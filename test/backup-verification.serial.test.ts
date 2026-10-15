import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { computeBackupCoverage, getBackupStatus } from '../src/core/backup/coverage.ts';
import { __setBackupStatusPathForTests, loadBackupStatus, saveBackupStatus, invalidateBackupStatus } from '../src/core/backup/status-file.ts';
import * as backupStatusModule from '../src/core/backup/status-file.ts';
import { checkBackupCoverage } from '../src/commands/doctor/checks/backup-coverage.ts';
import { pushStatusPathForRoot } from '../src/core/workspace-push.ts';
import { assessBackupRepository, BACKUP_REMOTE_PROBE_CAP, BACKUP_REMOTE_BUDGET_MS, BACKUP_REMOTE_TIMEOUT_MS } from '../src/core/backup/repository.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;
let oldHome: string | undefined;
const now = new Date('2026-09-22T12:00:00Z');
const verified = { localGitProbes: true, verifyRemoteRefs: true, now };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-backup-evidence-')));
  oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  __setBackupStatusPathForTests(join(tmp, 'status.json'));
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  __setBackupStatusPathForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function repository(name = 'source') {
  const root = join(tmp, name);
  const remote = join(tmp, `${name}.git`);
  mkdirSync(root);
  await makeGitFixture(root);
  git(root, 'branch', '-M', 'main');
  writeFileSync(join(root, 'note.md'), '# Fixture memory\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return { root, remote };
}
function engine(roots: string[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string) => sql.includes('FROM pages') ? [{ n: 1 }]
      : roots.map((root, i) => ({ id: `fixture-${i}`, name: 'fixture', local_path: root, archived: false, config: {} })),
  } as unknown as BrainEngine;
}

test('a deleted remote cannot be verified by a surviving tracking ref', async () => {
  const { root, remote } = await repository();
  rmSync(remote, { recursive: true });
  expect(git(root, 'rev-parse', 'origin/main')).toBe(git(root, 'rev-parse', 'HEAD'));
  const result = await computeBackupCoverage(engine([root]), verified);
  expect(result.overall).toBe('warn');
  expect(result.totals.recoverable_repos).toBe(0);
  expect(result.totals.configured_repos).toBe(1);
  expect(result.assets[0].verification?.state).toBe('unavailable');
});

test('only a clean matching remote commit is verified, and git never covers the full database', async () => {
  const { root } = await repository();
  const result = await computeBackupCoverage(engine([root]), verified);
  expect(result.overall).toBe('ok');
  expect(result.totals.recoverable_repos).toBe(1);
  expect(result.assets[0].verification).toMatchObject({ state: 'verified', checked_at: now.toISOString(), local_commit: git(root, 'rev-parse', 'HEAD'), remote_commit: git(root, 'rev-parse', 'HEAD') });
  expect(result.recovery_scope).toContain('not a full database backup');
});

test('a removed remote branch and a changed remote commit invalidate local tracking evidence', async () => {
  const { root, remote } = await repository();
  git(remote, 'update-ref', '-d', 'refs/heads/main');
  let result = await computeBackupCoverage(engine([root]), verified);
  expect(result.totals.recoverable_repos).toBe(0);
  expect(result.assets[0].verification?.state).toBe('missing_ref');
  git(root, 'commit', '--allow-empty', '-m', 'newer fixture');
  git(root, 'push', 'origin', 'main');
  git(root, 'reset', '--hard', 'HEAD~1');
  result = await computeBackupCoverage(engine([root]), verified);
  expect(result.totals.recoverable_repos).toBe(0);
  expect(result.overall).toBe('warn');
  expect(result.assets[0].verification?.state).toBe('mismatch');
});

test('unpushed, dirty and failed-push states are never fully recoverable', async () => {
  const { root } = await repository();
  git(root, 'commit', '--allow-empty', '-m', 'not pushed');
  let result = await computeBackupCoverage(engine([root]), verified);
  expect(result.overall).toBe('warn');
  expect(result.totals.unpushed).toBe(1);
  expect(result.totals.recoverable_repos).toBe(0);
  git(root, 'push');
  writeFileSync(join(root, 'note.md'), '# New memory not committed\n');
  result = await computeBackupCoverage(engine([root]), verified);
  expect(result.overall).toBe('warn');
  expect(result.totals.recoverable_repos).toBe(0);
  git(root, 'checkout', '--', 'note.md');
  git(root, 'commit', '--allow-empty', '-m', 'failed push leaves a new revision unbacked');
  const statusPath = pushStatusPathForRoot(root);
  mkdirSync(join(statusPath, '..'), { recursive: true });
  writeFileSync(statusPath, JSON.stringify({ schema_version: 'gbrain-push-status-v1', root, ok: false, reason: 'offline', timestamp: now.toISOString() }));
  result = await computeBackupCoverage(engine([root]), verified);
  expect(result.overall).toBe('warn');
  expect(result.totals.failing).toBe(1);
  expect(result.totals.recoverable_repos).toBe(0);
});

