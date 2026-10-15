/**
 * v0.31.8 — multi_source_drift doctor check (D8 + D14 + D17 + OV12 + OV13).
 *
 * Heuristic: a non-default source X with local_path set, where the FS at
 * local_path contains a markdown file whose slug exists at (default, slug)
 * in DB but is missing from (X, slug). Surfaces evidence of pre-v0.30.3
 * putPage misroutes OR an incomplete initial sync.
 *
 * Test cases (5):
 *   1. Single-source brain → check skipped (no row in checks output).
 *   2. Multi-source brain, no misroutes → status `ok`.
 *   3. Multi-source brain, 2 misrouted slugs → status `warn` with sample.
 *   4. Multi-source brain, healthy same-slug-across-sources (file at X has
 *      DB row at X AND default has its own legitimate slug) → ok (NOT a
 *      false positive).
 *   5. FS walk hits limit → status `warn 'check skipped, walk too large'`.
 *
 * #5862: sources pinned to git-root slugs are compared using the prefix git
 * reports for local_path inside its work tree (empty at the toplevel), and a
 * source git cannot place keeps the doctor verdict at "not verified".
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { writeSlugRootMode } from '../src/core/sync-anchor.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { withEnv } from './helpers/with-env.ts';
import { multiSourceDriftCheck } from '../src/commands/doctor/schema-pack-checks.ts';

let engine: PGLiteEngine;
const TMP_ROOTS: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const dir of TMP_ROOTS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmpRoot(label: string): string {
  const dir = join(tmpdir(), `gbrain-drift-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

function seedFile(root: string, relPath: string, content = 'placeholder\n'): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('findMisroutedPages — heuristic correctness', () => {
  test('case 1: no non-default sources → returns empty result (caller skips check)', async () => {
    // Findfn is called by doctor only when at least one non-default source
    // with local_path exists; passing an empty array is the equivalent.
    const result = await findMisroutedPages(engine, []);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 2: multi-source brain, no misroutes → count=0', async () => {
    const root = makeTmpRoot('case2');
    seedFile(root, 'people/alice.md');
    seedFile(root, 'people/bob.md');

    // Register the source via runSources, then update local_path directly.
    await runSources(engine, ['add', 'src-case2', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case2'],
    );
    // Both slugs land in (src-case2, *), NOT in (default, *). Healthy.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '.' }, { sourceId: 'src-case2' });
    await engine.putPage('people/bob',   { type: 'person', title: 'Bob',   compiled_truth: '.' }, { sourceId: 'src-case2' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case2', local_path: root }]);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 3: multi-source brain, 2 misrouted slugs → warn with sample', async () => {
    const root = makeTmpRoot('case3');
    seedFile(root, 'people/charlie.md');
    seedFile(root, 'people/dana.md');

    await runSources(engine, ['add', 'src-case3', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case3'],
    );
    // Both slugs land in (default, *) — the misroute shape.
    await engine.putPage('people/charlie', { type: 'person', title: 'Charlie', compiled_truth: '.' });
    await engine.putPage('people/dana',    { type: 'person', title: 'Dana',    compiled_truth: '.' });
    // src-case3 has neither.

    const result = await findMisroutedPages(engine, [{ id: 'src-case3', local_path: root }]);
    expect(result.count).toBe(2);
    expect(result.sample.length).toBe(2);
    const slugs = result.sample.map(s => s.slug).sort();
    expect(slugs).toEqual(['people/charlie', 'people/dana']);
    for (const s of result.sample) {
      expect(s.intended_source).toBe('src-case3');
      expect(s.local_path).toBe(root);
    }
  });

  test('case 4: healthy same-slug-across-sources is NOT a false positive (OV4 redesign)', async () => {
    const root = makeTmpRoot('case4');
    seedFile(root, 'topics/widget.md');

    await runSources(engine, ['add', 'src-case4', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case4'],
    );
    // Page exists at BOTH sources — the v0.18.0 supported state. The FS file
    // at src-case4 has a row at (src-case4, ...) AND default has its own.
    await engine.putPage('topics/widget', { type: 'concept', title: 'Default widget', compiled_truth: '.' });
    await engine.putPage('topics/widget', { type: 'concept', title: 'Src widget',     compiled_truth: '.' }, { sourceId: 'src-case4' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case4', local_path: root }]);
    // Heuristic requires "(default, slug) AND NOT (X, slug)". Since both
    // exist, it's NOT misroute. Count must be 0 — this is the codex OV4 fix
    // case, the original "same-slug-across-sources = corruption" heuristic
    // would have false-positived here.
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
  });

  test('case 5: FS walk hits limit → walk_truncated=true', async () => {
    const root = makeTmpRoot('case5');
    // Seed 12 files with a limit of 5 to force truncation.
    for (let i = 0; i < 12; i++) {
      seedFile(root, `topics/file-${i}.md`);
    }

    const result = await findMisroutedPages(engine, [{ id: 'src-case5-fake', local_path: root }], {
      limit: 5,
      timeoutMs: 5000,
    });
    expect(result.walk_truncated).toBe(true);
  });

  test('case 6 (OV13): unreadable local_path does NOT crash; returns empty', async () => {
    const result = await findMisroutedPages(engine, [
      { id: 'src-fake', local_path: '/nonexistent/path/that/does/not/exist' },
    ]);
    // Walk silently returns zero files; count=0, NOT throw.
    expect(result.count).toBe(0);
    expect(result.walk_truncated).toBe(false);
  });

  test('case 7 (OV13): .mdx files are walked alongside .md', async () => {
    const root = makeTmpRoot('case7');
    seedFile(root, 'topics/mdx-page.mdx');

    await runSources(engine, ['add', 'src-case7', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case7'],
    );
    // Misroute the slug into default.
    await engine.putPage('topics/mdx-page', { type: 'concept', title: 'mdx', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case7', local_path: root }]);
    expect(result.count).toBe(1);
    expect(result.sample[0].slug).toBe('topics/mdx-page');
  });

  test('case 8 (#4712): a git-root-pinned source is skipped, not false-positived', async () => {
    const root = makeTmpRoot('case8');
    seedFile(root, 'page.md');

    await runSources(engine, ['add', 'src-case8', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = $2`,
      [root, 'src-case8'],
    );
    await writeSlugRootMode(engine, 'src-case8', 'git-root');
    // Sync actually produced the git-root-prefixed slug (what import.ts's
    // importRelPath would derive) — NOT local_path-relative 'page'.
    await engine.putPage('src-case8/page', { type: 'concept', title: 'p', compiled_truth: '.' }, { sourceId: 'src-case8' });
    // An unrelated page legitimately owns the local_path-relative slug at
    // default — this is exactly the #4712 false-positive shape pre-fix.
    await engine.putPage('page', { type: 'concept', title: 'unrelated', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [{ id: 'src-case8', local_path: root }]);
    expect(result.count).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.git_root_skipped).toEqual(['src-case8']);
  });

  test('case 9 (#4712): git-root skip does not mask real drift on a sibling source-root source', async () => {
    const gitRootRoot = makeTmpRoot('case9-gitroot');
    seedFile(gitRootRoot, 'page.md');
    await runSources(engine, ['add', 'src-case9-gr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [gitRootRoot, 'src-case9-gr']);
    await writeSlugRootMode(engine, 'src-case9-gr', 'git-root');
    await engine.putPage('src-case9-gr/page', { type: 'concept', title: 'p', compiled_truth: '.' }, { sourceId: 'src-case9-gr' });
    await engine.putPage('page', { type: 'concept', title: 'unrelated', compiled_truth: '.' });

    const sourceRootRoot = makeTmpRoot('case9-srcroot');
    seedFile(sourceRootRoot, 'people/eve.md');
    await runSources(engine, ['add', 'src-case9-sr', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [sourceRootRoot, 'src-case9-sr']);
    // Genuine misroute: exists at default, missing from the intended source.
    await engine.putPage('people/eve', { type: 'person', title: 'Eve', compiled_truth: '.' });

    const result = await findMisroutedPages(engine, [
      { id: 'src-case9-gr', local_path: gitRootRoot },
      { id: 'src-case9-sr', local_path: sourceRootRoot },
    ]);
    expect(result.count).toBe(1);
    expect(result.sample[0]).toMatchObject({ slug: 'people/eve', intended_source: 'src-case9-sr' });
    expect(result.git_root_skipped).toEqual(['src-case9-gr']);
  });
});

describe('findMisroutedPages — files sync never imports (#6681)', () => {
  test('root AGENTS.md/CLAUDE.md metafiles are not drift; docs/AGENTS.md still is', async () => {
    await engine.putPage('agents', { type: 'concept', title: 'default agents', compiled_truth: '.' });
    await engine.putPage('claude', { type: 'concept', title: 'default claude', compiled_truth: '.' });
    await engine.putPage('docs/agents', { type: 'concept', title: 'docs agents', compiled_truth: '.' });

    const meta = makeTmpRoot('meta6681');
    seedFile(meta, 'AGENTS.md');
    seedFile(meta, 'CLAUDE.md');
    await runSources(engine, ['add', 'src-meta6681', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [meta, 'src-meta6681']);
    const metaResult = await findMisroutedPages(engine, [{ id: 'src-meta6681', local_path: meta }]);
    expect(metaResult.count).toBe(0);
    expect(metaResult.sample).toEqual([]);

    const real = makeTmpRoot('real6681');
    seedFile(real, 'docs/AGENTS.md');
    await runSources(engine, ['add', 'src-real6681', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [real, 'src-real6681']);
    const realResult = await findMisroutedPages(engine, [{ id: 'src-real6681', local_path: real }]);
    expect(realResult.count).toBe(1);
    expect(realResult.sample.map(s => s.slug)).toEqual(['docs/agents']);
  });
});

describe('findMisroutedPages — git-root pins inside a work tree (#5862)', () => {
  /** A fresh repository; returns `<repo>/<subdir>` (the repo itself for ''). */
  function gitWorkTree(label: string, subdir: string): string {
    const repo = makeTmpRoot(label);
    execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
    const dir = subdir ? join(repo, subdir) : repo;
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function registerSource(id: string, localPath: string, pin: 'git-root' | 'source-root' | null): Promise<void> {
    await runSources(engine, ['add', id, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [localPath, id]);
    if (pin) await writeSlugRootMode(engine, id, pin);
  }

  /**
   * Two files under local_path. Sync stored `kept` under the source; `lost`
   * exists only at default (a misroute). `<plain>/lost` is an unrelated
   * default page that a wrong (unprefixed) slug shape would also flag.
   */
  async function seedPair(id: string, localPath: string, slugPrefix: string, tag: string): Promise<void> {
    seedFile(localPath, `${tag}/kept.md`);
    seedFile(localPath, `${tag}/lost.md`);
    await engine.putPage(`${slugPrefix}${tag}/kept`, { type: 'note', title: 'Kept', compiled_truth: '.' }, { sourceId: id });
    await engine.putPage(`${slugPrefix}${tag}/lost`, { type: 'note', title: 'Lost', compiled_truth: '.' });
    if (slugPrefix) await engine.putPage(`${tag}/kept`, { type: 'note', title: 'Unrelated', compiled_truth: '.' });
  }

  test('git-root source at its repo toplevel is checked with no prefix', async () => {
    const root = gitWorkTree('gr-top', '');
    await registerSource('src-gr-top', root, 'git-root');
    await seedPair('src-gr-top', root, '', 'grtop');

    const result = await findMisroutedPages(engine, [{ id: 'src-gr-top', local_path: root }]);
    expect(result.git_root_skipped).toEqual([]);
    expect(result.sample).toEqual([{ slug: 'grtop/lost', intended_source: 'src-gr-top', local_path: root }]);
    expect(multiSourceDriftCheck(result, 1, 'local').details).toMatchObject({ code: 'drift_detected' });
  });

  test('git-root source two levels down gets its work-tree location as the slug prefix', async () => {
    const root = gitWorkTree('gr-nested', join('Field Notes', '2026'));
    await registerSource('src-gr-nested', root, 'git-root');
    await seedPair('src-gr-nested', root, 'field-notes/2026/', 'grnested');

    const result = await findMisroutedPages(engine, [{ id: 'src-gr-nested', local_path: root }]);
    expect(result.git_root_skipped).toEqual([]);
    expect(result.count).toBe(1);
    expect(result.sample.map((s) => s.slug)).toEqual(['field-notes/2026/grnested/lost']);
  });

  test('a symlinked local_path takes the prefix of the directory it points to', async () => {
    const real = gitWorkTree('gr-link', 'shared');
    const link = join(makeTmpRoot('gr-link-alias'), 'alias');
    symlinkSync(real, link);
    await registerSource('src-gr-link', link, 'git-root');
    await seedPair('src-gr-link', link, 'shared/', 'grlink');

    const result = await findMisroutedPages(engine, [{ id: 'src-gr-link', local_path: link }]);
    expect(result.git_root_skipped).toEqual([]);
    expect(result.sample).toEqual([{ slug: 'shared/grlink/lost', intended_source: 'src-gr-link', local_path: link }]);
  });

  test('control: a source-root source in a subdirectory keeps local_path-relative slugs', async () => {
    const root = gitWorkTree('sr-sub', 'docs');
    await registerSource('src-sr-sub', root, 'source-root');
    await seedPair('src-sr-sub', root, '', 'srsub');

    const result = await findMisroutedPages(engine, [{ id: 'src-sr-sub', local_path: root }]);
    expect(result.sample.map((s) => s.slug)).toEqual(['srsub/lost']);
  });

  test('a git-root source whose local_path is gone is unreadable, not a git-root skip', async () => {
    const gone = join(makeTmpRoot('gr-gone'), 'missing');
    await registerSource('src-gr-gone', gone, 'git-root');

    const result = await findMisroutedPages(engine, [{ id: 'src-gr-gone', local_path: gone }]);
    expect(result.git_root_skipped).toEqual([]);
    expect(result.unreadable_sources).toEqual([{ source_id: 'src-gr-gone', reason: 'root_unreadable', dirs: 1 }]);
  });
});

