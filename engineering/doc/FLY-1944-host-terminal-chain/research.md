# FLY-1944 宿主终端链收口 — 调研

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21
基于: exploration.md

> 方法:四路并行代码审计(watcher / TUI 锁 / tmux 路径与 brew 面 / playwright)+ 本 runner 宿主只读实测。所有断言带 文件:行号 或标注 [实测 2026-08-21]。

## 0. 会过期的结论表(续接者先读)

| 结论 | as-of | 重核命令 |
|---|---|---|
| Intel brew tmux 3.5a linked / ARM 3.7c unlinked | 2026-08-21 | `ls /usr/local/Cellar/tmux /opt/homebrew/Cellar/tmux; which -a tmux` |
| Intel 侧可升 3.7c(bottle 556KB + 6 依赖) | 2026-08-21 | `HOMEBREW_NO_AUTO_UPDATE=1 /usr/local/bin/brew upgrade --dry-run tmux` |
| runner pane 继承 `FLYWHEEL_LEAD_ID`、有 `FLYWHEEL_EXEC_ID` | 2026-08-21 本 runner env | 在任一 runner pane `env \| grep -E "FLYWHEEL_(LEAD|EXEC)_ID"` |
| runner shell `proc_translated=1`(Rosetta) | 2026-08-21 | `sysctl -n sysctl.proc_translated` |
| `~/.claude/settings.json` playwright=true、无 HEADLESS env、无 receipt | 2026-08-21(转引 FLY-1867 plan.md:49 + 审计复核) | `python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print(d.get('enabledPlugins',{}).get('playwright@claude-plugins-official'),d.get('env',{}).get('PLAYWRIGHT_MCP_HEADLESS'))"` |
| 生产 Bridge buildSha=f4d789396=main HEAD;dist 与 src 的 ensure 日志模板一致(无 `/2` 分母) | 2026-08-21 | `curl -s localhost:9876/health \| jq .buildSha` + grep dist |
| 宿主有两个 `--watch` 进程(79610 持锁,20795 supervised 等待) | 2026-08-21 | `pgrep -fl "flywheel-cmux-sync"; cat /tmp/flywheel-cmux-watcher.lock/owner` |
| 行号引用基于分支 `flywheel-FLY-1944`(fork 自 main f4d789396) | 2026-08-21 | 行号漂移用 `git log -S "<锚文本>"` 重定位 |

## 1. W1:cmux-sync watcher

主体:`scripts/flywheel-cmux-sync.sh`(9837 行)。守护:launchd `com.flywheel.cmux-watcher`,KeepAlive=true,ThrottleInterval=30(`scripts/com.flywheel.cmux-watcher.plist.template:21-23`),入口 `scripts/flywheel-cmux-autostart.sh`(supervised 分支 `exec` 掉自己 :61 → launchd 直管真 watcher)。

### 1.1 主循环与节拍

- `watch_loop()` sync.sh:8523-8592。健康 tick=15s(:8527),睡眠在循环开头(:8532)。退化 backoff:≤1 失败 15s / ≤5→30s / ≤10→60s / >10→300s(`next_sleep_seconds` :366-377)。
- 健康态睡眠是**一整条 `sleep`**(`reopen_aware_sleep` :8476),不可中断;unhealthy 态才按 `FLYWHEEL_CMUX_SOCKET_PROBE_SLICE`(默认 3s,:8480)切片、纯 `stat` 探 socket 提前醒。→ D1d 的 event 切片有现成形态可抄。
- 每 tick:maintenance checkpoint(:8535)→ begin_pass lease 自检(:8544)→ `cmux_health_check_or_die`(:8557)→ reopen 探测(:8563)→ `drain_events`(:8579)→ pending cleanups / close requests(:8580-8582)→ **tick%4==0 时 `sync_additive`**(60s 全量对账,:8583-8585)→ finish_pass(:8590)。

### 1.2 三大卡死路径(均不触发任何现有退出条件)

