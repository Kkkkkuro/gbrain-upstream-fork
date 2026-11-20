import type { BrainEngine } from '../../../core/engine.ts';
import { excludedAtomSources } from '../../../core/cycle/atom-source-policy.ts';
import { countExtractAtomsBacklog } from '../../../core/cycle/extract-atoms.ts';

/** Total backlog: brain-wide when unscoped, else the sum over the granted ids. */
export async function countExtractAtomsBacklogScoped(
  engine: BrainEngine,
  countBacklog: (engine: BrainEngine, id?: string) => Promise<number | null>,
  sourceIds?: string[],
): Promise<number | null> {
  if (!sourceIds) return countBacklog(engine);
  let total = 0;
  for (const id of sourceIds) {
    const n = await countBacklog(engine, id);
    if (n === null) return null;
    total += n;
  }
  return total;
}

export async function policyExcludedAtomPages(engine: BrainEngine, grants?: string[]): Promise<number> {
  const excluded = await excludedAtomSources(engine);
  const visible = grants ? excluded.filter(id => grants.includes(id)) : excluded;
  const count = await countExtractAtomsBacklogScoped(engine,
    (brain, source) => countExtractAtomsBacklog(brain, source, { excludedOnly: true }), visible);
  if (count === null) throw new Error('Could not count pages excluded from provider-based atom extraction.');
  return count;
}
