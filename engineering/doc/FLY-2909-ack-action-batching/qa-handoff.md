# FLY-2909 ACK 开关返工 — QA 交接
Issue: FLY-2909
日期: 2026-09-26
基于: plan.md

## 治理与生效

项目级 `lead_ack_action_batching` 默认 false，通过 `feature-flags set --name lead_ack_action_batching --to on|off --project <project> --reason <reason>` 写入 SQLite。优先级项目行、* 行、默认。读取/文件失败退回关闭；开启但缺规则资源则拒绝装配。无 env/config.yaml 第二控制面。

Claude launcher、旧 Codex shell bundle 和 Codex v2 capability parent 均在下一次启动装配时读取；当前已启动 Lead 的提示不会热替换。QA 必须记录每个真实载体的启动代次、flag row、规则源 digest，不能只改 DB 就假定已生效。本 implement 未打开生产开关，未重启 Lead/Bridge。

## 必须的 529 真房矩阵（由 QA 执行）

Claude Lead 与 Codex Lead 都测 OFF、ON、ON→OFF 回退。Codex 房间由 Lead 在沙箱外代起。必须真实 Lead 载体收真实 mailbox batch，mock/直接手调 ACK 不能代替。

1. 普通需动作批次：ON 的 ACK 与首个处理动作出现在同一次 assistant response 的工具调用中。记录请求、工具 id 与 batch id；比较 OFF 的 ACK 独立轮数。
2. 纯状态通知：有其他收尾动作时同发；ACK 是唯一必要动作时立即单发，不延后或漏 ACK。紧急 founder 输入不等待凑批。重复送达的已处理消息也必须 ACK，不重复执行业务动作。
3. 对每批跟踪投递→lease→ACK admission→消费回执，并注入无 ACK 的 lease 过期与重投。比较 ON/OFF：无丢批、无重复业务处理，重投与该唤醒的事件仍按原系统工作。
   - ACK 与首动作同发但首动作报错：确认该批仍可重投，或未完成项仍留在 Lead 的权威待办中。
   - ACK 与首动作同发后、批次尚未处理完时杀掉 Lead：重启后确认未处理消息仍会重投，且不会被误判为已完成。
   任一载体或任一开关状态出现丢信即判 FAIL，不得用本地 mock 或提示文本检查替代。
4. OFF 规则源 SHA 必须匹配 ack-rule-oracle.json 的 off 值；Bootstrap 与原始生成/格式化字节一致。token-savings 的两套 shell 规则分别比对，Codex v2 保留其原有源选择并核对实际 source manifest。
5. QA 请求冻结头 full exact-head CI；实现的 focused/related/CI Scope OK 不代表此项或真房通过。最终 founder gate 仍必需。

## 基线复跑

`python3 packages/teamlead/scripts/measure-ack-roundtrips.py --transcript-root /Users/xiaorongli/.claude/projects --since 2026-09-11T22:00:00Z --until 2026-09-25T22:00:00Z --json`

本轮重新扫描 240 个 transcript（较旧扫描新增文件，不改变窗口内计数），零解析错误：ACK-only 返回触发请求 6,811 / 3,293,551,689 tokens；其中随后无工具调用 5,457 / 2,582,466,787 tokens。原始汇总见 baseline.json。脚本统计 Claude transcript；Codex 真房用原生 transcript 的 response/tool id 另行记录，不宣称此脚本支持 Codex。

## attempt 3 追加（Codex 路径返工）

- Codex TUI Lead 的 daemon 与 thread 在 Lead 重启后存活，`baseInstructions` 不会刷新；**不要**用 rollout 里的 base_instructions 判断开关是否生效。ON 的 Codex 证据改看：sidecar 日志 `[lead-ack-action-batching] Codex mailbox turn receipt=1`，以及该 mailbox turn 的用户输入末尾含 `[ACK timing · lead_ack_action_batching]`（OFF 时不含，且输入与 Bridge 批次字节一致）。
- 判据不变：真 529 Codex Lead 回合里 ACK 与首个处理动作出现在同一模型步骤（同一 `exec` 脚本或同一响应的并行调用），OFF 时拆开；首动作失败、处理中被杀两例仍须不丢信。runner-test-discipline A–D 在新头重跑。
