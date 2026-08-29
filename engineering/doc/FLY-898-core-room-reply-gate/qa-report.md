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

### 8. 真机 Discord E2E（529 QA Room，Annie 补要求，2026-07-06）

第一轮 QA（第 1-7 节）验证了实现正确性但未跑真 Discord 消息往返。Annie 指令要求补跑；本节用真实
Discord 消息 + 真实运行中的 Claude Code Lead 会话验证，**只测不改实现**。

**拓扑搭建**（无生产 mutation，全部在 `/tmp/flywheel-test-slot-{1,2}` + 独立 `~/.flywheel/pids`/
`~/.flywheel/comm/test-slot-*`）：用 `scripts/test-deploy.sh 1` / `2`（`--mode slot`，本仓 checkout
= PR #466 + 已编译 dist）起两个真实 Claude Code Lead：
- **slot1 = CoS**（`flywheel-test-1`，channel `#cos-test`=`1493080991290626079`，`chatChannel==
  generalChannel`，镜像生产 Simba）。
- **slot2 = 非-CoS**（`flywheel-test-2`，自己的 channel `#product-lead-test`=
  `1493080993173737583`，镜像生产 Peter）。

`test-deploy.sh` 默认每个 slot 只生成单-lead roster（无法体现「同项目多 lead」），故为让 slot2 的
FLY-898 launcher 逻辑算出真实 `gateNonCoS=true`，**手动 kill 掉 test-deploy 自动起的 slot2 Lead 进程**，
用与 test-deploy 完全相同的 env（`DISCORD_BOT_TOKEN`/`DISCORD_STATE_DIR`/`BRIDGE_URL` 等，逐一核对
test-deploy.sh 源码抄出）+ **一份手写的两-lead `FLYWHEEL_PROJECTS`**（`generalChannel=#cos-test`，
`leads:[flywheel-test-1(chatChannel=core), flywheel-test-2(chatChannel=own)]`）重新 `bash
claude-lead.sh` 拉起 slot2——这就是**真实的、未经改动的 FLY-898 launcher 代码**（`packages/teamlead/
scripts/claude-lead.sh` 的 FLY-898 patch 段 + `core-room-gate-cli.js`），只是喂给它一份反映「同项目
真有 CoS」的 roster（对应 test-deploy.sh harness 本身缺一个「多 lead 单项目」拓扑生成能力的已知局限，
非 FLY-898 缺陷）。

**实测证据 1 —— launcher 真实执行、access.json 真实被改**（`/tmp/flywheel-test-slot-2/
lead-fly898.log`）：
```
[lead] 09:00:40 FLY-898: applying core-room mention gate for flywheel-test-2 (core 1493080991290626079)
[core-room-gate] WARNING: --id-only requested but runtime plugin lacks per-group mentionPatterns support
[core-room-gate]          (~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts)
[core-room-gate]          — applying requireMention:true ONLY (bare-name still passes).
[core-room-gate] group '1493080991290626079' → requireMention:true (mention-required-only) in access.json (backup: ...)
```
`access.json` 改前 `{"1493080991290626079":{"requireMention":false}}` → 改后
`{"1493080991290626079":{"requireMention":true}}` + 备份文件——**真实文件、真实 diff**，不是模拟。
这一条本身就与 guardrail #2/#3 的设计意图吻合：当前**生产共享 marketplace 插件**尚未同步 fork
（`server.ts` 900 行，无 `resolveGroupMentionPatterns`），preflight 正确拒绝写 `mentionPatterns:[]`，
只给「mention-required-only」部分收益 + loud warn——这正是 plan §3.3 rollout 顺序里描述的、fork 同步
之前的预期中间态。

**实测证据 2 —— 3 个场景真消息往返**（core room = `#cos-test`，用 `TEST_BOT_TOKEN_1`/`TEST_BOT_TOKEN_2`
真实 REST 发消息，slot1↔slot2 互相加进对方 `allowBots`）：

