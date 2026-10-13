import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = [
  ['src/core/backup/status-file.ts', 'export function pendingBackupContinuationEligible'],
  ['src/core/backup/status-file.ts', 'export function backupRemoteClaimsAllowContinuation'],
  ['src/core/backup/coverage.ts', 'export async function continuePendingBackupOnce'],
  ['src/commands/autopilot-daemon.ts', 'continuePendingBackupOnce'],
] as const;

export type ReapplyResult = 'present' | 'applied' | 'failed';

export function defaultInstallRoot(): string {
  return join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
}

export function patchPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'gbrain-backup-pending-continuation.patch');
}

function hasMarkers(root: string): boolean {
  return MARKERS.every(([file, text]) => {
    try {
      return readFileSync(join(root, file), 'utf8').includes(text);
    } catch {
      return false;
    }
  });
}

export function reapplyBackupPatch(root: string, patch = patchPath()): ReapplyResult {
  if (hasMarkers(root)) return 'present';
  const result = spawnSync('patch', ['-d', root, '-p1', '--forward', '--batch', '-i', patch], {
    encoding: 'utf8',
  });
  if (hasMarkers(root)) return 'applied';
  if (result.status !== 0) return 'failed';
  return 'failed';
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : defaultInstallRoot();
  if (!root) {
    process.stderr.write('reapply: missing --root value\n');
    process.exit(1);
  }
  const outcome = reapplyBackupPatch(root);
  process.stdout.write(`reapply ${outcome}\n`);
  process.exit(outcome === 'failed' ? 1 : 0);
}
