# QA · FLY-670 — ponytail full-live E2E (PASS)

**Issue**: FLY-670 (QA · FLY-615 E2E — full live ponytail 插件真加载)
**Gates**: FLY-615 (PR #381 — ponytail per-issue/per-run A/B) ship-readiness
**Date**: 2026-06-29
**Verdict**: **PASS** — 615 ship-ready (进 663/614/615 批次)

## 这次补的 gap

QA·666 (FLY-666) 验了 FLY-615 的「真 dispatch 链路 + argv flag + condition 落库」，但隔离 `CLAUDE_CONFIG_DIR` **没登录态** → live claude **auth-exit**，没跑到「claude 真带插件真加载并回消息」那步。FLY-670 = 用**有登录态**的隔离 claude，把整条 **dispatch → runner → 插件真加载** 活链路跑通，并给出 on/off **真行为差**铁证。全程 529 Room、隔离、不碰生产 Bridge / 生产 `~/.claude`。

## 机制(已审计 PR #381 + 上游 ponytail v4.8.4)

- **开关** = `TmuxAdapter` 给 runner 的 claude 加 `--settings '{"enabledPlugins":{"ponytail@ponytail":true}}'`，gated on `ctx.enablePonytail`（源自 `Blueprint` 解析的 `ponytail_condition.startsWith("on:")`）。
- **三层灰度梯子**（`packages/config/src/ponytail.ts`）：per-run flag > per-issue Linear 标签 > per-project config > 默认 off。本 QA 走 **per-issue 标签**（AC#2 字面要求、615 生产 A/B 主入口）。
- **插件真加载铁证** = 上游 `hooks/ponytail-activate.js`（SessionStart hook）写 `$CLAUDE_CONFIG_DIR/.ponytail-active`（off mode 不写）+ 把 YAGNI ruleset 经 SessionStart `hook_success` 喂进 claude 上下文。
- **readiness** = Bridge 进程跑 `claude plugin details ponytail@ponytail`（用 Bridge 继承的 `CLAUDE_CONFIG_DIR`）→ 必须指向装了 ponytail 的 dir。

## Phase 0 — 隔离登录态 CLAUDE_CONFIG_DIR (闭 QA·666 auth-exit gap)

复用 FLY-572 配方建的 `iso-claude2`（rsync 生产 `~/.claude` 全结构 770MB + 复制 onboarding 态 + **Keychain 凭据 relocate 到 `$ISO/.credentials.json`**）。本 session **刷新了过期凭据**（iso2 token 已过期+Keychain 已轮换 → 从当前 Keychain 重导）。
- 验证：interactive claude in iso2 → "Welcome back Annie!" + **Claude Max** + 真账号、推理可用。
- ponytail 装进 iso2（globally-disabled）。

## Phase 1 — 插件真加载 + 真行为差 (本 session 新鲜证据，interactive tmux = 生产 runner 路径)

| 证据 | ON (claude --settings 开 ponytail) | OFF (无 flag，全局 disabled) |
|---|---|---|
| argv `--settings` | present | absent |
| SessionStart hook | **fired** (`hook_success`, exit 0, 207ms) | NO |
| marker `$ISO/.ponytail-active` | **"full"** | ABSENT |
| ruleset 入 transcript | 完整 YAGNI ruleset (`PONYTAIL MODE ACTIVE — level: full ... You are a lazy senior developer ... ## The ladder`) | 无 |
| **模型行为**（同一编码任务："N most common words"） | ponytail **签名格式**：stdlib `Counter.most_common`、code-first、`→ skipped: stopword/unicode … — add when you actually hit them`（逐字对应 ruleset `Pattern: [code] → skipped: [X], add when [Y]`） | 普通解释式："returns a list of (word, count) tuples … Drop .lower() if you want case-sensitive …"，无 skipped/add-when 模式 |

> **Note（诚实边界）**：直接问模型「你在 ponytail mode 吗 / 引用你的隐藏指令」答 `NONE`（模型对"复述注入指令"谨慎）。但**行为编码 A/B** 证明 ruleset 真到达且真改变模型行为——这正是 615 的产品目标（claude 写更精简的码），比 self-report 更可信。

## Phase 2 — 整条活链路 (真 Bridge dispatch，529 slot 1，PR #381 dist)

PR #381 dist 重建 → slot 1 Bridge（`CLAUDE_CONFIG_DIR=iso2` 过 readiness）→ 预建 `runner-test-slot-1` tmux session 注入 `CLAUDE_CONFIG_DIR=iso2`（`ensureSession` 幂等→复用）→ 按 **Linear 标签** A/B：

| 证据 | ON arm — FLY-688 (label `ponytail`) | OFF arm — FLY-689 (label `ponytail-off`) |
|---|---|---|
| `/api/runs/start` | success, exec `5b29d942` | success, exec `aec7ef86` |
| runner spawned | `runner-test-slot-1:@206` | `runner-test-slot-1:@212` |
| claude argv `--settings {"enabledPlugins":{"ponytail@ponytail":true}}` | **PRESENT** | **ABSENT** (真 flag count=0;"WITHOUT --settings" 只是 issue 描述文本) |
| runner `CLAUDE_CONFIG_DIR` | iso2 (隔离登录态贯穿全链路) | iso2 |
| marker `.ponytail-active` | **"full"** (runner 的 SessionStart hook 真触发) | **ABSENT** (无 hook、无加载) |
| DB `sessions.ponytail_condition` | **`on:label`** | **`off:label`** |

→ 真 Linear 标签 → condition → spawn flag → 插件真加载，整条 dispatch→runner→plugin 活链路通；on/off 经真入口干净分化。

## 隔离 / 清理

- **不碰生产**：全程 `CLAUDE_CONFIG_DIR=iso2`（生产 `~/.claude` 无 `.ponytail-active`）；手动起的 slot-1 Bridge 用独立 port 19871 + 独立 DB，生产 bridge（port 9876 树）全程未碰。
- **teardown**：runner session killed、test bridge killed（port 19871 freed）、transient issue FLY-688/FLY-689 **Canceled**、slot dir 在 `/tmp`（ephemeral）。
- `ponytail` / `ponytail-off` label 留存（= 615 生产 A/B 入口；现仅贴在已取消的 QA issue 上）。

## 部署侧观察(非 615 问题，记给运维)

- `scripts/test-deploy.sh` 的 **Lead-ready 门控硬编码 120s**，cold Lead 启动慢（已知 8min 级）→ 超时即报错并 teardown，导致 **Bridge 根本没启动**。本 QA 改为用 test-deploy 备好的 artifacts **手动起 slot Bridge**（跳过 Lead，QA 不需要 Lead）。建议：给 Lead-ready 超时一个 env 旋钮，或加 `--no-lead` 仅起 Bridge 的模式（利于这类 runner-only QA）。
