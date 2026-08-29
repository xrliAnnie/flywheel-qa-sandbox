# FLY-2033 会议产物与闭环(C) — 探索
Issue: FLY-2033 (https://linear.app/geoforge3d/issue/FLY-2033/rayav5-会议产物与闭环c每场一单-notes-落-thread-复用互动卡)
日期: 2026-08-29
基于: 无(上游为 product/doc/FLY-1851-voice-meeting-mode/prd.md 与 engineering/doc/FLY-2032-raya-meeting-mode/plan.md)

---

## 0. 一句话

一场会(FLY-2032 已交付的会议骨架)结束后,自动出现一条完整的留痕链:**每场会一张 Linear issue → note taker 会后读转写出 notes → notes 与可互动 HTML 卡落在该 issue 的 Discord thread → 她在卡上逐条批 action items → finalize 成 doc 走 PR + Ship Card → 她 approve 进 main → issue 结**。

### 0.1 Founder 打回后的事实纠正(attempt 2)

- **会议模式没有被做成 Raya 专属。** FLY-2032 的 actor model 以 `leadId` 参数化;Raya、Tadashi、Honey Lemon 或其他有效 Lead 都走同一套会议状态机。FLY-2033 的 reconciler 只读取存档里的 `leadId`,没有 Raya allowlist/filter。
- 前一版 ship report 写「Raya 对 Linear、Flywheel 一无所知,也不该知道」是**报告表述错误**。代码事实只是 meeting 数据模块不 import Linear/Bridge,这是模块所有权边界,不是 Raya 这个 Lead 的知识、权限或可见性边界。
- 三个身份必须分开:参会者 = 本场 `leadId` 选中的 Lead;Raya/meeting runtime = 会议编排与原始证据的服务/物理目录;note taker = 会后独立 runner,目前由 Product Lead 的 `prd` route 承接。目录叫 `raya` 不会改变任何 Lead 的知识边界。
- Founder 已推翻「激活时补验」:本单实现只能交给 QA 做**ship 前真会硬门槛**,没有真实 issue-number Discord thread、note-taker HTML 卡投递和 founder 意见消费证据,不得声称验收完成。

## 1. 需求出处逐条(PRD v2.0 定稿,⛔ 以最新修订为准)

> ⚠️ PRD 是只追加账本:早出现的条款可能被晚出现的小节修订。下面每条都已核到最后修订状态。

| 条款 | 内容(核到最新) | 状态 |
|---|---|---|
| R-19 | 产物 = meeting notes 要点摘要,不是逐字 | ✅ 有效 |
| R-20 | **定了会就开一条 issue** 作为这场会的立项 | ✅ 有效(触发点 = 排会成功,不是会议结束) |
| R-21 | ~~会中有 runner 全程记~~ | 🔄 **已被 §41 修订**:note taker **不在场,会后读转写** |
| Q-5(谁记 notes) | issue 文本说「按 PRD 备选跑起来定」 | ✅ **已被 §41 关闭**:答案 = 会后的 note taker(R-59,她 2026-08-24 定,标注【暂时】——照它执行,⛔ 不记成终局拍板) |
| R-22 | 会后 note taker 整理成**一份可互动 HTML**,含 notes + action items | ✅ 有效,她二次确认(§47 ③a) |
| R-23 | **互动粒度**:讨论总结不需要她互动;action items 需要她**逐条**互动(要不要做) | ✅ 有效 |
| R-24 | 她逐条答完 → 这条 issue 就算结了 → 按定下来的内容决定下一步 | ✅ 有效 |
| R-24b | notes 发在**那条 issue 自己的 thread**;一 issue 一 thread 是现成机制 | ✅ 有效 |
| R-25 | notes 与最终 action items **ship 进 repository 归档** | ✅ 有效 |
| R-26 | 她不审 notes | 🔄 部分修订:**分法活着**(门在 action item 不在总结),但「不许等她」那半被取代 —— **现在要等她 approve**(哪怕只是点一下) |
| R-27 | 会后 HTML **复用现有互动卡片形状**(分节 / 每节可留言 / 一键汇总复制),不新造机制 | ✅ 有效 |
| R-30 | 没有 action items:HTML 只出 notes,同一条链,少一段互动,照样 ship | ✅ 有效 |
| R-41 | 四步:①会一结束 note taker 在 issue thread 总结出 HTML ②她 iterate ③finalize 成 doc ④提 PR、出 Ship Card,她 approve 才进 main | ✅ 有效(她逐字定的) |
| R-42 | 留痕**无条件**:所有会议永远留痕,⛔ 不做成可配置项 | ✅ 有效 |
| R-43 | **自动触发**:必须有东西自动察觉「会开完了」并拉起 note taker,⛔ 不许要人按 | ✅ 有效(这是需求;「怎么察觉」是本设计要定的机制) |
| R-45 | **不做快慢车道 · 不判断有没有 action item · 永远在那条 thread 里跟她 iterate · 节奏由她定** | ✅ 有效(R-44 已被她砍掉,划痕保留在 PRD) |
| R-59 | 会后留痕由 note taker 读转写承担(她定,【暂时】) | ✅ 有效 |
| R-60 | 会末**口头**总结(分身,FLY-2032 规矩④)与会后**读转写**(note taker,本单)是**两件事,并存** | 🔶 Lead 定向,成色照抄不升档 |

### 1.1 她砍掉过什么(⛔ 本设计不许复活)

- **新开 DAG 节点 / 专门 meeting-planner agent**:她 2026-08-21 砍了 ——「就那个 issue 开一个 runner 来做这个 note taker 就可以了」。⚠️ 她说的是「够了」不是「不要」,规模变了可以回来看;但**现阶段不做新节点**。
- **快慢车道 / 判断有无 action item**(R-44):她 2026-08-21 砍了。同一条链,HTML 里有没有 action item 段只是内容差异,不是流程分支。
- **触发器可配置 / 手动按记录键**:R-42/43,无条件 + 自动。

### 1.2 「初期」两个字(⛔ 不许抹平)

她说了两次「初期」——「初期我还是希望能去 review 这些 action items」。⇒ 记成【初期做法】;以后她不想审了,那一格是开着的,不用重新争取。设计上意味着:**审批环不做成硬编码的死流程,退出成本要低**(但按 R-45,不为此建开关系统 —— 到时改就是了)。

## 2. 上游已交付什么(FLY-2032 = V4,已 merge 进 raya main PR #5)

raya 仓(github.com/xrliAnnie/raya)main 上已有:

- `packages/contracts/src/meeting.ts`:Meeting schema v2(含 leadId)、`meetings/<id>/meeting.json` 不可变存档(`archiveMeeting`)、`meeting-events.jsonl` 追加账本、`notifications.json` 回执(routes: `shared-leads` / `lead-mailbox` / **`meeting-thread`**)、briefing 合同。
- `apps/brain/src/meeting.ts`:排会命令解析、`meeting_schedule:v1` 机器可读卡(**发进共享 Lead 频道、真 @ lead、从卡开 Discord thread**)、到点 tick、`finishTerminal`(🏁 终局播报 + 归档 + 清 current)。
- `apps/voice/src/evidence.ts` + `runtime.ts`:`RAYA_STATE_DIR/voice-evidence/events.jsonl` 逐事件留证,其中 `realtime_transcript` 事件带 `{ts, role, text}` —— **这就是 note taker 要读的「转写」**;会议窗口由 meeting 存档的时间字段界定。
- FLY-2032 plan §5 与本单的接口合同原文:「2033 读 `meetings/<id>/meeting.json` 存档(含 leadId)+ 会议窗口 transcript evidence」。

## 3. 本单要回答的架构问题(方案空间)

### Q-A 谁创建 Linear issue(R-20),什么时候

| 选项 | 做法 | 代价 |
|---|---|---|
| A1 raya brain 直连 Linear API | brain 排会成功后自己 createIssue | ❌ raya 仓引入 Linear SDK + 凭据,打破「raya 仓独立、Linear 归 flywheel」的现有分界 |
| A2 raya brain 调 flywheel 侧现有入口(CLI/Bridge API) | 排会成功 → 调 flywheel 已有的 issue 创建机制 | 需要 flywheel 侧有(或补)一个可编程创建入口;跨仓调用要 fail-open(排会不因 Linear 挂而失败) |
| A3 flywheel 侧监听 raya 账本 | Bridge/patrol 轮询 `meeting-events.jsonl`,见 scheduled 就开 issue | ❌ 新增一个常驻监听机制(新轮子),且两边状态对账复杂 |

倾向 **A2**(待 research 核实 flywheel 现有创建入口后定)。

### Q-B 「issue 自己的 thread」是哪条 thread

| 选项 | 做法 | 代价 |
|---|---|---|
| B1 复用 V4 排会卡开出的 thread | 排会卡 thread 登记为这条 issue 的 thread | thread 在共享 Lead 频道下,与 flywheel「issue thread」机制是不是同一套要核实 |
| B2 用 flywheel 标准 issue↔thread 机制 | issue 创建/派发时按现有机制开 thread | 可能出现**两条 thread**(排会卡一条 + issue 一条),她要在哪条里 iterate 会歧义 |

关键约束:R-24b 说「一 issue 一 thread 是现成的,不用新建机制」⇒ 无论选哪个,**不造第三种 thread**。待 research 查清 flywheel issue↔thread 的真实机制后定。

### Q-C 「自动察觉会开完了」的机制(R-43)

会议终局的权威信号 = raya brain `finishTerminal`(status ended/missed/cancelled + `archiveMeeting`)。候选:

| 选项 | 做法 | 代价 |
|---|---|---|
| C1 brain 终局时直接触发派工 | finishTerminal 后调 flywheel 侧入口把 note taker 拉起来 | 跨仓调用;但触发点唯一、语义最准 |
| C2 flywheel 轮询会议存档目录 | patrol 发现新 ended 存档 → 派工 | 新监听机制;有延迟;两边对账 |
| C3 Linear issue 状态驱动 | brain 只改 issue(如打 label/换 state),flywheel 现有的 issue 派发机制接手 | 复用现有「issue → runner」链路;brain 只需会一个动作 |

⚠️ ended / missed / cancelled 三种终局里,**只有 ended 需要 notes**;missed / cancelled 的 issue 怎么收(直接关?留言后关?)是 plan 要写清的边界。

### Q-D note taker 的宿主与输入

她已定:就 meeting issue 开一个 runner。runner 是标准 flywheel runner(有仓、有 worktree、有 doc-flow、有 founder HTML 能力)。输入 = `meetings/<id>/meeting.json` + `voice-evidence/events.jsonl` 会议窗口切片 + `briefing.md`(如有)。要定:
- runner 拿哪个 repo 的 worktree(notes ship 进哪个 repo 归档,R-25)——倾向 flywheel 仓(会议是跨项目的,统一归档);
- transcript 切片怎么给它(runner 自己读 RAYA_STATE_DIR?还是派工时把切片物化进 issue/文件?)——RAYA_STATE_DIR 在本机,runner 同机可读,但**路径要从派工上下文传入,不许 runner 猜**。

### Q-E 互动卡的 action-item 粒度(R-23)与「被消费」

现有互动卡合同 = 分节 + 每节 textarea(localStorage)+ 底部【页面意见汇总】一键复制。R-23 要「逐条要不要做」⇒ 在**同一卡片机制**内把每个 action item 渲染成一节,并加「采纳 / 不做 / 有意见」三态快选(写进同一 localStorage + 汇总文本)。她把汇总贴回 thread → note taker 消费并修订。**不新建后端、不新建评论服务** —— 汇总文本仍是唯一回传通道(与现行 founder review 完全同构)。待 research 确认现行卡片的消费端(谁解析【页面意见汇总】)。

## 4. 明确不做(本单)

- 不新开 DAG 节点、不建 meeting-planner agent(她砍的)。
- 不做快慢车道、不判断有无 action item(R-45)。
- 不碰会中交互 / 语音链路 / 简报内容(归 2032/2074/2030)。
- 不做「多场并发会议」:V4 至多一场活动会,本单跟随。
- 不替她创建 follow-up issue:R-24「按定下来的内容决定下一步」的「决定」是她在 thread 里做的;note taker 只落记录,不自作主张开新单(她要开,走现有 create-issue 路径)。
- 不做 notes 质量评审门:她不审 notes(R-26 分法),门只在 action items + 最终 approve。

## 5. 风险与开口

- **转写质量**:PRD §13 有转写错语料;note taker 只能写「真正被说出口的」,她 iterate 补 context(§41 已论证这是设计价值不是缺陷)。
- **RAYA_STATE_DIR 跨仓读**:runner 与 raya 同机,读文件可行,但生产路径是部署输入,不许硬编码。
- **missed/cancelled 会议的 issue 残留**:要在 plan 里给出确定性的收口。
- **她的批复形式**:互动卡汇总是文本粘贴,不是结构化 API —— note taker 解析她的自然语言批复,错读风险存在;缓解 = 修订稿在 thread 里再过她一遍(R-45 本来就要求 iterate 到她满意)。
