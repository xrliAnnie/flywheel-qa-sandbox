# QA · FLY-710 — FLY-707 enablement (PASS)

**Issue**: FLY-710 (QA · FLY-707 enablement — 独立验证 PR #400)
**Gates**: FLY-707 (PR #400 — auto-QA + doc_flow enablement + default-enable Lead policy) ship-readiness
**PR head verified**: `c120183a8297ade2d3745dbd1ca1a388140efea7`
**Date**: 2026-06-30
**Verdict**: **PASS 4/4** — PR #400 ship-ready，跟批次（637/694/697/699/400）一起 founder-gate ship

## Scope

独立 **pre-deploy** QA of PR #400。隔离 worktree（`/Users/xiaorongli/Dev/flywheel-FLY-710`，git worktree of canonical repo）检出 PR head `c120183a` 跑全套只读验证，**不碰生产 Bridge / 生产 `~/.claude` / canonical root**。PR 为纯 additive（5 文件 +238/-0，无删除），`gh pr view` 报 MERGEABLE，base=main。

PR #400 的 5 个文件：
- `.flywheel/config.yaml`（+25）
- `packages/teamlead/lead-rules-base/default-enable-policy.md`（+64，新增）
- `packages/teamlead/lead-rules-base/README.md`（+1）
- `packages/teamlead/scripts/claude-lead.sh`（+13）
- `packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts`（+135，新增）

**E2E carve-out（认同）**：真 auto-QA-live-fire（部署后 `qa.auto` live → 真 spawn QA·FLY-XX runner）是 chicken-egg —— 要 Tier-3 Bridge 重启才 live，属 **post-deploy** 验，不在本 QA。本 QA 验 pre-deploy 确定性（config 解析 + 代码级真 dispatch + 政策 doc + 工具链）。

## [1] config 改对 — PASS

`.flywheel/config.yaml` **顶层**（非嵌套，插入在 `checkpoints:` 块之后）：

```yaml
qa:
  auto: true
  skip_labels: [docs, chore]
doc_flow:
  enabled: true
  default_department: engineering
```

- 经 `ConfigLoader` 真解析成功：回归测试 `beforeAll` 用真 `ConfigLoader(readFileSync)` load 此 canonical 文件，`cfg.qa` / `cfg.doc_flow` 被正确填充（断言通过）。
- 全仓 build exit 0 → `qa` / `doc_flow` 已在 `FlywheelConfig` 类型中（否则 `cfg.qa?.auto` 处 TS 编译失败），非 silent passthrough。
- **位置正确**：是 `<projectRoot>/.flywheel/config.yaml` 顶层 `qa:` 块（`auto-qa-config-source.ts → ConfigLoader → cfg.qa → resolveAutoQaPolicy` 读的就是这里），**不是** `.claude/qa-config.yaml`（那是 `packages/qa-framework` orchestrator 的 doc_root/domains 配置，无 `auto` 键）。

## [2] 真-fire 回归测试 — PASS

`packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts`（5 tests）：

| 验证手段 | 结果 |
|---|---|
| 复跑（2 次） | **5/5 通过，确定性**（164ms / 21ms） |
| `resolveAutoQaPolicy` engineer issue | `enabled: true`（对照真源码 `auto-qa-policy.ts`：无 kill-switch / 无 no-qa / `qa.auto===true` / "engineer" 不在 skip_labels → ON） |
| `resolveAutoQaPolicy` docs issue | `enabled: false`，`reason` 含 "docs"（skip_labels 命中） |
| `AutoQaCoordinator.onMainAwaitingReview`（真 fire） | 真驱动 dispatch：`start` 被调 1 次，`sessionRole === "qa"`，`startPoint === reviewed SHA`（对照 `auto-qa-coordinator.ts` `onMainAwaitingReview → spawnQa → startDispatcher.start({sessionRole:"qa", startPoint:sha})`） |

**变异负控（mutation test，最强证据）**：临时把 canonical config 的 `qa.auto` 翻 `false` → **5 中 4 失败**（`qa.auto` 断言、两个 policy 断言、**以及那个「真 fire」coordinator dispatch 测试**），仅不依赖 `qa.auto` 的 `doc_flow` 断言还过 → 证明：
1. 测试**真读** canonical `.flywheel/config.yaml`（不是 hand-built stub / 套套逻辑）；
2. coordinator 测试**真驱动** `onMainAwaitingReview` → policy → dispatch 这条真代码路径，config 一关 QA 就不 spawn——这正是 default-enable-policy.md「verify it really fires, don't just merge the config」的属性。

验证后 config 已 `git diff --stat` 确认还原干净（空 diff，无 `.bak` 残留）。

## [3] default-enable 政策 doc — PASS

`packages/teamlead/lead-rules-base/default-enable-policy.md`（FLY-707 / FLY-698）：

- **政策正确**：built + applicable 的 user/workflow 功能 default-enable（config opt-ins 如 `qa.auto`/`doc_flow`，及默认-off env flag），不留 dormant；区分 `=== "1"`（默认-OFF opt-in，set 来开）vs `!== "0"`（默认-ON kill-switch，已开别碰）的 flag 习惯；要求「observed firing」非「key present」。
- **安全闸豁免正确**：硬豁免列表引用的治理闸在代码库**真实存在**且描述准确——
  - `founder_consent` / `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE`（FLY-175）→ `packages/flywheel-comm/src/founder-consent-audit.ts` 等真实存在；
  - `founder_ux_gate`（FLY-598）→ `packages/flywheel-comm/src/commands/founder-ux.ts` 真实存在；
  - branch-protection / merge gates → `packages/teamlead/scripts/verify-merge-actor-denied.sh` 等真实存在。
  - 豁免理由正确：这些 gate「on」是 **restrict/block** pipeline 而非 unlock capability，blind `enforce` 会 wedge 全队 merge/ship，须 staged rollout（`audit_only` 先于 `enforce`）。还正确豁免了「founder 明确说 keep off」（如 ponytail/FLY-615）和「inapplicable」（如纯 backend 项目的 proofshot）。
- **claude-lead.sh 接线正确**：append block 在 `elif [ "$IS_COS_ROLE" = false ]` 分支（**仅 non-cos dept lead**，与 `auto-qa-pipeline.md` 同位），`-f && -r` file-exists 条件守卫，缺文件 no-op（向后兼容旧 flywheel checkout）。README.md 同步登记该 base 文件一行。

## [4] 全仓 build / biome / shellcheck — PASS

| 工具 | 命令 | 结果 |
|---|---|---|
| build | `pnpm -r build` | **exit 0** |
| biome | `pnpm lint`（`biome check`） | **exit 0**，1045 文件，13 个 warning **全是预存无关项**（`fleet-data.test.ts` suppressions/unused），**无 FLY-707 文件被标记**（唯一被 biome lint 的 FLY-707 文件 `fly707-enablement.test.ts` 干净；config.yaml/md/sh 不归 biome） |
| shellcheck | `shellcheck claude-lead.sh` | **exit 0**，findings 全在 208/368/493/1193/1194 行（**预存**，FLY-707 新增块 1720-1739 之外）；新增块是纯 prose append，无 shell 复杂度 |

## Verdict

**PASS 4/4。** PR #400 pre-deploy 确定性全绿，ship-ready。post-deploy 真 auto-QA-live-fire 待 Tier-3 重启后随批次验证（chicken-egg，非本 QA scope）。
