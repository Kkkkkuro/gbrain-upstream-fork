/** Default guard roots must be filesystem paths, including URL-reserved characters. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const guard = join(repo, 'scripts/check-core-guard-coverage.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tree(kind: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain guard 中文 #%-'));
  dirs.push(root);
  cpSync(join(repo, 'test/fixtures/guards/check-core-guard-coverage.mjs', kind), root, { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(guard, join(root, 'scripts/check-core-guard-coverage.mjs'));
  return root;
}
function run(root: string, args: string[] = [], override?: string) {
  const env = { ...process.env };
  delete env.GBRAIN_GUARD_ROOT;
  if (override !== undefined) env.GBRAIN_GUARD_ROOT = override;
  const result = spawnSync('node', [join(root, 'scripts/check-core-guard-coverage.mjs'), ...args],
    { cwd: tmpdir(), env, encoding: 'utf8', timeout: 10_000 });
  return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
}
test('default root decodes spaces, Unicode, hash and percent without depending on cwd', () => {
  const result = run(tree('good'));
  expect(result.out).toContain('check-core-guard-coverage: OK');
  expect(result.code).toBe(0);
});
for (const [kind, diagnostic] of [['bad', 'without the core guard'], ['bad-drop', 'drops exclusiveSources']]) {
  test(`default root still rejects ${kind} with the actual core guard diagnostic`, () => {
    const result = run(tree(kind!));
    expect(result.code).toBe(1);
    expect(result.out).toContain(diagnostic!);
    expect(result.out).not.toContain('ENOENT');
  });
}
test('explicit argv root still overrides the environment and script root', () => {
  const result = run(tree('bad'), [tree('good')], tree('bad-drop'));
  expect(result.code).toBe(0);
  expect(result.out).toContain('check-core-guard-coverage: OK');
});
test('environment root still overrides the script root when no argv is given', () => {
  const result = run(tree('good'), [], tree('bad-drop'));
  expect(result.code).toBe(1);
  expect(result.out).toContain('drops exclusiveSources');
});
