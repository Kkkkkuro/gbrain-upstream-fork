import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeUpstream } from '../src/core/sync-upstream.ts';

test('an empty FETCH_HEAD or reflog cannot date an upstream observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-upstream-observation-'));
  const git = (...args: string[]) => execFileSync('git', [
    '-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const remote = join(root, 'origin.git');
    git('init', '-q', '-b', 'main');
    git('init', '-q', '--bare', '-b', 'main', remote);
    git('config', 'core.logAllRefUpdates', 'true');
    git('commit', '-qm', 'initial', '--allow-empty');
    git('remote', 'add', 'origin', remote);
    git('push', '-qu', 'origin', 'main');
    const head = git('rev-parse', 'HEAD');
    const fetchHead = join(root, '.git', 'FETCH_HEAD');
    const reflog = join(root, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    const lastRefUpdate = new Date('2024-01-01T00:00:00Z');
    const successfulFetch = new Date('2024-01-02T00:00:00Z');
    utimesSync(reflog, lastRefUpdate, lastRefUpdate);
    git('fetch', '-q', 'origin', 'main');
    utimesSync(fetchHead, successfulFetch, successfulFetch);
    expect(await observeUpstream(root, head)).toEqual({ checkedAt: successfulFetch, commit: head, behind: 0 });

    // A failed fetch can truncate FETCH_HEAD while the tracking ref still resolves.
    writeFileSync(fetchHead, '');
    expect(await observeUpstream(root, head)).toEqual({ checkedAt: lastRefUpdate, commit: head, behind: 0 });
    writeFileSync(reflog, '');
    expect(await observeUpstream(root, head)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
