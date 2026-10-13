import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInstallRoot, reapplySubjectInfer } from './reapply.ts';

/** The only machine that writes the Mini brain. Other hosts must not install this hook. */
export const MINI_HOSTNAME = 'KuroChendeMac-mini.local';

export function isMiniWriter(host = hostname()): boolean {
  return host === MINI_HOSTNAME;
}

/** Absolute so `bun` can run it from `~/.bun/install/global`, where a relative overlay path does not exist. */
export function absolutePostinstallCommand(scriptPath = fileURLToPath(import.meta.url)): string {
  if (!isAbsolute(scriptPath)) throw new Error('postinstall script path is not absolute');
  return `bun ${scriptPath}`;
}

export function runPostinstall(host = hostname(), root = defaultInstallRoot()): number {
  if (!isMiniWriter(host)) {
    process.stdout.write('postinstall skipped: not the Mini writer\n');
    return 0;
  }
  const outcome = reapplySubjectInfer(root);
  if (outcome.output) process.stderr.write(outcome.output);
  if (outcome.result === 'failed' || outcome.result === 'partial') return 1;
  process.stdout.write(`postinstall ${outcome.result}\n`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(runPostinstall());
