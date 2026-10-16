/** Lossless manual adoption guards, using the real fence projection mapper. */
import type { BrainEngine } from '../engine.ts';
import { parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { extractFactsFromFenceText } from './extract-from-fence.ts';
import { digest } from '../persistence/digest.ts';
import { opError } from '../ops/contract.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { BOUNDED_PREFIX_BYTES } from '../page-window/document.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { Page } from '../types.ts';

/** Preview must not eagerly load a snapshot body before its bounded refusal. */
export async function readManualRelinkTarget(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<Pick<Page, 'id' | 'slug' | 'type' | 'body_storage'> & { revision: string }>(
    'SELECT id,slug,type,body_storage,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  if (!row) return null;
  const { revision, ...page } = row;
  return { page, revision };
}

/** Bounded inline-only preview: a full prefix is held, never mistaken for a complete page. */
export async function readManualRelinkBody(engine: BrainEngine, sourceId: string, page: Pick<Page, 'id' | 'slug' | 'body_storage'>, revision: string): Promise<string> {
  assertInlineBody(page, 'manual fact relink');
  const [row] = await engine.executeRaw<{ body: string }>(`SELECT ${boundedBodyPrefixSql('p')} AS body FROM pages p
    WHERE p.source_id=$1 AND p.id=$2 AND p.knowledge_revision=$3::uuid AND p.body_storage='inline' AND p.deleted_at IS NULL`, [sourceId, page.id, revision]);
  if (!row) throw opError('revision_conflict', 'The manual target changed during its bounded read.', 'Nothing was submitted. Read the current target and preview a new mapping.');
  if (Buffer.byteLength(row.body, 'utf8') >= BOUNDED_PREFIX_BYTES) throw opError('invalid_params', 'Manual relink holds targets at or over the bounded preview size.',
    'Nothing was submitted. This preview supports inline compiled truth below 64 KiB; use the supported segment-aware repair path when available, not a truncated manifest.');
  return row.body;
}

export function manualProjectionMatches(value: Record<string, unknown>, cell: ParsedFact): boolean {
  const p = extractFactsFromFenceText([cell], 'manual-preview', 'manual-preview')[0]!;
  for (const key of ['valid_from', 'valid_until', 'expired_at']) {
    const raw = value[key];
    // PostgreSQL retains microseconds; JS Date and the projection retain milliseconds.
    const fraction = raw == null ? null : String(raw).match(/\d\d:\d\d:\d\d\.(\d+)/)?.[1];
    if (fraction && /[1-9]/.test(fraction.slice(3))) return false;
    const projected = p[key as keyof typeof p] as Date | null | undefined;
    if ((projected?.getTime() ?? null) !== (raw == null ? null : new Date(String(raw)).getTime())) return false;
  }
  const fields = ['fact','kind','visibility','notability','context','source','confidence','claim_metric','claim_value','claim_unit','claim_period','attributed_to'] as const;
  return fields.every(key => (p[key] ?? null) === (value[key] ?? null));
}

const refuse = (): never => { throw opError('revision_conflict', 'Manual relink cannot preserve every existing fence field.',
  'Nothing was linked. The current fence codec or projection would change an unselected row or stored precision; repair that representation separately, then preview and review a new mapping.'); };

export function assertManualFenceUnchanged(before: string, after: string): void {
  const a = parseFactsFence(before), b = parseFactsFence(after);
  if (a.warnings.length || b.warnings.length || a.facts.some(old => {
    const next = b.facts.find(f => f.rowNum === old.rowNum);
    return !next || digest(old) !== digest(next);
  })) refuse();
}

/** Pin all existing fence-owned rows, not just the selected unlinked facts. */
export async function manualTargetFactsHash(engine: BrainEngine, sourceId: string, slug: string, body: string, lock = false): Promise<string> {
  const rows = await engine.executeRaw<{ id: number; value: Record<string, unknown> }>(`SELECT f.id,to_jsonb(f) AS value FROM facts f
    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num IS NOT NULL ORDER BY f.id${lock ? ' FOR UPDATE' : ''}`, [sourceId, slug]);
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length || parsed.facts.length !== rows.length || new Set(rows.map(r => r.value.row_num)).size !== rows.length) refuse();
  for (const row of rows) {
    const cell = parsed.facts.find(f => f.rowNum === Number(row.value.row_num));
    if (!cell || !manualProjectionMatches(row.value, cell)) refuse();
  }
  return digest(rows.map(r => ({ id: Number(r.id), value: r.value })));
}
