# FLY-1570 拆 watchdog 全家 — 探索

Issue: FLY-1570 (https://linear.app/geoforge3d/issue/FLY-1570/消息层重构-a-批次1-拆-watchdog-全家)
日期: 2026-08-03
基于: 无(上游为总纲单 FLY-1569 的 `doc/messaging-rework/design.md`)

## 1. 背景与动机

这是消息层重构(FLY-1569 总纲)的批次 1 · A 单。与 B 单(Runner stop 通知)并行,无依赖,**纯删代码,不动 schema**。

v1 消息层的病因不是「没有 ack 机制」,而是自激循环:

```
ack 慢 → watchdog 催 → 催的时候新建一行 → 表膨胀 → 更慢
```

实测(`~/.flywheel/comm/flywheel/comm.db`,2026-07-31):`lead_inbox` 44,567 行里 **67% 被重发过、42% 本身就是重发副本、14% 被升级过**;而真正「投了但两样都没标」的只有 30 行(0.07%)—— 闭环其实是闭上的,watchdog 兜出来的几乎全是噪音。

watchdog 的检测方式本身也不可靠:靠「你多久没动 / 面板文字变没变」判断 —— **agent 在思考就误报,agent 瞎忙就漏报**。FLY-218(529 误判)、FLY-220(告警回声风暴)、FLY-193(pane_hash_stuck 误报)三次生产事故都是这条检测链的直接产物,每次都是在误报机制上再打补丁。

## 2. 为什么先拆(founder 拍板)

1. **先拆再改比边改边照顾干净** —— 批次 2(D 单:租约重投 + 合批投递 + 死信闸)改投递逻辑时,不用照顾 12 个 watchdog 调用点
2. **让 C 单删字段变干净** —— `lead_inbox` 那 17 个死字段(`resend_of` / `escalated_at` / `read_at` 等)本来就是 watchdog 的账本
3. **第一次能看到真实的丢失率** —— 现在 67% 的重发把真相盖住了

新架构里 watchdog「反复催」的位置由三样东西取代:租约到期整批重投(不新建行)、门铃自带欠账数、agent 自己能按的 `no_action` 出口。这些属于批次 2/3;本单只负责把旧机制拆干净。

## 3. 核心判别标准:追人型 vs 保留型

这是本设计最重要的一条线,所有切割决策都从它推导:

| 类型 | 定义 | 判据 | 处置 |
| -- | -- | -- | -- |
| **追人型** | 基于「多久没动 / 面板文字变没变」推断 agent 状态,然后催促、重发、升级 | 它的输出是**给活人/活 agent 施加压力**(重发消息、升级告警、page founder) | ❌ 全删 |
| **收尸型** | 检测**进程已死**这一硬事实,清理残骸 | 它的输入是 OS 级事实(进程不存在、pane 已亡) | ✅ 保留 |
| **外部事实型** | 系统内部推不出来的外部状态(额度用尽、登录失效) | 不看「动没动」,看具体的外部信号文本 | ✅ 保留 |
| **状态收敛型** | 对账两份持久状态的不一致,收敛到一致 | 输入输出都是持久状态,不催任何人 | ✅ 保留 |

边界上最容易切错的三处(设计要精确回答):

1. **LeadWatchdog.ts** —— 面板哈希检测(追人型)要删,但 10 分钟 tick 本身要留:一堆正经对账搭在它的 `onPollComplete` 上,且 runner 额度/登录扫描搭它同一次抓屏
2. **founder-reply-watchdog.ts** —— pass-dead / cursor-pin 两个检测器(追人型)删,`unreachable-runner`(活会话但 CommDB 注册行没了 = 真实数据不一致,状态收敛型)留
3. **RunnerIdleWatchdog** —— 进程存活部分(收尸型)留;如果里面混了 idle 追人逻辑,按判别标准切

## 4. Scope 概览

### 要删(追人型,12 类机制)

三档追命的 runner 收据巡逻、四档追命的 lead 收据巡逻、lead-pending 升级(退避 + page founder)、detection 升级对账全家(4 文件)、卡死检测器全家(5 文件)、LeadWatchdog 面板哈希检测、auto-qa-coordinator 的两个 codex hold 催办 reconcile、notify-digest 期望 watchdog、workflow route 提醒 drain、plugin.ts 的信箱溢出标记扫描、inbox loop 健康检查、founder-reply watchdog 的两个追人检测器。

### 要铲(墓碑,FLY-1393 已 hard-off)

gap-scan / park-watch / delivery 对账 / misroute 巡逻 四个已被策略级永久关闭(环境变量都救不活)的模块,连同 `watchdog-minimum-set.ts` 里的 `RETIRED_WATCHDOG_ENV_VARS` 一起物理删除。这四个墓碑正是「留开关不删代码」的反面教材。

### 必须保留(不许误砍)

Bridge 主循环自杀 watchdog(真存活探测,救过命)、RunnerIdleWatchdog 进程存活部分、runner 额度/登录扫描、五个 reaper、全部状态收敛类对账、founder-reply watchdog 的 unreachable-runner 检测器。

## 5. 方案空间与决策

### 决策 1:物理删 vs feature flag —— 物理删(founder 2026-07-24 直令)

不加任何 flag。四个墓碑就是「留开关」的下场:代码留在仓里两个月,没人敢碰,还得再开一个单来铲。删错了有 git 历史可回滚,PR 本身就是开关。

### 决策 2:删除粒度 —— 整文件删除优先,部分删除仅限三处

能整文件删的绝不做文件内手术(手术会留下「删了一半」的模糊状态,rg 验收也难写)。部分删除只发生在 issue 点名的三处:LeadWatchdog.ts、founder-reply-watchdog.ts、auto-qa-coordinator.ts(+ plugin.ts 的 wiring 段落)。

### 决策 3:wiring 层文件(detection-detector-wiring / detection-escalation-sinks / detection-config-source 等)怎么办

issue 只点名了核心模块。wiring / sinks / config-source 这类伴生文件按「删后是否变死代码」判定:唯一消费者是被删模块的,一并删(验收标准 1 要求无死引用);还有保留功能引用的,做文件内摘除。具体判定以 research 审计为准。

### 决策 4:测试处置

删掉的模块对应的测试一并删(验收标准 2 明说)。但要区分:纯测被删模块的测试文件 → 删;混合测试文件(同文件里既测被删又测保留)→ 只删相关 test case。保留清单里每一项的既有测试必须继续全绿 —— 这是「没误砍」的机器证据。

## 6. 设计要交付的产物

1. **精确删除清单**:每个文件/函数/wiring 点/测试/env var,精确到 file:line 级别的切割线(尤其 LeadWatchdog、founder-reply-watchdog、auto-qa-coordinator、plugin.ts 四处手术)
2. **孤儿判定表**:被删模块 import 的共享模块里,哪些随之变孤儿(一并删),哪些仍被保留功能引用(不动)
3. **验证设计**:五条验收标准逐条的验证方法,尤其「真机起 runner 跑一轮无追命告警」和「保留清单逐条点名验证」

## 7. 风险(founder 已知悉并接受)

批 1 → 批 2 期间,runner「进程活着但卡死」没有自动发现。缓解:① B 单(Runner stop 通知)在同一批,覆盖「正常停了」;② Lead 定期巡检;③ 批 1 → 批 2 尽量短。

设计层面新增的风险控制:保留清单逐条点名验证写进 plan 的验收步骤,防「删 wiring 时顺手删掉保留项的启动点」这类误伤 —— 这类误伤 build 和单测都不一定抓得住(启动点少一行,编译照样绿)。

## 8. 不做什么

- ❌ 不加任何 feature flag
- ❌ 不动 `lead_inbox` / `messages` 的 schema(C 单)
- ❌ 不动投递循环的投递逻辑(D 单)
- ❌ 不做任何「顺手重构」—— 只删点名的和被判定为孤儿的