test('local-only checks cannot certify a configured remote', async () => {
  const { root } = await repository();
  const result = await computeBackupCoverage(engine([root]), { localGitProbes: true, now });
  expect(result.totals.configured_repos).toBe(1);
  expect(result.totals.recoverable_repos).toBe(0);
  expect(result.overall).toBe('warn');
});

test('remote doctor reads aggregate cache only and downgrades expired evidence', async () => {
  const { root } = await repository();
  saveBackupStatus(await computeBackupCoverage(engine([root]), verified));
  const untouched = new Proxy({}, { get: () => { throw new Error('remote accessed the engine'); } }) as BrainEngine;
  const check = await checkBackupCoverage(untouched, { now: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
  expect(check.status).toBe('warn');
  expect(check.message).toContain('not verified');
  expect(JSON.stringify(check)).not.toContain(root);
  expect((check.details as { totals: { recoverable_repos: number } }).totals.recoverable_repos).toBe(0);
  expect(loadBackupStatus()?.totals.recoverable_repos).toBe(1);
});

test('failed refresh cannot silently reuse verified cache as a fresh success', async () => {
  const { root } = await repository();
  await getBackupStatus(engine([root]), { ...verified, forceRefresh: true });
  const before = readFileSync(join(tmp, 'status.json'), 'utf8');
  const down = { kind: 'pglite', executeRaw: async () => { throw new Error('offline'); } } as unknown as BrainEngine;
  const result = await getBackupStatus(down, { ...verified, forceRefresh: true });
  expect(result.degraded).toBe(true);
  expect(result.overall).toBe('warn');
  expect(result.totals.recoverable_repos).toBe(0);
  expect(readFileSync(join(tmp, 'status.json'), 'utf8')).toBe(before);
});

test('remote-ref readback is capped, cached, and never performed for untrusted or background readers', async () => {
  const roots = await Promise.all(Array.from({ length: BACKUP_REMOTE_PROBE_CAP + 2 }, async (_, i) => (await repository(`source-${i}`)).root));
  const run = childProcess.execFile;
  const commands: string[][] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: unknown, callback: unknown) => {
    commands.push(args);
    return (run as Function)(file, args, options, callback);
  }) as typeof childProcess.execFile);
  try {
    const result = await getBackupStatus(engine(roots), verified);
    expect(commands).toHaveLength(BACKUP_REMOTE_PROBE_CAP);
    expect(commands.every(args => args.includes('ls-remote') && !args.includes('push') && !args.includes('fetch'))).toBe(true);
    expect(result.assets.filter(a => a.verification?.state === 'budget_exhausted')).toHaveLength(2);
    expect(result.overall).toBe('warn');
    // Official249 throttles ordinary continuation for60s; forced checks retain claims.
    await getBackupStatus(engine(roots), verified);
    expect(commands).toHaveLength(BACKUP_REMOTE_PROBE_CAP);
    const followup = { ...verified, now: new Date(now.getTime() + 60_000) };
    const continued = await getBackupStatus(engine(roots), followup);
    expect(commands).toHaveLength(BACKUP_REMOTE_PROBE_CAP + 2);
    expect(continued.totals.recoverable_repos).toBe(10);
    await getBackupStatus(engine(roots), followup);
    expect(commands).toHaveLength(BACKUP_REMOTE_PROBE_CAP + 2);
    await computeBackupCoverage(engine(roots), { ...verified, localGitProbes: false });
    await computeBackupCoverage(engine(roots), { localGitProbes: true, now, computedBy: 'serve' });
    await checkBackupCoverage(engine(roots), { now });
    expect(commands).toHaveLength(BACKUP_REMOTE_PROBE_CAP + 2);
  } finally { probe.mockRestore(); }
});

