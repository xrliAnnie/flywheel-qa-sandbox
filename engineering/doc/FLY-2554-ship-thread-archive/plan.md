# FLY-2554 ship 即归档 — 实施计划
Issue: FLY-2554 (https://linear.app/geoforge3d/issue/FLY-2554/thread归档-ship-即归档把-done-thread-archiver-的-60-分钟静默常量降为-0机器消息阶段回声-巡检提醒)
日期: 2026-09-14
基于: research.md

## 权威范围
Lead RULING 7a8c7c66-7236-44e1-bf4c-1ba9c07fa38b：保留 FLY-2377 immediate 与 ISSUE_THREAD_QUIET_WINDOW_MS=60m；targeted/reconcile 的 ship 后 bot-only 尾部无需再等 60m；人类尾部保持原等待/重开策略。手动 API、archive-once、frontier 补偿与频道清扫不变。

## R1 HIGH 修正
bot-tail 例外同时覆盖首次自动归档和 archived_at 非空的 terminal reopened 分支。后者由现有 done-thread-reconcile 的 Discord open discovery 选入，不依赖当前只选未归档线程的 targeted。

## 实现
1. targeted/reconcile 显式开启 bot-tail policy；手动 API、direct post-ship、其他 caller 不开启。不改默认常量。
2. 在 sink 的 per-thread lock 内、原 quiet 判定将 defer 时检查例外；不在 sink 外预先分类后传 immediate，避免漏掉随后的人类消息。
3. 读取当前未 superseded land operation，要求 project/issue 绑定、有效 merge_confirmed_at、terminal_notified receipt.threadId 精确匹配。缺失、异常、无效证据不授予豁免。alias 查询必须覆盖实际 UUID/identifier 并避免借用另一 issue 的收据。
4. 首次归档用 ship 锚点；terminal reopened 用 ship 锚点与 archive epoch 中较晚者。向前保守取窗口覆盖 timestamp 精度；对本地时钟与 Discord snowflake 的偏差保守处理，不能把异常未来锚点视为无 human 证据。消息分类复用完整证据要求：非空、少于100条、作者存在、全部 bot；unknown、人类、满页一律回原 quiet 策略。
5. 分类 frontier 必须与 sink 当前 frontier 完全相同。existing pre/post PATCH frontier 验证与补偿不变；并发人类到达不能得到 successful archive 结果。重开的人类尾部不获得新的例外；terminal 的既有 60m 策略与 nonterminal founder_reopened 保护分别保留。
6. Lead RULING b1e3ba53-ff35-4fcb-ab25-4b959b0ce309 要求及时触发：Bridge 成功向 issue thread 发送 bot 消息后，若 thread 本地有 archived_at 或 issue 已 terminal，立即 enqueue targeted re-archive。复用现有有界去重队列、single-flight 与 tick，不加 gateway listener、不加 poller。targeted 为此入队路径允许选入本地已归档 thread；保留 Linear、alias session、claim、liveness、issue-lock 全部 veto。普通 360m reconcile 仅兜底。
7. 发送调用面至少覆盖阶段回声、巡检、/api/chat-threads/send Lead relay、ship card：核查 discord-utils.ts postDiscordMessageToChannel、founder-thread-notifier.ts（infra / founder card）、ChatThreadCreator 的发帖路径，以及 Bridge 中直接 Discord POST。采用一个成功发送通知 seam（thread/channel id）集中通知 Bridge 现有 enqueuer；订阅与 Bridge 生命周期绑定，清理在 scheduler stop 前。只对 StateStore 已知 issue thread 判定，普通频道/roundtable 不入队；发送失败不入队，拒绝入队要有日志，不能令成功发送变失败或重复发送。
8. human-tail terminal reopen 保持 CURRENT 行为：60m quiet 后可归档（terminal overrides founder_reopened），不新增永久人类 veto。nonterminal founder_reopened 保护不变。

## TDD 与交付
- 触发集成 RED：真实 bot 发送公开 seam 成功 → 现有 targeted 队列消费 → 归档后再次 bot 发送仍入队；失败发送不入队，human-tail 等待；普通频道不受影响。
- 首个 RED seam 为 reconcileDoneThreads：真实 StateStore 中存在 ship marker 与 archived_at，Discord open discovery + GET 返回 bot-only 重开尾部，第一次 pass 应 archive。旧实现应 deferred_quiet_window。GREEN 后再覆盖首次 targeted、不同 bot 通报类型。
- human-tail 仍等待；unknown/full-page/missing marker 不 bypass；混合 bot+human、人类在分类与PATCH间到达及PATCH后到达的竞态；已归档 deterministic post-ship replay 不重复PATCH。
- 真 StateStore fixture 不等于生产副本。managed snapshot 当前 owner unavailable，需保留该限制并在恢复后补生产副本选路验证；不绕过 snapshot policy。
- 回归 done-thread-archiver / post-ship-finalization / terminal-thread-archive / done-thread-reconcile / manual API / channel sweep。
- 全仓 pnpm lint、pnpm -r build、pnpm test:packages:run；新增 shell 测试逐一运行。fresh code review、commit/push/PR、milestone 最后提交、精确头 CI、needs_review handoff。QA 负责 ship-report 模板托管 HTTP 200、零表格。不得 merge/deploy/dispatch QA。

## 当前状态
设计 R1 CHANGES_REQUESTED；本修订移除首次限定及错误前提。无生产实现。Lead 已授权发送后入队与 targeted archived-row 路径。下一步获得修订设计 review。

## R2 advisory 处置（Lead 3c24e84b-1cd9-4b9b-a4aa-64f040a65224）
- 不扩展 Lead 插件 reply-guard。issue-thread 消息按 Lead discipline 走 /api/chat-threads/send；若直接插件向 issue thread 回复，Bridge 不可见，最长普通兜底周期360m。
- send-trigger 用精确 threadId 去重与小容量边界；不与 completion 的 issue-only key 合并丢失模式。允许 send-mode 精确选择 archived row。
- 接受 UI-only 解档无法分辨；一旦出现人类消息，仍执行原60m terminal策略。
