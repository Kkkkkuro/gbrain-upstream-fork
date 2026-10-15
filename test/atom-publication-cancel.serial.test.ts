import { beforeEach, expect, mock, test } from 'bun:test';
import type { AtomOrigin, ManagedAtomSession } from '../src/core/persistence/atom-maintenance.ts';
import { MaintenanceWriteWait } from '../src/core/persistence/maintenance-wait.ts';

const authority = await import('../src/core/persistence/authority.ts');
const journal = await import('../src/core/persistence/journal.ts');
const service = await import('../src/core/persistence/service.ts');
let controller: AbortController;
let atAuth: () => Promise<void>, atTarget: () => Promise<void>, atTransaction: () => Promise<void>;
let atAdmit: (n: number) => Promise<void>, afterCommit: () => Promise<void>, atWait: () => Promise<void>;
let admitted: any[], staged: any[], committed: any[];
let waited:number, settle:boolean;
mock.module('../src/core/persistence/authority.ts', () => ({ ...authority, authorizeWrite: async () => atAuth() }));
mock.module('../src/core/persistence/journal.ts', () => ({ ...journal,
  admitWriteInTransaction: async (_tx: any, input: any) => {
    const row = { id: input.requestId, request_id: input.requestId, state: 'queued', created_at: new Date(), updated_at: new Date(),
      operation: input.operation, source_id: input.sourceId, principal_kind: 'local_cli', principal_id: 'synthetic',
      intent: input.intent, claim_expires_at: null, outcome: null };
    staged.push(row); admitted.push(row); await atAdmit(staged.length); return row;
  },
}));
mock.module('../src/core/persistence/service.ts', () => ({ ...service,
  waitForWrite: async (_e: any, row: any) => { await atWait(); waited++; return settle?{...row,state:'committed'}:row; },
  awaitWrite: async (_e: any, row: any) => { await atWait(); waited++; return { kind: settle?'terminal':'pending', row:settle?{...row,state:'committed'}:row }; },
  writeResponse: () => ({}),
}));
const { publishManagedAtoms } = await import('../src/core/persistence/atom-maintenance.ts');
const origin: AtomOrigin = { kind: 'page', locator: 'notes/synthetic', contentHash: 'full-hash', textHash: 'text-hash', pageId: 1, revision: 'r1', visibility: 'private' };
const makeSession = (): ManagedAtomSession => ({ sourceId: 'default', incarnation: 'synthetic',
  authority: { principal: { kind: 'local_cli', id: 'synthetic' } } as any, binding: null, config: { engine: 'pglite' }, wait: new MaintenanceWriteWait() });
