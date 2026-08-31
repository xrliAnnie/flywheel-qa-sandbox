# FLY-2131 Raya 大脑:summary 吸收 + 追问 + 可见汇报 — 调研
Issue: FLY-2131 (https://linear.app/geoforge3d/issue/FLY-2131/rayav2-m2-大脑summary-吸收-追问-可见汇报承接-fly-2030-m1)
日期: 2026-08-28
基于: exploration.md

> 全部为 2026-08-28 本机实核(flywheel main @ 6d5f0cbff;raya origin/main @ b7abff4)。每条给复核命令;会过期的结论集中在 §5。

## 1. FLY-2030 plan §3 基座接缝复核(承接前的过期检查)

| 结论 | 实核 | 复核命令 |
|---|---|---|
| `buildThreadParams` 仍只钉 approvalPolicy/sandbox/cwd/baseInstructions,**无 model/effort/window 口子** ⇒ M2-a 设计原样适用 | codex-lead-runtime.ts:990-1012 逐行读过 | `rg -n "buildThreadParams" packages/teamlead/src/lead-backends/codex/` |
| TUI 与 headless 共用同一 `buildThreadParams`(tui:522 → runtime:989),resume 重钉 params(FLY-224)⇒ 一处改两形态生效 | FLY-2030 plan §1 实核结论,路径未变 | 同上 |
| GatePoller rider 形态健在(60s cadence 上多个 rider:FLY-1687/1944/1781 等)⇒ M2-b 巡视复用 rider,不建新 timer | gate-poller.ts:138/140/226/230/250 | `rg -n "rider" packages/teamlead/src/bridge/gate-poller.ts` |
| `lead_events` durable 队列 + `RuntimeRegistry.enqueueLeadEvent` 健在 ⇒ M2-b 投递通路原样 | lead-event-queue.ts / runtime-registry.ts 存在且被 bridge/plugin.ts 消费 | `rg -ln "enqueueLeadEvent" packages/teamlead/src/` |
| full-access Codex Lead 有 proactive `discord_send` MCP 入口(FLY-304)⇒ 可见汇报的发声通路是既有件 | codex-lead-runtime.ts:177/741;discord-send-core.ts | `rg -n "discord_send" packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` |
| roundtable 通道配置链健在(`FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 等进 Codex Lead env)⇒ 追问通路是既有件 | codex-lead-runtime.ts:628-655 | 同文件 grep ROUNDTABLE |
| 生产 Lead 部署硬规 = TUI 窗口形态(FLY-398),Mufasa TUI launcher 是先例 | packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh 存在 | `ls packages/teamlead/scripts/` |
| `flag_values` 表 + project scope 列已 merge(FLY-2100,PR #971)⇒ 巡视间隔 flag 的载体就绪 | git log 0ffbeefaa | `git log --oneline \| head` |

## 2. M1 交付面(本单要骑/要补的码)

### 2.1 `flywheel-comm summary` 命令族(packages/flywheel-comm)

- `summary`:校验 + 投递 Lead 亲笔 summary(幂等 key {project, author, period});`summary verify-pr`:对 PR **当前 head** 只读核验,输出 `verifiedHeadSha`(index.ts:114-115、commands/summary.ts、summary-pr-verifier.ts)。
- verifier 合同(summary-pr-verifier.ts):readPullRequest→headSha、listPullRequestFiles、readTreeModes(拒 100755)、readFileAtRef;返回 `{ok:true, verifiedHeadSha, fileCount}`。**merge 动作本身不在任何命令里**——M1 只把 `gh pr merge --match-head-commit <verified-sha>` 写在身份稿(raya-identity-draft.md「merge only with…」),是 prompt 层纪律。⇒ 安全栓①的缺口精确在此:verify 与 merge 之间无机械绑定。
- `summary-registry migrate|verify-activation`(commands/summary-registry.ts):migrate 要求 `FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1`(只能经 `scripts/migrate-summary-registry.sh` 持锁跑);verify-activation 输出 `{ok, granularity, summaryAssignmentDigest}`。

### 2.2 安全栓②病灶(scripts/restart-services.sh:176-190)

```bash
summary_registry_activation_preflight() {
    local source_cli="${FLYWHEEL_DIR}/packages/flywheel-comm/src/bin/summary-registry.ts"
    ...
    [[ -f "$source_cli" ]] || return 0     # ← 字面 fail-open:源缺失 ⇒ 栅栏整体放行
    ...
    pnpm --dir "$FLYWHEEL_DIR" exec tsx "$source_cli" verify-activation ...
}
```

调用点 restart-services.sh:1501,位于 `preflight_pull_latest_main` 之后、`default_lead_agent_env_converge` 等一切 mutation 之前(shell 测试 fly2030-summary-registry-activation.test.sh 断言了这个顺序)。`|| return 0` 的历史理由是 M1 merge 前 main 上还没有该文件;M1 已 merge(main 含 `packages/flywheel-comm/src/bin/summary-registry.ts`),兼容窗口已关闭,改 fail-closed 无部署风险。现有 shell 测试**没有**「源缺失」负测格。

### 2.3 flaky 根因(packages/flywheel-comm/src/__tests__/summary-registry-cli.test.ts)

- 用例 2「migrates and verifies under the shared lock receipt」未注入 `validateTeamleadCandidate` ⇒ 落进 `defaultTeamleadValidator` ⇒ `spawnSync("pnpm", ["--dir",…,"exec","tsx", validate-projects.ts, candidate])` 真子进程。冷 tsx 编译在负载高的机器可超 vitest 默认 5s ⇒ flaky timeout。
- default validator 有第二分支:env `FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR` 配置时改为 `spawnSync(process.execPath, [validator, candidatePath])`(commands/summary-registry.ts:27-47)——一个指向轻量 node 脚本的注入点,可以**不经 pnpm/tsx** 覆盖「真 spawn」分支。
- 真 pnpm 调用的 argv 形状已有 shell 层覆盖:fly2030-summary-registry-activation.test.sh 用 fake pnpm 断言了完整 argv。

## 3. Raya 侧现状(xrliAnnie/raya @ origin/main b7abff4;本地 clone ~/.flywheel/raya/code)

| 事实 | 实核 | 影响 |
|---|---|---|
| PR #4(FLY-2030 summaries/ 合同)**仍 open**;#3(FLY-2097 voice UX)仍 open;#5(FLY-2032 meeting)仍 open | `gh pr list --state all` | 本单 raya 侧改动(身份 M2 段、开场指令文件)**基于 #4 merge 后的 main**;排期上是前置依赖,不是本单义务 |
| origin/main 尚无 `summaries/`、无 IDENTITY M1 段 | `git ls-tree origin/main` | 同上 |
| `apps/voice/src/cli.ts:56-60`:`startInstructions(config)` = `config.realtime.startInstructionsFile ? readFileSync(...) : 硬编码一行` | `git grep -n startInstructions origin/main -- apps/voice/src/` | 义务 5 的接缝:交一个仓内 instructions 文件 + operator 在 `RAYA_ENV_FILE`(raya.env)配 `startInstructionsFile` 指向它;代码零改动(机制已在) |
| config.ts:307-311 校验 `startInstructionsFile` 类型;总长 8,192 上限、超限拒起(FLY-2097 qa-report 实测) | `git grep -n startInstructionsFile origin/main -- apps/voice/src/config.ts` | 内容预算:本单 ≤ ~6,000 字符,给 2097 追加的退出协议留量 |
| FLY-2097 的退出协议设计 = 在代码里把固定段**追加**到本单内容之后(2097 plan §0.2:「开场指令的内容归 2030/2131」) | FLY-2097 plan.md:25 | 冲突面为零;两单各自独立可 merge |
| 生产语音旧通道的「Xiaorong」称呼来自 Codex 账号个性化,非 Raya 认识 founder;换 prompt 通道后 2/2 自称 Raya、2/2 叫不出名字 | FLY-2097 qa-report §D A/B 实测 | 义务 5 验收两格的基线与病灶 |
| Raya 不在 `~/.flywheel/projects.json`(6 项目 13 Lead,无 raya 行) | python 解析实读 | merge authority 未激活 ⇒ 栓①「激活前到位」的窗口还开着;M2-d 注册是吸收的前置件 |
| raya 仓记忆合同:`RAYA_IDENTITY_FILE` 必须在 writable roots 之外(constitution 不可自改);`RAYA_MEMORY_FILE` **刻意可写**(独立版本化 raya-memory) | FLY-2074 plan §0.3 F4′ | 吸收的「工作记忆层」落 raya-memory 是既有合同的正用,非新机制 |

## 4. 窄口径豁免与 merge 权威(义务 4① 的权威文本)

- 豁免终稿(founder-only-authority-exemption-proposal.md,Tadashi 逐字审过):Raya 仅对 `xrliAnnie/raya` + `xrliAnnie/raya-memory` 两仓、满足两条机器可核条件(全部改动在 `summaries/` 下 ∧ 无可执行/影响构建运行的文件)的 PR,merge = 已阅回执。随 M1 flywheel PR 已落进 `founder-only-authority.md`。
- 身份稿已写「Run the read-only summary verifier against the PR's CURRENT head right before merging, and merge only with `gh pr merge --match-head-commit <verified-sha>`」——但这是文本,不是机器。QA 升级项①要求的是:**激活她的 merge 权威之前**,存在一条机械通路,使「无 `--match-head-commit` 的 summary merge」被拒绝。机械可达的最强形态 = verify 与 merge 收进同一条命令、命令内不存在不带栓的路径(见 plan);对「蓄意绕过红线敲裸 gh」的残余风险如实划界。

## 5. 会过期的结论

| 结论 | as-of | 复核 |
|---|---|---|
| buildThreadParams 无 model/effort/window | 2026-08-28 main 6d5f0cbff | `rg -n "buildThreadParams" packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` |
| restart-services.sh:181 `[[ -f "$source_cli" ]] \|\| return 0` fail-open | 同上 | `sed -n '176,190p' scripts/restart-services.sh` |
| summary-registry-cli.test.ts 用例 2 走真 spawnSync(pnpm exec tsx) | 同上 | 读该文件 93-129 行 + commands/summary-registry.ts:25-53 |
| raya PR #4/#3/#5 仍 open;origin/main 无 summaries/ | 2026-08-28 23:50Z | `gh pr list --state all`(raya 仓) |
| 生产 raya.env 无 startInstructionsFile 配置 | 2026-08-28(FLY-2097 QA) | operator 读 RAYA_ENV_FILE(不入仓,不可 grep;向持有 operator 权限者确认) |
| Raya 不在 projects.json | 2026-08-28 | `python3 -c "…"` 解析 `~/.flywheel/projects.json` |
| flag_values + project scope 列已在 main | 2026-08-28(FLY-2100 #971) | `git log --oneline --grep 2100` |

## 6. R1 评审后增补实核(2026-08-29 00:15Z;Codex R1 主张逐条本机复核)

| 结论 | 实核 | 复核命令 |
|---|---|---|
| TUI full-access = **单一** `fullAccessProjectRoot`,`writable_roots` 被精确断言为恰等 `[validated root]` | lead-actions/mcp-config.ts:84-91;codex-lead-tui-runtime.ts:944-957 | `rg -n "writable_roots" packages/teamlead/src/` |
| full-access root **不得**与 `~/.flywheel`/state/CODEX_HOME 重叠 ⇒ 现状 `~/.flywheel/raya/*` 无合法 root | codex-lead-runtime.ts:487 | `sed -n '480,490p' …codex-lead-runtime.ts` |
| Lead persona 装载走显式 `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES`(不自动发现文件)⇒ MEMORY.md 需点名接入 | codex-lead-tui-runtime.ts:385-401 附近 | `rg -n "FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES" packages/teamlead/src/` |
| **粒度已拍**:`~/.flywheel/summary-config.json` = per-lead,setBy founder(Discord msg 1543035397066588170),setAt 2026-08-28T23:58:13Z | 实读该文件 | `cat ~/.flywheel/summary-config.json` |
| **迁移已跑**:receipt 在默认路径,postImageSha256 d942cec7a5e6…,live projects.json 16/16 行含 closed `summaryRole` | 实读 receipt + python 解析 | `cat ~/.flywheel/state/summary-registry/migration-receipt.json` |
| FLY-2029/2074 未定义 memory 仓运行期 commit/push 生命周期(只建仓 + 初始文件 + RAYA_MEMORY_FILE 可写合同) | FLY-2029 plan/verification 通读 | 该两文档 |

## 7. R2 评审后增补实核(2026-08-29 00:40Z)

| 结论 | 实核 | 复核命令 |
|---|---|---|
| **raya PR #4 与 FLY-2097 PR #3 均已 merge**:origin/main = fb354a2(founder 授权 msg 1543046861844250634,2026-08-28 16:57 PT);`summaries/` 已在 main;prompt 通道修复(4a67508「deliver exit contract through realtime prompt」)已在 main。**部署仍 pending**(2.6 验收前置改为「部署该构建」) | fetch + log 实读 | raya 仓 `git log --oneline origin/main -4` |
| brain `parseConfig` canonicalize 每个 `RAYA_WORKSPACE_ROOTS_JSON` 根、目录缺失拒起;live raya.env 的 roots = [code, memory] ⇒ memory checkout 迁移必须同步改该条目 | config.ts:139-145 + Codex R2 读了 live 非密配置 | raya 仓 `git grep -n RAYA_WORKSPACE_ROOTS_JSON origin/main -- apps/brain/src/config.ts` |
| `discord_send` MCP 只有 target/text,无读操作;gateway 丢弃她自己 bot 的 inbound(CodexDiscordGateway.ts:268);send audit 不留正文/roundId ⇒ 「读自己频道」不可作恢复判据 | Codex R2 读码,采信(与 discord-send-core.ts 形态一致) | `rg -n "target" packages/teamlead/src/lead-backends/codex/discord-send-core.ts` |
