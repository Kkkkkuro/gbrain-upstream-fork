import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const moduleUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const step = 'after restarting serve and the workers, run: gbrain sources writer movement';

test('upgrade parent prints its completion step without loading the replaced command graph (#6604)', async () => {
  const source = readFileSync(new URL('../src/commands/upgrade.ts', import.meta.url), 'utf8');
  const oldModule = moduleUrl('export const oldVersion = true;');
  await import(oldModule);
  // Model a newly loaded command requiring a named export absent from a module
  // already cached by the upgrading parent. No real package update is run.
  const replacedCommand = moduleUrl(`import { isMultimodalEnabled } from ${JSON.stringify(oldModule)}; export const MOVEMENT_SUPERVISOR_STEP = ${JSON.stringify(step)}; isMultimodalEnabled();`);
  const key = `__upgradeSwap${Date.now()}`;
  const state = { calls: [] as unknown[], writes: [] as unknown[], lines: [] as unknown[] };
  (globalThis as any)[key] = state;
  const stateRef = `globalThis[${JSON.stringify(key)}]`;
  const deny = moduleUrl('throw Error("UNEXPECTED MODULE LOAD");');
  const stubs: Record<string, string> = {
    child_process: moduleUrl(`const s=${stateRef}; export function execSync(c){s.calls.push(c); if(c==='gbrain --version') return 'gbrain 0.60.246.0'; if(c==='gbrain features') return ''; throw Error('DENIED execSync:'+c)} export function execFileSync(c,a){s.calls.push([c,a]); if(c==='bun'&&JSON.stringify(a)==='["update","gbrain"]') return ''; if(c==='gbrain'&&a[0]==='post-upgrade') return ''; throw Error('DENIED execFileSync:'+c)} export function spawnSync(c,a){s.calls.push([c,a]); if(c==='gbrain'&&JSON.stringify(a)==='["--help"]') return {status:0,stderr:''}; throw Error('DENIED spawnSync:'+c)}`),
    fs: moduleUrl(`const s=${stateRef}; export const existsSync=x=>x.endsWith('/package.json'); export const realpathSync=x=>x; export const readFileSync=x=>{if(x.endsWith('/package.json')) return JSON.stringify({name:'gbrain',repository:'garrytan/gbrain'}); throw Error('DENIED read:'+x)}; export const writeFileSync=(...a)=>s.writes.push(a); export const mkdirSync=(...a)=>s.writes.push(a); export const appendFileSync=(...a)=>s.writes.push(a);`),
    path: 'node:path',
    '../core/semver.ts': moduleUrl('export const parseSemver=s=>s; export const semverGt=(a,b)=>a>b; export const isNewerVersion=(a,b)=>b>a;'),
    '../core/cli-force-exit.ts': moduleUrl('export const jsonRequested=()=>false; export const setCliExitVerdict=c=>{throw Error("UNEXPECTED verdict:"+c)}; export const writeJsonDocument=()=>{throw Error("UNEXPECTED JSON")};'),
    '../core/ops/contract.ts': moduleUrl('export const opError=()=>{throw Error("UNEXPECTED opError")};'),
    '../cli/cli-error.ts': moduleUrl('export const writeCliError=()=>{throw Error("UNEXPECTED cliError")};'),
    '../version.ts': moduleUrl('export const VERSION="0.60.245.0";'),
    '../core/migration-ledger.ts': moduleUrl('export const migrationLedgerSummary=()=>({wedged:[]}); export const forwardProgressPast=()=>false;'),
    '../core/preferences.ts': moduleUrl('export const loadCompletedMigrations=()=>[];'),
    '../core/migration-orchestration-lock.ts': moduleUrl('export const MIGRATIONS_RUNNING_EXIT_CODE=75; export const readMigrationLockHolder=()=>null;'),
    '../core/bun-floor.ts': moduleUrl('export const BUN_FLOOR_EXIT_CODE=70; export const evaluateBunFloor=()=>{throw Error("UNEXPECTED floor")}; export const globalGbrainSpec=()=>null; export const readBunLinkTarget=()=>null; export const readHostBun=()=>null; export const readPackageTarget=()=>null;'),
    '../core/config.ts': moduleUrl('export const resolveGbrainHome=()=>"/synthetic"; export const loadConfig=()=>({});'),
    '../core/self-upgrade.ts': moduleUrl('export const writeJustUpgraded=()=>{}; export const clearUpdateCache=()=>{}; export const clearSnooze=()=>{}; export const pendingUpgradeVersion=()=>null;'),
    './sources-writer-movement.ts': replacedCommand,
    './movement-step.ts': moduleUrl(`export const MOVEMENT_SUPERVISOR_STEP=${JSON.stringify(step)};`),
  };
  const transformed = source.replace(/(from\s*|import\s*\()(['"])([^'"]+)\2/g,
    (_, prefix, _quote, specifier) => prefix + JSON.stringify(stubs[specifier] ?? deny));
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(transformed);
  const originalArgv1 = process.argv[1];
  const originalLog = console.log;
  let error: unknown = null;
  try {
    process.argv[1] = '/synthetic/node_modules/gbrain/src/cli.ts';
    console.log = (...args) => { state.lines.push(args.join(' ')); };
    const mod = await import(moduleUrl(js));
    await mod.runUpgrade(['--no-bun-floor-check', '--no-autopilot-install']);
  } catch (e) {
    error = e;
  } finally {
    process.argv[1] = originalArgv1;
    console.log = originalLog;
    delete (globalThis as any)[key];
  }
  expect(error).toBeNull();
  expect(state.calls).toContainEqual(['bun', ['update', 'gbrain']]);
  expect(state.calls).toContainEqual(['gbrain', ['post-upgrade', '--no-autopilot-install']]);
  expect(state.lines).toContain(`Next: ${step}`);
});
