# Design Review — plan.md (Round 1)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案整体可行，模块拆分与现有额度页模式一致，影响范围也合理。进入实现前需关闭两个合同缺口：刷新写盘失败仍可能显示旧的成功读数；下次扣费日算法没有落实仅对 Pro 使用账期结束日的限制。

审查基于工作区 HEAD `d9c4939c29414cfc80c5633e8b15c03f826c7e37`。已核对 CLAUDE.md、exploration/research、前两轮计划，以及请求列出的 renderer、view、refresh、plugin 接线、托管凭据/usage/API/registry、订阅 store 和测试 harness。保持 Lead 的别名、邮箱哈希及旧 Hobby 静态行裁定。

证据主要来自源码阅读；另执行了现有 renderer 的纯本地空页探针，以及 research 时间戳转换检查，均退出 0。未运行测试套件、构建或 lint；未调用 Vercel API、读取 `~/.flywheel/.env` 或修改仓库文件。公开 Vercel 文档仅用于交叉核对计费语义。

## What's Good (Keep)

- 独立 Vercel store + 页面第二参数，避免把托管状态引入容量快照与巡检决策。现有 `renderAccountsPageHtml` 确实只是 renderer 的薄包装（`account-quota-view.ts:1193-1195`）。
- 复用现有 single-flight 并行刷新入口，普通 GET 仅消费存量数据；生产的 credentials 与 registry 对象均已在刷新接线前构造，依赖位置成立（`plugin.ts:7341-7350,8909-8957`）。
- 三条 GET 白名单、固定 origin、禁止 redirect、枚举错误、邮箱只存哈希，以及 owner 校验，均切合本单约束。`hostingBinding()` 每次重新读文件，计划无需增加 registry 读锁（`report-registry.ts:592-594,945-975`）。
- 不用 Hobby 上限推算 Pro 占比是正确的；现有 `evaluateReportHostingUsage` 确实使用固定 Hobby storage 上限，不能直接拿来显示 Pro 占比（`report-hosting-usage.ts:24-51`）。
- T1–T6 的 store → reader → view → renderer → refresh → route 顺序合理；已有测试缝足以支持主要验收。

## Issues & Recommendations

1. **BLOCKER — Vercel 刷新失败的可见结果不能只依赖成功写盘。**

   **位置：** plan §3.1、§3.5、T5/T6（`plan.md:79,141-142,155-157`）。

   **问题与影响：** 计划承诺不跨轮沿用，但 observer 或 writer 抛错时仅 warn，GET 随后仍读取同一个 store。具体反例：上一轮文件为 Pro + available；本轮 API 返回 unauthorized，observer 正确产出失败记录，但写入因磁盘满或 rename 失败而抛错。旧成功文件仍在，GET 就继续显示绿色「在用」、正常 Blob 和旧扣费日，而没有「读不到」。直接照搬 Codex 订阅的容错语义不成立：现有组合确实吞订阅异常（`account-quota-refresh.ts:52-61`），原子 writer 失败不会清除旧目标（`codex-subscription-store.ts:164-185`），而本单明确禁止此类历史回退。

   **建议：** 为 Vercel 明确定义“最新尝试失败优先于旧成功文件”的页面读取合同。一个小范围做法是由 Bridge 保留最新尝试结果/失败标记，页面优先消费它，写盘失败也输出固定安全原因且 `active=false`；下次成功刷新再清除失败状态。至少补“已有成功文件 → API 失败 + writer 抛错 → refresh=1 和随后普通 GET 均 200、Vercel 显示读不到且不绿 → 成功刷新恢复”的集成用例。observer 意外抛错同样覆盖。仅断言 refresh resolve 与 warn 不足以证明降级行为。

