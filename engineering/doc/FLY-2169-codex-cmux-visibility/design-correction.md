# FLY-2169 设计修正附录(design-correction)

Issue: FLY-2169 (https://linear.app/geoforge3d/issue/FLY-2169/可见性-socket-直连-codex-runner-在-cmux-零可见-founder-主观察窗照不到-implement-段一晚四问)
日期: 2026-08-30
基于: plan.md(codex-approved R7,blob edc07327)

> 本附录承载 plan 过审并绑定 design_review gate **之后**到达的 Lead 指令
> (b66d628e 答复 + lead-instruction 17bbdccf / 1952faed / b976be40)。
> 按流程以 design-correction 增量修正,不回滚已批 plan、不破坏 gate binding。

## 1. Lead 设计底线对照(b66d628e 答复)

| 底线 | 状态 |
|---|---|
| ① 根因两条都吃掉:壳/窗口为何死(FLY-1239 race 面) | ✅ plan 已吃 — resume TUI 通道整体替换,race 从机理消失 |
| ① 后半:死后 app-server 孤儿回收 | ⛔ plan 未覆盖 → **本附录 §2 增补,纳入 FLY-2169 implement 范围** |
| ② 可见性 = founder 在 cmux 点开就能看 | ✅ plan 目标 4 即此 |
| ③ 修好后 Lead 的 4 个临时 VIEWER 窗能安全撤掉 | **本附录 §3 给出撤除条件** |

## 2. 增补:孤儿 app-server 回收(纳入 implement 范围)

**实锤形态**(lead-instruction b976be40):PID 92593,ppid=1、存活 11.5h、socket 零客户端、
writable_roots 指向已删除的 slot-1 路径 — 即 codex-daemon-runtime 注释(:551)明示的
「杀壳留 app-server reparent」形态。壳死 → app-server 存活是**常态路径**。

**现有机制与缺口**:runtime 已有 pgid tree-kill(FLY-1188 HIGH-2,壳自己 teardown 时)
和 `reapOrphanPid`(同 execution 重启 resume 时收割前代)。缺口 = 壳被 SIGKILL /
Bridge 崩溃后无人杀 pgid,且该 execution 不再 resume 时孤儿**永活**。

**增补设计(双轴 sweep,挂 Bridge 既有 patrol 周期,不新造调度器)**:

1. **正向(账面轴)**:枚举 `~/.flywheel/state/codex-sessions/*/session.json`
   (含 executionId + daemonPgid)。execution 已不可逆终态、或无 active runway 认领
   → 对 daemonPgid 做**三点身份验证**(进程组存在 ∧ 组内进程 argv 是
   `codex app-server --remote-control --listen unix://<该 execution 的 socket>` ∧
   env/CODEX_HOME 路径匹配该 executionId)→ 全过才 kill 进程组 + 清 socket + 记日志。
   任一点不匹配 = 拒杀(防 pid 复用误杀,fail-closed)。
2. **反向(进程轴)**(账面已被清、进程残留的 92593 型):`pgrep -f` 枚举全部
   `codex app-server --remote-control` 进程,解析各自 `--listen` socket → 与所有
   非终态 execution 的 `resolveDaemonSocketPath` 正算值比对 → 无主 ∧ 超年龄阈值
   (建议 2h)→ kill + 清 socket。argv 解析不出 socket 的进程只告警不杀。

**implement 时的 host-safe 证据链修正**(Lead 批准,a9502df7):macOS SIP 不允许
Bridge 通过 `ps eww` 读取另一进程的 `CODEX_HOME`(repo QA 已有同结论),若照字面做 env
检查会让生产 sweep 永久 inert。等价且更强的可检查四证改为:
canonical `CODEX_HOME` 目录枚举反算 `socket → executionId` ∧ 精确 app-server argv/socket
∧ fresh pgid/command ∧ fresh `lsof` 证明该 pid 正持有该 socket。每次 TERM/KILL 前重验;
组和 socket holder 都确认消失后才 unlink。每次处置均写 StateStore audit event,包含
pid/socket/exec/证据摘要。active runway 同样在 signal 前 fresh 重查,readopt 发生即停手。

**测试**:人造孤儿(真 app-server + 删账面)一个周期内被收;健康 runner daemon
对照组不被误杀;pid 复用(argv 不匹配)拒杀;socket 解析失败只告警。

**为什么进 2169**:Lead 底线①明示「否则修好可见性还会攒孤儿进程」;且 tail 窗口留痕
规则依赖「daemon 终局有人负责」这一前提,回收是同一修复面的另一半。
implement 节点落地时此增补与 plan 同 PR;code review 覆盖。

## 3. VIEWER 窗撤除条件(Lead 底线③)

Lead 手动开的 4 个临时 VIEWER 窗在以下三条**同时成立**后即可安全撤掉:

1. 新 tail 窗口在生产对至少一个 codex implement 段出现且内容实时滚动;
2. 该体 comm.db `tmux_window` 为真名(`runner-flywheel:@N`,非 pending);
3. issue-display attach 对该体不再报 `pending-target` withholding。

撤除动作 = 直接 kill 那 4 个窗(它们是 observer,无状态);transcript 文件不受影响。

## 4. 线索调查结论(DONE 详情)

### 4.1 FLY-1239 race 代码路径与触发条件(lead-instruction 17bbdccf)

- **路径**:`CodexTmuxAdapter.execute` → `onThreadReady`(:892)→ `attemptOpen`(:726)
  → `ensureRunnerTuiWindow`(codex-runner-tui-window.ts:831)→ `tmux new-window` 跑
  `codex resume --remote unix://<socket> <threadId>` → settle 800ms →
  `display-message` 验 pane(:974-999)→ pane 已死 → `window_died` → 退避重试
  (`TUI_OPEN_RETRY_DELAYS_MS`)→ 全灭后 comm.db 恒 pending →
  issue-display `attach cross-wire … pending-target withholding`(你抓到的两行日志
  正是该链的中间与末端)。
- **触发条件两个**,都在 Bridge 控制之外:
  a) resume 要求该 threadId 的 rollout jsonl 已在 CODEX_HOME/sessions 落盘,而
  app-server 落盘时机异步不受控("no rollout found" → TUI 出生 0.2s 死);
  b) resume 撞 active writer 时 codex fork 新线程 — 实锤:FLY-2155 死窗体
  b03845bf 的 CODEX_HOME 有 3 个 15:26 同分钟 fork 副本 rollout(各 2.4-3.6MB)。
  当晚 bridge.log 共 **47 次 DIED**,6 个 implement 窗全灭。
