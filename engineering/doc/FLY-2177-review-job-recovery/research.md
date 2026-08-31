# FLY-2177 Review 失败恢复 — 调研
Issue: FLY-2177 (https://linear.app/geoforge3d/issue/FLY-2177/巡检缺口-code-review-job-failed-后无人重试无人告警-review-任务层纳入巡检面2155-空等5小时)
日期: 2026-08-30
基于: exploration.md

## 1. 权威事故证据

对当前 `~/.flywheel/teamlead.db` 的只读核对显示，FLY-2155 有两轮 code review：

| request | round | 当前终态 | created_at | updated_at |
|---|---:|---|---|---|
| `3900296e-…` | 1 | failed / `head_moved` | 23:23:02 | 23:43:17 |
| `d1d1e9ba-…` | 2 | done | 23:49:56 | 05:09:16 |

第二行之所以现在是 done，是 founder 追问后对同一 `requestId` 做了幂等重放；`claimCodexReviewJobRunning()` 会清掉 failure 诊断，因此当前行不再保留首次 quota failure。Bridge 轮转日志仍保留 23:49 的失败事实：R2 `nonzero_exit`，文案明确写着 gate stays closed、需要 retry request；到 05:09 前没有 coordinator 自驱恢复。

这同时证明：

- 重试正门本身可用；
- 当前 schema 的“最近状态覆盖”不足以单独还原每次尝试，但本 issue 不扩展成完整 attempt event store；
- 自动 retry 次数和 retry 时刻若要跨重启可靠，必须放进当前 job 行，而不是仅存在内存。

## 2. Review coordinator 状态机

`packages/teamlead/src/bridge/review-request-coordinator.ts` 当前合同：

- `accept()` 对新 request 做 session、author family、worktree、target repo、gate 和 code head 校验；
- 同 `requestId` 的 failed job 重放时会重新执行 `checkGate()`，通过后进入现有 `enqueue()`；
- `enqueue()` 按 execution 串行；
- `runJob()` 用 StateStore CAS 将 `pending|failed → running`；
- reviewer failure 调 `failCodexReviewJob()`，写 `failed/failure_reason/failure_raw`，只调用 `alert()`；
- `redriveOnBoot()` 只恢复 `pending/running` 和未投递的 `done/skipped`，不读 failed；
- 现有回归测试明确断言 quota-like nonzero exit 只调用 reviewer 一次。

### 2.1 告警为什么没有送到 Lead

`alert()` 只保证本地 logger；真正 Lead-facing 的 `deps.alertLead` 是可选依赖。生产 `plugin.ts` 构造 coordinator 时没有注入 `alertLead`。因此 failure 文案只进 Bridge log，不会进入 routed alert sink。

同一 coordinator 已有另一条正确通路：`emitReviewAlert()` → `createReviewAlertEmitter()` → owning Lead → routed alert sink。它目前仅注册 review advisory/ruling 四种 kind。失败应复用这条现成通路，而不是新增旁路通知器。

## 3. StateStore 与迁移约束

`codex_review_job` 已有 `request_id` 主键、`status` 索引和迁移时的 `PRAGMA table_info` 缺列补齐模式。所需最小持久字段：

- `retry_at TEXT`：下一次自动重试的 UTC ISO 时刻；NULL 表示无排期；
- `auto_retry_count INTEGER NOT NULL DEFAULT 0`：已经排期/消费的自动 retry 预算计数。
- `failure_attempt_count INTEGER NOT NULL DEFAULT 0`：每次失败状态转换都递增，作为告警 generation；不能复用只在自动排期时变化的计数。

迁移必须沿用列枚举补齐并失败响亮；老库默认值为 0。状态转换约束：

- 排期：非终态 job → `failed`，保存 failure，CAS 增加 count 并设置 retry_at；
- claim：`pending|failed → running` 时清 retry_at，但保留 count；
- complete / 普通 fail：清 retry_at；
- boot scan：只取 `status='failed' AND retry_at IS NOT NULL`，按 retry_at 排序。

不新增 retry 表。单 job 行已是同 request 的幂等权威，新增表会制造双写和归属歧义。

## 4. Quota reset 识别

仓库已有两条可复用约束：

- `account-heal/detection-classifier.ts` 将 genuine `usage limit` 与普通 `rate limit` 分开，并用 negative lookbehind 排除 `not your usage limit`；
- `account-heal/usage-gauge.ts` 已实现 IANA timezone 下的 today/tomorrow/weekday wall-clock → UTC 转换，`resolveResetAt()` 可复用。

Reviewer 是 headless `claude -p --output-format json`，不保证有 TUI gauge。设计评审后又对当前 `~/.flywheel/teamlead.db` 做了只读语法盘点：现有 `failure_raw` 中有 65 条同时含 limit/reset，真实 envelope 的稳定证据是 `api_error_status: 429`，`result` 则有以下三种已观察形状：

1. `You've hit your session limit · resets 5:10pm (America/Los_Angeles)`（也出现无分钟的 `3pm`、`8pm`、午夜 `12am`）；
2. `You've hit your weekly limit · resets Aug 26 at 7pm (America/Los_Angeles)`；
3. 上述 result 后可能追加 `· progress saved`，不改变 reset 语义。

因此 parser 不再从 TUI/相对时间语法猜测。它只消费 reviewer 的 bounded stdout/stderr evidence，并且必须同时证明：JSON envelope 的 `api_error_status` 恰为 429、result 是 `You've hit your session|weekly limit`、reset 是上述 wall-clock/month-day 语法、timezone 是可由 `Intl` 验证的 IANA zone。普通 429/rate-limit、仅有 marker、`not your usage limit`、过去或超出 8 天的 reset、缺 timezone 的模糊 wall-clock均返回 null，转人工告警/巡检。月日若已过则只允许解析到下一自然年，随后仍受 8 天上限约束。

在 reset 时刻后加小的固定 grace，避免边界秒误差。timer 延迟必须受 Node 最大 timeout 和 coordinator stop 管理；测试注入 clock/timer，不真实等待。

## 5. 自动重试前的权威重验

排期到点不是继续执行的授权。排期前先读取 bound question 的 `expires_at`；`reset + grace + deterministic jitter` 必须严格早于 `expires_at - safety margin`，否则不消耗自动 retry 预算。触发前必须重新读取 job 并验证：

1. job 仍是 `failed` 且 retry_at 已到；
2. 绑定 gate 仍是该 execution 的 open `review_design|review_code`；
3. code review 的当前 trusted head 仍等于 frozen head；
4. coordinator 未 stop。

gate 已关闭时保留具体结果：answered/resolved 落 `gate_answered_externally`，expired/missing/mismatch 分别落 `gate_expired`/`gate_missing`/`gate_mismatch`；head 已移动时落 `head_moved`。不再把所有非 open gate 都压扁成 answered。

## 6. Lead alert 合同

沿现有 structured emitter 增加单一 kind `review_job_failed`，severity=warning。event id 带 requestId 与持久化的 `failure_attempt_count`，做到同一次失败幂等、手工/自动的后续尝试也不会被上一代事件吞掉。

Body 必须包含：issue、review type/round、failure reason，以及二选一恢复信息：

- 已排期：同 requestId 将于 `<UTC>` 自动重试；
- 未排期/预算耗尽：用同 requestId 重放 `POST /review-requests`，或使用受治理的 codex-skip 路径。

Body 不包含 evidence tail 或 `failure_raw`；当前 `sanitizeFailureSummary()` 只防控制字符/mention，不构成 secret redaction，故 structured alert 只指向 durable job row。`review_job_failed` 同时加入 `ISSUE_PROGRESS_KINDS`：有绑定 thread 时送 owning Lead 所在 issue thread，无绑定时由既有 router fail-safe 为 durable infra ticket。

## 6.1 自动恢复开关与惊群控制

新增 store-managed、Bridge-global、default-on kill switch `review_quota_auto_retry`，通过 `flag-store-runtime.ts` call-time wrapper 读取；关闭时新 failure 只告警，已排期 timer 保持 row 可见并每分钟低频重读开关，不 spawn reviewer。这样管理面可即时止血，Bridge 重启后也不会绕过关闭状态。

同一 request 只保留一个 timer。目标时刻是 `reset + 60s grace + hash(requestId) % 5min`，把同一账号同一 reset 秒的大批 review 摊开；到点后仍走既有 per-execution 串行 `enqueue()`，不引入 coordinator-wide slot limit，也不调用/写 quota-monitor 的账号切换状态。自动预算最多 3 次，由 StateStore 条件 UPDATE 原子裁决。

## 7. 巡检纳入面

`scripts/lead-patrol-snapshot.sh` STEP 4 已覆盖 stale mailbox、unacked wake、dead letter、verdict/head mismatch，且有统一 owner attribution CTE。生产库目前约有 100 条历史 failed review job；若不先裁剪而直接放进共享 `attribution_subjects`，其中已被 CommDB prune 的 execution 会令整个 STEP 永久 `UNAVAILABLE(owner_missing)`。因此先新增有界 `failed_review_candidates`：

- `codex_review_job.status='failed'`；
- job/session project 都匹配；
- 必须存在同 execution 的当前 StateStore session，且 session status 仍属 patrol 的 live roster；
- `updated_at|created_at` 在最近 24 小时；
- 排除明确不可用同 request 重放的终态原因：`head_moved`、`gate_answered_externally`、`gate_answered`、`gate_expired`、`gate_mismatch`；
- 只有完成上述裁剪的 execution/issue 才进入同一 owner attribution；
- 只展示 owning Lead 的行；任何 owner ambiguity 继续让整个 STEP fail-closed。

finding 文案包含完整 requestId（它就是重放幂等键）、type、round、reason、updated/retry_at，以及固定恢复提示 `POST /review-requests with the same requestId`。不得输出 failure_raw。

## 8. 测试矩阵

### Coordinator / StateStore

- genuine usage cap + observed wall-clock reset → failed row持久化 retry_at/count、warning alert、未到点不 invoke；
- 真实 session/weekly envelope fixtures（含普通 429 阴性）→ 精确 parser；
- timer 到点且 gate/head 未变 → 同 request row重新 running，reviewer 被调用并可完成；
- Bridge restart → `redriveOnBoot()` 恢复 future/due timer；
- gate 外部回答/expired/missing/mismatch 或 head moved → 到点不 spawn，落各自具体无效化 reason；
- 普通 429、`not your usage limit`、无 reset、坏 timestamp → 不自动 retry但告警；
- reset 晚于 bound gate TTL、kill switch OFF → 不 spawn、不消耗额外 retry；
- 同 reset 的多个 request 得到稳定分散的 retryAt；
- 达到上限 → 不再排期但告警给出人工正门；
- `stop()` 清 timer，不再 spawn；
- legacy DB migration 实际新增列且幂等；
- done/skipped outbox、pending/running boot redrive、手工同 requestId replay 保持原行为。

### Patrol shell contract

- owning Lead 看到 eligible failed review finding 与完整 same-request recovery；
- `head_moved`、`gate_answered_externally` 不出现；
- foreign Lead/project 不出现；
- owner ambiguity 仍 aggregate-only 且 STEP 4 unavailable；
- 大量缺少 CommDB session 的历史 failed rows 因非 live/超窗在 attribution 前被裁掉，不污染 STEP 4；
- failure_raw 中的 secret fixture 不出现在报告。
