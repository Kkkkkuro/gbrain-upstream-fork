/**
 * Contract: the extractor's own page/transcript outputs carry real raw traces,
 * and pass the unchanged Doctor check without exemptions. Reverting the writer
 * loses those traces. Existing quote/link tests never run that Doctor contract.
 * Uses the existing _chat seam, real extraction, and isolated in-memory PGLite;
 * no production-only seam, model inference, or operator database is needed.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { corpusTextForExtraction } from '../../src/core/context/corpus-segments.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { rawProvenanceCheck } from '../../src/commands/doctor/checks/core-health.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const SOURCE = 'A measured rollout can reveal a mistaken assumption before expansion.\n' + 'Project context stays available for review. '.repeat(20);
const QUOTE = 'A measured rollout can reveal a mistaken assumption before expansion.';
const inputTrace = { input_hash: createHash('sha256').update(SOURCE).digest('hex'), quote_offset_basis: 'extractor_input_utf16' };
const chat = async (): Promise<ChatResult> => ({
  text: JSON.stringify([{ title: 'Measure before expansion', atom_type: 'insight',
    body: 'Measure assumptions before expanding.', source_quote: QUOTE }]),
  blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
});
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function onlyAtom(sourceId = 'default') {
  const rows = await engine.listPages({ sourceId, type: 'atom', limit: 10 });
  expect(rows).toHaveLength(1);
  return (await engine.getPage(rows[0]!.slug, { sourceId }))!;
}

for (const managed of [false, true]) {
  test(`${managed ? 'managed' : 'unmanaged'} page output records the pinned source image and passes Doctor`, async () => {
    const page = await engine.putPage('notes/source', { type: 'note', title: 'Source', compiled_truth: SOURCE, timeline: '' });
    if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
      _pages: [{ slug: page.slug, content: SOURCE, contentHash: page.content_hash! }], _chat: chat });
    expect(outcome.status).toBe('ok');
    const atom = await onlyAtom();
    expect(atom.frontmatter.raw_source).toBe('gbrain-page://default/notes/source');
    expect(atom.frontmatter.raw_trace).toEqual({ source_id: 'default', source_slug: page.slug,
      source_revision: page.knowledge_revision, source_hash: page.content_hash, ...inputTrace });
    expect(atom.frontmatter.source_slug).toBe(page.slug);
    expect(atom.frontmatter.source_quote).toBe(QUOTE);
    const [start, end] = atom.frontmatter.source_quote_offset as [number, number];
    expect(SOURCE.slice(start, end)).toBe(QUOTE);
    expect(atom.frontmatter.raw_trace_exempt).toBeUndefined();
    expect((await rawProvenanceCheck(engine)).status).toBe('ok');
    // The generator fix must never suppress a genuinely missing trace.
    if (!managed) {
      await engine.putPage('notes/traceless', { type: 'synthesis', title: 'Missing trace', compiled_truth: 'body' });
      expect((await rawProvenanceCheck(engine)).message).toContain('1 synthesized page(s)');
    }
  });
}

test('transcript output retains its exact file path/full hash and invents no page revision', async () => {
  const path = '/synthetic/corpus/notes with spaces.txt';
  const hash = createHash('sha256').update(SOURCE).digest('hex');
  const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
    _transcripts: [{ filePath: path, content: SOURCE, contentHash: hash }], _chat: chat });
  expect(outcome.status).toBe('ok');
  const atom = await onlyAtom();
  expect(atom.frontmatter.raw_source).toBe(path);
  expect(atom.frontmatter.source_path).toBe(path);
  expect(atom.frontmatter.raw_trace).toEqual({ source_id: 'default', source_path: path, source_hash: hash, ...inputTrace });
  expect(atom.frontmatter.source_quote_verified).toBe(true);
  expect(atom.frontmatter.raw_trace_exempt).toBeUndefined();
  expect((await rawProvenanceCheck(engine)).status).toBe('ok');
});

test('a source edited during inference cannot be mislabeled as the newer revision', async () => {
  const page = await engine.putPage('notes/source', { type: 'note', title: 'Source', compiled_truth: SOURCE });
  const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [],
    _pages: [{ slug: page.slug, content: SOURCE, contentHash: page.content_hash! }],
    _chat: async () => {
      await engine.putPage(page.slug, { type: 'note', title: 'Source', compiled_truth: 'A newer source image.' });
      return chat();
    } });
  expect(outcome.status).toBe('warn'); // completion stays retryable, as before
  const atom = await onlyAtom();
  expect(atom.frontmatter.raw_trace).toEqual({ source_id: 'default', source_slug: page.slug,
    source_revision: page.knowledge_revision, source_hash: page.content_hash, ...inputTrace });
  const newer = await engine.getPage(page.slug, { sourceId: 'default' });
  expect(newer!.knowledge_revision).not.toBe(page.knowledge_revision);
});

test('same-slug pages in different sources keep distinct raw source identities', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('dept-x','Department X')");
  const wrong = await engine.putPage('notes/source', { type: 'note', title: 'Other source', compiled_truth: 'Unrelated material.' });
  const page = await engine.putPage('notes/source', { type: 'note', title: 'Source', compiled_truth: SOURCE }, { sourceId: 'dept-x' });
  const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'dept-x', _transcripts: [],
    _pages: [{ slug: page.slug, content: SOURCE, contentHash: page.content_hash! }], _chat: chat });
  expect(outcome.status).toBe('ok');
  const atom = await onlyAtom('dept-x');
  expect(atom.frontmatter.raw_source).toBe('gbrain-page://dept-x/notes/source');
  expect(atom.frontmatter.raw_trace).toEqual({ source_id: 'dept-x', source_slug: page.slug,
    source_revision: page.knowledge_revision, source_hash: page.content_hash, ...inputTrace });
  expect((atom.frontmatter.raw_trace as { source_revision: string }).source_revision).not.toBe(wrong.knowledge_revision);
  expect(await engine.listPages({ sourceId: 'default', type: 'atom' })).toHaveLength(0);
  expect((await rawProvenanceCheck(engine)).status).toBe('ok');
});


test('paste-filtered transcript trace distinguishes raw material from the input quote offsets', async () => {
  const path = '/synthetic/corpus/pasted-session.txt';
  const raw = `[user]\n<pasted_content id="1">discarded source bytes</pasted_content>\n${SOURCE}`;
  const input = corpusTextForExtraction(path, raw);
  expect(input).not.toBe(raw);
  const hash = createHash('sha256').update(raw).digest('hex');
  const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
    _transcripts: [{ filePath: path, content: raw, contentHash: hash }], _chat: chat });
  expect(outcome.status).toBe('ok');
  const atom = await onlyAtom();
  expect(atom.frontmatter.raw_trace).toEqual({ source_id: 'default', source_path: path, source_hash: hash,
    input_hash: createHash('sha256').update(input).digest('hex'), quote_offset_basis: 'extractor_input_utf16' });
  const [start, end] = atom.frontmatter.source_quote_offset as [number, number];
  expect(input.slice(start, end)).toBe(QUOTE);
  expect(raw.slice(start, end)).not.toBe(QUOTE);
  expect((await rawProvenanceCheck(engine)).status).toBe('ok');
});
