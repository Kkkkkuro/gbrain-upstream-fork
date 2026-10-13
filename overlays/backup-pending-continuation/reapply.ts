import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = [
  ['src/core/backup/status-file.ts', 'export function pendingBackupContinuationEligible'],
  ['src/core/backup/status-file.ts', 'export function backupRemoteClaimsAllowContinuation'],
  ['src/core/backup/coverage.ts', 'export async function continuePendingBackupOnce'],
  ['src/commands/autopilot-daemon.ts', 'continuePendingBackupOnce'],
] as const;

const TOUCHED = [
  'src/core/backup/status-file.ts',
  'src/core/backup/coverage.ts',
  'src/commands/autopilot-daemon.ts',
  'test/backup-pending-continuation.test.ts',
] as const;

export type ReapplyResult = 'present' | 'applied' | 'partial' | 'mismatch';

export type ReapplyOutcome = {
  result: ReapplyResult;
  patchOutput: string;
};

export function defaultInstallRoot(): string {
  return join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
}

export function patchPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'gbrain-backup-pending-continuation.patch');
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function markerReport(root: string): { found: number; lines: string[] } {
  const lines: string[] = [];
  let found = 0;
  for (const [file, text] of MARKERS) {
    const body = readOrNull(join(root, file));
    const hit = body !== null && body.includes(text);
    if (hit) found += 1;
    lines.push(`${hit ? 'present' : 'absent'} ${file} ${text}`);
  }
  return { found, lines };
}

function runPatch(root: string, patch: string, dryRun: boolean): { status: number | null; output: string } {
  const args = ['-d', root, '-p1', '--forward', '--batch', '-r', '-'];
  if (dryRun) args.push('--dry-run');
  args.push('-i', patch);
  const result = spawnSync('patch', args, { encoding: 'utf8' });
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  return { status: result.status, output };
}

function snapshot(root: string): Map<string, string | null> {
  const saved = new Map<string, string | null>();
  for (const rel of TOUCHED) saved.set(rel, readOrNull(join(root, rel)));
  return saved;
}

function restore(root: string, saved: Map<string, string | null>): void {
  for (const [rel, body] of saved) {
    const path = join(root, rel);
    if (body === null) {
      try { unlinkSync(path); } catch { /* absent before apply */ }
    } else {
      writeFileSync(path, body);
    }
    for (const suffix of ['.rej', '.orig']) {
      try { unlinkSync(path + suffix); } catch { /* none */ }
    }
  }
}

export function reapplyBackupPatch(root: string, patch = patchPath()): ReapplyOutcome {
  const report = markerReport(root);
  if (report.found === MARKERS.length) return { result: 'present', patchOutput: '' };
  if (report.found > 0) {
    return {
      result: 'partial',
      patchOutput: `partial markers, not patching\n${report.lines.join('\n')}\n`,
    };
  }
  const before = snapshot(root);
  const dry = runPatch(root, patch, true);
  if (dry.status !== 0) {
    restore(root, before);
    return { result: 'mismatch', patchOutput: dry.output };
  }
  const applied = runPatch(root, patch, false);
  if (markerReport(root).found !== MARKERS.length) {
    restore(root, before);
    return { result: 'mismatch', patchOutput: applied.output || dry.output };
  }
  return { result: 'applied', patchOutput: applied.output };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : defaultInstallRoot();
  if (!root) {
    process.stderr.write('reapply: missing --root value\n');
    process.exit(1);
  }
  const outcome = reapplyBackupPatch(root);
  if (outcome.patchOutput) process.stderr.write(outcome.patchOutput);
  process.stdout.write(`reapply ${outcome.result}\n`);
  process.exit(outcome.result === 'present' || outcome.result === 'applied' ? 0 : 1);
}
