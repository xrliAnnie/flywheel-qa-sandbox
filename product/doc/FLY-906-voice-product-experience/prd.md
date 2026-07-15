# FLY-906 Voice 产品体验设计 — PRD

Issue: FLY-906 (https://linear.app/geoforge3d/issue/FLY-906/voice-产品体验设计pm-共创-设计prd喂给-542-实现树)
日期: 2026-07-06
基于: exploration.md · research.md(同文件夹)· 上游 FLY-883 research.md · FLY-542 EPIC

> **状态:✅ APPROVED — Annie 最终 review 通过(2026-07-06,v0.17)。** 产品设计侧定稿。
> **交付去向(Annie 指示)**:906 = 产品设计 docs;**eng 实现 issue 由 Tadashi create**(本 PRD 不
> 拆/建 eng issue),PRD 作为参考链接指向已有 Voice 实现树(FLY-542 / 543-548,见 §10)。
> **STT 收音 = Tadashi 要先验证的前提假设(FLY-544);验通再往下建实现。**
>
> 逐版收敛的 PRD(Mode A 产品共创,与 Annie 逐块 live 收敛 10 轮)。技术实现/选型不在本文(归 eng)。

## 版本记录
- **v0.17(2026-07-06)** — **命令名 = `/meet`〔Annie R10 锁定〕**;其余候选(/call /huddle /sync /talk)
  进 backlog,命令名做成可配置。**至此 Huddle 机制全锁**(v1 只做 Huddle / 混合语音+文字频道 /
  /meet @点名发起 / 第一个 @ 的 Lead 做总结 / 自动建 issue→worktree→总结+action items / 动作三档 /
  延迟目标 / Stop Word 芝麻关门 / STT 待 Tadashi 验证)。huddle-review.html 同步 + 重新发布。
- **v0.16(2026-07-06)** — Annie R9 两条:①**谁做总结 = @ 的第一个 Lead 锁死**(单人就那人、多人第一个
  @ 的);②命令名候选收敛成 **/meet /call /huddle /sync /talk**(她要好懂,挑定后填,先可配置占位 /huddle)。
- **v0.15(2026-07-06)** — Annie R8 反馈折进:①发起=任意文字频道、随时随地(命令名 huddle 待她挑,
  先做**可配置**);②**结论落地改**:一发起自动建 1 条立项 issue(日期+参与者)→ 聊完 @第一个 Lead
  从它建 worktree + 写 summary+action items → 存档关 issue(取代 R7 的"落 1-2 action-item issue");
  ③**谁总结**=@ 的第一个 Lead(主持/记录),待她确认先按此写;④**STT 标成"待 Tadashi 技术验证的
  前提假设"**(整个 Voice 愿景依赖它、Discord DAVE 下现坏,别当已确认)。§12.1/§16/§16b/build map 对齐。
- **v0.13(2026-07-06)· R7 重大范围收敛 = Huddle-only** — Annie 拍:①砍 per-Lead 常规语音频道→改
  一个共享 Huddle VC + 动态成员(她发起+@点名 Lead 1 或 2-3 进同一 VC);②砍早会/晚会,只 Huddle
  试跑;③明确 voice+text 混合频道原生就有(TIV),记录落语音频道自带文字区;④结论落地精修:讨论=
  原生 message,聊完 summarize→落 1-2 action-item issue(不再一场一 issue,GitHub 归档降可选)。
  新增权威 **§12.0**(scope 收敛)+ **§12.1**(发起/拉人机制,Discord 语音原语研究回填中);§16b/§5/§8.1/§18
  对齐。砍项进 §18 Deferred。
- **v0.14(2026-07-06)** — **§12.1 发起+拉人机制定稿**(Discord 语音原语研究 research.md §12):
  硬约束=Discord 不能 ring/强拉没在语音的人(她必一键 join;已在 VC 则零-tap);推荐一个常驻
  `#huddle` VC + `/huddle @Lead` slash 发起 + Lead 自动进 + 一个"耳朵"bot 做 STT + 聊完 summarize
  落 1-2 issue 到 TIV。**头号可行性风险 flag(归 eng)**:bot 收音在强制 DAVE 下当前坏 → FLY-544 先验。
- **v0.12(2026-07-06)** — 又锁两条:**进入口令=「芝麻开门」/ 退出=「芝麻关门」对称**(§13,彩蛋转正锁);
  **FIFO v1=纯 FIFO 无优先级**(§17 LOCK)+ 阻塞类优先级记进 **§18 Deferred**(别丢 tradeoff)。
  新增 **§16b 快速沟通/Huddle 复习清单**(7 条体验选择整理成 relay 脚本,供 Lead 逐条端给 Annie)。
  至此 异步+进出+StopWord+FIFO 全定。
- **v0.11(2026-07-06)** — **Stop Word LOCK**(§13):=「芝麻关门」(中文短语)+ 确认步(说→系统
  「确认结束耳机模式?」→「对」→退出)。Annie 三点全定(中文/短语/带确认;确认步比研究建议更保守,
  为绝不误挂取安全)。可选进入彩蛋「芝麻开门」标 optional。§17 worked example 同步。
- **v0.10(2026-07-06)** — §17 加一段**逐字 worked example**(多-agent queue 跑起来:换声线报头 /
  skip / 要回代发 / mid-turn 静默入队 / 不可逆走 §14 c 档 / Stop Word 退出),把端到端 flow 做扎实到
  "eng 照着定措辞/回合边界"(Lead 要求)。
- **v0.9(2026-07-06)** — Stop Word 选词研究回填(research.md §11)+ §13 给出推荐(供 Annie 拍三点):
  短语+agent 名前缀、中/英按顺口(候选:芝麻关门/飞轮收工/下课下课/Flywheel over and out)、
  不做硬两步确认(改严阈值+边界软确认+ack+~30s 撤销窗,因结束可逆)。
- **v0.8(2026-07-06)** — Annie **LOCK 耳机模式进/出**(§13):进=#flywheel-core 说「进入耳机模式」/
  /headphone on;进入后**全局**(所有 Lead 消息转语音,喂 §17);退出=**专用 Stop Word 安全词**
  (只认特定生僻词、压误触发,可选加确认步)。仍待锁:Stop Word 中/英、词/短语、确认步。
  Stop Word 选词研究已起(Siri/Google 唤醒词可靠性 → 迁移)。
- **v0.7(2026-07-06)** — Annie **LOCK §17 全套 7 点**:两点待确认转已锁(⑥报头由发消息 agent 附带、
  ⑦mid-turn 新消息静默入队尾)。§13 记下耳机模式进/出**倾向**(core 宣布进入 / 语音说结束 / 全局,
  待她正式锁)。Lead 明示:别定稿别开 PR,逐块 live 共创中。
- **v0.6(2026-07-06)** — Android Auto/Siri/Alexa 车载读+回研究回填(research.md §10);据此校准
  §17:四拍骨架、报头/正文两深度(长消息先报头+摘要)、自动开麦、发前确认+不可逆强制、可中断可恢复。
  诚实 flag「FIFO 无优先级」的取舍(阻塞类会被 FYI 淹没;便宜方案=2-3 类),v1 尊重她简单 FIFO,经 Lead 抛回她定。
- **v0.5(2026-07-06)** — **新增 §17 异步多-agent 语音模式**(Annie R5 深化,离屏推进核心):
  推不拉 / FIFO 无优先级 / 一条一条一来一回 / 回哪条不用指定 / **per-agent 声线硬要求** /
  语音报头(身份+issue+进度)。带一条端到端流。flag FLY-547 声线依赖需提前(§10)。
  2 点待 Annie 确认(报头由发送 agent 附带 / 新消息静默入队尾)。下一块 = 耳机模式进/出。
- **v0.4(2026-07-06)** — **Part II 详细产品体验规格写满**(§12-16),达 Annie R4 要求的
  「Tadashi 照着能建」深度:§12 Discord 界面(常规 VC + TIV 落记录 + 绿圈/earcon/状态行)、
  §13 接入唤起(进频道=开始听 / 切耳机常开态 / 干净结束带产物)、§14 action 三档确认 + 写前口头
  recap、§15 latency 业务目标(首音≤800ms、静默≤3s、barge-in<100ms)、§16 每 use case 一条
  端到端流。依据 research.md(两路外部 UX 调研,带引用)。→ 待 Annie review 详细版。
- **v0.3(2026-07-06)** — Part II 骨架;§8.1 GitHub 存档机制确认。
- **v0.2(2026-07-06)** — 块③结论落地按会话性质细分;块④⑤按原则推导。
- **v0.1(2026-07-06)** — 捕获 R1-R2:真实意图、两模式模型、能力边界、v1=Huddle-first。

> **文档结构**:Part I(§1-11)= 产品决策与原则。**Part II(§12-18)= 详细产品体验规格**
> (§12.0 v1 范围 / §12.1 发起机制 / §12 界面 / §13 接入+耳机模式+StopWord / §14 动作 / §15 延迟 /
> §16 端到端流 / §16b Huddle 清单 / §17 异步多-agent / §18 Deferred),达 Annie R4「Tadashi 照着能建」
> 深度——定稿主体。

---

## 1. Problem(要解决什么)

Annie 目前用 **Discord 打字**跟 AI Lead 对齐工作。痛点:**打字来回半天太慢**,还把她
钉在键盘/屏幕前。她需要在**做家务、离开屏幕处理私事**时,也能顺畅地跟 Lead 把活儿
对齐、推进——这是北极星 **FLY-212(离屏也顺畅工作)** 的关键一环。

**本质**:Voice 不是新系统,是**现有文本交互通道的语音投影**——降低「跟 Lead 对齐」的
摩擦,让 Annie 敢离开屏幕。(不是为语音而语音。)

## 2. Users

| 用户 | 视角 |
|------|------|
| **Annie**(founder,非技术) | 语音进/出;边做私事边指挥;要自然口语,不要工程黑话/命令语法 |
| **AI Lead**(各部门) | 收到的**可能仍是文本**;工作流不变(该写代码写代码、该做 KV 做 KV);只是媒介从文字变语音 |

## 3. Goals

- G1. Annie 能用**自然语音**跟对应 Lead 把一件事聊清、并把结论/下一步**记下来再开干**。
- G2. Annie 能在**离屏**(做家务/处理私事)时,语音汇报进度 / 接收 guidance / 定下一步。
- G3. 语音能触发的行为与文本**完全一致**——不多不少。
- G4. 三类场景都能**顺畅跑通**:Huddle、(后续)早晚会、离屏推进项目。

## 4. Non-Goals(每个 add 都点一个 cut)

- **不碰技术选型/实现**——后端(Gemini Live/混合架构)、延迟、Discord bridge 归 eng(FLY-883/542 树)。
- **不新增语音专属确认机制**——voice 继承 text 现有确认行为(见 §6)。
- **v1 不做 scheduled 早晚会**——先全用 Huddle,方向对了再加(§5)。
- **不改 Lead 工作流**——Lead 侧与文字沟通无异。
- **不拆 bot 身份 / 不做独立声线**——同 bot 挂 voice 子系统;per-Lead 声线 = Phase 2(FLY-547)。

## 5. 核心模型:两种模式(Annie 定,已确认)

### 模式 1 · 快速沟通(即时同步)
即时交流,说完立刻要回应。核心=**基础查询**;**不产生实质 action**;目的是**同步信息**。
两种触发形态:
- **Huddle**(= **v1 唯一形态**):即时——她发起、@点名 Lead(1 或 2-3)进共享语音频道聊。
  动态成员机制见 **§12.0**。
- ~~**早会 / 晚会**~~:**R7 砍出 v1**(只做 Huddle 试跑)→ §18 Deferred。
> v1 = Huddle-only(§12.0);早晚会 deferred。

### 模式 2 · 异步协作(推进项目)
项目正常推进时,Annie 切入语音、一边做私事一边继续和 Lead 推进:
- **可真正触发 action**——对系统/团队与任何项目任务无区别。
- **语音≡文本**:能触发的行为完全一致;对她是语音进/出,对 Lead 收到的可能仍是文本。
- 用途:**汇报进度 / 接收 Guidance / 明确下一步**。

## 6. 能力边界 & 安全(已确认)

**贯穿原则:Voice = 现有文本交互的纯媒介投影,不加新能力/新闸/新机制,同行为、换 I/O。**

- 不可逆 / 高后果动作(ship PR、合并、关 runner):**跟 Text 模式完全一样**——Annie 说了
  Lead 就去执行,但**执行前会跟她说明一下**;该确认的确认、该直接做的直接做。
- **不需要专门的语音二次确认机制**;沿用 text 那道现有的确认行为。
- 不可逆动作**照旧 founder-gated**(FLY-175),只是媒介变语音。

## 7. Requirements

- R1-R4 — §3 Goals 对应的体验;用例形态见 §5,能力边界见 §6。
- R5 结论/进度落地 — 见 §8。
- R6 非技术措辞 + 听错兜底 — 见 §8b。

## 8. 结论 / 进度落地(块③,已确认 · 喂 FLY-548)

**按「一场 voice 是什么性质」分两类:**

### 8.1 有会话边界的(Huddle)= 结论落地

> **以 §12.0.4(R8 最终模型)为准**:Huddle 落地 = 发起自动建 1 条立项 issue → 聊完 **@ 的第一个
> Lead** 从它建 worktree + 把 **summary + action items 写进该 issue** → 存档关。早会/晚会已砍(§18)。
> (早前 R3「一场一 issue + GitHub markdown 归档」、R7「落 1-2 个 action-item issue」均被 R8 取代,不再赘述。)

### 8.2 普通 Voice Mode(边做事边语音)= 不专门记录
- 跟 text 工作**一模一样** —— 她说啥就继续往下做,**不新建 issue、不进 GitHub**。
- 语音→transcript→text 自然出现在**对应的 Discord thread** 上即为记录(与文字工作一致)。

## 8b. 非技术措辞 + 听错兜底(块④,按 Annie 原则推导 · 待 review)

- **措辞**:Lead 语音里**说人话**——零工程黑话 / 命令语法,用日常中文;要提技术概念就用
  等价白话(沿用 Flywheel 现有「不要工程黑话」规则)。Annie 是非技术 founder,自然口语交互。
- **听错兜底**:**无语音专属兜底机制**(继承 §6「voice≡text,不加新机制」)。防误听靠
  Lead **执行前的自然说明/复述**——复述跟她意思不符时她当场纠正即可;不可逆动作照旧
  founder-gated 多一层保护。

## 9. Success Metrics(块⑤,按 Annie 定性推导 · 待 review)

北极星:**Annie 真的用起来、且敢离屏顺畅协作**。

- **主信号(定性,Annie 定)**:三类 use case 端到端顺畅跑通 —— Huddle(聊清→落 issue→定
  下一步)、(后续)早晚会(有纪要)、离屏推进项目(语音≡文字、无卡顿)。
- **硬信号(轻量量化提案)**:① Annie 每周真用语音发起 Huddle / 离屏推进 ≥ 若干次(真用
  起来 = 成功的硬证据);② 语音发起的动作与「她本意」口径一致(≈0 次「听错做错」)。
  → 具体阈值等真跑一阵再定,不预设虚数(scoping:先能跑,再谈数)。

---

# Part II — 详细产品体验规格(Annie R4 要求的深度)

> 目标深度:**Tadashi 照着就能建出 Annie 要的、不用她再跟 eng 掰扯细节**。
> 不做技术选型(后端/延迟实现归 eng);定义的是**产品长什么样 + 端到端体验**。
> 依据:research.md(外部 UX 参考,带引用)+ Part I 已收敛决策。

## 12.0 v1 范围收敛(Annie R7:Huddle-only)⭐

> **重大范围收敛。** Annie 拍板把 v1 砍到只做 **Huddle**(试跑),下面 §12-16 里凡与此冲突的
> 以本节为准;被砍的进 §18 Deferred。

**v1 只做 Huddle · 砍掉的:**
- ❌ **砍 per-Lead 常规语音频道**——她不要(太多 + 有时要 2-3 个 Lead 在同一频道)。**改为一个
  共享 Huddle 语音频道**,动态成员。
- ❌ **砍早会/晚会**(§5 模式1 的 scheduled 层、§16 流③)——先只 Huddle 试跑,方向对了再说 → §18。

**Huddle v1 = 动态成员的临时语音会:**
1. **发起 + 拉人**:Annie 发起 Huddle、**@点名**她要的 Lead(1 个,或 2-3 个)→ 被点名的 Lead
   **进同一个共享语音频道** → 开聊。(机制详见 **§12.1**,已按真实 Discord 能力定稿:一个常驻
   `#huddle` VC + slash 发起 + Lead 自动进 + 她一键 join / 已在 VC 则零-tap。)
2. **混合频道原生就有(Annie 问的)**:Discord 语音频道**自带内置文字聊天**(Text-in-Voice,2021 起)
   —— 一个语音频道天然是 voice+text 混合面。所以:**语音在频道里聊 + transcript / 结论卡片 /
   action-item 链接落在该语音频道自带的文字区**(不用另开 text 频道)。
3. **聊**:多人(她 + 1-3 个 Lead bot)在同一频道语音一来一回(§14 动作三档、§15 延迟、barge-in 照旧)。
4. **结论落地(Annie R8 定)**:
   - **一发起 Huddle 自动建 1 条 issue** 当立项(标题如「2026-03-06 15:00 · 参与者 huddle」,含日期 + 参与者)。
   - 语音讨论 = 频道原生 message(在 `#huddle` 的 TIV 里)。
   - 聊完 → **@点名的第一个 Lead(主持/记录;单人聊就那人)** 从该 issue **建 worktree** + 把
     **summary + action items 写进该 issue** → **存档 + 关 issue**。
   - **谁做总结 = @ 的第一个 Lead(主持/记录)〔Annie R9 锁死〕**:单人聊就那人、多人就**第一个 @ 的 Lead**。
   > 演变:R3=一场一 issue + GitHub 归档;R7=不开 issue、落 1-2 个 action-item issue;**R8=一发起就
   > 自动建 1 个立项 issue,聊完把 summary + action items 写进它 + 建 worktree + 存档关闭**——回到
   > "一场一 issue",但带明确生命周期(立项 → worktree → 总结/action items → 存档关)。

## 12.1 发起 Huddle + 拉 Lead 进语音频道的机制(基于真实 Discord 能力 · research.md §12)

**一条硬约束(先说清)**:**Discord 不能 ring / 强拉一个"没在语音里"的人进服务器语音频道**
(ring 只存在于 DM/群 DM)。所以 **Annie 进 Huddle 必然要她自己一次 tap**;bot 那半边可以 100%
自动。唯一例外:她若已在服务器某个 VC → 系统可用 MOVE_MEMBERS **零-tap** 把她挪进 Huddle。
(Slack Huddle 本身也是 ring + 一键 Join,不强制 —— 所以体验差距其实很小。)

**用一个常驻复用的 `#huddle` 语音频道**(不是每场建临时频道):稳定深链她可 pin = 她的"huddle
按钮";稳定权限;频道自带文字区(TIV)天然当 Huddle 存档。

**最顺流程:**
1. **发起** —— Annie 在**任何文字频道、随时随地**打 **`/meet @Peter @Hiro`**(不用在语音频道;slash
   命令最顺:回复直接带"进 Huddle"按钮)。**同时自动建 1 条立项 issue**(§12.0.4)。
   〔**命令名 = `/meet`〔Annie R10 锁定〕**;其余候选(/call /huddle /sync /talk)进 backlog,**命令名
   做成可配置**以后想换也行。〕
2. **拉 Lead(全自动)** —— 被点名的 Lead bot ~1s 内自动进 `#huddle` 语音频道。这半个"ring"完美。
3. **"叫"Annie(诚实的一键)** —— 系统 @通知她(推送 = 我们的"ring")+ 给一个 Join 链接/按钮 →
   她 tap 一下(桌面)/ tap+确认(手机)进来;**她若已在别的 VC → 直接 MOVE_MEMBERS 零-tap 挪进来**。
   她一落地,一个 Lead 立刻语音招呼(像 Slack huddle 被接住)。
4. **聊** —— 各 Lead TTS 说话(稳);指定**一个 Lead 当"耳朵"做 STT**、把 transcript 分享给其余
   (只让一条进程吃"收音"这条脆弱腿)。多人一频道、per-speaker 分离没问题。turn-taking 是产品层
   的事(§17 同款)。
5. **落地(R8 · §12.0.4)** —— 她说「结束」或离开 → **@ 的第一个 Lead(主持/记录)** 从发起时那条
   立项 issue **建 worktree** + 把 **summary + action items 写进该 issue**,链接丢进 `#huddle` 自带
   文字区 → **存档 + 关 issue** → Leads 断开。

**⚠️ 前提假设 · 待 Tadashi 技术验证(Annie R8 要求这样标,别当已确认)**:整个 Voice 愿景**依赖
bot 能收音(STT)**,而这是**全 PRD 最大的技术不确定点** —— Discord 不官方支持 bot 收音,且
`@discordjs/voice` 0.19.x 在 **2026-03 起强制的 DAVE 端到端加密**下**当前是坏的**。**TTS 发送侧安全**。
→ **把"bot 能在 Discord 里可靠收音"当作待验证的前提假设**,归 **FLY-544 让 Tadashi 早验证**;缓解
路径(eng 定):patch davey / 用 py-cord 当"耳朵"bot(据报可用)/ 本地采音绕开。**若验证不通,整个
Huddle/离屏语音的可行性要重估。**

**ring gap 不可修**:别假装能强拉她 —— 把"推送通知 + 一键 join / 已在 VC 就零-tap"做到极好即可。

## 12. Discord 里长什么样(界面 / 交互)

**用常规 Voice Channel(VC),不用 Stage。** Stage 是广播式(讲者在上、观众静音举手),
1:1「聊清」不合适;VC 对称、drop-in、成员列表显示谁在,最贴 Huddle 心智。

- **谁在里面怎么显示**:VC 成员列表里 = Annie + 对应 Lead(bot)两个成员(bot 头像 = 该 Lead
  的 persona 头像)。
- **说话的视觉反馈**:用 Discord **原生绿色说话圈**(谁说话谁头像亮圈)——这是唯一免费视觉,
  表示"正在说"。
- **Text-in-Voice(TIV)= 关键界面**:每个 VC 自带一个文字聊天(右上聊天气泡进)。它是
  **实时字幕 / action 卡片 / 书面结论**的家 —— 让记录落在对话发生的同一个地方。她在 TIV 里
  能看到:滚动的对话文字、Lead 的状态行、结论卡片(带 Linear/GitHub 链接)。
- **"在听 / 在想 / 在说"状态**(她常不看屏,所以音频优先):
  - **说** = 绿说话圈(免费,视觉)。
  - **在听 / 在想** = ① 短 earcon 提示音(听到了/在处理)+ ② Lead 在 TIV 顶部**编辑一行状态**
    (🎙在听 · 🧠在想 · 💬在说);>1s 的思考(Lead 在跑工具/repo 活)加一句口头 filler「嗯,让我看一下」。
  - **麦关/暂停** = TIV 状态行显示"⏸ 已暂停",Lead 不接话。
- **不追求原生 AI 特效**:Discord 无原生字幕/AI UI;凡是绿圈之外的信号都由 bot 发进 TIV。
  (标杆是 ChatGPT 语音 / Gemini Live 的体验感,不是 Discord 现成控件。)

## 13. Voice 怎么接入 / 被唤起

**核心模型:「进频道 = 开始听」**——加入 VC 这个动作本身就是唤醒词,物理在频道内 = 会话边界
(像 meeting bot 可见地进会 = 录制开)。频道内**不需要唤醒词**。

三条入口:
1. **Huddle(即时,v1 唯一形态 · 机制详见 §12.0/§12.1)**:
   - Annie 打 `/meet @Peter @Hiro`(或 @点名 + huddle)→ **被点名的 Lead 自动进共享 `#huddle`
     语音频道**(~1s)→ 系统 @通知她 + Join 按钮,她 **tap 一下进来**(她若已在别的 VC → 零-tap
     被挪进)→ 她一落地 Lead 语音招呼(像被接住)→ 开聊。
   - **发起时自动建 1 条立项 issue**(日期+参与者);讨论走频道原生 message(TIV);聊完
     **@ 的第一个 Lead 从该 issue 建 worktree + 写 summary+action items → 存档关 issue**(§12.0.4)。
2. **普通 voice mode / "切耳机模式"(离屏推进项目)**:
   - 她进 VC 说「陪着我,我边做事边聊」→ 进入 **常开态**(Alexa Conversation-Mode / Gemini Live
     式):Lead 常驻听 + 答,支持 **Hold(说"先停一下"= 静音留上下文)/ End(说"就到这"= 结束)**。
   - 这一档**不新建 issue**;对话落对应 Discord thread(§8.2)。
   - **多个 agent 同时想找她时的推送/排队/回复交互 = §17(离屏推进核心机制)。**
   - **〔进/出切换 · Annie LOCK(R6)〕**
     - **进入**:在 **#flywheel-core 说/打「芝麻开门」**(=进入口令,与退出「芝麻关门」**对称**、
       好记;/headphone on 亦可)。进入在 core 打字/命令,无误触风险。
     - **全局生效**:一旦进入,**所有 Lead** 发给她的消息都转语音(不是子集)——直接喂进 §17 的
       推送/queue。这是**全局**开关,非 per-Lead。
     - **退出 · 〔Annie LOCK(R6)〕**:走语音,用**专用 Stop Word「芝麻关门」(中文短语)+ 一道确认步**。
       完整流:她说「**芝麻关门**」→ 系统回「**确认结束耳机模式?**」→ 她说「**对**」→ 退出。
       - **不靠 NLP 猜自然语义**,只认「芝麻关门」这个特定短语才触发结束;短语生僻(芝麻开门的反转、
         对话里近乎零基率)压误触发,**再加确认步兜底**——宁可偶尔重说,也绝不误挂。
       - 选词依据(research.md §11):短语>单词(单词误接受高);中文短语贴她母语直觉;塞音 g +
         开口韵 an/en、四声,家务闲聊里不出现。Annie 在"确认步"上**选了带确认**(比研究建议的
         "严阈值+撤销窗"更保守)——她为"绝不误挂"的安全优先,合理采纳。
       > 设计理由 = 安全词原则:结束是"高误触代价"动作(§15 silence≠结束、靠明确指令非静默,同纪律)。
       - **〔known-alternative · 记着别丢〕** 若 v1 的确认步用起来嫌烦,可换研究推荐方案:严检测阈值
         (极低误挂)+ 只在边界软确认 + ack 播报 + ~30 秒「回来」撤销窗(research.md §11)。Annie 现
         明确要**确认步求安全**,v1 先按她的;此为备选(也记进 §18 Deferred)。
     - **对称口令(已锁)**:进「芝麻开门」/ 出「芝麻关门」—— 一对,好记。
