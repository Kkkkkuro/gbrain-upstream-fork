import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// test-reads-source-ok[structural]: execute the actual CI mount block and inspect its argv boundaries.
const script = readFileSync(join(import.meta.dir, '../scripts/ci-local.sh'), 'utf8');
const start = script.indexOf('EXTRA_MOUNTS=()');
const end = script.indexOf('echo "[ci-local] Running checks inside runner container..."', start);
if (start < 0 || end < start) throw new Error('CI worktree mount block was not found');
const block = script.slice(start, end);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function mounts(withSpaces: boolean, worktree = true): { actual: string[]; expected: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-ci-worktree-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const common = join(root, withSpaces ? 'git common with spaces' : 'git-common');
  const gitdir = join(common, 'worktrees', 'candidate');
  mkdirSync(cwd);
  mkdirSync(gitdir, { recursive: true });
  if (worktree) {
    writeFileSync(join(cwd, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
  } else mkdirSync(join(cwd, '.git'));
  const command = `${block}\nprintf '__MOUNTS__\\n'\nprintf '%s\\n' "\${EXTRA_MOUNTS[@]}"\n`;
  const child = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  expect(child.status).toBe(0);
  const actual = child.stdout.split('__MOUNTS__\n')[1].trimEnd().split('\n').filter(Boolean);
  return { actual, expected: worktree ? ['-v', `${common}:${common}:ro`] : [] };
}

test('CI mounts the complete shared git directory when its path contains spaces', () => {
  const result = mounts(true);
  expect(result.actual).toEqual(result.expected);
});

test('CI retains the same mount arguments for a worktree without spaces', () => {
  const result = mounts(false);
  expect(result.actual).toEqual(result.expected);
});

test('CI adds no shared-git mount for a normal clone', () => {
  const result = mounts(true, false);
  expect(result.actual).toEqual(result.expected);
});
