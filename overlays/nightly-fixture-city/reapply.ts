import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_REL = 'test/fixtures/longmemeval-nightly.jsonl';
export const PLACEHOLDER_CITY = 'placeholder-city';
export const FIXTURE_CITY = 'harbor-city-example';

export type ReapplyResult = 'present' | 'applied' | 'missing';
export type CheckResult = 'ok' | 'placeholder-city' | 'missing';

export function defaultInstallRoot(): string {
  return join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
}

function readFixture(root: string): string | null {
  try {
    return readFileSync(join(root, FIXTURE_REL), 'utf8');
  } catch {
    return null;
  }
}

export function reapplyNightlyFixtureCity(root: string): ReapplyResult {
  const body = readFixture(root);
  if (body === null) return 'missing';
  if (!body.includes(PLACEHOLDER_CITY)) return 'present';
  writeFileSync(join(root, FIXTURE_REL), body.replaceAll(PLACEHOLDER_CITY, FIXTURE_CITY));
  return 'applied';
}

export function checkNightlyFixtureCity(root: string): CheckResult {
  const body = readFixture(root);
  if (body === null) return 'missing';
  return body.includes(PLACEHOLDER_CITY) ? 'placeholder-city' : 'ok';
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const checkOnly = process.argv.includes('--check');
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : defaultInstallRoot();
  if (!root) {
    process.stderr.write('reapply: missing --root value\n');
    process.exit(1);
  }
  if (!checkOnly) {
    const result = reapplyNightlyFixtureCity(root);
    process.stdout.write(`reapply ${result}\n`);
    if (result === 'missing') process.exit(1);
  }
  const check = checkNightlyFixtureCity(root);
  if (check === 'ok') {
    process.stdout.write('nightly fixture check ok\n');
    process.exit(0);
  }
  process.stdout.write(`nightly fixture check fail: ${check}\n`);
  process.exit(1);
}
