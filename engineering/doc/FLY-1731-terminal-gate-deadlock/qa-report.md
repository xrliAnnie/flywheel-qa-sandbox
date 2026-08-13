# FLY-1731 活着的 runner 被判终态·gate 永不投递 — 独立 QA 报告

Issue: FLY-1731 (https://linear.app/geoforge3d/issue/FLY-1731/session-被提前判-terminal活着的-runner-双向失联-ship-gate-无限重试永不投递)
日期: 2026-08-12
基于: plan.md

## 0. 判定

**PASS** — issue 三条行为验收全部在 529 隔离房真机成立。一腿(founder ✅ → land 推进)未跑,原因是只有 founder 能解的环境阻塞,详见 §5 诚实边界。

被测 head:`7ef0161a`(= 已推送的 PR head `504d6e99` + 我自己的 progress-ledger commit;`git diff 504d6e99 7ef0161a --name-only` 只有 `progress.md`,**源码逐字节相同**)。
覆盖 PR #819(Fix A)+ 堆叠 PR #822(Fix B/C/D)的合并形态,即 plan §3.1 要求的「A+B 组合回归」。

## 1. 真机环境

529 隔离房 slot 3:候选 head 的 Bridge(port 19873)+ 真 test Lead `flywheel-test-3`(launchd-v2 载体)+ 真 Discord bot,隔离频道 `#ops-lead-test`。
**确认跑的是候选代码**(不是靠 build 戳):`packages/teamlead/dist` 里 `RETRY_HORIZON_MS`×2、`holderAuthoritative`×3、`holder_carrier_unbound`×1、`completion_disposition`×4 全部在场,Bridge 进程 argv 指向本 worktree。

生产零污染:
- 生产 Bridge PID 22119 全程未重启(17:03 起,验收时 uptime 5082s)。
- 生产 comm.db 只做 `-readonly` 查询。
- 生产告警目录逐文件前后对齐;隔离房唯一外溢的一条 `flywheel-test-3` 告警已移出生产 deadletter,基线恢复(0 新增 0 删除)。窗口内其余新文件经逐条归因均属他人/生产活动。

## 2. Fix A — holder-authoritative admission(issue 验收 ①)

把 FLY-1704 事故形态原样种进隔离房(真 StateStore + 真 CommDB + 真 Bridge inbox loop):
engine-owned epoch-1 land run → `complete --route needs_review` → session 投影 **completed**(从未进 awaiting_review)→ gate holder 铸出 → `approve_to_ship` 问题入队。

三次独立复现,全部投达:

| 次 | question id | 结果 |
|---|---|---|
| 1 | `workflow-gate:87db07d4…` | materialized → **ACKED**;`lead_events` 出现 `gate_workflow-gate:87db07d4…` / `gate_question`,`delivered_at 01:00:16` |
| 2 | `workflow-gate:8f450028…` | materialized → ACKED;`lead_events` seq 3,`delivered_at 01:08:37` |
| 3 | `workflow-gate:1ef27b63…` | materialized → ACKED |

**真 Discord 腿**:test Lead 消费 gate_question 后,真的把 gate 发进隔离频道 —— 第一次是频道顶层消息 `1537264475395326034`,第二次开进真 thread `1537266907357519985`。Lead 同时正确拒绝代批(founder-only-authority 合同),只做转达。

即:issue 症状「Annie 从未被通知可以 ship」在修后不再复现,通知链一路走到真 Discord。

## 3. Fix B — 有限终结 + 可见告警(issue 验收 ②)

同一个活 Bridge 上跑四格,**唯一变量受控**:

| 格 | source session | TTL | 结果 | 证明 |
|---|---|---|---|---|
| a 正例 | completed + **有 holder** | 72h | 投达 | Fix A 不被活性检查拦 |
| b | completed(无 holder,legacy) | 72h | **DEAD** `revoked_terminal_session` | Fix A **不是**无差别放行;`completed` 无出边 ⇒ 永久 |
| c 对照 | blocked(无 holder) | 72h | **存活重试**(QUEUED) | `blocked` 有出边 ⇒ 可重试;证明不是「什么都死」 |
| d | blocked(无 holder) | **2h** | **DEAD** `revoked_terminal_session` | c/d 唯一差别是 TTL ⇒ 24h horizon 这一层真在起作用 |

b 与 c 的差别只在 session 状态(permanence 层),c 与 d 的差别只在 TTL(horizon 层)——两层各自被一组对照钉死。

**可见告警**:DEAD 行真的产生了 `mailbox_dead_letter` 告警(`lead_events` 里 `dead_letter_alert:lead_unacked:flywheel-test-3:1`),正文点名了那条没投出去的 gate 问题原文。不是静默过期。

## 4. Fix C / Fix D

- **Fix C(收工信号)**:三次真机 completion 全部返回 `completionDisposition: "engine_gate_handoff"` —— 这正是 FLY-1704 那个 runner 该收到、当时没收到的「你已终结,别等 approve」信号。CLI 侧打印分支与 2xx-body 读失败兜底由单测覆盖(含逐字节兼容哨兵:`terminal_no_gate` / 无该字段时输出与现行完全一致)。
- **Fix D(死信通道)**:计划范围是「核实既有通道,零新增代码」。Lead-收件方那半在真机上跑通(见 §3 告警)。runner-收件方那半(`scanAndInsertDeadLetterNotices` → owner Lead)本次未在真机重放,依赖既有测试覆盖 —— 见 §5。

## 5. 诚实边界(honest boundary)

1. **founder ✅ → land 推进:未验证。** 两个原因叠加:
   (a) engine gate 是 **founder-bound** —— 我用真 `respond '{"approved": true}'` 走真 Bridge 试过,被明确拒绝:`lead_ack_rejected — Lead approval cannot resolve a founder-bound gate; only the trusted founder writer may approve.` 这条拒绝本身是**好证据**(护栏在),但也意味着这腿只能由 founder 本人的界面触发。
   (b) Claude-in-Chrome 断连:本机 Claude 账号 2026-08-13T00:55Z 刚从 school 切到 personal1,扩展侧没跟着重新登录(chrome-repair §7 陷阱 7 的典型形态)。重登扩展是**只有 founder 能做**的动作。
   风险:这腿属 plan §3.4 明确划出范围的 approval 深链(FLY-1448/1505 领域),不影响本单三条验收;但 research §5 曾把它列为「QA 节点必跑」,所以我不把它算作已验。补测时机:Annie 修好扩展登录后,在真卡上点一次 ✅ 即可闭环。
2. **Bridge 自己贴的 founder ship 卡:未观察到。** 合成 issue 没有 chat thread,materializer 报 `workflow_gate_thread_not_found`;唯一一次 thread 对上的尝试撞了 `deterministic question identity conflict` —— 那是我的 harness 抢先插了问题行造成的**取证工装副作用**,不是产品缺陷。founder 实际是经 Lead 的真 Discord 转发被通知到的(§2)。
3. **`completionDisposition` 走 HTTP 那一跳:仅单测覆盖。** 真机 POST `/events` 需要 dispatcher 建的 worktree binding(我两次尝试分别撞 `worktree_binding_missing` / `land_head_unavailable`),没有真 Runner 就凑不出。服务端取值本身已在真机证了三次。
4. **529 房自身两个缺口**(与本单无关,建议另记):slot-3 bot 对 `#test-flywheel-alerts` 403,`--alerts` 起不来;slot Bridge 异常退出会往**生产**告警路径写 `bridge_abnormal_exit`(落 deadletter 未投递)。

## 6. 门与非真机证据

- `pnpm -r build`:通过(exit 0)。
- `pnpm lint`:通过,0 error(13 条既有 warning)。
- 定向测试 242 passed:question-admission + event-route 102、StateStore generalized-execution + workflow-engine-transition 83、flywheel-comm complete 57。
- **突变检验**(绿测不算证据,得证明测试真钉着改动):
  - 把 `holderAuthoritative` 写死 `false`(等于撤掉 Fix A)→ 5 个测试红,含验收 ① 的集成用例 `delivers a land gate after needs_review terminalizes its source session`。
  - 去掉 24h horizon 项 → `stops a retryable verdict at the inclusive 24-hour horizon` 红。
  - 把 `if (!gateOpened) return "terminal_no_gate"` 短路掉 → `parks a ship-capable epoch-1 execution without opening founder review before the Gate` 红(该用例正是 engine-owned + epoch-1 + 未开门那一格)。
  三次突变后文件逐字节还原,`git status` 干净。

## 7. 建议(不阻断 ship)

1. **24h horizon 是绝对量,不是比例** —— 任何**出生时 TTL ≤ 24h** 的问题行,重试预算为零:第一次瞬时拒绝就判死。生产近 30 天实测:`approve_to_ship` 20 条里 2 条、`review_code` 157 条里 13 条属这一类(最短 0.03h)。这是 plan §3.1「边界含等号」明确拍过的取舍(宁可响亮地死,不要静默过期),但它把「本来会自愈的瞬时故障」变成「可见的永久失败」。建议后续把 horizon 改成 `min(24h, TTL/2)` 之类的相对量,或至少给短 TTL 行留一次重试。
2. **`complete.ts` 的 abort timer 现在在读 body 期间仍武装着** —— 非 2xx 分支读 `response.text()` 若超时,会把一个确定的 HTTP 失败转成通用 attempt 失败并重试。影响很小,但与「2xx 才是权威」的意图相比,非 2xx 路径的语义被顺带改了。
3. 上面两条都建议记成 follow-up,不建议卡本单。
