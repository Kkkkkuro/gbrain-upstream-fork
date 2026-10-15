/** Independent real-PostgreSQL adversarial checks of the exact counter handler.
 * Direct handler calls avoid copying unrelated candidate registry/core changes.
 * No production seam; wrappers only observe real SQL or hold a transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type postgres from '#postgres';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { receiptCounterReconcileRepair as handler } from '../src/core/repair/receipt-counter-reconcile.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { freshBrainFactory, requestFixture, editRequest } from './helpers/persistence-request-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL!;
const counterRows = (engine: BrainEngine) => engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key');
const receipts = (engine: BrainEngine) => engine.executeRaw('SELECT row_to_json(r)::text AS row FROM persistence_requests r ORDER BY id');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!process.env.DATABASE_URL)('counter lock independent PostgreSQL review', () => {
  let factory: Awaited<ReturnType<typeof freshBrainFactory>>, scratch: string;
  let inspector: ReturnType<typeof postgres>;
  beforeAll(async () => {
    requirePostgresTestDatabase();
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-counter-lock-review-'));
    factory = await freshBrainFactory('postgres', databaseUrl);
    inspector = (await import('#postgres')).default(databaseUrl, { max: 1, prepare: false });
  }, 120_000);
  afterAll(async () => { await inspector?.end(); await factory?.dispose(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
  const isolated = (fn: (engine: BrainEngine) => Promise<void>) => () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => fn(await factory.fresh()));
  async function setup(engine: BrainEngine, count = 3) {
    const requests = await requestFixture(engine);
    for (let i = 0; i < count; i++) await requests.admit(`counter-review-${i}`);
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes+983040 WHERE key='brain' OR key LIKE 'principal:%'");
    });
    const scope = await resolveRepairScope(engine);
    const plan = await handler.plan(engine, scope, null, { apply: false, remote: false });
    const apply = (selected = engine) => handler.apply({ ...requests.ctx, engine: selected }, plan.items[0], { embed: false, expect: plan.preview_hash });
    return { requests, scope, plan, apply };
  }
  async function waitForLock(engine: BrainEngine, minimum = 1) {
    const [db] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    for (let i = 0; i < 200; i++) {
      const [row] = await inspector.unsafe<{ n: string }[]>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [db.name]);
      if (Number(row.n) >= minimum) return Number(row.n);
      await pause(10);
    }
    throw new Error('Expected real server lock waiter did not appear');
  }

  test('brain identity changes invalidate approved snapshot even with identical accounting', isolated(async engine => {
    const { apply, scope, plan } = await setup(engine);
    await engine.executeRaw('UPDATE persistence_brain SET brain_id=$1::uuid WHERE singleton=1', [randomUUID()]);
    const before = await counterRows(engine), history = await receipts(engine);
    await expect(handler.plan(engine, { ...scope, brain_id: randomUUID() }, null, { apply: true, remote: false, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'preview_changed' });
    await expect(apply()).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await counterRows(engine)).toEqual(before);
    expect(await receipts(engine)).toEqual(history);
  }), 120_000);

  test('principal membership changes reject even when existing drift and all aggregate bytes match', isolated(async engine => {
    const { apply } = await setup(engine);
    await engine.executeRaw("INSERT INTO persistence_counters(key) VALUES('principal:local_cli:review-zero-member')");
    const before = await counterRows(engine), history = await receipts(engine);
    await expect(apply()).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await counterRows(engine)).toEqual(before);
    expect(await receipts(engine)).toEqual(history);
  }), 120_000);

  test('transferring checkpoint into a distinct brain database cannot approve its counters', isolated(async engine => {
    const { plan, scope } = await setup(engine);
    const [saved] = await engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op='repair-approval' AND fingerprint=$1", [`receipt-counter-reconcile:${plan.preview_hash}`]);
    const [originalDb] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    // Factory creates a new scratch DB and disconnects the previous scratch.
    const other = await factory.fresh();
    const otherId = randomUUID();
    await other.executeRaw('UPDATE persistence_brain SET brain_id=$1::uuid WHERE singleton=1', [otherId]);
    const [otherDb] = await other.executeRaw<{ name: string }>('SELECT current_database() AS name');
    expect(otherDb.name).not.toBe(originalDb.name); expect(otherId).not.toBe(scope.brain_id);
    await other.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('repair-approval',$1,$2::text::jsonb)", [`receipt-counter-reconcile:${plan.preview_hash}`, JSON.stringify(saved.completed_keys)]);
    const before = await counterRows(other);
    await expect(handler.plan(other, await resolveRepairScope(other), null, { apply: true, remote: false, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await counterRows(other)).toEqual(before);
  }), 120_000);

  test('receipt state-only changes preserve accounting approval; every state is summed', isolated(async engine => {
    const { apply } = await setup(engine);
    const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests ORDER BY sequence LIMIT 1');
    await editRequest(engine, row.id, "state='failed',completed_at=now(),claim_expires_at=NULL");
    const history = await receipts(engine);
    expect(await apply()).toMatchObject({ applied: true });
    expect(await receipts(engine)).toEqual(history);
    const [drift] = await engine.executeRaw<{ delta: string }>("SELECT (c.terminal_bytes-(SELECT sum(terminal_reservation) FROM persistence_requests))::text AS delta FROM persistence_counters c WHERE key='brain'");
    expect(drift.delta).toBe('0');
  }), 120_000);

  test('remote or unset execution trust fails before any database call', isolated(async engine => {
    const { requests, scope, plan } = await setup(engine);
    const forbidden = Object.create(engine) as BrainEngine;
    forbidden.executeRaw = () => { throw new Error('unexpected database access'); };
    forbidden.transaction = () => { throw new Error('unexpected transaction'); };
    for (const remote of [true, undefined]) {
      await expect(handler.plan(forbidden, scope, null, { apply: true, remote, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(handler.apply({ ...requests.ctx, engine: forbidden, remote } as OperationContext, plan.items[0], { embed: false, expect: plan.preview_hash })).rejects.toMatchObject({ code: 'permission_denied' });
    }
  }), 120_000);

  test('two overlapping applies serialize: exactly one write, then exact poststate no-op', isolated(async engine => {
    const { apply } = await setup(engine);
    let reached!: () => void, release!: () => void;
    const locked = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
    const wrapped = Object.create(engine) as BrainEngine;
    wrapped.transaction = fn => engine.transaction(async tx => {
      const observed = Object.create(tx) as BrainEngine;
      observed.executeRaw = async (sql, params) => {
        if (sql.startsWith('UPDATE persistence_counters c SET terminal_bytes=')) { reached(); await gate; }
        return tx.executeRaw(sql, params);
      };
      return fn(observed);
    });
    const first = apply(wrapped);
    await locked;
    const second = apply();
    try { expect(await waitForLock(engine)).toBeGreaterThanOrEqual(1); }
    finally { release(); }
    expect(await first).toMatchObject({ applied: true, outcome: 'reconciled' });
    expect(await second).toMatchObject({ applied: false, outcome: 'already_reconciled' });
  }), 120_000);

  test('update failure rolls back every counter and releases locks for same-preview retry', isolated(async engine => {
    const { apply } = await setup(engine);
    const before = await counterRows(engine), history = await receipts(engine);
    await engine.executeRaw(`CREATE FUNCTION review_counter_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.key LIKE 'principal:%' AND NEW.terminal_bytes<>OLD.terminal_bytes THEN RAISE EXCEPTION 'review update failure'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER review_counter_fail BEFORE UPDATE ON persistence_counters FOR EACH ROW EXECUTE FUNCTION review_counter_fail()');
    await expect(apply()).rejects.toThrow('review update failure');
    expect(await counterRows(engine)).toEqual(before); expect(await receipts(engine)).toEqual(history);
    await engine.executeRaw('DROP TRIGGER review_counter_fail ON persistence_counters');
    await engine.executeRaw('DROP FUNCTION review_counter_fail()');
    expect(await apply()).toMatchObject({ applied: true });
  }), 120_000);

  test('2s lock wait timeout leaves counters intact and retry succeeds after holder releases', isolated(async engine => {
    const { apply } = await setup(engine);
    const before = await counterRows(engine);
    let reached!: () => void, release!: () => void;
    const locked = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
    const holder = engine.transaction(async tx => {
      await tx.executeRaw("SELECT * FROM persistence_counters WHERE key='brain' FOR UPDATE"); reached(); await gate;
    });
    await locked;
    const start = performance.now();
    const pending = apply();
    try {
      expect(await waitForLock(engine)).toBeGreaterThanOrEqual(1);
      await expect(pending).rejects.toThrow(/lock timeout/);
      expect(await counterRows(engine)).toEqual(before);
    } finally { release(); await holder; }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeGreaterThanOrEqual(1800); expect(elapsedMs).toBeLessThan(6000);
    expect(await apply()).toMatchObject({ applied: true });
    console.log(JSON.stringify({ evidence: 'lock_wait_timeout', elapsed_ms: elapsedMs }));
  }), 120_000);

  test('server cancellation after real UPDATE rolls back and releases all held counter locks', isolated(async engine => {
    const { apply } = await setup(engine);
    const before = await counterRows(engine), history = await receipts(engine);
    let reached!: (pid: number) => void;
    const sleeping = new Promise<number>(r => { reached = r; });
    const wrapped = Object.create(engine) as BrainEngine;
    wrapped.transaction = fn => engine.transaction(async tx => {
      const observed = Object.create(tx) as BrainEngine;
      observed.executeRaw = async <T = Record<string, unknown>>(sql: string, params?: unknown[], opts?: Parameters<BrainEngine['executeRaw']>[2]) => {
        const result = await tx.executeRaw<T>(sql, params, opts);
        if (sql.startsWith('UPDATE persistence_counters c SET terminal_bytes=')) {
          const [row] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          reached(row.pid); await tx.executeRaw('SELECT pg_sleep(30)');
        }
        return result;
      };
      return fn(observed);
    });
    const pending = apply(wrapped);
    const pid = await sleeping;
    // Wait for pg_sleep to be the actual active server query, avoiding a race
    // where cancel lands in the brief gap between backend-pid read and sleep.
    for (let i = 0; i < 200; i++) {
      const [row] = await inspector.unsafe<{ sleeping: boolean }[]>("SELECT query='SELECT pg_sleep(30)' AND state='active' AS sleeping FROM pg_stat_activity WHERE pid=$1", [pid]);
      if (row?.sleeping) break;
      if (i === 199) throw new Error('sleep not active');
      await pause(10);
    }
    const [cancelled] = await inspector.unsafe<{ cancelled: boolean }[]>('SELECT pg_cancel_backend($1) AS cancelled', [pid]);
    expect(cancelled.cancelled).toBe(true);
    await expect(pending).rejects.toThrow(/canceling statement due to user request/);
    expect(await counterRows(engine)).toEqual(before); expect(await receipts(engine)).toEqual(history);
    expect(await apply()).toMatchObject({ applied: true });
  }), 120_000);

  test('bounded 10x fixture measures whole transaction, and preserves all 30 receipts', isolated(async engine => {
    const { apply } = await setup(engine, 30);
    const history = await receipts(engine);
    expect(history).toHaveLength(30);
    const wrapped = Object.create(engine) as BrainEngine;
    let elapsedMs = 0;
    wrapped.transaction = async fn => {
      const start = performance.now();
      try { return await engine.transaction(fn); }
      finally { elapsedMs = performance.now() - start; }
    };
    expect(await apply(wrapped)).toMatchObject({ applied: true });
    expect(await receipts(engine)).toEqual(history);
    console.log(JSON.stringify({ evidence: 'bounded_10x_whole_transaction', fixture_receipts: 30, baseline_receipts: 3, elapsed_ms: elapsedMs, production_scale_proven: false }));
  }), 120_000);
});
