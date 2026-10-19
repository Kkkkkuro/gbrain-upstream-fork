import { opError } from '../ops/contract.ts';
import type { BrainEngine, FactRow } from '../engine.ts';

interface TimedClaim {
  id?: unknown;
  valid_from?: unknown;
  claim_metric?: unknown;
  claim_unit?: unknown;
  claim_period?: unknown;
}

function effectiveTime(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

/** Lock the rows whose timestamps will drive the unmanaged validity chain.
 * A phase snapshot must not expire a row using an effective time it no
 * longer has when the transaction starts.
 */
export async function validateConsolidationTimeSnapshot(engine: BrainEngine, sourceId: string, observed: readonly FactRow[]): Promise<void> {
  const current = await engine.executeRaw<TimedClaim>(`SELECT id,valid_from,claim_metric,claim_unit,claim_period FROM facts
    WHERE source_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE`, [sourceId, observed.map(f => f.id)]);
  const expected = new Map(observed.map(f => [Number(f.id), f.valid_from.getTime()]));
  if (current.length !== observed.length || current.some(f => expected.get(Number(f.id)) !== effectiveTime(f.valid_from))) {
    throw opError('revision_conflict', 'Consolidation effective times changed after clustering.',
      'No take or fact lifecycle was written. Run consolidation again so its validity chain uses the current effective times.');
  }
  assertConsolidationTime(current);
}

/** #6023: confidence and row order cannot order typed observations at one
 * effective instant. Do not infer a winner or expire either observation.
 * Deliberately conservative: even same-time duplicates wait for review.
 */
export function hasAmbiguousConsolidationTime(facts: readonly TimedClaim[]): boolean {
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.claim_metric == null) continue;
    const instant = effectiveTime(fact.valid_from);
    if (!Number.isFinite(instant)) return true;
    const key = JSON.stringify([fact.claim_metric, fact.claim_unit ?? null, fact.claim_period ?? null, instant]);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Shared by submission and publication, including requests admitted by an
 * older binary. Refuse before any take or fact lifecycle write.
 */
export function assertConsolidationTime(facts: readonly TimedClaim[]): void {
  if (hasAmbiguousConsolidationTime(facts)) throw opError('invalid_params',
    'Typed consolidation has ambiguous effective times.',
    'Two observations of the same metric, unit and period have the same effective time. Neither was chosen or expired. Review their source evidence and establish chronology before consolidating; confidence and row IDs are not correction order.',
    { reason: 'consolidation_time_ambiguous', retryable: false });
}
