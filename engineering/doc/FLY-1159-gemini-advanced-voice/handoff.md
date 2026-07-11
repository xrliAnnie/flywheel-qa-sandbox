# FLY-1159 /gemini-advanced 语音接线 — 交接包(implement 已完成,QA+ship 生命周期交接)

Issue: FLY-1159 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: engineering/doc/FLY-1018-gemini-advanced-build/plan.md(M3 delegate seam)+ FLY-1060 QA R1-R3 verdict

> 写给接手 FLY-1159 正式 run 的 runner:实现已完成并过两轮 Codex code review,
> 你的活 = 驱动独立真机语音 QA → kickback 修复循环 → #518 合并后 rebase/retarget →
> ship lap。**不要重做实现。**
>
> **⚠️ v2 更正(founder 2026-07-11)**:本文的「delegate 挂在 /gemini 配置开关下」
> 合同已被 Annie 推翻 —— 现行合同 = 双命令(/gemini 字节冻结不动;delegate 挂独立
> 的 /gemini-advanced 语音命令)。现行行为合同以 exploration.md §2 (v2) 为准;
> 本文其余部分(资产/env/QA 坑)仍有效。

## 1. 资产清单

| 资产 | 位置 |
|------|------|
| PR | #548(title ref FLY-1159;**stacked**,base = flywheel-FLY-1018 分支) |
| 分支 | feat/fly1018-voice-delegate(基线 c2370b81 = #518 head,因为要 import flywheel-gemini-agent,main 上还没有) |
| worktree | ~/Dev/flywheel-FLY-1018/worktrees/fly1018-voice(已 install + build) |
| 实现 | packages/voice-bridge/src/assistant/advanced.ts(新)+ config.ts / wiring.ts / cli.ts / package.json 增量 |
| 测试 | src/__tests__/assistant-advanced.test.ts(14 测)+ 全套 193/193 |
| review 记录 | PR #548 评论区:Codex R1(MEDIUM:生产文字保底缺失)→ 修复 285f2ac8 → R2 APPROVED 零 findings |

## 2. 已交付的行为合同(别改,QA 对着验)

- 配置:`huddle.assistant.advanced = { leadId, deptLabel?, identityPath? }` —— 不配 = /gemini 字节不变;半配置(缺 agent env)= daemon 启动即拒(fail-fast 带修复指引)。
- 链路:说一句 → Live 口头「已受理,任务 <id>」(即时 ACK)→ 深层 6 工具文字循环异步跑(#518 的封闭注册表 + scoped token)→ 完成**口播**(轮换安全)+ **语音频道文字落地**(无条件送达,createDiscordCompletionSink;这是口播里「详情见文字记录」的兑现面)。
- 权威面:零新增 —— ship 意愿仍止于 request_ship_approval;绝无 merge/deploy 能力。

## 3. 你的生命周期任务

1. **独立真机语音 QA**(Tadashi 派/你驱动):967 staged 形态起 voice-bridge(assistant 配置 + advanced 段),真 VC 说一句派活 → 听到已受理 → 深层执行(可对接 ~/.flywheel/gemini-agent-test 的隔离 Bridge 半区,QA R3 同款,含真 Linear + dept 闸)→ 完成口播 + 频道文字齐到。验收锚点:QA R3 的四条(带 label 建票/过 dept 闸/query_status/记忆落 shared bucket)经语音链复现。
2. **kickback 循环**:修 → 测 → Codex 增量 review → 重验。
3. **#518 合并后**:rebase 本分支到 main、PR retarget main(冲突面理论为零 —— 全部改动在 voice-bridge,#518 不碰它)。
4. **ship lap**:founder gate 照全套纪律 —— gate --no-block + complete needs_review + verify-approval 只认 {"approved": true};绝不自 merge/自 :cool:。

## 4. 环境要点(QA R1-R3 + venue 实操验证过的坑)

- GEMINI_API_KEY:复用 /gemini 在用那把(Annie 裁决,不要新 key)—— 取值路径:~/.flywheel/qa-fly967-staged/.env.staged 或 ~/.zshrc 的 GOOGLE_API_KEY(映射一行,别进 argv/日志)。
- Bridge token:只放 scoped(FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN),绝不放主令牌(包 README 红线)。
- deptLabel:生产姿态必配(F2 派活闸);QA 用 Ops-Test(FLY 团队真实存在、与生产 lead 路由不相交)。
- 文字 venue(QA-6 被测对象)仍常驻 ~/.flywheel/gemini-agent-test/(venue-state.json 有端口/pid;拆栈 = SIGTERM stackPid,自动删 guild command)——语音 QA 可复用其隔离 Bridge 半区。
- Discord bot:测试用 TEST_BOT_TOKEN_1(FLY-1060 先例);生产专属 bot = Tadashi 上线手续,不在本票。

## 5. 红线

不 merge、不自 ship、founder 沟通经 Tadashi;QA pin 一旦钉住 head 就不再 push(head 纪律 FLY-921/945)。
