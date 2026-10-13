import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultInstallRoot, reapplySubjectInfer } from './reapply.ts';

/** The only machine that writes the Mini brain. Other hosts must not install this hook. */
export const MINI_HOSTNAME = 'KuroChendeMac-mini.local';

export function isMiniWriter(host = hostname()): boolean {
  return host === MINI_HOSTNAME;
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
