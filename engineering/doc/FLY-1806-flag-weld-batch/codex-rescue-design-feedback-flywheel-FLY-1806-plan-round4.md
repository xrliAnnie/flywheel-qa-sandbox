# Design Review — plan.md (Round 4)
Date: 2026-08-16
Author: Codex
Status: APPROVED

## Summary

Round 3 的两项问题已完整闭合：Chrome 方案现在准确区分“projection key 决定历史 hash schema”与“manifest 中 false/缺席等价”，完删例外、preflight inventory 和最终范围口径也已同步。结合重新核验的源码、部署状态与测试接缝，本计划可以按写法执行，并具备逐条退出 E3、保持零行为变化所需的证据门。

## What's Good (Keep)

- #29 现在只保留 `flywheel-fleet.sh` projection 中的 `chromeEnabled` key，停止 materializer/test-deploy 生成或读取配置字段；这既删除配置能力，又保持 37 个现存 applied journal 所依赖的 canonical hash schema。
- jq 语义已写对：`false` 与字段缺席经 `.chromeEnabled // null` 均投影为 `null`，只有从 projection 对象删除 key 才会改变 schema。已部署的 15 个 `chromeEnabled:false` manifest 无需回写。
- golden 回归要求是非自证的：expected 为字面量 hash，不由被测 helper 在运行时现算；同时覆盖 false/缺席等价，以及 post-change materializer 输出仍投影到同一 golden。现有 `flywheel-fleet.test.sh` 已通过 `FLYWHEEL_FLEET_SOURCED=1` 暴露真实 helper，测试接缝可行。
- 完删 sweep 已将 live-code 合法残留、test-only 合法命中与历史 doc 分栏；#29 正常实现后唯一 live `chromeEnabled` 命中就是 projection schema key，不会再出现“要求保留却宣称零命中”的矛盾。
- §3、§4.1、§5 和 §6 现已统一采用 source / forwarder / resolver-local 模型：#23、#27、#29 的节点和终端 source 证据明确，其余 28 条无 source/forwarder，PR 表按最终实际范围生成。
- 前轮已通过的 `_EFFECTIVE` parent 条件、writer preflight、drift 边界、31 条唯一分组、registry+tombstone 同组提交及按组 RED→GREEN 均未回退；`fa9fd4b06` 仍是当前 HEAD 祖先。

## Issues & Recommendations

1. **[NON-BLOCKING] Golden fixture 必须让所有 projection 字段保持确定性。** `manifest_projection_sha` 还包含 `projectDir`、`workspace`、`projectsFile` 等字段，而现有 materializer harness 使用 `mktemp` 路径；实现时应使用固定语义值的 fixture/参数，或在进入真实 helper 前构造确定性的等价 manifest，避免把随机 sandbox 路径写进字面量 hash。保留计划已规定的三重断言：固定 pre-change golden、false/absent 等价、post-materializer projection 命中同一 golden。

## Verdict

APPROVED — ready to implement
