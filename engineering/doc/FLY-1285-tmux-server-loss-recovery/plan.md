# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 实施计划

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: research.md

**Status**: draft（待 codex design review）
**裁决来源**: brainstorm gate 已过（Tadashi 批 A/B/C 全量 + 四点裁决：PR-0 最先单独出 / runbook 附 research / B 加真机验收 / C 批准）。

## 0. 总览与 PR 切分

| PR | 内容 | 目标文件 | 生效方式 | 依赖 |
|---|---|---|---|---|
| PR-0 | 健康窗可配置（FLY-1290 载体，**最先单独出、独立小分支**） | scripts/restart-services.sh + 测试 | 下次跑 restart-services.sh 即生效（脚本现读） | 无 |
| PR-1 | tmux rescue 库 + supervisor 侧接入（Fix A 前半）+ Fix C 互斥 + Fix B model/effort SSOT | scripts/lib/tmux-server-rescue.sh（新）、packages/teamlead/scripts/claude-lead.sh + 测试 | Lead 下次 relaunch/重启生效（脚本现读） | 无（与 PR-0 并行可） |
| PR-2 | Bridge/Runner 侧接入（Fix A 后半）：ensureRunnerSession 前置分类 + ServerLossCoordinator 宣判前 rescue | packages/claude-runner/src/TmuxAdapter.ts、packages/teamlead/src/bridge/{server-loss.ts,plugin.ts} + 测试 | 需 Bridge 重启（攒批，遵守 batched-restart 纪律） | PR-1（复用同一 helper 与 fixture 规格） |

三阶段管线注：本分支（flywheel-FLY-1285）为共享分支；implement 阶段按上表拆 PR 时，PR-0 从 main 直接开小分支速出（Tadashi 裁决），PR-1/PR-2 在本分支交付（是否再拆按 implement 时 diff 体量与 Lead 意见定，拆分不改变下述内容规格）。docs（exploration/research/plan/progress）随本分支 PR 合入。

## 1. PR-0 — restart-services.sh 健康窗可配置

### 改动
1. 顶部配置区新增（跟随现有 env 读取风格）：
   - `FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC`（默认 **240**；来源：7/14 17:15 实测冷启动 ~110s × 2 余量）。
   - 解析护栏：非数字或 <30 → 按 30 处理并 log 警告（防误配置把窗口打穿）。
2. 两处 60s 硬窗改为共用推导：`hc_rounds = timeout_sec / 2`（sleep 2 保持不变）：
   - deploy 路径 `deploy_and_verify`（现 :1288-1301 `seq 1 30`）。
   - bridge-only 路径（现 ~:1380-1395 同款）。
3. 文案同步：bridge-only 的 dry-run 描述（现 :1362 写死 "health-check up to 60s"）与超时 severe 告警正文（现 :1392 "60s 内未通过"）改为引用实际配置值。
4. 附带（research §3 建议，micro）：abnormal-exit 路径可归因面包屑——`stop_bridge`/启动侧在日志打一行 last-exit 状态（若 launchctl print 可得），**只 log 不加告警面**；如 implement 评估侵入超过 ~10 行则砍掉此项（PR-0 保持极小）。

### 测试
- 新 `scripts/__tests__/restart-health-window.test.sh`（模式仿 restart-stabilization.test.sh：source 函数/驱动脚本打桩 curl）：
  a. 默认值 240 生效（未设 env 时推导 120 轮）。
  b. env 覆盖生效（如 8s → 4 轮）。
  c. 护栏：`FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC=5`、`=abc` → 按 30 处理 + 警告行。
  d. 反向兼容哨兵：设 `=60` 时行为与旧版逐字节等价（轮数 30、文案含 60）。
- 全仓 lint（biome/shellcheck 按现状适用面）。

### 验收
- 打桩 curl 令 /health 在第 90s 才 ok：旧版判失败回滚、新版（默认 240）判成功——两侧都断言。

## 2. PR-1 — rescue 库 + supervisor 接入 + Fix B + Fix C

### 2.1 新库 `scripts/lib/tmux-server-rescue.sh`