| # | 场景 | 发的消息（真实 Discord message id） | slot2（非-CoS）结果 |
|---|---|---|---|
| ① | 无-@ 泛消息 | `1523723534919274547`「status check, anything blocking today?」 | **从未被注入 slot2 会话**——横跨后续 ~10 分钟 + 场景②③两条消息先后送达并被处理，scenario①的内容自始至终没有在 slot2 的 transcript 里出现过一次。**零注入零回，符合预期。** |
| ③ | 真 `<@id>` | `1523723235856875761`「`<@1493072948683341976>` FLY-898 QA scenario 3」 | **注入 + 回复**（回复 msg id `1523724826928218192`）。slot2 自己读取 access.json 确认「`1493080991290626079: requireMention:true`」+ 真 @ 命中 → 判定 PASS。 |
| ② | 裸名 `TestLeadTwo`（access.json `mentionPatterns:["\\bTestLeadTwo\\b"]`，我手动加的、模拟生产真实存在的名字正则） | `1523724916866814002`「hey TestLeadTwo can you take a look」 | **注入 + 回复**（回复 msg id `1523725048828006400`）。slot2 自己引用 `lead-fly898.log` 的原话「applying requireMention:true ONLY (bare-name still passes)」解释「裸名匹配了全局 mentionPatterns，所以在当前未同步 fork 的状态下这条消息合规地穿过了 delivery gate」——**这正是 guardrail #3 文档过的「mention-required-only」中间态该有的行为，不是 bug**：id-only（mentionPatterns:[]）要等 fork 同步后才会把这条也拦下。 |

对照关系清楚：①（无-@）零注入 vs ②③（有真-@ 或裸名匹配）注入+回复，同一个 slot2 会话、同一个
channel，行为差异只由消息内容决定——直接证明 `requireMention:true` 这道 gate 真的在拦截，而非
碰巧沉默。

**CoS 无条件监听（slot1）**：额外用一条无-@ 消息（诊断 ping，slot2 发到 core room）验证 slot1
（CoS）**无条件收到并以 default-handler 身份回复**（`access.json` 里 `requireMention:false` 从未被
FLY-898 触碰，byte-compat）；随后 slot1 又收到 slot2 对场景②③的回复，但**正确保持沉默**（peer-bot
终态自述，非请求，避免 bot-to-bot 回声循环）——这是模型自己的应用层判断，不是 FLY-898 gate 的一部分，
仅作为「消息确实双向可达」的旁证。

**回归项**（roundtable 名字寻址不受影响 / joycon 型 core-无-CoS fail-open）：**未在本轮额外起第三套
真机拓扑复测**——这两项已在 §3-5 用真实代码路径 + 真实 discord.js 形状的 fixture 覆盖（plugin fork
139/139 全量 bun 套件零回归，含显式「roundtable 裸名仍触发」用例；`core-room-gate.test.ts`/
`core-room-gate-cli.test.ts` 显式覆盖 joycon 型 core-无-CoS→`gateNonCoS:false`），且这两条都是**不受
FLY-898 改动触碰的路径**（roundtable 走独立 `sharedChannelIds`，joycon 走同一 `resolveCoreRoomGate`
纯函数,已直接测过其 fail-open 分支）,判断无需额外真机复测。

**清理**：跑完后 `test-teardown.sh` 收回两个 slot（Lead 进程、Bridge、CommDB、tmux 窗口全部清理），
未留任何常驻进程；`~/.claude/*` 全程未碰。

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

**补充（第二轮，Annie 要求）：真机 Discord E2E 已跑完**（§8）——529 Room 起两个真实 Claude Code Lead
（CoS + 非-CoS），真实 launcher 代码把非-CoS lead 的 core group 从 `requireMention:false` 真实改成
`true`（真实 access.json diff + 真实 warning log），随后 3 个场景用真实 Discord 消息验证：无-@ 消息
零注入 slot2（① 真实静默,横跨多分钟+后续消息佐证不是延迟）、真 `<@id>` 注入+回复（③ PASS）、裸名
在「未同步 fork」的当前中间态下仍注入+回复（② PASS，符合 guardrail #3 文档过的 mention-required-only
预期行为,非 bug）。CoS 无条件监听 + 正确的 peer-bot 静默旁证也一并验证。回归项（roundtable/joycon）
判断已被 §3-5 的真实代码路径测试充分覆盖,未见需要额外真机复测的理由。跑完已 `test-teardown.sh`
清理两个 slot,生产环境（`~/.claude/*`、真实 leads）全程零接触。

裸名→真@ 的行为收紧已在 `ux-brief.md` 向 Annie 明确说明，PR 正确 hold 在 founder ship-gate 未自动上线。

**PASS — 建议进入 approve/ship 流程（founder 点头后）。**
