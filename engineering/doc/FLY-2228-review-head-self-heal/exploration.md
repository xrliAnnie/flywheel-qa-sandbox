# FLY-2228 评审头移动自愈 — 探索
Issue: FLY-2228 (https://linear.app/geoforge3d/issue/FLY-2228/审查自愈-review-job-因-head-moved-报废后自动在新头重排不再需要-lead-手工救报废通知发给-lead-而不是吓)
日期: 2026-08-31
基于: 无

## 问题

Codex 作者通过 `gate review_code` + `request-review` 打开跨厂商审查。Bridge 接收请求时冻结可信 HEAD；若 reviewer 运行期间作者又提交，新旧 HEAD 不同，旧 job 正确地 fail-close 为 `failed / head_moved`，但系统随后停止：没有新 request，原 question 永远没有 response，runner 只能持续轮询，Lead 也只能手工 POST 新请求。

同一失败还被 `review_job_failed` 当作 issue progress 投进 founder 可见 thread；真正负责恢复的 owning Lead mailbox 没有事件。结果是 founder 被无需其决策的基础设施故障打扰，Lead 反而不知情。

## 现有边界

- `ReviewRequestCoordinator.accept()` 是 review request 的公开入口；它验证 session/worktree/gate，服务端冻结 HEAD，持久化 `codex_review_job`，再按 execution 串行运行 reviewer。
- `runJob()` 在 reviewer 返回后重验 gate 与当前 HEAD。当前 HEAD 漂移分支只写 `head_moved` 并 emit `review_job_failed`，没有 successor。
- gate 在 `head_moved` 时仍 open 且未回答，所以 successor 可以安全复用同一 `questionId`；最终成功 job 仍通过既有原子 `insertReviewResponseIfGateOpen` 唤醒 runner。
- FLY-2177 已给 quota 类 same-request retry 建了 durable timer/budget；它刻意排除 `head_moved`，因为旧 request 冻结了旧头。这里必须铸新 request，而不能复活旧 request。
- FLY-2194 已把可信同 execution revision supersede 归为 benign 并静默；本单不撤销该分类。
- `createReviewAlertEmitter()` 已解析 owning Lead 并生成带 `leadId` 的 payload，但 `infra-event-router` 把 `review_job_failed` 放入 `ISSUE_PROGRESS_KINDS`，只要有 thread 就直发 Discord。
- 生产已有 `LeadInboxRuntime.enqueueInfraAlert(leadId, payload)`，可把同一 payload 可靠、去重地写入指定 Lead mailbox。

## 锁定行为

1. 仅 code review 的 `head_moved` 触发自动 successor。Design review 不冻结 code HEAD，不进入该分支。
2. successor 使用服务端新 UUID、同 execution、同 review type、同 target repo、同 `questionId`，重新冻结当刻可信 HEAD，并继续既有 reviewer session/round。
3. 自动链最多新铸 2 个 successor。预算必须 durable，Bridge 重启后不能归零，也不能因每次换 requestId 而无限循环。
4. 每个废弃 job 仍保留 `failed / head_moved` 审计；自动 successor 是另一行，不覆写历史。
5. 最终 successor 的 verdict 走既有 gate response/outbox/authority 路径，runner 无需换 question 或手工注册。
6. 非 benign `review_job_failed` 进入 payload 所指 owning Lead 的 mailbox；不解析或写 founder issue thread。Lead mailbox 不可用时仍 fail-safe 到既有 durable ticket sink，不能静默丢失。
7. `superseded_by_revision` 继续零 structured failure event；其他失败原因不新增自动 head requeue。

## 验收映射与测试 seam

用户验收对应两个已确认的公开 seam：

- `ReviewRequestCoordinator.accept` + CommDB gate response：用 deferred reviewer 在运行中推进可信 HEAD，证明旧 job failed、新 requestId job 自动出现且冻结新头、成功 verdict 回答原 `questionId`，并证明连续漂移只自动新铸两次；同一场景经 StateStore 重建/boot redrive 后预算仍不丢。
- `buildInfraAlertRouting` + real in-memory StateStore：绑定真实 issue thread 与 owning Lead，证明 `review_job_failed` 只调用 Lead inbox sink、Discord fetch 为零；同时保留 benign supersede 零 event 的 coordinator 断言。

测试只观察请求入口、持久 job、gate response 和投递 sink，不 mock coordinator 内部 helper，不以私有调用次数代替行为。

## 非目标

- 不放宽 HEAD/verdict/authority 校验。
- 不让旧 requestId 在新头上重跑。
- 不改变 CHANGES_REQUESTED 后 runner 主动开新 gate 的正常流程。
- 不修改 reviewer binary、quota retry 政策或 founder approval/ship gate。
- 可选 runner `check` 死门提示不纳入必做范围：本修复保持原 question open 并由 successor 回答，先闭合主验收；只有发现 successor 无法可靠回答原 gate 时才回到该项。
