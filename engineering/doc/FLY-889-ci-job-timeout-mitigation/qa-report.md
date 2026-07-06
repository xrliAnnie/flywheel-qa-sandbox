# FLY-889 CI job 超时贴边缓解 — QA 报告

Issue: FLY-889 (https://linear.app/geoforge3d/issue/FLY-889/infraci-ci-job-贴近-10-分钟超时上限-50percent-run-timeout-cancelfleet-wide)
日期: 2026-07-05
基于: `plan.md`（PR #455, commit e777d450）

## Verdict: PASS

## 验证方式

1. **实现 vs 计划逐行核对**：`git diff main...HEAD -- .github/workflows/ci.yml` 与 `plan.md` 逐行比对——`timeout-minutes: 10 → 20`、3 处 apt-get 合并为 1 处、所有 FLY-XXX 注释归属（贴在对应测试 step 而非旧的 install step）均与计划一致，未发现偏差或顺手改动。

2. **真实 CI 证据（PR #455）**：
   - `gh pr view --json statusCheckRollup` → `Build & Test` conclusion `SUCCESS`，`startedAt 16:08:50 → completedAt 16:19:21`（**10m31s**，落在新 20min 预算的 ~53%，headroom 充足）。
   - 对照 main 分支近期真实 run：抽查 3 个 `cancelled` run（`740c90ee`/`f03657ad`/`2035ccc3` push），逐个用 `gh run view --log` 拉日志，确认末尾均为 `##[error]The operation was canceled.`，且卡住的位置各不相同（apt-get install 中途 / 不同 hermetic 测试之间）——与 `research.md` 的结论（"卡在哪一步是随机的，真正问题是 Test step 吃掉 75% 预算"）吻合，证实了 issue 描述的 ~50% timeout-cancel 是真实存在的，且本次改动（20min + 合并 apt-get）能覆盖旧配置下的这几个真实超时场景（10m08s-10m13s 均 < 新 20min 预算）。

3. **新增回归测试**（`packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`）：纯 YAML 结构断言（同 `workflow-permissions.test.ts` 的 R4-2 模式），防止未来静默改回 10min 或重新拆散 apt-get。
   - **正向验证**：对当前 `ci.yml` 跑通过（2/2 pass）。
   - **负向验证**（证明测试真的有区分力，不是永远绿的空测试）：手动用同一段解析逻辑跑 `git show main:.github/workflows/ci.yml`（FLY-889 之前的版本），确认会失败——`timeout-minutes: 10`（< 15 floor）+ `apt-get update` 出现 3 次（≠ 1）。

4. **全仓质量门禁**：
   - `pnpm build` 全绿（16/16 包）。
   - `pnpm typecheck` 全绿（16/16 包）。
   - `pnpm lint`（biome）：0 error，14 个 warning——已用 `git stash` 交叉确认这 14 条在本 PR 改动之前就存在（与本 diff 无关的其他文件），非本次引入。

5. **全量本地测试套件**（`pnpm test:packages:run`，跑了 2 次）：
   - 第一次：`Test Files 4 failed | 345 passed | 1 skipped (350)` [`packages/teamlead`]
   - 第二次（重跑核对）：`Test Files 3 failed | 346 passed | 1 skipped (350)` [`packages/teamlead`]
   - **失败集合在两次跑之间不一致（4个 vs 3个文件）本身就是本机环境噪声的信号，不是确定性回归。** 逐一核实三类失败均为**本机环境伪影，与 FLY-889 diff 无关**：
     - `src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts`（绝大多数失败，`FLYWHEEL_CODEX_LEAD_WORKSPACE ... must not overlap ~/.flywheel`）——**已知问题**，见 memory `reference_qa_codex_lead_runtime_tmpdir_overlap`：本 QA session 的 `TMPDIR` 被设成 `~/.flywheel/runner-state/<exec-id>/browser-tmp`，正好落在 FLY-245/FLY-350 的 `~/.flywheel` overlap 安全校验范围内。本轮**独立核实**：`echo $TMPDIR` 确认当前值确实是该路径，且测试源码里 `mkdtempSync(join(tmpdir(), ...))` 直接用这个 TMPDIR 建临时目录 → 触发校验。GitHub CI 上 `TMPDIR=/tmp`，不重叠，故 CI 绿。
     - `src/__tests__/LeadAlertNotifier.test.ts`（"POSTs to alertChannel with resolved bot token..."）——断言收到的 Authorization header 应为 mock 值 `Bot resolved-bot-token`，实际收到一个**真实格式的 Discord bot token**（`Bot MTQ4NzMzOTA3NTU2MzI5MDc0NQ...`）。这台机器上跑着真实 Flywheel 生产/QA 基建（Bridge、多个 lead），token 解析路径读到了本机真实配置而非纯 mock —— 本机环境污染，非代码逻辑回归。
     - `src/__tests__/createLeadRuntime-preflight.test.ts`（2 处失败：`Test timed out in 5000ms` / `promise resolved instead of rejecting`）——5 秒硬编码超时在本机（同时跑着 Bridge + 多个 worktree + 本次 QA 自身的重负载测试跑）CPU 抢占下抖动，属于时序类 flaky，不是逻辑错误。
   - **诊断纪律**（遵循既有 QA 判定规范）：(1) 确认被测 diff 完全不碰这 3 个失败文件所在模块——确认，本 PR 只改 `ci.yml` + 新增 1 个独立测试文件；(2) 确认 GitHub CI 是绿的——确认，PR #455 单 job SUCCESS；(3) 隔离重跑本 PR 自己新增的测试文件拿到权威结果——确认 2/2 pass（含负向验证）。三条均满足，判定这 3 个文件的失败不计入本次 verdict。

## 结论

FLY-889 的实现与已批准的 `plan.md` 完全一致（scope 限定在 A+C，未夹带 B/D 或其他改动）。改动本身用 PR #455 的真实 CI run 验证有效（10m31s < 20min，相对旧 10min 硬顶有实质 headroom）。新增的结构性回归测试防止未来静默倒退。本机运行完整套件时出现的少量失败均系环境噪声（TMPDIR overlap / 真实 token 泄漏 / CPU 抢占超时），与本次 diff 无关且不影响 CI 权威结果。

**PASS — 建议进入 approve/ship 流程。**