test('timeouts spend a sweep-wide deadline, return no credentials, and never verify offline remotes', async () => {
  const roots = await Promise.all(Array.from({ length: 5 }, async (_, i) => (await repository(`offline-${i}`)).root));
  const timeouts: number[] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: { timeout: number }, callback: Function) => {
    timeouts.push(options.timeout);
    setTimeout(() => callback(new Error('https://fixture-user:fixture-password@example.invalid/private'), ''), options.timeout);
    return {};
  }) as unknown as typeof childProcess.execFile);
  const started = Date.now();
  try {
    const result = await computeBackupCoverage(engine(roots), verified);
    expect(timeouts.length).toBeLessThanOrEqual(Math.ceil(BACKUP_REMOTE_BUDGET_MS / BACKUP_REMOTE_TIMEOUT_MS));
    expect(timeouts.every(ms => ms > 0 && ms <= BACKUP_REMOTE_TIMEOUT_MS)).toBe(true);
    expect(Date.now() - started).toBeLessThan(BACKUP_REMOTE_BUDGET_MS + 3_000);
    expect(result.totals.recoverable_repos).toBe(0);
    expect(result.overall).toBe('warn');
    expect(result.assets.some(a => a.verification?.state === 'budget_exhausted')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-password');
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  } finally { probe.mockRestore(); }
}, 15_000);

test('a fresh aggregate cache never exposes commit or source identities to MCP', async () => {
  const { root } = await repository();
  await getBackupStatus(engine([root]), verified);
  const check = await checkBackupCoverage(engine([root]), { now });
  expect(check.status).toBe('ok');
  expect(JSON.stringify(check)).not.toContain(git(root, 'rev-parse', 'HEAD'));
  expect(JSON.stringify(check)).not.toContain('fixture-0');
  expect(JSON.stringify(check)).not.toContain(root);
});

test('fresh remote evidence supersedes a historical failed push but a new mismatch does not', async () => {
  const { root, remote } = await repository();
  const statusPath = pushStatusPathForRoot(root);
  mkdirSync(join(statusPath, '..'), { recursive: true });
  writeFileSync(statusPath, JSON.stringify({ ok: false, reason: 'https://fixture-user:fixture-password@example.invalid/private', ts: now.toISOString(), repoRoot: root }));
  const before = readFileSync(statusPath, 'utf8');
  let result = await getBackupStatus(engine([root]), { ...verified, forceRefresh: true });
  expect(result.overall).toBe('ok');
  expect(result.totals.recoverable_repos).toBe(1);
  expect(result.totals.failing).toBe(0);
  expect(readFileSync(statusPath, 'utf8')).toBe(before);
  git(root, 'commit', '--allow-empty', '-m', 'unpushed after recovery');
  result = await getBackupStatus(engine([root]), { ...verified, forceRefresh: true });
  expect(result.overall).toBe('warn');
  expect(result.totals.failing).toBe(1);
  expect(result.totals.recoverable_repos).toBe(0);
  rmSync(remote, { recursive: true });
  result = await getBackupStatus(engine([root]), { ...verified, forceRefresh: true });
  expect(result.totals.failing).toBe(1);
  expect(result.assets[0].verification?.state).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('fixture-password');
});

test('successive bounded checks prioritize pending roots and retain identity-bound fresh evidence', async () => {
  const roots = await Promise.all(Array.from({ length: BACKUP_REMOTE_PROBE_CAP + 2 }, async (_, i) => (await repository(`rotate-${i}`)).root));
  const run = childProcess.execFile;
  const commands: string[][] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((file: string, args: string[], options: unknown, callback: unknown) => {
    commands.push(args);
    return (run as Function)(file, args, options, callback);
  }) as typeof childProcess.execFile);
  try {
    const first = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true });
    expect(first.totals.recoverable_repos).toBe(BACKUP_REMOTE_PROBE_CAP);
    commands.length = 0;
    const second = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true, now: new Date(now.getTime() + 1000) });
    expect(commands).toHaveLength(2);
    expect(commands.slice(0, 2).map(args => args[1])).toEqual(roots.slice(-2));
    expect(second.totals.recoverable_repos).toBe(roots.length);
    expect(second.overall).toBe('ok');
    expect(second.assets.filter(a => a.verification?.checked_at === now.toISOString())).toHaveLength(8);
    for (const change of [
      { degraded: true },
      { checked_at: new Date(now.getTime() + 60_000).toISOString() },
      { checked_at: new Date(now.getTime() - 31 * 86400000).toISOString() },
    ]) {
      saveBackupStatus({ ...second, ...change });
      const invalidCache = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true, now: new Date(now.getTime() + 2000) });
      expect(invalidCache.totals.recoverable_repos).toBe(BACKUP_REMOTE_PROBE_CAP);
    }
    const reordered = await getBackupStatus(engine([...roots].reverse()), { ...verified, forceRefresh: true, now: new Date(now.getTime() + 2000) });
    expect(reordered.totals.recoverable_repos).toBe(BACKUP_REMOTE_PROBE_CAP);
  } finally { probe.mockRestore(); }
}, 25_000);