3. **早会 / 晚会(v1 不做,后续可选层)**:到点 Lead 主动发起 + 邀请她进 VC;每场立一个纪要 issue。

- **频道内对话**:开麦 + Follow-Up 式对话窗(她说完 Lead 答、答完继续听,无需每句唤醒);
  全程支持 **barge-in**(她一开口 Lead 立即停口)。
- **干净结束(必带 deliverable)**:她**离开 VC** 或 说「就这样 / 结束」→ Lead **口头一句 recap** +
  把结论贴进 TIV(+ 落 issue/thread)→ Lead 离开频道。结束不给产物 = 对话像蒸发,禁止。

## 14. 触发什么 action、怎么落地

承 §6(voice≡text)+ §8(落地)。**action 分三档确认(误识别代价越高、越显式)**:

| 档 | 动作举例 | 确认方式 |
|----|---------|---------|
| **(a) 可逆 / 信息类** | 建 issue、贴总结、起 research、派 Runner 开干、查状态 | **隐式**:直接做 + 口头 narrate「建好了,FLY-XXX」 |
| **(b) 可恢复但有后果** | 重排优先级、改 scope、改派 | **一句 readback**「我要把 X 设成最高优先级,对吧」;**沉默 ≠ 同意**,要她口头应 |
| **(c) 不可逆 / founder-gated** | merge、ship、关 runner | **显式 readback + TIV 文字卡片留凭据**——语音批准、**文字是收据**;照旧走现有 founder gate(FLY-175),仅媒介变语音,**不新增语音专属闸** |