接口（供 shell source；行为规格 = research §1 三分类表，fixture 用例与 PR-2 共享）：
- `tmux_socket_classify <socket_path>` → stdout 一行：`missing_orphan <pid>` / `saturated <pid>` / `dead` / `reachable`。
  - 判据：`stat` socket 文件存在性；可达性用 `tmux -S <socket_path> display-message -p ok`（带 ~3s timeout，成功即 `reachable`）；孤儿扫描 = 同 uid 且 **ppid==1** 的 tmux 进程（`ps -axo pid,ppid,comm`）中 `lsof -p <pid>` 引用 `<socket_path>` 者、且非当前可达 server。多孤儿命中 → 取最老（lstart 最早）并全部列出到日志。
  - 超时/异常 → `unknown`（调用方 fail-open 到旧行为，见 2.2）。
- `tmux_socket_rescue <socket_path>` → 仅当 classify=missing_orphan：对孤儿 PID 发 SIGUSR1 → 有界等（≤3s 轮询 stat+可达性）→ 成功输出 `rescued <pid>` / 失败 `rescue_failed <pid>`。classify=saturated → 输出 `backoff`（**不建、不发信号**）。classify=dead → `create_allowed`。classify=reachable → `noop`。
  - **铁律护栏**：若可达 server 已存在（classify=reachable/或 rescue 中途发现路径已被占）→ 绝不 SIGUSR1（E3 反向抢占实证）。
- 风格/测试跟随 `packages/teamlead/scripts/lib/reap-orphan-adapters.sh` 先例（errexit 保护、dry-run env `FLY1285_RESCUE_DRY_RUN=1`、shellcheck、独立可执行自测段）。

### 2.2 claude-lead.sh `ensure_tmux_session` 接入（Fix A 前半）

现状（:1042-1045）：`tmux new-session -Ad -s flywheel -x 200 -y 50 || true`。
改为：
```
classify(default socket) →
  reachable   → 原样 new-session -Ad（幂等 attach 语义不变）
  missing_orphan → rescue；rescued → new-session -Ad（此时必 attach 不 create）；rescue_failed → 响亮 log + 按 dead 处理
  saturated   → log 警告 + return 1（调用链：_launch_claude 失败 → 供给循环 backoff 重试；绝不顶替 socket）
  dead / unknown → 原样 new-session -Ad（unknown fail-open 保旧行为）
```
- socket 路径推导：`${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default`（与 tmux 默认一致；claude-lead.sh 未设 -L/-S）。
- `_launch_claude` 对 ensure 失败的传播：ensure 返回非零 → `_launch_claude` 直接 return 1 → 主循环按 crash 计数走既有指数退避（5/15/30/60…s）——饱和期自然退避，正对 E1 病灶。

### 2.3 Fix C — 双实例互斥（claude-lead.sh）

- `_launch_claude` 成功后：`CLAUDE_PANE_PID=$(tmux display-message -p -t "$LEAD_WINDOW_ID" '#{pane_pid}')` → 写 `${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.claude.pid`。
- 主循环 crash 检测后、下一轮 `_launch_claude` 前插入 `reap_stale_lead_claude`：
  - 读 claude.pid；无文件/进程不存活 → 清文件返回。
  - 存活 → `ps -o command= -p <pid>` 必须同时含 `claude` 与本 lead 辨识（`--agent ${LEAD_ID}` 或 append-system-prompt 路径含 lead-id；两者都无 → 视为 PID 复用，只清文件不动进程）。
  - 验明 → SIGTERM → ≤10s 轮询 → 仍活 SIGKILL → log 一行 `reaped stale lead claude pid=…`。
- `cleanup()`（graceful 路径）同步 rm claude.pid。

### 2.4 Fix B — model/effort 启动时读 manifest（claude-lead.sh）

- 现状 :1617-1633：`_fly241_lead_model="${FLYWHEEL_LEAD_MODEL:-}"` → CLAUDE_ARGS 构建。CLAUDE_ARGS 在 supervisor 启动时构建一次、循环重放。
- 改动：把 model/effort 的解析**移进 `_launch_claude`**（每次拉起现算）：
  - `_m=$(jq -r '.model // ""' "$MANIFEST_FILE")`；空/空白 → 回落 `FLYWHEEL_LEAD_MODEL`；仍空 → 不传 `--model`。effort 同构（`.effort` ↔ `FLYWHEEL_LEAD_EFFORT`）。
  - 两源都非空且不同 → log `model drift: env=<env> manifest=<manifest> → using manifest`。
  - CLAUDE_ARGS 中不再预置 --model/--effort；`_launch_claude` 在 `claude "$@"` 前追加解析结果（launch-plan dry-run 的 ARG 输出随之如实变化）。
