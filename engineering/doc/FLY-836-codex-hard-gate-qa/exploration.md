# FLY-836 Codex 硬门真机验证 — 探索

Issue: FLY-836 (https://linear.app/geoforge3d/issue/FLY-836/qa-fly-827-codex-code-review-硬门真机验证529-room无-codex-pr-被拦-过-codex-pr)
日期: 2026-07-03
基于: 无

## 1. 背景

FLY-827 把「Codex code review」从"应该做但靠 runner 记得跑"的软约定，改成 Bridge 强制的硬门：任何 runner-controlled ship 的 PR，当前 head 没有一条匹配的 Codex APPROVED 记录，就 (a) auto-QA 起不来、(b) merge 被 `verify-approval` 拦、(c) founder 保持挂起 + Flywheel Alert 告警 + 重发 `/codex-code-review` 指令。默认 ON，`FLYWHEEL_CODEX_HARD_GATE=0` 是 live 双向 kill-switch。

触发动机（PR #433 body 引用）：PR #430 曾经在**没有任何 Codex 审过**的情况下滑过 auto-QA + merge —— 因为门是"软"的，runner 误以为 Bridge 会自动帮它跑。FLY-827 就是要把这个洞焊死。

Codex design review 已经过 5 轮（xhigh）APPROVED；单测(687/687)、byte-compat sentinel 都过了。但这是一个 **restart-gated + 全域生效**的强制门 —— 一旦部署到生产就立刻影响所有 runner 的 ship 路径。Lead（Tadashi）在 plan.md 里明确写了两条硬要求：

1. 独立 QA 在**真机**造新 PR 证明三件事：(a) 无 Codex 的 PR 被卡、(b) 有 Codex approved 的 PR 不误卡、(c) kill-switch 一开立即放行。
2. Pre-ship 必须在 **529 QA Room 真机**验证过，不能带着"只有单测"就直接 ship。

FLY-836 就是这个独立 QA 任务：**非实现者**（实现 runner = be7627b3）验证 PR #433（head `4ed47626`，Codex design 5 轮 + code 3 轮全 APPROVED，CI 绿）。

## 2. 目标（一句话）

在 529 QA Room 的隔离测试 Bridge 上，用真实的 PR #433 二进制（不是读实现者写的单测）证明硬门的 4 个行为：无-Codex PR 被拦、过-Codex PR 不误拦、head 变需要重过、kill-switch 放行 —— 外加 restart reconcile，产出 PASS/FAIL 结论交给 Tadashi 做 founder-gated ship 决策。

## 3. 范围边界

- **验证对象**：PR #433 的 Bridge + CLI 代码路径（`codex_review_record` 表、`isCodexGateSatisfied`、`isReviewHeld`、`verify-approval`、`await-codex-gate` / `codex-review-result`、kill-switch 直接切换）。
- **不做**：不重新审查 FLY-827 的设计是否合理（Codex 已经 5 轮批准）；不测 Codex code review 本身审得准不准（那是另一个问题域，本 issue 测的是"门"的强制执行逻辑，不是 review 内容质量）；不动生产 Bridge（:9876）。
- **场所**：529 QA Room 隔离测试 Bridge（slot 2 或 3，slot 1 被 roundtable 占用）。Ad-hoc 观察用 Claude-in-Chrome（非 Playwright，这是本项目 QA 的强制约定）。

## 4. 我的理解已经过 Lead 确认

已经用 `flywheel-comm gate brainstorm` 把上面的理解 + 验证方案 + 一个安全风险发现（kill-switch 的持久化路径 `flagRouteDeps.envPath` 硬编码为共享的真实 `~/.flywheel/.env`，不是 slot 隔离）发给 Tadashi，他回复：「理解对、计划稳、批准开跑」，并要求把这个共享 `.env` 风险点写进最终报告作为一个 finding（可能需要 follow-up 让 flag path 也隔离）。
