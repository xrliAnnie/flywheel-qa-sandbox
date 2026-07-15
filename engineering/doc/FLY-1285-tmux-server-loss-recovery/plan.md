# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 实施计划

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: research.md

**Status**: draft（codex design review Round 2 中；Round 1 十项反馈已全量吸收）
**裁决来源**: brainstorm gate 已过（Tadashi 批 A/B/C 全量 + 四点裁决：PR-0 最先单独出 / runbook 附 research / B 加真机验收 / C 批准）。

## 核心安全原则（贯穿全计划，Round 1 反馈的公分母）

1. **破坏性动作只接受正向证明**（positive proof）：创建新 server、埋葬 session、清理旧 claude，三者的前置都必须是"完整扫描证明"（scan complete），任何 `unknown` / `ambiguous` / `saturated` / `rescue_failed` / helper 缺失 / ps·lsof 失败一律 **hold/backoff**，绝不 fail-open 到破坏性路径。与 `probeTmuxServer` 既有三态约定（tmux-lookup.ts:259-279 "unknown never treated as loss"）同构。
2. **诊断→决策→动作必须原子**：每个 socket 一把跨进程锁，锁内完成"重新 inspect + SIGUSR1 或 create"；锁外的分类结果只用于日志。
3. **hold 必须可持久、可解除、有界升级**：Bridge 侧 hold 落 StateStore；supervisor 侧连续 hold 超时升级 severe 告警——不能无声挂死，也不能挂过真恢复窗口。

## 0. 总览与 PR 切分

| PR | 内容 | 目标文件 | 生效方式 | 依赖 |
|---|---|---|---|---|
| PR-0 | 健康窗可配置（FLY-1290 载体，**最先单独出、独立小分支**） | scripts/restart-services.sh、scripts/lib/health-window.sh（新，极小可 source 单元）+ 测试 | 下次跑 restart-services.sh 即生效 | 无 |
| PR-1 | tmux inspect/rescue 库 + supervisor 三态等待 + Fix C 互斥 + Fix B model/effort SSOT | scripts/lib/tmux-server-rescue.sh（新）、packages/teamlead/scripts/claude-lead.sh + 测试 | Lead 下次 relaunch/重启生效 | 无（与 PR-0 并行可） |
| PR-2 | Bridge/Runner 侧接入：ensureRunnerSession 守卫 + ServerLossCoordinator 宣判前 inspect + durable hold 贯通 reaper + split-brain 告警 kind | packages/claude-runner/src/TmuxAdapter.ts、packages/teamlead/src/bridge/{server-loss.ts,plugin.ts,sync-flywheel-hooks.ts}、packages/teamlead/src/{HeartbeatService.ts,StateStore.ts,LeadAlertNotifier.ts} + 各自测试 | 需 Bridge 重启（攒批） | PR-1（同一 helper + 共享 fixture） |

三阶段管线注：本分支（flywheel-FLY-1285）为共享分支；PR-0 从 main 直接开小分支速出（Tadashi 裁决），PR-1/PR-2 在本分支交付（是否再拆按 implement 时 diff 体量与 Lead 意见定）。docs 随本分支 PR 合入。

## 1. PR-0 — restart-services.sh 健康窗可配置

### 改动
1. 新极小可 source 单元 `scripts/lib/health-window.sh`：函数 `resolve_health_window_sec`（读 `FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC`）+ `health_window_rounds`（按 sleep 步长向上取整，保证时间预算不缩水）。restart-services.sh 在 **`.env` source 之后**（现 :32-95 的 env 装载完成后）调用解析——env 覆盖必须能来自 ~/.flywheel/.env。
2. 解析规则（消除 Round 1 #10 的自相矛盾）：
   - 未设/空 → 默认 **240**（实测冷启动 ~110s × 2 余量）。
   - 非法（非正整数）→ **回安全默认 240** + warning（绝不落到最小窗）。
   - 合法但 <30 → clamp 30 + warning。
   - 合法 ≥30 → 原值。
3. 两处 60s 硬窗（deploy 路径 :1288-1301、bridge-only 路径 ~:1380-1395）改为 `health_window_rounds` 推导（sleep 2 不变，轮数=ceil(sec/2)）；文案（:1362 dry-run、:1392 severe 告警正文）引用实际配置值。
4. ~~abnormal-exit 面包屑~~ **砍出 PR-0**，另开 follow-up 票（保 PR-0 极小）。

