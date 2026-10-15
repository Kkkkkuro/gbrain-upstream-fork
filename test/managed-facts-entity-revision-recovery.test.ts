/** Page-backed automatic facts reuse retained candidates after an entity CAS race.
 * The origin, identity, authority, new entity bytes and old receipts must survive.
 * No inference transport is allowed; tests use the isolated PostgreSQL factory. */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { prepareManagedFactsSession, resumeManagedFacts, type FrozenExtractedFact, type ManagedFactIntent } from '../src/core/persistence/facts-maintenance.ts';
import { admitWriteInTransaction } from '../src/core/persistence/journal.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { readFactsEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
const ORIGIN = 'meetings/synthetic-workshop', ENTITY = 'people/alice-example', COMPLETE = '__managed_facts_complete__';
const BODY = 'Alice Example will verify the synthetic workshop booking in November.';
const NEW_TEXT = '# Alice Example\n\nNew current entity notes that must survive the append.\n';
const engines: BrainEngine[] = [], dirs: string[] = [];
let closePg: (() => Promise<void>) | undefined;
let providerCalls = 0;
beforeAll(async () => {
    __setChatTransportForTests(async () => { providerCalls++; throw Error('unexpected inference'); });
    __setEmbedTransportForTests((async () => { providerCalls++; throw Error('unexpected embedding'); }) as never);
    for (const backend of testBackends())
        if (backend === 'postgres') {
            const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
            engines.push(pg.engine);
            closePg = pg.close;
        }
        else {
            const dir = mkdtempSync(join(tmpdir(), 'gbrain-cas-db-'));
            dirs.push(dir);
            const e = new PGLiteEngine();
            await e.connect({ database_path: dir });
            await e.initSchema();
            engines.push(e);
        }
}, 120000);
afterEach(() => { installFaultHook(undefined); });
afterAll(async () => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); for (const e of engines) {
    await disposePersistenceConsumer(e);
    await e.disconnect();
} await closePg?.(); for (const d of dirs)
    rmSync(d, { recursive: true, force: true }); });