- **写结论前先口头 recap**(建立信任的关键,综合 Granola/Ramble/Zoom 政策):Lead 说
  「所以我要:1)… 2)… 对吗?」→ 她口头确认/纠正 → **才**把 summary + action items 写进立项 issue
  (§12.0.4)。写进的内容**引用她的原话决定**,不只 paraphrase(可追溯 = 可信)。
- **落地(以 §12.0.4 为准)**:Huddle → 立项 issue(@ 的第一个 Lead 建 worktree + 写 summary+action
  items → 存档关);普通 voice → 落对应 Discord thread(语音→transcript→text 自然出现在 thread,不新建)。
- (b) 档确认**可随时间调成 per-动作类型可跳**(Siri 式:信任逐渐转交她),但**默认开着**。

## 15. Latency / 性能要求(业务层目标)

**业务层体验目标**(怎么达成归 eng;人类对话轮次间隔基准 ~200ms):

- **Huddle / 快速沟通**:**首音**(她说完 → Lead 开口)**≤ 800ms 好、≤ 1.2s 可接受、> 1.5s 算破**。
- **首音 ≠ 全答**:Lead 需要长答(在跑工具/repo 活,可能几十秒)时,**≤ 1s 内必须先口头 ack**
  「让我看一下」,真答可流式说 5-10s;绝不让她干等。