test('retained evidence is invalidated by local identity, source, commit, remote, push and clock changes', async () => {
  for (const change of ['head', 'branch', 'origin', 'replacement', 'dirty', 'push', 'source', 'future', 'stale']) {
    const { root, remote } = await repository(`identity-${change}`);
    const first = await assessBackupRepository(root, 'source_repo', 'source-id', now, { remaining: 1 });
    const retained = await assessBackupRepository(root, 'source_repo', 'source-id', now, undefined, first);
    expect(retained.verification?.state).toBe('verified');
    const inconsistent = await assessBackupRepository(root, 'source_repo', 'source-id', now, undefined, { ...first, state: 'failing' });
    expect(inconsistent.verification?.state).not.toBe('verified');
    expect(JSON.stringify(retained.verification)).not.toContain(remote);
    if (change === 'head') git(root, 'commit', '--allow-empty', '-m', 'new revision');
    if (change === 'branch') git(root, 'checkout', '-b', 'unverified-branch');
    if (change === 'origin') git(root, 'remote', 'set-url', 'origin', `${remote}-missing`);
    if (change === 'replacement') { renameSync(root, `${root}-old`); git(tmp, 'clone', remote, root); }
    if (change === 'dirty') writeFileSync(join(root, 'note.md'), '# Uncommitted memory\n');
    if (change === 'push') {
      const file = pushStatusPathForRoot(root);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ ok: false, ts: now.toISOString() }));
    }
    const checked = new Date(now.getTime() + (change === 'future' ? -1 : change === 'stale' ? 3600001 : 1));
    const result = await assessBackupRepository(root, 'source_repo', change === 'source' ? 'changed-id' : 'source-id', checked, undefined, first);
    expect(result.verification?.state).not.toBe('verified');
  }
}, 15_000);

test('the remote probe reads the user git config through HOME, so an insteadOf rewrite reaches the remote (#5794)', async () => {
  const { root, remote } = await repository();
  const alias = 'https://example.invalid/private-backup.git';
  git(root, 'remote', 'set-url', 'origin', alias);
  const userHome = join(tmp, 'user-home');
  mkdirSync(userHome);
  writeFileSync(join(userHome, '.gitconfig'), `[url "${remote}"]\n\tinsteadOf = ${alias}\n`);
  const head = git(root, 'rev-parse', 'HEAD');
  await withEnv({ HOME: userHome, GIT_CONFIG_GLOBAL: undefined, XDG_CONFIG_HOME: undefined,
    GIT_DIR: join(tmp, 'not-a-repository'), GIT_WORK_TREE: join(tmp, 'not-a-worktree') }, async () => {
    const result = await assessBackupRepository(root, 'source_repo', 'source-id', now, { remaining: 1 });
    expect(result.verification).toMatchObject({ state: 'verified', local_commit: head, remote_commit: head });
    expect(result.state).toBe('ok');
  });
}, 15_000);

// #6499: a probe is started only with its full two-second slot; a sub-slot leftover defers the root as budget_exhausted.
type ExecFileStub = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => unknown;

/** A remote that answers correctly after `answerMs`, killed the way execFile kills a timed-out child when the slot is shorter. */
function slowRemote(answerMs: number, timeouts: number[]): ExecFileStub {
  return (_file, args, options, callback) => {
    timeouts.push(options.timeout);
    const head = git(args[args.indexOf('-C') + 1], 'rev-parse', 'HEAD');
    const ref = args[args.length - 1];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (error: Error | null, stdout: string) => { for (const t of timers) clearTimeout(t); callback(error, stdout); };
    timers.push(setTimeout(() => finish(null, `${head}\t${ref}\n`), answerMs));
    timers.push(setTimeout(() => finish(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }), ''), options.timeout));
    return {};
  };
}

