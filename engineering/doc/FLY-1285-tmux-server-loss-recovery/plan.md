# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 实施计划

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: research.md

**Status**: draft（codex design review Round 3 中；R1 十项 + R2 八项已全量吸收）
**裁决来源**: brainstorm gate 已过（Tadashi 批 A/B/C 全量 + 四点裁决：PR-0 最先单独出 / runbook 附 research / B 加真机验收 / C 批准）。

## 核心安全原则（贯穿全计划）

1. **破坏性动作只接受正向证明**：创建 server、埋葬 session、清理旧 claude 的前置必须是"完整扫描证明"；`unknown` / `ambiguous` / `saturated` / `rescue_failed` / helper 缺失 / ps·lsof 失败一律 hold/backoff，绝不 fail-open。与 probeTmuxServer 三态约定（tmux-lookup.ts:259-279）同构。
2. **诊断→决策→动作原子**：每 socket 一把跨进程锁，受保护动作（SIGUSR1 / create）只在锁内、且紧跟锁内 re-inspect 之后执行。
3. **hold 可持久、可解除、有界升级、告警一次**：Bridge 侧 hold 落 StateStore；launch-hold / wait-hold / Bridge durable hold 共享同一 episode 语义——超阈值（默认 10min，env 可调）告警**恰一次**，收敛时 resolve；绝不无声挂死、绝不刷屏。
4. **代码合入 ≠ 行为激活**：auto-SIGUSR1 受 feature gate（`FLYWHEEL_TMUX_AUTO_RESCUE`，默认 0=hold-only），只有全部 creator 都受 guard 的部署批次完成后才开启（§4）。

## 0. 总览与 PR 切分

| PR | 内容 | 目标文件 | 生效方式 | 依赖 |
|---|---|---|---|---|
| PR-0 | 健康窗可配置（FLY-1290 载体，**最先单独出、独立小分支**） | scripts/restart-services.sh、scripts/lib/health-window.sh（新）+ 测试 | 下次跑 restart-services.sh 即生效 | 无 |
| PR-1 | inspect/rescue 库（guarded-exec + 锁）+ supervisor 三态等待 + Fix C 互斥 + Fix B model/effort SSOT + tmux_hold 告警 kind（shell 侧） | scripts/lib/tmux-server-rescue.sh（新）、packages/teamlead/scripts/claude-lead.sh、scripts/lead-alert.sh（kind allowlist）+ 测试 | **supervisor 进程重启**才生效（运行中 bash 不重读磁盘脚本）；auto-rescue 默认 gate-off | 无（与 PR-0 并行可） |
| PR-2 | Bridge/Runner 侧：ensureRunnerSession async 守卫 + ServerLossCoordinator 穷举裁决 + durable hold 贯通 reaper + tmux_split_brain/tmux_hold 告警契约（TS 侧）+ CLI sync | packages/claude-runner/src/TmuxAdapter.ts、packages/teamlead/src/bridge/{server-loss.ts,plugin.ts,sync-flywheel-hooks.ts,kind-contract.ts,ticket-owner-map.ts}、packages/teamlead/src/{HeartbeatService.ts,StateStore.ts,LeadAlertNotifier.ts} + 各自测试 | 需 Bridge 重启（与 PR-1 激活同批，§4） | PR-1 |

三阶段管线注：本分支（flywheel-FLY-1285）为共享分支；PR-0 从 main 直接开小分支速出（Tadashi 裁决），PR-1/PR-2 在本分支交付（是否再拆按 implement 时 diff 体量与 Lead 意见定）。docs 随本分支 PR 合入。

## 1. PR-0 — restart-services.sh 健康窗可配置

### 改动
1. 新极小可 source 单元 `scripts/lib/health-window.sh`：`resolve_health_window_sec`（读 `FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC`）+ `health_window_rounds`（ceil(sec/2)，sleep 2 不变，时间预算不缩水）。restart-services.sh 在 **`.env` source 之后**（:32-95 装载完成后）调用解析。
2. 解析规则：未设/空 → 默认 **240**（实测冷启动 ~110s ×2 余量）；非法（非正整数）→ **回默认 240** + warning；合法但 <30 → clamp 30 + warning；合法 ≥30 → 原值。
3. 两处 60s 硬窗（deploy :1288-1301、bridge-only ~:1380-1395）都改为消费同一 `health_window_rounds`；文案（:1362 dry-run、:1392 severe 告警）引用实际配置值。
4. abnormal-exit 面包屑砍出 PR-0（follow-up 票）。