describe('multiSourceDriftCheck — skipped git-root sources (#5862)', () => {
  const clean = { walk_truncated: false, count: 0, sample: [], unreadable_sources: [], limit: 10_000, timeout_ms: 5_000 };

  test('one skipped source beside a clean one is not verified, and says why', () => {
    const check = multiSourceDriftCheck({ ...clean, git_root_skipped: ['src-outside-git'] }, 2, 'local');
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ code: 'not_verified', verified: false, git_root_skipped: ['src-outside-git'] });
    expect(check.message).toStartWith('No cross-source slug drift among checked sources.');
    expect(check.message).toContain('src-outside-git');
    expect(check.message).toContain('work tree');
    expect(check.message).not.toContain('#4712');
  });

  test('every candidate skipped means no verification at all', () => {
    const check = multiSourceDriftCheck({ ...clean, git_root_skipped: ['a', 'b'] }, 2, 'remote');
    expect(check.status).toBe('warn');
    expect(check.message).toStartWith('Multi-source drift check performed no verification');
  });

  test('control: nothing skipped and nothing found is ok', () => {
    const check = multiSourceDriftCheck({ ...clean, git_root_skipped: [] }, 2, 'local');
    expect(check).toMatchObject({ status: 'ok', message: 'No cross-source slug drift detected.' });
  });
});