const atoms = [{ slug: 'atoms/synthetic', content: 'Synthetic retained content.', links: [] }];
const engine: any = {
  readPageSnapshot: async () => { await atTarget(); return null; },
  executeRaw: async () => [],
  transaction: async (work: any) => {
    await atTransaction(); staged = [];
    const result = await work(engine); committed.push(...staged); await afterCommit(); return result;
  },
};
const publication = (options: any = { signal: controller.signal }) => (publishManagedAtoms as any)(engine, makeSession(), origin, atoms, undefined, [], options);
beforeEach(() => {
  controller = new AbortController(); admitted = []; staged = []; committed = []; waited=0;settle=false;
  atAuth = atTarget = atTransaction = afterCommit = atWait = async () => {};
  atAdmit = async () => {};
});
for (const boundary of ['authority', 'target', 'transaction', 'first admission', 'last admission']) {
  test(`real publisher refuses cancellation at ${boundary} before durable commit`, async () => {
    const stop = async () => { await Promise.resolve(); controller.abort(Error(`stop:${boundary}`)); };
    if (boundary === 'authority') atAuth = stop;
    if (boundary === 'target') atTarget = stop;
    if (boundary === 'transaction') atTransaction = stop;
    if (boundary.endsWith('admission')) atAdmit = async n => { if (n === (boundary === 'first admission' ? 1 : 2)) await stop(); };
    await expect(publication()).rejects.toThrow(`stop:${boundary}`);
    expect(committed).toHaveLength(0);
    if (['authority', 'target', 'transaction'].includes(boundary)) expect(admitted).toHaveLength(0);
    if (boundary === 'first admission') expect(admitted).toHaveLength(1);
    if (boundary === 'last admission') expect(admitted).toHaveLength(2);
  });
}
for (const reason of ['deadline reached', 'cycle lock lost']) test(`publisher checks live ${reason} guard after target await`, async () => {
  let stopped = false; atTarget = async () => { await Promise.resolve(); stopped = true; };
  await expect(publication({ assertActive: () => { if (stopped) throw Error(reason); } })).rejects.toThrow(reason);
  expect(admitted).toHaveLength(0); expect(committed).toHaveLength(0);
});
for (const boundary of ['commit', 'settlement']) test(`stop after ${boundary} keeps every accepted receipt without claiming rollback`, async () => {
  const stop = async () => { controller.abort(Error(`stop:${boundary}`)); };
  if (boundary === 'commit') afterCommit = stop; else atWait = stop;
  let caught: any; try { await publication(); } catch (error) { caught = error; }
  expect(committed).toHaveLength(2); expect(caught?.code).toBe('write_pending');
  expect(caught?.writeRequests).toHaveLength(2);
  expect(caught?.writeRequests.map((r: any) => r.request_id)).toEqual(committed.map(r => r.request_id));
  expect(caught?.writeRequest).toEqual(caught?.writeRequests.find((r: any) => ['queued','running','recovering'].includes(r.state)));
  expect(caught?.write_requests).toEqual(caught?.writeRequests);
  expect(caught?.cause?.message).toContain(`stop:${boundary}`);
});
test('publisher checks guard synchronously before any work and preserves no-options compatibility', async () => {
  controller.abort(Error('already stopped')); await expect(publication()).rejects.toThrow('already stopped');
  expect(admitted).toHaveLength(0);
  controller = new AbortController();
  const receipts = await publishManagedAtoms(engine, makeSession(), origin, atoms, undefined, []);
  expect(receipts).toHaveLength(2); expect(committed).toHaveLength(2);
});

test('stop after every accepted write settled retains terminal outcomes as AbortError', async () => {
  settle=true;atWait=async()=>{if(waited===1)controller.abort(Error('all settled stop'));};
  let caught:any;try{await publication();}catch(error){caught=error;}
  expect(committed).toHaveLength(2);expect(caught?.name).toBe('AbortError');expect(caught?.writeRequests).toHaveLength(2);
  expect(caught?.writeRequests.every((r:any)=>r.state==='committed')).toBe(true);expect(caught?.cause?.message).toBe('all settled stop');
});

for (const boundary of ['authority','target']) test(`publisher checks the live absolute deadline after ${boundary}`,async()=>{
  let deadline=Infinity;const expire=async()=>{await Promise.resolve();deadline=Date.now()-1;};
  if(boundary==='authority')atAuth=expire;else atTarget=expire;
  await expect(publication({assertActive:()=>{if(Date.now()>=deadline)throw Error('absolute deadline reached');}})).rejects.toThrow('absolute deadline reached');
  expect(admitted).toHaveLength(0);expect(committed).toHaveLength(0);
});
test('retirement authorization await cannot admit after lock loss',async()=>{
  const lost=new AbortController();atAuth=async()=>{lost.abort(Error('retirement lock lost'));};
  await expect((publishManagedAtoms as any)(engine,makeSession(),origin,[],undefined,[{slug:'atoms/old',pageId:2,revision:'r1'}],{signal:lost.signal})).rejects.toThrow('retirement lock lost');
  expect(admitted).toHaveLength(0);expect(committed).toHaveLength(0);
});
