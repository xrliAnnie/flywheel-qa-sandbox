# FLY-799 Ship 流程重构:founder 批准归属 founder + runner 自 ship + fan-out 自动收尾 — 探索

Issue: FLY-799 (https://linear.app/geoforge3d/issue/FLY-799/infrafounder-facingp1-ship-流程重构founder-discord-批准-归属-founder-runner-自)
日期: 2026-07-02
基于: 无(main issue;Tadashi 定为 plan-first,大方向问题 surface 给 Annie)

---

## 0. 这是 plan-first(Tadashi 指示)

设计 → Codex design review → plan → present Annie。**本 session 不 implement、不自 ship。**
「别自 ship、Lead 不代 merge」是**要被这个 issue 取代的旧流程**。两个大方向开放问题必须
surface 给 Annie 拍:**(a) founder 身份归属怎么防伪造;(b) fan-out 部分成功的回滚语义。**

## 1. 问题(Annie 原话)

「我一批准 → runner 自己去 ship + 自动收尾」,不是「Lead 替 runner merge + 手动收尾」。
**真红线 = 「没有经过验证的 founder 批准就绝不 ship」,不是「runner 永不自 merge」。**

## 2. 现状审计(codebase 实证,非猜测)

### 2.1 runner 自 ship + 单 runner 自动收尾链路 —— 已存在且已经对
`Blueprint.ts` 的 runner `APPROVE GATE` 段(L1145–1177):`verify-approval=approved:true`
→ `stage set ship` → `gh pr comment :cool:` 触发 deploy workflow 合并 → 改写 land-status=
merged → `session_completed`(route=needs_review + landing=merged)命中
`isPostApproveShipComplete`(post-ship-finalization.ts L63–82)→ **`runPostShipFinalization`**
自动跑:关 tmux + 清 worktree(`removeCleanWorktree`)+ 发「🏁 可关闭」+ 移 founder +
archive thread。`founder-only-authority.md` R1 也明说:founder 批准 = 解锁 runner 走
`:cool:` 自 merge。

### 2.2 唯一断点 —— founder 的 thread 批准从不变成 gate response
`verify-approval.ts`(4 个 trusted 源全一致才 true):StateStore `review_question_id` 绑定
→ 该 question 有 response → response 是结构化 `{"approved":true}` → session
`approved_to_ship` 且 `pr_head_sha` 对得上。**gate 没被写 response,它永远
`gate_not_answered=false`。**

`founder-reply-deliverer.ts`(FLY-605 Part B)**已经在读** founder 的 thread 回复,并按
`msg.author.id === ownerUserId && !bot` 做身份验证。**但对 `approve_to_ship` 它故意只
WAKE、绝不写 gate response**(顶部注释:「approve_to_ship → WAKE-only … NEVER
insertResponse」,标 🔴 FLY-175 hard boundary,Tadashi-confirmed)。→ runner 醒来
verify-approval 仍 false → 卡 `awaiting_review` → Lead 只好外部 `gh pr merge`(而外部
merge 时 runner 没发 session_completed → **`runPostShipFinalization` 从不跑** → 收尾从不
触发)。现有的 Lead 中转路径(`POST /api/actions/approve` 翻 gate + 解锁 runner)靠 Lead
主动注意到 thread 批准并调用 —— Lead 是 AI,可能睡/忙/漏读 = 不可靠瓶颈。

### 2.3 fan-out 收尾的基建 —— 大部分已就位(比预期完整)
Annie 要:ship 一个节点 → 顺**关系图**把整棵树一次全清(标 Done + 关每个 runner + 删每个
worktree + archive 每个 thread + 清 cmux),founder 零提醒。关系图 = **Linear parent-child
子树 ∪ AutoQaRecord parent↔QA 链**。审计发现:
- **`closeRunner`**(close-runner.ts):单 runner 清理原语 —— 关 tmux + cmux linked
  session(FLY-756)+ macOS Terminal tab + `finalizeDone` 模式(把卡在
  running/awaiting_review/approved_to_ship 的 done runner 经 FSM 翻 `completed`)+ FLY-369
  `maybeArchiveThreadOnClose`(archive thread)+ 删 CommDB row。幂等。**不含** worktree 删
  (那是独立 `WorktreeCleanupFn`)。
- **`auto-qa-effects.closeQaRunner`**(L463-473):**QA runner 清理原语已存在** ——
  `closeRunner({finalizeDone:true})` 把 idle/parked QA 翻 completed + archive + 删 row。
- **`auto_qa_record` 表**:`parent_execution_id ↔ qa_execution_id`(+ `qa_issue_id`)=
  **feature↔QA 边已记录**(QA spawn 时 `claimAutoQaRecord`/`setQaExecutionId`)。
- **Bridge 有 Linear SDK client**(auto-qa-effects L171 `client.issue()`/`.team`/
  `.project`/`.labels()`)→ 查 parent/children + 标 Done 可达(caveat:prod projects.json
  可能没配 `linear`)。
- **缺**:`sessions` 表**无** `parent_issue_id` 列 → Linear sub-issue 子树关系没存进
  StateStore;遍历子树要么走 Linear API(`issue.parent`/`.children()`),要么新存边。

## 3. 拟建模型(三部分)

### Part A — founder-approval-relay + gate-flip(核心,改动最小)
反转 `founder-reply-deliverer.ts` 对 approve_to_ship 的 WAKE-only 边界:founder 身份已验证
的 thread 消息若是**明确批准** → 写 `{"approved":true}` gate response、**归属 founder**
(actor 如 `founder-discord`)+ 跑 `wiring.ts` 里现成的 `onResponseWritten` hook(翻
awaiting_review→approved_to_ship + 唤醒)。下游 verify-approval / `:cool:` 自 ship 零改动。
- **批准判定**:`FounderConsentEvaluator`(Haiku)天生就是干这个 —— 读 thread、要求
  evidence 是 founder message id 且在 recency window 内(evaluator.ts L297-304)、返
  allow/deny。它已是 FLY-175 gate `/api/actions/approve` 的判定器。caveat:它受
  DECISION_MODE 控(prod default-off,evaluator 可能没实例化)→ FLY-799 的检测要**独立于
  DECISION_MODE**(见 plan)。
- **红线**:只认 `author.id===ownerUserId && !bot`;Lead/bot/含糊/reject 一律不算。

### Part B — runner 自 ship(基本不改,标 795 依赖)
Blueprint APPROVE GATE 已对(verify-approval=true → 自 ship)。**依赖 FLY-795 durable-state
地基**:runner 被唤醒后自 ship 的 resume/finalize 要在重启/交接后可靠续做(否则 Bridge 重启
中断 ship = strand)。设计里**标出依赖、接口留好**;795 的 durable-state 落地前,用现有
mailbox wake + verify-approval 幂等兜底(runner 醒来重跑 verify-approval,approved 仍 true
就续 ship)。

### Part C — fan-out 自动收尾(扩 post-ship-finalization)
shipped runner 自 ship 后,除对它自己跑 `runPostShipFinalization`,还**顺关系图遍历**、对每个
相关节点跑清理(复用 `closeRunner{finalizeDone,archive}` + worktree 删 + 标 Linear Done):
- **v1(现在):auto_qa_record 链** —— feature↔QA 边已存在、`closeQaRunner` 已存在 = 高价值
  常见场景(每个 implement runner 都有 auto-QA)。
- **v2(耦合 FLY-793):Linear sub-issue 子树** —— design/implement/QA 独立 sub-issue,需
  FLY-793 先建出子树结构 + 走 Linear parent/children(或新存边)。**接口留好、实际遍历
  deferred**。
- **孤儿**:没记关系边的手动 issue 清不掉 → spawn/split 流程必须保证总挂上边(auto_qa 已挂
  QA 边;sub-issue 由 Linear parent-child,FLY-793 负责建)。

## 4. 大方向开放问题(surface 给 Annie)

1. **founder 身份防伪造**:身份来自 Discord `author.id===ownerUserId`(Discord 保证作者不可
   冒充)+ 我们的 bot token 保密。残余向量:(a) 有 comm.db/teamlead.db 写权限的同机进程能直
   接伪造(verify-approval 已声明的 threat-model:「trusted local processes」);(b)
   ownerUserId 配错;(c) Discord 账号被盗。**问 Annie**:这个身份强度可接受吗?要不要加第二
   因子(如 reaction 双确认 / 只认特定 emoji reaction 而非自由文字)?
2. **fan-out 部分成功回滚语义**:ship(merge)不可逆 → 「回滚」不指回滚 merge,而是清理这步。
   若树里某节点清理失败(如关 runner OK、删 worktree 失败)怎么办?**建议**:幂等重试 +
   失败节点告警(FLY-368 alert channel)+ 不阻塞其他节点 + 已清的不重清。**问 Annie**:接受
   「尽力清 + 失败告警你补手动」还是要更强保证?
3. **自 ship 机制(碰 founder-only-authority)**:**建议**保留 `:cool:` deploy workflow(已
   是 runner 现成路径、保 CI-green+branch-protection、守 FLY-248),不改 runner 直接
   `gh pr merge`(绕过 CI+保护、重开 FLY-248 风险)。Annie 字面写了 gh pr merge —— 按结果读
   `:cool:` 已满足「runner 自 ship、不再 Lead 代 merge」。**问 Annie**:字面照做吗?
4. **fan-out v1 scope**:v1 只做 auto_qa_record 链(现在能落),Linear sub-issue 子树接口留好
   但遍历随 FLY-793。**问 Annie**:接受这个切分吗?

## 5. 关联
FLY-605(反转其 Part B approve_to_ship 分支)、FLY-175(founder-consent,自然延伸)、
FLY-191(verify-approval + binding)、FLY-248(runner 不自 merge → 澄清为「未验证批准不
ship」)、FLY-369(central close→archive,已并,本次让 fan-out 触发它)、FLY-643(QA 独立
issue)、FLY-752(QA 复用/fix-loop)、**FLY-793**(三段式 sub-issue → fan-out v2 结构来
源)、**FLY-795**(durable-state 地基 → Part B resume/finalize 依赖)、FLY-756(cmux 清
理)。
