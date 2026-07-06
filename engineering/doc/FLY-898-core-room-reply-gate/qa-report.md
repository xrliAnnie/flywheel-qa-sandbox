# FLY-898 Fleet-wide core-room 回复纪律 — QA 报告

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: `plan.md`（Codex design review R2 APPROVED），PR #466（本仓）+ plugin fork PR #13

## Verdict: PASS

## 验证范围

本 PR **held at founder ship-gate**（fleet-wide 行为改动 + 裸名→真@ 收紧，需 Annie 早上点头才真正
生效）。本轮 QA 验证的是**实现是否正确、是否与 plan.md 一致、测试是否全绿**——不涉及任何生产
mutation（未跑 `apply-core-room-mention-gate.sh` 的非 `--dry-run`/非 fixture 路径，未碰任何真实
`access.json` 或重启任何 Lead）。

## 验证方式

### 1. 实现 vs plan.md 逐节核对

逐一读了 `core-room-gate.ts`（§1 单一判定）、Codex 侧 `mention-gate.ts` + 两个 runtime
(`codex-lead-runtime.ts` / `codex-lead-tui-runtime.ts`) + `RestPollDiscordInboundSource.ts`
的 `referencedAuthorId` 富化（§2）、Claude 侧 `apply-core-room-mention-gate.sh` + `claude-lead.sh`
/ `codex-lead.sh` 接线（§3）、`cross-dept-channel-rules.md` 的 founder-facing 措辞（§4）、以及
**plugin fork（独立 repo，`~/.flywheel/repos/claude-plugins-official`，PR #13）** 的
`resolveGroupMentionPatterns` + 两处 `isMentioned` 调用点改造（§3.2）。逐节对照，实现与 plan 一致，
未发现偏差或顺手改动。

**三条 Codex R2 guardrail 逐条核实落地**：
- Guardrail #1（`coreChannelId` 必须真在 runtime 订阅集里才敢 on）— `resolveCoreStrictChannelIds`
  显式检查 `channelIds.includes(coreChannelId)`，`dryRunReport` 测试覆盖三态（on / 有 core 但未订阅→off
  / 无 flag→off）。
- Guardrail #2（preflight source-of-truth）— progress.md 记录了明确判定：ops-side
  `check-discord-plugin.sh` 不在 repo 里，FLY-898 preflight **自包含**在受测 helper 脚本内（grep 运行时
  `server.ts` 的显式 sentinel），不依赖修改未追踪的 ops 脚本。
- Guardrail #3（降级态≠完成）— helper 脚本区分 `mention-required-only` vs `id-only-core` 两态，
  T9/T9b 测试专门验证「插件半成品（声明了字段但没接入判定路径）也必须判定为不支持」——这正是
  Codex R2 MEDIUM 指出的、纯代码形状 grep 会漏判的场景；本仓 helper 与 plugin fork 都用**显式
  sentinel token**而非代码形状匹配，两侧一致。

### 2. 编译 + Lint

- `pnpm build`（全仓 16/16 包）：绿。
- `biome check`：FLY-898 触碰的全部文件（TS + 两个 shell 脚本）0 error。
- **CI 现状**：PR #466 的 GitHub Actions `Build & Test` 因 **Lint step 失败**而红，但失败文件是
  `doc/engineer/research/assets/FLY-581-cdmcp-verify.mjs`（`git diff main...HEAD` 对该文件为空、
  `git show main:<file>` 与当前分支逐字节相同）——**main 上早已存在的 lint 失败，与本 PR 无关**，
  且因 Lint 先失败，CI 的 `Test` step 被跳过（`conclusion: skipped`），所以 CI 本身对本 PR 的测试
  结果不具权威性，全部测试改为本地跑（见下）。

### 3. 本仓（flywheel）FLY-898 专属测试 — 全绿

修 `TMPDIR=/tmp`（见下方环境说明）后单独跑 FLY-898 涉及的 6 个测试文件：

```
✓ src/__tests__/core-room-gate.test.ts (10)
✓ src/__tests__/core-room-gate-cli.test.ts (6)
✓ src/lead-backends/codex/__tests__/mention-gate.test.ts (27)
✓ src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts (124)
✓ src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts (19)
✓ src/lead-backends/codex/__tests__/RestPollDiscordInboundSource.test.ts (15)
```
**201/201 pass。**

### 4. 本仓 bash helper 测试 — 全绿

`bash packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`：**12/12 pass**
（T1-T11 + T9b），含 `--all` fleet 模式（T11：patch geo/growth 的 gated claude lead，正确 skip
codex lead + CoS + joycon）。

### 5. plugin fork（独立 repo）测试 — 全绿

`~/.flywheel/repos/claude-plugins-official`，分支 `fix/FLY-898-core-room-mention-patterns`（PR #13,
base main）：
- `bun test mention-patterns.test.ts`：**6/6 pass**（含「空数组不回退全局」的关键语义）。
- `bun test`（整个 discord 插件全量套件）：**139/139 pass, 0 fail**——确认本次 fork 改动未回归任何
  既有插件行为（roundtable / reply-guard / typing-indicator 等）。

### 6. 本仓（flywheel）全量回归套件

`TMPDIR=/tmp pnpm vitest run`（全 367 个测试文件，5078 个用例）：**5074 pass / 4 fail**。逐一诊断
4 个失败，**均与 FLY-898 diff 无关**（这 3 个失败文件均不在 `git diff main...HEAD --stat` 里）：

