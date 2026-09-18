# FLY-2662 收尾恢复 — 调研
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: exploration.md

## 结论
已合入后收尾的执行主体、目录目标和恢复权限需要分别补证，再用同一个 operation/run 的代次绑定。不是单独把 pending 判 gone，也不是只放宽 run.status。当前代码的真正恢复环必须整体测试。

## 源码证据（基线 06cbb3615）
| 文件与入口 | 已核对行为 | 设计影响 |
|---|---|---|
| `packages/teamlead/src/bridge/tmux-lookup.ts`：lookupTmuxTarget、listTmuxWindowsByExecutionId | 前者 pending→error；后者已有全窗 @flywheel_exec_id inventory | closeout 专用解析组合两者，不放宽 kill/attach 默认 |
| `bridge/execution-closeout-evidence.ts`：collectExecutionCloseoutEvidence | lookup error→unknown；hostProcess 是 boolean；任何 live veto，unknown 阻止 gone | 新增三态 host probe 与全窗结果；保留所有 veto |
| `bridge/lifecycle-closeout.ts:226,1518` | runIds 扩展所有调用；非 land 无 session 分支裸 finalize | 仅 land-managed 扩展；无行也走相同保护 |
| `bridge/land-intent-targets.ts:62,247,407,432` | NULL 拒绝；provider 要当前路径/绑定；部分 realpath/stat await 无 typed catch | 拆共享目标验证与旧作业补证，完整边界 typed refusal |
| `bridge/workflow-engine-dispatcher.ts:2309` | prepare refused 时 operation 参数传 undefined | 存在作业必须 with-operation hold；不能再次阻断 reclose |
| `bridge/hold-shape-registry.ts:145` | with/without operation 互斥 | 修新写与旧事件读取的兼容，不改写历史 event |
| `StateStore.ts:78066` / `bridge/land-executor.ts:304` | reclose 验远端 PR + merge receipt；held/partial 条件；replay 未比较 mergeSha；authorize 需 active | 原子补证 + run/node/dispatch/resume 更新；端到端防重入 |
| `bridge/lifecycle-routes.ts:293` / `flywheel-comm/src/commands/land.ts` | master token + 写死 authenticated-master | Bridge 验真实 Lead carrier 身份、项目与 issue scope |
| `bridge/lead-capability-runners.ts:85` | registry + forwardedLeadAuthorizationEnv + validateLeadCarrierAuthorization | 复用已存在身份检验，不能信任 actor 字符串或环境变量名 |
| `bridge/land-source-session.ts:137` | 无 gate owner 回落 resolveLandSourceSession，可借 sibling | post-merge 一律 operation context，无 owner 也不借 sibling |
| `bridge/post-ship-finalization.ts:590` | read snapshot 校验内容；目标消费未比较新 attribution | reservation 与每次破坏性副作用都需同一 snapshot revision |
| `StateStore.ts:77244` | 相同 step receipt replay 在 owner fence 之前 commitThreadArchive | 只读查询 replay 与有副作用 replay 分开，后者必须先 fence |
| `bridge/land-owner-liveness.ts` | 心跳10s，deadline5min，monitor2s；没有独立进展时钟 | 进度告警与存活续租分离；明确本单保留5min deadline |

上表 `bridge/` 与 `StateStore.ts` 均相对 `packages/teamlead/src/`。细项 finding、消费者和测试路径见 plan §7。

## 事故关系与状态
`land_operation` 保存 project/issue/run/PR/head；`land_operation_step.merge_confirmed` 保存 head+mergeSha；workflow snapshot/current terminal land node/dispatch 固定执行代次；attribution 收集 run nodes、activations、side effects 的 execution ids；session/worktree binding 和 CommDB 只提供各自证据，不能互相替代。
现网一个 issue 下可有多个 op，甚至同 run 不同 head；op ID 不能靠名称重新计算后覆盖老记录。现场 issue_id 可能是旧字符串 FLY-xxxx，而非 UUID；保持持久键不变，以服务端已验证 alias 解析外部 Linear UUID，不在本单做全库改键。

