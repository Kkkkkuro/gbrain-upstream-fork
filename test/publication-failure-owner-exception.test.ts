/**
 * #5929: an unexpected exception inside the owner's preparation or publication
 * keeps a bounded identity (class, errno, repo-relative top gbrain frame, never
 * its message), so the attempt is stamped with the owner's build; remote
 * receipts expose only the allow-listed public keys; `gbrain write-request`
 * names an owner/CLI build mismatch with a restart fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { receiptFor } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { publicFailureDetail, OWNER_EXCEPTION_MESSAGE } from '../src/core/persistence/publication-failure.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-exception-'));
const sourceId = `owner-exc-${randomUUID().slice(0, 8)}`;
const logger = { info() {}, warn() {}, error() {} };
const ctx = () => ({ engine, sourceId, remote: false, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false, logger }) as never;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const root = join(dir, 'brain'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => claimWorktree(engine, sourceId, root));
}, 60_000);
afterAll(async () => { installFaultHook(undefined); await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

async function failingWrite(error: Error): Promise<{ thrown: OperationError; row: WriteRequest }> {
  const slug = `notes/${randomUUID().slice(0, 8)}`;
  const requestId = randomUUID();
  installFaultHook(async point => { if (point === 'consumer:prepared') throw error; });
  let thrown: unknown;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => submitPageMutation(ctx(), { operation: 'put_page',
      params: { slug, content: '---\ntype: note\ntitle: Example\n---\nBody.\n', request_id: requestId } }));
  } catch (e) { thrown = e; } finally { installFaultHook(undefined); }
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return { thrown: thrown as OperationError, row };
}

describe('#5929 owner exceptions keep a bounded identity', () => {
  test('a TypeError is stored with its class and repo-relative frame, the attempt is stamped, and its message never leaves the owner', async () => {
    // As thrown inside gbrain: a dependency frame first, then gbrain's own source under an absolute checkout path.
    const error = Object.assign(new TypeError('cannot read secret-value of undefined'), { stack: [
      'TypeError: cannot read secret-value of undefined',
      '    at parse (/home/alice-example/.bun/install/global/node_modules/yaml/dist/index.js:10:3)',
      '    at preparePageMutation (/home/alice-example/gbrain/src/core/persistence/page-prepare.ts:120:15)',
      '    at run (/home/alice-example/gbrain/src/core/persistence/consumer.ts:540:9)'].join('\n') });
    const { thrown, row } = await failingWrite(error);
    expect(thrown).toBeInstanceOf(OperationError);
    expect(thrown.code).toBe('storage_error');
    expect(row.error_code).toBe('storage_error');
    expect(row.error_message).toBe(OWNER_EXCEPTION_MESSAGE);
    expect(row.error_message).not.toContain('TypeError');
    expect(row.error_message).not.toContain(VERSION);
    const detail = row.error_detail as Record<string, any>;
    expect(detail).toMatchObject({ origin: 'owner_exception', error_class: 'TypeError', stage: 'publication', attempt: { consumer_version: VERSION } });
    expect(detail.frame).toBe('src/core/persistence/page-prepare.ts:120');
    expect(JSON.stringify(row)).not.toContain('secret-value');
    expect(JSON.stringify(row)).not.toContain('alice-example');
  });

  test('an errno-bearing error keeps the errno', async () => {
    const { row } = await failingWrite(Object.assign(new Error('no space left on /home/alice-example/brain'), { code: 'ENOSPC' }));
    expect(row.error_detail).toMatchObject({ origin: 'owner_exception', error_class: 'Error', errno: 'ENOSPC' });
    expect(row.error_message).toBe(OWNER_EXCEPTION_MESSAGE);
    expect(row.error_message).not.toContain('ENOSPC');
    expect(JSON.stringify(row)).not.toContain('alice-example');
  });

  // Protects the trusted writer-status guidance, which the existing public-receipt tests do not read.
  // Regresses if unknown owner/database origins are again routed to a trigger repair; uses the real reader,
  // stored receipts and existing fault seam, with no new production seam or real provider/database access.
  test('writer status preserves an owner exception without claiming a database trigger or a known cause', async () => {
    class PostgresError extends Error { code = '0A000'; }
    const error = new PostgresError('PRIVATE_DATABASE_TEXT');
    error.stack = 'PostgresError: PRIVATE_DATABASE_TEXT\n    at publish (/example/gbrain/src/core/persistence/sync-prepare.ts:100:2)';
    const { row } = await failingWrite(error);
    const status = await readWriterDiagnostics(engine);
    const failure = status.recent_failures.find(f => f.request_id === row.request_id)!;
    expect(failure.error_code).toBe('storage_error');
    const storedDetail = row.error_detail;
    if (!storedDetail) throw new Error('owner exception lost its recorded identity');
    expect(failure.error_detail).toEqual(storedDetail);
    expect(failure.error_detail).toMatchObject({ origin: 'owner_exception', errno: '0A000', error_class: 'PostgresError',
      frame: 'src/core/persistence/sync-prepare.ts:100', attempt: { consumer_version: VERSION } });
    expect(failure.next_action).toContain('owner exception');
    expect(failure.next_action).toContain('cause is unknown');
    expect(failure.next_action).toContain('consumer log');
    expect(failure.next_action).toContain('report');
    expect(failure.next_action).not.toContain('A database trigger refused');
    expect(failure.next_action).not.toContain('apply-migrations');
    expect(JSON.stringify(status)).not.toContain('PRIVATE_DATABASE_TEXT');
  });

  test.each(['database', 'future_origin'])('writer status leaves a %s cause unknown instead of guessing a trigger', async origin => {
    const { row } = await failingWrite(new Error('PRIVATE_DATABASE_TEXT'));
    const detail = { origin, sqlstate: 'P0001', reason: 'unknown', stage: 'publication' };
    await engine.executeRaw('UPDATE persistence_requests SET error_detail=$2::jsonb WHERE id=$1::uuid', [row.id, JSON.stringify(detail)]);
    const failure = (await readWriterDiagnostics(engine)).recent_failures.find(f => f.request_id === row.request_id)!;
    expect(failure.error_code).toBe('storage_error');
    expect(failure.error_detail).toEqual(detail);
    expect(failure.next_action).toContain('cause is unknown');
    expect(failure.next_action).toContain('gbrain write-request');
    expect(failure.next_action).not.toContain('A database trigger refused');
    expect(failure.next_action).not.toContain('apply-migrations');
  });

  test.each(['pending_import', 'sync_held'])('writer status keeps %s file refusals distinct from trigger or owner failures', async origin => {
    const { row } = await failingWrite(new Error('PRIVATE_DATABASE_TEXT'));
    const detail = { origin, stage: 'publication' };
    await engine.executeRaw("UPDATE persistence_requests SET error_code='source_changed',error_detail=$2::jsonb WHERE id=$1::uuid", [row.id, JSON.stringify(detail)]);
    const failure = (await readWriterDiagnostics(engine)).recent_failures.find(f => f.request_id === row.request_id)!;
    expect(failure.error_code).toBe('source_changed');
    expect(failure.error_detail).toEqual(detail);
    expect(failure.next_action).toContain('gbrain sync status');
    expect(failure.next_action).toContain(origin === 'pending_import' ? 'committed change' : 'holds the canonical file');
    expect(failure.next_action).not.toContain('cause is unknown');
    expect(failure.next_action).not.toContain('A database trigger refused');
    expect(failure.next_action).not.toContain('apply-migrations');
  });

  test('the receipt any caller reads carries none of the owner-only fields', async () => {
    const { row } = await failingWrite(new RangeError('bad offset'));
    const receipt = receiptFor(row) as Record<string, any>;
    expect(receipt.write_error_detail).toEqual({ origin: 'owner_exception', stage: 'publication' });
  });

  test('the public view of today\'s detail shapes is unchanged', () => {
    const guard = { origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer', table: 'tags', branch: 'source_scope', op: 'INSERT',
      relationship: 'different_source', sources: { target: 'a', old: null, allowed: ['b'] }, stage: 'publication', attempt: { consumer_version: '0.60.1.0', consumer_host_id: 'h' } };
    expect(JSON.stringify(publicFailureDetail(guard))).toBe(JSON.stringify({ origin: 'database_guard', sqlstate: 'P0001', raiser: 'gbrain_require_managed_writer',
      table: 'tags', branch: 'source_scope', op: 'INSERT', relationship: 'different_source', stage: 'publication' }));
    const fence = { origin: 'fence', fence: { version: 1, fence: 'facts', section: 'body', reason: 'malformed_row', rows: [3], issues: [{ row: 3, column: 'kind', problem: 'invalid_enum' }] },
      stage: 'preparation', attempt: { consumer_version: '0.60.1.0', consumer_host_id: 'h' } };
    expect(JSON.stringify(publicFailureDetail(fence))).toBe(JSON.stringify({ origin: 'fence', fence: { version: 1, fence: 'facts', section: 'body', reason: 'malformed_row',
      issues: [{ column: 'kind', problem: 'invalid_enum' }] }, stage: 'preparation' }));
    expect(publicFailureDetail({ origin: 'database', sqlstate: 'P0001', surprise: 'leak' })).toEqual({ origin: 'database', sqlstate: 'P0001' });
  });

  test('write-request names an owner build that differs from this CLI, with a restart fix', async () => {
    const { row } = await failingWrite(new TypeError('stale owner'));
    await engine.executeRaw(`UPDATE persistence_requests SET error_detail=jsonb_set(error_detail,'{attempt,consumer_version}','"0.60.1.0"') WHERE id=$1::uuid`, [row.id]);
    const receipt = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () =>
      operationsByName.get_write_request.handler(ctx(), { request_id: row.request_id })) as Record<string, any>;
    expect(receipt.owner_build).toMatchObject({ owner: '0.60.1.0', cli: VERSION });
    expect(receipt.owner_build.why).toContain('gbrain serve');
    expect(receipt.owner_build.fix).toMatchObject({ actor: 'user', verify: { argv: ['gbrain', 'doctor', '--only', 'writer_version', '--json'] } });
  });
});
