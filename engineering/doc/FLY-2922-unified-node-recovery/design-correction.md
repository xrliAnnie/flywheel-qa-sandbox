# FLY-2922 与返工两态合同对齐 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: plan.md

## 权威与范围

本补充落实本次重开指令中 Lead 明确给出的 FLY-2921 合同。原计划 c4d40fbed、有效 APPROVED 门 d9ab4f85-f464-4fee-9c09-7af6295b0c9a 保留；本补充仅覆盖其中返工投递的旧状态写法，不重开其余设计。原 review-result.md 的三个 MEDIUM 与一个 LOW 仍是非阻塞 Follow-ups，不宣称已解决。

继承实现头 d35da9cde 原样保留。本次节点是 design，未修改业务代码、运行实现测试或验证原 WIP 可用。实现进度原为 0/6，详见 implementation-evidence.md，全部剩余合同继续有效。

## 当前核对

- 本分支 dispatcher 的 replacementContext 仍要求 delivery.state 为 replacement_pending；仅改写入值会被 engine_rework_replacement_context_invalid 拒绝。
- FLY-2921 远端计划 C2/C6 已规定：替身投递 pending、新 preferred actor、同 request/route revision、dispatch reason 为 rework_replacement:<requestId>；启动围栏、上下文消费者、markWorkflowReplacementStartedTx 同步改为 pending。
- FLY-2921 C4 明确只对 replacement 回滚保持 run active，写非 hold 事件 rework_replacement_launch_rolled_back；非 replacement 回滚仍由本单处理。
- 这是分支合同核对，不是 FLY-2921 已合并或已部署的证明。合入后者负责同步并解决冲突，不能把仍要求旧值的生产消费者视作可用。

## 对原计划的精确覆盖

1. plan.md §2 的 FLY-2116 行、§3.4 返工段、§7 的 2116 验收行，以及 research.md 对旧消费者的描述中，目标写入 replacement_pending 全部由 **pending + 新 preferred_actor_execution_id** 取代。历史源码描述保留用于溯源，不是要求继续写旧状态。
2. rework_retry_exhausted、rework_activation_stalled_held、rework_pane_loss_handoff 只作为历史存量兼容输入。新返工投递失败由 FLY-2921 收敛，不再由本单 producer 重新生成这些 run hold。其 delivery 作用域的 returned_to_lead 不升级成 run 故障；不恢复第二套按原因分叉的恢复口。
3. 历史 held 的死目标仍走本单同事务 redispatch_current：固定 run/node/attempt，新 execution/ordinal/dispatch ledger/receipt；追加同 request 的 route revision，新 actor，delivery 与 verification path 同步 revision 并 pending，保留反馈、base_revision、verification_policy、批准内容与 lineage。清 owner/lease、旧 wake 与 grant 标记沿用两单既定精确身份规则，旧 wake 退休仍要求真实证明。
4. 新派发 reason 保持 rework_replacement:<requestId>。消费端同时校验 run/node/attempt/request/routeRevision/preferredActor 与 pending，不能为兼容而放宽身份围栏。replacement launching 的识别、启动成功写回、准入/启动回滚、协调器认领都使用 FLY-2921 的共同形态。
5. 协调器看到本单已铸出的 pending 替身与匹配账本，应沿 FLY-2921 的 replacement_launching 协议等待既有派发，不再铸第二具。路由解释来源须使用该协议识别的替身来源，并保留本单 operationId 审计关联；具体采用共用物化方法，不另造第三种未被消费者识别的来源。再次失败由当前所有者处理：active 的返工 replacement 走 2921；历史 held 恢复和非 replacement 的 run 故障走 2922。
6. 历史事件的 preferred actor alive/parked 时仍保留原 §3.4 的同 actor 重投语义；unknown 或 owner 在途拒绝，不把存量兼容当作强行换活体的许可。FLY-2921 的迁移可能把 delivery 改成 returned_to_lead，但不自动解冻历史 held run；分类器使用精确 run/request/route/事件证据归一，不能仅凭 delivery 新值认定 run 已恢复。
7. 两单冲突解决必须同时对齐写入与全部读取路径。后合者按 Lead 合同同步；不 force-push，不自行申请 ship。已保存的 WIP 不是此补充的完成证据。

## 必须追加的相关验收

| 场景 | 必须观察到的证据 |
|---|---|
| 三个旧 rework hold，各自死 actor | 同一 run/current node/request；新 actor/revision；delivery pending；新 ledger 与 receipt；真实 dispatcher 可消费，不因旧状态围栏拒绝 |
| 三个旧 hold，各自活体停驻 / unknown | 活体仅重投原请求；unknown 拒绝；不产生新 dispatch 或抢现有 owner |
| 2921 迁移后的历史 held | returned_to_lead delivery 不能冒充已解冻；统一入口按历史 episode 恢复后 pending，run active，旧事件有精确解决回执 |
| 2922 apply 与 2921 coordinator 竞争、响应丢失、重启 | tuple/route CAS 只允许一个新 actor、一个 ordinal 与一条 dispatch；重复请求返回同一 receipt；协调器不重复 mint |
| 第一次替身启动失败，再恢复 | 第二次使用新身份/ordinal/revision；各次 lineage 和恢复证据不撞 UID；失败归属按 replacement/non-replacement 分离 |
| 新返工投递失败负控 | 不再写上述三个旧 run hold，不将 active run 打 held；returned_to_lead 的投递恢复仍走 2921 原权限门 |

原九张单、FLY-2901/2914、完成顺序、carrier-close、quota/land/gate、并发权限等矩阵不减少。本机只运行相关测试；后续实现/QA 必须保存公共入口到派发消费者的证据，不能只检查状态字符串。