- **静默零反馈绝不 > 3s**(否则她以为崩了)——超 1s 无声就得有 earcon 或口头 filler 兜。
- **端点判定(判断她说完了)**:用**语义端点**(判"这句说完没")、停顿容忍 ~0.4-0.7s,**非裸静默
  阈值**;**普通 voice mode 放宽容忍**(她做家务会停顿),别把停顿当"聊完"→ 用明确的开关/说
  「就到这」来结束,而不是靠静默。
- **barge-in 必备**:她一开口,Lead **< 100ms 停 TTS**;忽略 backchannel(嗯 / 对 / 笑)不打断。
- **听错兜底**(§8b 的具体化):没听清 → **只问缺的那块**(隐式证明其余听到了)、给个说法例子;
  连续没听清 ≤ 2-3 次后**优雅回落**「我把听到的先记在 thread 里,错了你在那儿改」——**持久文字
  记录 = 兜底安全网**。confirm-by-consequence(「我归到 payments 项目,对吧」)优于回念乱码。

## 16. 端到端 UX 流(每 use case 一条)

**① Huddle(v1 唯一形态 · §12.0/§12.1)——「@点名拉人 → 聊清 → summarize 落 action items」**
1. Annie 在任意文字频道打 `/meet @Peter @Hiro`(命令名可配置)→ **自动建 1 条立项 issue**(日期+参与者)+ 被点名 Lead ~1s 自动进共享 `#huddle` 语音频道。
2. 系统 @通知她 + Join 按钮 → 她 tap 进来(或已在别的 VC 则零-tap 被挪进),绿圈亮,Lead 语音招呼(首音 < 1s)。
3. 多人开麦一来一回把事聊清:Lead 在听/在想有 earcon + TIV 状态行;她可随时打断(§14 动作三档 / §15 延迟适用)。
4. Lead 口头 recap「所以要:1)… 2)… 对吗?」→ Annie「对」(或纠正,回到 3)。
5. **@ 的第一个 Lead(主持/记录)** 从立项 issue **建 worktree** + 写 **summary + action items** 进该 issue → 链接贴进 `#huddle` TIV → **存档 + 关 issue**。
6. Annie 说「就这样」或离开 → Lead 收尾 + 断开。之后基于该 issue / worktree 开干。

