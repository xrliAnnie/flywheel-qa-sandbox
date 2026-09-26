# FLY-2922 恢复链与消费者审计 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: exploration.md

## 证据范围

代码基线 af853328d，续接文档救援 head 3e3a6000a。依据仓库当前源码、已有测试、engineering/doc/FLY-2072-triage/fixclasses.json K07 与 tickets.json。2026-09-26 本轮复核关键源码；以下为静态证据，不是运行验收。本机未运行实现测试，未读取或修改线上数据库。

## 生产者到消费者

| 入口 / 源事实 | 当前消费者 / 缺口 | 设计约束 |
|---|---|---|
| StateStore resume_unlaunched:58340、resume_retry_limit | 节点改 pending、execution=NULL；dispatcher 读账本 | 原子生成新身份并调用 allocateWorkflowLaunchOrdinalTx，不能只改节点 |
| allocateWorkflowLaunchOrdinalTx:86433 | INSERT dispatch ledger 并 mint launch delivery，当前返回 ordinal | 通过完整 tuple 查询新账本 id 写回执；不要把 ordinal 当 ledger id |
| workflow-engine-dispatcher.ts:2464–2498 | 返工检查 preferred actor、reason、delivery state/revision | 同请求新 revision 与 replacement_pending 必须同时满足，防有账本却不消费 |
| StateStore resumeWorkflowHold:59048–59064 | 无剩余 hold 才 active，并复活 run_inactive carrier | 统一事务保留 carrier 复活；不能声称现有 land 外层完全没恢复 run |
| commitEnrolledCompletion:65145–65364 | 事务内 transition 后 projectGeneralizedCompletionTx | 已具备正确骨架；补 enrolled 漏分流与失败原子性回归，不再造异步完成协议 |
| event-route.ts:1675 | founder review 预检未按失败 route 分开 | blocked 专用失败登记在成功产物校验前分流，不生成成功 completion |
| close-runner.ts:404、actions.ts:1546/1709 | cascadeRunTerminationOnCarrierClose 会终结 run | 移除隐式级联；显式 run terminate 保留，并同步工具说明与驻留生命周期 |
| pruneWorkflowDeadExecutionWatches:60396 | TTL OR 非 active 会清理 held 证据 | active/held 的 active 或 tripped watch 保留，仅真终态/孤儿可清理 |
| codex-quota/run-recovery.ts:41–135 | waiting 后 terminate/start；persist 没有 CAS 返回值 | 精确 target/generation CAS，人工与额度恢复共用重派，旧在途请求服务端阻断过期 authority |
| lifecycle-routes.ts land resume | apiToken 权限弱于 runs-route master+loopback+confirm | 旧 full resume 仅返回统一正门定位，不能升级弱权限代写 |

账本 intent_recorded 是派发承诺；launch_committed/started 与可见窗口启动证据才证明执行体起来。展示 node_dispatched 事件不能代替账本；账本也不能代替真实启动证据。

## R1 反例与修订

人工 pause 可有活体，gate 节点为 review + execution=NULL，idle/loop 的 source 已 done。统一故障事务的「旧体死、源节点未完成」守卫不能套用这些情形。因此 stage 冻结服务端派生的操作语义，状态恢复如实返回 state_applied；只有 redispatch_current 和业务目标派发返回实际派发回执。不开放客户端任意选择宽权限算法。

已有 FLY-2329 受害者可能已 active+pending NULL，不能只列 held。提供只读 inventory 与证据严格绑定的 active orphan 修复；缺少唯一历史 rollback/resume 证据时拒绝猜测。

额度守卫不能裸删：waiting CAS 被统一恢复取走后，旧 worker 的 persist 必须失败且不得发 terminate。旧 terminating/starting/queued 先收敛原持久请求。服务端再次检查旧 tuple 与恢复代次，防已经发出的旧请求关闭新体。

## 验证与消费端范围

实现按 plan.md §6–7 做 TDD，逐文件运行相关 vitest；九张单分别保存 old/new tuple、恢复回执、dispatch ledger、launch delivery 与 consumer 启动证据。补并发、重启、响应丢失、过期 token、旧体迟到、真实审批内容变更、再次失败负控。

消费者 sweep 必须包含 packages、scripts、插件 fork external_plugins 与本机插件缓存，记录时间和每个调用方处置。设计本轮未扫描外部插件 root，不声称其零引用；实现交接明确要求补该证据。保持 hold CLI 兼容定位参数，删除按故障原因选择算法的分支。

本调研仅依赖本仓实现事实，不引入新的服务、队列、远程渲染器或架构重写。具体事务、迁移、回滚和错误码合同见 plan.md。

## R2 追加源码核对

已确认 dispatcher:2644–2785 通过 edge_traversed 或 execution_dead_rolled_back 回溯前序；单独 node_dispatched 无效。StateStore:61500–61780 的死体替换还维护 writer replacement、resume attachment/issue_delivery 迁移及 watch，统一入口必须复用这些记账。loop/idle 的现有 resume 分支只有新节点与 node_dispatched，不能直接照搬为完成方案；业务继续须补可消费 edge 与 QA fix context。

同时确认 pane-loss 恢复可写 active 而没有 hold_resumed，land full resume 留下的是 land_operation_step 的 resume_authorized 收据。旧开放事件须按精确关联收据投影 superseded，不能按时间一笔清除。plugin.ts done-close 仍用 legacy finalizeDone，enrolled 分流必须只认真实 completion。以上具体修订及验收见 plan.md §3.1、3.4、3.5、4、7、10。
