import {beforeEach,expect,mock,test} from 'bun:test';
let lock=new AbortController(), lockCalls=0,reads=0,models=0;
let sessionHook=async()=>{};
let retainedRows:any[]|undefined;
let publish=async(..._args:any[]):Promise<any>=>{throw Error('UNEXPECTED_PUBLISH')};
let phase=async(opts:any):Promise<any>=>({status:'ok'});
const origin={kind:'page',locator:'notes/synthetic',contentHash:'hash'};
const session={retry:{origin,expectedCheckpoint:[{failure:'malformed'}],rows:[{outcome:{failure:'malformed'}}]}};
mock.module('../src/core/db-lock.ts',()=>({withRefreshingLock:async(_e:any,_k:any,work:any)=>{lockCalls++;return work(lock.signal,{})}}));
mock.module('../src/core/cycle.ts',()=>({cycleLockIdFor:(s:string)=>s}));
mock.module('../src/core/persistence/atom-maintenance.ts',()=>({
 managedAtomSession:async()=>{await sessionHook();return {...session,retry:{...session.retry,rows:retainedRows??session.retry.rows}}},atomRetryInputKey:()=> 'same',readAtomOrigin:async()=>origin,
 resumeManagedAtoms:async()=> 'run',publishManagedAtoms:async(...args:any[])=>publish(...args)
}));
mock.module('../src/core/cycle/extract-atoms.ts',()=>({runPhaseExtractAtoms:async(_e:any,opts:any)=>{models++;return phase(opts)}}));
const {retryManagedAtomBatch}=await import('../src/core/persistence/atom-retry.ts');
const {makeExtractAtomsDrainHandler}=await import('../src/core/minions/handlers/extract-atoms-drain.ts');
const engine:any={readPageSnapshot:async(slug:string)=>{reads++;return slug.startsWith('atoms/')?{page:{id:2,deleted_at:null},revision:'r1'}:{page:{compiled_truth:'Synthetic.'}}}};
const job=(signal:AbortSignal,deadlineAtMs?:number)=>({id:'synthetic',data:{sourceId:'default',retryRequestId:'synthetic'},signal,deadlineAtMs}) as any;
beforeEach(()=>{lock=new AbortController();lockCalls=reads=models=0;sessionHook=async()=>{};retainedRows=undefined;publish=async()=>{throw Error('UNEXPECTED_PUBLISH')};phase=async()=>({status:'ok'})});
test('pre-aborted handler starts no retry work',async()=>{const c=new AbortController();c.abort(Error('cancelled'));await expect(makeExtractAtomsDrainHandler(engine)(job(c.signal))).rejects.toThrow();expect(lockCalls).toBe(0);expect(models).toBe(0)});
test('expired handler starts no work and is unrecoverable',async()=>{await expect(makeExtractAtomsDrainHandler(engine)(job(new AbortController().signal,Date.now()-1))).rejects.toMatchObject({name:'UnrecoverableError'});expect(lockCalls).toBe(0)});
test('caller cancellation while session loads stops next read/model',async()=>{const c=new AbortController();sessionHook=async()=>{c.abort(Error('caller-stop'))};await expect(retryManagedAtomBatch(engine,'default','synthetic','retry',{signal:c.signal})).rejects.toThrow('caller-stop');expect(reads).toBe(0);expect(models).toBe(0)});
test('lost lock while session loads stops next read/model',async()=>{sessionHook=async()=>{lock.abort(Error('lock-lost'))};await expect(retryManagedAtomBatch(engine,'default','synthetic','retry')).rejects.toThrow('lock-lost');expect(reads).toBe(0);expect(models).toBe(0)});
test('real signal and deadline budget reach extraction; cancellation cannot become success',async()=>{const c=new AbortController();const deadline=Date.now()+1000;phase=async(opts)=>{expect(opts.signal).toBeInstanceOf(AbortSignal);expect(opts.attempt.writeWait.ms()).toBeLessThanOrEqual(1000);c.abort(Error('model-stop'));expect(opts.signal.aborted).toBe(true);return {status:'ok'}};await expect(retryManagedAtomBatch(engine,'default','synthetic','retry',{signal:c.signal,deadlineAtMs:deadline})).rejects.toThrow('model-stop');expect(models).toBe(1)});
test('deadline aborts in-flight model signal',async()=>{phase=async(opts)=>{expect(opts.signal).toBeInstanceOf(AbortSignal);await new Promise<void>((resolve,reject)=>{const fail=setTimeout(()=>reject(Error('deadline signal missing')),1000);opts.signal.addEventListener('abort',()=>{clearTimeout(fail);resolve()},{once:true})});return {status:'ok'}};await expect(retryManagedAtomBatch(engine,'default','synthetic','retry',{deadlineAtMs:Date.now()+20})).rejects.toThrow('deadline');expect(models).toBe(1)});
test('four-argument compatibility remains successful',async()=>{expect(await retryManagedAtomBatch(engine,'default','synthetic','retry')).toMatchObject({status:'ok',model_rerun:true});expect(models).toBe(1)});

