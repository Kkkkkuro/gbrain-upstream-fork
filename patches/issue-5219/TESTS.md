# #5219 test evidence

Base: upstream tag `v0.60.27.0` (`ad7900d8dcd221e22b885fef0f4030b73a1d69c9`) on fork branch
`fix/5219-retire-zero-page-source-missing-checkout`.

Environment: Bun 1.4.2, temporary PGLite fixtures only (no live brain / no keys).

## Pre-fix (failing repro)

```bash
# After adding tests only (before source fix):
bun test test/persistence-source-lifecycle.test.ts
```

Summary (full log: retained in agent workspace `/tmp/5219-pre-fix.txt`):

- **EXIT=1**
- **25 pass / 2 fail**
- Failures:
  1. `retire-missing-checkout archives and removes zero-page sources whose checkout is gone (#5219)`
     - `OperationError: The canonical checkout is missing; restore its verified manifest first.`
     - at `src/core/persistence/source-lifecycle.ts:109`
  2. `sources archive/remove accept --retire-missing-checkout only on those verbs (#5219)`
     - `OperationError: Unknown option --retire-missing-checkout.`

Also confirmed by discrimination helper after the fix landed:

```bash
bash scripts/check-test-discriminates.sh \
  test/persistence-source-lifecycle.test.ts \
  src/core/persistence/source-lifecycle.ts \
  src/commands/sources-lifecycle-args.ts \
  src/core/persistence/administration.ts
```

→ `Discrimination test: reverted … to merge-base, ran test/persistence-source-lifecycle.test.ts → 23 pass / 4 fail. Restored → all pass.` (EXIT=0)

## Post-fix

```bash
bun test test/persistence-source-lifecycle.test.ts
```

- **EXIT=0**
- **27 pass / 0 fail**

```bash
bun test \
  test/persistence-source-lifecycle.test.ts \
  test/persistence-physical-root.test.ts \
  test/cli-flag-validation.test.ts
```

- **EXIT=0**
- **69 pass / 1 skip / 0 fail**

```bash
bun run typecheck
```

- **EXIT=0**

```bash
bash scripts/check-test-isolation.sh
```

- **EXIT=0** (`OK (2202 non-serial unit files scanned)`)

```bash
bun run build:flag-registry
```

- Regenerated `src/core/cli-flag-registry.generated.ts` with `--retire-missing-checkout` on `sources` / `repos`.

## Not run / 未确认

- Full `bun run verify` suite (19+ parallel guards) — **未确认** (not executed end-to-end in this session).
- `bun run ci:local` / E2E against Postgres — **未确认** (Docker/PgBouncer gate not run).
- Live CLI against a real `~/.gbrain` — **intentionally not run** (hard constraint: no live systems).
