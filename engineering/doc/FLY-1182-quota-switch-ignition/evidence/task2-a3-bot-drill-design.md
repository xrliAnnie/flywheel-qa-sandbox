# 轨A 收尾 · 2.9 真 LLM bot 演练 — 执行设计(下一轮照此执行)

状态: 设计定稿待执行 · 前置: a2 driver 13/13 绿(slot Bridge 配方已验证)

## 编排(watchdog-won 全集成路)

1. **复用 a2 的 boot_bridge selfheal 配方**,追加 env `FLYWHEEL_COMM_DIR=$SLOT_DIR/comm-dir`(隔离 per-project CommDB,capture 用它解析 tmux 目标)。
2. **Bridge 起之前种世界**(全部用本 worktree dist):
   - StateStore(better-sqlite3, $SLOT_DIR/teamlead.db): `upsertSession({execution_id:"exec-victim", project_name:"fly1182-qa", status:"running", issue_id:"QA-VICTIM", ...})` + `openAlertThread({correlationKey:"ck-victim", eventType:"usage_limit", sessionKey:"exec-victim", accountLimit:{provider:"claude",observedAccount:"alpha",observedGeneration:1}, threadId/channelId=隔离频道})`;
   - CommDB(flywheel-comm/db dist): `$SLOT_DIR/comm-dir/fly1182-qa/comm.db` → `registerSession("exec-victim", "<tmux 目标>", "fly1182-qa", ...)`;
   - 真 tmux(**默认 server**,capture 不认 -L socket;窗口名唯一 fly1182-victim,勿动他人): `tmux new-session -d -s fly1182-victim "cat <usage-limit-real fixture>; sleep 3600"`;
   - scratch pending: due 立刻(deadlineAt=now)。
3. **boot Bridge** → 30s 内 watchdog 真切换(alpha→beta)+ `onSwitchCommitted` 给 ck-victim stamp `switched_generation=2`(账本绑定的全集成落点)。
4. **真 LLM bot** = codex:codex-rescue subagent,prompt = persona「救」节逐字 + assignment 文案(sourceAlertId/observedAccount=alpha/observedGeneration=1/目标清单 exec-victim)+ slot Bridge URL + TEAMLEAD_API_TOKEN + scratch accounts.json 路径 + 「隔离演练,证据帖标(可删)」。期望它自主:
   - POST /api/account-switch claim → **409**(watchdog 已切)→ 不当失败;
   - 读 scratch accounts.json:generation==observed+1 且 active!=alpha → 判定相邻切换已发生;
   - POST /api/rescue {route:"runner",executionId:"exec-victim",kind:"quota_stuck",actorBackend:"codex"};
   - 按响应行动:refusal=停手;escalated=报告;ok=报告成功。
5. **服务端预期路径**:准入(绑定命中)→ revalidateQuota 捕真 pane(fixture 显示 cap)→ terminate FSM → closeRunner(真 tmux 关)→ startSuccessor —— **bridge-only slot 无真 dispatch 栈,此腿预计 throw → op-state 记 closed → escalated ⚠️ 帖**。这正是 2.9-B 子段的边界(已 ask Tadashi 裁定 05103e27:全保真需 FLY-115 real-runner 栈 vs 按「原语同 FLY-871 已真机验 + module/HTTP 级已验」记边界)。
6. 证据:bot 会话原文(它的 HTTP 调用与判断)、bridge 日志(admission/revalidate/terminate/close/audit 行)、隔离频道帖、op-state 行(rescue_ops phase=closed = 部分失败可重试的真机形态)。

## 已勘明的技术事实(别再花时间重查)

- captureSession: CommDB `$FLYWHEEL_COMM_DIR/<project>/comm.db` 的 sessions.tmux_window → 默认 tmux server capture-pane。
- StateStore.upsertSession / openAlertThread(带 accountLimit)可直接种;FSM applyTransition 认 sessions 行。
- codex 一律经 codex-rescue subagent(raw exec 本机挂死;memory 红线)。
- slot Bridge 必须 pin FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_N(生产 .env 继承坑,a2 已踩)。
