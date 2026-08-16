# Design Review — plan.md (Round 3)
Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的 forwarder 分类和按组断言时序已经闭合，保留 fleet projection key 的总体方向也正确，原有行为阻断没有回退。但 Chrome 方案仍建立在一个错误的 jq `//` 语义推断上，并由此把不必要的 manifest 恒值残留写成 CAS 必需条件；同时 sweep 例外与 preflight 数量尚未同步，因此计划还需要一次小而实质的正确性修订。

## What's Good (Keep)

- #23 已把 `qa-room.sh` 明确归为同向 terminal source，把 `claude-lead.sh:1954-1965` 明确归为 pass-through forwarder，并逐一解释删除后仓外 plugin 仍从 ON 到 ON；这关闭了 Round 2 的 writer 证据缺口。
- #27 的 `load_cmux_bool_flag` 被正确识别为 resolver-local assignment，而不是独立 writer；新的 source / forwarder / resolver 三类模型可直接用于 implementation-time preflight。
- #29 已不再删除 `manifest_projection_sha` 中的 `chromeEnabled` key；保留 canonical projection schema 能维持历史 `postImage.manifestProjSha` 的比较合同，37 个现存 applied journal 也被明确纳入风险说明。
- 表驱动 tombstone 断言现在随 G1-G6 各组累积，每组独立 RED→GREEN，G7 只校验最终集合；这与每个中间 commit 独立可验证的目标一致。
- 31 条分组仍覆盖 1-31 恰好一次，`fa9fd4b06` 仍是 HEAD 祖先；`_EFFECTIVE`、drift 边界、测试清单、registry/tombstone 同 commit 等前轮已通过项均未回退。

## Issues & Recommendations

1. **[MEDIUM] §4.3 对 jq `//` 的关键推理不正确：`chromeEnabled:false` 与字段缺席在当前 projection 中都会成为 `null`。** 当前表达式是 `chromeEnabled: (.chromeEnabled // null)`；实测 `{}` 和 `{"chromeEnabled":false}` 都输出 `{"chromeEnabled":null}`，只有 `true` 保持 `true`。因此，会破坏历史 CAS hash schema 的动作是**从 projection 对象删除 `chromeEnabled` key**，不是停止在 manifest 中生成 `false` 字段。当前方案保留 projection key，所以是安全的；但“必须让 materializer/test-deploy 恒发 false，否则旧 journal hash 失配”的理由不成立，也把本可删除的配置字段误写成永久 CAS 载体。**建议：**保留 `flywheel-fleet.sh` projection key byte-for-byte；然后二选一并写对理由：(a) materializer/test-deploy 停止生成该字段，明确说明 absent 与旧 `false` 都投影为 `null`，所以 CAS hash 不变；或 (b) 为了 manifest 原始 byte-shape 兼容继续恒发 `false`，但说明这是 carrier 形状兼容选择，不是 CAS hash 必需。回归测试应 pin 一个改动前 fixture 的**字面量 golden hash**（不能在测试运行时用同一函数同时生成“expected”），并最好钉住 false/absent projection 等价；若选择 (a)，再断言 post-change materializer 输出的 projection 等于该 golden。

2. **[MEDIUM] 完删证据和 preflight 口径尚未随新方案完全同步，照文执行无法得到宣称的零命中结果。** §4.2 的 #29 合法例外只列 `flywheel-fleet.sh` projection 与 materializer 恒值行，但 §4.3 同时要求 `test-deploy.sh` 保留恒值 `chromeEnabled`，相关 fleet/materializer fixtures 也必然继续命中别名 sweep；这些都不是 doc/tombstone，必须分成“live-code 合法残留”和“test-only 合法命中”逐项列出。另 §5 仍写旧结论“29 条无 writer、#23 一个同向、#29 manifest”，与 §3 的新台账“#23 source+forwarder、#27 resolver-local、#29 manifest、其余 28 条”矛盾；§3 的通用 PR 理由模板也仍使用旧的“无 writer/同向 writer”措辞。**建议：**让 §4.2 的例外表与最终选择 (1a/1b) 精确一致，更新 §3/§5 为同一 source/forwarder/resolver 口径；同时把 §6 固定“31 行 PR 表”改为“最终实际范围（正常 31，#29 escape 时 30）”，与既有 escape 条款一致。

## Verdict

CHANGES REQUESTED — address items above
