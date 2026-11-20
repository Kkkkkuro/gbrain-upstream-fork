import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { previewChangedError } from '../persistence/preview-approval.ts';
import { parseMarkdownHead } from '../markdown.ts';
import { fileMatchesSnapshot } from '../persistence/page-prepare.ts';
import { ownerRepairFile } from './page-handlers.ts';

/** The local checkout must still carry the proven first stamps and the current revision's body. */
export async function firstIngestEvidence(engine: BrainEngine, source: string, slug: string) {
  const evidence = await engine.firstIngestProjection(source, slug);
  if (!evidence) return null;
  const file = await ownerRepairFile(engine, source, slug);
  const bytes = file.ok && file.target?.expectedFileBytes;
  if (!bytes) return null;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: source });
  if (!snapshot || snapshot.revision !== evidence.revision) return null;
  const header = parseMarkdownHead(bytes, { validate: true });
  if (header.errors.length || header.recovery || header.frontmatter.source_kind !== 'put_page'
    || header.frontmatter.ingested_via !== 'put_page' || header.frontmatter.ingested_at !== evidence.first_at
    || !await fileMatchesSnapshot(engine, slug, bytes, snapshot, snapshot.page.source_path ?? slug + '.md')) return null;
  return { ...evidence, storageProof: evidence.planned, planned: digest([evidence.planned, bytes]) };
}

/** Called by the local owner's journaled repair under its publication guards. */
export async function restoreFirstIngestProjection(tx: BrainEngine, source: string, slug: string, planned: string) {
  const evidence = await firstIngestEvidence(tx, source, slug);
  if (!evidence || evidence.planned !== planned || !await tx.firstIngestProjection(source, slug, evidence.storageProof)) {
    throw previewChangedError(planned, 'gbrain repair provenance');
  }
  return { status: 'restored', first_ingest_projection: true, creation_request_id: evidence.birth_request };
}