1. **裸 maintenance marker 永久停车**:`maintenance_requested()` :8897-8901 对三个 marker 任一存在即真(`~/.flywheel/state/cmux-maintenance{,.qa-teardown,.ops-rebuild}`,:101-103);checkpoint 循环 :9560-9600 只 reap 后两个 claim(需死主两次观测),**裸 marker 无人清**;`release_logged` latch(:9568-9569)让"yielding"只打印一次 → 此后完全静默 1s 空转。仓库内**无裸 marker 写入方**(grep 全仓只有读取与拒绝检查)= 运维手工暂停开关,忘删即永久盲。
2. **cmux IPC 全部无 timeout**:`cmux ping` :276、`cmux_call` :388、`cmux_call_guarded` :426、`list-workspaces` :1165、裸 `read-screen` :2265。Electron 半开 socket → 永久阻塞在每 tick 第一个 ping,连 backoff 日志都不会有。仓库已有 `scripts/lib/bounded-run.sh`,但主循环一处未用(仅 autostart.sh:48 的 meta-alert 用了)。
3. **tmux 调用 173 处无 timeout**;`scripts/lib/tmux-server-rescue.sh` 未被 sync.sh source(:157-198 只 source census/lead-address/alert-lib)。

现有退出条件穷举(sync.sh:9484-9501 连续 3 轮失权 fail-loud exit 1;:316-324 cmux 鉴权拒 exit 1;启动期锁占用/畸形/marker 存在 exit 0;SIGINT/TERM)——**没有 stall 检测**。KeepAlive 只救"死了",不救"活着不动"。

### 1.3 日志与心跳

- 日志 `/tmp/flywheel-cmux-watcher.log`(plist:24-25 与 autostart:10,61 双指向);transition-only 设计静默(:303-306、:348-358),**mtime 不能当心跳**。
- 可用副作用心跳及失真前提:`~/.flywheel/state/cmux-roster-episodes`(60s 相位无条件 touch,:783;maintenance 期冻结)/ `/tmp/flywheel-cmux-stale.state`(:7371 每 60s pass 末 touch;**空舰队时提前 return 冻结** :7366-7367)。
- **反向探针**:`/tmp/flywheel-cmux-events`(:46)存在且 mtime 超龄 = drain 死了(健康 watcher ≤15s 清空)。
- lease:目录锁 `/tmp/flywheel-cmux-watcher.lock`,owner 文件 `pid|incarnation|mode|nonce`(:9059-9087 只在获取时写一次,mtime 恒旧);owner 判活 `kill -0` + `ps -o lstart=`(TZ=UTC,:8829-8834);解析器现成:`scripts/lib/restart-cmux-watcher.sh:38-54`。
- [实测] 当前健康:roster-episodes 27s 前刷新;**两个 `--watch` 进程共存**(79610 持锁 + 20795 supervised 等待,:9730-9738 的 FLY-177 语义)→ watchdog kill 目标必须锚定 lease owner。

### 1.4 新窗口镜像延迟

- hook(`after-new-window[500]` per-session :7047-7048;`session-created` global :7063-7064 等)写 event 文件 ≈0 延迟 → **drain 等待 = 最多一个 tick(健康 0-15s,均值 ~7.5s)** → `create_workspace_for_window` 1-4s(:6549-6803,尾部最多 3×sleep1 verify :6796-6801)。
- 兜底:hook 丢失 → 60s additive 补建(:7531-7538);unhealthy → backoff 至 300s;maintenance park → 无上限。
- **没有亚秒路径;pane-died/window-unlinked 只用于清理,create 侧只有 after-new-window。**

### 1.5 fork 开销(D② 依据)

- 静态:`tmux ` 173 处、`cmux_call` 45 处、`python3` 48 处、`get_cmux_workspaces_json` **40 个调用点**(每次 = mktemp+cmux+cat+rm,:1164-1168)。
- 空闲 tick ≈25-30 fork,其中 `mutator_lease_owned_by_self` 每 tick 被调**两次**(:9589 与 :9477)各 ~9 fork(wc/cat/awk/sed/ps 解析一个 4 字段单行文件,纯 bash 可 0 fork)。
- 60s pass ≈ `300 + 40×W + 15×L` fork(W=窗口数,L=Lead 数);10 窗 3 Lead ≈ **750 fork/min**。`get_tmux_agent_windows` 每 pass 重复 4 次(:7485/:6976/:3272/:3359)。单次 create ≈60-80 fork。
- 已有的唯一复用优化:create 内 snapshot 复用(:6551-6554);唯一进程内缓存:REOPEN_CACHE(:1135-1138,只盖 generation 文件)。
- **FLY-1929 存档裁决**(verification-and-scope.md §2-3):cmux-sync 占全机 churn 22.8%(独立归因实测),砍半只降总量 ~11%,不改变 panic 与否(voucher-guard 已兜);15s 节拍写进契约(sync.sh:7262 "events drain within 15s of firing");建议单独 QA(test-cmux-sync 570 例隔离 socket)。
- **Rosetta 放大器**[实测]:`/usr/local/bin/tmux` x86_64,本 runner shell `proc_translated=1`;Claude/node 是 arm64-only 不受影响,受影响的正是 fork 出的 universal 系统工具(bash/awk/grep/ps)。→ server 换 ARM 是单一最大杠杆。