/**
 * `slowRemote` on a virtual clock: each probe advances `Date.now()` by exactly `answerMs` and answers on the next tick, so the
 * sweep deadline sees only probe time. Real local git work between probes on a loaded runner can't eat the 4th probe's slot.
 */
function virtualSlowRemote(answerMs: number, timeouts: number[]): { restore: () => void } {
  let clock = Date.now();
  const time = spyOn(Date, 'now').mockImplementation(() => clock);
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((_file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
    timeouts.push(options.timeout);
    const head = git(args[args.indexOf('-C') + 1], 'rev-parse', 'HEAD');
    const ref = args[args.length - 1];
    clock += Math.min(answerMs, options.timeout);
    setImmediate(() => answerMs < options.timeout
      ? callback(null, `${head}\t${ref}\n`)
      : callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null }), ''));
    return {};
  }) as unknown as typeof childProcess.execFile);
  return { restore: () => { probe.mockRestore(); time.mockRestore(); } };
}

test('a remote that would not get its full slot is deferred as budget_exhausted, never probed on a sub-slot (#6499)', async () => {
  const roots = await Promise.all(Array.from({ length: 5 }, async (_, i) => (await repository(`slow-${i}`)).root));
  const timeouts: number[] = [];
  const probe = virtualSlowRemote(1_700, timeouts);
  try {
    const result = await computeBackupCoverage(engine(roots), verified);
    expect(timeouts).toEqual([BACKUP_REMOTE_TIMEOUT_MS, BACKUP_REMOTE_TIMEOUT_MS, BACKUP_REMOTE_TIMEOUT_MS, BACKUP_REMOTE_TIMEOUT_MS]);
    const states = result.assets.filter(a => a.kind === 'source_repo').map(a => a.verification?.state);
    expect(states.filter(s => s === 'verified')).toHaveLength(4);
    expect(states).toContain('budget_exhausted');
    expect(states).not.toContain('unavailable');
  } finally { probe.restore(); }
}, 20_000);

test('a deferred probe keeps first-pass verified evidence; a transport failure still supersedes it (#6499)', async () => {
  const roots = await Promise.all(Array.from({ length: 5 }, async (_, i) => (await repository(`keep-${i}`)).root));
  const first = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true });
  expect(first.assets.filter(a => a.verification?.state === 'verified')).toHaveLength(5);
  const timeouts: number[] = [];
  const probe = virtualSlowRemote(1_700, timeouts);
  try {
    const second = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true, now: new Date(now.getTime() + 1000) });
    expect(timeouts).toHaveLength(4);
    expect(second.assets.filter(a => a.kind === 'source_repo').map(a => a.verification?.state)).toEqual(['verified', 'verified', 'verified', 'verified', 'verified']);
    expect(second.totals.recoverable_repos).toBe(5);
  } finally { probe.restore(); }
  const failing = spyOn(childProcess, 'execFile').mockImplementation(((_f: string, _a: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
    timeouts.push(options.timeout);
    setTimeout(() => callback(Object.assign(new Error('fatal: could not read from remote'), { code: 128 }), ''), 10);
    return {};
  }) as unknown as typeof childProcess.execFile);
  try {
    const third = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true, now: new Date(now.getTime() + 2000) });
    expect(third.assets.filter(a => a.kind === 'source_repo').every(a => a.verification?.state === 'unavailable' && a.verification.cause === 'exit')).toBe(true);
    expect(third.totals.recoverable_repos).toBe(0);
  } finally { failing.mockRestore(); }
}, 30_000);

test('assessBackupRepository with less than a full slot left starts no git process; a killed full-slot probe says cause: timeout (#6499)', async () => {
  const { root } = await repository('direct');
  const calls: number[] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(slowRemote(5_000, calls) as unknown as typeof childProcess.execFile);
  try {
    const deferred = await assessBackupRepository(root, 'source_repo', 'source-id', now, { remaining: 1, deadline: Date.now() + 1_000 });
    expect(calls).toEqual([]);
    expect(deferred.verification).toMatchObject({ state: 'budget_exhausted' });
    expect(deferred.verification).not.toHaveProperty('cause');
    const killed = await assessBackupRepository(root, 'source_repo', 'source-id', now, { remaining: 1 });
    expect(calls).toEqual([BACKUP_REMOTE_TIMEOUT_MS]);
    expect(killed.verification).toMatchObject({ state: 'unavailable', cause: 'timeout' });
  } finally { probe.mockRestore(); }
}, 15_000);

