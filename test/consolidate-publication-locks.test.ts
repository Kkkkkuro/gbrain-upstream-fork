import { expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

// Value: protects=publication locks against a real competing transaction;
// fails_when=the phase omits its lock or compares only the pre-cluster snapshot;
// why_new=single-connection mutation fixtures cannot prove blocking or lock lifetime;
// seam=barriers around native transaction/SQL calls, never substituted SQL/results.
// Two actors use distinct backend PIDs; a third read-only observer proves the wait edge.
const pgTest = testBackends().includes('postgres') ? test : test.skip;
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}
async function waitFor(check: () => Promise<boolean>) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error('Expected PostgreSQL lock wait did not occur');
}
async function within<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication test barrier timed out')), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(run: (engine: BrainEngine, writer: ReturnType<typeof postgres>, monitor: ReturnType<typeof postgres>, sourceId: string, root: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-publication-lock-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  const writer = postgres(pg.databaseUrl, { max: 1, prepare: false, connection: { application_name: 'dream-test-writer', statement_timeout: 20_000 } });
  const monitor = postgres(pg.databaseUrl, { max: 1, prepare: false });
  const sourceId = `locks-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await pg.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await pg.engine.setConfig('sync.write_through', 'true');
      await claimWorktree(pg.engine, sourceId, root);
      await submitPageMutation({ engine: pg.engine, sourceId, remote: false, config: { engine: 'postgres', embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } }, {
        operation: 'put_page', params: { slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nSynthetic chronology evidence.', request_id: randomUUID() },
      });
      const vector = `[1,${Array(1535).fill(0).join(',')}]`;
      for (const [i, word] of ['alpha', 'beta', 'gamma'].entries()) {
        await pg.engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
          VALUES($1,'people/example',$2,'fact','test','world',$3,$4::timestamptz,$5::vector,'openai:text-embedding-3-large',md5($2))`,
          [sourceId, `Example claim ${word}`, 0.9 - i / 10, `2026-01-0${i + 1}T00:00:00.123Z`, vector]);
      }
      await run(pg.engine, writer, monitor, sourceId, root);
    });
  } finally {
    await writer.end({ timeout: 1 }); await monitor.end({ timeout: 1 }); await pg.close();
    resetGateway(); rmSync(dir, { recursive: true, force: true });
  }
}
const state = (engine: BrainEngine, sourceId: string) => engine.executeRaw('SELECT id,valid_from,valid_until,consolidated_at,consolidated_into FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]);

function publicationRead(sql: string) {
  return sql.includes('claim_period FROM facts') && sql.includes('ORDER BY id FOR UPDATE');
}
function hook(engine: BrainEngine, intercept: (tx: BrainEngine, read: () => Promise<unknown>) => Promise<unknown>) {
  const execute = engine.executeRaw;
  const own = Object.getOwnPropertyDescriptor(engine, 'executeRaw');
  engine.executeRaw = async function (this: BrainEngine, sql, params, ...rest) {
    const read = () => execute.call(this, sql, params, ...rest);
    return publicationRead(sql) ? intercept(this, read) : read();
  } as typeof engine.executeRaw;
  return () => { if (own) Object.defineProperty(engine, 'executeRaw', own); else delete (engine as Partial<BrainEngine>).executeRaw; };
}

for (const change of ['timestamp', 'typed_metadata', 'deleted_contributor'] as const) {
pgTest(`writer before publication lock rejects stale ${change} without effects`, async () => {
  await fixture(async (engine, writer, monitor, sourceId, root) => {
    if (change === 'typed_metadata') await engine.executeRaw("UPDATE facts SET valid_from='2026-01-01T00:00:00.123Z' WHERE source_id=$1", [sourceId]);
    const original = readFileSync(join(root, 'people/example.md'), 'utf8');
    const page = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    const entered = barrier(), finishWriter = barrier(), phaseReady = barrier();
    let writerPid = 0, phasePid = 0;
    let writerRun: Promise<unknown> | undefined;
    const unhook = hook(engine, async (tx, read) => {
      writerRun = writer.begin(async sql => {
        writerPid = Number((await sql.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
        await sql.unsafe(change === 'timestamp' ? "UPDATE facts SET valid_from=valid_from+interval '1 day' WHERE source_id=$1"
          : change === 'typed_metadata' ? "UPDATE facts SET claim_metric='deposit_amount',claim_unit='USD',claim_period='monthly' WHERE source_id=$1"
          : 'DELETE FROM facts WHERE source_id=$1 AND id=(SELECT min(id) FROM facts WHERE source_id=$1)', [sourceId]);
        entered.release(); await within(finishWriter.ready);
      });
      await within(Promise.race([entered.ready, writerRun.then(() => { throw new Error('Writer ended before the publication barrier'); })]));
      phasePid = Number((await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0].pid);
      phaseReady.release();
      return read();
    });
    const phase = runPhaseConsolidate(engine, { sourceId });
    try {
      await within(Promise.race([phaseReady.ready, phase.then(() => { throw new Error('Phase finished without the publication lock'); })]));
      await waitFor(async () => (await monitor.unsafe('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [phasePid, writerPid]))[0].blocked);
      expect(phasePid).not.toBe(writerPid);
      finishWriter.release(); await writerRun;
      const afterWriter = await state(engine, sourceId);
      const result = await phase;
      expect(result.status).toBe('warn'); expect(result.details.facts_consolidated).toBe(0);
      expect(result.details.takes_written).toBe(0);
      expect(result.details.bucket_failures).toMatchObject([{ code: 'revision_conflict' }]);
      expect(await state(engine, sourceId)).toEqual(afterWriter);
      expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [page.page.id])).toHaveLength(0);
      expect((await engine.readPageSnapshot('people/example', { sourceId }))!.revision).toBe(page.revision);
      expect(readFileSync(join(root, 'people/example.md'), 'utf8')).toBe(original);
    } finally {
      finishWriter.release(); await Promise.allSettled([phase, writerRun]); unhook();
    }
  });
}, 60_000);
}

pgTest('publication row locks keep a competing writer blocked through commit', async () => {
  await fixture(async (engine, writer, monitor, sourceId) => {
    const locked = barrier(), finishPhase = barrier();
    let phasePid = 0, writerPid = 0, writerDone = false;
    const unhook = hook(engine, async (tx, read) => {
      const rows = await read();
      phasePid = Number((await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0].pid);
      locked.release(); await within(finishPhase.ready);
      return rows;
    });
    let writerRun: Promise<unknown> | undefined;
    const phase = runPhaseConsolidate(engine, { sourceId });
    try {
      await within(Promise.race([locked.ready, phase.then(() => { throw new Error('Phase finished without the publication lock'); })]));
      writerPid = Number((await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
      writerRun = writer.unsafe("UPDATE facts SET valid_from=valid_from+interval '1 day' WHERE source_id=$1", [sourceId]).then(() => { writerDone = true; });
      await waitFor(async () => (await monitor.unsafe('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [writerPid, phasePid]))[0].blocked);
      expect(phasePid).not.toBe(writerPid); expect(writerDone).toBe(false);
      finishPhase.release(); const result = await phase; await writerRun;
      expect(result.details.facts_consolidated).toBe(3); expect(result.details.takes_written).toBe(1);
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_into IS NOT NULL', [sourceId])).toHaveLength(3);
      expect(await engine.executeRaw('SELECT id FROM takes')).toHaveLength(1);
      expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id=$1 AND valid_from::date>='2026-01-02'", [sourceId])).toHaveLength(3);
    } finally {
      finishPhase.release(); await Promise.allSettled([phase, writerRun]); unhook();
    }
  });
}, 60_000);