for (const state of ['queued', 'committed']) test(`cancelled phase retains ${state} write receipts`,async()=>{
 const c=new AbortController();const receipt={request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',state,retry_after_ms:state==='queued'?100:null};
 phase=async()=>{c.abort(Error('late-stop'));return {status:'ok',details:{write_requests:[receipt]}}};
 let caught:any;try{await retryManagedAtomBatch(engine,'default','synthetic','retry',{signal:c.signal})}catch(e){caught=e}
 expect(caught.writeRequest).toEqual(receipt);expect(caught.writeRequests).toEqual([receipt]);expect(caught.cause.message).toContain('late-stop');if(state==='committed'){expect(caught.name).toBe('AbortError');expect(caught.code).not.toBe('cancelled');}
});
test('handler deadline preserves the accepted receipt and cause',async()=>{
 const receipt={request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',state:'queued',retry_after_ms:100};
 phase=async(opts)=>{await new Promise<void>(resolve=>opts.signal.addEventListener('abort',()=>resolve(),{once:true}));return {status:'warn',details:{write_requests:[receipt]}}};
 let caught:any;try{await makeExtractAtomsDrainHandler(engine)(job(new AbortController().signal,Date.now()+20))}catch(e){caught=e}
 expect(caught.name).toBe('UnrecoverableError');expect(caught.writeRequest).toEqual(receipt);expect(caught.writeRequests).toEqual([receipt]);expect(caught.write_requests).toEqual(caught.writeRequests);expect(caught.cause.code).toBe('write_pending');
});
test('caller listeners are removed after normal return and failure',async()=>{
 for(const fail of [false,true]){const c=new AbortController();let added=0,removed=0;const add=c.signal.addEventListener.bind(c.signal),remove=c.signal.removeEventListener.bind(c.signal);
 c.signal.addEventListener=((...args:any[])=>{added++;return (add as any)(...args)}) as any;c.signal.removeEventListener=((...args:any[])=>{removed++;return (remove as any)(...args)}) as any;
 phase=async()=>{if(fail)throw Error('injected');return {status:'ok'}};
 try{await retryManagedAtomBatch(engine,'default','synthetic','retry',{signal:c.signal,deadlineAtMs:Date.now()+10000})}catch(e){expect(fail).toBe(true)}
 expect(added).toBeGreaterThan(0);expect(removed).toBe(added);
 }
});

const retained = () => [{slug:'atoms/synthetic',page_id:2,state:'failed',intent:{kind:'managed_atom_page',expected_revision:'r1',content:'Synthetic retained atom.',links:[]}}];
for(const state of ['queued','committed']) test(`retained retry stop preserves every ${state} accepted receipt`,async()=>{
 retainedRows=retained();const c=new AbortController();
 const receipt={request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',state,retry_after_ms:state==='queued'?100:null};
 publish=async(...args:any[])=>{expect(args[6].signal).toBeInstanceOf(AbortSignal);expect(args[6].assertActive).toBeFunction();c.abort(Error('retained-stop'));return [receipt]};
 let caught:any;try{await retryManagedAtomBatch(engine,'default','synthetic','retry',{signal:c.signal})}catch(e){caught=e}
 expect(caught?.writeRequest).toEqual(receipt);expect(caught?.writeRequests).toEqual([receipt]);expect(caught?.cause?.message).toContain('retained-stop');
 expect(caught?.name).toBe(state==='committed'?'AbortError':'OperationError');expect(models).toBe(0);
});
test('healthy retained retry preserves four-argument compatibility and does not rerun the model',async()=>{
 retainedRows=retained();const receipts=[{request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',state:'committed',retry_after_ms:null}];
 publish=async()=>receipts;
 expect(await retryManagedAtomBatch(engine,'default','synthetic','retry')).toEqual({status:'completed',model_rerun:false,write_requests:receipts});expect(models).toBe(0);
});
