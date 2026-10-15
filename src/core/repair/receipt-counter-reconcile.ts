/**
 * Lossless, explicit host repair for preexisting receipt-byte counter drift.
 * Every official reservation change takes the brain counter before its
 * principal counters. Hold that same lock first, enumerate and lock the
 * principal counters in collated order, then recompute under a fresh snapshot.
 * Admissions of a new principal cannot publish a reservation past this lock.
 * Never lock receipt/effect/page rows: their paths may already hold those
 * before waiting for counters. Only terminal_bytes is changed.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { LOCK_COUNTERS_SQL } from '../persistence/journal.ts';
import { loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import type { RepairHandler, RepairItem, RepairScope } from './core.ts';

const COMMAND = 'receipt-counter-reconcile';
const PREVIEW = `gbrain repair ${COMMAND} --json`;
interface CounterRow {
  key: string; counter: string | null; receipts: string; receipt_count: string; max_sequence: string; lifecycle_count: string;
}
interface Snapshot { brain_id: string; counters: CounterRow[] }

/** One statement, exact bigint text, covering requests in EVERY state plus lifecycle receipts. */
async function snapshot(engine: BrainEngine): Promise<Snapshot> {
  const rows = await engine.executeRaw<CounterRow & { brain_id: string }>(`WITH receipts AS (
      SELECT 'principal:'||principal_kind||':'||principal_id AS key,terminal_reservation AS bytes,sequence,0::bigint AS lifecycle
      FROM persistence_requests
      UNION ALL SELECT 'principal:local_cli:'||principal_id::text,terminal_bytes,NULL::bigint,1::bigint FROM persistence_topology_changes),
    s AS (SELECT key,SUM(bytes) AS bytes,count(*) AS n,max(sequence) AS seq,SUM(lifecycle) AS lifecycle FROM receipts GROUP BY key),
    every AS (SELECT * FROM s UNION ALL SELECT 'brain',COALESCE(SUM(bytes),0),COALESCE(SUM(n),0),max(seq),COALESCE(SUM(lifecycle),0) FROM s),
    keys AS (SELECT key FROM every UNION SELECT key FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%')
    SELECT k.key,c.terminal_bytes::text AS counter,COALESCE(e.bytes,0)::text AS receipts,
      COALESCE(e.n,0)::text AS receipt_count,COALESCE(e.seq,0)::text AS max_sequence,COALESCE(e.lifecycle,0)::text AS lifecycle_count,
      (SELECT brain_id::text FROM persistence_brain WHERE singleton=1) AS brain_id
    FROM keys k LEFT JOIN persistence_counters c ON c.key=k.key LEFT JOIN every e ON e.key=k.key ORDER BY k.key COLLATE "C"`);
  if (!rows[0]?.brain_id || rows.some(row => row.counter === null)) {
    throw new OperationError('storage_error', 'Receipt accounting is missing its brain identity or a counter row; no counter was reconciled.',
      'Report this storage invariant with gbrain doctor --only persistence_counter_drift --json. Missing lifetime/replay counters need separate recovery; this repair never creates them.');
  }
  return { brain_id: rows[0].brain_id, counters: rows.map(({ brain_id: _brain, ...row }) => row) };
}

const hashOf = (value: Snapshot) => previewHash({ kind: 'receipt-counter-reconcile-v1', ...value });
const repairedSnapshot = (value: Snapshot): Snapshot => ({ ...value, counters: value.counters.map(row => ({ ...row, counter: row.receipts })) });
const drift = (value: Snapshot) => value.counters.filter(row => row.counter !== row.receipts);
const item = (value: Snapshot): RepairItem => ({ cursor: { phase: 0, id: 1 }, source_id: '(brain)', slug: COMMAND,
  chars: 0, action: 'reconcile_receipt_bytes', change: { from: JSON.stringify(value), to: 'receipt_totals' } });

function assertBrain(value: Snapshot, scope: RepairScope) {
  if (value.brain_id !== scope.brain_id) throw previewChangedError(hashOf(value), PREVIEW);
}