### 测试
- 新 `scripts/__tests__/restart-health-window.test.sh`：source `scripts/lib/health-window.sh` 驱动**真实解析单元**：未设→240→120 轮；`=40`→20 轮；`=41`→21 轮（ceil）；`=5`→clamp 30+警告；`=abc`/`=-1`/`=0`→240+警告；`=60`→30 轮（旧行为等价哨兵）。
- **两条生产路径各自的静态断言（R2 #8）**：分别对 deploy 与 bridge-only 循环段做文本断言——都消费 `health_window_rounds`、全文不再残留 `seq 1 30` / 写死 "60s" 的健康窗文案（各一条独立断言，防单侧漏改）。
- 现有 5 个 `scripts/__tests__/restart-*.test.sh` 全绿。

### 验收
- 打桩 /health 第 90s 才 ok：`=60` 判失败、默认 240 判成功，两侧断言。

## 2. PR-1 — inspect/rescue 库 + supervisor 接入 + Fix B + Fix C

### 2.1 新库 `scripts/lib/tmux-server-rescue.sh`

**(a) inspect**：`tmux_socket_inspect <socket_path>` → stdout 单行 JSON（诊断走 stderr）：

```json
{"verdict":"reachable|missing_single_orphan|saturated|dead|split_brain|ambiguous|unknown",
 "socketPresent":true,"socketPath":"/private/tmp/tmux-501/default",
 "reachablePid":93009,"candidatePids":[3738],"scanComplete":true}
```

- 路径归一：输入与 lsof 输出都归一到 `/private/tmp` 形态。
- 判定：可达性 `tmux -S <path> display-message -p ok`（portable 有界等待 ≤3s，无 GNU timeout 假设）；候选扫描 = 同 uid、ppid==1 的 tmux 进程 × lsof 引用该路径；ps/lsof 失败 → scanComplete:false → unknown。组合：可达+零其它候选→reachable；可达+有候选→split_brain；不可达+socket 缺+恰一候选→missing_single_orphan；不可达+socket 缺+候选>1→ambiguous（绝不自动选最老）;不可达+socket 在+≥1 候选→saturated；不可达+scanComplete+零候选→dead；其余→unknown。

**(b) guarded exec（R2 #1 修正——语义是"确保目标存在"，不是"server 存在"）**：`tmux_socket_ensure <socket_path> -- <cmd...>`，传入命令**必须显式带同一 `-S <归一化路径>`**（库校验：cmd 不含 -S 或路径不一致 → 直接报错拒执行，防 override 测试打到 default）。锁内流程：

1. 取锁（见 (d)）→ 锁内 re-inspect。
2. `reachable` → **锁内执行 cmd**（对 new-session -Ad 即幂等 attach/建 session；对 TmuxAdapter 的 create 即真建）。
3. `missing_single_orphan` 且 gate 开 → SIGUSR1（发前对该 PID 即时 ps/lsof 重验）→ 锁内等 socket 重现 → **完整 re-inspect 必须证明 reachablePid == 被 signal 的候选、scanComplete、无其它候选**才算 rescued → 锁内执行 cmd；任一不满足 → 返回 hold（split/ambiguous/unknown 对应码）。gate 关 → 返回 hold。
4. `dead`（scanComplete 前提）→ 锁内执行 cmd。
5. `saturated`/`ambiguous`/`split_brain`/`unknown` → hold，不建不发信号。
6. cmd 失败 → 锁内重查目标（session/window 是否已被并发方建出）：已存在 → 视为成功（并发 duplicate）；否则真失败上抛。
- 输出结构化 JSON `{"action":"executed|rescued_then_executed|hold_saturated|hold_ambiguous|hold_split_brain|hold_unknown","createStdout":"..."}`——**保留 cmd stdout**（TmuxAdapter 依赖 `-P -F '#{window_id}'` 输出做 scaffold rename）。退出码：0=executed 类；2/3/4=对应 hold。

**(c) feature gate**：`FLYWHEEL_TMUX_AUTO_RESCUE`（默认 0）：关 → 步骤 3 永远 hold（inspect/hold/锁语义照常，SIGUSR1 与 rescue-then-create 被禁）；开 → 全流程。hold-only 模式本身安全可先行（只阻止破坏性动作）。

