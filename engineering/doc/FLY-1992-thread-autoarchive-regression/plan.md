# FLY-1992 thread 自动归档回归 — 实施计划
Issue: FLY-1992 (https://linear.app/geoforge3d/issue/FLY-1992/ship回归-thread-自动归档再次漏1832-已修已-ship-后回归同日同链-3-成-3-漏1831-漏-8h1975-1h1944)
日期: 2026-08-22
基于: research.md、design-correction.md

## 0. 结论

3 成 3 漏的分水岭不是 cleanup mailbox 是否消费：六单的 cleanup 信都可能进入 DEAD；成功组在 closeout 时 workflow phase 已物理消失，漏组则稳定停在「窗口仍活、shutdown 未 ack、land closeout 重试」的不动点，9 次重试后 held。

修复只针对 merge-confirmed 的 engine land 终局：给所有 runner vendor 使用同一套 phase/window 证据，在一次失败 pass 与完整 shutdown 响应窗口之后，调用现成的 strict tmux cleanup。收敛后沿既有 terminal → thread archive → Linear Done 路径完成；收敛失败则把有界原因写进 founder thread 与 Lead alert，不静默。

## 1. 范围

| 文件 | 最小改动 |
|---|---|
| `bridge/shipped-husk-escalation.ts` | vendor-neutral 候选、五道证据门、strict tmux cleanup、可重放 intent/receipt |
| `bridge/post-merge.ts` | 为既有 cleanup 增加 strict execution identity + authority fence；legacy 调用方不变 |
| `bridge/post-ship-finalization.ts` | 在 resumable land closeout、worktree cleanup 前运行 escalation；失败 cause 阻止静默归档 |
| `bridge/land-closeout-cause.ts` | 有界 cause token 与 founder 可读说明 |
| `bridge/land-executor.ts`、`bridge/plugin.ts`、`StateStore.ts` | partial/held 原因贯通、终态 thread 说明、`aux:` 收据不污染 retry epoch |
| `packages/config` | `FLYWHEEL_SHIPPED_HUSK_FORCE`，default on，`0` 可关闭强制收敛 |

明确不做：

- 不按 Codex、Claude 或未来 vendor 分支；`adapter_type` 不是资格或动作依据。
- 不把 archive 与 closeout 解耦；仍禁止在 live/不确定 runner 上方归档。
- 不修 FLY-1985 mailbox/daemon wedge 本体。1985 是相关上游活性病；本单修通用 teardown 收敛。
- 不新增 execution-wide `ps`/signal reaper。R2 真机证明 runner 启动的 Cursor 等脱离应用会继承 `FLYWHEEL_EXEC_ID`；按该变量杀进程组会误杀用户应用。
- 不自动 resume 已 held 的历史 land operation。

## 2. 证据门

每个候选 phase 必须同时满足：

| 门 | 证据 | 不满足时 |
|---|---|---|
| g1 | session 是 `design` / `implement` / `qa`，属于本 issue，并通过 workflow activation 绑定当前 `operation.run_id` | 跳过 |
| g2 | CommDB 找到目标，tmux process probe 恰为 `alive` | gone 走既有 closeout；indeterminate 不拆 |
| g3 | `runner_shutdown_controls` 为 `requested`，且已等待完整 `DEFAULT_ACK_TIMEOUT_MS`；acked/failed/缺行不拆 | 跳过 |
| g4 | 当前 closeout retry epoch 已完整失败过一次：`retry_count >= 1` 且 epoch key 匹配 | 首 pass 只观察 |
| g5 | operation 未 supersede，merge 已确认，run 仍在 land terminal node，claim owner/generation/lease 仍有效 | 立即停手 |

`sessions.heartbeat_at` 不在 gate 中。Bridge 的 `HeartbeatService` 会依据 pane alive 主动刷新它，因此它不是 runner-authored 活性证据；把它当 stale gate 会让 g2=alive 与 heartbeat=stale 在生产互斥，修复永远不触发。

## 3. 收敛序列

1. 在 canonical issue mutex 内、manifest 与 land authority 已验证、`postMergeTmuxCleanup` 之前枚举候选。
2. 写 `shipped_husk_force_started`，intent id 包含 operation、claim generation、execution、retry count、shutdown request 与 tmux window 的 digest。
3. destructive boundary 前重读 session/control/window/operation；任何证据变化写 `aborted`，不发信号。
4. 调用 `cleanupTmuxTarget(..., strict)`：
   - `resolveCmuxAttachTarget` 证明窗口的 `@flywheel_exec_id` 等于目标 execution；
   - 复用既有 `reapRunnerMcp`，只处理从已证明 pane 派生且 classifier 命中的 MCP 进程；
   - MCP、linked cmux、tmux window 每个不可逆边界前重验 authority/identity；
   - 使用 tmux 原生 `kill-window` 收敛窗口，不扫描或杀任意 execution-tagged host process group。
5. `physicalGone` 后写 `shipped_husk_force_reaped` 与 `aux:husk_force_cleared:<execution>:<intent-hash>`；`aux:` 不改变 `current_step`、step count 或 retry epoch。
6. strict identity/authority/tmux cleanup 失败时写 `failed` 或 `aborted`，返回 `window_identity_mismatch` / `window_cleanup_failed` / `authority_lost`；closeout 保持 open 并自动重试。
7. 本 pass 继续既有 post-merge cleanup；全部 postcondition 收敛后 terminal → archive → Done。

这是 Ponytail ladder 的第 3/4 rung：优先使用 tmux 平台能力和仓内既有 strict cleanup，而不是继续加自制 process classifier。

## 4. crash 与重放

- terminal events 为 `reaped` / `failed` / `aborted`，都引用同一个 intent id。
- 查找 open intent 时按 operation scope 跨 land claim generation 对账；避免上一 claim 的 intent 永久 open。
- 若重放时窗口已经 gone，只补 `aborted(reason=window_gone_after_force_intent)`；不声称所有 host process 已 absent，也不写成功收据。
- 若窗口仍 alive，先终结旧 open intent，再由当前 claim/generation 生成新 intent 重新走证据门。
- 同一 terminal intent 不重复 destructive attempt；retry release 后的新 generation 可产生新 intent。
- 窗口 cleanup 成功、receipt 写入前崩溃时，下一 pass 仍以实时 strict window 状态决定，不凭旧事件虚构成功。

## 5. 诚实面

`ResumablePostShipFinalizationReport` 返回有界 cause；wire reason 使用 `issue_closeout_incomplete:cause=<token>`，兼容 dispatcher 的既有 prefix allowlist。

- partial：thread 说明合入已完成、具体收尾原因、系统仍在自动重试。
- held：在 claim 释放前预演 retry 结算；若将 held，写一次 `aux:notification:land_held:<resume_generation>` 并说明自动重试已停止、需要 Lead 处理。
- thread 写入失败时继续使用既有 Lead alert/outbox；不发明第二运输通道。
- generic land failure 不套 FLY-1992 的「已 merge、9 次重试」文案，避免把 merge conflict 等前置失败误报成 closeout。
- legacy `node_process_*` token 只为历史 reason 解析兼容保留，新 escalation 不再产生。

## 6. TDD 与验收

RED → GREEN 覆盖：

1. g1–g5 缺一不可；同样接受 Claude、Codex 与 future adapter。
2. Bridge 刚刷新/缺失/异常的 heartbeat 不影响 eligibility；shutdown control 才是 runner 响应窗口证据。
3. strict cleanup 是唯一新 destructive primitive；不调用 execution-wide process signal。
4. identity mismatch、authority loss、tmux kill failure 均零成功收据、thread 保持 open、cause 精确。
5. 跨 generation open intent 在 window gone 后补 `aborted`，不使用生产不可能的 `process absent` mock。
6. `aux:` receipt/notification 不改变 retry epoch；同 retry 不重复 terminal intent，新 retry 可重试。
7. source session unavailable、worktree failure、archive failure、policy waiver、通知运输失败均有明确顺序与文案测试。
8. full repo：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；宿主 GUI/固定 timeout 失败必须逐项隔离重跑并诚实记录。

issue 验收映射：

- 3 漏 3 成路径差异：生产 SQLite/CommDB 取证已完成，差异是 phase window presence，不是 cleanup ack。
- 修复：merge-confirmed terminal land 对 vendor-neutral stuck phase 自动 strict cleanup，随后既有 archive 链自然收敛。
- 不能归档不静默：partial/held thread + Lead alert 携带有界原因。
- 1985 关系：不合并表皮修；1985 修活性，本单修所有 vendor/死法共用的 teardown。

## 7. 风险与发布边界

- 最大风险是误杀用户进程；因此删除 execution-env process census/signal，只允许 exact tmux execution identity + land authority 下的 window cleanup。
- default-on flag 可快速关闭 escalation，但文案/审计仍保留。
- merge 不触发部署或重启；按项目 00:00/12:00 updater 窗口部署。
- 本实现节点只开 PR 并 `complete --route needs_review`；不请求 ship approval、不 merge、不部署。
- 真机 land → 零人工 thread archive 由独立 QA/DAG 后继节点验证，不在本实现进程里伪造生产验收。
