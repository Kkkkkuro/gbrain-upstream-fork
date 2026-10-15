/**
 * Protects the lossless host repair of an existing receipt-byte surplus or
 * deficit. Removing the registered repair makes the original +983040 case
 * fail; changing lock/recheck/transaction behavior fails stale/concurrent/
 * rollback cases. Existing compaction tests only release reservations and
 * never reconcile a counter-only discrepancy. No production-only test seam.
 * PGLite runs by default; the guarded PostgreSQL backend runs in its own lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runRepair, resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { parseRepairArgs } from '../src/commands/repair.ts';
import { checkPersistenceCounterDrift } from '../src/commands/doctor/checks/persistence-compaction.ts';
import { claimNextWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { recordTopologyChange } from '../src/core/persistence/topology-receipts.ts';
import { trueUpRequests, sweepCompactedReservations } from '../src/core/persistence/receipt-true-up.ts';
import { freshBrainFactory, requestFixture, editRequest } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const KIND: RepairKind = 'receipt-counter-reconcile';
const databaseUrl = process.env.DATABASE_URL;
const counterRows = (engine: BrainEngine) => engine.executeRaw("SELECT key,terminal_bytes::text FROM persistence_counters ORDER BY key");
async function inject(engine: BrainEngine, delta: string) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes+$1::bigint WHERE key='brain' OR key LIKE 'principal:%'", [delta]);
  });
}
async function preserved(engine: BrainEngine) {
  return {
    requests: await engine.executeRaw('SELECT row_to_json(r)::text AS row FROM persistence_requests r ORDER BY id'),
    topology: await engine.executeRaw('SELECT row_to_json(t)::text AS row FROM persistence_topology_changes t ORDER BY id'),
    effects: await engine.executeRaw('SELECT row_to_json(e)::text AS row FROM persistence_effects e ORDER BY id'),
    counters: await engine.executeRaw('SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,recovery_bytes::text FROM persistence_counters ORDER BY key'),
  };
}
async function fixture(engine: BrainEngine) {
  const requests = await requestFixture(engine);
  const done = await requests.admit('history-example');
  const claimed = (await claimNextWrite(engine, localHostId()))!;
  await engine.transaction(tx => completeWrite(tx, claimed, 'conflict', {}, { code: 'source_changed', message: 'preserve this history' }));
  await requests.admit('open-example');
  const [writer] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_local_writers LIMIT 1');
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await recordTopologyChange(tx, { principal: writer.id, requestId: randomUUID(), intent: { op: 'example' }, operation: 'example',
      sourceId: requests.sourceId, incarnation: requests.incarnation, worktrees: [] }, { done: true });
  });
  const scope = await resolveRepairScope(engine);
  const run = (apply: boolean, expectHash?: string) => repairRunner(engine, { apply }).then(r => r.run(KIND, scope, { explicit: true, expect: expectHash }));
  return { requests, done, scope, run };
}

test('explicit host-only projection repair is discoverable through the official command', () => {
  expect(parseRepairArgs([KIND, '--apply', '--expect', 'example-hash'])).toMatchObject({ kind: KIND, apply: true, expect: 'example-hash' });
  expect(repairSpec(KIND)).toMatchObject({ explicit_only: true, preview_bound: true, embeds: 'none', checks: ['persistence_counter_drift'],
    handler: { localOnly: true, publication: 'projection' } });
});

for (const backend of testBackends()) {
  describe(`receipt-counter-reconcile ${backend}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-counter-reconcile-'));
      factory = await freshBrainFactory(backend, databaseUrl);
    }, 120_000);
    afterAll(async () => { await factory?.dispose(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
    const isolated = (fn: (engine: BrainEngine) => Promise<void>) => () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => fn(await factory.fresh()));

    test('original +983040 surplus clears; all receipts, lifecycle history, open work and lifetime IDs survive; repeat is a no-op', isolated(async engine => {
      const { run } = await fixture(engine);
      await inject(engine, '983040');
      expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'warn', details: { drift: [{ delta: 983040 }, { delta: 983040 }] } });
      const state = await preserved(engine), counters = await counterRows(engine);
      const preview = await run(false);
      expect(preview).toMatchObject({ affected: 1, cost: { lifetime_ids: 0, receipt_bytes: 0, embedding_pages: 0 } });
      expect(await preserved(engine)).toEqual(state);
      expect(await counterRows(engine)).toEqual(counters);
      const applied = await run(true, preview.preview_hash);
      expect(applied).toMatchObject({ applied: 1, complete: true, outcomes: { reconciled: 1 } });
      expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok', details: { drift: [] } });
      expect(await preserved(engine)).toEqual(state);
      const repeated = await run(true, preview.preview_hash);
      expect(repeated).toMatchObject({ applied: 0, skipped: 1, outcomes: { already_reconciled: 1 } });
      expect(await preserved(engine)).toEqual(state);
    }), 120_000);

    for (const delta of ['-100', '9007199254740993']) {
      test(`repairs exact bigint delta ${delta} without precision loss`, isolated(async engine => {
        const { run } = await fixture(engine);
        await inject(engine, delta);
        const state = await preserved(engine);
        const preview = await run(false);
        expect((preview.details!.counters as Array<{ delta: string }>).map(row => row.delta)).toEqual([delta, delta]);
        expect((await run(true, preview.preview_hash)).applied).toBe(1);
        expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
        expect(await preserved(engine)).toEqual(state);
      }), 120_000);
    }

    for (const mutation of ['append', 'true-up', 'sweep'] as const) {
      test(`stale preview refuses after ${mutation}, without changing counters or historical receipts`, isolated(async engine => {
        const { requests, run } = await fixture(engine);
        const legacy = await requests.admit('legacy-example');
        await editRequest(engine, legacy.id, `state='failed',completed_at=now(),claim_expires_at=NULL${mutation === 'sweep' ? ',compacted=true,intent=NULL' : ''}`);
        await inject(engine, '983040');
        const preview = await run(false);
        if (mutation === 'append') await requests.admit('appended-example');
        else if (mutation === 'true-up') expect(await trueUpRequests(engine, [legacy.id])).toBeGreaterThan(0);
        else expect((await sweepCompactedReservations(engine, 100)).freed_bytes).toBeGreaterThan(0);
        const counters = await counterRows(engine), state = await preserved(engine);
        await expect(run(true, preview.preview_hash)).rejects.toMatchObject({ code: 'preview_changed' });
        expect(await counterRows(engine)).toEqual(counters);
        expect(await preserved(engine)).toEqual(state);
        expect((await run(true, (await run(false)).preview_hash)).applied).toBe(1);
        expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
      }), 120_000);
    }

    test('append, true-up and compacted sweep racing the locked apply preserve exact accounting', isolated(async engine => {
      const { requests, scope } = await fixture(engine);
      const terminal = await requests.admit('settling-example'), compacted = await requests.admit('compacted-example');
      await editRequest(engine, terminal.id, "state='failed',completed_at=now(),claim_expires_at=NULL");
      await editRequest(engine, compacted.id, "state='failed',completed_at=now(),claim_expires_at=NULL,compacted=true,intent=NULL");
      await inject(engine, '983040');
      const handler = repairSpec(KIND).handler;
      const plan = await handler.plan(engine, scope, null, { apply: false, remote: false });
      let reached!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const wrapped = Object.create(engine) as BrainEngine;
      wrapped.transaction = fn => engine.transaction(async tx => {
        const observed = Object.create(tx) as BrainEngine;
        observed.executeRaw = async (sql, params) => {
          if (sql.startsWith('UPDATE persistence_counters c SET terminal_bytes=')) { reached(); await gate; }
          return tx.executeRaw(sql, params);
        };
        return fn(observed);
      });
      const ctx = { ...requests.ctx, engine: wrapped };
      const db = backend === 'postgres' ? (await engine.executeRaw<{ name: string }>('SELECT current_database() AS name'))[0].name : undefined;
      const inspector = backend === 'postgres' ? (await import('#postgres')).default(databaseUrl!, { max: 1, prepare: false }) : undefined;
      const apply = handler.apply(ctx, plan.items[0], { embed: false, expect: plan.preview_hash });
      await locked;
      const racing = [requests.admit('racing-example'), trueUpRequests(engine, [terminal.id]), sweepCompactedReservations(engine, 100)] as const;
      try {
        if (inspector) {
          let blocked = 0;
          for (let attempt = 0; attempt < 200 && blocked < 3; attempt++) {
            const [row] = await inspector.unsafe<{ n: string }[]>(
              "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [db!]);
            blocked = Number(row.n);
            if (blocked < 3) await new Promise(resolve => setTimeout(resolve, 10));
          }
          // Real PostgreSQL evidence: all three concurrent ledger mutators
          // reached a server-side lock wait while reconciliation held brain.
          expect(blocked).toBeGreaterThanOrEqual(3);
        }
      } finally { release(); await inspector?.end(); }
      expect(await apply).toMatchObject({ applied: true });
      const [admitted, freed, swept] = await Promise.all(racing);
      expect(admitted.slug).toBe('racing-example');
      expect(freed).toBeGreaterThan(0);
      expect(swept.freed_bytes).toBeGreaterThan(0);
      expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
    }), 120_000);

    test('database failure in the counter update rolls the entire reconciliation back; the same preview can retry', isolated(async engine => {
      const { run } = await fixture(engine);
      await inject(engine, '983040');
      const preview = await run(false), before = await counterRows(engine), state = await preserved(engine);
      await engine.executeRaw(`CREATE FUNCTION test_counter_reconcile_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.key LIKE 'principal:%' AND NEW.terminal_bytes<>OLD.terminal_bytes THEN RAISE EXCEPTION 'counter reconcile fixture failure'; END IF;
        RETURN NEW; END $$`);
      await engine.executeRaw('CREATE TRIGGER test_counter_reconcile_fail BEFORE UPDATE ON persistence_counters FOR EACH ROW EXECUTE FUNCTION test_counter_reconcile_fail()');
      await expect(run(true, preview.preview_hash)).rejects.toThrow('counter reconcile fixture failure');
      expect(await counterRows(engine)).toEqual(before);
      expect(await preserved(engine)).toEqual(state);
      await engine.executeRaw('DROP TRIGGER test_counter_reconcile_fail ON persistence_counters');
      await engine.executeRaw('DROP FUNCTION test_counter_reconcile_fail()');
      expect((await run(true, preview.preview_hash)).applied).toBe(1);
      expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
    }), 120_000);

    test('remote and unset trust are refused before any database operation, including initialization', isolated(async engine => {
      const { requests, scope } = await fixture(engine);
      await inject(engine, '983040');
      const handler = repairSpec(KIND).handler;
      const plan = await handler.plan(engine, scope, null, { apply: false, remote: false });
      const forbidden = Object.create(engine) as BrainEngine;
      forbidden.executeRaw = () => { throw new Error('unexpected database access'); };
      forbidden.transaction = () => { throw new Error('unexpected transaction'); };
      for (const remote of [true, undefined]) {
        const ctx = { ...requests.ctx, engine: forbidden, remote } as OperationContext;
        await expect(handler.plan(forbidden, scope, null, { apply: false, remote })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(handler.apply(ctx, plan.items[0], { embed: false, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(runRepair(ctx, handler, scope, { apply: true, explicit: true, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'permission_denied' });
      }
    }), 120_000);

    test('a counter removed after preview is refused without recreating its lifetime or replay accounting', isolated(async engine => {
      const { run } = await fixture(engine);
      await inject(engine, '983040');
      const preview = await run(false);
      await engine.executeRaw("DELETE FROM persistence_counters WHERE key='brain'");
      const before = await counterRows(engine);
      await expect(run(true, preview.preview_hash)).rejects.toMatchObject({ code: 'storage_error' });
      expect(await counterRows(engine)).toEqual(before);
    }), 120_000);

    test('missing or expired preview and missing counter rows fail closed', isolated(async engine => {
      const { run } = await fixture(engine);
      await inject(engine, '983040');
      await expect(run(true)).rejects.toMatchObject({ code: 'invalid_params' });
      const preview = await run(false);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='repair-approval'");
      await expect(run(true, preview.preview_hash)).rejects.toMatchObject({ code: 'preview_changed' });
      await engine.executeRaw("DELETE FROM persistence_counters WHERE key LIKE 'principal:%'");
      await expect(run(false)).rejects.toMatchObject({ code: 'storage_error' });
    }), 120_000);
  });
}
