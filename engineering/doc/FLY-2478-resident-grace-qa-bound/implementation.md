# FLY-2478 resident 判决释放 — 实施验证
Issue: FLY-2478 (https://linear.app/geoforge3d/issue/FLY-2478)
日期: 2026-09-11
基于: plan.md

## 固定设计与实施范围

按已批准 plan v2 blob `3347d8657d3893f21b0bbf8a4ffec4981b9a82d3` 实施 C0–C8。
不修改已冻结方案。设计评审的 Lead acceptance 要求代码评审先复审该方案，设计级 HIGH 仍阻塞。
C9 真机验收属于独立 QA 节点，尚未执行；本实现节点没有部署或重启服务。

- 判决通过在 workflow transition 事务中请求释放，失败保留原体返工；固定兜底 3 小时。
- 到期 saga 收到 ACK，或现有查找器与登记满足死证规则后，原子结算 hold、session、park 和 operation。
- session 只在 `ship_parked` 且当前 activation 精确匹配时进入 `completed`，记录终态时间及 lifecycle revision。
- dispatcher 有待处理 hold 时走快速释放；与维护通路共享每项目单飞；不新增定时器。
- 已释放/到期的返工直接进入替身路径；其他 wake 错误保持原行为。
- resident 更大 boundary 续期且保留 revision；adapter 遇 stale boundary 只采纳同 activation/node 的 resident/woken 记录。

## RED → GREEN 记录

| 分块 | 预期 RED | GREEN 与负向守卫 |
|---|---|---|
| C0 | 常量仍为 1,800,000；CLI 仍提示 30 分钟 | 10,800,000；判决绑定文案 |
| C1 | 缺少 release_cause/source 两列 | 新库列集合、旧 SQLite 数据保留、连续 reopen |
| C2 | qa_pass 后 hold 仍到 03:00，release_cause 为 NULL | 通过触发、FAIL 原体、founder 打回不触发、两个循环目标隔离、woken/expired/closed 不改、陈旧 writer/attempt 拒绝、重放幂等、事务失败回滚 |
| C3 | requested + absent 不投影；探针/登记读取异常把 op 永久 failed | 缺 ACK 恢复、running 不探针、alive/indeterminate 不放行、显式 failed 保留、无依赖 ACK-only、两 vendor SQLite reopen 后继续 |
| C4 | PASS closed_reason 仍 expired；session 仍 ship_parked | 同事务终态与 park 清除、activation 不匹配/已有 failed 不覆盖、ship gate park 保留、注入 park 写失败回滚、重复 closeout 与 divergence 静默 |
| C5 | dispatcher 不调用 due count/callback；StateStore 缺计数方法 | 0 候选不回调、到期/未投影计数、异常不阻断后续 reconcile；共享单飞与 DB 释放经代码自查 |
| C6/C7 | expired wake 返回 retryable | pending 与 turn_granted 均转 replacement_pending；不增 hold_count；completed pane-loss 零事件/通知，ship_parked 对照产生 advisory |
| C8 | resident 较新 boundary 被拒；两条 woken→resident 残留旧 release metadata；adapter stale 抛错 | 续期不换 revision，旧边界拒绝，旧期限不误过期，飞行中的旧 revision wake 有效；Bridge authoritative boundary 本地持久化并经控制器 reopen |

C6 实施细节：进入 wake 前 delivery 可由 pending 变为 turn_granted，因此替身 CAS 显式使用 turn_granted，不能继续使用闭包捕获的旧 pending。

## 本地验证

2026-09-11，当前实现代码：

- `pnpm lint`：exit 0，既有警告保留。
- `pnpm -r build`：exit 0。
- TeamLead 8 个定向文件：225 tests passed。
- Claude runner 的 resident receiver / phase lifecycle：31 tests passed。
- Comm CLI `complete.test.ts`：70 tests passed。
- `git diff --check`：通过。

宿主全量 `pnpm test:packages:run` 按 Lead 指令 `524bd42f-8c37-4e95-8e75-d2ed35cf3829` 不运行，交精确 HEAD CI 的全部 package shards。没有新增 scripts shell suite。最终 CI 与外部评审仍待运行，不以定向测试代替。

## 对已冻结设计的证据口径更正

Lead 对问题 `0be14023-0e25-42eb-954b-abbb2e67f40f` 裁定：本单保持锁定实现，不新增宿主进程探针；推送前审计 prune 路径。

原链路是：CommDB 行缺失 ⇒ `lookupTmuxTarget` 判 gone/absent，**非独立宿主探针**。已冻结 plan C3/C5 中有关二次死证的描述应以本补充说明为准。最终按下述裁定将新释放探针的 gone/error 都改为 indeterminate，不能把缺失登记描述成独立进程死亡观测。

审计发现：`post-merge.ts` 使用会折叠 lookup 错误的 `getTmuxTargetFromCommDb`，undefined 分支设置 physicalGone，然后调用完整 CommDB finalize。这不等同于 proven teardown。已按 Lead 条件暂停推送并提交问题 `9a1705a4-4e9b-4bea-962c-0ed35ee884db`，等范围裁定；尚未更改该外部路径。

补充全路径审计结果（2026-09-11，源码只读，无生产数据变更）：

| 删除路径 | 证据与限制 |
|---|---|
| `stale-blocker-guard.ts:235–240` | FSM 行缺失或终态直接 `finalizeCommunications(false)`；helper 仍完整删除 session，false 仅记录 audit，不是禁止删除 |
| `post-merge.ts:236,270,283` | lossy target getter 将读取错误折成 undefined，再把它视为 physicalGone 并 finalize |
| `close-runner.ts:728,757` | 同类 lossy lookup；虽然之前调用 Codex daemon reap，仍没有由此证明窗口目标消失 |
| 其他常规 package 删除家族 | terminate、crash reaper、ghost、FSM reconcile、dead-terminal prune 有 probe/kill/ACK 守卫；pending abort 只删 `:pending` 注册 |
| 脚本 cleanup / retention | cleanup 以只读 CommDB 读取；retention registry 保护 sessions |
| operator R4 migration / rollback | `r4-window.sh:396–409` 与 `rollback-r4.sh:419–443` 可替换整库；检查 authority 停止与 DB holder，不证明 resident 进程消失。未核当前安装产物或生产使用 |

因此不能作出“所有 CommDB 行删除均代表 proven teardown”的结论。完整审计已通过报告 `9371d85b-6f6e-422a-a7d8-2896c66101cb` 送达 Lead。

## 最终范围裁定与修复

问题 `9a1705a4-4e9b-4bea-962c-0ed35ee884db` 及补充确认 `b24de8a9-2636-46c5-b902-8b1bdf04bc95` 已答复，解除推送暂停，授权以下最小修复：

- post-merge 改用已有 `lookupTmuxTarget`，error 保留登记并报告 partial；found/gone 的既有清理行为不变。
- 新增的 plugin resident probe 对 gone/error 均返回 `indeterminate`；只有找到的目标才调用进程探针。Codex request-bound ACK 仍可直接推进 saga。
- legacy `getTmuxTargetFromCommDb` 及其他消费者不改；tmux-lookup 仅更正 gone 的说明。
- stale-blocker 与 close-runner 的删除证据缺口留作 Follow-ups，本单不修。

新增 RED：post-merge 在 lookup error 时仍 finalized；新 probe 在 gone 时返回 absent、error 时抛错。GREEN：post-merge 19 tests、生产 probe callback 隔离执行 3 tests、expiry saga 14 tests，合计 36 passed。probe 测试执行从 plugin 提取的实际 callback，不启动 Bridge，不能替代宿主实测。

限制：缺少登记且没有 shutdown ACK 的遗留 hold 现在保持 pending，不再凭登记缺失自动结算。这是安全裁定的预期结果；不能承诺所有历史 expired 行在一个维护 tick 内归零。真正的宿主死亡恢复留给后续更强探针。

## Follow-ups 与尚待证据

- 更强的独立宿主进程探针：按 Lead 裁定记录于此，不创建新单。
- stale-blocker / close-runner 中登记删除与进程死亡证据的缺口：按 `b24de8a9` 留作后续，不扩本单实现范围。
- C9：真机 QA FAIL 原体复用、PASS ≤60 秒释放、释放后替身、patrol 静默及重启后停驻存活，由 QA 独立验证。
- plugin 单飞/CommDB 生命周期目前为代码审查证据；dispatcher 行为有可执行测试。

## 续跑 CI 修复（2026-09-11）

PR #1164 原头 `e4a2e691edbcd3e3e78d67059ae2e9e396caf087` 的 CI run `34639792611` 中，TeamLead 两个 job 因 post-ship-finalization 测试失败。生产 post-merge 已使用 typed lookup，但该测试仍将 typed lookup 固定为 gone，目标夹具只接到旧 getter，导致清理顺序等 5 项断言失败。

本地原样复现 5 项失败后，仅将 typed lookup 夹具接到相同的目标与错误配置；未改变生产行为或放宽断言。post-ship-finalization 49 项与 post-merge 19 项合计 68 项通过。原头 CI 失败不能算通过；修复头须重新运行精确 HEAD CI 与代码评审。

## R2 代码评审阻塞项修复

评审 request `42aefe6c-2fa8-485d-a109-5e6c58694549` 对 `d650231fa` 返回 CHANGES_REQUESTED。唯一 HIGH `resident-fastlane-1hz-commdb-storm`：长期 expired/applied 记录使原全局计数持续非零，每秒打开所有项目 CommDB；已核实该代码路径。

修复限定于 C5 快速调度：

- 根据 due resident 或最近 60 秒创建的 pending expiry operation 查询所属项目，只打开这些已配置项目的 CommDB。
- 快速通道每 10 秒最多执行一次，operation 创建后的快速重试窗口为 60 秒；只读取该窗口内的 operation，不扫描旧 pending 任务。
- 过窗后仍缺少关闭证据的任务保持 pending，原维护通道继续重试；后续 ACK 可以正常收敛。未添加超时终态、flag、进程探针或新定时器。
- RED：缺少项目/窗口查询；dispatcher 未传项目名单。GREEN：161 项相关测试，涵盖旧 backlog 退出快速通道、项目名单、10 秒限频，以及维护通道凭后续 ACK 完成释放。lint 与全仓 build 通过。

非阻塞建议已保留供 Lead 跟进：`registry-absence-permanently-stalls-expiry`、`tmux-absence-not-daemon-death`、`release-voided-by-boundary-renewal`、`probe-test-regex-extracts-plugin-source`。本轮不扩大到已裁定保留的死亡证据问题、边界续期语义或测试结构重构。新头需要重新登记代码评审与 CI。

## Lead 裁定后的最终四项修复（R4 输入）

Lead 问题 `453b243c-1ace-455f-9f78-626b229ef975` 明确裁定：R3 新 HIGH 属真缺陷，允许以下四项有界修复并开最终 R4；R4 若有新 HIGH，原文上报，不开 R5。以下行为覆盖前文涉及这些四项的旧实现说明；冻结 plan 不修改。

1. **ship carrier 保护**：判决释放必须匹配最新 open `rework_reachable_wait` park 与 activation。最新 park 是 `runner_ship_gate_wait` 时，到期扫描、快速项目选择、待执行操作与最终投影均跳过；session 不写 completed。正向测试改用 land manifest 并提供真实 PR binding；runner_ship 负向场景断言 PASS 后 hold/session 不变、兜底扫描不发 shutdown。过期操作与新 ship park 相遇也不能投影。
2. **同 revision 续约**：已有 `release_cause` 时保留 cause/source、grace_started_at 与 grace_expires_at，只更新 boundary；无待释放判决时正常续期。返工后新 revision 清理 metadata 的原测试继续通过。
3. **request-bound gone**：只有本 execution + 本 operationId 的 shutdown control 为 requested，probe 才获得放行 gone 的证据；其他请求/缺请求不可放行。lookup error 始终 indeterminate。已 acked 的请求照原途径收敛；仍 running 的登记不绕过原守卫。Claude 没有该 request-bound control，因此其 gone 仍不凭空作为 teardown 证明。
4. **wake fence 分类**：pre-check 的 expired/closed 才返回 `resident_hold_expired` 并允许 coordinator 直接换体；woken 返回 `resident_hold_already_woken`，投递后 CAS 丢失返回 `resident_hold_wake_conflict`，后两者走原 retry 路径。

RED→GREEN：续约测试复现释放期限被推后；wake 两例复现错误 expired 分类；carrier/park 五例复现误释放；request-bound probe 三例复现丢失证据参数。最终 11 个定向测试文件 **313 tests passed**；`pnpm lint` exit 0（既有 warnings）、`pnpm -r build` exit 0、diff whitespace check 通过。宿主不跑全包，按 Lead 指令交精确头 CI。

剩余 LOW Follow-ups：unused `countDueResidentHolds` API、probe 测试 source extraction、短窗口内 CommDB archive-on-open 开销；未扩本轮范围。强宿主进程证明的既有 follow-up 保留。C9 真机验证仍由独立 QA 节点执行，本节点没有部署或重启生产服务。
