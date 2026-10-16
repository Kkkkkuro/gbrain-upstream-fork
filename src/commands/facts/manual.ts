import { readFileSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../../core/engine.ts';
import type { GBrainConfig } from '../../core/config.ts';
import { applyManualRelink, previewManualRelink } from '../../core/facts/relink-manual.ts';
import { opError } from '../../core/ops/contract.ts';

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw opError('invalid_params', 'The manual relink input could not be read as JSON.', 'Check the local file path, permissions and JSON syntax; nothing was submitted.'); }
}

export const isManualRelinkArgs = (args: string[]) => args.some(a => ['--mapping', '--manifest-out', '--apply-manifest', '--allow-page-effects'].includes(a));

/** Existing facts command is host-only; never add these to MCP operations. */
export async function runManualRelinkCommand(engine: BrainEngine, config: GBrainConfig, sourceId: string, args: string[]): Promise<number> {
  const values: Record<string, string> = {}; const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (['--mapping', '--manifest-out', '--apply-manifest', '--source'].includes(a)) {
      const v = args[++i];
      if (!v || v.startsWith('--') || a in values) { console.error(`manual relink: ${a} needs one value`); return 1; }
      values[a] = v;
    } else if (['--dry-run', '--json', '--allow-page-effects'].includes(a) && !flags.has(a)) flags.add(a);
    else { console.error(`manual relink: unsupported or repeated flag ${a}`); return 1; }
  }
  sourceId = values['--source'] ?? sourceId;
  const preview = !!values['--mapping'] && !!values['--manifest-out'] && flags.has('--dry-run') && !values['--apply-manifest'] && !flags.has('--allow-page-effects');
  const apply = !!values['--apply-manifest'] && flags.has('--allow-page-effects') && !values['--mapping'] && !values['--manifest-out'] && !flags.has('--dry-run');
  if (!preview && !apply) { console.error('manual relink: preview needs --mapping FILE --manifest-out NEW_FILE --dry-run; apply needs --apply-manifest FILE --allow-page-effects. Applying may queue paid page embedding; obtain operator cost authorization first.'); return 1; }
  if (preview) {
    const mapping = readJson(values['--mapping']!);
    const manifest = await previewManualRelink(engine, sourceId, mapping);
    // Private new output only: never overwrite an older approved manifest.
    try { writeFileSync(values['--manifest-out']!, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { throw opError('invalid_params', 'The private preview manifest could not be created.', 'Choose a new writable output path. Existing manifests are never overwritten, and no write request was submitted.'); }
    console.log(JSON.stringify({ status: 'preview', manifest: values['--manifest-out'], outcomes: manifest.outcomes, effects: manifest.effects,
      next: 'Review the mapping and acquire any page-effect cost authorization before applying this exact manifest.' }));
    return 0;
  }
  const manifest = readJson(values['--apply-manifest']!);
  const result = await applyManualRelink(engine, config, sourceId, manifest);
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