/** The error execFileSync throws when its `timeout` kills a slow git (what a loaded runner produced). */
function timeOutLocalGit(match: (args: string[]) => boolean) {
  const real = childProcess.execFileSync;
  return spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[], options: unknown) => {
    if (file === 'git' && match(args)) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
    return real(file, args, options as Parameters<typeof real>[2]);
  }) as unknown as typeof childProcess.execFileSync);
}

test('a local git probe that times out keeps an established bad verdict and never certifies a repository', async () => {
  const { root } = await repository('slow-local');
  git(root, 'commit', '--allow-empty', '-m', 'unpushed after a failed push');
  const statusPath = pushStatusPathForRoot(root);
  mkdirSync(join(statusPath, '..'), { recursive: true });
  writeFileSync(statusPath, JSON.stringify({ schema_version: 'gbrain-push-status-v1', root, ok: false, reason: 'offline', timestamp: now.toISOString() }));
  let slow = timeOutLocalGit(args => args.includes('status'));
  try {
    const failed = await assessBackupRepository(root, 'source_repo', 'source-id', now);
    expect(failed).toMatchObject({ state: 'failing', detail: 'last_push_failed' });
    const result = await computeBackupCoverage(engine([root]), verified);
    expect(result.totals.failing).toBe(1);
    expect(result.totals.recoverable_repos).toBe(0);
  } finally { slow.mockRestore(); }
  rmSync(statusPath);
  slow = timeOutLocalGit(args => args.includes('--absolute-git-dir'));
  try {
    expect(await assessBackupRepository(root, 'source_repo', 'source-id', now)).toMatchObject({ state: 'unpushed', ahead: 1 });
  } finally { slow.mockRestore(); }
  git(root, 'push');
  slow = timeOutLocalGit(args => args.includes('--absolute-git-dir'));
  try {
    expect(await assessBackupRepository(root, 'source_repo', 'source-id', now)).toMatchObject({ state: 'unknown', detail: 'probe_failed' });
  } finally { slow.mockRestore(); }
});


// Continuation coordination uses synthetic/local fixtures only; no provider or remote service.
function stubSuccessfulRemote(onCall?: (root: string) => void): ExecFileStub {
  return (_file, args, _opts, callback) => {
    const root = args[args.indexOf('-C') + 1];
    onCall?.(root);
    queueMicrotask(() => callback(null, `${git(root, 'rev-parse', 'HEAD')}\t${args.at(-1)}\n`));
    return {};
  };
}

test('continuation retains real failures and never retries them to fill the next batch', async () => {
  const roots = await Promise.all(Array.from({ length: 10 }, async (_, i) => (await repository(`failure-${i}`)).root));
  const calls: string[] = [];
  const good = stubSuccessfulRemote();
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((_f: string, args: string[], opts: { timeout: number }, cb: (error: Error | null, stdout: string) => void) => {
    const root = args[args.indexOf('-C') + 1]; calls.push(root);
    if (root === roots[0]) { queueMicrotask(() => cb(Object.assign(new Error('offline fixture'), { code: 128 }), '')); return {}; }
    return good(_f, args, opts, cb);
  }) as typeof childProcess.execFile);
  try {
    await getBackupStatus(engine(roots), verified);
    const second = await getBackupStatus(engine(roots), { ...verified, forceRefresh: true });
    expect(calls).toHaveLength(10);
    expect(new Set(calls).size).toBe(10);
    expect(second.assets[0].verification?.state).toBe('unavailable');
    expect(second.totals.recoverable_repos).toBe(9);
    expect(second.overall).toBe('warn');
  } finally { probe.mockRestore(); }
}, 15_000);

