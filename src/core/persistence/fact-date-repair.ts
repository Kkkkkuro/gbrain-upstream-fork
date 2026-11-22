/** The coordinated publication of a trusted operator's evidence for existing database-only facts. */
import type { BrainEngine } from '../engine.ts';
import { activeDateRepairSource, lockUnfencedFactsForDateRepair, updateLockedFactDates } from '../engine-sql/fact-date-repair.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { parseFactDateEvidence, type FactDateEvidence } from '../repair/fact-date-evidence.ts';
import { submissionAuthority } from './authority.ts';
import type { PreparedMutation } from './coordinator.ts';
import { requireUuid, sha256 } from './digest.ts';
import { admitWrite } from './journal.ts';
import type { WriteAuthority, WriteRequest } from './model.ts';
import { getWorktreeBinding } from './ownership.ts';
import { PreadmitBrainChanged } from './preadmit-cache.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';

const OPERATION = 'repair_fact_dates';
const targetSlug = (requestId: string) => `repairs/fact-dates/${requestId}`;

export interface UnfencedDateApproval {
  brainId: string;
  sourceIncarnation: string;
  rows: FactDateEvidence[];
}

async function assertMixedSource(engine: BrainEngine, sourceId: string, lock = false): Promise<string> {
  const source = await activeDateRepairSource(engine, sourceId, lock);
  if (!source || source.canonical === 'git') throw opError('source_changed',
    'The source is no longer eligible for a database-only date correction.',
    'Keep the recorded dates and use a canonical fact row for repairs on a Git-canonical source.');
  return source.incarnation;
}

function changed() {
  return opError('revision_conflict', 'A database-only fact no longer matches the date repair preview.',
    'Read the current fact and source. Run repair fact-claim-dates with a new evidence preview before applying changes.');
}

function forbidden() {
  return opError('permission_denied', 'Database-only date repair requires source-wide write authority from a local CLI operator.',
    'Run repair fact-claim-dates on the brain host for one authorized source.');
}

function requireSourceWideDateAuthority(authority: WriteAuthority) {
  if (authority.remote !== false || authority.principal.kind !== 'local_cli' ||
      authority.slugPrefixes !== null || authority.restrictedNamespace) throw forbidden();
}

/** Only the host CLI can admit this operation. A synthetic routing key coordinates it without publishing a page. */
export async function publishFactDateRepair(ctx: OperationContext, sourceId: string, requestId: string, approval: UnfencedDateApproval) {
  if (ctx.remote !== false || ctx.auth || ctx.dryRun || ctx.sourceId !== sourceId) throw forbidden();
  const { engine, config } = ctx;
  assertPersistenceAccepting(engine);
  const sourceIncarnation = await assertMixedSource(engine, sourceId);
  if (sourceIncarnation !== approval.sourceIncarnation) throw changed();
  const binding = await getWorktreeBinding(engine, sourceId);
  const stableId = requireUuid(requestId);
  const slug = targetSlug(stableId);
  const authority = await submissionAuthority(ctx, OPERATION, sourceId, sourceIncarnation, slug);
  requireSourceWideDateAuthority(authority);
  const intent = { rows: approval.rows };
  const row = await admitWrite(engine, { principal: authority.principal, operation: OPERATION, sourceId, sourceIncarnation, slug,
    requestId: stableId, callerIntent: intent, intent, authority, brainId: approval.brainId,
    worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null }).catch(error => {
    if (error instanceof PreadmitBrainChanged) throw changed();
    throw error;
  });
  const finished = await waitForWrite(engine, row, config, 60_000);
  writeResponse(finished);
  return finished.outcome as { facts: number; dates: FactDateEvidence[] };
}

export function prepareFactDateRepair(request: WriteRequest): PreparedMutation {
  requireSourceWideDateAuthority(request.authority);
  if (request.principal_kind !== 'local_cli' || request.principal_id !== request.authority.principal.id ||
      request.slug !== targetSlug(request.request_id) || request.page_id !== null) throw forbidden();
  const evidence = parseFactDateEvidence(JSON.stringify(request.intent?.rows ?? null), 'write receipt');
  return {
    observedRevision: null,
    async apply(tx) {
      const live = await tx.readLocalWriterRow(request.principal_id, { lock: true });
      if (live?.grant_ceiling.slugPrefixes !== null) throw forbidden();
      if (await assertMixedSource(tx, request.source_id, true) !== request.source_incarnation
        || await tx.readPageSnapshot(request.slug, { sourceId: request.source_id, includeDeleted: true })) throw changed();
      const rows = await lockUnfencedFactsForDateRepair(tx, request.source_id, evidence.rows);
      if (rows.length !== evidence.rows.length || rows.some((fact, index) =>
        Number(fact.id) !== evidence.rows[index]!.id || sha256(fact.fact) !== evidence.rows[index]!.claim_sha256)) throw changed();
      const applied = await updateLockedFactDates(tx, request.source_id, evidence.rows);
      if (applied !== rows.length) throw changed();
      return { facts: applied, dates: evidence.rows };
    },
  };
}