## 不变量
- 先 merge 事实，再 closeout；reclose 永远没有 merge/ensureShip 调用权限。
- gone 需要完整物理探测与 launch/heartbeat veto；probe 失败是 unknown。
- StateStore/CommDB 各自事务，不能假装跨库原子；证据有效期和 revision CAS 才能处理间隙。
- 身份/归属或 founder wake、TURN、取消/重开有变化则旧证据失效。
- 目录缺失只有可靠 parent/path/binding provenance 时才 settled；权限错误、重建、不同 generation 都拒绝。
- 长 await 外不能持 SQLite 事务；准备在锁内 await，提交在同步 CAS 事务，任何外部 effect 前重新验证。

## 证据限制和后续验收
本设计已核对只读数据和源码；没有运行修改后系统、没有 live gone 证明、没有 sandbox Discord/Linear readback。没有 production writes。Lead 在 question 604259b8-b1f3-4428-b02c-953b56cd6ee8 明确允许按只读查询的真实行形状逐字段脱敏重建，标注“非受管快照、形状来源=只读查询”；NULL/空串/缺失保持一致，不以新prepare工厂重铸实例。保存旧generation/steps与最小关系闭包。快照工具目前 owner 服务不可用，已向 Lead 报告。设计审阅不是运行验收。

## 受管快照失败原始回执与 Lead 裁定
时间取本次 runner 工具回执（UTC）：
- 2026-09-17T19:13:02.985Z：`node /Users/xiaorongli/Dev/flywheel/scripts/flywheel-snapshot-control.mjs runner --source /Users/xiaorongli/.flywheel/teamlead.db --kind teamlead`。
- 2026-09-17T19:13:14.903Z：`FLYWHEEL_EXEC_ID=34627a91-90da-4f99-a1c5-79149cc00848 node /Users/xiaorongli/Dev/flywheel/scripts/flywheel-snapshot-control.mjs runner --source /Users/xiaorongli/.flywheel/teamlead.db --kind teamlead`。
两次 exit=1，原始 stdout 均为 `{"ok":false,"reason":"snapshot_owner_unavailable","retryable":true}`。未生成/复制快照。第二次只显式传入已分配执行ID，不改变任何身份或凭据。
Lead response question `604259b8-b1f3-4428-b02c-953b56cd6ee8`：优先主死结、可独立PR；允许真实只读行形状逐字段脱敏重建，标“非受管快照、形状来源=只读查询”；不并入2658。已应用于 plan §8，工具失败本身由Lead记病根。

## 首轮送审后的只读补充
2598/2616 的指定目录均lstat ENOENT，完整Git worktree inventory无登记；sessions专用binding列仍有path/branch/generation。见incident-readonly.json的targetPathDetail/absentPathBindingSamples。plan revision 2纳入无历史parent inode的非破坏性absence attestation；不重建历史证据，不执行删除。这个修订必须再取effective review verdict。

## 第二轮权限与范围核对
Claude validateClaudeLeadLeaseAuthorization检查已登记的holder存在及lease有效，并未绑定发请求的进程；公开tuple可读不能当caller凭据。既有broker-socket只做路径/chmod/JSON，未提供peer认证。Lead选择新增窄Darwin socket适配器，非新增secret，细节见plan §3.1。只对reclose做映射，普通identifierShip与未配置Linear的现有行为不加新门。
Darwin接口依据为Apple一手源码：[Unix socket选项](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/un.h)、[proc identity结构](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/proc_info_private.h)。前者定义内核peer PID和audit token选项，后者定义进程及父进程unique id与pidversion；本机SDK的bsm/libbsm.h提供audit_token_to_pidversion，但proc private header不在该SDK公开头中。因而设计把ABI/SDK兼容与目标机实际探测列为实施及QA硬要求，未把源码定义当真机验收。
