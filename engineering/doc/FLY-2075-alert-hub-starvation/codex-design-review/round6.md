# Design Review — plan.md (Round 6)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 已关闭 Round 5 的四个主要设计缺口：一次性 route-health effect seam、真实 renderer RED、行为型 escalation RED，以及删除 `AlertTicketContext.status` 的生产合同都可在现架构内实现。仍有三个相邻接缝需要收口：R9 的全仓 send-site 断言会误伤两个合法 `alert_unreachable_config` 路径，plugin adapter 未定义 `MetaAlertNotifier.notify` 的方法绑定，而 status 字段删除尚未覆盖不会被 `tsc` 检查的测试 fixtures；因此本轮仍请求修改。

## What's Good (Keep)

- 已核 plan blob 精确为 `c260f0508e18c08d7e0d4d1dcf92520b9e5c423e`，HEAD `14544dd4fbb3b4dd25fe6278b09fc132a855f5ba`，提交只修改 plan，worktree 干净。
- T7f 现在明确替换并删除 `plugin.ts:9903-9912` 的旧 route-health effect branch，并把 decision 与 effect 分开；健康 0/0、任一前置缺失 1/1 的 spy 合同是可构建、可真实 RED 的。
- R1 已停止让 notifier stub 自行伪造 renderer；现有 `LeadAlertNotifier.test.ts:1069-1077` 能直接观察真实根 POST，R10 继续覆盖磁盘 JSON → `drainQueue()` → `attachDeliveredAlertLifecycles()` 的完整旧 payload 回放。
- R2/R3 已删除没有 runner 执行的类型 RED 宣称；production `pnpm -r build` 会真实抓住 Hub deps 删除后 plugin 旧接线未同步，状态机行为则由 Vitest RED 把关。
- 删除 `AlertTicketContext.status` 比保留 ignored required field 更干净：生产构造点只需删除 `infra-alert-wiring.enrich()` 的 status，renderer 与 Hub 分别以 literal `NEW` 建立首发和账本初态，旧 JSON 的额外键不会改变运行时行为。
- T11 已补 `DiscordOps.postToThread` 的 mention 注释；G0 C1–C8、FLY-2076 deploy gate、真实 Discord thread 负向证据和高副作用 rollback 授权仍保持完整。

## Issues & Recommendations

1. **MEDIUM — R9 的“`alert_unreachable_config` 全仓恰一处发送点”与现有合法路径冲突，不能作为 residue gate。** 当前 `plugin.ts` 有三条不同用途的该 reason：`:9890-9894` 的 repair-bot degraded、`:9908-9912` 的 no-repair-chain route health，以及 `:10724-10731` 的 Lead alert channel unreachable。T7f 只应替换中间一条；实施后仍应保留 degraded、new route-health 和 Lead-unreachable 三类通知。全仓要求恰一处要么永远失败，要么诱使实现者删除两个不在本单范围内的 fail-loud 保护。**修复：**把 review gate 改为有作用域的机械检查：`plugin.ts` 中旧 title/body（`FLY-368 alert threading misconfigured` / `per-error threads will NOT be created`）为 0，`emitTicketRouteHealth(...)` boot 调用恰 1；明确 degraded 与 Lead-unreachable send sites 必须保留。R9 的 effect spies 已足够锁 route-health 自身的 0/0、1/1，不要用 reason 的全仓计数代替调用点检查。

2. **MEDIUM — effect seam 没有定义 production `notify` adapter 的绑定方式，spy 测试抓不住 unbound-method 失败。** `MetaAlertNotifier.notify()` 在入口立即读取 `this.now()`、`this.lastSent`；若 plugin 直接传 `notify: metaAlertNotifier.notify`，测试里的独立 spy 会通过，但生产调用会因 `this` 丢失而 rejected，boot meta-alert 实际不送达。**修复：**T7f 写出绑定合同，例如 `notify: (input) => { void metaAlertNotifier.notify(input); }`（以及 `log: (line) => console.error(line)`），不要传裸方法引用；effect seam 的依赖类型应允许该 best-effort async 调用而不改变当前 boot 不等待通知完成的语义。

3. **MEDIUM — `AlertTicketContext.status` 的删除没有完整传播到测试 fixtures，而现有构建不会替你发现。** `packages/teamlead/tsconfig.json` 排除 `**/*.test.ts`；当前仍有 typed/new-world ticket fixtures 在 `LeadAlertNotifier.test.ts:1044-1048,1740-1744,1771-1775`、`alert-ticket-lifecycle.test.ts:28-33`、`escalation-chain.test.ts:71-76,131-136`，以及 `AlertChannelHub.contract-escalate.test.ts:64-71` 的 `ticket(status)` helper。`infra-alert-wiring.test.ts:292-299` 还会直接期待 `status: "NEW"`；其中只有部分会因行为断言变红，其余可带着已删除的假 API 全绿。R1-⑤ 也仍写着 zombie 的 `enrich() 种 NEW`，与 T2“enrich 不再产出 status”矛盾。**修复：**把这些 fixture/helper 一并列入删除清单，并加 scoped residue check：除 R1/R10 明确标注的 legacy JSON/`as any` 兼容用例外，新 payload fixture 不得再含 ticket `status`；R1 文案改为“Hub 种 NEW”。

## Verdict

CHANGES REQUESTED — address items above