**(d) 锁（R2 #3 加固）**：锁目录放 `~/.flywheel/locks/tmux-<规范化路径的稳定 key（sha256 前 16 位）>.lock`（父目录预先可建、权限可验，不依赖 tmux-<uid> 目录存在——冷启动可用）。`mkdir` 原子取锁后写 owner 文件 = `pid + ps lstart 序列化 + 随机 token`；owner 缺失/半写 → **等待/hold，绝不回收**；只有 owner 完整且 pid+start-identity 证明已死才回收；释放校验 token；shell `trap` 兜底清锁。取锁有界等待（默认 5s）→ 超时按 unknown hold。

- dry-run env `FLY1285_RESCUE_DRY_RUN=1`；风格随 reap-orphan-adapters.sh；shellcheck。

### 2.2 claude-lead.sh 接入（Fix A 前半）

**(a) `_tmux()` 包装**：`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 非空时对所有 tmux 调用注入 `-S`；`ensure_tmux_session` 经 guarded exec 传入的命令同样由包装生成（保证 -S 一致性，R2 #1 尾）。默认空=现行为逐字节不变。

**(b) `ensure_tmux_session`** → `tmux_socket_ensure <path> -- _tmux new-session -Ad -s flywheel -x 200 -y 50` 的展开形态；hold → 返回非零 + `ENSURE_HOLD_KIND`。

**(c) main loop set -e 修正**：两处裸调用（:2392/:2423）改 `if !` 包裹；ensure 失败 → return 1（不写 session file、不起 poller、不进 wait）；`LAUNCH_OUTCOME=hold` → 独立 hold backoff 计数（不进 crash count / resume-failure）→ 连续 hold 超阈值（默认 10min，`FLYWHEEL_TMUX_HOLD_ESCALATE_SEC`）→ 经 lead-alert.sh 发 **`tmux_hold`**（新 kind，见 §3.3）恰一次（episode 语义），继续 hold。

**(d) `_wait_tmux_window` 三态化 + 身份绑定（R2 #2 修正）**：
- launch 成功即写**身份档案**（也是 Fix C 档案，四元组）：`serverPid（锁内 inspect 的 reachablePid）+ panePid（#{pane_pid}）+ pane start-identity（ps lstart）+ windowId`。
- `list-panes` 成功 + pane_dead=1 → proven_dead（现路径）。
- `list-panes` 成功 + 在 → alive。
- `list-panes` 失败 → server_indeterminate → inspect：
  - `reachable` → **不直接判死**：做 target 级二次探测——先验 server 世代（当前 reachablePid == 档案 serverPid），再对 windowId 做明确 absence 探测（stderr 匹配 can't find window/session/pane 类硬证据；timeout/EACCES 等 → 维持 indeterminate 继续等）。世代不符（server 换代）→ 档案 windowId 不可信，**绝不对同号 window 发键/kill**；此时若档案 panePid 仍活（按 pane start-identity 验证）→ 维持等待（旧 claude 或仍活在孤儿 server 上）；panePid 确死 → proven_window_gone。
  - `missing_single_orphan` → 经 guarded rescue（gate 开才发信号）→ rescued 后验证恢复的正是档案 serverPid → 重查 windowId：在 → 回等待循环（不 reap 不 relaunch 不二次 resume）；确不在（硬证据）→ proven_window_gone。
  - `saturated`/`ambiguous`/`split_brain`/`unknown` → 停留等待循环（周期性降噪日志 + 超阈值并入 tmux_hold episode 告警）。
- **graceful cleanup() 在 indeterminate 期间的行为（R2 #2 尾）**：不得向可能重号的 window 发 C-c/kill-window，**不删除身份档案**（留给下一代 supervisor rescue/takeover 用）；仅在验明世代一致时才走现有优雅关闭序列。

### 2.3 Fix C — 双实例互斥

- 档案即 2.2d 的四元组文件 `${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.claude.pid`。
- 仅在 proven_dead / proven_window_gone 后的下一次 launch 前执行 `reap_stale_lead_claude`：读档案 → panePid 存活？→ TERM 前重验（command 含 claude + 本 lead 辨识 + start-identity 与档案一致；不符=PID 复用 → 只清档案）→ SIGTERM → ≤10s 轮询 → **KILL 前再重验** → SIGKILL → log。cleanup() 只在非 indeterminate 时清档案。

### 2.4 Fix B — model/effort 每次 launch 现读 manifest

