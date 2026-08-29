# FLY-1018 /gemini-advanced 正式建造 — 探索

Issue: FLY-1018 (https://linear.app/geoforge3d/issue/FLY-1018/voicebbuild-gemini-advanced-正式建造-cc-设计思想-spike-资产产品化m1-m4)
日期: 2026-07-08
基于: FLY-997 spike findings(`flywheel-FLY-997` 分支 `engineering/doc/FLY-997-gemini-agent-spike/findings.md`,PR #513)

> **TL;DR**:把 FLY-997 已实证的薄 agent loop(S2 矩阵 100/100、S4 护栏 10/10、S3 两层 delegate 5/5)产品化成 `packages/gemini-agent` 正式包,设计思想全面学 Claude Code(思想层,license 红线内 clean-room 自写),按 M1 正式包 → M2 Discord 文字入口 → M3 语音接线 → M4 token 降权四个里程碑落地。核心架构决策(own-loop on Interactions API / 两层语音架构 / 6 工具 MVP / 三层护栏)已被 spike 数据定稿,本 issue 的设计工作重心是**产品化重设计**(循环/工具 dispatch/上下文管理/错误路径/审计,对着 CC 设计思想)而非重开架构辩论。

## 1. 问题定义

FLY-996 定义了 voice track B:`/gemini-advanced` = 一个真·会用工具的 Gemini Agent——Gemini 当脑 + 自建一层真工具,能 take action(开会里说「帮我派个活」它真去做)。FLY-997 spike 已回答可行性(全部判据大幅超过门槛),Annie 2026-07-08 拍板 GO 开建。

本 issue = build:把 spike 资产(~301 行 loop + 6 工具合同 + 三层护栏 + 实测背书)转成正式产品。**不是**从零设计一个 agent——地基已在,要做的是:

1. **产品化重设计**(M1):spike loop 是一次性脚本(.mjs、无重试、无超时、mock 工具面);正式包要 TypeScript、真 Bridge HTTP 集成、错误路径完整、审计落盘、config 化、测试覆盖。重设计时**对着 CC 设计思想**(架构分层、单主循环、工具抽象、上下文管理、审计先行)。
2. **入口接线**(M2 文字 / M3 语音):把这个脑接到用户面前——Discord 文字命令先通全链,语音走 FLY-545 留好的 extraTools/BrainAdapter seam(两层:语音 delegate → 文本执行 → 完成注回播报)。
3. **护栏结构化**(M4):spike 的护栏三层里,「注册表无 merge 工具」「进程不持凭证」是客户端纪律;S-b 降权 token 把它升级为**服务端强制**(Bridge 按 token 区分 endpoint 可达集)——issue 定为 build 必做。

## 2. 授权与方针(设计输入,不可重开)

以下由 founder/Lead 拍板,是设计的**边界条件**而非选项:

| 方针 | 内容 | 来源 |
|------|------|------|
| GO 开建 | B 线从 spike 转正式建造 | Annie 2026-07-08 [FLY-997] thread |
| 设计参考 | **设计思想全面学 Claude Code、贴得越近越好**;研读 ~/Dev/claude-code 提炼思想 | Annie 钦定 |
| License 红线 | 该仓 = 泄露的 Anthropic 专有码(UNLICENSED):思想/概念层可学可贴;**代码本体不逐行照搬、不贴近转写**;产品代码 clean-room 自写 | Annie 钦定 |
| gemini-cli 一票否决 | 「写的太差、千万不要抄」,从参考清单移除 | Annie 明确 |
| 命令名 | `/gemini-advanced` | Lead 2026-07-08 拍板 |
| 北极星主轴 | 深脑 + **自带上下文(persona+context 注入:跟特定 Lead 聊特定事)** + 结果落地(结论回 issue/memory) | Annie 拍(996 PRD 对齐) |
| 红线 | founder-merge-gate 原样继承零改动;agent 不碰 reserved endpoints、不持 raw comm.db 写权限 | issue 红线 |
| 模型 | Fable(QA 除外)——指开发本 issue 的 agent;gemini-agent 运行时模型档见 §4 | issue |

**License 红线的执行方式**(设计阶段落实):CC 源码研读发生在**设计阶段**(本文档 + research.md),产出物 = 概念级设计原则清单(禁代码引用);**实现阶段 clean-room**——implement 阶段不打开 ~/Dev/claude-code,只对着我们自己的 plan.md 写。这继承 FLY-997 findings §④-附 已定的纪律。

## 3. spike 已定稿的架构决策(直接继承)

| # | 决策 | spike 证据 | 本 issue 态度 |
|---|------|-----------|--------------|
| D1 | **own-loop on `@google/genai` Interactions API**,不用 ADK | ~301 行跑出 100/100;Interactions 面天然手动 dispatch(`steps[]` + `previous_interaction_id` + `function_result`) | 继承。硬前提 SDK ≥2.0.0(1.x wire schema 已被服务端拒收) |
| D2 | **monorepo 新包 `packages/gemini-agent`** | 依赖五个面全在仓内;SDK 版本可包内独立 pin(2.x 与 voice-core 1.x 互不干扰) | 继承。standalone 抽离条件维持三条(非 Flywheel 消费者/发布节奏冲突/进程级信任域隔离) |
| D3 | **MVP 6 工具**:create_issue / dispatch_runner / query_status / search_memory / save_memory / request_ship_approval | 全部 100% 实测背书;合同已逐条对照真 Bridge 路由 | 继承。生产 schema 修正 spike-strict 偏差(description 回到可选) |
| D4 | **两层语音架构**(Live 持单 delegate 工具 → 深脑文本 loop → 完成注回) | S3 5/5,delegate 决策 ~0.6s;live 模型拒 TEXT 模态 → 两层是物理必然 | 继承(M3) |
| D5 | **模型档默认 flash**(`gemini-3.5-flash`),pro 留重规划场景 config 开关 | 两档同 100%,flash 成本低 | 继承。config 可切,像 voice-core 模型 pin 惯例 |
| D6 | **护栏三层 + S-b 降权 token** | S4 10/10 零绕过(行为层);S-b 是服务端结构强制的最后一公里 | 继承,S-b = M4 必做 |

## 4. 本 issue 要新做的设计决策(设计阶段收敛)

1. **CC 设计思想 → 我们的落法**:单主循环怎么组织、工具抽象接口形状、上下文组装分层(persona/identity.md + 项目记忆 + 会话历史)、审计先行落盘格式、错误路径分级(fatal vs recoverable、重试策略)——research.md 给概念对照,plan.md 给我们自己的模块图。
2. **M2 文字入口挂点**:`/gemini-advanced <指令>` 在 Discord 侧怎么路由进 agent loop——调研结论(research §3.4):gemini-agent 自带瘦 Discord 入口(FLY-882 bot 池领 slot,guild slash command 直调同一 loop);排除 Lead 转译路(脑变 Claude)与 voice-bridge 耦合路(依赖未 land 的 PR-2 且违背独立 track)。
3. **M4 S-b 形态**:Bridge 按 token 区分 endpoint 可达集的中间件挂点 + 降权 token 的签发/存放。
4. **上线顺序与开关**:feature-flag default-off(字节兼容惯例),M1-M4 全落 + QA 过后才对 Annie 开;M4 必须先于真实启用(没有 S-b 之前只有客户端纪律)。
5. **审计与可观测**:session transcript 落盘(位置/格式/脱敏)、token 用量记账(接 FLY-614 token-usage 体系还是独立)。
6. **PR #513 依赖处理**:~~spike 资产还未 merge~~ **已解决**——brainstorm gate 期间 Tadashi 确认 #513 已 merge(main `36e99fcb`),spike 资产已在 main 上;implement 开工时同步一次 origin/main 自然带进(本分支设计时落后 47+ commit)。姿态不变:**正式包 clean-room 重写非搬运**,spike 只作设计参考 + 证据基线。

## 5. 非目标(YAGNI)

- **不做新 Lead/Runner 角色**:gemini-agent 是「能被语音/文本唤起的 dispatch 助手」,不进 Lead fleet、不接 Runner 生命周期。
- **不做通用 agent 框架**:6 工具、窄面、单用途;不为假想的第 7 个工具设计插件系统(工具注册表可扩展即可)。
- **不动 voice-core 现有 track A**(/glaw /gemini 薄派活):B 线独立,voice-core 只消费其公开 seam。
- **不做 mode b 真异步 FC**(NON_BLOCKING 调度语义):spike 未端到端验证,模式 a(ACK+完成注回)已够 MVP;随模型演进复测。
- **不固化美元价格**(FLY-883 教训):成本按 build 当日牌价折算。

## 6. 风险与未知(设计阶段要压掉的)

| 风险 | 处置 |
|------|------|
| Interactions API 标 experimental,SDK 2.x wire 可能再变 | pin 精确版本 + build 当日 ListModels/冒烟复核(FLY-883 教训,spike 已演练过该流程) |
| 真 Bridge 集成摩擦(网络超时/重试/token 生命周期)——spike 明确没测 | M1 验收含真 Bridge E2E;错误路径设计先行(research) |
| first-byte ACK 延迟 ≤3s 判据 spike 无法裁定 | M3 用真音频管线测;判据裁定归 M3 验收 |
| S-b 降权 token 触碰 Bridge 鉴权面,改坏 = 全家不可用 | M4 独立 chunk + 字节兼容开关 + reverse-compat 测试(项目惯例) |
| PR #513 未 merge 的时序耦合 | plan 写死 base 策略(§4-6) |

## 7. 结论 → research

方向已清晰,无需多方案对比(架构层 spike 已定稿、方针层 founder 已拍板)。research.md 聚焦两件事:① CC 设计思想的概念级提炼(五维:分层/单主循环/工具抽象/上下文管理/审计先行)+ 对我们包的适配映射;② 本仓接线面事实审计(voice-core seam / Bridge 工具面鉴权 / Discord 命令路由 / reserved endpoints 中间件),为 M1-M4 的 plan 提供 file:line 级依据。