## 2. W2:tmux 路径与版本

### 2.1 宿主实况 [实测 2026-08-21]

- `which -a tmux` → 仅 `/usr/local/bin/tmux`,x86_64,3.5a。ARM Cellar 有 3.7c 未 link;Intel Cellar 3.5a。
- macOS 26.6.2;Intel brew `upgrade --dry-run tmux` → `tmux 3.5a -> 3.7c (556.6KB)` + 6 依赖(ca-certificates/openssl@3/libevent/ncurses/utf8proc/jemalloc)。
- 生产 server 形态:15 个 per-Lead 私有 socket(`-D -S ~/.flywheel/sock/fw-*.sock`,绝对路径 `/usr/local/bin/tmux`)、default server(裸 `tmux new-session -Ad -s flywheel`)、`-L atlas`、QA slot socket。

### 2.2 路径解析全景

- **唯一代码写死旧路径**:`packages/teamlead/scripts/decommission-legacy-companion-daemon.sh:42-45`(`/usr/local/bin/tmux` 优先探测)。issue 说法字面成立。
- **系统性旧路径优先**:8 处 wrapper/plist PATH `/usr/local/bin` 在 `/opt/homebrew/bin` 前 —— `scripts/flywheel-bridge-wrapper.sh:54`(Bridge 主进程;bridge.plist 无 EnvironmentVariables,PATH 全由 wrapper 定)、`scripts/flywheel-lead-wrapper-v2.sh:74`、mufasa TUI 模板 :37、`scripts/restart-services.sh:33`、voice/quota wrapper、`com.flywheel.updater.plist:18`、`scripts/lib/qa-launchd-lead.sh:64`。**另一派 homebrew 优先**:5 个 launchd plist + `flywheel-cmux-autostart.sh:27` + xiaohongshu tick。两派并存。
- TS 全线裸 `tmux` 靠 PATH(TmuxAdapter 21 处、codex-runner-tui-window 4 处、tmux-lookup 5 处、terminal-mcp `tmux-exec.ts:53`);唯一绝对路径解析:`packages/core/src/tmux-viewer.ts:137-146`(`which tmux`,AppleScript 场景)。shell 侧 rescue 完全裸 tmux;lead wrapper v2 `TMUX_BIN="${FLYWHEEL_LEAD_V2_TMUX_BIN:-tmux}"` + `command -v` 解析(:227-235)。
- [实测] 双 prefix 同名二进制 **373 个** → 通用 PATH 翻转爆炸半径过大,排除。
- [实测] 本 runner pane PATH **无 `/opt/homebrew/bin`**(`~/.local/bin:/usr/local/bin:系统路径`)→ 若只删 Intel tmux 不留兼容 symlink,交互/runner shell 的裸 `tmux` 会 command-not-found。

### 2.3 3.5a 行为假设(升级风险面)

- `TmuxAdapter.ts:1704-1726`:scaffold window 自动改名竞态 workaround("verified on tmux 3.5a")——手动 rename 方案对 3.7c 仍成立,但需回归确认。
- `scripts/test-cmux-sync-hooks-integration.sh:8-40`:3.5a 实测 `pane-exited` 注册但不触发;`remain-on-exit` 下 `pane-died`/`pane-exited` 都不触发。3.6 changelog:hooks 改为 **array options 存储**、新增多种 hook;3.7:hooks 内部改 event 机制。→ `register_session_hooks`(sync.sh:7035-7041,grep `show-hooks` 输出做幂等)是**最高风险点**:`show-hooks` 输出形态若变,幂等判断失效 → 重复注册或漏注册。
- `tmux-lookup.ts:131,163`(display-message 失败回落)与 FLY-1672 的 `window_id|pane_dead` 身份校验:身份校验对版本变化免疫(这正是 FLY-1672 的修法),回归覆盖即可。
- **`tmux -V` 从不被 parse**:所有版本适配是硬编码假设,升级无自动告警。测试为门:`scripts/test-cmux-sync.sh`(570 例,隔离 socket)、TmuxAdapter 79 例、hooks integration、FLY-1672 回归。
- 协议:同版本跨 arch(x86_64 client ↔ arm64 server)兼容(同为 little-endian 64-bit,imsg 结构一致);**跨版本**(3.5a↔3.7c)不兼容 = 事故日实锤。

