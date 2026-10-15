/** Shared path admission for managed sync discovery and its read-only diagnostics. */
import type { BrainEngine } from '../engine.ts';
import { isSyncable, matchesAnyGlob, type SyncStrategy } from '../sync.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';

/** Persisted exclusions are source-relative, including when slugs use the Git root. */
export async function syncExcludePatterns(engine: Pick<BrainEngine, 'getConfig'>, extra: readonly string[] = []): Promise<string[]> {
  return [...extra, ...(await engine.getConfig('sync.exclude') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v);
}

/**
 * Git-relative paths drive strategy/metafile/hidden admission; source-relative
 * paths drive exclusions. Reserved-skill checks use the original sourcePath,
 * whose root follows the source slug pin; none of these coordinates can be collapsed.
 */
export async function resolveSyncAdmission(engine: Pick<BrainEngine, 'getConfig'>,
  opts: { strategy: SyncStrategy; exclude?: readonly string[]; includeHidden?: readonly string[] }) {
  const exclude = await syncExcludePatterns(engine, opts.exclude);
  const includeHidden = [...new Set([...(opts.includeHidden ?? []), ...(await engine.getConfig('sync.include_hidden') ?? '')
    .split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))];
  return {
    includeHidden,
    eligible: (gitPath: string, sourceRelativePath: string, reservedPath: string) => !matchesAnyGlob(sourceRelativePath, exclude)
      && !isReservedSkillBundlePath(reservedPath)
      && isSyncable(gitPath, { strategy: opts.strategy, includeHidden }),
  };
}