test('eight concurrent callers share a native lock and cannot duplicate remote claims', async () => {
  const roots = await Promise.all(Array.from({ length: 10 }, async (_, i) => (await repository(`parallel-${i}`)).root));
  let entered!: () => void; const firstEntered = new Promise<void>(r => { entered = r; });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const calls: string[] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((_f: string, args: string[], _opts: { timeout: number }, cb: (error: Error | null, stdout: string) => void) => {
    const root = args[args.indexOf('-C') + 1]; calls.push(root); entered();
    void gate.then(() => cb(null, `${git(root, 'rev-parse', 'HEAD')}\t${args.at(-1)}\n`)); return {};
  }) as typeof childProcess.execFile);
  try {
    const first = getBackupStatus(engine(roots), verified);
    await firstEntered;
    const others = await Promise.all(Array.from({ length: 7 }, () => getBackupStatus(engine(roots), verified)));
    expect(others.every(s => s.degraded)).toBe(true);
    release(); await first;
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(new Set(calls).size).toBe(calls.length);
    await getBackupStatus(engine(roots), { ...verified, now: new Date(now.getTime() + 60_000) });
    expect(calls).toHaveLength(10);
    expect(new Set(calls).size).toBe(10);
  } finally { release(); probe.mockRestore(); }
}, 20_000);

test('invalidation during a probe cannot resurrect the old cache generation', async () => {
  const { root } = await repository();
  const old = backupStatusModule.backupGeneration();
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => invalidateBackupStatus()) as typeof childProcess.execFile);
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(result.degraded).toBe(true);
    expect(loadBackupStatus()).toBeNull();
    expect(backupStatusModule.backupGeneration()).not.toBe(old);
    expect(() => saveBackupStatus(result, old)).toThrow('invalidated');
  } finally { probe.mockRestore(); }
});

test('a claim with no saved response is not replayed after a crash; TTL permits a new cycle', async () => {
  const { root } = await repository();
  const local = await assessBackupRepository(root, 'source_repo', 'fixture-0', now);
  const key = JSON.stringify(['source_repo', 'fixture-0', local.verification?.repository_fingerprint]);
  expect(backupStatusModule.claimBackupRemoteProbe(key, now, backupStatusModule.backupGeneration())).toBe(true);
  let calls = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(calls).toBe(0);
    expect(result.assets[0].verification?.state).toBe('not_checked');
    expect(result.assets[0].verification?.attempted_at).toBe(now.toISOString());
    expect(result.totals.recoverable_repos).toBe(0);
    await getBackupStatus(engine([root]), { ...verified, now: new Date(now.getTime() + 3_600_001) });
    expect(calls).toBe(1);
  } finally { probe.mockRestore(); }
});

test('claim persistence failure starts no remote work and cannot replace cached evidence', async () => {
  const { root } = await repository();
  mkdirSync(join(tmp, 'status.json.remote-claims'));
  let calls = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(calls).toBe(0);
    expect(result.degraded).toBe(true);
    expect(loadBackupStatus()).toBeNull();
  } finally { probe.mockRestore(); }
});

test('changed fingerprints invalidate a prior claim without retrying an unchanged fingerprint', async () => {
  const { root } = await repository();
  const local = await assessBackupRepository(root, 'source_repo', 'fixture-0', now);
  expect(backupStatusModule.claimBackupRemoteProbe(JSON.stringify(['source_repo', 'fixture-0', local.verification?.repository_fingerprint]), now, backupStatusModule.backupGeneration())).toBe(true);
  git(root, 'commit', '--allow-empty', '-m', 'changed synthetic head');
  let calls = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(calls).toBe(1);
    expect(result.assets[0].verification?.state).toBe('verified');
    await getBackupStatus(engine([root]), verified);
    expect(calls).toBe(1);
  } finally { probe.mockRestore(); }
});


test('failed invalidation is observable and the current process fails closed', async () => {
  const { root } = await repository();
  await getBackupStatus(engine([root]), verified);
  mkdirSync(join(tmp, 'status.json.generation'));
  const messages: string[] = [];
  const log = spyOn(process.stderr, 'write').mockImplementation(((message: string) => { messages.push(String(message)); return true; }) as typeof process.stderr.write);
  try {
    invalidateBackupStatus();
    expect(messages.join('')).toContain('could not persist cache invalidation');
    expect(loadBackupStatus()).toBeNull();
    expect(() => backupStatusModule.backupGeneration()).toThrow('invalidation failed');
    await expect(getBackupStatus(engine([root]), verified)).rejects.toThrow('invalidation failed');
  } finally { log.mockRestore(); }
});