**② 离屏推进项目(耳机模式 · 异步多-agent)——「边做家务边推进」**(机制 = §13 入口② + §17)
1. Annie 在 #flywheel-core 说/打「**芝麻开门**」→ 进耳机模式(全局:所有 Lead 消息转语音,喂 §17 queue)。
2. 消息**主动推给她**(推不拉):各 agent 换声线 + 报头(身份+issue+进度)一条条来(§17)。
3. 她语音查询「A / B / C 什么状态?」→ Lead 逐条答(首音 < 1s;查询 = 信息类,隐式)。
4. Annie「把 B 那个 PR ship 了」→ (c) 档:Lead readback「我要把 B 的 PR ship 上线,确认?」+ TIV
   贴确认卡 → Annie「确认」→ 走现有 founder gate 执行 → Lead narrate 结果。
5. 全程落**对应 Discord thread**,不新建 issue。
6. Annie 说「**芝麻关门**」→ 系统「确认结束耳机模式?」→「对」→ 退出。

**③ 早会 / 晚会(v1 不做 · 后续可选层 → §18)——「到点同步」**
〔deferred,非 v1〕到点 Lead 立一个纪要 issue + 邀请 → 语音过「今天做啥 / 做完啥」(基础查询、
无 action)→ summary 写进纪要 issue(落地形态到时按当时的 Huddle 模型定)。

