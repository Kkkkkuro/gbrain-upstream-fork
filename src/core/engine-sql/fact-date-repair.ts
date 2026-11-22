/** SQL for the trusted, coordinated date repair of unfenced facts. */
import type { BrainEngine } from '../engine.ts';
import type { FactDateEvidence } from '../repair/fact-date-evidence.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

export async function activeDateRepairSource(engine: BrainEngine, sourceId: string, lock: boolean) {
  const statement = renderFragment(sqlFragment`SELECT incarnation::text,config->>'canonical' AS canonical
    FROM sources WHERE id=${sourceId} AND NOT archived${lock ? trustedSql(' FOR SHARE') : sqlFragment``}`);
  const [source] = await engine.executeRaw<{ incarnation: string; canonical: string | null }>(statement.text, statement.params);
  return source;
}

export async function lockUnfencedFactsForDateRepair(tx: BrainEngine, sourceId: string, evidence: FactDateEvidence[]) {
  return tx.executeRaw<{ id: number | string; fact: string }>(`
    SELECT f.id,f.fact FROM facts f JOIN jsonb_to_recordset($2::text::jsonb) AS e(id bigint, expected_valid_from text, valid_from text)
      ON f.id=e.id
    WHERE f.source_id=$1 AND f.valid_from=e.expected_valid_from::timestamptz
      AND f.row_num IS NULL AND f.source_markdown_slug IS NULL AND f.expired_at IS NULL AND f.superseded_by IS NULL
      AND (f.valid_until IS NULL OR f.valid_until>=e.valid_from::timestamptz)
    ORDER BY f.id FOR UPDATE OF f`, [sourceId, JSON.stringify(evidence)]);
}

/** Only call after all the evidence rows have been checked and locked in this transaction. */
export async function updateLockedFactDates(tx: BrainEngine, sourceId: string, evidence: FactDateEvidence[]) {
  const updated = await tx.executeRaw(`
    UPDATE facts f SET valid_from=e.valid_from::timestamptz
    FROM jsonb_to_recordset($2::text::jsonb) AS e(id bigint, valid_from text)
    WHERE f.source_id=$1 AND f.id=e.id RETURNING f.id`, [sourceId, JSON.stringify(evidence)]);
  return updated.length;
}