- **结论**:race 是确证根因;已批 plan 的修法不是修 race 而是整体替换通道
  (只读 tail,零依赖零副作用),race 面从机理消失。
- **附带:infra alert owner 解析**:`unknown infra alert owner: claude-infra-bot-lead`
  抛点在 `packages/teamlead/src/bridge/lead-inbox-runtime.ts:528` —
  `claude-infra-bot-lead` 本身是合法常量(infra-alert-mailbox.ts:3),抛错是因为
  **隔离房的 project roster 解析不到该 owner 对应的 project** → throw → 上层吞掉 =
  静默丢失。这是隔离房 roster 配置面的问题,不属 2169 修复面,建议归 FLY-2121 QA
  环境单或另开小单。

### 4.2 FLY-2152 死胎 `-c` 静态分析(lead-instruction 1952faed,复现主战场在 FLY-2168)

- **死胎 config 实锤**:aace4d22 的 `CODEX_HOME/config.toml` 前两行 =
  `sandbox_mode = "danger-full-access"` + `approval_policy = "never"` —
  codex-home 构造从全局 `~/.codex/config.toml` **verbatim 复制**(codex-home.ts:507
  注释明示)。管理级 `/Library/Application Support/Codex/requirements.toml`
  (root 权限,2026-08-29 当天已确认存在)禁止 danger-full-access → 该 config
  **加载即错**。与我本 session 的 companion「not authenticated」假报错同源
  (memory: codex-managed-requirements-break-global-config)。
- **健康兄弟对照**:2031(ca97c108)与死胎 config.toml 前 6 行 **identical**,
  两个 worktree 都存在 → 变量确实收窄到 spawn 时的 `-c` 值内容或环境,支持你的推断。
- **daemon spawn 的 `-c` 全集**(codex-daemon-runtime.ts:718-734,供 2168 二分):
  1. `sandbox_workspace_write.writable_roots=[…JSON 数组,per-issue worktree 路径…]`
  2. `sandbox_workspace_write.network_access=true`
  3. `apps._default.default_tools_approval_mode="approve"`
  4. `model_reasoning_effort="<effort>"`
  注意 **approval_policy / sandbox_mode 不在 -c 里** — 它们只来自 config.toml。
- **二分假说排序**:首验 #1(唯一 per-issue 变量,worktree 路径注入;裸拉无 -c 时
  config 错误是警告降级,任何 `sandbox_workspace_write.*` override 可能触发 sandbox
  配置严格重校验 → 警告升级致命);#2-#4 是常量,理论上不区分 2031/2152。
- **修法方向建议**(归 FLY-2168):codex-home 构造时把这两行 patch 为
  requirements 允许的值(`workspace-write` + 保留 never 由 -c/thread 参数表达),
  与我 session 级绕过同型 — 根除「全局 config 被管理约束打死」整族问题。

## 5. 对已批 plan 的影响

- plan 主体(可见性通道)**零改动**;gate binding(blob edc07327)不动;
- 孤儿回收(§2)作为 implement 范围扩展,授权来源 = Lead 设计底线①;
- §4 调查结论均归属他单(2168 / 2121 / 另开),不改 2169 范围。