## 3. W3:护栏面

### 3.1 现成范式(FLY-913 restart-guard)

- Hook 安装:`claude-lead.sh:1188-1206` → `scripts/hooks/install-restart-guard.sh`,装进 `~/.claude/settings.json` PreToolUse(matcher:"Bash"),**同时覆盖 Lead + 全部 Claude runner**(runner 由 TmuxAdapter 裸 `claude` 起,继承同一 `~/.claude`,`packages/claude-runner/src`、`packages/edge-worker/src` 零处注入 `CLAUDE_CONFIG_DIR`)。每次 Lead 启动收敛(anti-drift)。
- 判定:`scripts/hooks/flywheel-restart-guard.py:574-587` — JSON `hookSpecificOutput.permissionDecision:"deny"` + 恒 exit 0;放行 = 零输出。fail-open 只盖判断路径,命中后唯一出口 deny 或记账成功的 bypass(:590-630)。
- bypass:`FLYWHEEL_RESTART_GUARD_BYPASS=<reason> <cmd>` 锚定前缀(:117-122);放行双前置 = audit 写成功(:506-518)+ `lead-alert.sh --strict-delivery` 末行 `sent|queued_transient`(:529-570)。
- 安装器细节:jq 细粒度 merge 保兄弟 hook(:60-74);jq1.6 输出非空判定陷阱(:48-56);测试 `scripts/hooks/test-restart-guard-install.sh` + `test-flywheel-restart-guard.py`(35.8KB)。

### 3.2 判别信号 [实测关键]

- runner pane env:`FLYWHEEL_EXEC_ID=7416f51f-…` **存在**;`FLYWHEEL_LEAD_ID=flywheel-eng-lead` **也存在**(泄漏——`TmuxAdapter.ts:677-680` 只清 `LEAD_ID`/`DISCORD_*`);`LEAD_ID` 已清。
- → 判别用 `FLYWHEEL_EXEC_ID`(Lead 会话无);`FLYWHEEL_LEAD_ID` 不可用。泄漏本身是既有归因 bug(restart-guard :551-552 用它做 bypass 归因,runner bypass 会记成 Lead 名)——记 follow-up,本单不动(需先核 `flywheel-comm` CLI 是否依赖该 env 做默认 lead 路由)。
- 权限模型:Lead 与 runner 同为 `bypassPermissions`(claude-lead.sh:2358-2361 / Blueprint.ts:2839)——权限差异不由 permissionMode 表达,hook 是唯一现实拦截面。
- 非 Claude 面:Codex runner = workspace-write 沙箱(天然拦 /usr/local 写);Codex full-access Lead = Lead(白名单侧);agy/kimi runner 无 Claude hook(诚实边界)。

## 4. W4:Codex TUI 开窗

### 4.1 锁与预算