- `src/__tests__/LeadAlertNotifier.test.ts`（1 例）——期望收到 mock token `Bot resolved-bot-token`，
  实际收到一个真实格式的 Discord bot token。根因**已用 `env -u SIMBA_BOT_TOKEN` 复测确认**：本机
  真实跑着生产 Flywheel 基建，shell 里 `SIMBA_BOT_TOKEN` 是真实值，测试的 `botTokenEnv` 解析路径
  优先读环境变量、盖过 fixture 里的字面量 mock token——本机环境串扰，与本 PR 无关。（FLY-889 的
  QA 报告记录过同一条已知环境噪声。）
- `src/__tests__/close-runner.test.ts`、`src/__tests__/post-ship-finalization.test.ts`（各 1-2 例）
  ——`Test timed out in 5000ms`。**单独重跑这两个文件（不在 367 文件全量并发跑的资源争抢下）
  100% pass**（`close-runner.test.ts` 34/34，`post-ship-finalization.test.ts` 19/19），证实是全量
  并发跑时的 CPU 抢占计时抖动，不是确定性回归。

诊断纪律（同已有 QA 判定规范）：(1) 确认这 3 个文件完全不在本 PR diff 里——确认；(2) 单独重跑本 PR
新增/改动的测试文件拿到权威结果——见上方第 3/4/5 节，全绿；(3) 单独重跑失败文件排除资源竞争——2/3
文件重跑即通过，剩下 1 个是已知本机 token 串扰并复现验证。三条均满足，不计入本次 verdict。

### 7. 端到端行为核验（只读，零 mutation）

用编译后的 `dist/core-room-gate-cli.js` 跑了两类只读 smoke：
- **合成 fixture**（geoforge3d 多-lead-CoS / joycon-typeless core-无-CoS / personal-assistant 无 core）：
  `--all`、`--lead-id/--project` 单查、未知 lead（exit 3）均按预期输出。
  - product-lead/ops-lead → `gateNonCoS:true`；cos-lead → `false`；joycon-lead → `false`
    （`projectHasCoS:false`，fail-open 保持现状）。
- **真实生产 `~/.flywheel/projects.json`**（只读 `--all`，**未做任何写入/patch/重启**）：输出与
  `research.md` §2.1 描述的 fleet 快照完全吻合——geoforge3d(product/ops)、growth(rafiki/reflection)、
  flywheel(eng/product/codex-infra-bot/anna-interviewer)、tidal-echo(content-lead) 被正确判定为
  gated；sub / joycon-typeless / personal-assistant 不在列表（单 lead / core-无-CoS / 无 core，
  fail-open 符合预期）。`codex-infra-bot-lead` 的 `backend` 字段正确标注为 `codex-app-server`（fleet
  apply 脚本会据此跳过它，走 runtime env 而非 access.json）。

## 发现（非阻塞，供参考）

**`codex-lead-tui-runtime.ts` 的 FLY-898 接线缺少专属单测**（plan §2.4 / progress.md chunk 5 原本
计划要有）。核实后判定不影响 verdict：
- 被复用的两个决定性函数——`resolveCoreStrictChannelIds`（headless/TUI 共用）与
  `buildMentionGate({ coreStrictChannelIds })`——本身已被 `codex-lead-runtime.test.ts` (7 个专属用例)
  + `mention-gate.test.ts` (9 个专属用例) 充分覆盖。
- TUI 侧的接线代码（`git diff` 7 行）与 headless 侧逐行结构一致（同样调用
  `resolveCoreStrictChannelIds(config)` → 传入 `buildMentionGate`），純粹是胶水代码。
- 这与 `codex-lead-tui-runtime.test.ts` 现有的测试边界一致——该文件本就不对 `buildTuiGeneration`
  内部任何 `shouldHandle` 拼装逻辑做单测（包括早于本 PR 就存在的 cross-dept 拼装），只测试可独立
  调用的 helper 函数。补一个 TUI 专属集成测试需要改变该内部函数的可测试性边界（导出/重构），
  超出 QA 补测的合理范围，故未新增——留给未来若要重构 `buildTuiGeneration` 可测试性时一并考虑。

## 结论

FLY-898 的实现与已批准的 `plan.md`（含 R2 三条 guardrail）逐节一致，Claude 侧（access.json helper +
两个 launcher 接线）与 Codex 侧（两个 runtime + mention-gate + RestPoll 富化）与**独立 plugin fork
repo**（per-group mentionPatterns，PR #13）三处改动均验证正确、幂等、fail-safe。本仓 FLY-898 专属
201 个 vitest + 12 个 bash 用例、plugin fork 139 个 bun 用例（含 6 个专属）**全绿**；全仓 5078 个用例
仅 4 个失败，且逐一复测确认均为本机环境噪声（TMPDIR overlap / 真实 token 串扰 / 全量并发计时抖动），
与 FLY-898 diff 完全无关。只读 smoke 对真实生产 `projects.json` 的门控判定与 research.md 的 fleet
快照完全吻合。

裸名→真@ 的行为收紧已在 `ux-brief.md` 向 Annie 明确说明，PR 正确 hold 在 founder ship-gate 未自动上线。

**PASS — 建议进入 approve/ship 流程（founder 点头后）。**
