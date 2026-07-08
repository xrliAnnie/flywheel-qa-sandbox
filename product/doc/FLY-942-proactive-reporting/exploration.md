# FLY-942 Watchdog + Lead 主动汇报机制 — 探索

Issue: FLY-942 (https://linear.app/geoforge3d/issue/FLY-942/watchdog-lead-主动汇报机制-产品设计-prd让-annie-不再当人肉-qa)
日期: 2026-07-07
基于: 无(retro brief 直接派;上游 FLY-927 / FLY-915 / FLY-941 / FLY-964)

---

## 0. 一句话

runner 干完一轮 parked、或真卡住时,**系统主动、准确、及时地把状态推进对应 issue thread**,让 Annie 扫一眼(甚至不用扫、通知自己来)就知道谁在等她拍板、谁真卡了 —— **她不再每 30–60min 人肉巡查所有 runner**。核心是把"扫描/检测"变成看门狗的系统级职责,把 Lead 从"巡查工"变成"第一响应人",并用**去重 + 升级阶梯 + 每日兜底 digest** 同时满足两个看似矛盾的诉求:**绝不静默停着没人发现** ⨯ **Annie 离开数小时也绝不刷屏**。

---

## 1. 问题 / 用户 / 目标

- **Problem**:runner 经常干完一轮 parked(等 founder 拍板)或真卡住,**没人主动汇报** → Annie 被迫定时人肉巡查每个 runner(当"人肉 QA"),累且不 scalable。要她拍的决策埋在长消息里 / 不进对应 thread / 不够醒目。
- **Users**:
  - **Annie(founder)** —— 只想在"真需要她拍板 / 真卡了"时被精准、醒目地叫到,其余时间不被打扰,离开数小时回来能一眼看清"哪些在等我"。
  - **Lead(部门负责人)** —— 从"要会手动巡查"解放为"看门狗一响我第一个排查",自愈或 relay。
  - **Runner / Watchdog / Bridge** —— 状态的产生者 / 检测者 / 投递者。
- **Goal**:
  1. **绝不静默**:任何 runner 停在需要人介入的状态,系统一定会让"该负责的人"知道(不靠 Annie 主动发现)。
  2. **不刷屏**:无新状态变化 = 无新通知;Annie 离开数小时回来不被 N 条重复刷屏。
  3. **决策醒目、进对应 thread**:每个要 Annie 拍的 = 一张独立、固定格式、在对应 issue thread 里的卡,一事一卡。
  4. **可扩展**:检测是系统级看门狗的活,新 Lead / generic Lead 不必"会巡查"就自动被覆盖。
- **Non-goals(明确划走)**:
  - **检测引擎实现**(park 元组、真实 stage、去重键、1h 阈值、owner 路由、@-target)= **FLY-927 Watchdog v2**。本 PRD 只定"检测到之后,产品对 founder 表现成什么样"。
  - **告警频道架构 / bot 工单队列 / 发送方门禁 / #flywheel-alerts vs #flywheel-notify** = **FLY-915**(Annie 已 lgtm)。本 PRD 复用其 thread 落点机制(`founder-thread-notifier`)。
  - **tool-call-leak 检测** = **FLY-941**(它是"真卡住"里的一个检测类别,归看门狗抓)。
  - **状态的持久显示**(置顶 pinned / thread 标题徽章 / 4 态 / 返工模型)= **FLY-964**。本 PRD 的 push 通知与 964 显示**同源**(同一份真实 stage),永不打架。
  - eng 实现细节 = Tadashi。本 PRD 只定**产品行为 + 机制契约**。

---

## 2. 核心洞察:两个互补的界面 + 一条升级阶梯,全部同源

Annie 现在人肉 QA 的本质是:**唯一能"知道 runner 停了"的界面是她主动去看**。要根治,得让"知道"这件事变成系统 push 给对的人。

把这件事拆成两个界面 + 一条阶梯:

| | 是什么 | 谁看 | 触发 | 归属 |
|---|---|---|---|---|
| **持久显示(pull)** | 置顶消息 + thread 标题徽章,恒在,反映"现在整体在哪一步" | Annie 想看时扫一眼 | 每个生命周期事件**静默**重算刷新 | **FLY-964**(已定) |
| **主动推送(push)** | 状态变时往 thread 发的**一条新的带类型通知**(会 ping) | 通知自己来找 Annie / 责任 Lead | **只在"球换手到 founder / Lead 已替你决定 / 真卡了"时** push | **本 PRD** |
| **升级阶梯(safety net)** | 超时未处理 → owner Lead 先接 → 兜底 digest | 责任 Lead → (兜底)Annie | 阈值(1h,FLY-927)+ 每日一次 | 检测=FLY-927;founder 体验=本 PRD |

**为什么两个界面而不是一个**:光有持久显示(964)不够——它是 pull,Annie 还得主动去看 = 还在人肉 QA。光有 push 又会刷屏。**持久显示恒在但静默,推送稀有但高信号**;两者同源(都从 `flywheel-comm stage set` 上报的真实 stage + park 元组派生),所以永不矛盾。**这条"同源"是"准确性=北极星"的技术底座**(接 FLY-964 §4 / FLY-927 fix#1:按真实 stage 报,不靠 heuristic 猜——FLY-912 那条"Code Review 卡 3h"错的措辞就是猜出来的)。

---

## 3. 状态 → 通知映射(把 5 块串起来的骨架)

一个 session 在任一时刻,按真实 stage + park 元组,归到"球在谁手上":

| 球在谁 | 触发状态(真实 stage 派生) | push? | 通知形态 | 对应 5 块 |
|---|---|---|---|---|
| **runner / CI**(在干活 / 跑测试 / CI 中) | running、test、CI 中 | ❌ 不 push | 仅 964 置顶显 ▶ 进行中 | — |
| **founder — 干完等你拍** | parked 在 approve_to_ship / ship gate,活已完成且健康 | ✅ **立即 push** | 『✅ [FLY-XXX] 干完了,等你拍 X』| 块3 ✅ |
| **founder — 需要你做个决定** | 要 founder 二选一 / 拍方向 | 🔴 **立即 push(决策卡)** | 『🔴 [FLY-XXX] 需要你拍:<一句话> — A / B — 建议 X』| 块4 决策卡 |
| **某 Lead — 真卡了** | 真 stuck / hang / rate-limit 冻结 / tool-leak(FLY-941) | 🔴 **push + @该 Lead** | 『🔴 [FLY-XXX] 卡住(在等 <Lead>):停在 <真实stage> 已 Nh』| 块2/5 |
| **某 Lead — 压着没 relay**(HL 2026-07-07 补) | runner 抛了需 founder relay 的东西,但走 Lead 中转、Lead 还没转 | ⏱ **计时 → 超时先 nudge 该 Lead**(不先让 Annie 看到) | (先私下 nudge Lead;Lead 转成 ✅/🔴 卡进 thread) | 块5 |
| **founder — Lead 已替你决定** | Lead 自主拍了个可逆的技术决定 | 🟡 **FYI** | 『🟡 [FLY-XXX] Lead 已替你决定 Z(可回退)』| 块3 🟡 |

**关键:两个时刻,别混**(这是相对 FLY-927 的核心 reframe):
1. **立即正向 surface**(事件驱动):runner 一 park-等-founder,**立刻** push 一条 ✅ / 🔴,**不等 1h**。它不是告警、是把"该你了"正向、及时地端到你面前。
2. **超时升级**(FLY-927 阈值):同一条若 1h 仍没人处理 → 看门狗按 FLY-927 升级(owner Lead 先接)。1h 阈值治的是"拖太久没人管",**不是**首次 surface 的门槛。

---

## 4. 反刷屏 + 绝不静默:去重与升级阶梯(块1 的心脏)

两个诉求看似矛盾,用一条阶梯化解:

1. **去重(dedup)**:一条 push 对每个 (issue, 球在谁) 转移**只发一次**。同状态不重复报。**球必须真的换手**才会再 push。→ Annie 离开 5h、期间无状态变化 = 0 条新通知。
2. **绝不对 Annie 定时 re-ping**:首次 ✅/🔴 push 之后,**不**按计时器反复戳 Annie(那就是刷屏)。
3. **超时 → 先找 Lead,不是再戳 Annie**(FLY-927 owner 首响应):一条"球在 founder"的项若超阈未处理,看门狗**先 @ 责任 Lead**——Lead 的活是确保这张卡够醒目 / 必要时 relay 提醒,**不是**再刷 Annie。(真只有 Annie 能拍的决定,Lead 不能替她拍,但能保证"它没被埋掉"。)
4. **每日兜底 digest**:每天一次,把**当前所有"在等你"的开放项**(未处理的决策卡 + parked-等-founder)汇总成一条 founder 面向的 roll-up。→ 即便某次 push 漏了(Bridge 短暂 down 等),也绝不会有东西静默烂在那。

**这四条合起来 = "绝不静默停着" ⨯ "离开数小时不刷屏"**:立即 push 一次(去重)+ 不再 re-spam + 超时先找 Lead + 每日兜底。这是本 PRD 的产品灵魂。

---

## 5. Lead 响应契约(块5)+ Lead-relay 延迟看门(HL 2026-07-07 补)

看门狗一响(任何 stuck 类),**责任 Lead 是第一响应人**,不是 Annie:
1. Lead 第一个排查该 session。
2. 能自愈的自愈(例:Bridge 短暂 down 致 publish 失败 → Bridge 恢复后 runner 重试即好;单 Enter 解卡;respawn+resume)。
3. 自愈不了 / 真需要 Annie 拍 → **relay 一张决策卡**进对应 thread(不是丢一句"卡了"给 Annie)。
4. **绝不静默**:Lead 收到看门狗信号后必须留下动作痕迹(ACK / 自愈记录 / relay),不允许"看到了不动"。

### 5.1 两条投递路径 —— 化解块3"不经 Lead 手转" ⨯ "Lead 压着没 relay"的张力

块3 说"Bridge 自动往 thread 发、不经 Lead 手转";HL 又指出"Lead 压着 runner surfaced 的东西没转"是真 case。二者**不矛盾**,是按状态可判定性分两条路径:

- **路径 A · 机器可明判的状态 → Bridge 直投 thread(不经 Lead)**:runner parked 在 ship gate = ✅干完等你拍;正式 gate question = 🔴决策卡 —— 这些从真实 stage / park 元组能明确判定,**Bridge 直接发对应 thread、只 @ founder**(块3 的"不经 Lead 手转"就是这条,消灭了大部分 Lead-relay 依赖)。
- **路径 B · 需 Lead 判断/塑形的状态 → Lead 是中转,但看门狗盯它的 relay 延迟**:runner 抛出一个需 Lead 先塑形成决策卡(或先自己试着解)的问题 → Lead 是中转 hop。**看门狗对这条 hop 计时**:超时 Lead 还没 relay/ACK → **先私下 nudge 该 Lead**(给窗口自转,别让 Annie 靠"看门狗 flag"先发现)。HL 今天漏转 978 round-1 就是这条:watchdog 本应先 nudge HL,而非 Annie 先看到。

**这两条合起来才完整**:路径 A 把常见态直投(去掉 relay 依赖),路径 B 用"Lead-relay 延迟看门"堵住"Lead 坐着不转"的漏。都归到 §3 第 3 条"超时先 @ Lead 不再戳 Annie"。

这把 Annie 定的 reframe("Lead=响应,不巡查")落成可验收的行为契约。检测/路由/@-target/relay 计时由 FLY-927 提供;本 PRD 定"Lead 收到后必须做什么 + relay 超时怎么盯"。

---

## 5.5 检测层:要准确检测什么 + 准确性=北极星(融 FLY-878 / 975 / 976 + ghost / alive-flag)

> Cass 要 FLY-878 / 975 / 976 跟 942 收敛 → 本 PRD 是收敛这一族的**产品层**。主动汇报(§2–§5)只有在**检测足够准**时才成立 —— "状态显示骗你一次你就再也懒得看"(FLY-964 §4 同根)。所以**准确性是本 PRD 的北极星**,检测层与汇报层同等重要。

### 5.5.1 准确性为什么是北极星(现状为什么不准)

现有检测是**机械规则**(pane-hash 冻结 + 固定错误模式 + `isIdleHealthyPane` 抑制器),两头都错:
- **漏报**(false negative,最致命 —— 直接逼 Annie 人肉巡查):FLY-975/546 —— runner 撞 `Server error mid-response` 后停在空 `❯` 静默 22min,被 `isIdleHealthyPane` 当"健康 idle"压掉;错误模式也不认(只认 Stream idle timeout / 限流)。**FLY-927 不修这条**(没动 isIdleHealthyPane、没加该错误模式)。
- **误报**(false positive → 刷屏 → Annie 不看了):把正在干长活的 runner 当卡死(FLY-871 一天两次误报);ghost 死着还一直 fire `session_stuck`(FLY-970)。
- **alive-flag 不可信**:alive=true 但登出 / 卡 rate-limit 菜单 / 冻结(FLY-909 登出却 alive=true)→ **必须 capture pane 看真状态才准**。
- **归因错**:FLY-912 "Code Review 卡 3h" 是靠画面猜的(真相是 approve gate 等 founder)→ 措辞错 = 不可信。

### 5.5.2 准确性方案:从机械规则 → 能理解上下文的判断(FLY-976,Annie 定方向)

Annie 的根因判断(FLY-976):**看门狗最大问题是它不是 LLM,没法理解"现在到底什么状况"**。方向 = 让看门狗像人一样理解"这 session 卡没卡、卡在哪、该怎么办"。收敛建议(待 Annie 拍):

- **分层判断(便宜初筛 + 贵判断兜底)**:
  1. **机械快路**(零 token,便宜):明确态直接判 —— 真实 stage / park 元组明判(parked-at-gate = 合法等 founder;running+pane 活跃 = 健康;已知错误模式秒认)。
  2. **LLM 判断层**(可疑才升级,省 token):读 pane 尾部 + 真实 stage + park 元组 + 最近事件 → 输出「卡住 / 健康 idle / 正常等待」+ 归因(球在谁)+ 建议动作(nudge / respawn / 切账号 / @人)。**正是 546 那种"报错后静默 idle"要的**——机械分不清,LLM 能。
  3. **降级永不静默**(FLY-878 标签分层):认不出 → 走 AI 兜底;仍不确定 → `fail-suspicious` 附 pane 原文上报(标签变糙、但绝不吞)。
- **为什么不用纯机械(FLY-878 的零-token 方案)**:878 的"状态型+通信感知+零 token"已是机械的升级版,但 975 证明**纯机械仍漏**(Server-error idle)。所以收敛到 976 的 hybrid(机械快路 + LLM 兜底),不是二选一。

### 5.5.3 要检测什么(catalog —— 喂 FLY-927/976 的检测清单)

| 检测类 | 判定(准确性要点) | 归因(球在谁)| 来源 |
|---|---|---|---|
| 干完 parked 等 founder | park 元组明判(approve gate / ship gate) | founder | 块3 ✅ |
| 需 founder 决策 | 正式 gate question / runner surfaced 决策 | founder | 块4 🔴 |
| runner 真卡(hang) | capture pane:冻住 + 无进展(非健康 idle)| lead | 878/975 |
| **报错后静默 idle** | pane 有非预期 error 文本 + 冻住 → **不得被 isIdleHealthyPane 压掉** | lead | **FLY-975(必修)** |
| rate-limit / 冻结 / 登出 | capture pane 认菜单/登出(**非 alive-flag**);理想自动切账号 | lead/infra | alive-flag 家族 / 915 |
| tool-call-leak | 输出含未执行的 invoke 文字块 | lead | **FLY-941** |
| **Lead 压着没 relay** | runner 抛需 relay 的东西、Lead 应答超时未转 | lead(先 nudge)| **FLY-878 scenario 3 / HL** |
| **dead-but-registered ghost** | status=running 但 alive=false 僵尸 | 系统(检测+清)| **FLY-970/973** |

### 5.5.4 over-notify 抑制(治 ghost 刷屏)

已知 / 正在清 / 已升级的问题 **绝不 re-alert**(FLY-970 死着还一直 fire session_stuck)。复用去重设施(claims.db / episode-latch),并对"正在清理中"的 ghost 加抑制态。这是"绝不静默 ⨯ 不刷屏"里"不刷屏"的一条硬约束。

### 5.5.5 mid-turn hard-stop(相邻能力,标边界)

现状 queued STOP / goal-edit 只在 turn 边界生效 → runner 会烧完 token 做完不想要的才停(FLY-915 v2 就多做了个 PRD+PR)。**需求**:能 kill 当前 turn。**边界**:这是 harness 能力,偏 eng;本 PRD 列为需求(让跑偏的 runner 能被及时叫停),实现归 eng(可能独立 issue)。待 Annie 定是否纳入 942 scope。

---

## 6. 组件职责(已按 codebase 审计校准真实组件名/文件)

> 已审计。标注 **[已建]** / **[计划中,归属 X]** —— 本 PRD 只做产品层串联,绝不重做已建/别 issue 的机制。

- **Runner**:
  - **[已建]** 每次状态变按 `flywheel-comm stage set <stage>` 上报**真实 stage**(`packages/flywheel-comm/src/commands/stage.ts` → `stage_changed` 事件 → Bridge `sessions.session_stage` 列)。13 个合法 stage。这是"按真实 stage 报、不靠猜"的权威源(FLY-912 那条错措辞就是靠画面猜的)。
  - **[已建]** 干完一轮 parked 用 `flywheel-comm park`(→ CommDB `runner_declared_states` kind `parked`,`declare-state.ts`)。**⚠️ 现状痛点**:park 后**看门狗全压制唤醒 = 静默**,没有任何主动 ✅ 推送 → 正是本 PRD 要补的核心空白。
- **Watchdog(检测,归 FLY-927)**:
  - **[已建]** 现有三检测器:`LeadWatchdog`(Lead pane infra 冻结:rate/usage/login/crash)、`stuck-candidate`+`stuck-runner-detector`(FLY-195,停滞 runner,10min 阈值 + owner Lead 5min grace → `runner_stuck_unhandled` founder page)、`RunnerIdleWatchdog`。
  - **[计划中,FLY-927]** park 元组(真实stage / blocking_party = founder|lead|runner|ci / owner / waiting_since)+ 1h 阈值 + @-target owner 首响应 = **尚未实现**,是本 PRD 检测层的依赖。
- **Bridge(投递)**:
  - **[已建]** `founder-thread-notifier.ts` 已能往 `[FLY-XX]` thread 发带类型通知、只 @ founder(现有类型:🧠 Brainstorm gate / 🚀 Ship gate 等你批准 / 🚨 Runner 卡住 / ✅completed / 🔴failed / ⛔blocked)。**绝不进告警频道**(FLY-523 已否决那条路)。
  - **[已建]** `GatePoller` + `maybeEmitFounderThreadFallback`(FLY-605,approve_to_ship / brainstorm)+ ✅-reaction 批准(FLY-799)。
  - **[本 PRD 要补]** ① park-等-founder 的**即时** ✅ 正向 push(现状 park 静默)② `🟡 Lead 已替你决定` 类型(未建)③ **决策卡固定格式**(现状只有 free-text gate body)④ per-runner "在等 Annie" 的每日兜底 digest(现 DigestService=已 ship issue、StandupService=粗计数,都不含)。
  - **[已建]** 去重设施:`claims.db`(`event_id = sha1(project|lead|kind|signature)`,signature 默认 `YYYYMMDD` → 每 (project,lead,kind) 每天至多一条)+ `lead_events` UNIQUE + episode-latch。本 PRD **复用**,不新建。
- **Lead**:第一响应人(契约见 §5)。现状 `stuck-runner-detector` 已有 owner Lead 5min grace,但未形式化为"必须 ACK/自愈/relay、绝不静默"的契约。
- **告警落点/频道(归 FLY-915)**:三落点(thread / #flywheel-alerts 工单队列 / #flywheel-notify digest)= FLY-915 已 lgtm。本 PRD 的 push 走 thread 落点。
- **FLY-964 显示层**:同源持久显示(置顶/标题/4 态/返工),不在本 PRD 重做。

数据流(草图,research.md 精化):
`runner 状态变 → stage set(真实stage)+ park 声明 → Watchdog(FLY-927)检测/分类(在等谁)/去重 → Bridge 渲染带类型通知(founder-thread-notifier)→ 对应 [FLY-XX] thread(push)/ 每日 digest(兜底)→ Lead 首响应 / Annie 拍板`

---

## 7. 要跟 Annie converge 的 clarify 集(HL relay;小步多轮,建议排序)

> Annie 交付:逐块 converge,不一次性甩全 PRD。每条给我的建议 + 开放点。**建议排序**:round 2 = Q1+Q2(准确性机制+验收,北极星,最基础);round 3 = Q3(阈值/阶梯);round 4 = Q4–Q7(汇报细节);round 5 = Q8–Q10(边界/scope)。

**框架** ✅ round-1 HL 已确认(两界面/两时刻/反刷屏阶梯/边界干净),并补第 5 球态"Lead 压着没 relay"。待 Annie 框架终确认。

### Group 1 · 检测准确性(北极星,先过)
- **Q1 准确性机制**:确认走 **FLY-976 的 hybrid**(机械快路省 token 判明确态 + LLM 判断层兜底可疑态,读 pane/真实stage/park元组 → 卡/健康idle/正常等待 + 归因 + 建议动作)作为 THE 准确性机制?〔rec:是——纯机械(878 零-token)已被 975/546 证明会漏〕
- **Q2 北极星验收(准确率怎么衡量)**:什么算"够准"?〔rec:分三面 —— **漏报 FN**(missed 真 stall,如 546;最致命=直接逼 Annie 人肉巡查,目标近零)/ **误报 FP**(alert 健康 runner;可容忍低)/ **措辞归因准确**(别再"Code Review 卡 3h" 猜错)。**FN 权重 >> FP**(漏一个比偶尔误报一个糟得多)〕
- **Q3 阈值/时序(nudge-Lead 先于 founder)**:878 说 20min→Lead、927 说 1h,怎么统一?〔rec:**分层可配**(global+per-project):静默停车 ~20min → 先 nudge 责任 Lead;Lead 未解/未转 再 +X → 升级 founder。**✅干完等你拍 = park 那刻立即 push,不受此超时阈值管**(它是正向 surface,不是超时告警)〕

### Group 2 · 主动汇报细节(round-1 已确认,补细节)
- **Q4 digest 触发模型**:event vs 定时?〔rec:**两者** —— event 主动 push(球换手,主)+ 每日兜底 digest(网底)。HL brief 已倾向〕
- **Q5 digest 内容/落点/时点**:〔rec:内容 = 当前所有"在等你"开放项(谁在跑/谁 parked 等你/谁真卡/什么要你决策 vs Lead 已替你决);时点 = 每日 1 次;**落点 = founder 面向 roll-up,待 Annie 定**(她的 DM? 某专属频道?与 FLY-915 #flywheel-notify 的非-@ 系统 digest 不同——这是"你的开放队列",可轻 @)〕
- **Q6 决策卡固定字段**:〔rec:`🔴 [FLY-XXX] 需要你拍:<一句话> — 选项 A / 选项 B — 建议 X(一句理由)`;一事一卡、立即、**绝不批量进 digest**〕确认字段。
- **Q7 🟡 Lead 已替你决定**:push(ping)还是只进 digest?〔rec:**只进 digest / 安静 thread 帖,不 ping**(它是 FYI 透明,不需打断)〕

### Group 3 · 边界 / scope
- **Q8 942 ↔ 915 边界**:〔rec:**942 = 检测(要检测什么+准确性北极星)+ 主动汇报(founder 体验:何时/怎么 surface)**;**915 = 通知管线(频道架构/bot 工单队列/发送方门禁/profile 切换)**。942 喂 thread-落点需求给 915,不重做管线〕
- **Q9 ghost 检测+抑制**:纳入 942 需求?〔rec:**检测 dead-but-registered(status=running/alive=false)+ over-notify 抑制(已知/正清理的别 re-alert)= 942 需求**;清理机制/scope 归属 = eng(927/973)〕
- **Q10 mid-turn hard-stop**:纳入 942 scope 还是兄弟 issue?〔rec:列为**需求**(让跑偏 runner 能被及时叫停,别烧完 token),但实现 = harness/eng,**可能独立 issue**;待 Annie 定是否算 942 一部分〕

---

## 8. 假设(实现前显式列出,请 Annie 证伪)

1. runner 的真实 stage 已经可靠上报(`flywheel-comm stage set`)且 Bridge 能读到 —— 这是"按真实 stage 报、不靠猜"的前提(FLY-927 fix#1 也建立在此)。待审计确认覆盖度。
2. 每条 issue 已有专属 `[FLY-XX]` chat thread,且 `founder-thread-notifier` 能往里发(FLY-523/818 已在跑)。
3. "干完 parked 等你拍"是一个可从 stage/park 元组明确判定的状态(approve_to_ship / ship gate),不是靠画面猜。
4. 去重键可复用 FLY-915/927 的 claims.db / episode-latch,不需新建去重设施。
5. Annie 要的"主动"= 通知 push 到 thread + 她被 ping,而不是"Lead 手动把状态转述给她"(块3 明确"不经 Lead 手转")。