2. **BLOCKER — `nextCharge` 的实际判定遗漏 `plan === "pro"`，会对未验证的套餐推断扣费日。**

   **位置：** plan §3.3 与 §7（`plan.md:123,192`），research §2.2（`research.md:29-40`）。

   **问题与影响：** 风险表限制为 `pro/active/未取消/未过期`，但 §3.3 只排除了 Hobby；`enterprise` 或任意合法的新 plan token，只要 status=active 且 periodEnd 在未来，都会直接显示日期。研究证据只有当前 Pro 账号，不能把其它套餐的账期结束日当作已证实的扣费日。这违反“真值或读不到，不猜”的约束。公开 [Vercel Pro 计费说明](https://vercel.com/docs/plans/pro-plan/billing) 支持 Pro 在账期开始收款；它并不为上述任意套餐分支提供依据。

   **建议：** 把 §7 的 Pro 门槛落到 §3.3 的规范算法；Enterprise/未知套餐保留档位事实，但无独立依据时扣费日显示「读不到（接口未给扣费日）」等固定原因。T3 增加 `enterprise`、未知合法 plan 与 `active + future periodEnd` 的负测，正常 Pro fixture 继续显示 `10/24 周六`。

3. **NIT — T4/T6 的几个断言需要按真实 HTML 和 HTTP harness 调整。**

   **位置：** `plan.md:41,134,153,157`。

   **问题与影响：** 当前 HTML 自带 `@media` 和 `.active-account` CSS（`account-quota-page.ts:325`）。本地执行现有 renderer，空账号页得到 `containsAtSign=true`、`containsActiveAccountString=true`，实际 active 行为 0。因此“全文不含 @”及“失败 HTML 不含 active-account”都会误报；其它 provider 的在用行也应继续保留。现有 route 测试检查的是具体邮箱/`@example.com`（`capacity-route.test.ts:498-499`），且请求 Bridge 本身就使用全局 fetch（同文件 `:881-888`），不能直接断言全局 fetch 总调用数为 0。“不含 provider-vercel”也不能证明旧 HTML 逐字节一致。

   **建议：** 邮箱隐私检查覆盖原始及 HTML 转义后的 fixture 邮箱；绿色断言定位 `.provider-vercel` 内实际 `tr.active-account`；出网断言用独立 HTTP 客户端发本地请求，或区分 loopback 与外部 fetch。若保留逐字节兼容承诺，使用固定 view 与改动前完整 HTML 做相等比较。T6 固定生成时间，避免 `2026-10-24` fixture 随系统日期过期。统一给 route harness 注入临时 Vercel store 路径，避免旧用例意外读取本机默认 store。

4. **NIT — 本地验证清单需要约束 `vitest related` 的范围。**

   **位置：** `plan.md:164-174`。

   **问题与影响：** `<changed ts files>` 包含 Bridge 总入口 `plugin.ts`；本次静态扫描就发现 74 个测试文件直接 import `plugin.js`，还不含间接依赖。把所有改动文件交给 related，会明显超出列出的 7 个定向套件，不能把它当作已知范围的小测试集。

   **建议：** 本地使用明确文件清单；需要证明 `/api/capacity` 与 patrol 不变时，将对应聚焦测试按名称列入。将更广的 related/aggregate 留给 CI，或先列出实际选择范围再限定执行。本次没有执行该宽范围命令。

5. **NIT — 日志白名单应是固定值，不能默认 `error.name` 已脱敏。**

   **位置：** `plan.md:40,141,155`。

   **问题与影响：** `Error.name` 可写，catch 值也可能不是 Error；它不天然等于安全枚举。计划的“不打印 message”是好的，但直接输出任意 name 尚不能支撑零 token 泄漏的绝对断言。

   **建议：** 最简单是只记录固定失败文案；需要类别时，将已知异常映射到固定白名单。测试分别注入含假 token 的 message/name，以及非 Error 抛值，确认无敏感片段、无二次异常。

## Verdict

CHANGES REQUESTED

关闭第 1、2 项 BLOCKER 后可进入实现；保持独立 store、只读 GET、别名隐私与静态 retired 行的既定方向。