/**
 * Admission regression (#6681): Doctor must only call an absent counterpart
 * drift when sync admits its path. The old walker admitted root scaffolds and
 * Markdown excluded by a code source; existing cases only covered ordinary
 * Markdown. Real files and PGLite rows exercise the public detector, without a
 * new production seam. Reverting its admission filter must fail these cases.
 */
describe('findMisroutedPages — sync admission parity', () => {
  async function sourceWithFiles(id: string, files: string[], strategy: 'markdown' | 'code' | 'auto', subdir = '', pin: 'git-root' | 'source-root' = 'git-root') {
    const repo = makeTmpRoot(id);
    execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
    const root = join(repo, subdir);
    mkdirSync(root, { recursive: true });
    for (const file of files) seedFile(root, file);
    execFileSync('git', ['-C', repo, 'add', '--', ...files.map(file => subdir ? `${subdir}/${file}` : file)], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { stdio: 'pipe' });
    await runSources(engine, ['add', id, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path=$1,config=jsonb_set(config,'{strategy}',to_jsonb($2::text)) WHERE id=$3`, [root, strategy, id]);
    await writeSlugRootMode(engine, id, pin);
    return { id, local_path: root };
  }

  test('committed root scaffolds do not imply drift or delete independent default pages', async () => {
    const src = await sourceWithFiles('admit-scaffolds', ['AGENTS.md', 'CLAUDE.md', 'README.md', 'admission-real.md'], 'markdown');
    for (const slug of ['agents', 'claude', 'readme', 'admission-real']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Independent default ${slug}` });
    }
    const before = await engine.executeRaw(`SELECT slug,compiled_truth,knowledge_revision FROM pages WHERE source_id='default' AND slug IN ('agents','claude','readme','admission-real') ORDER BY slug`);
    const result = await findMisroutedPages(engine, [src]);
    expect(result.count).toBe(1);
    expect(result.sample.map(s => s.slug)).toEqual(['admission-real']);
    expect(result.unreadable_sources).toEqual([]);
    expect(await engine.executeRaw(`SELECT slug,compiled_truth,knowledge_revision FROM pages WHERE source_id='default' AND slug IN ('agents','claude','readme','admission-real') ORDER BY slug`)).toEqual(before);
  });

  test.each(['code', 'markdown', 'auto'] as const)('stored %s strategy determines whether a Markdown counterpart is intended', async strategy => {
    const slug = `admission-strategy-${strategy}`;
    const src = await sourceWithFiles(`admit-${strategy}`, [`${slug}.md`], strategy);
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Default-owned page' });
    const result = await findMisroutedPages(engine, [src]);
    expect(result.count).toBe(strategy === 'code' ? 0 : 1);
    expect(result.sample.map(s => s.slug)).toEqual(strategy === 'code' ? [] : [slug]);
    expect(multiSourceDriftCheck(result, 1, 'local').status).toBe(strategy === 'code' ? 'ok' : 'warn');
  });

  test.each(['git-root', 'source-root'] as const)('AGENTS below the Git root remains real content with a %s slug pin', async pin => {
    const subdir = `admission-nested-${pin}`;
    const src = await sourceWithFiles(`admit-nested-${pin}`, ['AGENTS.md'], 'markdown', subdir, pin);
    const slug = pin === 'git-root' ? `${subdir}/agents` : 'agents';
    await engine.putPage(slug, { type: 'note', title: 'Nested agent notes', compiled_truth: 'Unimported nested page' });
    const result = await findMisroutedPages(engine, [src]);
    expect(result.count).toBe(1);
    expect(result.sample.map(s => s.slug)).toEqual([slug]);
  });

  test.each(['git-root', 'source-root'] as const)('persisted source-relative exclusions agree with managed sync under a %s slug pin', async pin => {
    const subdir = `admission-exclude-${pin}`;
    const src = await sourceWithFiles(`admit-exclude-${pin}`, ['notes/skip.md', 'raw/deep.md', 'notes/real.md'], 'markdown', subdir, pin);
    const prefix = pin === 'git-root' ? `${subdir}/` : '';
    for (const path of ['notes/skip', 'raw/deep', 'notes/real']) {
      await engine.putPage(prefix + path, { type: 'note', title: path, compiled_truth: 'Independent default page' });
    }
    await engine.setConfig('sync.exclude', 'notes/skip.md, raw/');
    try {
      const result = await findMisroutedPages(engine, [src]);
      expect(result.count).toBe(1);
      expect(result.sample.map(s => s.slug)).toEqual([prefix + 'notes/real']);
      expect(result.walk_truncated).toBe(false);
    } finally { await engine.unsetConfig('sync.exclude'); }
  });

  test('reserved skill bundles and nonwaivable generated directories never imply missing knowledge pages', async () => {
    const src = await sourceWithFiles('admit-reserved', ['skills/check/SKILL.md', 'notes/Skills/guide.md', 'venv/installed.md', 'notes/source.raw/source.md', 'notes/real.md'], 'markdown');
    for (const slug of ['skills/check/skill', 'notes/skills/guide', 'venv/installed', 'notes/source.raw/source', 'notes/real']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Independent default page' });
    }
    const result = await findMisroutedPages(engine, [src]);
    expect(result.count).toBe(1);
    expect(result.sample.map(s => s.slug)).toEqual(['notes/real']);
  });

  test('persisted include_hidden admits genuine hidden drift without waiving explicit exclusions or generated trees', async () => {
    const subdir = 'admission-hidden';
    const paths = ['.notes/real.md', '.notes/skip.md', '.notes/venv/installed.md', '_notes.md'];
    const src = await sourceWithFiles('admit-hidden', paths, 'markdown', subdir, 'source-root');
    for (const slug of ['.notes/real', '.notes/skip', '.notes/venv/installed', '_notes']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Independent default page' });
    }
    await engine.setConfig('sync.include_hidden', `${subdir}/.notes/`);
    await engine.setConfig('sync.exclude', '.notes/skip.md');
    try {
      const result = await findMisroutedPages(engine, [src]);
      expect(result.count).toBe(2);
      expect(result.sample.map(s => s.slug).sort()).toEqual(['.notes/real', '_notes']);
      expect(result.walk_truncated).toBe(false);
    } finally {
      await engine.unsetConfig('sync.include_hidden');
      await engine.unsetConfig('sync.exclude');
    }
  });


  test.each(['git-root', 'source-root'] as const)('managed discovery preserves reserved-path coordinates for a %s source below skills/', async pin => {
    const src = await sourceWithFiles(`managed-res-${pin}`, ['notes/coordinate.md'], 'markdown', `docs/skills/${pin}`, pin);
    await withEnv({ GBRAIN_HOME: makeTmpRoot(`managed-home-${pin}`) }, async () => {
      await claimWorktree(engine, src.id, src.local_path);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const discovery = await discoverManagedSync(engine, { sourceId: src.id, noPull: true, noEmbed: true, dryRun: true, full: true });
        expect(discovery.slugMode).toBe(pin);
        expect(discovery.entries.map(e => e.sourcePath)).toEqual(pin === 'git-root' ? [] : ['notes/coordinate.md']);
      } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
    });
  });

  test.each(['git-root', 'source-root'] as const)('drift uses the same reserved-path coordinate as a %s source below skills/', async pin => {
    const subdir = `docs/skills/drift-${pin}`;
    const src = await sourceWithFiles(`drift-res-${pin}`, ['notes/coordinate.md'], 'markdown', subdir, pin);
    const slug = pin === 'git-root' ? `${subdir}/notes/coordinate` : 'notes/coordinate';
    await engine.putPage(slug, { type: 'note', title: 'Coordinate page', compiled_truth: 'Independent default page' });
    const result = await findMisroutedPages(engine, [src]);
    expect(result.count).toBe(pin === 'git-root' ? 0 : 1);
    expect(result.sample.map(s => s.slug)).toEqual(pin === 'git-root' ? [] : [slug]);
  });

});