test('corrupt invalidation generation fails closed before any network probe', async () => {
  const { root } = await repository();
  writeFileSync(join(tmp, 'status.json.generation'), 'not JSON');
  let calls = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  try {
    await expect(getBackupStatus(engine([root]), verified)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(loadBackupStatus()).toBeNull();
  } finally { probe.mockRestore(); }
});

test('mounted explicit verification retains its behavior without touching host cache or claims', async () => {
  const { root } = await repository();
  await getBackupStatus(engine([root]), verified);
  const cached = readFileSync(join(tmp, 'status.json'), 'utf8');
  const claims = readFileSync(join(tmp, 'status.json.remote-claims'), 'utf8');
  let calls = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  try {
    await withEnv({ GBRAIN_BRAIN_ID: 'fixture-mounted-brain' }, async () => {
      const result = await getBackupStatus(engine([root]), verified);
      expect(result.totals.recoverable_repos).toBe(1);
    });
    expect(calls).toBe(1);
    expect(readFileSync(join(tmp, 'status.json'), 'utf8')).toBe(cached);
    expect(readFileSync(join(tmp, 'status.json.remote-claims'), 'utf8')).toBe(claims);
  } finally { probe.mockRestore(); }
});


test('invalidation during a first probe cannot return an ok verdict without an older cache', async () => {
  const { root } = await repository();
  const head = git(root, 'rev-parse', 'HEAD');
  const probe = spyOn(childProcess, 'execFile').mockImplementation(((...args: any[]) => {
    invalidateBackupStatus();
    const callback = args[args.length - 1];
    callback(null, head + '\trefs/heads/main\n', '');
    return { kill() {} } as any;
  }) as any);
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(result.degraded).toBe(true);
    expect(result.overall).toBe('warn');
    expect(result.totals.recoverable_repos).toBe(0);
    expect(result.assets[0].verification?.state).not.toBe('verified');
    expect((await checkBackupCoverage(engine([root]), { localOnly: true, now })).status).toBe('warn');
  } finally { probe.mockRestore(); }
});

test('generation change immediately before save is not swallowed as an ordinary cache write failure', async () => {
  const { root } = await repository();
  const statusModule = await import('../src/core/backup/status-file.ts');
  const originalSave = statusModule.saveBackupStatus;
  const save = spyOn(statusModule, 'saveBackupStatus').mockImplementation((s, generation) => {
    invalidateBackupStatus();
    originalSave(s, generation);
  });
  try {
    const result = await getBackupStatus(engine([root]), verified);
    expect(result.degraded).toBe(true);
    expect(result.overall).toBe('warn');
    expect(result.totals.recoverable_repos).toBe(0);
    expect(loadBackupStatus()).toBeNull();
    expect((await checkBackupCoverage(engine([root]), { localOnly: true, now })).status).toBe('warn');
  } finally { save.mockRestore(); }
});


test('claim persistence time consumes the full-slot budget and cannot start a shortened remote probe', async () => {
  const { root } = await repository();
  let clock = Date.now();
  const time = spyOn(Date, 'now').mockImplementation(() => clock);
  let calls = 0;
  const claims: string[] = [];
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  const budget = { remaining: 1, deadline: clock + BACKUP_REMOTE_TIMEOUT_MS,
    claim: (key: string) => { claims.push(key); clock++; return true; } };
  try {
    const result = await assessBackupRepository(root, 'source_repo', 'fixture-0', now, budget);
    expect(claims).toHaveLength(1);
    expect(JSON.parse(claims[0]).slice(0, 2)).toEqual(['source_repo', 'fixture-0']);
    expect(calls).toBe(0);
    expect(budget.remaining).toBe(1);
    expect(result.verification).toMatchObject({ state: 'not_checked', attempted_at: now.toISOString() });
    expect(result.verification).not.toHaveProperty('cause');
  } finally { probe.mockRestore(); time.mockRestore(); }
});

test('an already claimed identity starts no duplicate remote probe or consumes a probe slot', async () => {
  const { root } = await repository();
  let calls = 0, claims = 0;
  const probe = spyOn(childProcess, 'execFile').mockImplementation(stubSuccessfulRemote(() => calls++) as typeof childProcess.execFile);
  const budget = { remaining: 1, claim: (_key: string) => { claims++; return false; } };
  try {
    const result = await assessBackupRepository(root, 'source_repo', 'fixture-0', now, budget);
    expect(claims).toBe(1);
    expect(calls).toBe(0);
    expect(budget.remaining).toBe(1);
    expect(result.verification).toMatchObject({ state: 'not_checked', attempted_at: now.toISOString() });
  } finally { probe.mockRestore(); }
});
