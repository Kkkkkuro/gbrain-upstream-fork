/** Synthetic explicit mappings; isolated PGLite. Never opens an operator brain. */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyManualRelink, previewManualRelink, parseManualMapping } from '../src/core/facts/relink-manual.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { readDecideConfig } from '../src/core/ai/decide/config.ts';
import { runFactsCommand } from '../src/commands/facts.ts';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManualRelinkBody } from '../src/core/facts/relink-manual-guards.ts';
let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;
const mapping = (id: number) => ({ target_slug: 'people/example-person', fact_ids: [id], evidence: 'Synthetic operator reviewed the exact existing subject.' });
const row = async (id: number) => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM facts WHERE id=$1', [id]))[0]!;
async function fact(text = '王小明负责项目。', extra: Record<string, unknown> = {}) {
  return (await engine.insertFact({ fact: text, kind: 'fact', entity_slug: null, visibility: 'world', source: 'synthetic source', ...extra } as never, { source_id: 'default' })).id;
}
const resign = (m: any) => { const { checksum: _, ...rest } = m; return { ...rest, checksum: digest(rest) }; };
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120000);
beforeEach(async () => {
  await resetPgliteState(engine); await engine.setConfig('decide.slots.conflict.mode', 'off');
  await importFromContent(engine, 'people/example-person', '---\ntitle: 王小明\ntype: person\n---\n# 王小明\n', { noEmbed: true });
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); __setEmbedTransportForTests(null); });

