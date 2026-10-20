import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Markers unique to RC-EXTRACT-H2-FIRST-ASYNC (H2 + first-async attribution). */
const MARKERS = [
  ['src/core/persistence/atom-maintenance.ts', 'outcome?.extract_halt_attributed === true'],
  ['src/core/extract/atoms-run-finalization.ts', 'haltRequestIds?: string[]'],
  ['src/core/extract/atoms-run-finalization.ts', 'extract_halt_attribution'],
  ['src/core/cycle/extract-atoms.ts', 'haltRequestIds: [...haltRequestIds]'],
  ['test/h2-first-async-halt.test.ts', 'first observed conflict after an earlier pending phase must contribute its first halt'],
] as const;

export type ReapplyResult = 'present' | 'applied' | 'failed' | 'partial';

const TOUCHED = [
  'src/core/cycle/extract-atoms.ts',
  'src/core/extract/atoms-run-finalization.ts',
  'src/core/persistence/atom-maintenance.ts',
  'test/h2-first-async-halt.test.ts',
  'test/h2-terminal-replay.test.ts',
  'test/h2-terminal-replay-boundaries.test.ts',
] as const;

const SIDECAR_SUFFIXES = ['.rej', '.orig'] as const;

export function defaultInstallRoot(): string {
  return join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
}

export function patchPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'gbrain-extract-h2-first-async.patch');
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

interface Snapshot {
  files: Map<string, string | null>;
  sidecars: Map<string, string | null>;
}

function snapshot(root: string): Snapshot {
  const files = new Map<string, string | null>();
  const sidecars = new Map<string, string | null>();
  for (const rel of TOUCHED) {
    files.set(rel, readText(root, rel));
    for (const suffix of SIDECAR_SUFFIXES) sidecars.set(rel + suffix, readText(root, rel + suffix));
  }
  return { files, sidecars };
}

function restore(root: string, before: Snapshot): void {
  for (const [rel, text] of before.files) {
    const path = join(root, rel);
    if (text === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  for (const [rel, text] of before.sidecars) {
    if (text !== null) continue;
    rmSync(join(root, rel), { force: true });
  }
}

function createdSidecar(root: string, before: Snapshot): boolean {
  for (const [rel, text] of before.sidecars) {
    if (text === null && readText(root, rel) !== null) return true;
  }
  return false;
}

function unchanged(root: string, before: Snapshot): boolean {
  for (const [rel, text] of before.files) {
    if (readText(root, rel) !== text) return false;
  }
  return !createdSidecar(root, before);
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

export function reapplyExtractH2FirstAsync(
  root: string,
  patch = patchPath(),
  apply: (root: string, patch: string) => PatchRun = (target, patchFile) => runPatch(target, patchFile, false),
): { result: ReapplyResult; output: string } {
  const hits = markerHits(root);
  if (hits === MARKERS.length) return { result: 'present', output: '' };
  if (hits > 0) {
    return { result: 'partial', output: `reapply partial: ${hits} of ${MARKERS.length} extract-h2-first-async markers exist\n` };
  }
  const before = snapshot(root);
  const dry = runPatch(root, patch, true);
  const dryOutput = `${dry.stderr}${dry.stdout}`;
  if (dry.status !== 0 || !unchanged(root, before)) {
    restore(root, before);
    return { result: 'failed', output: dryOutput };
  }
  const applied = apply(root, patch);
  const output = `${dryOutput}${applied.stderr}${applied.stdout}`;
  if (applied.status !== 0 || markerHits(root) !== MARKERS.length || createdSidecar(root, before)) {
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
  const outcome = reapplyExtractH2FirstAsync(root);
  if (outcome.output) process.stderr.write(outcome.output);
  if (outcome.result === 'failed' || outcome.result === 'partial') process.exit(1);
  process.stdout.write(`reapply ${outcome.result}\n`);
}
