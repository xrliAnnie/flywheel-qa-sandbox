# FLY-2662 收尾恢复 — 探索
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: 无

## 目标与范围
让已合入的卡通过一次 Lead 正门 `land reclose` 接回完整收尾：证明所有执行体 gone → 清工作目录 → 关闭记录 → 归档 thread → Linear Done。保持耦合；活体或未知不得因恢复命令而被当成已消失。当前是 design-only，不实施、部署、重启、清理生产卡或派发后继。

Issue 说“12 条 advisory”，实际列出 11 个 MEDIUM 加最后一组 4 个 LOW，共 12 组 / 15 个 findingKey。本单全部覆盖，不把最后一组缩成一个用例。FLY-2658 仅被描述为可合并派发；没有其明确任务合同，本设计不扩进它；Lead 后续确认此边界。主死结优先，允许独立PR先合；15项仍全部收口。

## 当前证据
基线 `06cbb3615` 已含 FLY-2616 merge `aaf8e9c0e`。没有已有 FLY-2662 文档，TURN design epoch=1 已确认。只读 SQL 证据见 `evidence/incident-readonly.json`：8 张点名卡、15 份历史/current 作业，其中 14 份 targets=NULL；不能将这个总数解释为 15 个待恢复当前作业。
5 张卡共有 6 条 `runner-flywheel:pending` 通信行；其中 FLY-2612 两条、一个为 failed。状态文字不是死亡证明。FLY-2606 同时存在旧 NULL 和新 v1 目标作业；FLY-2616 最新观察为 `closeout_only_run_not_active`。多个 run/op 并存要求精确身份，不按 issue 名挑任意一行。
受管 snapshot 两次返回 `snapshot_owner_unavailable`；本次使用两库各自的只读事务做限定字段核对，没有复制或写入生产 DB。该 JSON 是现场观察，不能充当完整/跨库一致回放 fixture，也不能证明真实进程 gone 或远端归档结果。

## 根因与选择
1. 窗口查询把 pending 当 error；证据汇总正确保守为 unknown，却缺少按 execution marker 搜索全部真实窗口的补证路径。
2. 旧 op 没目标快照；prepare 的拒绝把存在的 operationId 丢掉，归为 without-operation hold。resume 更新部分状态后 dispatcher 仍走旧 prepare 路径，可再次 held。现有 StateStore 已支持 held run→active，不应写成“所有 held 天生不能恢复”；要消除整个循环。
3. 内容哈希无法识别 A→B→A；目标集合虽然存了 attribution digest，清理消费者未重新核验；这两者会使旧证据误用于新身份。

| 方案 | 结果 | 选择 |
|---|---|---|
| 扩展现有 reclose：补证、冻结完整目标、原子恢复、按原次序收尾 | 一条正门；保留 fail-closed 和审计 lineage | 采用 |
| 自动扫库把 pending 改成真实窗口、NULL 填空数组 | 猜身份、漏目标、可能清活体 | 拒绝 |
| thread/Linear 提前结案，清体和目录后台补 | founder 看似结束但任务仍活着；违反本单耦合 | 拒绝 |

## 设计边界
恢复只修当前精确 merged op 的收尾，不复用或重铸 ship approval。旧窗口字段原样保留为 provenance，不凭缺窗重绑。部署前旧作业必须原样进入 fixture，不能先通过新 prepare 工厂补齐快照。所有 15 个 finding 在 plan 有落点和反例。
人工判断仅用于来源确实不可证明、卡被取消/重开/停驻、活体未停止等情况；正常两类事故数据应一次 reclose 即收敛。若 fixture 揭示所需来源缺失，必须设计可验证的正门补证并复审，不能以“安全拒绝”冒充本单成功。

## 工作清单
- [x] 项目/2616 基线与 TURN 核对。
- [x] 两种事故形状、替代方案与限制明确。
- [x] 调研全部调用方与持久化契约。
- [ ] 实施计划与有效设计审阅。
- [ ] Founder HTML、托管验证、结构化报告、design completion + park。
