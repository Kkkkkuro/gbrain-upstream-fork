import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';

export const ATOM_EXCLUDED_SOURCES = 'cycle.extract_atoms.excluded_sources';

/** An absent setting keeps the existing source selection; a malformed stored policy never enables a provider call. */
export function parseExcludedAtomSources(raw: string | null): string[] {
  if (raw === null) return [];
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { /* report one actionable config error below */ }
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string' && isValidSourceId(entry))) {
    throw opError('invalid_params', `Invalid ${ATOM_EXCLUDED_SOURCES}: expected a JSON array of exact source IDs.`,
      `Inspect gbrain config get ${ATOM_EXCLUDED_SOURCES} and correct the list before running atom extraction.`);
  }
  return [...new Set(entries)];
}

export class AtomSourcePolicyUnavailable extends Error {}

/** Read the stored policy even when a long-running phase has a cached config snapshot. */
export async function excludedAtomSources(engine: BrainEngine): Promise<string[]> {
  try {
    const [row] = await engine.getConfigValues([ATOM_EXCLUDED_SOURCES]);
    return parseExcludedAtomSources(row?.value ?? null);
  } catch (cause) {
    throw new AtomSourcePolicyUnavailable('Atom extraction cannot read its source policy. Check cycle.extract_atoms.excluded_sources before retrying.', { cause });
  }
}