- 字节兼容承诺：manifest 无 model/effort 字段（历史/手工 lead）→ 走 env → 逐字节同旧。FLY-231 dry-run sentinel 若有写死 "--model 顺序/位置" 的断言，按 FLY-217 先例做 LEGITIMATE RETARGET 并在 PR 描述标注。
- 注意 wrapper 不改（它本就不读 model；manifest 路径经既有 `MANIFEST_FILE` 推导，QA slot 的 HOME 隔离自然生效）。

### 2.5 PR-1 测试

- 新 `packages/teamlead/scripts/__tests__/tmux-server-rescue.test.sh`：mock ps/lsof/tmux 桩（同 reap-orphan-adapters 测试形态）覆盖四态 classify、rescue 的 SIGUSR1 幂等与铁律护栏、saturated 不建、unknown fail-open。
- 真 tmux 集成段（隔离 -L socket，复用 research 实验脚本的三个场景做自动化 fixture）：missing_orphan→rescued；saturated（SIGSTOP）→backoff；E3 场景断言 rescue 拒绝 SIGUSR1。挂进现有 `tmux-integration.test.sh` 或独立文件。
- Fix B：`lead-env-propagation.test.sh` 旁新增用例——manifest 有/无 model、env 有/无、drift 组合 ×（含空白串）断言最终 argv；dry-run launch-plan 断言。
- Fix C：桩测试——claude.pid 写入/清理、PID 复用防误杀（command 不匹配不动手）、TERM→KILL 升级路径。

### 2.6 PR-1 真机验收（QA 阶段执行，写给 QA runner）

- **B 验收（Tadashi 裁决 ③）**：QA slot 隔离 lead 上，改 manifest.model 为哨兵值 → 触发 supervisor 自然 relaunch（结束 claude 窗口进程走 crash 路径）→ 断言新 claude argv --model=哨兵值、plist 未动、日志有 drift 行。
- **A 验收**：隔离 -L socket 重演 E1/E2 场景驱动 claude-lead.sh 的 ensure（可用测试挂钩注入 socket 路径 env——实现时给 `ensure_tmux_session` 加 `FLYWHEEL_TMUX_SOCKET_OVERRIDE`（仅测试用，默认空=default 路径）以便隔离验证）。
- **C 验收**：人为孤儿化一个假 claude（隔离 slot）→ relaunch → 断言旧进程被收、新进程唯一。

## 3. PR-2 — Bridge/Runner 侧接入（Fix A 后半）

### 3.1 TmuxAdapter.ensureRunnerSession（packages/claude-runner/src/TmuxAdapter.ts:1180-1224）

- `has-session` 失败后、`new-session` 前插入分类调用：经 execFileFn 调 `scripts/lib/tmux-server-rescue.sh`（分发路径按 FLY-142 `syncFlywheelCliBin` 同款进 `~/.flywheel/bin/`，或直接以 `FLYWHEEL_ROOT` 相对路径调用——implement 时二选一，倾向后者=零新分发面）。
- `missing_orphan→rescued` → 重试 has-session（应命中）；`saturated` → throw 带辨识错误（spawn 调用链已有失败面，错误信息含 `tmux_saturated` 供上游退避）；`dead/unknown` → 原样 create。

### 3.2 ServerLossCoordinator 宣判前 rescue（packages/teamlead/src/bridge/server-loss.ts + plugin.ts 接线）

