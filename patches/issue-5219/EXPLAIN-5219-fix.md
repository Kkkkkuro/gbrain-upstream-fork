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

## 模型使用

| 项 | 实际 |
|---|---|
| 主会话模型 | **Auto**（Cloud Agent `run-info.originalModelName = default`；派单要求显式 Auto） |
| `~/.cursor/rules/pstack-models.mdc` | **不存在**（本环境无该文件；无覆盖角色行可列） |

按 pstack / poteto 派出的子任务（仅列出实际发起的 Task）：

| 阶段 / 角色 | 派出方式 | 请求的 model 参数 | 实际生效模型 | 相对 pstack 默认是否回退 |
|---|---|---|---|---|
| poteto-mode 定位（读 SKILL + Principles；bug-fix playbook 取向） | `Task` → `poteto-agent` | `inherit` | 继承主会话 **Auto** | poteto skill 默认 bug-fix 角色为 `grok-4.7-xhigh-fast`（poteto 子代理回报：无本地 pstack-models 覆盖）。本次未再派独立 bug-fix 代码子代理，定位阶段本身用 inherit→Auto。 |
| how / 代码库探查（#5219 守卫与空源门控设计摸底） | `Task` → `explore` | `inherit` | 继承主会话 **Auto** | 用户规则里 how（explorer）默认为 `auto`，与本次 Auto 一致；**无额外回退**。 |
| bug-fix 实现 / 测试 / 文档（写失败测试、最小修复、跑测、产物） | **未派子代理**；主会话直接执行 | — | 主会话 **Auto** | 用户规则 bug-fix 默认为 `claude-sonnet-5-5-medium`；poteto skill 默认为 `grok-4.7-xhigh-fast`。本次**没有**按该角色再开 Task，整段实现留在主会话 Auto。记为：**未按 pstack bug-fix 角色单独派模，回退/等价于主会话 Auto**。 |
| why / architect / judgment 专轮 | 未派出 | — | — | 未派出（未确认若派出时会落到哪一档硬件模型名以外的路由细节）。 |

说明：子代理调用时只传了 `model: "inherit"`，工具回报未另附底层供应商模型 slug；除上表外无其它 pstack 子任务。查不到的底层具体模型 ID 标 **未确认**，不猜测。
