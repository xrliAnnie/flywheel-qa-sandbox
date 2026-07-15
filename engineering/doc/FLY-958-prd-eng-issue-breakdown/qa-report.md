# FLY-958 三份已批 PRD → eng issue 拆解提案 — QA 报告

Issue: FLY-958 (https://linear.app/geoforge3d/issue/FLY-958/planning-三份已批-prd-eng-issue-拆解提案-906-voicehuddle-914-交互批注-915-infra)
日期: 2026-07-07
基于: proposal-906-voice.md · exploration.md · progress.md（同文件夹）；独立核对 FLY-906 prd.md + poc-converse.md + CommDB + Linear ground truth

> **QA 结论:✅ PASS**。这是**纯规划 issue、零 production code**——QA = 对交付物
> `proposal-906-voice.md` 做**独立事实核查**(不重跑测试、无代码可测),核到四个独立
> ground-truth 源全部吻合,且提案已被 Annie **采纳并执行**。QA 阶段只**新增本报告**,
> 不改设计交付物本体(scope discipline:proposal 是已被采纳的历史设计产物)。

## 0. Scope 确认(先说清 QA 依据的是哪个 scope)

原 issue 描述 = 三份 PRD(906/914/915)全拆 + founder-facing HTML。**但 Lead(Tadashi)在
brainstorm gate 明确、记录在案地收窄了 scope**(压过原 issue 描述)。CommDB ground truth:

| 消息 id | 时间 | Lead 原话(节选) |
|---------|------|----------------|
| `f3565f40` (instruction) | 07-07 07:16 | "总览 HTML 我自己直接出…你只做深读 906 Voice PRD → 拆解提案清单…markdown 直接 ask 发我、不用 HTML 不用 exploration/research/plan 三件套" |
| `3fe91ed2` (response) | 07-07 07:22 | "Scope 已大改、按这个走(**别按原 issue 描述**):914/915 已拆好不用你管、总览 HTML 我已出。你只做…出拆解提案清单…每个提案 issue:标题 + scope + 依赖 + **难度** + 顺序" |
| `0b29fed1` (instruction) | 07-07 07:30 | "别做 HTML —— 交付物已完成…提案在 proposal-906-voice.md…complete 收尾(**不用 QA、纯规划 issue**)" |

→ **收窄后 scope = 只做 FLY-906 Voice PRD 深读 → 拆解提案清单**(markdown,不做 HTML、不做
914/915、不做三件套、每 issue 带难度档而非模型档)。914/915 已由 Lead 另拆好、总览 HTML 由
Lead 直出并已发 Annie(打勾页 v2:`fw-reports-a53de2.vercel.app/r/893666f69340b5ae0792ba0ea7ee1be3/`)。
**本 QA 依此收窄 scope 验收**,不因原 issue 描述里的 914/915/HTML 判 FAIL。

## 1. 验证方法(四个独立 ground-truth 源)

| # | 验的是什么 | Ground truth 源 | 结果 |
|---|-----------|-----------------|------|
| A | scope 收窄是否真实(不是 runner 自编) | CommDB `messages`(上表三条 Lead 指令) | ✅ 真实、记录在案 |
| B | 提案是否忠实映射 FLY-906 PRD | `product/doc/FLY-906-voice-product-experience/prd.md`(APPROVED v0.17,519 行) | ✅ 逐节吻合 |
| C | 543 的 4 个 bug 是否属实、描述是否准 | `packages/voice-core/evidence/poc-converse.md`(543 QA 真机证据) | ✅ 4/4 逐字吻合 |
| D | Linear 542 树 claim(543 Done / 544-548 现状)是否准 | Linear API 实查(542/543/544/545/546/547/548/960/906) | ✅ 准确,且提案已被采纳执行 |

## 2. 提案 ↔ PRD §10 映射核对(源 B)

提案 7 条 = **2 新建 + 5 保号更新**,逐条对回 PRD §10「PRD 各节 → 已有 Voice 树」映射表:

| 提案条目 | 动作 | 映射 PRD 节 | 核对 |
|---------|------|-------------|------|
| ① voice-core bug 修复(543 QA 遗留) | 新建 | §5/§6/§14/§17 能力地基的实作缺陷 | ✅ 543 已 Done/关闭 → 新建(不重开)合理 |
| ② STT spike(bot 在 DAVE 下收音 go/no-go) | 新建 | §12.1 头号可行性风险 + §10 544 前提 | ✅ 单独 go/no-go 闸(PRD 原话「验通再往下建」);难度=难,对 |
| ③ Discord voice bridge | 更新 544 | §12 界面 + §12.1 + §17 多-agent 同频 | ✅ 依赖 ②GO+① 正确 |
| ④ 用例① Huddle 端到端 | 更新 545 | §12.0/§12.1 + §16 流① + §14/§15 | ✅ 依赖 ③ 正确 |
| ⑤ 结论落地 pipeline | 更新 548 | §12.0.4 + §14 写前 recap | ✅ 依赖 ④ 正确 |
| ⑥ per-agent 声线 | 更新 547(priority 提起) | §17 硬要求(耳机模式硬前提) | ✅ 抓住 PRD §10 phasing flag |
| ⑦ 用例② 离屏推进(耳机模式) | 更新 546(整改写,v1.5 待拍) | §13 + §16 流② + §17 | ✅ 旧「早晚会」已被 R7 砍→整改写,对 |

- **HL 特别要核的三节全部落位正确**:两模式(§5)→ #4(Huddle)/#7(异步);action 三档(§14)→
  #4/#7 验收;延迟目标(§15)→ #3 地基 + #4 硬指标。✅
- **给 Annie 拍的决策点抓对**:耳机模式(#6+#7)进 v1 vs v1.5(推荐 v1.5,= PRD §10 显式
  phasing open question);#2 no-go 时的 fallback。✅

## 3. 543 四个 bug 核对(源 C — poc-converse.md 逐条)

提案对 543 QA 遗留 bug 的描述与真机证据 **4/4 逐字吻合**:

| bug | 提案描述 | poc-converse.md 证据 | 核对 |
|-----|---------|---------------------|------|
| A mic 默认设备错 | `MicCapture.ts` 写死 avfoundation `:0`、非系统默认输入;`--device ":2"` 已现场修复验证 | §"bug A":`:0`=笔记本麦、真实默认是 DJI `:2`;`--device ":2"` 重启已确认监听 | ✅ 含「已现场验证」这一细节 |
| B talk session ~50s 过期不重连 | resume handle 从未被调用 | §"bug B":`cli.ts runTalk()` 只打印 `[session expiring in ~50s]`、从不调 resume | ✅ |
| C `ask_lead` 缺 schema | `genaiConnector.ts` 工具声明缺 parameters/description → 真模型瞎编/卡壳;补 schema 即好 | §追加:`{ name:"ask_lead" }` 无 parameters → 两次真机跑瞎编/"连接出问题";补标准 JSON schema 对照实验立即成功调用 | ✅ 含对照实验结论 |
| D config 默认模型 404 | `config.ts` 默认 `gemini-live-2.5-flash-preview` 已 404 | §"顺带发现":真机连接返回真实 404、该名不在真实可用列表 | ✅ |

## 4. Linear 542 树核对(源 D)+ 提案 → 执行对账 ⭐

**关键发现:提案写完(design 段 ~00:26)后,Annie 于 07-07 07:44–07:45 拍板把 542 树重构成
「Voice 4 单元结构」,提案的实质建议全部被采纳并落地。** 提案 7 项(input)→ Annie 收敛成 4 单元:

| Linear 现状(实查) | 状态 | 对应提案条目 |
|---------------------|------|--------------|
| **FLY-542** EPIC | Backlog(容器未动) | 提案「EPIC 不动」✅ |
| **FLY-543** 核心 voice skill | **Done**(07-07 04:09,PR #480) | 提案「543 已 Done」✅ |
| **FLY-960** STT spike ⭐全树闸 | Backlog · High · **model Fable** · 07-07 07:44 新建 | = 提案 ②(新建 STT spike,难,Fable)✅ 逐条兑现 |
| **FLY-545** [voice·③] Huddle 完整 deliverable(原 **544/545/548** 合并,A/B/C 子范围) | Backlog · 依赖 ①bugfix+②STT GO | = 提案 ③+④+⑤ 合并 ✅ |
| **FLY-546** [voice·④·v1.5] 耳机模式(原 **546/547** 合并,A=声线先行) | Backlog · 待 Huddle 试跑后开 | = 提案 ⑥+⑦ 合并,v1.5 phasing ✅ |
| **FLY-544 / 547 / 548** | **Duplicate**(07-07 07:45,分别折入 545/546/545) | 提案的「更新」被 Annie 用「合并」取代——更干净 |

**对账结论**:提案里凡实质决策(bugfix 先行 / STT spike 作 go/no-go 全树闸 / Huddle 端到端 /
耳机模式 v1.5 + 声线提前 / 542 EPIC 不动)**全部 carried through**。Annie 把提案的 7 项(2 新+5 更)
进一步**收敛成 4 单元**(544+545+548→③;546+547→④;新建 ②=FLY-960;①=bug 修复),是对提案的
**采纳 + 精修**,不是推翻。这是提案「正确且有用」的最强证据。

> **给未来读本分支的人的提醒(避免混淆)**:`proposal-906-voice.md` 是 **design 段的历史设计
> 产物**,描述的是「更新 FLY-544/547/548」的 7 项形态;它写完后 Annie 已把 Linear 树重构成
> 4 单元(544/547/548 现为 Duplicate、新增 FLY-960)。**proposal 不是活文档、无需回改**——真正
> 的执行事实以 live Linear(FLY-545/546 + FLY-960)为准。本节即两者的对账。

## 5. QA 判定

**✅ PASS。** 交付物 `proposal-906-voice.md` 在收窄后 scope 下:忠实、准确、完整地把 FLY-906
PRD 拆成可执行 eng issue 提案(每条带标题/scope/依赖/顺序/难度/映射动作),4 个 ground-truth 源
全部吻合,HL 要核三节与 Annie 决策点均落位正确,且**已被 Annie 采纳并在 Linear 落地执行**。

- **无需修的缺陷**:未发现事实错误、映射错误或遗漏(收窄 scope 内)。
- **非缺陷、仅记录**:proposal 描述的 7 项形态已被 Annie 收敛为 4 单元(§4 对账),属正常
  「提案 → founder 决策精修」演进,不改设计产物本体。
- **本分支 PR #486 内容** = 该规划提案 + 本 QA 报告(纯 docs,零代码)。
