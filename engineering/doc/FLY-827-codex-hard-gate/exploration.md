# FLY-827 Codex code review 硬门 — 探索

Issue: FLY-827 (https://linear.app/geoforge3d/issue/FLY-827/infrap1hard-gate-codex-code-review-必须是硬门-任何-pr-没过-codex-approved-就卡住)
日期: 2026-07-03
基于: 无

## 1. 问题(what)

Codex code review 是 must-have,但**当前不是硬门**:靠 runner 自己记得跑 `/codex-code-review`,不一致、无强制。#430(793) 确认 runner 误以为「Bridge 自动触发」→ 根本没跑 Codex,却照样 QA + merge 溜过去了。#802/#807 存疑。

**根因**:没有任何东西**卡住 QA/merge 直到确认该 PR 的 Codex code review 过了**。
- FLY-579 auto-QA 在 session 进 `awaiting_review` 就 spawn,不查 Codex。
- merge gate(`verify-approval`)只查 founder 批准 + head SHA,不查 Codex。
- Codex verdict 目前只写在 runner 自己 worktree 的 `.flywheel/runs/<execId>/codex/code-review.json`,**不上报 Bridge、不进权威库、不绑 PR head SHA**、还可能只靠贴 PR 评论(sandbox 无 GitHub 写权限时连评论都没有,#428/#429)。

## 2. 现状机制(已审计)

| 环节 | 现有代码 | 现状 |
|---|---|---|
| PR created 触发 | `event-route.ts::handleCodexAutoTrigger`(stage_changed→pr_created)| 往 runner CommDB inbox 写一条 `/codex-code-review` + `await-codex-gate code` **指令**(advisory) |
| runner 自阻塞 | `flywheel-comm await-codex-gate code`(`await-codex-gate.ts`)| 轮询本地 `code-review.json`,valid=exit0。**纯本地、不上报 Bridge**;runner 若跳过它也没人拦 |
| verdict 文件 | runner 写 `.flywheel/runs/<execId>/codex/code-review.json` `{status:"APPROVED",reviewedTarget,timestamp,rounds,codexThreadId}` | 无 PR head SHA 字段、在 runner worktree、非权威 |
| auto-QA spawn | `AutoQaCoordinator.onMainAwaitingReview`(session 进 awaiting_review 时)| 直接 spawn QA,**不查 Codex** |
| 合并授权 | `flywheel-comm verify-approval`(`verify-approval.ts`)| 只查 founder gate + head SHA,**不查 Codex** |
| founder 挂起 | `isQaHeld`(`auto-qa-held.ts`)+ 3 处压制点(event-route always-deliver / GatePoller / HeartbeatService)| 只在「QA 未 pass」时挂起 founder |
| 告警 | `alertLeadPipelineError`→`LeadAlertNotifier`(FLY-368 统一 Flywheel Alerts 频道)| 现成可复用 |
| codex-skip | `session.codex_skip` / codex-skip label → Bridge 写 skip.json | 已有的合法豁免路径 |

**关键洞察**:Bridge 无法自己跑 Codex(它是 Node 服务;`/codex-code-review` 是 runner 的 Claude Code 技能驱动 Codex CLI)。所以「执行 review」必须留在 runner 侧;FLY-827 要加的是 **Bridge 侧的强制 GATING** —— runner 忘了跑/忘了上报 → **fail-closed 卡住 + 告警**(不静默溜过)。这正是硬门要的:不是防恶意 runner 伪造(那是「可信本地进程」威胁模型,同 verify-approval/qa-result),而是**强制执行**。

## 3. 设计(how)

镜像现成的 `auto_qa_record` + `qa_result` 事件模式,加一条 Codex code review 的权威链路。

### 3.1 权威记录:StateStore 新表 `codex_review_record`(teamlead.db)
- PK `(parent_execution_id, target_pr_head_sha)`,review_type 固定 `code`(design review 是 implement 前的门,不在本 issue 的 merge-gate 范围)
- `status`: `pending`(pr_created 时登记「需要 review」)→ `approved`(Codex 对该 head APPROVED)→ 或 `skipped`(codex-skip)
- 字段:issue_id / project_name / codex_thread_id / rounds / reviewed_target / verdict_event_id(幂等)/ created_at / approved_at
- **绑 head SHA** = 满足要求 #6:head 变了(#430 补 entry)→ 新 head 无 approved 记录 → 自动重卡、需重过 Codex;旧 APPROVED 不算数。

### 3.2 runner→Bridge 新事件 `codex_review_result`
- 由 `await-codex-gate code` 在**本地 JSON 校验通过后**发出(mirror `qa-result.ts` 的可靠性:retry + fail-close marker;head=`git rev-parse HEAD`)。把上报**耦合到 runner 本来就要跑的门** = 单一路径、fail-closed(没跑门→没事件→卡住)。
- Bridge `onCodexReviewResult`(event-route,mirror `onQaResult`):校验(是本 session、head 是 40-hex)→ 记 `codex_review_record=approved` → 若 parent 已 `awaiting_review` 且此刻 codex 已过 → **重驱动 `onMainAwaitingReview`**(补上 complete 先到、report 后到的竞态)。

### 3.3 三个 GATE 点
1. **pr_created**(`handleCodexAutoTrigger`):登记 `codex_review_record=pending`(codex_skip→`skipped`),keyed 到 session 当前 head。保留现有 inbox 指令。
2. **auto-QA spawn**(`onMainAwaitingReview`,在 claim/spawn/retest **之前**):要求 `(exec, session.pr_head_sha)` 有 approved-or-skipped 记录。没有 → **codex-hold**:发 thread 说明 + 重发 codex 指令 + 限频告警 Lead,return(founder 保持挂起)。**独立于 QA policy**(codex 是全队通用门,QA 是 per-project)。
3. **merge**(`verify-approval`):要求 `(exec, prHead)` approved-or-skipped。否则 `approved:false, reason:"codex_review_not_approved"`。纵深防御 —— 即便 founder gate 被答了,没过 Codex 也不许 merge。

### 3.4 founder 挂起谓词扩展
`isReviewHeld(store, session) = codex-未过(该 head) OR isQaHeld`。更新 3 处压制点用 `isReviewHeld`。这样 codex 没过时 founder 也不被 surface(即便 QA 关了)。

### 3.5 告警(要求 #5)
复用 `alertLeadPipelineError`→`LeadAlertNotifier` 统一 Flywheel Alerts 频道,新 eventType `codex_gate_blocked`,限频(每 head 只报一次,mirror auto_qa_stuck 的 eventId 去重)。

### 3.6 kill-switch / byte-compat
- 合法豁免:codex-skip label/flag → `skipped` → 门放行(现成)。
- 全局逃生口:env `FLYWHEEL_CODEX_HARD_GATE`(见下方待定项)。

## 4. 要 Lead 确认的关键决策

1. **默认 ON 还是 opt-in?**(最重要)Annie 说 must-have/严重 → 要强制。但默认 ON 的 fleet-wide merge 门,若 runner 侧上报没接好会**卡住所有 PR**(fail-closed→held+告警,不会误 merge,但会刷告警/挡 ship)。我**建议**:门默认 ON + 保留 `FLYWHEEL_CODEX_HARD_GATE=0` 紧急 kill-switch,plan 里写清 rollout 风险 + 独立 QA 造新 PR 验「不手动跑→系统自动 Codex→没过 QA 起不来+merge 被拦」。(备选:先默认 OFF opt-in,QA 过后再翻 ON —— 但拖长 Annie 的 must-have。)
2. **范围**:只做 **code review** 门(QA+merge),design review 保持现状(implement 前门,await-codex-gate 已管)。确认?
3. **上报机制**:`await-codex-gate code` 成功时发 `codex_review_result` 事件(耦合到已有的门),而非要 runner 额外记一条命令。确认?
4. **补今天的洞(#430 补 entry 重跑 Codex、#802/#807 核实)= 运营动作,非本 PR 代码**。由 Lead/founder 驱动。确认这不在我代码交付范围?

## 5. 验证

- 单测:policy/gate 谓词、`onCodexReviewResult`、verify-approval codex 分支、await-codex-gate 上报、reconcile。
- 独立 QA(造新 PR):不手动跑 codex → 系统自动触发 → 没 APPROVED → QA 起不来 + merge 被 verify-approval 拦 + Flywheel Alerts 告警;跑通 Codex APPROVED → QA 起来 → head 变 → 重卡。