- `_resolve_launch_model_effort`（`_launch_claude` 内，产出本地 LAUNCH_ARGS；全局 CLAUDE_ARGS 不含 --model/--effort）：
  - model：安全 `jq -r`（失败/损坏 → warning + 降级 env，set -e 保护）；manifest 非空(trim)→用之；空→env；仍空→不传。
  - effort：保留 :1636-1676 语义——manifest `.effort` 先过 enum(low|medium|high|xhigh|max)；非法/空 → env 过 enum；仍非法/空 → 维持现状缺省（companion xhigh 回落不动）。
  - **drift 日志真实性（R2 #8）**：`using manifest` 只在 manifest 值**通过校验后实际被采用**时打印；manifest effort 非法回落 env 时打 `invalid manifest effort → using env`——日志必须与最终 argv 一致，测试矩阵覆盖。
- 字节兼容：manifest 无字段 → env → 逐字节同旧；launch-plan sentinel 按 FLY-217 先例 LEGITIMATE RETARGET。
- 测试：扩展 `fly241-lead-model-override.test.sh`（manifest×env×drift×空白×jq 损坏×effort 非法链×日志一致性）；补 `claude-lead-manifest-preserve.test.sh` 的 effort preserve 断言。
- 真机验收（Tadashi 裁决 ③）：QA slot 隔离 lead，manifest.model 改有效备选模型 → 自然 supervisor 重启路径 → 断言新 argv 用 manifest 值、旧值 argv 消失、plist/env 未动、drift 日志一行。

### 2.5 PR-1 测试

- rescue 库：mock 桩覆盖七态 inspect（归一化、scanComplete=false→unknown、候选>1→ambiguous、可达+候选→split_brain）、guarded exec（reachable 仍执行 cmd / cmd 失败后锁内重查并发 duplicate / createStdout 透传 / cmd 无 -S 拒执行）、锁（初始化窗口不误回收、token 校验、陈旧回收需完整 owner+已死证明、超时→hold）、gate 关→拒 SIGUSR1、rescue postcondition（reachablePid==被 signal 者才算 rescued）。
- 真 tmux 隔离段：E1 saturated→hold；E2 missing_single_orphan→rescued；E3 场景 inspect 判 split_brain + 守卫拒 SIGUSR1；**"server reachable 但目标 session 不存在"→cmd 执行建出**；**override socket 旁放 default decoy**→全程 default 无扰动。
- **并发赛跑 fixture**：rescue×create 两进程赛跑，终态断言 = `verdict=reachable + candidatePids=[] + reachablePid 为预期世代`（不只看 inode）。
- supervisor：seam 测试驱动真 main loop（hold 不进 crash/resume 计数、无 session file 写入、退避序列、告警恰一次）；三态 wait（含 **"新 server 同号 window"不误判/不误杀**、**indeterminate 期间 SIGTERM**→不发键不删档案两个新例）；Fix C 双重验证；Fix B 矩阵。
- E1/E2 真机验收断言：旧 Lead PID 全程存活、session file 未改写、无第二次 --resume。

## 3. PR-2 — Bridge/Runner 侧接入

### 3.1 TmuxAdapter.ensureRunnerSession（R2 #5 修正：async 非阻塞）

- 新增 **async guarded-exec 依赖 seam**（仅此新路径 async；TmuxAdapter 其余同步命令面不动）：非阻塞 `execFile`(Promise) 调 `~/.flywheel/bin` 的 rescue CLI + timer backoff；`execute()`（:219-237）在调 ensure 处显式 `await`。**绝不 sleep/execFileSync 重试**——Bridge event loop（run-infra.ts 直接实例化 adapter）在等待期间照常服务。
- 预算：deadline 制（默认 90s，env 可调，含每次 helper/锁耗时）；到期或 CLI 缺失 → 抛 `tmux_saturated` 类 typed error → 既有失败面（Blueprint success:false → DagDispatcher shelve）——诚实封顶 + 响亮日志；端到端 retryable dispatch 为 follow-up 票。
- 主 create 与 fallback create（:1191-1212）都走守卫；guarded exec 的 createStdout 透传保 `-P -F '#{window_id}'` 语义。
- 测试：fake timers/短预算证明等待期 event loop 可运行；Claude/Codex/Antigravity/Kimi 四个 adapter 继承路径都过（它们共享 ensureRunnerSession seam）；既有 ~110 it 用例全绿（claude 路径字节兼容锚）。

### 3.2 ServerLossCoordinator + HeartbeatService + StateStore（R2 #4 修正：穷举 + 收敛对账）