describe('explicit manual relink', () => {
  test('preview does not mutate facts, pages or receipts', async () => {
    const id = await fact(); const before = await row(id);
    const page = await engine.readPageSnapshot('people/example-person', { sourceId: 'default' });
    const beforeN = await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');
    const p = await previewManualRelink(engine, 'default', mapping(id));
    expect(p.outcomes).toEqual([{ id, action: 'link' }]); expect(p.effects.page_embedding).toBe('may_be_queued');
    expect(await row(id)).toEqual(before);
    expect((await engine.readPageSnapshot('people/example-person', { sourceId: 'default' }))?.revision).toBe(page!.revision);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests')).toEqual(beforeN);
  });
  test('explicit CJK mapping keeps original id, provenance, visibility, TTL and vector', async () => {
    const id = await fact(undefined, { valid_until: new Date('2099-01-01T12:34:56.123Z'), source_session: 'synthetic-session', confidence: 0.8 });
    await engine.executeRaw('UPDATE facts SET embedding=$2::vector WHERE id=$1', [id, '[' + Array.from({length:1536}, (_,i) => i===0 ? 1 : 0).join(',') + ']']);
    const before = await row(id), p = await previewManualRelink(engine, 'default', mapping(id));
    const r = await applyManualRelink(engine, config, 'default', p); expect(r.ok).toBe(true);
    const after = await row(id);
    for (const key of ['id','fact','source','source_session','visibility','valid_from','valid_until','embedding','confidence']) expect(after[key]).toEqual(before[key]);
    expect(after.entity_slug).toBe('people/example-person'); expect(after.expired_at).toBeNull();
  });
  test('reapplying the exact manifest replays one receipt, not a second write', async () => {
    const id=await fact(), p=await previewManualRelink(engine,'default',mapping(id));
    expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(true);
    const after=await row(id), n=await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');
    expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(true);
    expect(await row(id)).toEqual(after);expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests')).toEqual(n);
  });
  test('an exact duplicate is shown in preview and retired with its old id', async () => {
    const first=await fact(), p=await previewManualRelink(engine,'default',mapping(first));await applyManualRelink(engine,config,'default',p);
    const second=await fact(), next=await previewManualRelink(engine,'default',mapping(second));
    expect(next.outcomes).toEqual([{id:second,action:'retire',duplicate_of:first}]);
    await applyManualRelink(engine,config,'default',next);expect((await row(second)).expired_at).not.toBeNull();
  });
  test('changed full vector refuses even when semantic fields match', async () => {
    const id=await fact(), p=await previewManualRelink(engine,'default',mapping(id));
    await engine.executeRaw('UPDATE facts SET embedding=$2::vector WHERE id=$1',[id,'['+Array(1536).fill(0).join(',')+']']);
    const r=await applyManualRelink(engine,config,'default',p);expect(r.ok).toBe(false);expect((await row(id)).entity_slug).toBeNull();
  });
  test('target revision drift refuses before a new request', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));
    await importFromContent(engine,'people/example-person','---\ntitle: 王小明\ntype: person\n---\nChanged.\n',{noEmbed:true});
    await expect(applyManualRelink(engine,config,'default',p)).rejects.toMatchObject({code:'revision_conflict'});expect((await row(id)).entity_slug).toBeNull();
  });
  test('wrong brain, source, checksum and edited replay intent refuse', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));
    await expect(applyManualRelink(engine,config,'other',p)).rejects.toMatchObject({code:'invalid_params'});
    await expect(applyManualRelink(engine,config,'default',{...p,checksum:'bad'})).rejects.toMatchObject({code:'invalid_params'});
    const other=structuredClone(p);other.intent.manual!.brain_id='11111111-1111-4111-8111-111111111111';
    await expect(applyManualRelink(engine,config,'default',resign(other))).rejects.toMatchObject({code:'invalid_params'});
    await applyManualRelink(engine,config,'default',p);const edited=structuredClone(p);edited.intent.facts[0]!.note+=' changed';
    await expect(applyManualRelink(engine,config,'default',resign(edited))).rejects.toMatchObject({code:'idempotency_conflict'});
  });
  test('withdrawn claim and bad mapping are not admitted', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));await applyManualRelink(engine,config,'default',p);
    await recordFactWithdrawal(engine,id,'default');const other=await fact();
    await expect(previewManualRelink(engine,'default',mapping(other))).rejects.toMatchObject({code:'revision_conflict'});expect((await row(other)).entity_slug).toBeNull();
    expect(()=>parseManualMapping({...mapping(other),fact_ids:[other,other]})).toThrow();
    expect(()=>parseManualMapping({...mapping(other),unknown:true})).toThrow();
  });
  test('a value the fence would round loses no metadata: preview refuses', async () => {
    const id=await fact(undefined,{confidence:0.812345});
    await expect(previewManualRelink(engine,'default',mapping(id))).rejects.toMatchObject({code:'invalid_params'});
    expect((await row(id)).confidence).toBe(0.812345);
  });
  test('same preview UUID never admits a changed target, revision, fact set or hash', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));await applyManualRelink(engine,config,'default',p);
    const before=await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');
    const edits=[(m:any)=>{m.target_slug='people/other';},(m:any)=>{m.intent.manual.revision='11111111-1111-4111-8111-111111111111';},
      (m:any)=>{m.intent.facts[0].id=id+100;},(m:any)=>{m.intent.facts[0].hash='0'.repeat(64);}];
    for(const edit of edits){const m=structuredClone(p);edit(m);await expect(applyManualRelink(engine,config,'default',resign(m))).rejects.toMatchObject({code:'idempotency_conflict'});}
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests')).toEqual(before);
  });
  test('source incarnation and page identity pins refuse stale previews', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));
    for(const field of ['source_incarnation','page_id'] as const){const m=structuredClone(p);(m.intent.manual as any)[field]=field==='page_id'?999999:'11111111-1111-4111-8111-111111111111';
      await expect(applyManualRelink(engine,config,'default',resign(m))).rejects.toMatchObject({code:'revision_conflict'});}
    expect((await row(id)).entity_slug).toBeNull();
  });
  test('empty provenance and a metric the real mapper normalizes are refused unchanged', async () => {
    for(const assignment of ["source=''","claim_metric='MRR'"]){const id=await fact();await engine.executeRaw(`UPDATE facts SET ${assignment} WHERE id=$1`,[id]);
      const before=await row(id);await expect(previewManualRelink(engine,'default',mapping(id))).rejects.toMatchObject({code:'invalid_params'});expect(await row(id)).toEqual(before);}
  });
  test('PostgreSQL microsecond dates cannot silently become milliseconds', async () => {
    for(const field of ['valid_from','valid_until']){const id=await fact();await engine.executeRaw(`UPDATE facts SET ${field}='2099-01-01T12:34:56.123456Z'::timestamptz WHERE id=$1`,[id]);
      const before=await engine.executeRaw(`SELECT ${field}::text AS value FROM facts WHERE id=$1`,[id]);
      await expect(previewManualRelink(engine,'default',mapping(id))).rejects.toMatchObject({code:'invalid_params'});
      expect(await engine.executeRaw(`SELECT ${field}::text AS value FROM facts WHERE id=$1`,[id])).toEqual(before);}
  });
  test('notes are not attribution targets', async () => {
    await importFromContent(engine,'notes/example','---\ntitle: Example note\ntype: note\n---\nNote.\n',{noEmbed:true});const id=await fact();
    await expect(previewManualRelink(engine,'default',{...mapping(id),target_slug:'notes/example'})).rejects.toMatchObject({code:'invalid_params'});
  });
  test('appending a fact never rounds an unselected target fence row', async () => {
    const body='---\ntitle: 王小明\ntype: person\n---\n# 王小明\n\n## Facts\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Old claim | fact | 0.812345 | world | medium | 2026-01-01 | | synthetic | |\n<!--- gbrain:facts:end -->\n';
    await importFromContent(engine,'people/example-person',body,{noEmbed:true});const id=await fact();
    const before=await engine.readPageSnapshot('people/example-person',{sourceId:'default'});
    await expect(previewManualRelink(engine,'default',mapping(id))).rejects.toMatchObject({code:'revision_conflict'});
    expect((await engine.readPageSnapshot('people/example-person',{sourceId:'default'}))!.revision).toBe(before!.revision);expect((await row(id)).entity_slug).toBeNull();
  });
  test('a change between preparation and locked publication refuses the original request', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));let hit=false;
    installFaultHook(async(point,detail)=>{if(point==='consumer:prepared'&&detail.operation==='relink_facts'){hit=true;installFaultHook(undefined);await engine.executeRaw("UPDATE facts SET source='separate writer' WHERE id=$1",[id]);}});
    const r=await applyManualRelink(engine,config,'default',p);expect(hit).toBe(true);expect(r.ok).toBe(false);expect((await row(id)).entity_slug).toBeNull();
  });
  test('lost post-commit acknowledgement keeps one request and no subject provider call', async () => {
    const id=await fact(),p=await previewManualRelink(engine,'default',mapping(id));let hit=false,calls=0;
    __setChatTransportForTests(async()=>{calls++;throw Error('provider forbidden');});__setEmbedTransportForTests(async()=>{calls++;throw Error('provider forbidden');});
    installFaultHook((point,detail)=>{if(point==='publication:after_commit'&&detail.operation==='relink_facts'){hit=true;installFaultHook(undefined);throw Error('synthetic lost acknowledgement');}});
    expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(true);expect(hit).toBe(true);
    expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(true);expect(calls).toBe(0);
    const rows=await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid',[p.intent.run_id]);expect(rows).toEqual([{state:'committed'}]);
  });
  test('CLI previews a private new manifest, refuses overwrite and requires page-effect consent', async () => {
    const dir=mkdtempSync(join(tmpdir(),'manual-relink-cli-'));const id=await fact();
    try {
      const input=join(dir,'mapping.json'),output=join(dir,'manifest.json');writeFileSync(input,JSON.stringify(mapping(id)),{mode:0o600});
      expect(await runFactsCommand(engine,['relink','--mapping',input,'--manifest-out',output,'--dry-run'],config,'default')).toBe(0);
      expect(statSync(output).mode&0o777).toBe(0o600);const saved=readFileSync(output,'utf8');
      await expect(runFactsCommand(engine,['relink','--mapping',input,'--manifest-out',output,'--dry-run'],config,'default')).rejects.toMatchObject({code:'invalid_params'});
      expect(readFileSync(output,'utf8')).toBe(saved);
      expect(await runFactsCommand(engine,['relink','--apply-manifest',output],config,'default')).toBe(1);expect((await row(id)).entity_slug).toBeNull();
      expect(await runFactsCommand(engine,['relink','--apply-manifest',output,'--allow-page-effects'],config,'default')).toBe(0);
      expect((await row(id)).entity_slug).toBe('people/example-person');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test('bounded reads refuse segmented targets and never certify a truncated large page', async () => {
    await expect(readManualRelinkBody(engine,'default',{id:9999,slug:'people/segmented',body_storage:'segmented'},'11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({code:'page_body_segmented'});
    await importFromContent(engine,'people/large','---\ntitle: Large Example\ntype: person\n---\n'+'x'.repeat(70000),{noEmbed:true});const id=await fact();
    await expect(previewManualRelink(engine,'default',{...mapping(id),target_slug:'people/large'})).rejects.toMatchObject({code:'invalid_params'});expect((await row(id)).entity_slug).toBeNull();
  });
  test('preview never loads a whole-page snapshot before bounded checks', async () => {
    const id=await fact();let touched=false;
    const adapter={transaction:(fn:any)=>engine.transaction(tx=>fn(new Proxy(tx,{get(target,key){
      if(key==='readPageSnapshot'){touched=true;throw Error('whole-body snapshot forbidden');}
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }})))} as any;
    expect((await previewManualRelink(adapter,'default',mapping(id))).outcomes).toEqual([{id,action:'link'}]);expect(touched).toBe(false);
  });
  // Value: protects=manual mappings fail closed under current-read races and existing fence edits;
  // fails_when=CAS/full-row guards are removed; why_new=selected-row tests omit these target races;
  // seam=none; no_claim=Postgres/provider acceptance (isolated PGLite).
  test('a target revision change between metadata and bounded body read issues no manifest', async () => {
    const id=await fact();let changed=false;
    const adapter={transaction:(fn:any)=>engine.transaction(tx=>fn(new Proxy(tx,{get(target,key){
      if(key==='executeRaw')return async(sql:string,args:any[])=>{
        if(sql.includes(' AS body FROM pages p')&&!changed){changed=true;await target.executeRaw("UPDATE pages SET knowledge_revision='11111111-1111-4111-8111-111111111111'::uuid WHERE source_id='default' AND slug='people/example-person'");}
        return target.executeRaw(sql,args);
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }})))} as any;
    await expect(previewManualRelink(adapter,'default',mapping(id))).rejects.toMatchObject({code:'revision_conflict'});
    expect(changed).toBe(true);expect((await row(id)).entity_slug).toBeNull();
  });
  test('bounded body contract uses UTF-8 bytes below, at and above 64 KiB', async () => {
    for(const [body,held] of [['界'.repeat(21845),false],['界'.repeat(21845)+'a',true],['界'.repeat(21846),true]] as const){
      await engine.executeRaw("UPDATE pages SET compiled_truth=$1 WHERE source_id='default' AND slug='people/example-person'",[body]);
      const [target]=await engine.executeRaw<any>("SELECT id,slug,body_storage,knowledge_revision AS revision FROM pages WHERE source_id='default' AND slug='people/example-person'");
      if(held)await expect(readManualRelinkBody(engine,'default',target,target.revision)).rejects.toMatchObject({code:'invalid_params'});
      else expect(await readManualRelinkBody(engine,'default',target,target.revision)).toBe(body);
    }
  });
  test('a new distinct fact appends to an existing lossless fence without changing its old row', async () => {
    const first=await fact('Existing distinct claim.');await applyManualRelink(engine,config,'default',await previewManualRelink(engine,'default',mapping(first)));
    const before=await row(first),second=await fact('New distinct claim.');
    const result=await applyManualRelink(engine,config,'default',await previewManualRelink(engine,'default',mapping(second)));
    expect(result.ok).toBe(true);expect(await row(first)).toEqual(before);expect((await row(second)).entity_slug).toBe('people/example-person');
    const page=await engine.readPageSnapshot('people/example-person',{sourceId:'default'});
    expect(page!.page.compiled_truth).toContain('Existing distinct claim.');expect(page!.page.compiled_truth).toContain('New distinct claim.');
  });
  test('unselected existing fence row drift refuses both before prepare and before locked publication', async () => {
    const old=await fact('Existing target claim.');await applyManualRelink(engine,config,'default',await previewManualRelink(engine,'default',mapping(old)));
    for(const stage of ['before-prepare','before-publish']){
      const id=await fact('New target claim '+stage),p=await previewManualRelink(engine,'default',mapping(id));
      const change=()=>engine.executeRaw("UPDATE facts SET source_session=$2 WHERE id=$1",[old,stage]);
      if(stage==='before-prepare'){await change();await expect(applyManualRelink(engine,config,'default',p)).rejects.toMatchObject({code:'revision_conflict'});}
      else {installFaultHook(async(point,detail)=>{if(point==='consumer:prepared'&&detail.operation==='relink_facts'){installFaultHook(undefined);await change();}});
        expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(false);}
      expect((await row(id)).entity_slug).toBeNull();
    }
  });
  test('manual publish never queues subject decisions even with the conflict slot enabled', async () => {
    await engine.setConfig('decide.slots.conflict.mode','on');
    expect(readDecideConfig({'decide.slots.conflict.mode':(await engine.getConfig('decide.slots.conflict.mode'))??undefined}).slots.conflict.mode).toBe('on');const id=await fact();
    const p=await previewManualRelink(engine,'default',mapping(id));expect(p.intent.queue_conflict).toBe(false);
    const result=await applyManualRelink(engine,config,'default',p);expect(result.ok).toBe(true);
    if(result.ok)expect(result.outcome.queued).toBe(0);
    expect(await engine.executeRaw("SELECT fact_id FROM decide_sweep_deferred WHERE source_id='default' AND fact_id=$1",[id])).toEqual([]);
  });

  // Value: protects=invalid or changed manual intents cannot issue an unreviewed write;
  // fails_when=input/source/classification admission is removed; why_new=valid CLI and initial duplicate tests omit these failures;
  // seam=none; no_claim=installed CLI pre-dispatch validation or production permissions.
  test('bad or missing JSON and mixed CLI modes submit nothing and create no output', async () => {
    const dir=mkdtempSync(join(tmpdir(),'manual-invalid-cli-')),bad=join(dir,'bad.json'),out=join(dir,'out.json');
    const before=await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');
    try{writeFileSync(bad,'{ invalid');
      for(const file of [bad,join(dir,'missing.json')])await expect(runFactsCommand(engine,['relink','--mapping',file,'--manifest-out',out,'--dry-run'],config,'default')).rejects.toMatchObject({code:'invalid_params'});
      expect(await runFactsCommand(engine,['relink','--mapping',bad,'--manifest-out',out,'--apply-manifest',bad,'--dry-run','--allow-page-effects'],config,'default')).toBe(1);
      expect(existsSync(out)).toBe(false);expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests')).toEqual(before);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  test('a foreign-source or missing fact cannot enter a default-source preview', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other synthetic source')");
    const foreign=(await engine.insertFact({fact:'Foreign subject.',kind:'fact',entity_slug:null,visibility:'world',source:'synthetic'} as never,{source_id:'other'})).id;
    const before=await row(foreign);
    for(const id of [foreign,foreign+99999])await expect(previewManualRelink(engine,'default',mapping(id))).rejects.toMatchObject({code:'invalid_params'});
    expect(await row(foreign)).toEqual(before);
  });
  test('a previewed link cannot silently become an unreviewed duplicate retirement', async () => {
    const id=await fact('Exact claim later linked elsewhere.'),p=await previewManualRelink(engine,'default',mapping(id));
    const duplicate=(await engine.insertFact({fact:'Exact claim later linked elsewhere.',kind:'fact',entity_slug:'people/example-person',visibility:'world',source:'synthetic source'} as never,{source_id:'default'})).id;
    expect(duplicate).not.toBe(id);const before=await row(id);
    expect((await applyManualRelink(engine,config,'default',p)).ok).toBe(false);
    expect(await row(id)).toEqual(before);expect((await row(duplicate)).expired_at).toBeNull();
  });

  // Value: protects=documented manual flags reach the real installed-style CLI handler;
  // fails_when=the generated flag registry or pre-dispatch path drops a manual flag;
  // why_new=runFactsCommand tests bypass the CLI validator; seam=none;
  // no_claim=production installation or model acceptance (scratch keyless brain).
  test('real CLI pre-dispatch accepts manual flags and returns the manual JSON-input refusal', async () => {
    const dir=mkdtempSync(join(realpathSync(tmpdir()),'manual-cli-dispatch-'));
    try{
      const init=await runCli(['init','--pglite','--no-embedding','--json'],{home:dir,cwd:dir,timeoutMs:120000});
      expect(init.exitCode,init.stderr).toBe(0);
      const modes=[['--mapping',join(dir,'missing.json'),'--manifest-out',join(dir,'out.json'),'--dry-run'],['--apply-manifest',join(dir,'missing.json'),'--allow-page-effects']];
      for(const mode of modes){
        const r=await runCli(['facts','relink',...mode,'--json'],{home:dir,cwd:dir,timeoutMs:60000});
        expect(r.exitCode,r.stdout+r.stderr).toBe(2);expect(r.stdout+r.stderr).toContain('The manual relink input could not be read as JSON.');
        expect(r.stdout+r.stderr).not.toContain('unknown_flag');expect(existsSync(join(dir,'out.json'))).toBe(false);
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  },120000);

});