## 16b. Huddle 块 · 待 Annie 逐条过清单(供 Lead relay · 已按 R7 收敛成 Huddle-only)

> 已按 §12.0 收敛:**只 Huddle、一个共享语音频道、动态成员、no per-Lead VC、no 早晚会**。
> 每条 = 一个可拍板的选择 + 出处。

| # | 体验选择(Huddle-only) | 出处 |
|---|---------------------|------|
| 1 | **一个共享 Huddle 语音频道**(非 per-Lead、非 Stage);语音频道自带文字区(TIV)= transcript/结论卡片/action-item 落点(voice+text 混合原生);说话绿圈;听/想=earcon+一行状态字 | §12.0 / §12 |
| 2 | **发起 + 拉人**:任意文字频道打 `/meet @Lead`(命令名可配置、随时随地)→ 自动建立项 issue + 被点名 Lead 自动进共享 VC → 她 tap Join 进来(或已在 VC 零-tap)→ 开聊 | §12.1 |
| 3 | **结论落地(R8)**:一发起自动建 1 立项 issue(日期+参与者);讨论=频道原生 message;聊完 **@第一个 Lead 从它建 worktree + 写 summary+action items 进去 → 存档关 issue** | §12.0.4 |
| 4 | **动作三档确认**:可逆=隐式做+口头 narrate;可恢复=一句 readback「对吗」;不可逆=显式 readback + TIV 收据 + 照旧 founder gate | §14 |
| 5 | **写结论前口头 recap**:Lead 念「所以我要:1…2…对吗」等她确认才写(防记错、记原话) | §14 |
| 6 | **延迟业务目标**:首音 ≤800ms 好 / >1.5s 破;需长答 ≤1s 内先 ack;静默不 >3s;barge-in <100ms;语义端点(非裸静默) | §15 |
| 7 | **干净结束**:她说结束/离开 → @第一个 Lead recap + 从立项 issue 建 worktree + 写 summary/action items + 存档关 issue → 结束(必带产物) | §16 流① |

## 17. 异步多-agent 语音模式(离屏推进的核心交互 · Annie R5 深化)

场景:Annie 离屏(做家务 / 戴耳机),**多个 agent(各 Lead / Runner)在推进多个项目**、各自有
消息要给她。这是 §13 入口② 「切耳机模式」+ §16 流② 的**核心交互机制**——把「多个 agent 同时
想找她」这件本来很乱的事,变成她能被动接住的一条线。

**设计原则(Annie 定,硬性):**

1. **推不拉(push, not pull)**:消息来了**主动推给她读**,她被动接收;**绝不**要她主动问
   「谁需要我 / 有啥新消息」。
2. **FIFO 无优先级**:消息按**到达顺序**排队处理,**不做优先级、不做打断**(先简单)。
3. **一条一条 + 一来一回**:一个 thread 可能一下来 10 条 → 全部**排进 queue**;每条走**完整回合**
   才到下一条:
   - 读这条(带语音报头,见原则 6)→ 问「要回吗?」
   - 她说 skip / 不用 → 这条标记处理完 → 推下一条;
   - 她说「要回」→ 她口述内容 → 该 agent **代发出** → 这条才算完 → 推下一条。
   - **msg1 没处理完,绝不抢念 msg2。**
4. **回哪条不用她指定**:一次只处理一条,**当前这条即目标**(一来一回天然锁定上下文),她
   不用说「回第几条」。
