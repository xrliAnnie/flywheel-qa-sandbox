# FLY-2554 ship 即归档 — 验证记录
Issue: FLY-2554 (https://linear.app/geoforge3d/issue/FLY-2554)
日期: 2026-09-14
基于: plan.md

设计 R2 gate 9ef475fb-5f7e-480f-b64b-0e955c4b0a6e APPROVED；非阻断建议已 report 给 Lead。

## Slice 1: quiet gate
- RED reopened: 新 reconcileDoneThreads 用例使用真实 StateStore、land merge/terminal_notified 收据、非空 archived_at、Discord GET mock；旧行为发现线程但 deferredQuiet=1，期待0。日志 /tmp/FLY-2554-red-reopened.log，exit1。
- GREEN reopened: sink 内校验 ship 收据与 bot-only frontier 后，同 pass 归档，1/1 PASS。日志 /tmp/FLY-2554-green-reopened.log。
- RED first archive: 新增首次归档 bot-tail 与两个人类反例后，首次 bot-tail 失败，3 passed/1 failed。日志 /tmp/FLY-2554-red-first.log。
- GREEN regression: 对首次静默分支同样启用例外；done-thread-reconcile、done-thread-archiver、post-ship-finalization、terminal-thread-archive 共4文件177/177 PASS，exit0，36.81s。日志 /tmp/FLY-2554-green-archive-regression.log。

尚未完成：bot-send targeted 入队/按thread选择、targeted启用例外、alias/竞态/失败证据扩展、改动后的全仓门禁、代码评审、PR、精确头CI、QA生产副本。当前结果不是完整任务验收。

## Slice 2: exact-thread targeted queue
- RED selection: send-mode 请求 archived thread 时，原 targeted 只选未归档行返回 thread_missing；/tmp/FLY-2554-red-target.log exit1。新增精确 threadId 可选参数后 GREEN。
- RED queue: 缺少 enqueueThread；/tmp/FLY-2554-red-queue.log exit1。新增独立 thread identity 与 send cap16，completion cap64 不被占用；初始2文件71/71 PASS。
- RED in-flight send race: 检查悬挂时发送后被 deduped 丢掉后续 pass；/tmp/FLY-2554-red-send-race.log 1failed/3passed。保留 pending-send 标记，合并为额外一次 pass 后 GREEN。
- /tmp/FLY-2554-green-send-race.log：targeted/reconcile 2文件73/73 PASS，exit0。
- send-trigger 在队列层最多尝试3次；普通 completion 保持原无限低频重试。发送成功 seam/Bridge wiring 尚未接入，不能宣称事件触发已经生效。

## Slice 3: successful-send admission
- RED /tmp/FLY-2554-red-send-admission.log：成功 postDiscordMessageToChannel 后 targeted 调用为空（assertion failure，exit1）。
- shared post 接入 observer 后发现 getChatThreadByThreadId 不返回 archived_at；改用既有 getChatThreadArchivedAt 权威读取，再 GREEN。
- RED /tmp/FLY-2554-red-other-sends.log：infra/chat 两条成功发送没入队，2failed/1passed；相应成功HTTP分支接入 observer 后3/3 PASS。
- plugin 绑定 watcher 生命周期并向 runTargetedArchiveCheck 传精确 threadId；send-mode 非 transient outcome 出队，网络类错误仍服从3次上限。普通 completion 重试策略不变。
- 新模块仅同步观察成功POST，异常隔离，失败入队日志不改变发送结果；只处理StateStore已知main issue thread。本地 archived 或有效land terminal收据作为低成本入队资格，最终状态由targeted重新检查。
- /tmp/FLY-2554-typecheck.log：pnpm --filter flywheel-teamlead exec tsc --noEmit exit0。
- /tmp/FLY-2554-green-send-regression.log：3文件61/61 PASS，涵盖infra/relay/chat、失败发送、普通频道、active issue、取消订阅、observer异常。

发送清单尚待闭合：runner-ready-to-close、disposition receipt、founder-reply-deliverer、discord-post-file、ChatThreadCreator attach post 的直接POST。不得把当前3条发送面测试称为全部发送面验证。全仓门禁/代码评审/PR/CI仍未完成。

## Slice 4: remaining direct issue-thread POST sites
- RED /tmp/FLY-2554-red-direct-sends.log：disposition/founder-reply/file/ready 四条成功发送未入队，4failed/5passed。
- 各发送点成功HTTP后调用同一 observer，保留失败路径；/tmp/FLY-2554-red-attach.log 剩 attach-pin 1failed/18passed，随后补齐 attach POST 成功通知。
- /tmp/FLY-2554-green-direct.log：bot-send、ChatThreadCreator attach-pin、post-ship-finalization 共3文件71/71 PASS，exit0。
- 当前发送覆盖：postDiscordMessageToChannel（Lead relay等）、postChatMessage、postFounderThreadCore（infra/card）、ready-to-close、disposition receipt、founder reply、file、attach pin。频道建帖/root消息、普通频道通知不属于已有issue thread内重开；PATCH编辑不新增消息。Lead direct plugin缺口按Lead ruling交给360m兜底。
- retention consumer gate /tmp/FLY-2554-retention.log：ok=true, errors=[]。无session_events新消费者或schema变更。

下一步：alias下land收据查找、unknown/满页/缺失收据/时间偏差/消息竞态强化验证；发送到真实targeted/sink的完整集成；全仓门禁/评审/PR/CI。

## Slice 5: alias and full send-to-sink proof
- /tmp/FLY-2554-red-alias.log：UUID land / identifier thread RED，1failed/4passed。same-project session alias查找修复后 /tmp/FLY-2554-green-alias.log PASS。
- /tmp/FLY-2554-negative-matrix.log：12/12 PASS，包括缺失terminal收据、错thread绑定、未知作者、满页、未来ship锚点、变化frontier、混合human，均不豁免静默。
- /tmp/FLY-2554-send-sink-integration.log：10/10 PASS；实际postDiscordMessageToChannel→watcher→scheduler→runTargetedArchiveCheck→archiveThreadAndRecord→mock Discord PATCH，仅一次PATCH，compensation为空。
- /tmp/FLY-2554-final-lint.log pnpm lint exit0（18条warnings）；/tmp/FLY-2554-final-build.log pnpm -r build exit0；/tmp/FLY-2554-retention-final.log ok=true。
- 完整 pnpm test:packages:run 正在执行，日志 /tmp/FLY-2554-package-suite.log；不能先报通过。无新增scripts/__tests__/*.test.sh。

## Code review and handoff limits
Code R1 gate 2a3ae500-0e49-48a7-84c8-a3c8eec2f001 APPROVED at 4cd6f4fc377b4afbd47397cef725abdd73e10214; no blocking findings. Advisories reported to Lead.

Codex Lead gateway runs in another process and its direct issue-thread POST is not observed by the Bridge module; like direct plugin replies it falls back to the ordinary360m reconcile. This is a known coverage limit, not proof of prompt rearchive for that path. Alert, standup and roundtable senders are outside main issue-thread scope; flag-retirement-production uses its configured notification/probe channel and separately created probe threads.

Other accepted advisory boundaries: UI-only reopen is indistinguishable; human messages before the ship/archive anchor are outside this policy window; queued new sends can retain up to120s transient backoff; disabling reconcile pauses the bounded send queue and may log refusals when full; observer lifecycle assumes one Bridge and orderly shutdown.

PR creation proceeds while the full package suite remains live. Final package outcome, exact-head CI and any renewed review receipt will be recorded on the PR and through structured reports; no QA/production acceptance is claimed by these local fixtures.

## QA C4 replacement rework (2026-09-14)
- Replacement execution d0d22d50-ad29-4742-89fa-ec5deaba968c acquired implement TURN epoch 3, attempt 2, on base 7f2bc902ef08616fef3c24eb7f34b5400a1e773c. QA supplied C4-only failure; archive product paths and human-tail policy remain unchanged.
- PR #1192 CI run 34882994435: founder-budget combined child-cap test timed out at 6030ms on attempt 1 and 7990ms on attempt 2 against the existing 5000ms limit. Red logs: /tmp/FLY-2554-ci-red-attempt1.log and /tmp/FLY-2554-ci-red.log. Attempt 2 still printed cap 69 and 521503 bytes; this does not override its failed result.
- Local baseline /tmp/FLY-2554-budget-baseline.log: 3/3 passed, combined test 1359ms. Local passing does not reproduce or waive CI failure.
- Minimal test-only change moves imports from timed test callbacks to module collection. No production changes, timeout changes, skipped tests, fixture cardinality changes or assertion changes. Cold module transformation is no longer charged to these test callbacks; this is a hypothesis for the CI failure, pending exact-head validation.
- Local changed run /tmp/FLY-2554-budget-static.log: 3/3 passed, combined test 1129ms; output remains cap 69, 521503 bytes, 200 input attention candidates and 0 retained at that cap.
- Rework lint passed with 18 warnings. Full build and package gate currently running, logs /tmp/FLY-2554-rework-build.log and /tmp/FLY-2554-rework-packages.log. Fresh review, final-head CI and QA retest remain outstanding.

### Superseding C4 disposition: inherit merged FLY-2556
Live verification of Lead question 9a4a2160-aea7-4f51-90e9-b521df01872f directs a main sync after PR #1190 merges, with no independent budget-test edits. PR #1190 merged at 2026-09-14T19:45:20Z (579c79ed662e49e7799b5d61ccd6d11a00fce3f2). The speculative static-import change above was reverted in af8445678 before merging origin/main without conflicts. Final budget-test bytes match origin/main; only FLY-2556 owns its targeted timeout change. Archive product code remains unchanged from QA base.

The prior package run was interrupted before any aggregate result was recorded and is not a pass. Prior CI34889960223 and reviewc622f1d5 cover superseded head46eb24d1d, not the final sync. Rerun full gates and request fresh final-head review/CI. This section supersedes the earlier static-import implementation description while retaining its evidence history.
