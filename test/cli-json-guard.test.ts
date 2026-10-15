/**
 * Agent contract v1 `--json` guard (A0/D2): under the guard, fd 1 carries
 * exactly one JSON document. Interposed stdout writes and console.log go to
 * stderr; only writeStdoutFinal (or writeNdjsonLine) reaches fd 1; a non-zero
 * exit that wrote no document gets the fallback document; spawnCliChild
 * pipes a child's stdout to stderr. Child processes, because the guard
 * patches process-global stdout/exit.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(import.meta.dir, '..', 'src', 'core', 'cli-force-exit.ts');

async function run(body: string): Promise<{ out: string; err: string; code: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-json-guard-'));
  const script = join(dir, 'run.ts');
  writeFileSync(script, `import * as g from ${JSON.stringify(HELPER)};\n${body}\n`);
  try {
    const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#6629 json_document_missing event', () => {
  test('the event names the release, guard and exit code, and carries no argv values', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-6629-'));
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-6629-run-'));
    const script = join(dir, 'run.ts');
    const src = join(import.meta.dir, '..', 'src');
    writeFileSync(script, `import * as g from ${JSON.stringify(HELPER)};
import { agentJsonGuardMode } from ${JSON.stringify(join(src, 'cli', 'json-guard.ts'))};
const { json } = agentJsonGuardMode(['doctor', '--json', '--fast', 'private-arg-value']);
g.installStdoutPipeDelivery({ json });
console.log('forgot the document');
process.exit(0);`);
    try {
      const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_HOME: home } });
      expect(await proc.exited).toBe(0);
      const raw = readFileSync(join(home, '.gbrain', 'agent-contract', 'events.jsonl'), 'utf8').trim();
      const { ts, ...event } = JSON.parse(raw.split('\n').pop()!);
      expect(typeof ts).toBe('string');
      const { VERSION } = await import('../src/version.ts');
      const { diagnostics, ...flat } = event;
      expect(flat).toEqual({ transport: 'cli', command: 'doctor', code: 'json_document_missing', outcome: 'committed', version: VERSION, guard: 'document', exit_code: 0 });
      expect(diagnostics).toMatchObject({ schema_version: 1, version: VERSION, guard_mode: 'document', exit_code: 0 });
      expect(raw).not.toContain('private-arg-value');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--json guard (document mode)', () => {
  test('console.log and stdout.write go to stderr; the final document alone reaches fd 1', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
console.log('human progress line');
process.stdout.write('more noise\\n');
await g.writeStdoutFinal(JSON.stringify({ ok: true }) + '\\n');
g.flushThenExit(0);`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true });
    expect(r.err).toContain('human progress line');
    expect(r.err).toContain('more noise');
  });

  test('a direct non-zero exit with no document writes the fallback document', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
console.log('Error: something human');
g.noteRenderedErrorCode('invalid_params');
process.exit(2);`);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out);
    expect(doc).toEqual({
      error: 'command_failed', code: 'invalid_params',
      message: 'The command exited with status 2 without writing its JSON result.',
      suggestion: 'Re-run without --json to read the error on stderr, or run `gbrain doctor --json`.',
      exit_code: 2, contract_version: 1,
    });
  });

  test('a document already written is never followed by a fallback', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
await g.writeStdoutFinal(JSON.stringify({ error: 'x', code: 'x' }) + '\\n');
process.exit(1);`);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ error: 'x', code: 'x' });
  });

  test('exit 0 without a document writes nothing to fd 1 (a bug D5 fails; E11 hook fires)', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
g.setJsonDocumentMissingHook(() => process.stderr.write('HOOK_FIRED\\n'));
console.log('forgot the document');
process.exit(0);`);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('HOOK_FIRED');
  });

  test('ndjson: lines reach fd 1; a failing exit appends a status:error line', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'ndjson' });
await g.writeNdjsonLine({ n: 1 });
console.log('noise');
process.exit(1);`);
    const lines = r.out.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toEqual({ n: 1 });
    expect(lines[1]).toMatchObject({ status: 'error', error: 'command_failed', exit_code: 1 });
  });

  test('spawnCliChild pipes the child stdout to stderr under the guard', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
const child = g.spawnCliChild(process.execPath, ['-e', 'console.log("child says hi")']);
await new Promise(res => child.on('close', res));
await g.writeStdoutFinal(JSON.stringify({ ok: 1 }) + '\\n');
g.flushThenExit(0);`);
    expect(JSON.parse(r.out)).toEqual({ ok: 1 });
    expect(r.err).toContain('child says hi');
  });

  test('without the guard, installStdoutPipeDelivery keeps stdout as-is', async () => {
    const r = await run(`g.installStdoutPipeDelivery();
console.log('plain');
g.flushThenExit(0);`);
    expect(r.out).toBe('plain\n');
  });
});

// ── D2: command migrations (real CLI subprocesses, isolated GBRAIN_HOME) ──
import { runCli } from './helpers/cli-spawn.ts';
import { mkdirSync } from 'node:fs';

function onlyDocument(stdout: string): Record<string, unknown> {
  const doc = JSON.parse(stdout);
  expect(typeof doc).toBe('object');
  return doc;
}

describe('D2 command migrations: init', () => {
  test('init --pglite --no-embedding --json: one document carrying the first-run decision bundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-json-init-'));
    try {
      const r = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, cwd: home, timeoutMs: 120_000 });
      expect(r.exitCode).toBe(0);
      const doc = onlyDocument(r.stdout);
      expect(doc).toMatchObject({ status: 'success', engine: 'pglite', contract_version: 1 });
      const bundle = (doc.notices as Array<Record<string, any>>).find(n => n.code === 'first_run_decisions')!;
      expect(bundle).toMatchObject({ kind: 'ask', contract_version: 1 });
      expect(bundle.user_message).toContain("Reply 'defaults'");
      const searchMode = bundle.decisions.find((d: { id: string }) => d.id === 'search_mode');
      expect(searchMode.options.map((o: { id: string }) => o.id)).toEqual(['conservative', 'balanced', 'tokenmax']);
      expect(searchMode.options[0].argv).toEqual(['gbrain', 'config', 'set', 'search.mode', 'conservative']);
      // Progress lines and the picker's event went to stderr.
      expect(r.stderr).toContain('Setting up local brain with PGLite');
      expect(r.stdout).not.toContain('search_mode_picker');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);

  test('init --json usage failure: legacy one-line keys plus the v1 envelope, exit 2', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-json-init-'));
    try {
      const r = await runCli(['init', '--mcp-only', '--json', '--mcp-url', 'http://127.0.0.1:1/mcp', '--oauth-client-id', 'cid', '--oauth-client-secret', 'cs'], { home, cwd: home });
      expect(r.exitCode).toBe(2);
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
      expect(onlyDocument(r.stdout)).toMatchObject({ status: 'error', reason: 'missing_issuer_url', error: 'invalid_params', code: 'invalid_params', contract_version: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('init --json on a malformed config: config_error document, config untouched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-json-init-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), '{broken');
      const r = await runCli(['init', '--pglite', '--json'], { home, cwd: home });
      expect(r.exitCode).toBe(1);
      const doc = onlyDocument(r.stdout);
      expect(doc).toMatchObject({ status: 'error', reason: 'invalid_existing_config', code: 'config_error' });
      expect(typeof doc.suggestion).toBe('string');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('D2 command migrations: doctor, sync, embed on a keyless brain', () => {
  let home = '';
  const cli = (args: string[]) => runCli(args, { home, cwd: home, timeoutMs: 120_000 });

  test('setup: keyless PGLite brain + a git-backed source', async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-json-cmds-'));
    expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const repo = join(home, 'notes');
    mkdirSync(repo);
    writeFileSync(join(repo, 'example.md'), '---\ntitle: Example\n---\nHello world\n');
    const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', ...args], { cwd: repo });
    git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'init']);
    expect((await cli(['sources', 'add', 'notes', '--path', repo])).exitCode).toBe(0);
  }, 150_000);

  test('doctor --json --fast: one report document', async () => {
    const r = await cli(['doctor', '--json', '--fast']);
    expect(onlyDocument(r.stdout)).toMatchObject({ schema_version: 2 });
    expect(typeof onlyDocument(r.stdout).health_score).toBe('number');
  }, 120_000);

  test('sync --json success: one envelope; a failing sync: one v1 error document', async () => {
    const ok = await cli(['sync', '--source', 'notes', '--no-pull', '--json']);
    expect(ok.exitCode).toBe(0);
    expect(onlyDocument(ok.stdout)).toMatchObject({ schema_version: 1, source_id: 'notes', added: 1 });
    const bad = await cli(['sync', '--source', 'no-such-source', '--no-pull', '--json']);
    expect(bad.exitCode).toBe(1);
    const doc = onlyDocument(bad.stdout);
    expect(typeof doc.code).toBe('string');
    expect(typeof doc.suggestion).toBe('string');
    expect(doc.contract_version).toBe(1);
  }, 120_000);

  test('embed --json: keyless --stale is a result document (exit 0); --all is embedding_disabled (exit 1)', async () => {
    const stale = await cli(['embed', '--stale', '--json']);
    expect(stale.exitCode).toBe(0);
    expect(onlyDocument(stale.stdout)).toMatchObject({ failures: 0 });
    const all = await cli(['embed', '--all', '--json']);
    expect(all.exitCode).toBe(1);
    const doc = onlyDocument(all.stdout) as { code?: string; reason?: string; fix?: { argv?: string[] } };
    expect(doc).toMatchObject({ code: 'embedding_disabled', reason: 'disabled_by_choice' });
    expect(doc.fix?.argv?.[0]).toBe('gbrain'); // the readiness enablement command (A7)
  }, 120_000);

  test('sync status|unblock --json: the one document on stdout, nothing JSON on stderr (#6386)', async () => {
    for (const verb of ['status', 'unblock']) {
      const r = await cli(['sync', verb, '--source', 'notes', '--json']);
      expect(r.exitCode).toBe(0);
      expect(onlyDocument(r.stdout)).toMatchObject({ source_id: 'notes' });
      expect(r.stderr.split('\n').some(line => line.startsWith('{'))).toBe(false);
    }
  }, 120_000);

  test('doctor --json with no brain: the no_brain envelope', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gbrain-json-nobrain-'));
    try {
      const r = await runCli(['doctor', '--json'], { home: empty, cwd: empty });
      expect(r.exitCode).toBe(1);
      expect(onlyDocument(r.stdout)).toMatchObject({ code: 'no_brain', fix: { argv: ['gbrain', 'init', '--pglite', '--no-embedding'] } });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('teardown', () => { rmSync(home, { recursive: true, force: true }); });
});

describe('D2 command migrations: embed --facts on a brain with an embedding model', () => {
  test('embed --stale --facts --dry-run --json: one document on stdout, no copy on stderr (#6386)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-json-facts-'));
    try {
      const cli = (args: string[]) => runCli(args, { home, cwd: home, timeoutMs: 120_000, env: { OPENAI_API_KEY: undefined } });
      expect((await cli(['init', '--pglite', '--embedding-model', 'openai:text-embedding-3-small', '--json'])).exitCode).toBe(0);
      const r = await cli(['embed', '--stale', '--facts', '--source', 'default', '--dry-run', '--json']);
      expect(r.exitCode).toBe(0);
      expect(onlyDocument(r.stdout)).toMatchObject({ source_id: 'default', dryRun: true, stopped: 'preview' });
      expect(r.stderr.split('\n').some(line => line.startsWith('{'))).toBe(false);
      const plain = await cli(['embed', '--stale', '--facts', '--source', 'default', '--dry-run']);
      expect(plain.exitCode).toBe(0);
      expect(onlyDocument(plain.stdout)).toMatchObject({ source_id: 'default', dryRun: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);
});

// Exercise the real guard → exit hook → bounded event writer without CLI/DB startup.
describe('missing-document diagnostics', () => {
  async function probe(body: string, argv = ['doctor', '--json'], mode?: 'ndjson', failContext = false, legacyHook = false) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-json-diagnostic-'));
    const script = join(dir, 'run.ts');
    let guard = join(import.meta.dir, '..', 'src', 'cli', 'json-guard.ts');
    if (legacyHook) {
      const stub = join(dir, 'old-hook.ts');
      writeFileSync(stub, `export const jsonRequested = () => true; export function setJsonDocumentMissingHook(hook) { globalThis.oldJsonMissingHook = hook; }`);
      const copy = readFileSync(guard, 'utf8')
        .replace("'../core/cli-force-exit.ts'", JSON.stringify(stub))
        .replace("'../version.ts'", JSON.stringify(join(import.meta.dir, '..', 'src', 'version.ts')))
        .replace("'../core/agent-contract-log.ts'", JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'agent-contract-log.ts')))
        .replace("'./command-table.ts'", JSON.stringify(join(import.meta.dir, '..', 'src', 'cli', 'command-table.ts')));
      guard = join(dir, 'copied-real-guard.ts');
      writeFileSync(guard, copy);
    }
    writeFileSync(script, `import * as g from ${JSON.stringify(HELPER)};
import { agentJsonGuardMode } from ${JSON.stringify(guard)};
const args = ${JSON.stringify(argv)};
if (${failContext}) {
  let iterations = 0;
  Object.defineProperty(args, Symbol.iterator, { value() {
    if (++iterations > 1) throw new Error('PRIVATE_CONTEXT_ERROR');
    return Array.prototype[Symbol.iterator].call(this);
  } });
}
const mode = agentJsonGuardMode(args);
g.installStdoutPipeDelivery(${mode ? JSON.stringify({ json: mode }) : 'mode'});
${body}\n`);
    try {
      const proc = Bun.spawn([process.execPath, '--no-env-file', script], {
        cwd: dir, env: { HOME: dir, GBRAIN_HOME: dir, PATH: process.env.PATH ?? '' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const file = Bun.file(join(dir, '.gbrain', 'agent-contract', 'events.jsonl'));
      const raw = await file.exists() ? await file.text() : '';
      return { out, err, code, raw, events: raw.trim() ? raw.trim().split('\n').map(line => JSON.parse(line)) : [] };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test('records bounded shape and exact UTF8 / Uint8Array attempted bytes, never argument values', async () => {
    const r = await probe(`console.log('秘密');
process.stdout.write(new Uint8Array([65, 66, 67]));
process.stdout.write('ff', 'hex');
process.exit(0);`, ['doctor', '--json', '--fast', '--only=SECRET_CHECK', '--unknown-secret=SECRET_VALUE', '--token', 'SECRET_TOKEN', '--json', '--', '--remediate']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.events).toHaveLength(1);
    const d = r.events[0].diagnostics;
    expect(d).toMatchObject({ schema_version: 1, guard_mode: 'document', exit_code: 0,
      final_document_written: false, redirected_stdout_bytes: 11, flag_names: ['--json', '--fast', '--only'] });
    const { VERSION } = await import('../src/version.ts');
    expect(d.version).toBe(VERSION);
    expect(d.invocation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(d).sort()).toEqual(['schema_version', 'version', 'invocation_id', 'flag_names', 'guard_mode', 'exit_code', 'final_document_written', 'redirected_stdout_bytes'].sort());
    for (const secret of ['秘密', 'SECRET_CHECK', 'SECRET_VALUE', 'SECRET_TOKEN', '--unknown-secret', '--token', '--remediate']) expect(r.raw).not.toContain(secret);
  });

  test('separate invocations have distinct identifiers and zero output counts', async () => {
    const a = await probe('process.exit(0);');
    const b = await probe('process.exit(0);');
    expect(a.events[0].diagnostics.redirected_stdout_bytes).toBe(0);
    expect(a.events[0].diagnostics.invocation_id).not.toBe(b.events[0].diagnostics.invocation_id);
  });

  test('normal JSON emits no missing-document event', async () => {
    const r = await probe(`await g.writeStdoutFinal('{"ok":true}\\n'); process.exit(0);`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true });
    expect(r.events).toEqual([]);
  });

  test('nonzero fallback retains its exit and emits no missing-document event', async () => {
    const r = await probe('process.exit(2);');
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ exit_code: 2, error: 'command_failed' });
    expect(r.events).toEqual([]);
  });

  test('empty NDJSON emits no missing-document event', async () => {
    const r = await probe('process.exit(0);', ['doctor', '--json'], 'ndjson');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.events).toEqual([]);
  });

  test('context collection failure preserves the original event without private error text', async () => {
    const r = await probe('process.exit(0);', ['doctor', '--json'], undefined, true);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ command: 'doctor', code: 'json_document_missing', outcome: 'committed' });
    expect(r.events[0].diagnostics).toBeUndefined();
    expect(r.raw + r.err).not.toContain('PRIVATE_CONTEXT_ERROR');
  });

  test('legacy no-argument hook preserves an event without incomplete schema metadata', async () => {
    const r = await probe('globalThis.oldJsonMissingHook(); process.exit(0);', ['doctor', '--json'], undefined, false, true);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ command: 'doctor', code: 'json_document_missing', outcome: 'committed' });
    expect(r.events[0].diagnostics).toBeUndefined();
  });

  test('a failing diagnostics hook cannot change exit or output', async () => {
    const r = await probe(`g.setJsonDocumentMissingHook(() => { throw new Error('PRIVATE_HOOK_ERROR'); }); process.exit(0);`);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).not.toContain('PRIVATE_HOOK_ERROR');
    expect(r.events).toEqual([]);
  });
});
