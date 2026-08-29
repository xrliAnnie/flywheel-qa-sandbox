# FLY-1159 /gemini-advanced 语音接线（route A）— 调研

Issue: FLY-1159 (https://linear.app/geoforge3d/issue/FLY-1159/voiceb-gemini-advanced-语音接线route-a-delegate-挂-gemini-引擎)
日期: 2026-07-11
基于: exploration.md

> 本调研 = 落地路径（选项 A,brainstorm gate 已批）的技术证据固化。所有结论来自
> 真机演练,不是推断。演练现场:scratchpad rebase-sim worktree,基于 origin/main
> = 6f151690 (FLY-1160)。

## 1. 移植对象（#548 的 3 个 commit,按序 cherry-pick）

| # | commit | 内容 | 演练冲突 |
|---|--------|------|----------|
| 1 | 0b6862df | 实现主体:advanced.ts(新,134 行)+ assistant-advanced.test.ts(新,278 行,14 测)+ config.ts/wiring.ts/cli.ts/package.json 增量 | 3 hunk（见 §2） |
| 2 | 285f2ac8 | Codex R1 修复:deps.sendMessage 文字保底无条件化 | 零冲突 |
| 3 | 48d83fa1 | handoff.md（本文件夹,45 行） | 零冲突 |

移植后总 diffstat（见 evidence/sim-diffstat.txt）:8 文件,+534/-6。全部在
packages/voice-bridge/ + pnpm-lock.yaml + 本文档文件夹。

## 2. 冲突面（实测,3 个纯加性 hunk）

完整解决 patch 存档于 evidence/cherry-pick-resolution.patch（87 行,implement
阶段照抄）。逐个说明:

### hunk 1+2 — packages/voice-bridge/src/assistant/config.ts

FLY-1065（captions,已 merge #535）与 #548（advanced）在 AssistantModeConfig
interface 和 resolveAssistantConfig 返回对象的**同一插入点**各加了一个字段。
解法 = 两边都保,顺序 captions 在前（main 现状),advanced 在后:

```ts
	captions?: boolean;        // ← main 已有（FLY-1065）
	advanced?: AssistantAdvancedConfig;   // ← #548 新增
```
```ts
		captions: optBoolean(a, "captions") ?? true,
		...(advanced && { advanced }),
```

### hunk 3 — packages/voice-bridge/src/cli.ts

FLY-1160 的 ResidentBrainManager import 与 #548 的 loadAdvancedAgentConfig
import 撞同一行位。解法 = 两行都保。cli.ts 其余部分（#548 的启动 fail-fast 块,
插在 GEMINI_API_KEY 警告之后）auto-merge 干净。

### wiring.ts — 零冲突,且语义正交已验证

- #548 挂载点 = makeRealConversationFactory 内 TalkSessionRotator 的 extraTools
  数组（buildAssistantTools 基础 2 工具 lookup_issue/board_snapshot +
  advancedTool 条件追加;深层 6 工具 registry 在 delegate 内部,不进 extraTools。
  **v2 更正(founder 2026-07-11)**:delegate 只挂在独立的 /gemini-advanced 命令
  的工厂上,/gemini 的工厂由 advanced 剥离的配置构造,字节冻结）+
  RealConversationDeps.advancedSendText 注入。
- FLY-1160 对 wiring.ts 的全部改动 = shutdown 语义（isShuttingDown 命令下架、
  close(AbortSignal)、Linear client signal 透传）,不触碰 conversation factory
  的工具注入路径。git auto-merge 结果人工复核过,两组改动无行为交互。
- FLY-1160 scope 原文（#550 commit message）:「/glaw + /eleven only —
  /gemini(-advanced) have no Claude conversational brain」。resident brain 与
  Gemini Live 会话是不相交链路,BrainPort 默认 OFF 且本票不配 brain 段。

## 3. 移植后验证（演练已跑通,implement 阶段复现即可）

| 验证 | 演练结果 |
|------|----------|
| pnpm install --frozen-lockfile | 过（#548 的 pnpm-lock 增量与 main 兼容,+3 行） |
| voice-core / gemini-agent / voice-bridge build (tsc) | 全过 |
| voice-bridge 测试套 | **336/336 全绿**（34 文件） |

336 的构成:main 基线 322（含 FLY-1160 新增的 brain-port/daemon-brain-port/
assistant-landing 等 + FLY-1006/1065 全部）+ FLY-1159 的 14（assistant-advanced
.test.ts）。即 FLY-1160 与 FLY-1159 的测试在合并态共存,互相零回归。