export const receiptCounterReconcileRepair: RepairHandler = {
  kind: COMMAND,
  localOnly: true,
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, _after, opts) {
    if (opts?.remote !== false) throw trustedCliRequired(`${PREVIEW} runs only from the trusted local CLI on the brain host.`);
    if (opts.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'Receipt counter reconciliation requires the preview hash.', `Preview first: ${PREVIEW}; then apply its exact --expect hash.`);
      const approved = await loadApprovedSet<Snapshot>(engine, { command: COMMAND, hash: opts.expect, previewCommand: PREVIEW });
      const [value] = approved.items;
      if (approved.items.length !== 1 || !value || hashOf(value) !== opts.expect) throw previewChangedError(opts.expect, PREVIEW);
      assertBrain(value, scope);
      return { items: drift(value).length ? [item(value)] : [], preview_hash: opts.expect, residuals: {} };
    }
    const value = await snapshot(engine);
    assertBrain(value, scope);
    const hash = hashOf(value);
    await saveApprovedSet(engine, { command: COMMAND, hash }, [value]);
    return { items: drift(value).length ? [item(value)] : [], preview_hash: hash, residuals: {},
      details: { counters: drift(value).map(row => ({ ...row, delta: (BigInt(row.counter!) - BigInt(row.receipts)).toString() })),
        preserves: ['receipts', 'lifetime_ids', 'replay_keys', 'retention'], lock: 'brain then principal counters' } };
  },
  async apply(ctx, entry, opts) {
    if (ctx.remote !== false) throw trustedCliRequired(`${PREVIEW} runs only from the trusted local CLI on the brain host.`);
    const value = JSON.parse(entry.change!.from!) as Snapshot;
    if (!opts?.expect || hashOf(value) !== opts.expect) throw previewChangedError(opts?.expect ?? '(missing)', PREVIEW);
    const expectedHash = opts.expect;
    return ctx.engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL lock_timeout='2s'");
      await tx.executeRaw("SET LOCAL statement_timeout='15s'");
      // Reuse the journal's exact row-lock SQL, without its admission-only
      // ENSURE step: a repair must never create a missing replay counter.
      const brain = await tx.executeRaw<{ key: string }>(LOCK_COUNTERS_SQL, [['brain']]);
      if (brain.length !== 1) throw new OperationError('storage_error', 'The brain counter disappeared; no counter was recreated or reconciled.', `Re-run ${PREVIEW} and report the missing counter.`);
      const keys = await tx.executeRaw<{ key: string }>("SELECT key FROM persistence_counters WHERE key LIKE 'principal:%' ORDER BY key COLLATE \"C\"");
      await tx.executeRaw(LOCK_COUNTERS_SQL, [keys.map(row => row.key)]);
      const current = await snapshot(tx);
      // A repeat of the same successful apply is a read-only no-op; any other
      // accounting change (append, settlement, sweep, scope) needs a new preview.
      if (hashOf(current) === hashOf(repairedSnapshot(value))) return { applied: false, outcome: 'already_reconciled' };
      if (hashOf(current) !== expectedHash) throw previewChangedError(expectedHash, PREVIEW);
      const changed = drift(current);
      const updated = await tx.executeRaw<{ key: string }>(`UPDATE persistence_counters c SET terminal_bytes=t.bytes
        FROM unnest($1::text[],$2::bigint[]) AS t(key,bytes) WHERE c.key=t.key RETURNING c.key`,
      [changed.map(row => row.key), changed.map(row => row.receipts)]);
      const after = await snapshot(tx);
      if (updated.length !== changed.length || hashOf(after) !== hashOf(repairedSnapshot(current))) {
        throw new OperationError('storage_error', 'Receipt counter reconciliation did not verify; the transaction was rolled back.', `Re-run ${PREVIEW} and report the mismatch.`);
      }
      return { applied: true, outcome: 'reconciled', detail: { before: current.counters, after: after.counters } };
    });
  },
  render(details) {
    return [`  ${JSON.stringify(details.counters)}; preserves every receipt, lifetime ID and replay key; no compaction or retention change`];
  },
};
