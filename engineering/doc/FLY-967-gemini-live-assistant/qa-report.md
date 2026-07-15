# FLY-967 会议模式 A(纯 Gemini Live 语音助理) — QA 报告
Issue: FLY-967 (https://linear.app/geoforge3d/issue/FLY-967)
日期: 2026-07-07
基于: plan.md / research.md / exploration.md + 本分支 P1–P8 实现 + PR #501

> QA 阶段 = 三段式(Design→Implement→QA)第三段,Opus,独立不自验。本报告核对
> 实现 vs plan §8 验收标准,跑测试、审代码、量可运行性。**结论:FAIL(打回 implement)**。

## 结论(TL;DR)

**FAIL** —— 两条:

- **B1(结构性阻塞,主因)**:`/gemini` **根本没接进运行的 daemon**。这个功能现在是
  「导出 + 单测过、但运行时永远进不来」的休眠库代码 —— **Annie 现在无法发起 /gemini**,
  所以 plan §8 的 **A3 / A5 / A8**(staged E2E、工具真答、**Annie 真开一轮**——本 issue 的
  北极星「各开一轮真会按体感定方向」)**一条都做不了**。P9(真机闭环 + E2E)整段没做,
  progress.md 从 P8 直接跳到「open PR」。
- **B2(founder-facing 缺陷)**:会后落进立项 issue 的纪要 comment 抬头**还写着**
  `## 会议纪要(/live 助理)`——rename commit(9a9fe476)声称「founder-facing strings now
  say gemini」,漏了这一处。Annie 每开完一轮会都会在 issue 里读到「/live」,与她敲的
  `/gemini` 自相矛盾。

代码本身(在 scope 内的那部分)质量高、测试厚、字节兼容——但**这个 PR 交付的不是一个
Annie 能用的功能**,不能 PASS 上 ship gate。

## 已验证 PASS 的部分(scope 内代码正确性)

| 项 | 结论 | 证据 |
|----|------|------|
| A1 单测全绿 | ✅ voice-bridge 118/118、voice-core 116/116、teamlead 落地路由 18/18 | `pnpm vitest run`(各包) |
| A1 typecheck / lint | ✅ tsc --noEmit 干净、`pnpm lint`(biome)干净 | 本地跑 exit 0 |
| A1 字节兼容 545 | ✅ voice-core 116 条既有测试零改动全绿;`systemPreamble` 不设=原行为、`speechConfig` 仅 `voice` 有值时发 voiceName | genaiConnector.ts diff + genai-config.test.ts |
| Codex R1 项目 scope 强化 | ✅ comment 出 scope→403、lookup 精确命中出 scope→miss 不泄漏、in-scope 通过、unknown project→404、无 KEY→501 | linear-comment-and-lookup.test.ts 18 例 |
| 安全卫生 | ✅ token 只进 header;每次 Linear 调用带 projectName;BriefingEngine + config docs[] 路径穿越启动即拒;失败路径全部显式回注不静默 | tools.ts / BriefingEngine.ts / config.ts |
| S-A1(Gemini 侧) | ✅ 首音 706–1275ms、简报事实召回 6/6、6 声线 voiceName 全接受、sendText 控制口可靠触发 | evidence/s-a1-gemini-side.md |
| 模块级实现质量 | ✅ BriefingEngine 零等待 compose + 原子缓存 + stale 标记;AssistantLanding 失败顺序 + receipt 幂等;AssistantSpeaker turn 闸 + flush;AssistantSession 状态机全径;tools 失败显式 | 逐文件审 + 单测 |

> 备注:全仓 `pnpm -r test:run` 有 1 条失败,但在 **`packages/flywheel-comm`**
> (`capture command … tmux window not available`,5s **超时**),该包 FLY-967 未触碰,
> **单独重跑即 PASS(372ms)** —— 机器高负载下的 flake,与本 PR 无关。

## FAIL 详情

### B1 — `/gemini` 未接进 daemon(A3/A5/A8 无法执行)

**事实(仓库全量核对)**:
- `packages/voice-bridge/src/cli.ts` 是 **545 PR-1 residency skeleton**:登录 bots + 让
  Note-taker 常驻 VC + `/health`。文件自己写明:「The /meet orchestration loop … lands in
  PR-2」;`GEMINI_API_KEY` 未设**只 warning**,因为「PR-1 residency does not open a Gemini
  session yet」。
- 仓库内**没有任何** slash-command 注册 / `interactionCreate` / `SlashCommandBuilder`——
  /meet 和 /gemini 都没有。
- `GeminiCommand` / `AssistantSession` / `BriefingEngine` / `resolveAssistantConfig` /
  `buildAssistantTools` 仅被 `index.ts`(导出)与各自单测引用,**没有任何运行时路径实例化
  它们**。`resolveAssistantConfig` 全仓零调用,`BriefingEngine.start()` 无人触发。
- `MeetCommand` / `HuddleSession` 在源码里**不存在**(只作注释引用)——即 545 PR-2 没落。

**这属于漏做,不是「可接受的延期」**:research §3 明确 A **依赖 545 PR-1**(含第 5 项
launchd/daemon,已落),**不依赖 545 PR-2**。plan §3 说 GeminiCommand「照 MeetCommand
形态,谁先落谁抽 commandKit」——MeetCommand 没落 = 967 是**先落**方,本就该由 967 建
daemon 侧的 slash-command 注册 + interaction 分发 + 用真依赖(真 VoicePresence via
BotRegistry / 真 ConversationSession via voice-core / 真 Linear client / 真 TIV)把
GeminiCommand→AssistantSession 串起来。plan §7 **P9**(staged E2E + 生产部署 + Annie 真用)
是计划内的最后一步,**整段没做**。

**后果**:Annie 现在敲 `/gemini` 没有任何东西响应。plan §8 的 A3(真机闭环)、A5(工具
真答)、**A8(Annie 真开一轮 = 本 issue 的验收北极星)**都**无法执行**——不是「QA 没条件
跑」,是**代码层面就没接通**。

**需要 implement 阶段做**(二选一,建议先跟 Tadashi 对 scope):
1. 把 /gemini 接进 daemon:在 `cli.ts`(或新的 wiring 文件)注册 slash 命令 + interaction
   分发 + 构造真依赖 + `BriefingEngine.start()`,让 GeminiCommand→AssistantSession 真跑;
   然后补 P9 staged E2E(529 Room 纪律,QA 真人当 founder,全流程 /gemini→聊→收尾→issue
   关闭链接可点)+ 出 evidence。**或**
2. 若团队/Annie 决定本 PR **有意作休眠库代码合入**(字节兼容、feature-off),需 Tadashi
   显式 re-scope #501,并**明确告诉 Annie A8(她真开一轮)是后续步骤**,不能以「done」呈现。
   —— 这是 scope 决定,不该由实现者或 QA 单方定;我已 `ask` Tadashi。

### B2 — 落地纪要抬头仍写 `/live`(founder-facing)

`AssistantLanding.buildSummary`(`AssistantLanding.ts:58`)硬编码
`## 会议纪要(/live 助理)`。这段会 POST 成立项 issue 的 comment,是 Annie 会后**必读**的
内容。rename 到 `/gemini` 漏了这处。

QA 已加回归测试 `packages/voice-bridge/src/__tests__/qa-fly967-naming.test.ts`(断言纪要
抬头**不含** `/live`、**含** `/gemini`),当前**故意红**——修好即绿。建议抬头用**配置的
命令名**(config `commandName`,默认 gemini)而非再硬编码一个 `/gemini`,与「命令名可配」
的设计一致。

> 顺带(非 FAIL,可一并扫):`config.ts` 两处 error message、`tools.ts`/`BriefingEngine.ts`/
> `AssistantSpeaker.ts` 的 JSDoc 抬头仍写 `/live`——运维/开发者可见,非 founder-facing,
> 但既然在改 B2,顺手统一成 gemini 最干净。(内部状态机名 `state:"live"` 不用动。)

## 复现命令

```bash
# 三个包单测(全绿)
(cd packages/voice-bridge && pnpm vitest run)      # 118 passed（含 QA 新增红测=预期）
(cd packages/voice-core  && pnpm vitest run)      # 116 passed
(cd packages/teamlead    && pnpm vitest run src/__tests__/linear-comment-and-lookup.test.ts)  # 18 passed
# lint / typecheck
pnpm lint                                          # exit 0
(cd packages/voice-bridge && pnpm typecheck)       # exit 0
# B2 回归(当前红,修好转绿)
(cd packages/voice-bridge && pnpm vitest run src/__tests__/qa-fly967-naming.test.ts)
# B1 事实核对
grep -rn "interactionCreate\|SlashCommandBuilder\|resolveAssistantConfig\|new AssistantSession" packages/voice-bridge/src packages/teamlead/src | grep -v __tests__   # 仅 index.ts 导出，无运行时装配
```

---

## Round 2 — RE-TEST 复验(2026-07-07,head bf8369b1)

implement 阶段(session 525f8151)针对 round-1 两条 FAIL 提交了修复(commits
`d29c658c`→`bf8369b1`,Codex R3-R8 六轮 APPROVED)。QA 独立复核:

### 代码面(Tadashi 裁决 = 本轮 partial verdict)= **PASS**

| 复验项 | 结果 |
|--------|------|
| **B1 修复** — `/gemini` 真接进 daemon | ✅ 新 `assistant/wiring.ts`(610 行)`wireAssistantMode`:`deps.registerGuildCommand` + `deps.onChatCommand` 真注册 slash 命令 + interaction 分发 → GeminiCommand → AssistantSession,**真依赖**(BriefingEngine.start / 真 VC presence / 真 Linear proxy / 真 Gemini rotator / 真 AssistantLanding)。`cli.ts` 在 config opt-in 时调用它 + 缺 GEMINI_API_KEY **启动即 fail-fast**。**不再是休眠库代码。** |
| **B1 真机验证** | ✅ 隔离 staged rig 真跑:bots online + `/gemini registered on guild` + autostart→command.handle→真建 Linear issue(见 `evidence/staged-e2e-round-opening.md`) |
| **B2 修复** — 落地纪要 `/live`→`/gemini` | ✅ `buildSummary(input, commandName="gemini")` 参数化命令名;我那条红回归 `qa-fly967-naming.test.ts` **转绿** |
| 测试 | ✅ voice-bridge **131/131**(+11 新 wiring 测 + 我 2 条回归)、voice-core 116/116、teamlead 路由 18/18 |
| lint / typecheck | ✅ FLY-967 触碰的 16 文件 biome 干净(scoped exit 0);typecheck exit 0。全仓 `pnpm lint` 的 1 error 是 **gitignored 运行时产物** `.flywheel/runs/*/land-status.json`,14 warnings 在 d652fbec 也在(**预存**,非 FLY-967) |
| Codex 修复对得上 | ✅ R3(adapter late-handler / presence delta / dedicated-bot honesty)、R7(staged prod-port refusal + SIGTERM)等在代码里可核 |

### 最终验收(staged E2E full)= **等 Annie**(Tadashi 裁决)

round-opening 链已真机验过(见 evidence)。**live 全双工对话 + 「简报真出」现场体感 +
A/B 与 545(B)对比定方向 = Annie A8**,需她点 bot 邀请 URL + 进 VC 带麦克风,QA 无法替她做。
本轮不开 ship approve gate —— 代码面 PASS 报 Tadashi,最终 ship 等 Annie 的 staged E2E。