### 测试
- 新 `scripts/__tests__/restart-health-window.test.sh`，**直接 source `scripts/lib/health-window.sh` 驱动真实解析逻辑**（restart-services.sh 本体不可 source——见 restart-stabilization.test.sh:1-7 的先例注记；同时加一条对生产文本的 grep 断言：restart-services.sh 确实引用了该 helper 与变量名，防两份逻辑漂移）：
  a. 未设 → 240 → 120 轮。
  b. `=40` → 40 → 20 轮；`=41` → 21 轮（向上取整）。
  c. `=5` → clamp 30 + 警告行；`=abc` / `=-1` / `=0` → 回 240 + 警告行。
  d. 反向兼容哨兵：`=60` → 30 轮，与旧版行为等价。
- 现有 5 个 `scripts/__tests__/restart-*.test.sh` 全绿（回归锚）。

### 验收
- 打桩 /health 于第 90s 才 ok：`=60`（旧行为）判失败、默认 240 判成功——两侧断言。

## 2. PR-1 — inspect/rescue 库 + supervisor 接入 + Fix B + Fix C

### 2.1 新库 `scripts/lib/tmux-server-rescue.sh`

**inspect 接口（机器可读，Round 1 #2）**：`tmux_socket_inspect <socket_path>` → stdout **单行 JSON**（诊断日志一律走 stderr）：

```json
{"verdict":"reachable|missing_single_orphan|saturated|dead|split_brain|ambiguous|unknown",
 "socketPresent":true,"socketPath":"/private/tmp/tmux-501/default",
 "reachablePid":93009,"candidatePids":[3738],"scanComplete":true}
```

- 路径规范化：输入路径与 lsof 输出都归一到 `/private/tmp` 形态再比较（macOS `/tmp` 是符号链接，不归一会漏 owner）。
- 判定次序：
  1. 可达性探测：`tmux -S <path> display-message -p ok`，有界等待（**macOS 无 GNU timeout**：后台进程 + 轮询 `kill -0` + 兜底 TERM 的 shell 实现，≤3s）。
  2. 候选扫描：同 uid、**ppid==1** 的 tmux 进程（`ps -axo pid,ppid,comm`），逐个 `lsof -p` 过滤引用该规范化路径者；ps/lsof 任一失败 → `scanComplete:false` → `unknown`。
  3. 组合裁决：可达 + 无其它候选 → `reachable`；可达 + 有其它候选 → **`split_brain`**（双 PID 全量入 JSON）；不可达 + socket 缺失 + 恰一候选 → `missing_single_orphan`；不可达 + socket 缺失 + 候选>1 → **`ambiguous`**（绝不自动选最老——世代无法从 lstart 推断）；不可达 + socket 存在 + ≥1 候选 → `saturated`；不可达 + 扫描完整 + 零候选 → `dead`；其余 → `unknown`。
- **原子守卫 API（Round 1 #4）**：`tmux_socket_ensure <socket_path> -- <create-cmd...>`：
  1. 取每 socket 一把跨进程锁：`mkdir "<规范化路径>.fly1285.lock"`（mkdir 原子、macOS 可用；锁目录内写 owner pid；持锁者死亡的陈旧锁按 pid 探活回收；取锁有界等待，超时 → `unknown` 语义 hold）。
  2. 锁内重新 inspect → 按裁决行动：`reachable` 直接返回 ok（幂等）；`missing_single_orphan` → SIGUSR1 →（锁内）≤3s 轮询 socket 重现+可达 → 成功 ok / 失败**保持锁内**重新 inspect 一次，仍非 `dead` 则返回 hold；`dead`（scanComplete 前提）→ 锁内执行 create-cmd；`saturated`/`ambiguous`/`split_brain`/`unknown` → 返回对应 hold 码，**不建不发信号**。
  3. SIGUSR1 前置三条件缺一不可：路径缺失 + scanComplete + 恰一候选（E3 铁律的机械化）。
