# FLY-1956 出站回执 — 验证记录
Issue: FLY-1956 (https://linear.app/geoforge3d/issue/FLY-1956/bridge出站-flywheel-comm-出站调用高频-abortedqa-resultstage-setask-nudge)
日期: 2026-09-13
基于: plan.md

本记录区分本地全仓检查、聚焦测试与尚未完成的验收；不改动已批准计划。

## 本轮全仓检查

- `pnpm lint`: 首轮两项错误（gate 导入排序、pressure helper 测试格式）；修复后退出 0，16 warnings。日志 `/tmp/fly1956-full-lint-r2.log`。
- `pnpm -r build`: 退出 0。日志 `/tmp/fly1956-full-build.log`。
- `pnpm test:packages:run`: 退出 1，停在 flywheel-comm；该包 7 files failed / 178 passed，10 tests failed / 2513 passed / 3 skipped，并有 `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`。日志 `/tmp/fly1956-full-tests.log`。这不是全仓绿色结果。
- 失败明细：cli.test.ts 两个 5000ms timeout；lead-backend-migration-registry、lead-registry-cli、dependency、qa-result-lock 各一个 5000ms timeout；runner-stop-declaration-race 期望 `[sent,sent]` 实际 `[stale,sent]`；stage-queue 三例诊断 GET 被统计到 POST/重试预算。
- stage-queue 测试现已隔离独立有覆盖的 pressure helper；与新演练聚焦复测 22/22。其余失败尚未定性，未据此修改无关实现。全仓结果仍为失败。

## 确定性演练

`packages/flywheel-comm/src/__tests__/fly1956-outbound-drill.test.ts`：

- stage 首次响应 8s：单次 POST，确认前队列存在，确认后删除。
- QA t=25s 返回回执：两次请求 body 完全一致，取得回执、清除 marker。
- QA t=45s 返回回执：三次请求 body 完全一致，取得回执、清除 marker。
- 以上 3/3 通过；服务端采用存活共享 promise 模型，真实 router singleflight 另由 workflow-decision-routes 测试证明。
- 计划 8.2 第四项：stage-crash-replay.test.ts 使用真实 HTTP socket，在服务端收到 POST 且不回包时 SIGKILL 客户端；逐字验证队列文件保留，下一条 founder-time 命令重放同一 body 并删除队列。停摆为无限挂起模型，无生产负载操作。
- 第五项：stage-preflight-cli.test.ts 复测 8/8，gate 拒绝时 CommDB 文件不存在，complete 超车时仍发出终局事件。与 SIGKILL 演练合跑 9/9，日志 /tmp/fly1956-crash-drill.log。

## 尚需完成的核对

- 逐项核对计划 8.1 的并发发布、锁竞争、磁盘重启及 receipt 绑定负面守卫；不能将已有部分测试视为全部完成。
- 核对 completed 的非法 transition/superseded 与真实 ship predicate 下的重放，及全部 settlement 分支。
- Node 22 socket 分支已有下述证据；全仓默认运行时仍为 Node 25。
- 最终变更后全仓检查、注册 code review、PR、milestone 最后提交、精确 HEAD 的 review/CI，以及 needs_review 交付均未完成。
- 无生产高负载诱发、服务重启、部署或 QA 结果。

## 后续补证

- stage-crash-replay.test.ts 增加 20 个真实 publisher 进程：全部经 IPC ready 屏障同时开始入队，20 个 event_id 唯一，序号严格为 1–20；与 SIGKILL 用例合计 2/2，日志 `/tmp/fly1956-publish-drill.log`。
- 全仓失败的其余测试聚焦复跑：qa-result-lock + runner-stop-declaration-race 6/6；cli + lead-backend-migration-registry + lead-registry-cli + dependency 141/141。日志 `/tmp/fly1956-failure-triage.log`、`/tmp/fly1956-other-failure-triage.log`。未改动这些实现或放宽超时；只证明此次聚焦未复现，全仓失败记录保留。
- 安装到 /tmp npm cache 的 Node v22.18.0 仅用于测试，不切换项目/生产运行时。独立 outbound-pressure-socket.test.ts 覆盖真实 client abort / server res.destroy / normal finish，避免依赖 Node 25 编译的 SQLite addon；原 health 集成用例仍保留。
- Node 22 socket 最终 2/2，日志 `/tmp/fly1956-node22-socket-final.log`。

## 乱序终结回执

- 新增真实 HTTP 回归：已有 failed session 携 needs_review 路由收到 merged completed stage，首次及 duplicate 都必须返回 superseded，状态保持 failed，finalization/archive 零调用。
- 红阶段 `/tmp/fly1956-superseded-red3.log` 确认旧代码仅回 warning，缺 applied/superseded；修复只将真正 FSM 拒绝标为 superseded，不将缺失 transitionOpts 当作已失效。
- 绿阶段 `/tmp/fly1956-superseded-green.log`：terminal archive 与 event-route 110/110；teamlead build 退出 0（`/tmp/fly1956-superseded-build.log`）。
- W2 尚有明确待处理项：computeAuthoritativeShipDecision 包含 legacy status-sensitive approval，不能仅凭 mocked eligible=true 的 completed 重放测试证明真实收尾恢复；需要真实绑定证据测试和相应最小修复。

## W2 真实授权恢复（替身续跑）

- 将 terminal-archive-enqueue-sites 的授权成功 mock 替换为磁盘 StateStore + CommDB 的真实 founder gate、review binding、Codex review 与历史 QA 记录；只隔离 git HEAD 探测和最终收尾执行。
- `/tmp/fly1956-w2-real-red.log` 证明第一次 transition 后重放未再次调用 resumable finalizer，却错误回 applied=true。新增 completed-only 的批准校验入口，复用全部 bound approval / HEAD / review / QA 守卫；普通 verifyApproval 仍仅接受 approved_to_ship。
- `/tmp/fly1956-w2-negative-red.log` 证明 unbound / head-drift 重放也错误回 applied=true。merged W2 现在从 pending 开始，只有 finalizer 完成才结算；负面重放不再删除客户端证据。
- 绿阶段：terminal archive + merge-ship integration 25/25（`/tmp/fly1956-w2-green.log`）；verify-approval + ship-eligibility 83/83（`/tmp/fly1956-w2-approval-green.log`）；event-route 99/99（`/tmp/fly1956-w2-event-green.log`）。comm 与 teamlead build 均退出 0。
- 尚未完成最终全仓 gates、§8.1 全量需求审计、code review、PR/CI 与 needs_review。以上是聚焦验证，不替代全仓结果。

## §8.1 QA 进程退出覆盖补证

- qa-result-lock.test.ts 新增四个真实 tsx 子进程：refusal / exhaustion / UNRECORDED / marker conflict，分别验证退出码 1/1/3/1、POST 次数 1/4/0/0，以及调用返回时锁目录已释放。
- UNRECORDED 在子进程注入 marker 临时文件 open 失败；并非锁外 mkdir 失败，因而确实证明持锁 core 的失败路径会释放锁。exhaustion 使用真实 1/2/4 秒退避。
- 与既有活 owner 不接管、SIGKILL 后同键恢复合计 5/5，通过日志 `/tmp/fly1956-qa-process.log`。
- 审计继续项：stage publisher/fence 竞态和活 owner 锁超时、QA 授权 push 期间 contender、receipt engine 重启/损坏 binding 全集、ProofShot 各 settlement 窗口。不得将标题匹配作为已覆盖证据。

## §8.1 需求审计与竞争补证

| 计划要求 | 当前可执行证据与实现核对 |
|---|---|
| C1 write-ahead / 同键重放 / summary 固定 / 冲突拒绝 / discard | qa-result-resume、qa-result.test；首次 fetch 读取 marker、异 payload 字节不变、旧文件改名；marker 仅保存安全 verdict/digest，不保存凭证 |
| C1 整次持锁 / 四种真实退出 / dead owner | qa-result-lock 五例；本轮 qa-result.test 在首次 409 body 返回前启动 contender，确认 exit2、零额外 POST、一次新 id、一次 push；父调用 marker 在 push 前已发布 |
| C1/C2 存活 PID、复用 PID、TOCTOU | 共用 config withMkdirLock；teamlead mkdir-lock 19 例含 recycled PID、dead PID、存活 owner、替换 holder 不删；stage-queue 新例在活 owner 下断言 exit3、原文件不变、fence 不执行、零 fetch |
| C2 发布顺序 / fence 原子性 | stage-crash-replay 的 20 真实 publisher 屏障；新增 publisher 进程在 rename 前停住，另一进程 fence 等待，释放后消息顺序严格为 posted(event_id) 再 written；stage-queue 复扫与持锁 mutation；stage-preflight-cli 验证 flag exec 优先、CommDB 零新行 |
| C2 失败分类 / deadline / 文件保留 / 升级 / 队列清空复用 | stage-queue 的 headers/body stall、bare duplicate/warning/pending、拒绝改名并继续、顺序暂停、新旧 receipt、清空后 seq1；preflight 单次 slice(0,3)、异常保留；CLI complete/QA OVERTAKE 后仍执行 |
| C3 durable receipt bindings / zero writes / engine+legacy | StateStore.replayWorkflowDecisionReceipt 的 query_only、claim/lead-event/capability 损坏全集；新增 capability run/node/attempt/family；workflow-decision-routes engine review 已推进到 founder gate 后关闭数据库、删除临时 worktree、重开磁盘 DB，在 query_only 下返回原 claimId/serverSeq |
| C3 singleflight / mutable facts 不参与 replay | workflow-decision-routes 的同 body 合流、status/summary/head 区分、两 router 独立、失败 promise 清除；legacy replay 中 getSession 直接抛错且验证零调用/零 submit/零 insert |
| C3′ 热表/归档/事务/完整 payload | StateStore.stage-events 覆盖归档与热表最大 id、同 id 异 body、完整行返回、projection 失败回滚事件；event-route.codex-trigger 覆盖 legacy stage 修补、同秒排序、instruction 去重和 pending |
| C3′ ProofShot / completed 每分支 settlement | proofshot-trigger 真实 CommDB sink 后 projection 丢失重放仍只有一行；pending/running 不能绕过 sink、异常 pending、TTL attempt；W2 的真实批准/partial 重放、非法 transition superseded、archive admission 重试，详见前节 |
| C4/C5 pressure / nudge | outbound-pressure、Node22 outbound-pressure-socket；仅 finish 更新 max、close-before-finish 计数；bridge-pressure-snapshot fallback 与不抛；lead-inbox-nudge 默认1500ms和 durable 文案 |

本轮新增测试证据：stage race 1/1（`/tmp/fly1956-stage-fence-race.log`）；stage queue + QA push 113/113（`/tmp/fly1956-owner-push.log`）；receipt/proofshot/lock/stage store 79/79（`/tmp/fly1956-audit-teamlead.log`）；engine router 32/32（`/tmp/fly1956-receipt-reopen.log` 中该文件绿色，同次另一文件的新增 family 字段拼写错误随后修正并归入 79/79）。

§8.2 五项 harness 的现成 8s/25s/45s/kill+drain/门命令超车证据见上文；未诱发生产 load>30。实现 diff 无新 schema/env/token、无 Bridge lifecycle 启停任务、无 gate --stage 改动，回滚残留队列为旧版本不读取的文件；不会宣称实机回滚/部署通过。

## 最终全仓 gates（本轮尚未收齐）

- `pnpm lint` 首轮新增测试两处 noAssignInExpressions，修复后 `/tmp/fly1956-final-lint-r2.log` 退出0，16 warnings。
- `pnpm -r build` `/tmp/fly1956-final-build.log` 退出0。
- 精确命令 `pnpm test:packages:run` `/tmp/fly1956-final-packages.log` 退出1：flywheel-comm 1 failed / 186 passed files，1 failed / 2536 passed / 3 skipped tests；失败 lead-registry-cli backend migration 用例5000ms超时。按 Lead 指令隔离一次 `/tmp/fly1956-final-isolated-registry.log` 31/31，通过且不改实现/不加超时。原全仓仍失败。
- 此次命令已经完成的其他包：release-contract、core、token-usage、qa-framework、config、linear/slack/github-event-transport、voice-core。
- 继续覆盖被 bail 中止的包：teamlead 独立完整 suite 日志 `/tmp/fly1956-final-teamlead.log`；其余 claude-runner/edge-worker/gemini-agent/voice-headphone/voice-codex/voice-bridge 使用 `--workspace-concurrency=1 --no-bail`，日志 `/tmp/fly1956-final-remaining.log`。两进程仍在执行，不能把中间结果当最终统计。
- 本单导致的旧测试失配已经定位并修正：kill-path inventory 新增6个 qa-only 子进程 SIGKILL（无生产调用变化），聚焦5/5；stage emoji 的非法输入改为断言400 invalid_stage_event，仍断言零stamp/零reconnect-clear；ProofShot smoke 断言同一id/payload再次核验sink，合计9/9；runner-memory结构检查跟随抽取后的 runDecision，3/3。日志 `/tmp/fly1956-kill-inventory-green.log`、`/tmp/fly1956-fixture-green.log`、`/tmp/fly1956-memory-callsite-green.log`。
- 待 suite 完成后隔离一次的其他失败：claude-runner async-exec-file、prompt-overflow.real-tmux；teamlead bridge、StructuredInboxRouter、claude-profile-cli.integration、fly-2341-db-hygiene-script、automated-message-inventory。以最终失败清单为准，未定性的不称为已通过或无关。
- 无新增 `scripts/__tests__/*.test.sh`（按 merge-base 到分支 HEAD 核对）。
- codex:rescue 已按 companion task 尝试只读 review，`/tmp/fly1956-rescue-review.log` 记录嵌套 sandbox 初始化拒绝：exit71 / sandbox_apply Operation not permitted；未绕过沙箱、未运行 raw codex exec。已报告 Lead（report f4b109eb-90fc-4904-b6c7-d211426d8161）。合同注册式 review 已受理：question 45812394-cc3d-4a85-bc7d-3785ba352147，request 5f27e504-0ace-4474-a80f-749f90dd41b6；仍 pending，后续 HEAD 移动须新轮。

## 全包检查最终计数与 PR 前状态

teamlead 完整 suite 已退出1（`/tmp/fly1956-final-teamlead.log`）：1010 passed / 8 failed files，13648 passed / 13 failed / 7 skipped tests，另有 `[vitest-worker]: Timeout calling "onTaskUpdate"`。该统计包含上文已修复并聚焦通过的旧 fixture；不能将其重写为绿色。其余五个失败文件已启动 `--no-file-parallelism` 隔离一次（`/tmp/fly1956-teamlead-isolated.log`）。claude-runner async-exec-file + real-tmux 隔离9/9通过（`/tmp/fly1956-runner-isolated.log`）。其他六包补跑仍执行，正式 CI 尚未产生。

PR 按非 draft 提交以取得 CI 证据；review 与 CI 未完成前不得 needs_review。codex:rescue 沙箱限制已报告，合同 reviewer 已受理。没有新增超出已批准锁/回执/重放合同的通用经验，本次 runner-memory 不新增条目。未 dispatch QA、未请求 ship、未 merge main、未重启服务。

## PR 收口补充

PR https://github.com/xrliAnnie/flywheel/pull/1180 为非 draft。teamlead 隔离五文件75/75通过（`/tmp/fly1956-teamlead-isolated.log`）；剩余六包补跑退出1，汇总5 passed / 1 failed，失败仅 claude-runner 原始 aggregate（其 inventory5/5、timeout9/9隔离已绿）。所有要求的 package suite 均已执行。完整本地结果保持失败，正式 CI 与最终 HEAD 的有效 review 仍是交接条件。

## Code review HIGH — immutable design replay

review question `78a931e2-2bcf-410c-abcb-f03bdfe1786c` 在 HEAD `8a12ca729` 返回 CHANGES_REQUESTED，唯一 HIGH 为 `stage-replay-rederives-mutable-design-manifest-wedges-queue`。同事件重放重新 snapshot 当前计划会与持久 manifest 冲突；已写 correction 的 detail 改变也会触发相同 dedupeId 的内容冲突。

回归 `/tmp/fly1956-review-r3-red.log` 复现三例失败：已投递 manifest 后计划变更、manifest 已写但 sink 丢失后计划变更、correction 已落账后失败 detail 改变。最小修复先按 execution/sourceEvent 查持久 manifest 或 correction；复用原 blob/request id，同事件不重新派生内容；新 revision 已取代旧义务时直接结算旧事件，后续新 stage 仍绑定新计划。正常新事件保持原入场验证，未新增生命周期任务或 schema。

扩展回归覆盖以上三个窗口、旧 revision 不重投/不回退、新 stage 可继续、既有 manifest/Event route 合同：`/tmp/fly1956-r3-focused.log` 131/131；`pnpm lint` 退出0（16 warnings），`pnpm -r build` 退出0。该轮只修 HIGH，MEDIUM/LOW 均未扩入实现。Lead 在 report-response 1c5279e0-ef46-434c-b811-2ac3efb4225a 澄清冻结仅针对 review 在跑：CHANGES_REQUESTED 后可立即一次推送修复/台账/milestone，不必等旧头 CI；推送后重新冻结并取得新精确头 review/CI。
