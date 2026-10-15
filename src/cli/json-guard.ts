/**
 * Agent contract v1 (D2): which `--json` guard mode this invocation runs
 * under. The guard is on only for commands whose command-table record
 * declares `json` (or, for a record whose subcommands differ in shape,
 * `jsonSubcommands[<first positional after the command>]`); they write their
 * result through writeStdoutFinal / writeNdjsonLine, so undeclared commands
 * keep their current stdout. Also wires the E11 `json_document_missing`
 * record for the exit-0 bug case (document mode only), stamped with the
 * gbrain version, the guard and the exit code (#6629).
 */
import { jsonRequested, setJsonDocumentMissingHook } from '../core/cli-force-exit.ts';
import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.ts';
import { recordAgentContractEvent } from '../core/agent-contract-log.ts';
import { findCliCommand } from './command-table.ts';

// Only names with known Doctor semantics; values and unknown tokens are never persisted.
const DOCTOR_DIAGNOSTIC_FLAGS = new Set([
  '--json', '--help', '--fast', '--only', '--no-migrate', '--remediation-plan', '--remediate', '--dry-run',
]);

export function agentJsonGuardMode(argv: readonly string[]): { json?: 'document' | 'ndjson' } {
  const at = argv.findIndex(a => !a.startsWith('-') && findCliCommand(a) !== undefined);
  const command = at >= 0 ? argv[at] : undefined;
  const record = command ? findCliCommand(command) : undefined;
  const sub = argv.slice(at + 1).find(a => !a.startsWith('-'));
  const subs = record?.jsonSubcommands;
  const json = record?.json ?? (sub !== undefined && subs && Object.hasOwn(subs, sub) ? subs[sub] : undefined);
  if (!json || !jsonRequested(argv)) return {};
  let context: { version: string; invocation_id: string; flag_names: string[] } | undefined;
  try {
    const names = new Set<string>();
    if (command === 'doctor') {
      for (const arg of argv) {
        if (arg === '--') break;
        const name = arg.split('=', 1)[0]!;
        if (DOCTOR_DIAGNOSTIC_FLAGS.has(name)) names.add(name);
      }
    }
    context = { version: VERSION, invocation_id: randomUUID(), flag_names: [...names] };
  } catch { /* preserve the original event if diagnostic context cannot be collected */ }
  setJsonDocumentMissingHook(observation => {
    // Old exit helpers call hook() without observation during a rolling file
    // update. Preserve the original event rather than emit an incomplete schema.
    const valid = observation?.guard_mode === 'document' && observation.exit_code === 0
      && observation.final_document_written === false
      && Number.isSafeInteger(observation.redirected_stdout_bytes) && observation.redirected_stdout_bytes >= 0;
    recordAgentContractEvent({
      transport: 'cli', command, code: 'json_document_missing', outcome: 'committed',
      version: VERSION, guard: 'document', exit_code: 0,
      ...(context && valid ? { diagnostics: {
        schema_version: 1 as const, ...context, guard_mode: observation.guard_mode,
        exit_code: observation.exit_code, final_document_written: observation.final_document_written,
        redirected_stdout_bytes: observation.redirected_stdout_bytes,
      } } : {}),
    });
  });
  return { json };
}
