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

## 2. 核心洞察:正常路径自洽,看门狗只兜"漏"(Annie 2026-07-07 深度 revise)

> **⚠️ 汇报层最终形态(Annie 2026-07-08 定稿,大幅砍简单)以 `prd.md` §4 为准**:所有汇报**进对应 [FLY-XX] thread、自然语言**;**无 founder 频道 / 无决策卡模板 / 无 digest**;**唯一主动 @ Annie = 真卡死(case c)/ Lead 接不住**。本节以下的 consolidate 接收点 / 每日 digest 是 07-07 converge 中间态,已被简化取代;检测层(§5.5,兜两漏 + 三态)不变。

> **⚠️ 关键 revise**:早稿把汇报层设计成"球一换手就 push"——**Annie 否掉了**。因为换手时 runner 大概率自己会找 Lead、Lead 处理或 relay —— 这条**正常路径自己就 work**,系统不该在它正常运转时插一脚(那就是噪音 = 病症④)。

**看门狗真正要兜的是正常路径的两类失败(漏):**
- **漏①:runner 忘了找 Lead** —— 停/需要人,却没告诉 Lead(= FLY-878 场景1)。
- **漏②:Lead 漏应答** —— runner 找了 Lead,但 Lead 忙、把 message 忽略了(= FLY-878 场景3:看门狗也看 Lead 应答时效)。

其余换手(runner 找了 + Lead 处理了)→ **看门狗静默,不管**。

所以汇报层 = **两个界面 + 一张时间阈值的兜漏网**,全部同源:

| | 是什么 | 谁看 | 触发 |
|---|---|---|---|
| 持久显示(FLY-964,pull) | 置顶/标题恒在、静默刷新 | Annie 想看时扫一眼 | 每生命周期事件重算 |
| 看门狗兜漏(本 PRD,**时间阈值**) | 正常路径失败(两漏 + 真 stall)且**超时间阈值没人动** → 报责任 Lead(consolidate 接收点) | 责任 Lead 先接;解不了才到 Annie | **停在那没人动 + 超时间阈值** |