演练未跑全仓 lint（biome)与全仓测试 —— implement 阶段必跑（push 前全仓 lint 是
项目铁律)。

## 4. Codex review 策略

- #548 已有两轮记录:R1 = MEDIUM(轮换空窗丢完成通知)→ 修复 285f2ac8;R2 =
  APPROVED 零 findings。
- 新 PR head ≠ 已批 head → 必须重跑 Codex code review。提法:声明「diff 与
  #548 已批内容的关系 = 同一实现 cherry-pick 到 post-FLY-1160 的 main + 3 个
  加性冲突 hunk 的融合」,附 #548 链接让 Codex 拿到 R1/R2 上下文,重点审冲突
  融合区（config.ts/cli.ts）与 FLY-1160 共存语义,预期增量、快。
- 效率纪律:codex 一律走 codex-with-fallback / codex-rescue,绝不 raw exec;
  重型 review 前台跑。

## 5. QA 方案输入（gate 上 Tadashi 钉的边界 + handoff §3/§4）

### 5.1 能力边界（Tadashi 原话要点,QA 报告必须按此分栏）

route A 的耳朵是 Gemini Live STT,**合成音喂不进去**（与 /glaw 同样现实,
Chrome-as-Annie 灌不进 Gemini STT)。因此:

- **机器可验 ✅**:delegate 注入(advanced 配置解析/fail-fast)、深层 6 工具循环、
  集成层、非音频链路 —— 967 staged 形态起 voice-bridge + gemini-agent-test
  隔离半区,QA R3 四条锚点（带 label 建票 / 过 dept 闸 / query_status / 记忆落
  shared bucket）的工具与落地部分;完成通知的两条路径（speak 口播 mock 层 +
  Discord 文字落地真发)。
- **等真声验 ⏳**:「Annie 在 VC 说一句 → 真转写 → 异步跑 → 口播 + 频道文字
  落地」的全声学闭环 —— 留给 Annie 早上真机测（founder signoff)。

### 5.2 环境要点（handoff §4,QA R1-R3 + venue 实操验证过的坑）

- GEMINI_API_KEY:复用 /gemini 在用那把（Annie 裁决,不新开 key)。取值:
  ~/.flywheel/qa-fly967-staged/.env.staged 或 ~/.zshrc 的 GOOGLE_API_KEY 映射,
  绝不进 argv/日志。
- Bridge token:只放 scoped 的 FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN,绝不放主令牌。
- deptLabel:QA 用 Ops-Test（FLY 团队真实存在、与生产 lead 路由不相交)。
- 隔离半区:~/.flywheel/gemini-agent-test/ 常驻（venue-state.json 有端口/pid;
  拆栈 = SIGTERM stackPid),语音 QA 复用其 Bridge 半区(含真 Linear + dept 闸)。
- Discord bot:测试用 TEST_BOT_TOKEN_1(FLY-1060 先例);生产专属 bot = Tadashi
  上线手续,不在本票。

## 6. ship 形态

- merge-to-main-only,不重启生产 Bridge（Annie 2026-07-11 00:34 拍的 voice wave
  ship 模式）。voice-bridge 是按需起的 daemon,merge 即生效于下次启动;生产
  projects.json 未配 advanced 段之前,行为字节不变（合同保证)。
- founder gate 全套纪律:gate approve_to_ship --no-block → complete
  needs_review → verify-approval 只认 approved:true;绝不自 merge / 自 :cool:。
- head 纪律（FLY-921/945):QA pin 钉住 head 后不再 push。

## 7. 风险清单

| 风险 | 等级 | 处置 |
|------|------|------|
| main 在 implement 开跑前又动 voice-bridge | 低 | implement 第一步重新 fetch + 重放演练;冲突解法模式已知（加性追加） |
| pnpm-lock 融合漂移 | 低 | cherry-pick 后 --frozen-lockfile 装不上就重新 pnpm install 让 lock 收敛,diff 审查 |
| Codex 对融合区提新 findings | 中 | 正常 kickback 循环,修 → 增量 re-review |
| QA 半区 venue 状态陈旧（pid 死/端口占） | 中 | QA 阶段先做 venue 健康检查,必要时按 venue-state.json 重建 |
| 真声闭环在 Annie 测试时暴露问题 | 中 | 属预期内 founder 验收环;kickback 回 implement,QA 报告的 ⏳ 栏已声明未覆盖 |
