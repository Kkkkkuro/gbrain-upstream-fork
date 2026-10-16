/** Explicit operator mappings; no subject inference or model transport. Host CLI only. */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { readFacts } from '../persistence/prepared-maintenance.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { isFactEntityPage } from '../entities/resolve.ts';
import { manualTargetFactsHash, readManualRelinkBody, readManualRelinkTarget } from './relink-manual-guards.ts';
import { previewRelinkClassification, readFullRelinkFacts, relinkFactHash, submitRelinkGroup, type RelinkIntent } from './relink-publish.ts';

export interface ManualRelinkMapping { target_slug: string; fact_ids: number[]; evidence: string }
export interface ManualRelinkManifest {
  schema_version: 1; source_id: string; target_slug: string; intent: RelinkIntent;
  outcomes: Array<{ id: number; action: string; duplicate_of?: number; reason?: string }>;
  effects: { subject_model_calls: 0; page_embedding: 'may_be_queued'; conflict_queue: false };
  checksum: string;
}
const invalid = (message: string): never => { throw opError('invalid_params', message, 'Use a reviewed explicit mapping to one existing target in this source. Preview again after a change; never edit a saved manifest to bypass its pins.'); };
const withoutChecksum = (m: ManualRelinkManifest) => { const { checksum: _, ...rest } = m; return rest; };

export function parseManualMapping(value: unknown): ManualRelinkMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Mapping must be an object.');
  const m = value as ManualRelinkMapping;
  if (Object.keys(m).sort().join(',') !== 'evidence,fact_ids,target_slug' || typeof m.target_slug !== 'string' || !m.target_slug.trim()
    || !Array.isArray(m.fact_ids) || !m.fact_ids.length || m.fact_ids.length > 100 || m.fact_ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(m.fact_ids).size !== m.fact_ids.length || typeof m.evidence !== 'string' || !m.evidence.trim() || m.evidence.length > 1000) {
    return invalid('Mapping needs target_slug, 1–100 unique positive fact_ids, and specific evidence (1–1000 characters).');
  }
  return { target_slug: m.target_slug, fact_ids: [...m.fact_ids].sort((a, b) => a - b), evidence: m.evidence.trim() };
}

export async function previewManualRelink(engine: BrainEngine, sourceId: string, input: unknown): Promise<ManualRelinkManifest> {
  const mapping = parseManualMapping(input);
  // Preview never initializes persistence or claims an owner.
  return engine.transaction(async tx => {
    const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
    const target = await readManualRelinkTarget(tx, sourceId, mapping.target_slug);
    if (!brain || !source || source.archived || !target || !isFactEntityPage(target.page.slug, target.page.type)) return invalid('The existing brain, source and exact entity target are required.');
    const body = await readManualRelinkBody(tx, sourceId, target.page, target.revision);
    if (parseFactsFence(body).warnings.length) return invalid('The target has a malformed Facts fence; repair and review it first.');
    const rows = await readFacts(tx, sourceId, mapping.fact_ids), full = await readFullRelinkFacts(tx, sourceId, mapping.fact_ids);
    if (rows.length !== mapping.fact_ids.length || full.length !== rows.length) return invalid('Every fact must exist in the selected source.');
    const intent: RelinkIntent = { kind: 'relink_facts', run_id: randomUUID(), queue_conflict: false,
      facts: rows.map(row => ({ id: row.id, hash: relinkFactHash(row), full_hash: relinkFactHash(full.find(f => f.id === row.id)!),
        tier: 'manual', model: null, note: `entity relinked by operator: ${mapping.evidence}` })),
      manual: { brain_id: brain.brain_id, source_incarnation: source.incarnation, page_id: target.page.id, revision: target.revision, classification_key: '',
        target_facts_hash: await manualTargetFactsHash(tx, sourceId, mapping.target_slug, body) } };
    const classified = await previewRelinkClassification(tx, sourceId, mapping.target_slug, intent);
    if (classified.outcomes.some(o => o.action === 'skip')) return invalid('One or more facts are ineligible, withdrawn, private-conflicting or cannot round-trip. No manifest was issued.');
    intent.manual!.classification_key = classified.key;
    const manifest = { schema_version: 1 as const, source_id: sourceId, target_slug: mapping.target_slug, intent, outcomes: classified.outcomes,
      effects: { subject_model_calls: 0 as const, page_embedding: 'may_be_queued' as const, conflict_queue: false as const } };
    return { ...manifest, checksum: digest(manifest) };
  });
}

export async function applyManualRelink(engine: BrainEngine, config: GBrainConfig, sourceId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A complete manifest is required.');
  const m = input as ManualRelinkManifest;
  if (m.schema_version !== 1 || m.source_id !== sourceId || typeof m.target_slug !== 'string' || !m.target_slug.trim() || !m.intent?.manual || m.intent.kind !== 'relink_facts'
    || m.intent.queue_conflict !== false || !Array.isArray(m.intent.facts) || m.intent.facts.length < 1 || m.intent.facts.length > 100
    || typeof m.intent.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(m.intent.run_id)
    || typeof m.intent.manual.brain_id !== 'string' || typeof m.intent.manual.source_incarnation !== 'string' || typeof m.intent.manual.revision !== 'string'
    || !Number.isSafeInteger(m.intent.manual.page_id) || m.intent.manual.page_id < 1 || typeof m.intent.manual.classification_key !== 'string'
    || typeof m.intent.manual.target_facts_hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.intent.manual.target_facts_hash)
    || new Set(m.intent.facts.map(f => f?.id)).size !== m.intent.facts.length
    || m.intent.facts.some(f => !f || !Number.isSafeInteger(f.id) || f.id < 1 || typeof f.note !== 'string' || !f.note.trim() || f.note.length > 1100
      || typeof f.hash !== 'string' || !/^[0-9a-f]{64}$/.test(f.hash) || typeof f.full_hash !== 'string' || !/^[0-9a-f]{64}$/.test(f.full_hash) || f.tier !== 'manual' || f.model !== null)
    || digest(withoutChecksum(m)) !== m.checksum) return invalid('Manifest identity, fields or checksum differ.');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (brain?.brain_id !== m.intent.manual.brain_id) return invalid('This manifest belongs to another brain.');
  // Stable run_id and pinned intent replay the same journal request after lost replies.
  return submitRelinkGroup(engine, config, sourceId, m.target_slug, m.intent);
}
