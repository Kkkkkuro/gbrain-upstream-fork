import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = [
  ['src/core/facts/subject-infer.ts', 'async function aliasSlugsContained'],
  ['src/core/facts/subject-infer.ts', 'const ENTITY_DIR_SLUG'],
  ['src/core/facts/subject-infer.ts', 'input.mode === \'relink\' || input.mode === \'write\''],
  ['test/facts-subject-infer.test.ts', 'a prose slash does not veto one registered alias'],
] as const;

export type ReapplyResult = 'present' | 'applied' | 'failed' | 'partial';

export function defaultInstallRoot(): string {
  return join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
}

export function patchPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'gbrain-subject-infer-alias.patch');
}

function readText(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

export function markerHits(root: string): number {
  return MARKERS.filter(([rel, text]) => readText(root, rel)?.includes(text) === true).length;
}

function rejectFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(path);
      else if (name.endsWith('.rej') || name.endsWith('.orig')) found.push(path);
    }
  };
  walk(root);
  return found;
}

function snapshot(root: string): Map<string, string | null> {
  const files = new Map<string, string | null>();
  for (const [rel] of MARKERS) files.set(rel, readText(root, rel));
  return files;
}

function restore(root: string, before: Map<string, string | null>): void {
  for (const [rel, text] of before) {
    const path = join(root, rel);
    if (text === null) {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  for (const junk of rejectFiles(root)) rmSync(junk, { force: true });
}

function unchanged(root: string, before: Map<string, string | null>): boolean {
  for (const [rel, text] of before) {
    if (readText(root, rel) !== text) return false;
  }
  return rejectFiles(root).length === 0;
}

export interface PatchRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runPatch(root: string, patch: string, dryRun: boolean): PatchRun {
  const args = ['--forward', '--batch', '-r', '-', '-d', root, '-p1', '-i', patch];
  if (dryRun) args.unshift('--dry-run');
  const result = spawnSync('patch', args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function reapplySubjectInfer(
  root: string,
  patch = patchPath(),
  apply: (root: string, patch: string) => PatchRun = (target, patchFile) => runPatch(target, patchFile, false),
): { result: ReapplyResult; output: string } {
  const hits = markerHits(root);
  if (hits === MARKERS.length) return { result: 'present', output: '' };
  if (hits > 0) {
    return { result: 'partial', output: `reapply partial: ${hits} of ${MARKERS.length} subject-infer markers exist\n` };
  }
  const before = snapshot(root);
  const dry = runPatch(root, patch, true);
  const dryOutput = `${dry.stderr}${dry.stdout}`;
  if (dry.status !== 0 || !unchanged(root, before)) {
    for (const junk of rejectFiles(root)) rmSync(junk, { force: true });
    return { result: 'failed', output: dryOutput };
  }
  const applied = apply(root, patch);
  const output = `${dryOutput}${applied.stderr}${applied.stdout}`;
  if (applied.status !== 0 || markerHits(root) !== MARKERS.length || rejectFiles(root).length > 0) {
    restore(root, before);
    return { result: 'failed', output };
  }
  return { result: 'applied', output };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : defaultInstallRoot();
  if (!root) {
    process.stderr.write('reapply: missing --root value\n');
    process.exit(1);
  }
  const outcome = reapplySubjectInfer(root);
  if (outcome.output) process.stderr.write(outcome.output);
  if (outcome.result === 'failed' || outcome.result === 'partial') process.exit(1);
  process.stdout.write(`reapply ${outcome.result}\n`);
}