5. **per-agent 不同声线(硬能力要求)**:每个 agent 用**不同声线**,理想到**不用报身份也能
   听辨谁在说**。→ 写进 PRD 作**硬要求**。〔phasing 风险:FLY-542 EPIC 原把独立声线列 Phase 2
   (FLY-547);**此模式依赖它** → 需 flag 把 FLY-547 提前,见 §10 / 风险〕
6. **语音报头(替代 Discord 里本来看得到的「谁 / 哪个 thread」)**:每条**开口前先报
   身份 + issue + 一句进度提示**(她可能忘了这 issue 是啥)。
   例:「我是 Tadashi,FLY-906 语音设计 —— PRD 写到详细交互流了,想跟你确认一件事:……」

**〔已 LOCK · Annie 确认(R5+)〕**
- ① 语音报头**由发消息的那个 agent 附带**(而非中央统一生成)。✔
- ② 处理中(mid-turn)来的新消息**静默入队尾**,不打断当前回合。✔

**一条端到端流(离屏 · 多 agent):**
1. Annie 进耳机模式(§13 入口②)。
2. queue 里 FIFO 排着 3 条待推:agentA-msg1 / agentB-msg2 / agentA-msg3。
3. 推 msg1:**agentA 的声线**开口报头「我是 A,FLY-YY,<一句进度>,……」→ 读内容 → 问「要回吗?」
4. 她「不用」→ msg1 完 → 推 msg2:**agentB 的声线**报头 → 读 → 问「要回吗?」
5. 她「要回」→ 口述 → agentB 代发 → msg2 完 → 推 msg3。
6. 期间新来的消息**静默入队尾**(已锁②),不打断当前回合。
7. queue 空 → **静默待命**(推不拉,不催她);她说 Stop Word(§13)→ 退出耳机模式。

**逐字 worked example(给 eng 定措辞/回合边界的样板)**:
（Annie 在 #flywheel-core 说「进入耳机模式」→ 全局开启。queue: Tadashi/FLY-906 · Honey Lemon/FLY-880 · Tadashi/FLY-901）

- 🔊【Tadashi 声线】「我是 Tadashi。FLY-906,语音产品设计——PRD 写到详细交互流了。有个动作想跟你确认:要不要现在把结论落地那块也画进去?」
- 👤 Annie:「不用,先跳过。」
- 🔊【系统 ack】(轻 earcon)→ 下一条。
- 🔊【Honey Lemon 声线】「我是 Honey Lemon。FLY-880,内部 PM agent——那个共创流程 doc,Tadashi 想让我确认要不要拆两个子任务。」
- 👤 Annie:「要回。跟他说:先合成一个,别拆。」
- 🔊【Honey Lemon】「好,我转告他:先合成一个不拆。发出了。」(代发 → 落对应 Discord thread)
-  ——（此时 Tadashi 又来一条新消息 → 静默入队尾,不打断）——
- 🔊【Tadashi 声线】「我是 Tadashi。FLY-901,那个 feature-flag 注册——CI 绿了,等你点头就 ship。」
- 👤 Annie:「ship 吧。」
- 🔊【Tadashi】「你确认把 FLY-901 ship 上线?」(§14 c 档:不可逆强制 readback + TIV 贴确认卡)
- 👤 Annie:「确认。」→ 走现有 founder gate 执行 →「已 ship。」
- 🔊 queue 空 → 静默待命。稍后 Annie:「芝麻关门。」(Stop Word)→ 系统「确认结束耳机模式?」→ Annie「对」→ 退出。

要点:每条**换 agent 就换声线**(她不用问是谁);报头恒定语法 **身份→issue→一句进度**;
一条一来一回、skip/回 二选一才进下一条;mid-turn 新消息静默入队;不可逆动作单独走 §14 c 档确认。

**研究借鉴(已回 · Android Auto / Siri / Alexa 车载读+回流,详见 research.md §10)**:三家独立
收敛到同一契约,几乎逐条印证 Annie 的设计。据此把 §17 细化/校准如下:

- **四拍骨架**(印证):earcon → 身份报头 → 正文 → 开麦问处置(「回 / skip / 听详情?」)。
- **报头/正文两深度(新细化,待 Annie 认)**:借 Siri「长消息只报 sender」——我们**报头必念
  (身份+issue+一句进度),正文默认读;若某条很长则先给报头+摘要、问「要听全文吗」**。这样
  「重报头」不会淹没她。
- **回复回合自动开麦**(印证 · 做家务不能每句唤醒词)、**读回意图摘要再发**、**silence = defer 不发**、
  skip 一等公民、拒绝不重问。
- **发前确认默认 + 不可逆动作强制确认**(接 §14):普通回复可随时间开「自动发」(Siri 式),
  但 ship/merge/关 runner 永远强制确认。
- **一回合一个决定 + 可中断可恢复、她掌握节奏**(hands-free 安全元规则):「暂停/待会」中途要能用,
  该条回队列。

**〔FIFO 优先级 · Annie LOCK(R6)〕v1 = 纯 FIFO,不做优先级/阻塞分层。**
**〔Deferred(别丢的 tradeoff)〕** 研究显示消息其实有优先级类:某 Lead 的**阻塞类**(gate 问题在
等她拍)若排在 9 条 FYI 进度后,会拖慢解阻塞。**已知未来项**:阻塞类可能需要优先级——**真用了、
有感觉再加**。便宜方案备着(不是 v1):2-3 个类(阻塞 / 普通),非打分系统,只有最高类主动推、
其余等她拉。见 §18 Deferred。

## 18. Deferred / 已知未来项(别丢的 tradeoff,v1 不做)

- **阻塞类优先级(§17)**:v1 纯 FIFO;真用了、有感觉再加 2-3 类(阻塞/普通,非打分),只有阻塞类
  主动推。—— Annie「先简单」的红线下 deferred。
- **早会 / 晚会(§5 / §16 流③)· R7 砍**:v1 只做 Huddle 试跑,早晚会整块先砍;方向对了再加。
- **per-Lead 常规语音频道 · R7 砍**:改一个共享 Huddle 语音频道 + 动态成员(§12.0);不做每 Lead 一个常驻 VC。
- **GitHub markdown 归档 · 不在 R8 里**:R3 曾定 Huddle summary 提交 repo markdown 归档;**R8 最终模型
  (§12.0.4)的 Huddle 产出 = 立项 issue 里的 summary + action items**,不含 markdown 归档。需要长期
  文件存证时可另加,非 Huddle 必产。
