/** Per-run attribution of atoms rollup contributions, including zero-yield halts.
 * Intent without a result is UNKNOWN, never proof that the cache was updated.
 * Best-effort local metadata, not durable publication receipts or a DB transaction.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { VERSION } from '../../version.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { writeReceipt } from './receipt-writer.ts';
import { classifyRunStop, upsertExtractRollup } from './rollup-writer.ts';

type Stop = Parameters<typeof classifyRunStop>[0];
export interface AtomsRunFinalization {
  sourceId: string;
  sourceIncarnation?: string;
  model: string;
  managed: boolean;
  dryRun: boolean;
  hardStopped: boolean;
  atoms: number;
  transcripts: number;
  pages: number;
  costUsd: number;
  stop: Stop;
  requestIds: string[];
}

const writer = createAuditWriter<{ ts: string; event: 'rollup_intent' | 'rollup_result'; run_id: string;
  version: string; source_id: string; source_incarnation?: string; model?: string;
  request_ids: string[]; request_count: number; request_ids_omitted: number; deltas?: ReturnType<typeof classifyRunStop> & { cost_delta: number; day: string };
  rollup_written?: boolean;
}>({ featureName: 'atoms-run', errorTrailer: '; rollup and phase outcomes remain unchanged' });

let fallbackSequence = 0;

export async function finalizeAtomsRun(engine: BrainEngine, input: AtomsRunFinalization): Promise<{ run_id?: string }> {
  if (input.dryRun || input.hardStopped) return {};
  let runId: string | undefined;
  try { runId = `${randomUUID()}-atoms`; } catch { /* correlation must not prevent the existing cache write */ }
  if (!input.managed && input.atoms > 0) {
    try {
      await writeReceipt(engine, { kind: 'atoms', source_id: input.sourceId,
        run_id: runId ?? `${Date.now().toString(36)}-${process.pid}-${++fallbackSequence}-atoms`, round: 'single',
        extracted_at: new Date().toISOString(), total_rows: input.atoms, cost_usd: input.costUsd,
        summary: `Extracted ${input.atoms} atoms from ${input.transcripts} transcripts + ${input.pages} pages.` });
    } catch (error) { console.error(`[extract_atoms] receipt write failed: ${(error as Error).message}`); }
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const ids = input.requestIds.filter(id => uuid.test(id));
  const requestIds = [...new Set(ids)].slice(0, 128);
  const metadata = { run_id: runId!, version: VERSION, source_id: input.sourceId,
    ...(input.sourceIncarnation && uuid.test(input.sourceIncarnation) ? { source_incarnation: input.sourceIncarnation } : {}),
    ...(/^[a-z0-9_-]+:[a-zA-Z0-9._/-]+$/.test(input.model) ? { model: input.model } : {}),
    request_ids: requestIds, request_count: input.requestIds.length, request_ids_omitted: input.requestIds.length - requestIds.length };
  const deltas = { ...classifyRunStop(input.stop), cost_delta: input.costUsd, day: new Date().toISOString().slice(0, 10) };
  if (runId) writer.log({ event: 'rollup_intent', ...metadata, deltas });
  const result = await upsertExtractRollup(engine, { kind: 'atoms', source_id: input.sourceId, ...deltas });
  if (runId) writer.log({ event: 'rollup_result', ...metadata, rollup_written: result.ok });
  return runId ? { run_id: runId } : {};
}