- 新 dep `classifySocket: () => Promise<"reachable"|"missing_orphan"|"saturated"|"dead"|"unknown">`（plugin.ts 里同样经 helper 实现）+ `rescueSocket: () => Promise<boolean>`。
- `check()` 两处修改（保持 episode 账本语义不变）：
  1. tick leg：`probe === "down"` 判死前 → classify；`missing_orphan` → rescue → 成功则本 tick 视 probe 为 `unknown`（既有语义：suppress reapers、bury nothing）+ 发一条 informational alert `socket_lost_rescued`（severity: warning，走既有 routedAlertSink）；`saturated` → 同样按 `unknown` 处理 + 每 episode 一条 warning（防刷屏：以既有 dedupe/claims 机制签名 `tmux-saturated:<day>`）。
  2. boot leg（server_fresh）：targetGone 全灭成立后、埋葬前 → 孤儿扫描；命中孤儿 server（≠当前可达 server）→ **不迁移**，发 `tmux_split_brain` needs_human ticket（列两个 server PID + 各自归属推断），episode 不建（留待人工收敛后自然对账）。无孤儿 → 维持现状埋葬（真死路径不变）。
- `unknown` classify → 全部 fail-open 到现行为（宁可保守埋葬也不因 helper 故障瘫痪 reaper——但 helper 故障要 log）。

### 3.3 PR-2 测试

- server-loss.test.ts 扩展：missing_orphan rescue 成功→零迁移+informational；saturated→零迁移+每 episode 一条；boot leg 孤儿命中→split_brain ticket+零迁移；孤儿未命中→原路径回归（既有用例全绿=字节兼容锚）。
- TmuxAdapter 测试：79 测保持全绿（claude 路径字节兼容锚）+ 新增分类分支桩测。
- 真机段（QA）：隔离 socket 重演 server_fresh 假埋场景，断言新 Bridge 不埋活人、发 split_brain ticket。

## 4. 运维与部署顺序

1. PR-0 先行独立 merge（无重启面，下次 restart-services 即用新窗）。
2. PR-1 merge → Lead 侧生效于各 supervisor 下次 relaunch/fleet 重启（无需即刻重启；随下一次批量重启窗自然生效）。
3. PR-2 merge → 需 Bridge 重启，**攒进既有批量重启窗**（feedback：多 PR 攒一次重启）。
4. 活体 split-brain 收敛（research §4 runbook）：独立于代码交付，由 Tadashi/founder 择机执行；建议在 PR-1/2 部署重启**之前**做，避免重启动作再叠加双实例噪音。
5. 运维建议（不阻塞）：tmux 换 arm64 原生 build；探测洪峰减载另开 follow-up 票。

## 5. 风险与缓解

- **helper 误判 saturated 造成拒绝创建**：unknown/异常一律 fail-open；saturated 判定要求「socket 存在 + connect 失败 + 活 server 进程」三条同时成立；且 supervisor 侧只 backoff 不永拒（指数退避后重试再分类）。
- **SIGUSR1 打错进程**：只对 ppid==1 且 lsof 证实引用目标 socket 的 tmux 进程发；发前重验（同 FLY-183 R2 HIGH 的 live-recheck 先例）。
- **Fix B 改变 CLAUDE_ARGS 组装顺序**：dry-run launch-plan sentinel 全跑；无 manifest 字段路径逐字节回归。
- **Fix C 误杀**：argv 双条件校验 + 只认自己 lead 的进程；不匹配只清 pid 文件。
- **ServerLossCoordinator 行为面**：所有新分支默认只在 classify 明确命中时偏离旧路径；dep 未注入（测试/旧接线）→ 完全旧行为（可选 dep，默认 undefined）。

## 6. 验收清单（QA 阶段照单执行）

1. PR-0：90s 慢启动打桩下新旧行为对照（研 §2 验收）。
2. E1 重演（隔离 socket）：饱和期 supervisor 不顶替 socket、退避重试、恢复后自动接续。
3. E2 重演：socket 删除 → 下一次 ensure/probe 触发 rescue → 零伤亡、informational alert 一条。
4. split-brain 场景：Bridge boot 遇孤儿 server → 不埋人、split_brain ticket。
5. B 真机：staged manifest 改 model → 自然 relaunch 后新 argv 生效（Tadashi 裁决 ③）。
6. C 真机：孤儿旧 claude 被收敛、无双实例、无双 resume。
7. 字节兼容锚：TmuxAdapter 79 测、server-loss 既有用例、launch-plan sentinel、restart-* 既有 7 测全绿。