- **per-Lead 独立声线的"提前"**:§17 靠 per-agent 声线(硬需求, FLY-547);EPIC 原列 Phase 2 →
  离屏模式若进 v1 需把 FLY-547 提前(§10 phasing flag)。
- **动作确认"自动发"档(§14 b)**:普通可逆动作的确认可随时间调成 per-类型可跳(Siri 式信任转交),
  v1 默认全开确认。
- **Stop Word 确认步的替代(§13)**:v1 用 Annie 定的确认步(说「芝麻关门」→「确认结束?」→「对」);
  known-alternative = 严检测阈值 + 边界软确认 + ack + ~30s「回来」撤销窗(research.md §11 推荐)。
  确认步 v1 用了嫌烦可换此。

---

## 10. Build issues 映射(PRD → 已有 Voice 实现树 · 供 Tadashi 参考)

> **交付方式(Annie 指示)**:**eng 实现 issue 由 Tadashi create**;本 PRD **不拆/不建** eng issue。
> 下表是 PRD 各节 → **已存在的** Voice 实现树(FLY-542 EPIC + 543-548)的**参考映射**,供 Tadashi
> 建 issue / 分解实现时对照。**STT 收音 = FLY-544 里 Tadashi 要先验证的前提假设,验通再往下建。**


| Issue | 承接本 PRD 的 |
|-------|-------------|
| FLY-543 核心可插拔 voice skill | §5 两模式 + §6 能力边界 + §14 action 三档 + §17 queue/turn-taking/语音报头 能力 |
| FLY-544 Discord voice bridge | §12 界面(共享 #huddle VC + TIV)+ §12.1 发起/拉人机制 + §17 多-agent 同频。**⚠️ 头号可行性风险**:bot 收音(STT)在强制 DAVE 下当前坏(patch davey / py-cord 耳朵 bot / 本地采音)——Tadashi 先验证 |
| FLY-545 用例① = **Huddle** | §12/§12.1 发起+拉人机制 + §16 流① + §8/§12.0.4 结论落地(立项 issue→worktree→总结) |
| FLY-546 用例② = **离屏推进(耳机模式 · 异步多-agent)** | §13 耳机模式进/出+Stop Word + §16 流② + §17 推送/queue/声线/报头(早晚会已砍→§18) |
| FLY-548 结论落地 pipeline | §12.0.4(R8:Huddle 发起自动建立项 issue → @第一个 Lead 建 worktree + 写 summary+action items → 存档关)；普通 voice=Discord thread + §14 写前口头 recap |
| **FLY-547 per-agent 声线** | ⚠️ **§17 把它列为硬能力要求**(多-agent 语音靠声线辨身份)。EPIC 原列 Phase 2 → **需 flag 提前**,否则 §17 离屏模式体验不成立 |

> **PM 验收 = 未来 FLY-830,现在不做。**
> **⚠️ Phasing flag(给 Lead / eng)**:§17 离屏多-agent 语音模式**依赖 per-agent 不同声线**
> (FLY-547);FLY-547 当前列 Phase 2。若离屏模式要进 v1,FLY-547 需相应提前 —— 这是产品
> 依赖,提请 Tadashi / Annie 定 phasing。

## 11. Topic 树 & 当前位置

- [x] 真实意图(law 4)
- [x] 块① 模式2 能力边界(action 安全)= voice≡text,无新机制 ✔ R2
- [x] 块② 模式1 形态(Huddle v1 / scheduled later)✔ R2
- [x] 块③ 结论/进度落地(按会话性质细分 + GitHub 存档机制)✔ R3/R4
- [x] 块④ 非技术措辞 + 听错兜底 ✔(§8b + §15 具体化)
- [x] 块⑤ 成功度量 ✔(§9)
- [x] **Part II 详细规格(§12-16)** ✔ R4 go-deep + 外部 research
- [x] **§17 异步多-agent 语音模式** ✔ R5 LOCK 全 7 点(含报头由发送 agent 附带 / mid-turn 静默入队尾)
- [x] Android Auto/Siri/Alexa 车载读+回研究 ✔ 回填 research.md §10 + 校准 §17
- [x] **耳机模式进/出** ✔ R6 LOCK(§13:core 说「进入耳机模式」/ 全局 / 退出=Stop Word)
- [x] **Stop Word + 对称口令** ✔ R6 LOCK 进「芝麻开门」/ 出「芝麻关门」+ 确认步
- [x] **FIFO** ✔ R6 LOCK v1 纯 FIFO(阻塞类优先级 → §18 Deferred)
- [x] **R7 范围收敛 = Huddle-only** ✔(§12.0:砍 per-Lead VC + 早晚会;共享 VC 动态成员;混合 TIV 频道)〔结论落地最终以 R8/§12.0.4 为准〕
- [x] **发起 Huddle + 拉 Lead 进语音频道 机制** ✔(§12.1 定稿:常驻 #huddle VC + slash 发起 + Lead 自动进 + 她一键/零-tap + 耳朵 bot;flag STT/DAVE 头号可行性风险给 eng)
- [x] **Huddle 结论落地(R8)** ✔:发起自动建立项 issue → @第一个 Lead 建 worktree+写 summary/action items → 存档关
- [x] **发起=任意文字频道、随时随地**(R8)✔;命令名做成可配置
- [x] **STT = 待 Tadashi 技术验证的前提假设**(R8 标注)✔
- [x] **谁做总结 = @ 的第一个 Lead** ✔ R9 锁死
- [~] Huddle 7 条体验选择(§16b):Lead 正带 Annie 逐条过
- [x] **命令名 = /meet** ✔ R10 锁定(其余候选进 backlog;命令名可配置)
- [x] **Huddle 机制全锁** ✔ — 剩 Annie 对完整 review 稿的最终 review + STT 待 Tadashi 验证
- [ ] R5 六条产品体验决定:Lead 会逐块带 Annie 拍(已在 §12/14/15,别丢)
- [ ] 〔可选未来〕FIFO vs 2-3 优先级类:经 Lead 抛回 Annie 定
- [ ] 全部块收敛(Lead 逐块喂确认)→ 建分段可批注交互 HTML 给 Annie review → 拆/链接 build issue → PR → approve gate
