import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {freshBrainFactory} from './helpers/persistence-request-fixture.ts';
import {testBackends} from './helpers/test-backends.ts';
import {purgeStaleCheckpoints} from '../src/core/op-checkpoint.ts';
import {runTrustScan,readTrustScanState} from '../src/core/eligibility/scan.ts';
import {WRITE_GATE_DETECTOR_VERSION} from '../src/core/write-gate.ts';
const initialUrl=process.env.DATABASE_URL;
for(const backend of testBackends())describe('trust scan checkpoint retention '+backend,()=>{
let e:BrainEngine;let factory:Awaited<ReturnType<typeof freshBrainFactory>>;
beforeAll(async()=>{factory=await freshBrainFactory(backend,initialUrl);},120000);
afterAll(async()=>{await factory?.dispose();});
beforeEach(async()=>{e=await factory.fresh();},120000);
async function seed(){
 const p=await e.putPage('test/legacy',{type:'note',title:'Synthetic',compiled_truth:'A plain legacy note.',timeline:''});
 // The migrated PostgreSQL template has a zero-row gate baseline; explicitly
 // model a legacy row within the gate's original ceiling on both backends.
 await e.setConfig('write_gate.scan_baseline',JSON.stringify({detector_version:WRITE_GATE_DETECTOR_VERSION,until:{pages:p.id,facts:0,takes:0,timeline_entries:0}}));
}
async function age(){await e.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='trust_scan'");}
test('completed scan remains complete after ordinary checkpoint GC',async()=>{
 await seed();expect((await readTrustScanState(e)).total_unscanned).toBe(1);expect((await runTrustScan(e)).complete).toBe(true);const before=await readTrustScanState(e);expect(before.completed_at).not.toBeNull();
 await age();expect(await purgeStaleCheckpoints(e,7)).toBe(0);expect(await readTrustScanState(e)).toEqual(before);
});
test('unfinished scan cursor survives GC without claiming completion',async()=>{
 await seed();await runTrustScan(e,{maxBatches:0});const before=await readTrustScanState(e);expect(before.total_unscanned).toBe(1);expect(before.completed_at).toBeNull();
 await age();expect(await purgeStaleCheckpoints(e,7)).toBe(0);expect(await readTrustScanState(e)).toEqual(before);
});
test('ordinary stale resumable checkpoints still expire',async()=>{
 await e.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('embed','old','[]'::jsonb,now()-interval '8 days')");
 expect(await purgeStaleCheckpoints(e,7)).toBe(1);
});
test('retention does not make an older detector scan satisfy the current detector',async()=>{
 await seed();await runTrustScan(e);await e.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,detector_version}','-1'::jsonb) WHERE op='trust_scan'");
 await age();await purgeStaleCheckpoints(e,7);const state=await readTrustScanState(e);expect(state.total_unscanned).toBe(1);expect(state.completed_at).toBeNull();
});
});
