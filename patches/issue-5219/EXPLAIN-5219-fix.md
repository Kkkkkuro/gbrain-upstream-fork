# EXPLAIN: fix for upstream #5219

**Status:** fork-only patch for Owner review. Do **not** open an upstream PR or comment on the upstream issue until Owner approves.

**Issue:** [garrytan/gbrain#5219](https://github.com/garrytan/gbrain/issues/5219) — `sources archive|remove` blocked by `recovery_required` when the canonical checkout was deleted out-of-band, even for a zero-page / zero-chunk source. Recreating a stub directory at the same path is refused by physical-checkout identity guards, so operators have no legitimate exit.

**Base:** upstream tag `v0.60.27.0`.

## Problem

In `runManagedSourceLifecycle`, every bound `local_path` is `existsSync`'d and hashed via `worktreeManifest` before the topology transaction. A missing path always throws:

> `recovery_required`: The canonical checkout is missing; restore its verified manifest first.

That is correct for sources that still hold pages (including soft-deleted tombstones) or pending mirrors: the checkout is the recovery substrate. It is wrong for a **verified-empty** source that will never need that substrate again for archive/remove.

## Solution (narrow + explicit)

Add an opt-in flag:

```bash
gbrain sources archive <id> --retire-missing-checkout
gbrain sources remove <id> --confirm-destructive --retire-missing-checkout
```

Skip the missing-path `existsSync` / manifest hash **only when all** of:

1. Operation is `archive` or `remove` (not `purge`, `rebind`, `restore`, `claim`, …)
2. Caller passed `retireMissingCheckout: true` / `--retire-missing-checkout`
3. For every source bound to the missing path (shared-root safe): live pages = 0, soft-deleted pages = 0, chunks = 0, and no pending withdrawal/publication effects

Otherwise keep fail-closed:

- No flag → same `recovery_required` (plus a suggestion naming the flag for empty sources)
- Flag but populated / soft-deleted / chunks remain → `recovery_required` with a concrete reason
- Flag on wrong verb → `invalid_params`
- Stub directory at the old path → physical-identity / rebind / claim paths unchanged (retire hatch only skips *missing* paths)

No directories are created. Archive/remove retain existing receipt, idempotency, incarnation, and dry-run semantics.

## Why explicit flag (not default)

Default-skipping a missing checkout on archive/remove would silently retire topology when an operator mistyped a path or a mount briefly disappeared. The failure mode in #5219 is uncommon and operationally deliberate; an explicit flag matches other destructive confirmations (`--confirm-destructive`) and keeps the managed-writer / recovery story audible.

## Security impact

| Guard | Effect of this change |
|---|---|
| Missing checkout for populated sources | Still `recovery_required` |
| Soft-deleted pages | Still block retire |
| Pending mirrors / withdrawal-mirror | Still block (gate + existing `settleTopologyRequests`) |
| Physical checkout identity / stub recreate | Untouched |
| Managed-writer / filesystem fence | Untouched |
| `--force` / “skip everything” | Not introduced; flag is archive|remove + empty-only |

## Alternatives considered

1. **Default-allow empty missing checkout** — rejected: silent topology mutation on transient path loss.
2. **`--force` bypass** — rejected: too wide; would tempt reuse for populated sources / identity laundering.
3. **New `sources recover retire-empty` subcommand** — workable but more surface area; flag on existing archive/remove matches the operator intent (“retire this source”).
4. **Include `purge`** — deferred per issue scope (“purge 另议”); purge already requires archived + confirm.

## Upgrade-chain note (0.60.25.0 → 0.60.27.0+)

This is a pure control-path change (CLI flag + lifecycle gate). No schema migration, no VERSION bump in this fork patch (community fix; `/ship` owns CHANGELOG/VERSION per CONTRIBUTING/RELEASING). After upgrade to a release that includes this patch, operators unblock with:

```bash
gbrain sources archive <id> --retire-missing-checkout
# or
gbrain sources remove <id> --confirm-destructive --retire-missing-checkout
```

Unaffected: brains that never hit missing checkouts; populated-source recovery; writer transfer / physical-root flows.

## Files touched

- `src/core/persistence/source-lifecycle.ts` — gate + skip
- `src/core/persistence/administration.ts` — wire `retire_missing_checkout`
- `src/commands/sources-lifecycle-args.ts` — parse `--retire-missing-checkout`
- `src/commands/sources-lifecycle.ts` — help text
- `src/core/cli-flag-registry.generated.ts` — regen
- `test/persistence-source-lifecycle.test.ts` — repro + counterexamples

## Draft upstream PR description (Owner review only — do not publish)

Title (when Owner ships): `vX.Y.Z.W fix(persistence): retire empty source with missing checkout (#5219)`

### What

Allow `gbrain sources archive|remove --retire-missing-checkout` to succeed when the canonical checkout directory is already gone **and** the source has zero live pages, zero soft-deleted pages, zero chunks, and no pending mirrors. Populated sources, soft-deleted tombstones, physical-identity stub recreation, and all other lifecycle verbs stay fail-closed.

### Why

Fixes #5219: operators could neither archive/remove a zero-page source after an out-of-band checkout delete nor recreate a stub at the same path (physical identity correctly refuses). There was no legitimate exit short of restoring the original inode/ownership markers.

### Discrimination test

Discrimination test: reverted `src/core/persistence/source-lifecycle.ts` `src/commands/sources-lifecycle-args.ts` `src/core/persistence/administration.ts` to merge-base, ran `test/persistence-source-lifecycle.test.ts` → 23 pass / 4 fail. Restored → all pass.

### Tests

- `test/persistence-source-lifecycle.test.ts` (new #5219 cases)
- Adjacent: `test/persistence-physical-root.test.ts`, `test/cli-flag-validation.test.ts`
- `bun run typecheck`, `bash scripts/check-test-isolation.sh`
