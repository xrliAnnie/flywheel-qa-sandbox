# FLY-1255 厂商无关的标题与窗口模型显示 — QA 报告
Issue: FLY-1255 (https://linear.app/geoforge3d/issue/FLY-1255/fix-标题窗口模型名显示解除-anthropic-绑死-厂商无关渲染codexkimi-后端也要显示)
日期: 2026-07-14
基于: plan.md, exploration.md, research.md

## 结论

**PASS.** 三段流水线的 QA 阶段独立验证 PR #597（head `98de68deb`，实现阶段已开）。
display-only 改动完整、跨包组合正确、Claude 兼容边界守住、cmux 清理安全门守住。
全套单测/typecheck/lint/build 通过；对**已编译 dist 产物**跑的端到端行为链
（dispatch 描述符 → Discord thread marker → tmux window label → sanitize → 真
cmux managed-gate）100% 命中预期 founder 可见字符串。

## 验证范围与结果

### 1. 单元 / 集成测试（全绿）

| 套件 | 结果 | 关键覆盖 |
|---|---|---|
| `flywheel-config` | 411 passed | `model-display` 11 测：Claude F/O/S/H、Codex `GPT-5.6`、Kimi、vendor/model mismatch 不曲解、缺 vendor 时有界推导、opaque id 截断/sanitize、空 model 返回 undefined |
| `flywheel-core` | 209 passed | `tmux-naming` 50-char 链：`FLY-1255-implement-codex-GPT-5-6-…`、realistic Kimi、32-char cap 最坏边界 |
| `flywheel-edge-worker` | 1120 passed | `Blueprint` 把 `ctx.runnerName` 原样送入 `buildWindowLabel` |
| `flywheel-teamlead`（18 个 FLY-1255 相关文件，隔离运行） | 369 passed | `runner-model-display`（actual>plan>dispatch 优先级 + 双 kill-switch + 诚实 missing-backend）、`stage-status-emoji`（marker 语法 + injection `Model bad]value` 拒绝 + tri-state）、`ChatThreadCreator`（create/backfill 带前缀 marker）、`DirectEventSink`/`issue-display-refresher`/`auto-qa-effects`/`HeartbeatService`/`run-dispatcher`/`run-dispatcher-backend` |

### 2. 全套 `flywheel-teamlead`（负载甄别）

全套并行运行报 10 个文件失败，**无一为 FLY-1255 触碰的文件**。全部属实机资源类
（real-tmux / real-git / real-codex-config / bash-suite 在重并行 + runner 自身负载下超时）：
`close-runner`、`post-ship-finalization`、`post-merge`、`actions.terminate`、
`tmux-lookup.real-tmux`、`worktree-quarantine`、`codex-lead-runtime`、
`lead-rules-bundle`、`createLeadRuntime-preflight`、`fly247/fly574-bash-suites`。

甄别证据：`close-runner`（FLY-1255 只改了它的 2 行注释）**隔离运行 `--no-file-parallelism`
全 42 测通过**——证明全套失败来自真 tmux 服务器争用，不是逻辑回归。

### 3. Shell cmux 清理契约

`scripts/test-cmux-sync.sh`：**351 passed, 0 failed**。含 FLY-1255 新增：
managed-gate 认 `runner-codex-GPT-5-6`/`runner-kimi-kimi-for-coding`、orphan
`runner-codex-*` 可清理、direct vendor / `runnerX-*` / Lead / user tab 仍拒。

### 4. 门禁

- `flywheel-config` + `flywheel-teamlead` typecheck：exit 0
- `pnpm lint`：exit 0，0 error（15 warnings 全部预先存在，与 origin/main 逐字相同——
  如 `DirectEventSink.test.ts` 的 6 处 `biome-ignore` 计数/行号 origin/main 完全一致）
- `pnpm build`：exit 0

### 5. 端到端行为验证（对已编译 dist 产物，非 mock）

harness `qa-fly1255-e2e.mjs` 直接 import `flywheel-config`/`flywheel-teamlead`/
`flywheel-core` 的 **dist 产物**，模拟真实 dispatch，穿过实际导出函数链，断言 founder
可见字符串 —— **20/20 通过**。再把产出的 6 个真实 window 名喂给从
`flywheel-cmux-sync.sh` 提取的**真生产 `is_managed_runner_title`**：

| 场景 | thread marker | tmux window（50-cap 后） | cmux gate |
|---|---|---|---|
| Codex implement `gpt-5.6-sol` | `Model GPT-5.6` | `FLY-1255-implement-codex-GPT-5-6-Fix-a-deliberatel` | MANAGED |
| Codex design | `Model GPT-5.6` | `FLY-1255-design-codex-GPT-5-6-Fix-a-deliberately-l` | MANAGED |
| Kimi `kimi-for-coding`（非三段） | `Model kimi-for-coding` | `FLY-9-runner-kimi-kimi-for-coding-Fix-a-deliberate` | MANAGED |
| Claude Fable（非三段） | `F` | `LEARN-143-runner-claude-Fable-Fix-a-deliberately-l` | MANAGED |
| model-absent legacy | （无） | `FLY-1-claude-Fix-a-deliberately-long-founder-visib` | MANAGED |
| model-absent phase qa | （无） | `FLY-1-qa-Fix-a-deliberately-long-founder-visible-i` | MANAGED |

反向哨兵 `FLY-293-codex-foo` / `gemini` / `kimi-x` / `agy-x` / `runnerX-codex-x` /
Lead 窗 全部 NON-MANAGED（正确，direct vendor 不产生托管窗）。

## 需求对照

| 需求 | 证据 |
|---|---|
| 现有 Codex thread 收敛到 GPT-5.6 | aggregate refresher 重命名测试 + DirectEventSink fresh-create + dist E2E `Model GPT-5.6` |
| Codex window 标出 vendor/model | fresh+phase+retry 测试 + dist E2E `runner-codex-GPT-5-6`/`implement-codex-GPT-5-6`；50-char 保留 identity |
| Kimi 不被 Claude 逻辑吞 | renderer + dispatcher + dist E2E `runner-kimi-kimi-for-coding` |
| pending phase 真相 | resolver 默认 + 双 kill-switch 分支测试 + dist E2E |
| 缺 backend metadata 诚实 | `sessionModelDisplay(missing adapter + gpt)` → codex，绝不 `claude-*`（dist E2E 验） |
| Claude 兼容边界 | F/O/S/H marker 套件不变；model-absent 窗仍 `claude`/phase；model-present 窗有意加 tier |
| 无 runtime sniff / schema 变更 | diff 无 adapter CLI parsing、无 StateStore 迁移 |
| marker 安全 | namespace/injection/curated-title/clear/preserve 测试；`Model bad]value` 被拒 |
| cmux 清理仍安全 | shell gate 只认固定 `claude|runner|design|implement|qa`；direct vendor/user 哨兵拒；orphan close 回归过 |

## 边界与未做项（诚实记录）

- **真机 live-Discord E2E（重启生产 Bridge + 真派 Codex gpt-5.6 runner → 看 thread
  标题 `[Model GPT-5.6]` + tmux 窗 `codex-GPT-5-6`）未在本 QA 内做**：它需要重启生产
  Bridge（Tier-3、founder-gated、影响所有在跑 session），QA runner 不擅自执行。本改动
  display-only、无 schema/迁移，随下次自然 Bridge 重启生效。上面第 5 项对已编译 dist +
  真 shell gate 的端到端行为验证覆盖了跨包组合这一真实集成面。
- 15 个 biome warnings 与 origin/main 逐字相同，非本票引入，lint exit 0（不阻断 CI）。

## 判定

**PASS** — 交付项全部满足，display-only scope 未越界，跨包链在已编译产物上行为正确，
Claude 兼容与 cmux 安全门守住。