- 退出码约定：0=ok（可用/已建/已救）；2=hold-saturated；3=hold-ambiguous/split_brain；4=hold-unknown。dry-run env `FLY1285_RESCUE_DRY_RUN=1`；风格随 reap-orphan-adapters.sh（errexit 保护、shellcheck）。
- **双宿主分发（Round 1 #8，设计期定死）**：shell 宿主（claude-lead.sh）经 `SCRIPT_DIR` 相对路径直接 source（零分发面）；Bridge/TS 宿主经 `syncFlywheelCliBin` 把它作为可执行 CLI 同步进 `~/.flywheel/bin/`（allowlist 现仅 `agent-team-transport`，sync-flywheel-hooks.ts:236-242 → 加入本 CLI + sync 测试）；**Bridge 调用发现 bin 缺失/不可执行 = inspection incomplete = hold（fail-closed）+ 每 tick 日志**，boot sync soft-fail（plugin.ts:3383-3403）的现状因此不构成破坏性风险。

### 2.2 claude-lead.sh 接入（Fix A 前半）

**(a) 统一 socket 寻址**：新 `_tmux()` 包装函数——`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 非空时对**所有** tmux 调用注入 `-S <override>`（new-session/new-window/kill-window/list-panes/send-keys/display-message/capture-pane 全部经它）；默认空=现行为逐字节不变。隔离验收由此才成立（Round 1 #5 后半）。

**(b) `ensure_tmux_session` 改为守卫式**：调用 `tmux_socket_ensure <path> -- tmux new-session -Ad -s flywheel -x 200 -y 50`；返回 hold（2/3/4）→ ensure 返回非零并设 `ENSURE_HOLD_KIND`。

**(c) `set -e` 控制流修正（Round 1 #5）**：main loop 两处裸调用（:2392、:2423）改为 `if ! _launch_claude …; then LAUNCH_OUTCOME=hold; fi` 形态（或等价的返回值捕获），`_launch_claude` 内部 ensure 失败 → 立即 return 1（**不写 session file、不起 dialog poller、不进 `_wait_tmux_window`**）。主循环对 `LAUNCH_OUTCOME=hold`：
- **不**计入 crash count、**不**计入 resume-failure（不许饱和期误删 session file）；
- 走独立的 hold backoff 序列（复用 BACKOFF_SECONDS 数值即可，但计数器独立）；
- **有界升级**：连续 hold 超过阈值（默认 10 分钟，`FLYWHEEL_TMUX_HOLD_ESCALATE_SEC` 可调）→ 经 lead-alert.sh 发 severe（kind 复用既有 crash_loop 通道或新增 `tmux_hold`——implement 时按 lead-alert.sh 现有 kind 面最小化选择，倾向复用现有通道 + 正文注明 hold 原因），继续 hold 不自杀。
- 测试直接驱动真实 main-loop seam（打桩 `_launch_claude` 依赖）断言：supervisor 存活、无 fresh session file 写入、按 5/15/30… 重试、告警在阈值后恰一次。

**(d) `_wait_tmux_window` 三态化（Round 1 #1 核心）**：现状把一切 list-panes 失败记 `CLAUDE_EXIT=1`（:1305-1309）。改为：
- `list-panes` 成功 + pane_dead=1 → **proven_dead**（现路径，拿 exit code、kill-window、返回）。
- `list-panes` 成功 + 窗口在 → alive，继续等。
- `list-panes` 失败 → **server_indeterminate**：调用 inspect——
  - `reachable`（server 好好的，窗口真没了）→ proven_window_gone → 按 crash 返回（现语义）。
  - `missing_single_orphan` → 锁内 rescue → 成功后**重查原 `LEAD_WINDOW_ID`**：pane 还在 → 回到等待循环（**不 reap、不 relaunch、不二次 resume**）；pane 确实没了 → proven_window_gone。
  - `saturated`/`ambiguous`/`split_brain`/`unknown` → 停留在等待循环（沿用 3s 轮询 + 周期性降噪日志），**绝不据此判死**。
- 由此 E1/E2 场景下旧 claude 全程不被触碰——这是"恢复价值"的保全点。

### 2.3 Fix C — 双实例互斥（顺序在 2.2d 之后才有意义）

- `_launch_claude` 成功后记录 pid 档案：`${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.claude.pid` 内容 = `pid + 进程 start-time 标识（ps -o lstart 序列化）+ window_id`（三元组防 PID 复用，Round 1 #1 尾）。
- 触发点：仅在 **proven_dead / proven_window_gone** 后的下一次 launch 前执行 `reap_stale_lead_claude`：
  - 读档案；pid 不存活 → 清档案返回。
  - 存活 → **TERM 前重验**：`ps -o command=,lstart=` 同时匹配 claude + 本 lead 辨识（--agent ${LEAD_ID} 或 prompt 路径含 lead-id）+ start-time 与档案一致；不匹配 → 视为 PID 复用，仅清档案。
  - 验明 → SIGTERM → ≤10s 轮询 → **KILL 前再重验一次** → SIGKILL → log。
- `cleanup()` 同步清档案。server_indeterminate 分支（2.2d）**永不**进入 reap——防"先杀可恢复的旧 Lead"（Round 1 #1）。

### 2.4 Fix B — model/effort 每次 launch 现读 manifest（Round 1 #9 修正版）

- 新 resolver `_resolve_launch_model_effort`（`_launch_claude` 内调用，产出**本地** LAUNCH_ARGS 追加段；全局 CLAUDE_ARGS 不再含 --model/--effort，杜绝重复 flag 累积）：
  - model：`jq -r` 安全读 manifest `.model`（jq 失败/文件损坏 → 打 warning **降级到 env**，`|| true` 保护绝不触发 set -e 退出）；trim 后非空 → 用之；空 → env `FLYWHEEL_LEAD_MODEL`（沿用 FLY-241 空白串=未设语义）；仍空 → 不传。
  - effort：**保留现有 :1636-1676 的完整语义**——trim + enum 白名单（low|medium|high|xhigh|max）+ 非法回落链。解析次序：manifest `.effort` 过 enum；非法/空 → env `FLYWHEEL_LEAD_EFFORT` 过 enum；仍非法/空 → 维持现状缺省（companion 侧 xhigh 回落不动）。每级非法都打 warning。
  - drift 观测：manifest 与 env 都非空且不同 → log `model drift: env=… manifest=… → using manifest`（effort 同）。
- 字节兼容：manifest 无字段 → 走 env → 与今日逐字节一致；FLY-231 dry-run launch-plan 的 ARG 输出如实变化，相关 sentinel 按 FLY-217 先例 LEGITIMATE RETARGET 并在 PR 描述标注。
- 测试：**扩展现有 CI 锚 `packages/teamlead/scripts/__tests__/fly241-lead-model-override.test.sh`**（manifest 有/无 × env 有/无 × drift × 空白串 × jq 损坏降级 × effort 非法回落链）；补 `claude-lead-manifest-preserve.test.sh` 对 effort 字段 preserve 的断言（现只测 model/leadBackend）。
- 真机验收（Tadashi 裁决 ③）：QA slot 隔离 lead，manifest.model 改为**有效备选模型**（如 sonnet↔opus 互换，Claude CLI 可接受）→ 自然 relaunch → 断言：新 claude argv 用 manifest 值、旧值 argv 不存在、plist/env 未动、drift 日志一行。

### 2.5 PR-1 测试

- `packages/teamlead/scripts/__tests__/tmux-server-rescue.test.sh`：mock ps/lsof/tmux 覆盖七态 inspect（含 /tmp↔/private/tmp 归一、scanComplete=false→unknown、候选>1→ambiguous、可达+候选→split_brain）、SIGUSR1 三前置、锁的取得/陈旧回收/超时→hold。
- **并发 fixture（Round 1 #4 要求）**：真 tmux 隔离 socket 上并发跑 rescue×create（两进程赛跑），断言终态恰一 server、无 E3 反抢占（socket inode 只变一次或不变）。
- 真 tmux 集成段（隔离 -L/-S）：E1 saturated→hold（不顶替）、E2 missing_single_orphan→rescued、E3 场景 inspect 判 split_brain/守卫拒发 SIGUSR1。
- supervisor seam 测试（2.2c）+ `_wait_tmux_window` 三态测试（打桩 inspect 返回各态断言等待/判死/rescue 后回等待）+ Fix C 档案三元组与双重验证测试 + Fix B 测试（2.4）。
- **E1/E2 真机验收断言升级（Round 1 #1 尾）**：除 runner 零伤亡外，必须断言旧 Lead claude PID 全程存活、session file 未被改写、无第二次 `--resume` 发生。

## 3. PR-2 — Bridge/Runner 侧接入

### 3.1 TmuxAdapter.ensureRunnerSession（Round 1 #7 选型：ensure 内有界重试）

- 主 create 与 fallback create（:1191-1212 两处）都改走守卫：经 `~/.flywheel/bin` 的 rescue CLI 执行 `ensure`（同一把锁、同一裁决面）。
- `saturated`/`unknown`/`ambiguous` hold → **ensure 内有界指数重试**（2s 起倍增，总预算默认 90s，env 可调）直到 ok 或 `dead`（允许 create）或预算耗尽；预算耗尽 → 抛带 `tmux_saturated`（或对应 kind）辨识的 typed error → 上游按既有失败面处理（Blueprint success:false → DagDispatcher shelve）。**明确接受的降级**：超 90s 的持续饱和退化为现行 shelve 行为——诚实封顶、响亮日志；把 Blueprint/DagDispatcher 改造成端到端 retryable dispatch 另开 follow-up 票（本票不扩 scope）。
- CLI 缺失 → 同 hold 处理（fail-closed），预算耗尽路径同上。
- claude 路径字节兼容锚：TmuxAdapter 既有测试套件全绿（约 110 个 it 用例）+ 新增守卫分支桩测。

### 3.2 ServerLossCoordinator + HeartbeatService + StateStore（Round 1 #6）

- **durable hold**：StateStore 新增 `tmux_hold` 单行状态（kind: saturated|split_brain|unknown、evidence JSON（双 PID 等）、created_at、last_checked_at）；写读接口 + 迁移遵循既有幂等 ADD COLUMN/表先例。Bridge 重启后 hold 依然在——boot leg 的 firstCheck 消费问题（server-loss.ts:123-126）由 hold 兜底：有 hold 时每个 tick 都重新 inspect，收敛（inspect=reachable 且无候选）才清除。
- **coordinator 结构化裁决**：`check()` 返回从 `ReadonlySet<string>`（claimed）升级为 `{claimed: ReadonlySet<string>, holdDestructive: boolean}`：
  - tick leg：probe=down 先 inspect——`missing_single_orphan` → 锁内 rescue → 成功：本 tick 按 unknown 语义（suppress 一切、零埋葬）+ **log-only** 一行 `socket_lost_rescued`（**不新增告警 kind**，Round 1 #8 裁定：rescued 是信息不是工单）；`saturated`/`unknown` → 写/刷新 durable hold + holdDestructive=true；`dead`（scanComplete）→ 现行 server_down 埋葬路径不变。
  - boot leg：targetGone 全灭成立后、埋葬前 inspect——`split_brain`（可达 server + 孤儿候选）→ 写 durable hold + 发 `tmux_split_brain` 告警（见 3.3）+ holdDestructive=true + **零迁移**；`dead` → 现行 server_fresh 埋葬不变。
  - helper 缺失/异常 → holdDestructive=true（fail-closed）+ 每 tick 日志；hold 期间 episode 账本不建（收敛后由既有对账自然处理）。
- **HeartbeatService 贯通**：`check()` 的 holdDestructive 注入同一 tick 的 `reapCrashedRunners()`、`checkStuck()`、`reapOrphans()`（:438-453 调用序）——hold 时三者全部跳过破坏性动作（探测与日志照常）。crash-reaper 的 suppression（:1719-1733）加入 hold 判据。
- scope/测试因此包含：HeartbeatService.ts、StateStore.ts（+ 各自 __tests__）、server-loss.test.ts 扩展（rescued 零迁移、saturated hold 持久、split_brain 零迁移 + ticket、hold 期 reaper 跳过、hold 收敛清除、既有用例全绿回归锚）。

### 3.3 `tmux_split_brain` 告警 kind（Round 1 #8 契约面）

- LeadAlertNotifier：`ALERT_EVENT_TYPES` + exhaustive `KIND_CONTRACTS` 新条目——severity: severe；owner: `human_by_design`（收敛动作=research §4 runbook，天然人工）；dedupe 签名 = 规范化 socket path + 排序后的 (reachablePid, candidatePids) 组合（同一僵局不重复开票，PID 组合变化=新局面可再开）；resolve 条件 = durable hold 清除（re-inspect 单 server 收敛）时由 coordinator 调 resolveTicket；metadata = 结构化 `{socketPath, reachablePid, orphanPids, casualtiesHeld}`。router/Hub/recovery/dedupe 既有契约测试全部随之更新（这些测试是 exhaustive 的，漏一处会 typecheck/启动失败——列入 PR-2 验收清单）。

### 3.4 PR-2 真机段（QA）

- 隔离 socket 重演 server_fresh 假埋：断言 Bridge 零埋葬、split_brain ticket 恰一张、hold 落库、Bridge 重启后 hold 仍在、人工收敛后 hold 清除 + ticket resolve。

## 4. 运维与部署顺序

1. PR-0 独立 merge（无重启面）。
2. PR-1 merge → 各 supervisor 下次 relaunch/fleet 重启生效。
3. PR-2 merge → 攒进批量重启窗（多 PR 一次重启纪律）。
4. 活体 split-brain 收敛（research §4 runbook）由 Tadashi/founder 择机执行，建议在 PR-1/2 部署重启前完成。
5. Follow-up 票（本票不做）：abnormal-exit 面包屑；Blueprint/DagDispatcher 端到端 retryable dispatch；tmux 换 arm64 原生 build + 探测洪峰减载。

## 5. 风险与缓解

- **hold 误判卡住合法创建**：hold 全部有界升级（supervisor 侧 10min 告警；TmuxAdapter 侧 90s 预算降级 shelve；Bridge 侧 hold 只暂停破坏性动作、探测照跑）；`dead` 的 create 路径要求 scanComplete 正向证明，但零候选+扫描完整即放行——全新机器冷启动不受影响。
- **锁死锁/陈旧锁**：mkdir 锁带 owner pid + 探活回收 + 取锁超时→hold；锁粒度 per-socket，持锁段只含 inspect+signal/create（毫秒~3s 级）。
- **SIGUSR1 打错**：三前置（路径缺失+scanComplete+恰一候选）+ 锁内重验；候选>1 一律 ambiguous 交人。
- **Fix B/C 改动 supervisor 主循环**：所有新分支带 seam 测试直接驱动真 main-loop 代码；ensure/launch 失败路径全部显式 if 包裹，杜绝 set -e 暗杀。
- **契约面遗漏（alert/CLI sync）**：KIND_CONTRACTS/router/sync allowlist 均为 exhaustive 测试覆盖，列入验收清单逐项打勾。

## 6. 验收清单（QA 阶段照单执行）

1. PR-0：90s 慢启动打桩下 `=60` 判失败 vs 默认 240 判成功；解析矩阵（240 默认/40→20 轮/41→21 轮/5→30/abc→240）。
2. E1 重演（隔离 -S）：饱和期 supervisor hold 不顶替 socket、独立 backoff、超阈值告警一次、恢复后自动接续；**旧 Lead PID 全程存活、session file 未改写、无第二次 --resume**。
3. E2 重演：socket 删除 → 三态等待走 rescue → 窗口找回 → 回到等待循环零动作；或窗口确没 → proven 判死走正常重启。
4. 并发赛跑 fixture：rescue×create 终态恰一 server、无 E3 反抢占。
5. split-brain 场景（Bridge）：零埋葬、tmux_split_brain ticket 恰一、durable hold 落库 + 重启幸存 + 收敛清除 + ticket resolve。
6. B 真机：staged manifest 改有效备选 model → 自然 relaunch 生效、plist/env 未动、drift 日志（Tadashi 裁决 ③）。
7. C 真机：proven 判死后孤儿旧 claude 被三元组验证后收敛；server_indeterminate 期间绝不触碰。
8. 字节兼容锚：TmuxAdapter 既有套件（~110 it）、server-loss 既有用例、fly241-lead-model-override、claude-lead-manifest-preserve、launch-plan sentinel、现有 5 个 restart-*.test.sh 全绿。