**为什么不是 push-every-change**:正常路径 work 时插 push = 噪音(病症④);看门狗只在路径"漏"了、且**超时间阈值没人动**时才响 = 高信号、不刷屏。同源(真实 stage + park 元组派生)保证"准"(北极星),与 964 显示永不打架(接 FLY-927 fix#1:按真实 stage 报不靠猜——FLY-912"Code Review 卡 3h"就是猜错的)。

---

## 3. 看门狗抓什么 + 报给谁(时间阈值,不即时)

一个 session 停在需要人介入的态、且**超过时间阈值没人动**,看门狗按下面分类,**先报责任 Lead**(不即时、不先戳 Annie):

| 检测类(超阈值才响) | 判定 | 先报谁 | 来源 |
|---|---|---|---|
| **漏①:runner 没找 Lead** | parked/需要人,但无对 Lead 的通信 | 责任 Lead | 878 s1 |
| **漏②:Lead 漏应答** | runner 找了 Lead,Lead 超应答时效未理 | 提醒该 Lead | 878 s3 / HL |
| 真 stall / error | capture pane:冻住 + 无进展(非健康 idle) | owner Lead | 878/975 |
| rate-limit / 冻结 / 登出 | capture pane 认菜单/登出(**非 alive-flag**) | owner Lead/infra | alive-flag 家族 |
| tool-call-leak | 输出含未执行的 invoke 文字块 | owner Lead | FLY-941 |
| ghost(dead-but-registered) | status=running 但 alive=false | 系统(检测+清+抑制) | 970/973 |

- **时间阈值(不即时,Annie revise 2)**:Lead 忙、10min 后处理完全 OK。所以看门狗**不在事发那刻响**,而是设可配阈值(878:默认 ~20min,global+per-project)判"是不是停在那没人动了"。超阈值才响。→ 早稿的"✅/🔴 park 那刻立即 push"**作废**。
- **报给谁 = consolidate 接收点(Annie 病症②)**:现状分发乱——有的给 Lead[被看到、好]、有的进 alert room[被忽略]。→ 看门狗输出**统一到实际被看到的接收点**:issue 相关→对应 thread;Lead 相关→该 Lead(不是被忽略的 alert room)。owner Lead 先接,解不了才升级到 founder 的 consolidate 队列。
- **它真到 Annie 时的形态**(经 Lead relay 或系统 surface):决策卡『🔴 [FLY-XXX] 需要你拍:<一句话> — A/B — 建议 X』/ 干完等你拍『✅ …』/ Lead 已替你决『🟡 …(可回退)FYI』。格式见 `mockup.html`。**但何时到 Annie 由"正常路径 + 看门狗兜漏"决定,不是每次即时 push。**

---

## 4. 反刷屏 ⨯ 绝不静默:时间阈值 + 去重 + consolidate + digest(对上 Annie 四病症)

- **时间阈值(治噪音④/误报)**:不即时响,超阈值(没人动)才响 → 正常路径 work 时零打扰。
- **去重 + over-notify 抑制**:同一"漏"只报一次(复用 claims.db/episode-latch);已知/正清理的 ghost 绝不 re-alert(治病症④狂发)。
- **先报 Lead、不先戳 Annie**:owner Lead 首响应(自愈/relay);解不了才升级 founder。
- **consolidate 接收点(治病症②)**:统一到被看到的点(thread/Lead),不散落进被忽略的 alert room。
- **每日兜底 digest(治病症③漏报的网底)**:每天一次把当前所有"在等你"的开放项汇总成 founder 面向 roll-up → 即便某次漏了也不静默烂掉。

**合起来 = 绝不静默(兜两漏 + stall + digest 网底)⨯ 不刷屏(时间阈值 + 去重 + consolidate)**,直接对上 Annie 的四病症(①误报 ②分发 ③漏报 ④噪音)。这是本 PRD 的产品灵魂。

---

## 5. Lead 响应契约(块5)+ Lead-relay 延迟看门(HL 2026-07-07 补)

看门狗一响(任何 stuck 类),**责任 Lead 是第一响应人**,不是 Annie:
1. Lead 第一个排查该 session。
2. 能自愈的自愈(例:Bridge 短暂 down 致 publish 失败 → Bridge 恢复后 runner 重试即好;单 Enter 解卡;respawn+resume)。
3. 自愈不了 / 真需要 Annie 拍 → **relay 一张决策卡**进对应 thread(不是丢一句"卡了"给 Annie)。
4. **绝不静默**:Lead 收到看门狗信号后必须留下动作痕迹(ACK / 自愈记录 / relay),不允许"看到了不动"。

### 5.1 两条投递路径 —— 化解块3"不经 Lead 手转" ⨯ "Lead 压着没 relay"的张力

块3 说"Bridge 自动往 thread 发、不经 Lead 手转";HL 又指出"Lead 压着 runner surfaced 的东西没转"是真 case。二者**不矛盾**,是按状态可判定性分两条路径:

- **路径 A · 机器可明判的状态 → 系统可直接 surface 到对应 thread(不依赖 Lead 手转)**:runner parked 在 ship gate、正式 gate question 这些从真实 stage/park 元组能明判 —— 系统可直接 surface 到对应 thread、只 @ founder(**消灭 gap① 风险**:不靠 Lead 记得转)。**但仍走时间阈值**:不在那刻即时轰炸,超阈值没人动才由看门狗兜(= Annie revise 2)。
- **路径 B · 需 Lead 判断/塑形的状态 → Lead 是中转,看门狗盯 relay 延迟(= 漏②)**:runner 抛出一个需 Lead 先塑形成决策卡(或先自己试着解)的问题 → Lead 是中转 hop。**看门狗对这条 hop 计时**:超应答时效 Lead 还没 relay/ACK → **先私下 nudge 该 Lead**(给窗口自转,别让 Annie 靠"看门狗 flag"先发现)。HL 今天漏转 978 round-1 就是这条(= FLY-878 场景3)。

**这两条合起来才完整**:路径 A 把常见态直投(去掉 relay 依赖),路径 B 用"Lead-relay 延迟看门"堵住"Lead 坐着不转"的漏。都归到 §3 第 3 条"超时先 @ Lead 不再戳 Annie"。

这把 Annie 定的 reframe("Lead=响应,不巡查")落成可验收的行为契约。检测/路由/@-target/relay 计时由 FLY-927 提供;本 PRD 定"Lead 收到后必须做什么 + relay 超时怎么盯"。

---

## 5.5 检测层:要准确检测什么 + 准确性=北极星(融 FLY-878 / 975 / 976 + ghost / alive-flag)

> Cass 要 FLY-878 / 975 / 976 跟 942 收敛 → 本 PRD 是收敛这一族的**产品层**。主动汇报(§2–§5)只有在**检测足够准**时才成立 —— "状态显示骗你一次你就再也懒得看"(FLY-964 §4 同根)。所以**准确性是本 PRD 的北极星**,检测层与汇报层同等重要。

### 5.5.0 现状:多组件粗信号,分不清三种"看起来 idle"(Cass 亲历 + Tadashi code/运营)

现 watchdog = 多组件(`RunnerIdleWatchdog` / `LeadWatchdog` / `HeartbeatService` / `GatePoller` / `stuck-detector`)**各扫各的**,判"卡"靠**粗信号**(idle 时长 / 没 `stage_changed` / message 模式匹配 / alive-flag —— 全是 stale + 机械)。**核心病 = 分不清三种"看起来 idle":**

| 态 | 真相 | 现状误判 | 例 |
|---|---|---|---|
| **(a) 在跑的长 turn** | pane 里 token 在流(真在产出) | **误报卡住** | Tadashi:FLY-545 一个 48min implement turn 狂吐 token 却被报 stuck |
| **(b) 正常 parked 等 gate** | awaiting_review + 明确 park(合法等人) | **误报** | parked 等 founder 被当卡 |
| **(c) 真卡死** | error + 空 prompt + 不恢复 | **漏报** | FLY-975/546:error-then-idle 被 `isIdleHealthyPane` 当 HEALTHY |

**粗信号混三态 → 误报 (a)(b) + 漏报 (c)。** 误报还叠一层:codex-hold 被映射成罐头"等很久"、不分正常 hold vs 真卡(FLY-863 半修、FLY-912 这错)。

### 5.5.0b 核心跃迁:粗信号 → 读 per-pane 富态(区分 a/b/c)

**942 检测层的核心跃迁 = 从"粗信号机械匹配"→"读 per-pane 富态"**:看 pane 实际 **token-flow**(在不在吐)+ 会话 **FSM 态**(running / awaiting_review / park…)→ 判 a(working)/ b(parked)/ c(stuck)。**这正是 Tadashi 手动 fleet-scan 在做的**(capture pane → 眼判 working/parked/stuck),**942 = 把它自动化**。
- eng 方向:**FLY-976 LLM 判断层**(读 pane 富态理解上下文)+ **FLY-937 lead 协议**(收报警先 capture pane 验当下,不信 stale alive-flag/commit;**Watchdog 报警默认可信、值得查,不默认误报**)+ **FLY-778**(自动看门狗本身读 capture-pane 文字判 frozen/rate-limit)。
- **观察窗 + 二次确认(Tadashi 补)**:三态最难是边界 —— 长 turn 瞬时空 prompt(看着 idle、下秒又吐)、error-but-looks-parked(报错后停在类 park 静默态)。→ 检测用**观察窗 + 二次确认(多帧/时间窗),非单帧快照**:别把恢复中的长 turn 当卡死(护 a)、别把真卡死当短暂空(护 C)。

### 5.5.0c 北极星验收:三态优先级 + 六 test case ✅ G1 定案

**优先级(Annie 拍)**:**(c) 真卡死绝不漏(100%)>> (a) 在跑误报可容忍 >> (b) 正常 parked = feature 要 surface**(不是误报;parked 等她 + 没人转 → 汇报层 gap② 兜)。北极星 = C 绝不漏 >> A/B。

**真实 test case(Cass 亲历 + Tadashi 印证 + 本 PRD dogfood)**:
| # | case | 真态 | 验收 |
|---|---|:--:|---|
| A0 🐕 | 本 942 runner 长 draft turn(无 stage_changed)被现有 watchdog 误报 session_stuck;HL 手动 capture 见在动、按 A-可容忍未转 Annie | a | 不判 stuck(**dogfood**:写 PRD 的 runner 被它要治的 watchdog 误报) |
| A1 | 零-commit 只读/QA run 被判 stuck(FLY-798「没commit=stuck」) | a/b | 不判 stuck(可容忍偶发) |
| A2 | 长操作 idle-timeout 误杀(等 codex/build/test) | a | 不判 stuck(观察窗护) |
| A3 | Lead 见「刚 commit」机械 dismiss 真 stuck(07-06 rate-limit) | c | 937:capture pane 验、报警默认可信 |
| B0 🐕 | 910 runner alive=true 但 Claude auth 挂(Not logged in)→ 机械当 healthy | c | **100% 判 stuck**(dogfood:liveness≠healthy,须读 pane) |
| B1 | error-then-idle → HEALTHY(546/975) | c | **100% 判 stuck** |
| B2 | `/compact` 静默 stall(FLY-837,进程 alive 活死) | c | **100% 判 stuck** |
| B3 | Lead draft-not-sent(FLY-574,status 绿发不出) | c | **100% 判 stuck** |

共同根子 = 靠机械信号/alive-flag/idle 有无、不读 pane 当下。C 类(B1/B2/B3)100% 不漏、A 类可容忍、B 类要 surface。

### 5.5.1 准确性为什么是北极星(现状为什么不准)

> **G1 北极星验收 = Annie 亲给的四病症(2026-07-07)** + **三态判对**(HL/Tadashi 拼齐):**准 = 三态判对 —— (a) working / (b) parked 不误报、(c) stuck 不漏报**(直接映射:病症①误报 = 混淆 a/b;病症③漏报 = 漏 c)。PRD 的准确性验收就照四病症 + 三态:
> - **① 误报**:机械匹配旧 message、遇新 error 认不出 → 误报(**坐实 FLY-976 LLM 判断层**,机械规则不够)。
> - **② 分发不合理**:有的报给 Lead[被看到、好]、有的进 alert room[被忽略] → **consolidate 接收点**(统一到实际被看到的点)。
> - **③ 漏报**:真 stuck 没反应(如 FLY-546)。
> - **④ 噪音过多**:对错的问题狂发(如 ghost SPAM)。
> 北极星一句话:**watchdog 说卡就是真卡、说健康就是真健康;报了就是该报的、报到的就是看得到的。**

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

### 5.5.4 over-notify 抑制(治 ghost 刷屏)+ 治 ghost 源头(HL 补)

- **抑制**:已知 / 正在清 / 已升级的问题 **绝不 re-alert**(FLY-970 死着还一直 fire session_stuck)。复用去重设施(claims.db / episode-latch),并对"正在清理中"的 ghost 加抑制态。这是"绝不静默 ⨯ 不刷屏"里"不刷屏"的一条硬约束。
- **治源头(auto-QA-spawn gate)**:FLY-970 那个 ghost 的根因 = 一个 product / no-three-stage issue(FLY-915)被**错误地 auto-spawn 了 QA session**。**需求**:product / no-three-stage 类 issue 不该自动 spawn QA(接 FLY-579 auto-QA gate / FLY-707 opt-in 政策)→ 从源头少造 ghost。归属 = eng(Tadashi)。
- **关联收敛**:FLY-973(auto-spawned 子 session 的 scope 归 parent issue 的 lead、不是一律 eng → 拥有 issue 的 lead 才关得掉自己派生的子 session)、FLY-962(归档约束:只真 done/shipped 才归档、活跃线程绝不归档 —— 接 FLY-964 §4.3 / FLY-978 根治)。这两条都是"ghost / 死态清理"这一族的相邻问题,本 PRD 引过去、不重做。

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

## 7. converge 进度 + 剩余 clarify(HL relay;小步多轮)

> **母 Epic = FLY-989**(Watchdog + 主动汇报 稳定化 EPIC,https://linear.app/geoforge3d/issue/FLY-989):consolidate 878/975/976/937/778/927/915/970/973/941/964,以后发现一个提一个、定期 iterate;归 FLY-774 底下。**本 PRD(FLY-942)= 该 Epic 的「主动汇报 + 检测」产品定义 PRD**(parent=989 HL 已设)。

**框架** ✅✅ **Annie 深度 review + 两条核心 revise(2026-07-07)已落**:① 不是 push-every-ball-change → 看门狗兜两漏(runner 没找 Lead / Lead 漏应答);② 不是 park 立即 push → **时间阈值型 stall 检测**。第 5 球态"Lead 漏应答"= 漏②,与 878 场景3 对齐。

### Group 1 · 检测准确性(北极星)✅ **Annie 已拍(四病症)**
- **Q1 准确性机制** ✅ 走 **FLY-976 LLM 判断层**(病症① 坐实:机械匹配旧 msg/新 error 认不出)。
- **Q2 北极星验收** ✅ = **Annie 四病症**:①误报 ②分发不合理→consolidate 接收点 ③漏报 ④噪音过多(见 §5.5.1)。
- **Q3 阈值** ✅ **时间阈值型**(878 ~20min 可配,不即时);早稿"立即 push"作废。

### Group 2 · 剩余 converge(下一轮)
- **Qa consolidate 接收点具体在哪**(病症②新开):看门狗输出统一到哪个"实际被看到"的点?〔rec:issue 相关→对应 thread;Lead 相关→该 Lead;founder 兜底→一个 consolidated"你的开放队列"(非被忽略的 alert room)。落点待 Annie 定〕
- **Qb 决策卡固定字段**〔rec:`🔴 [FLY-XXX] 需要你拍:<一句话> — A/B — 建议 X(一句理由)`;一事一卡、绝不批量〕
- **Qc 🟡 Lead 已替你决定**:进 digest 还是安静帖?〔rec:只进 digest/安静帖,不 ping〕
- **Qd digest 内容/落点/时点**〔rec:内容=当前所有"在等你"开放项;每日 1 次;落点=consolidate 队列(同 Qa)〕

### Group 3 · 边界 / scope(下一轮)
- **Qe 942 ↔ 915 边界**〔rec:942=检测+主动汇报兜漏;915=通知管线。942 喂 thread/consolidate 落点需求给 915〕
- **Qf ghost 检测+抑制 + auto-QA-spawn gate 治源头**〔rec:检测+over-notify 抑制=942 需求;清理/scope/gate=eng(970/973/579)〕
- **Qg mid-turn hard-stop**:纳入 942 scope 还是兄弟 issue?〔rec:列需求,实现 harness/eng,可能独立 issue〕

---

## 8. 假设(实现前显式列出,请 Annie 证伪)

1. runner 的真实 stage 已经可靠上报(`flywheel-comm stage set`)且 Bridge 能读到 —— "按真实 stage 报、不靠猜"的前提(FLY-927 fix#1 也建立在此)。待审计确认覆盖度。
2. 每条 issue 已有专属 `[FLY-XX]` chat thread,且 `founder-thread-notifier` 能往里发(FLY-523/818 已在跑)。
3. runner 在需要人介入时会 declare(park / ask Lead)—— 看门狗判"漏①(没找 Lead)"依赖能看到"有没有对 Lead 的通信"(现有 CommDB `runner_declared_states` / ask 记录)。
4. 去重键可复用 FLY-915/927 的 claims.db / episode-latch,不需新建去重设施。
5. "consolidate 接收点"存在一个"实际被 Annie/Lead 看到"的落点(非被忽略的 alert room)—— 具体落点待 Annie 定(Qa)。