**durable hold**：StateStore `tmux_hold` 记录 = `{kind: saturated|split_brain|ambiguous|unknown|missing_orphan_rescue_failed, evidence(JSON：双方 PID、socketPath), affectedExecutionIds[], originalShape(server_down|server_fresh), created_at, last_checked_at}`——kind 面覆盖全部 hold 原因；受影响 execution ids 与原检测形状随 hold 落库（收敛对账要用）。

**穷举裁决表（七 verdict 全列，implement 照抄）**：

- tick leg（probe=down 时 inspect）：
  | verdict | 动作 |
  |---|---|
  | reachable | 本 tick 零埋葬，下 tick 重探（probe 与 inspect 打架=瞬态） |
  | missing_single_orphan | gate 开→锁内 rescue；成功→零埋葬+log-only `socket_lost_rescued`；失败/gate 关→hold |
  | saturated / ambiguous / unknown | durable hold + holdTmux=true |
  | split_brain | durable hold + `tmux_split_brain` ticket + holdTmux=true |
  | dead（scanComplete） | 现行 server_down 埋葬路径不变 |
- boot leg（probe=up + wasFirst + targetGone 全 true 时 inspect）：
  | verdict | 动作 |
  |---|---|
  | **reachable（scanComplete + 零候选）** | **正向证明"单 server 正常换代"→ 现行 server_fresh 成组迁移**（R2 #4：这才是放行条件） |
  | split_brain / ambiguous | durable hold + ticket（split_brain）+ 零迁移 |
  | missing_single_orphan | gate 开→rescue→成功零迁移；失败→hold |
  | saturated / unknown | durable hold + 零迁移 |
  | dead | 与 probe=up 矛盾 → 按 unknown hold（防御） |
- active-hold（存在 tmux_hold 时每 tick）：重新 inspect——未收敛 → 刷新 last_checked_at 继续 hold；**收敛（reachable+scanComplete+零候选）→ 同一 tick 内重验 affectedExecutionIds 的 target**：仍在 → 安全清 hold（+resolve ticket）；全部 gone → **先原子 arm server-loss episode（复用既有 grouped migration/通知/ticket 机制，shape 取 hold 的 originalShape）再清 hold**——保证 firstCheck 已消费后仍走成组对账而非 per-runner reaper（R2 #4 核心）；split ticket 只在该 reconcile transition 完成后 resolve。

**HeartbeatService 贯通（抑制按 claimed ids，不用全局布尔）**：`check()` 返回 `{claimed, heldExecutionIds}`；`reapCrashedRunners()`/`checkStuck()`/`reapOrphans()` 对 `claimed ∪ heldExecutionIds` 内的 session 跳过破坏性动作（非 tmux session 与无关 session 照常处理）；crash-reaper suppression（:1719-1733）加入同一判据。helper 缺失/异常 → 本 tick 对全部 tmux-backed running session 按 held 处理（fail-closed）+ 日志。

- scope/测试：HeartbeatService.ts、StateStore.ts（+__tests__）、server-loss.test.ts 扩展（每张表逐行用例 + hold 持久/重启幸存/收敛两分支（target 在/全 gone→episode arm）/ticket resolve 时机 + 既有用例全绿）。

### 3.3 告警契约（R2 #6 修正：设计期全定死）

- **`tmux_split_brain`**（Bridge 侧新 kind）：`owner: "founder_direct"` + `arc: "human_by_design"`（owner 枚举=claude|codex|cross_by_provider|founder_direct，human_by_design 是 arc 字段——kind-contract.ts:46-56）；同步把该 kind 加入 ticket-owner-map.ts:67-75 的 no-owner 面。severity: severe；dedupe = 归一化 socketPath + 排序 PID 集；resolve = active-hold 收敛对账完成后 coordinator resolveTicket；metadata = `{socketPath, reachablePid, orphanPids, casualtiesHeld}`。ALERT_EVENT_TYPES / KIND_CONTRACTS / router / Hub / dedupe 的 exhaustive 测试全部随更（漏一处 typecheck/启动失败——列入验收）。
- **`tmux_hold`**（supervisor + Bridge 共用的持久 hold 升级 kind，**不复用 crash_loop**——避免污染其每日 dedupe/文案/恢复语义）：owner: "claude"（infra-bot 可先行诊断）+ arc 按既有自动化 arc 面选择（implement 依 kind-contract 枚举落位，语义=可自动诊断、收敛自动 resolve）；severity: severe；dedupe = lead/socket + episode；升级阈值 10min；resolve = hold 清除。shell 侧 lead-alert.sh 的 kind allowlist（PR-1）与 TS union（PR-2）同步加入。launch-hold / wait-hold / Bridge durable hold 共享 episode timer 与"告警一次"语义。
- **`socket_lost_rescued`**：log-only，无告警 kind。

