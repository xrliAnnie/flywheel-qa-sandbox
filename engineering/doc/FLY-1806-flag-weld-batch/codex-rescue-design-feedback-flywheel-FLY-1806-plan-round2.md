# Design Review — plan.md (Round 2)
Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 `_EFFECTIVE`、drift 边界、测试清单、分组和 baseline 五项反馈都已实质吸收，计划比上一版明显更接近可执行。但 `lead_chrome_enabled` 的删除方案会改变既有 fleet transaction 的 CAS hash schema，writer inventory 的设计期结论也仍漏了真实动态 forwarder；这两处都直接触及“当前值证明/零行为变化”硬门，因此尚不能批准实施。

## What's Good (Keep)

- `roundtable_thread_autocontinue` 已正确收窄为只焊 raw `!== "0"`，保留 parent-resolvability、`_EFFECTIVE` transport/allowlist、producer/consumer 以及 parent/no-parent 测试；这闭合了 Round 1 的首要行为问题。
- `.env` 已降为必要非充分条件，writer/forwarder/manifest inventory 被前置到任何塌缩之前，并规定动态或反向 producer 立即整条退出 E3；这个门的方向正确。
- drift guard 现已准确描述为四个 `packages/*/src` 下布尔 TS 读点的辅助证明；数值、shell、manifest 字段改由 repo-wide 多形态 sweep 与表驱动 registry/tombstone 断言覆盖，定向测试清单也补齐了 Round 1 指出的直接受影响套件。
- G1-G6 的编号实查覆盖 1-31 恰好一次、无重叠；registry row、tombstone、行为测试与代码塌缩同组提交的原则正确。`fa9fd4b06` 也确为当前 HEAD 祖先，旧的未来 rebase 风险已正确删除。
- `lead_dry_run` 的生产 setter 证据、31 个 registry default/主要读点方向以及 `RETIRED_FLAGS` 复用方式没有出现新的回退。

## Issues & Recommendations

1. **[HIGH] #29 不能按当前方案从 `manifest_projection_sha` 删除 `chromeEnabled`；这会使旧 transaction 的 CAS hash schema 全部失配。** `scripts/flywheel-fleet.sh:462-483` 对枚举对象做 canonical JSON hash，`chromeEnabled` 无论在 manifest 中为 `false` 还是缺席，当前 schema 都会输出该 key；hash 随后写入 transaction 的 `postImage.manifestProjSha`（如 `:923`、`:1070`），rollback 在 `:1340-1347` 用当前 projection 与历史 hash 做严格相等比较。因此，从 projection 对象删除 key 本身就会改变 hash，计划 §4.3 所说“若实现中才发现 CAS 依赖字段存在性”实际上已经由现有源码证实，并不取决于 15 个 manifest 当前是否全为 `false`。只读检查还发现本机 `~/.flywheel/fleet-backups` 有 37 个包含 `applied` lead 的 transaction journal，计划没有任何让旧 hash 失效的迁移/过期边界。照写执行会让原本可满足 CAS 的旧 journal fail-closed，改变 rollback 运维行为。**建议：**二选一并在设计期定案：(a) 删除 runtime/materializer/test-deploy 的配置能力，但保留 projection 中的 `chromeEnabled` key 作为既有 CAS schema tombstone，把它列为 sweep 的明确合法残留，并加“pre-change journal hash 仍可匹配”的回归测试；或 (b) 按计划自己的退出规则现在就把 #29 转 E3，并把范围、台账、分组、31 行断言及 PR 口径改为 30 条。若坚持“不留兼容层”，只能选 (b)。

2. **[HIGH] 设计期 writer inventory 的结论仍与源码不符，按当前三分类会错误处置 #23/#27。** 计划 §3/§5 称 #23 只有 `qa-room.sh:53` 的同向常量 writer、其余 29 条无 writer；但 `packages/teamlead/scripts/claude-lead.sh:1954-1965` 会在 raw env 非空时把 `FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE` 动态透传给 `env -i` 子进程，这也是计划步骤 0 明确要求枚举的 forwarder。`scripts/flywheel-cmux-autostart.sh:20-45,53` 则从 inherited env / `.env` 动态解析后 `export` #27；按步骤 0 当前字面规则，它同样会被归为“动态 writer ⇒ E3”，与台账继续删除相冲突。更直接地，删除 `claude-lead.sh` 的 raw 透传会影响计划声明为仓外的 Discord plugin consumer，因此不能只把它记成 QA 常量注入。**建议：**把 inventory 模型改为“producer/source、pass-through forwarder、同 env 的 resolver-local assignment”三类：forwarder 必须递归追到实际生产 source，再以 source 的当前值/是否主动设置决定继续或 E3；resolver 自身的派生 export 不应被误算成独立 writer。然后在 #23/#27 台账和 PR 理由中列出这些节点及终端 source 证据，修正“其余 29 条无 writer”的数量。若无法证明 #23 的生产入口始终未设/同向，则它也必须退出 E3。

3. **[MEDIUM] 表驱动断言的落点仍与“每个中间 commit 独立 GREEN”冲突。** §4.2 定义的是一次断言全部 31 条已退出 registry/进入 tombstone，§5 又说先写该断言形成 RED；若它随早期 group commit 落地，G1-G6 会一直红到最后一组，违反 §6 的独立可验证承诺；若只在 G7 落地，“每条 flag 的测试同 commit”又不完全成立。**建议：**明确每个 G1-G6 commit 同步扩充表驱动 case 到本组已删除条目，最后 G7 只验证汇总恰好等于最终范围；或者把完整 31/调整后范围的表驱动断言明确限定为所有组完成后的 G7，不再声称它是各组的 RED。另请删除计划第 6 行预写的 `R2 APPROVED`，让文档状态由实际评审结果决定。

## Verdict

CHANGES REQUESTED — address items above