async function fixture(engine: BrainEngine, explicit = false, partial = false, embedded = false, visibility: 'private' | 'world' = 'world') {
    const sourceId = `entity-cas-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nOriginal entity notes.\n' }, { sourceId });
    await engine.setConfig('facts.default_visibility', 'world');
    const dim = (await readFactsEmbeddingDim(engine)).dims!;
    if (embedded) {
        await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
        await engine.setConfig('embedding_dimensions', String(dim));
    }
    else {
        await engine.unsetConfig('embedding_model');
        await engine.unsetConfig('embedding_dimensions');
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const config = { engine: engine.kind, embedding_disabled: !embedded };
    const parentId = randomUUID();
    await submitPageMutation({ engine, remote: false, sourceId, config } as never, { operation: 'put_page', params: { slug: ORIGIN, content: `---\ntype: meeting\ntitle: Synthetic workshop\n---\n\n${BODY}`, request_id: parentId } });
    const [parent] = await engine.executeRaw<{
        id: string;
    }>('SELECT id FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [sourceId, parentId]);
    const origin = (await engine.readPageSnapshot(ORIGIN, { sourceId }))!;
    const session = (await prepareManagedFactsSession({ engine, config, sourceId, sessionId: 'synthetic-entity-cas', source: 'mcp:put_page', persistenceRequestId: parent.id, remote: false, visibility, ...(explicit ? { requestId: randomUUID() } : {}) }, { turnText: origin.page.compiled_truth, pageSlug: ORIGIN }))!;
    if (embedded)
        session.embedding = { model: 'openai:text-embedding-3-large', dimensions: dim };
    const entity = (await engine.readPageSnapshot(ENTITY, { sourceId }))!;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: NEW_TEXT }, { sourceId });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const fact: FrozenExtractedFact = { fact: BODY, entity_slug: ENTITY, visibility, kind: 'fact', source: 'mcp:put_page', context: ORIGIN, embedding: embedded ? Array(dim).fill(0.01) : null, valid_from: '2026-10-15T00:00:00.000Z', valid_until: null };
    const shared = { batchKey: session.batchKey, inputDigest: session.inputDigest, origin: session.origin, originalRequestId: parent.id };
    const admission = { principal: session.authority.principal, authority: session.authority, operation: 'extract_facts', sourceId, sourceIncarnation: session.authority.sourceIncarnation };
    await engine.transaction(async (tx) => {
        const intent: ManagedFactIntent = { kind: 'managed_facts_entity', ...shared, embedding: session.embedding ?? null, expected_revision: entity.revision, facts: [fact], withdrawn: 'skip' };
        const child = await admitWriteInTransaction(tx, { ...admission, requestId: randomUUID(), slug: ENTITY, pageId: entity.page.id, callerIntent: intent, intent });
        const children = [child.id];
        if (partial) {
            const extra: ManagedFactIntent = { kind: 'managed_facts_entity', ...shared, embedding: null, facts: [{ ...fact, fact: 'A separate workshop fact was already saved.', entity_slug: null }], withdrawn: 'skip' };
            const done = await admitWriteInTransaction(tx, { ...admission, requestId: randomUUID(), slug: 'memory/unattributed', pageId: null, callerIntent: extra, intent: extra });
            children.push(done.id);
        }
        const completion: ManagedFactIntent = { kind: 'managed_facts_complete', ...shared, children };
        await admitWriteInTransaction(tx, { ...admission, requestId: session.completionRequestId, slug: COMPLETE, pageId: null, callerIntent: completion, intent: completion });
    });
    const quiet = () => waitFor(async () => (await engine.executeRaw<{
        n: number;
    }>("SELECT count(*)::int n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')", [sourceId]))[0].n === 0, { timeoutMs: 30000, label: 'CAS requests settled' });
    const journal = async () => { await quiet(); return engine.executeRaw<{
        id: string;
        state: string;
        error_message: string;
        row: string;
    }>("SELECT id,state,error_message,to_jsonb(r)::text row FROM persistence_requests r WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]); };
    await expect(resumeManagedFacts(engine, session)).rejects.toMatchObject({ code: 'revision_conflict' });
    const before = await journal();
    expect(before).toHaveLength(partial ? 3 : 2);
    expect(before[0].error_message).toBe('The fact entity changed after extraction admission.');
    return { sourceId, session, journal, before, run: (selected = engine) => resumeManagedFacts(selected, session) };
}
async function each(body: (e: BrainEngine) => Promise<void>) { for (const e of engines) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cas-home-'));
    try {
        await withEnv({ GBRAIN_HOME: home }, () => body(e));
    }
    finally {
        installFaultHook(undefined);
        await disposePersistenceConsumer(e);
        await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        rmSync(home, { recursive: true, force: true });
    }
} }
test('retained facts recover once with no provider calls, preserving new text and immutable old receipts', async () => {
    await each(async (engine) => {
        const s = await fixture(engine);
        expect(await s.run()).toMatchObject({ inserted: 1, duplicate: 0 });
        const after = await s.journal();
        expect(after).toHaveLength(4);
        expect(after.slice(0, 2).map(r => r.row)).toEqual(s.before.map(r => r.row));
        expect(after.slice(2).map(r => r.state)).toEqual(['committed', 'committed']);
        const frozen = await engine.executeRaw<{
            facts: string;
        }>("SELECT (intent->'facts')::text facts FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence", [s.sourceId, ENTITY]);
        expect(frozen.map(r => r.facts)).toEqual([frozen[0].facts, frozen[0].facts]);
        const page = (await engine.getPage(ENTITY, { sourceId: s.sourceId }))!;
        expect(page.compiled_truth).toContain('New current entity notes that must survive');
        expect(page.compiled_truth).toContain(BODY);
        expect((await engine.executeRaw<{
            n: number;
        }>('SELECT count(*)::int n FROM facts WHERE source_id=$1 AND expired_at IS NULL', [s.sourceId]))[0].n).toBe(1);
        expect(await s.run()).toMatchObject({ inserted: 1 });
        expect(await s.journal()).toHaveLength(4);
        expect(providerCalls).toBe(0);
    });
}, 180000);
test('explicit extract_facts request ids keep terminal receipts without follow-ups', async () => {
    await each(async (engine) => { const s = await fixture(engine, true); await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' }); expect((await s.journal()).map(r => r.row)).toEqual(s.before.map(r => r.row)); expect(providerCalls).toBe(0); });
}, 180000);
test('changed origin and replaced entity identity refuse recovery without publishing', async () => {
    await each(async (engine) => { for (const target of ['origin', 'identity']) {
        const s = await fixture(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        if (target === 'origin')
            await engine.putPage(ORIGIN, { type: 'meeting', title: 'Changed', compiled_truth: `${BODY} Changed source text.` }, { sourceId: s.sourceId });
        else {
            await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [s.sourceId, ENTITY]);
            await engine.putPage(ENTITY, { type: 'person', title: 'Replacement', compiled_truth: NEW_TEXT }, { sourceId: s.sourceId });
        }
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
        expect((await s.journal()).map(r => r.row)).toEqual(s.before.map(r => r.row));
        expect((await engine.executeRaw<{
            n: number;
        }>('SELECT count(*)::int n FROM facts WHERE source_id=$1 AND expired_at IS NULL', [s.sourceId]))[0].n).toBe(0);
    } });
}, 180000);
test('three follow-ups is a lifetime cap even if the entity races again before each prepare', async () => {
    await each(async (engine) => {
        const s = await fixture(engine);
        let edits = 0;
        installFaultHook(async (point, detail) => {
            if (point !== 'consumer:preparing' || detail.operation !== 'extract_facts' || detail.sourceId !== s.sourceId)
                return;
            const [r] = await engine.executeRaw<{
                slug: string;
            }>('SELECT slug FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [s.sourceId, detail.requestId]);
            if (r?.slug !== ENTITY)
                return;
            await engine.transaction(tx => withCoordinatedWrite(tx, [s.sourceId], () => tx.executeRaw('UPDATE pages SET title=$3 WHERE source_id=$1 AND slug=$2', [s.sourceId, ENTITY, `Concurrent edit ${++edits}`]), TEST_WRITE_ATTRIBUTION));
        });
        for (let i = 1; i <= 3; i++) {
            await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
            expect(await s.journal()).toHaveLength(2 * (i + 1));
        }
        installFaultHook(undefined);
        await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
        expect(await s.journal()).toHaveLength(8);
        expect(edits).toBe(3);
        expect(providerCalls).toBe(0);
        const p = (await engine.getPage(ENTITY, { sourceId: s.sourceId }))!;
        expect(p.title).toBe('Concurrent edit 3');
        expect(p.compiled_truth).not.toContain(BODY);
    });
}, 180000);
test('a partial batch carries its committed group without reinserting or re-extracting it', async () => {
    await each(async (engine) => { const s = await fixture(engine, false, true); expect(await s.run()).toMatchObject({ inserted: 2, duplicate: 0 }); const after = await s.journal(); expect(after).toHaveLength(5); expect(after.slice(0, 3).map(r => r.row)).toEqual(s.before.map(r => r.row)); expect((await engine.executeRaw<{
        n: number;
    }>('SELECT count(*)::int n FROM facts WHERE source_id=$1 AND expired_at IS NULL', [s.sourceId]))[0].n).toBe(2); expect(await s.run()).toMatchObject({ inserted: 2 }); expect(await s.journal()).toHaveLength(5); expect(providerCalls).toBe(0); });
}, 180000);
test('retained vectors survive the CAS follow-up byte for byte without calling the embedding provider', async () => {
    await each(async (engine) => { const s = await fixture(engine, false, false, true); expect(await s.run()).toMatchObject({ inserted: 1 }); const rows = await engine.executeRaw<{
        facts: string;
    }>("SELECT (intent->'facts')::text facts FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence", [s.sourceId, ENTITY]); expect(rows).toHaveLength(2); expect(rows[1].facts).toBe(rows[0].facts); expect(JSON.parse(rows[0].facts)[0].embedding.length).toBeGreaterThan(0); expect(providerCalls).toBe(0); });
}, 180000);

test('a revoked writer cannot admit an entity revision follow-up', async () => {
    await each(async (engine) => {
        const s = await fixture(engine);
        await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [s.session.authority.principal.id]);
        try {
            await expect(s.run()).rejects.toMatchObject({ code: 'permission_denied' });
            expect((await s.journal()).map(r => r.row)).toEqual(s.before.map(r => r.row));
            expect((await engine.getPage(ENTITY, { sourceId: s.sourceId }))!.compiled_truth).toBe(NEW_TEXT);
            expect(providerCalls).toBe(0);
        } finally {
            await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=$1::uuid', [s.session.authority.principal.id]);
        }
    });
}, 180000);

test('a current private-only policy refuses recovery without rewriting retained candidates', async () => {
    await each(async (engine) => {
        const s = await fixture(engine);
        await engine.setConfig('facts.default_visibility', 'private');
        await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
        expect((await s.journal()).map(r => r.row)).toEqual(s.before.map(r => r.row));
        expect((await engine.getPage(ENTITY, { sourceId: s.sourceId }))!.compiled_truth).toBe(NEW_TEXT);
        expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int n FROM facts WHERE source_id=$1 AND expired_at IS NULL', [s.sourceId]))[0].n).toBe(0);
        expect(providerCalls).toBe(0);
    });
}, 180000);