- 锁:per-socket 文件锁 `~/.flywheel/locks/tmux-<hash>.lockf`(`tmux-server-rescue.sh:1628-1636`),flock/lockf/python 三后端(:1581-1617)。
- 等待方单次 acquire = 5s × load factor(≤4)= 5-20s(:184-207,:71-77);超时 → `{"action":"hold_lock_unavailable","evidence":{"reason":"acquire_timeout"…}}` + exit 5(:1684-1686)。
- 持有方软预算 60s(:63-69);临界区 inspect 6s×factor、command 5s×factor、recover 最多 20×0.25s 轮询(:661-816,:829-911)→ **33.8s 持有在设计预算内**。持有超 5s 释放后自发 `tmux_rescue_hold` 告警(:1447-1454)——指向持有者,与被挡 runner 无关联键;**等待方零告警**(:1417-1420 只记 audit)。
- Node 侧重试:deadline 驱动 —— `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 默认 210s、`FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS` 单次 spawn cap 90s、间隔 min(1s, remaining)(codex-runner-tui-window.ts:428-453,:264-319)。
- [实测] 生产 dist 与 src 日志模板一致(`attempt ${attempt}` 无分母)→ "attempt 1/2" 是转述;高负载下单 attempt 被 90s cap 顶满,210s 恰容 2 次完整 attempt,与"两次尝试超时"吻合,**无 build 不一致**。

### 4.2 失败路径与账面

- ensure 全败 → `{created:false, reason:"create-failed"}`(:729-735,一行 log)→ `CodexTmuxAdapter.attemptOpen` :600-648:**只有 `died` 重试**(TUI_OPEN_MAX_ATTEMPTS=8×900ms,:114-115,:620-633);`create-failed`/`tmux-absent` 静默 fallthrough(:646)。Claude 侧对照:同 rescue 失败会 `throw TmuxSessionHoldError`(TmuxAdapter.ts:1743-1788,:1858-1968)——**Codex 路径是唯一吞掉该信号的分支**。
- 收尾兜底开窗(:836-851)条件 `!threadReadySeen`——锁竞争场景 onThreadReady 已 fire → 兜底不执行。锁挡场景落在**所有**补救之外。
- CommDB 时序:Bridge 预登记 `${tmuxSession}:pending`(run-dispatcher.ts:1236-1243)→ adapter 在窗口创建**前**写名字型 `${session}:${windowName}`(CodexTmuxAdapter.ts:461-464 → :1539-1548,ON CONFLICT 覆盖 pending)→ 建成后 pin `@id`(:569-578)。下游只把 `:pending` 判为 pending_only(started-evidence.ts:68-72、generalized-launch-recovery.ts:77-90、plugin.ts:6102)→ 名字型死 target 被误判 `tmux_dead` 而非"从未创建"。
- `delivered`:`onGoalActive` 由 setGoal 成功驱动(CodexTmuxAdapter.ts:733-745;StateStore.ts:25207-25212),与开窗解耦;窗口层契约 fail-open(codex-runner-tui-window.ts:17-19 "a window failure costs VISIBILITY, never the run")。
- 现有告警资产:`tui_window_lost` kind + episode-latch guard(`teamlead/src/lead-backends/codex/tui-window-alert.ts:47,50,288`),**只在 Lead 侧 opt-in**(run-codex-infra-bot-tui.sh:54),runner 侧从未实例化。

## 5. W5:playwright

- 配置链:plugin `playwright@claude-plugins-official`,注入 = per-launch `--settings` enabledPlugins(`packages/config/src/runner-mcp-profile.ts:56,70-72,104,115-118` → run-dispatcher.ts:1817/:1082 → Blueprint.ts:2871-2886 → TmuxAdapter.ts:1199-1219)。普通 runner 不写 playwright 键 → 继承 machine 值;QA(`sessionRole==="qa"`)结构性强制 true(:108,:116-118);Lead 走 projects.json `playwrightMcp` allowlist(claude-lead.sh:540-574,当前**全空**)。
- 启动命令:`npx @playwright/mcp@latest` **零 flag**(plugin cache `.mcp.json`);实跑 0.0.79。**两级启动**:MCP server 随 enabled plugin eager 起;**Chrome first-tool lazy**(FLY-1867 plan.md:47)。可见窗口 = 首调时默认 **headed** persistent context(profile 在 `~/Library/Caches/ms-playwright-mcp`,不看 TMPDIR,TmuxAdapter 的 TMPDIR 重定向无效)。
- FLY-1867 (PR #904) 已 ship:P0 reaper 修根因(旧 reaper TERM→sleep3→KILL 亲手造孤儿;新 `mcp-descendant-reaper.ts` 轮询等待+身份栅栏+unknown 不 KILL)、P2 census audit-only、P3 存量 quarantine、**P-1/P1 policy writer 已造未 apply**(`scripts/setup-mcp-on-demand.sh`:machine default-off + `PLAYWRIGHT_MCP_HEADLESS=true`,receipt/preimage-SHA/flock/原子写/rollback 齐备)。
- [实测复核] 宿主 `~/.claude/settings.json`:playwright=true、无 HEADLESS、无 receipt → **cutover 从未执行**(与 FLY-1867 plan.md:49 一致)。host census(plan.md:50):23 server 中 21 无 Chrome → 真实浪费 = 19 个空挂 node server,不是"启动即开浏览器"。
- kill-switch 缺口:`FLYWHEEL_RUNNER_SLIM_MCP=0` → legacy null profile,QA 的 opt-in 也失效(runner-mcp-profile.ts:100-104)→ cutover preflight 必核未设或 ≠0。
- 上游未钉版本(`@latest`):headless env 名、ppid==1 安全垫、config merge 优先级都是"对 0.0.79 成立"(FLY-1867 research.md:298)。

## 6. 结论移交 plan

五块的机制、行号、预算、现成资产与边界全部就位;设计选择与弃选理由见 exploration.md §4;实施切分、runbook、测试与验收映射见 plan.md。
