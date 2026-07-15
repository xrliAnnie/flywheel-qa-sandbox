# FLY-929 Profile 自动切换启用 + 通知迁移 — QA 报告

Issue: FLY-929 (https://linear.app/geoforge3d/issue/FLY-929)
日期: 2026-07-07
基于: plan.md / enable-runbook.md

> QA 阶段(三段式 Design → Implement → **QA**)。实现已由 implement 阶段提交在本分支、PR #490 开启。
> 本阶段职责:对照 plan 验证、跑测试、补边界覆盖、留 QA 报告 —— **不重实现**。

## 结论:**PASS**

这是一个 **env-keyed 字节兼容 dormant merge**:两个显式激活谓词(P-identity / P-expect)缺一即逐字回到现状。
merge 本身不改变任何生产行为;真正的启用发生在 founder-gated 的 enable 运维窗(enable-runbook.md / §6),
需前置 FLY-928 W5(Claude Infra Bot 存在)—— 该真机激活 QA(真发 Discord、真封顶注入)**不在本 dormant PR 的 gate 范围**,
按 plan §4 归属 enable 窗、Annie 在场。本阶段能验的(自动化测试 + 字节兼容铁证 + 纯函数真实行为)全部通过。

## 1. 验证范围与方法

| 面 | 本阶段可验? | 方法 |
|---|---|---|
| 字节兼容(env 全不设/只 token/只 channel → 逐字现状) | ✅ | reverse-compat sentinel(15 测)独立复跑 |
| 纯函数真实行为(P-identity 满足时 sender/digest/owner-mention/tick 输出) | ✅ | 各单测断言真实输出字符串 + 真实 write→read→tick round-trip |
| 日期契约(Codex R1#5:CLI 算 expectedDate,Bridge 只消费不重算) | ✅ | 补测跨时区/DST/精确 deadline 边界(本阶段新增) |
| bash 迁移(restart routine 分类、token-usage fail-loud、lead-alert kind) | ✅ | 3 个 shell harness 复跑 |
| 真发 Discord(reports/standup/digest sender = infra bot)、真封顶注入 → owner mention | ❌ 本阶段 | 需 Claude Infra Bot(FLY-928 W5)+ 隔离频道 → enable 窗 §5/§6,founder 在场 |

无法真机验证的部分是 **dormant merge 的必然**:没有 infra bot token 就没有可发的身份;这也正是设计成 dormant 的原因。

## 2. 自动化测试 —— 全绿(独立复跑)

| 套件 | 结果 |
|---|---|
| teamlead(9 个 FLY-929 相关 test 文件) | **160 passed** |
| config(含 `feature-flags-drift` CI drift guard) | **359 passed** |
| token-usage `cli.test.ts`(expectedDate 传递) | **22 passed** |
| flywheel-comm `publish-report.test.ts`(kind/expected-date flag) | **23 passed** |
| bash `lead-alert-notify-digest-kind` / `restart-notify-routine` / `token-usage-daily-failloud` | **3 + 7 + 8 passed** |
| **本阶段新增** `fly929-date-contract.qa.test.ts` | **10 passed** |
| CI(PR #490 Build & Test @ e5b025cf) | **SUCCESS** |

## 3. 逐项对照 plan(验收即此)

- **W3b sender 迁移(A2/A3)**:reports ①(`plugin.ts` `infraSenderTokenOr(globalBotToken)`)、standup ③(同 helper,FLY-71 非-CoS 约束由构造保留)、bash routine 分类(restart-services.sh 5 个 routine 位点迁移、⚠️/🚨/severe 一字不动、update-flywheel.sh 零改动)—— 接线正确,单测 + shell 测覆盖两态。✅
- **W6 成功 digest(A4)**:`notifySuccess` 仅在真 `switched` 填(noop/no_account/failed/enqueue 四个 negative case 锁死)；三个贴帖位点(watchdog `post`、`/api/account-switch` `postResult`、`accountRotationPostHolder`)都把 full disposition 作第二参传入(route + watchdog 测真断言);rotation digest 从结构化 payload 组文案(不反解析人类文本)。✅
- **W6 失败 owner mention(A5,Codex R1#2)**:AlertChannelHub 的 not-attemptable 路径 negative-test 矩阵**完整**(claude cap+env 齐 → owner mention 无 founder 升级;P-identity 缺 / self-heal off / 缺 bot id / 无 accountLimit / codex provider / rate_limit / login_expired → 逐字 founder 升级)。executor no_account/failed 路径经 `postSwitchResult`(见 §5 覆盖边界)。✅
- **自我健康检查(B1/B2,P-expect)**:回执写入仅 P-expect 下有 fs 副作用(unset → 零文件,sentinel 锁死)；expect tick piggyback onPollComplete(零新 timer)；`notify_digest_failed` eventId 按期望日期去重(重复 tick 一条)。✅
- **契约边界**:reports body `kind`/`expectedDate` 可选(不传 = 零回执，byte-compat + 400 shape 校验)；`RepairDisposition.notifySuccess`、`accountRotationPostHolder.current` 类型加宽均向后兼容。✅

## 4. 本阶段新增覆盖(零生产代码改动,仅测试)

`fly929-date-contract.qa.test.ts` —— 补 implement 套件(LA 单时区)未锁死、但 Codex R1#5 日期契约依赖的边界:

1. **01:00 精确 deadline(inclusive)**:恰 01:00 local → tick 运行判定(不 short-circuit 成 before-deadline);00:59 → before-deadline 静默。
2. **非-US 非-DST 时区端到端**(Asia/Shanghai, UTC+8):真 `writeTokenReportReceipt` → 真 `notifyDigestExpectTick` round-trip,证明写入日期与 tick 期望日期在不同 offset 下对齐(receipt-ok / stale→alerted / before-deadline 三态)。
3. **DST 切换日**(LA spring-forward 2026-03-08 / fall-back 2026-11-01):`expectedReportDate` 的 UTC-arithmetic civil-date shift 跨 offset 变化仍落对前一日。
4. **月/年 rollover**:1 号 → 上月末;Jan 1 → 上一年 Dec 31。

全部用真实导出的生产函数(不 mock 被测对象)+ 注入 `now`/`tz`/`env`,biome + tsc 干净。

## 5. 已知覆盖边界(非阻塞,记录在案)

- **`plugin.ts` `postSwitchResult` 闭包**(executor no_account/failed → owner mention + notifySuccess → digest 的**组合**逻辑)未被单测直达 —— 它是 `startBridge` 内的局部闭包。但:①其**全部组成块**(`resolveAccountCapOwnerId` / `formatAccountCapOwnerAssignment` / `formatSwitchSuccessDigest` / `postInfraNotifyDigest`)已单测;②**disposition 传参管道**(disposition 带 outcome/notifySuccess 到达 post callback)已由 route + watchdog 测真断言;③其真实端到端行为按 plan §4 item 3 归 enable 窗真机注入(no_account/failed → owner mention,founder 在场)。以「抽取生产闭包补测」代价是未过 review 的生产改动 + head 漂移,判定不值当,故不改;非 QA-fail 项。
- 真机激活面(真发 Discord / 真封顶注入)= enable 窗(§5/§6),依赖 FLY-928 W5,不在本 dormant PR gate。

## 6. QA 判定依据

代码正确、设计干净、接线复用已测纯函数;字节兼容有真 sentinel 铁证;A5 negative 矩阵完整;日期契约边界经本阶段补测加固;全部自动化测试 + CI 绿。**PASS** → 开 approve gate 交 founder。