### 3.4 PR-2 真机段（QA）

- 隔离 socket 重演 server_fresh 假埋：零埋葬、split_brain ticket 恰一、hold 落库、Bridge 重启 hold 幸存、人工收敛后（a）target 仍在→hold 清除+ticket resolve、（b）target 全 gone→成组 episode 对账后才清——两分支都验。

## 4. 部署与激活顺序（R2 #7 修正：合入与激活分离）

1. PR-0 独立 merge（无重启面）。
2. PR-1、PR-2 代码先后 merge；`FLYWHEEL_TMUX_AUTO_RESCUE` 默认 0——期间全 fleet 为 hold-only（安全增益即刻可有：不误顶替、不误埋，但不自动救）。
3. **同一批量重启窗**完成激活，顺序：先 Bridge 重启（PR-2 生效：CLI sync 落位并验证、所有 Runner creator 受 guard）→ 再 supervisor 批量重启（PR-1 生效）→ 最后置 `FLYWHEEL_TMUX_AUTO_RESCUE=1`（~/.flywheel/.env）。QA 过渡用例：gate=0 时任何路径拒发 SIGUSR1。
4. 活体 split-brain 收敛（research §4 runbook）由 Tadashi/founder 择机执行，建议在激活批次前完成。
5. Follow-up 票：abnormal-exit 面包屑；Blueprint/DagDispatcher 端到端 retryable dispatch；tmux arm64 原生 build + 探测洪峰减载。

## 5. 风险与缓解

- **hold 卡住合法创建**：hold 有界升级（supervisor 10min 告警一次；TmuxAdapter 90s deadline 降级 shelve；Bridge hold 只停破坏性动作、按 held ids 精准抑制）；dead 正向证明下 create 放行——冷启动零候选+扫描完整即通过；锁移到 ~/.flywheel/locks 不依赖 tmux 目录存在。
- **锁异常**：owner 三元组+token、半写不回收、超时→hold、trap 清理；持锁段毫秒~3s 级。
- **SIGUSR1 打错/救错**：gate 默认关；三前置+signal 前即时重验+signal 后身份 postcondition（reachablePid==被 signal 者）。
- **event loop 阻塞**：guarded exec 为 async seam + deadline，fake-timer 测试证明等待期可服务。
- **supervisor 主循环改动**：全部显式 if 包裹 + seam 测试驱动真代码；世代绑定防同号 window 误杀。
- **契约面遗漏**：KIND_CONTRACTS/router/owner-map/sync allowlist 均 exhaustive 测试，验收逐项打勾。

## 6. 验收清单（QA 阶段照单执行）

1. PR-0：解析矩阵 + `=60` vs 240 慢启动对照 + 两条生产循环的独立静态断言。
2. E1 重演（隔离 -S + default decoy）：hold 不顶替、独立退避、tmux_hold 告警恰一次、恢复自动接续；旧 Lead PID 存活、session file 未改写、无二次 --resume。
3. E2 重演：rescue 后窗口找回→回等待零动作；或硬证据判死→正常重启。
4. 并发赛跑：终态 verdict=reachable+candidatePids=[]+预期世代。
5. 同号 window 陷阱：server 换代后不向新 server 同号 window 发键/kill；indeterminate 期 SIGTERM 不删档案。
6. split-brain（Bridge）：零埋葬、ticket 恰一、hold 持久+重启幸存、收敛两分支（在→清；gone→先成组 episode 再清）+ resolve 时机。
7. B 真机：staged manifest 改有效备选 model → supervisor 重启生效、plist/env 未动、drift 日志与 argv 一致（Tadashi 裁决 ③）。
8. C 真机：proven 判死后四元组验证收敛旧 claude；indeterminate 绝不触碰。
9. 激活过渡：gate=0 全路径拒 SIGUSR1；激活顺序 Bridge→supervisor→gate=1。
10. 字节兼容锚：TmuxAdapter 既有套件（~110 it）、server-loss 既有用例、fly241-lead-model-override、claude-lead-manifest-preserve、launch-plan sentinel、5 个 restart-*.test.sh 全绿。
