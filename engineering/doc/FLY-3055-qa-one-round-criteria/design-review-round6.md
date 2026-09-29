# Design Review — plan.md (Round 6)

Date: 2026-09-29
Author: Codex
Status: APPROVED

## Summary

评审固定在 HEAD `c90042098ab1d0aeec53e5cc9172bc6f8e5ae59e`，plan blob 为 `e5b91b4e4044b2df9c6acf79ed1d6c7bc579af89`。已从磁盘完整重读 356 行 v7，检查相对 Round 5 HEAD `bab9a277a41c276ac3878454296d5e2117ff510b` 的全部差异，并重新核对涉及的 StateStore、event-route、启动 sweep、配置加载与 Bridge 初始化、CLI 和 QA 循环源码。归档的 Round 5 反馈与本轮前的反馈文件一致。

**Round 5 的 3 MED 和 2 LOW 均已在设计层面关闭。** 未发现修订引入会导致错误或无法构建实现的新阻塞问题；可以进入实施。另有一项 LOW 文案一致性建议，不要求再开设计轮次。

本轮为静态设计评审，未执行测试、build、lint 或真房验证；测试矩阵仍是待实施的验证要求。未修改源码，仅写本反馈文件。工作树干净；工作树、v6→v7 及 Round 4→当前 HEAD 的 `git diff --check` 均通过。v6→v7 只变更 plan、exploration 和归档的 Round 5 反馈，源码未变。

以下 `plan.md` 指 `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md`。

## What's Good (Keep)

- `supersedePendingQaResults` 放到新事件插入的同一事务，并在 sweep 前兜底，直接关闭真实的 A→B 到达顺序缺口；只处理“无 accepted 行且最新 outcome 为 pending”的旧事件，不会否认已经接受的 verdict。
- 两个保留 id 作为同一 529 义务的替代形态，避免为豁免退出引入复杂的 merged 特例；carried 仍要求同 id 的真实 pass/carried 历史，普通 fail/not_run 的合并限制保持不变。
- C6a/C6b 按输入兼容与服务端开启拆分，匹配分阶段回滚：先停止生产新协议和执行强制门，再排空活体 QA，最后撤共享 parser。无需新增回滚状态机。
- 配置快照在监听前加载，route 和同步接受事务共享同一 `qaE2e529Required`，未知项目按 required 处理，消除了“尚未初始化被当作未开启”的歧义。
- 保留前几轮已经明确的 ledger-first、原子接受、legacy 分支、共享 decoder 与九个注入出口。529 证据存储缺失时继续标注未核对，不把 UUID 形状校验当成真机验证；QA 对 flow 与豁免理由的判断权也保持本轮既定范围。

## Issues & Recommendations

**阻塞问题：无。Round 5 关闭核验如下。**

| Round 5 项目 | v7 结论及当前证据 |
|---|---|
| #1 旧 pending 的 superseded 更新不可达 | **已解决。** `plan.md:185` 明确在 `insertEvent(B)` 的同一 StateStore 事务里终结同 execution 的旧 pending，并在启动 sweep 消费最新事件前兜底；`:290` 用“A 已拿到 pending → B 到达 → A 被终结 → startup → 原样重放 A”的真实顺序验证，且保留 accepted A 不受影响的负控。当前 `StateStore.ts:1128-1138` 有自增事件顺序和 execution/type 字段，`:142-143` 提供同步事务；`:2366-2392` 是现有事件插入入口。`getLatestQaResultEventForExecution` 仍按 `ORDER BY id DESC LIMIT 1`（`:3376-3382`），所以这一明确的插入边界与 `phase-orchestrator.ts:914-933` 的 sweep 接线能覆盖前轮缺口。 |
| #2 豁免转实跑被覆盖规则卡死 | **已解决。** `plan.md:87` 明确两个保留 id 仅在覆盖义务上互为别名，可直接 exempt↔ran；禁止保留 id 为 merged 或 into 目标；carried 仍限定 prior 的同名 `e2e_529` 为 pass/carried。`:281` 补转换路线和负控。当前 `auto-qa-coordinator.ts:1294-1307` 与 `phase-orchestrator.ts:1101-1127` 的多轮消费模型无需改变；修订只需作用于共享 schema/引用检查。 |
| #3 C6 遗漏于回滚及输入兼容 | **已解决。** `plan.md:312-315,329-330` 明确 C6b 随第一阶段撤回，C6a 与 C2b/C2a/C1 留到全部受影响执行退出后才撤；`:294` 增加带 e2e/exempt_category 的真实 CLI 兼容验证。当前参数入口为 `packages/flywheel-comm/src/index.ts:928-947`，保留该入口所依赖的完整 v7 parser，能避免前轮指出的网络前未知键拒绝。账本列回滚时保留、不读取，符合仓库的加性迁移方式。 |
| LOW 配置生命周期与类型接线 | **已解决。** `plan.md:107` 明确扩展 AutoQaConfigShape、监听前 await 一次、auto-QA 复用快照、向两条 route 和三个接受操作注入同步函数，并规定未知项目 fail-closed。源码 `auto-qa-config-source.ts:29-43` 的类型/异步签名、`plugin.ts:4325,6218-6261` 的原有初始化次序及 `StateStore.ts:142-143` 的同步事务均已重新核对，修订与这些约束相容。 |
| LOW PASS 接受行号及 EOF 空行 | **已解决。** `plan.md:158` 已指向 `auto-qa-coordinator.ts:1270` 的首次 PASS 状态写入；exploration 尾部空行已移除，相关 Git 范围 whitespace 检查通过。 |

因此，Round 4 #1 的剩余问题亦已关闭；Round 4 #2 的 ledger-first 回执顺序在 v7 保持成立。

**非阻塞建议 / Nits**

1. **[LOW][ADVISORY] 让注入文案同步说明 529 槽位例外。** `plan.md:205` 的 renderer 示例仍写每个非 merged id 都必须原样出现，并泛称可用 merged 退役；`:248` 的 kickback 文案也要求保留 every id。实施时建议将这两处表述限定为普通判据，再补一句“两个 529 保留 id 可以相互替代，但不能 merged，carried 只沿用同名已通过项”，并在 §7.5b 的角色/规则块保持同义。否则合法的 exempt→ran 提交虽然会被服务端接受，QA 仍可能按旧文案多保留一个互斥 id，造成一次可避免的拒收。§2.1 的机器契约和转换测试已经明确，此项是提示词一致性收尾，不重新阻塞已解决的 #2。

## Verdict

APPROVED

Blocking findings: HIGH=0, MED=0. Non-blocking findings: LOW=1.

批准 v7 的设计进入实施；此结论不代表尚未编写的实现或测试已通过。
