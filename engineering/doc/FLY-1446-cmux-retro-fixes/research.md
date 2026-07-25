# FLY-1446 cmux 稳态 Retro 修复包 — 调研

Issue: FLY-1446 (https://linear.app/geoforge3d/issue/FLY-1446/cmux-稳态-retro-修复包-roster-对账-唯一启动者-合并即部署-server-死因-收养竞态去重)
日期: 2026-07-24
基于: exploration.md

逐项列出五个修复域的代码事实(file:line 证据),以及每个修复的挂载点。所有行号基于分支 `flywheel-FLY-1446` 当前 HEAD(与 main dc754746 同源)。

## 0. 涉案文件清单

| 文件 | 角色 | 行数 |
|------|------|------|
| `scripts/flywheel-cmux-sync.sh` | watcher 本体(A/E 的修改主体) | 5882 |
| `scripts/flywheel-cmux-autostart.sh` | launchd/.zshrc 共用入口 wrapper(B) | 76 |
| `scripts/flywheel-cmux-install.sh` | 安装器:symlink + .zshrc 集成 + launchd plist(B/C) | ~200 |
| `scripts/com.flywheel.cmux-watcher.plist.template` | launchd 模板(FLY-177,已装) | 27 |
| `scripts/converge-flywheel-bin.sh` | bin 收敛器(FLY-954/1389)(C 的修改主体) | 257 |
| `scripts/restart-services.sh` | 重启编排(只 poke,不改或微改) | 1456 |
| `scripts/lib/tmux-server-rescue.sh` | tmux server ensure/rescue(FLY-1285)(D 防复发挂载点) | — |
| `scripts/lead-alert.sh` + claims.db | 报警通道(A/C/E 复用,已有 dedup) | — |

## 1. RC1 / C 项:部署形态与收敛缺口

### 1.1 设计形态 = symlink

`flywheel-cmux-install.sh` 安装即 symlink(FLY-98 注释:「repo updates take effect immediately without re-install」):

```
ln -sf "$REPO_DIR/scripts/flywheel-cmux-sync.sh"      "$INSTALL_DIR/flywheel-cmux-sync"
ln -sf "$REPO_DIR/scripts/flywheel-cmux-autostart.sh" "$INSTALL_DIR/flywheel-cmux-autostart"
```

即「合并即部署」在 symlink 形态下**天然成立**(生产 main checkout `git pull` 后 symlink 目标即新代码)。

### 1.2 生产实际形态 = 普通文件副本(且此刻就在漂移)

实测(2026-07-24,生产机):

```
-rwxr-xr-x  3311 B  Jul 16  ~/.flywheel/bin/flywheel-cmux-autostart     ← 普通文件,非 symlink
-rwxr-xr-x  266687 B Jul 23 ~/.flywheel/bin/flywheel-cmux-sync          ← 普通文件,非 symlink
md5(bin/flywheel-cmux-sync)      = ec8fae29… == repo    (07-23 事故日手工救回)
md5(bin/flywheel-cmux-autostart) = 1e2f6c50… != repo 0d603daa…   ← 活漂移
```

diff 内容:部署副本缺 FLY-1364 的 `load_cmux_bool_flag FLYWHEEL_CMUX_STRICT_VIEW`(repo 第 49 行)——即生产 launchd 启动的 watcher **至今**拿不到 .env 里的 strict-view 开关(fallback 到 watcher 内部默认)。deployment-copy disease 第三犯(前两犯:enforcer hook、cmux-sync 7 天旧版=RC1)。副本来源:两个 `.bak-fly1272-pre-7ae127bf` 备份文件说明 FLY-1272 hotfix(Jul 16)以 cp 方式换入,symlink 形态自此断链。

### 1.3 converge-flywheel-bin.sh 的覆盖缺口(修 C 的确切位置)

- **内容收敛列表**(`FILES=`,converge-flywheel-bin.sh:65)只有 `flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh` —— cmux 两脚本不在内。
- **symlink 健康段**(FLY-1389 P1-c,:168-239)覆盖 `flywheel-cmux-sync` / `flywheel-cmux-autostart`,但入口条件是 `[ -L "$link" ] || continue`(:181)——**已经是 symlink 才检查**;普通文件副本(当前生产形态)整段跳过,零检测零报警。
- mount 点(:8-14):claude-lead.sh 每次 Lead 启动(non-fatal)、update-flywheel.sh 每日 sweep + self-ship(non-fatal)、restart-services.sh::do_restart_all_leads pre-kickstart(FAIL-LOUD)。修好缺口后这三个频率自动生效,无需新增巡检定时器。
- 现有安全惯例可直接复用:非 symlink → 期望 symlink 的修复要走「trusted root 才修」(`is_temp_or_worktree_root` 拒绝 worktree,:178)、`assert_sane_script_source` + shebang 检查(:204-205)、原子替换(`ln -s tmp && mv -f`,:216-217)、报警带 signature 走 claims.db 去重。

### 1.4 restart-services.sh 现状(不需要大改)

`trigger_cmux_refresh`(restart-services.sh:1102-1138)只调 `"$FLYWHEEL_DIR/scripts/flywheel-cmux-sync.sh" --refresh`(**repo 路径直调**,注释:「avoid stale-install rollout gap」)+ `cmux refresh-surfaces`。它已经是 poke,不启动实例。restart-services 唯一要加的是:pre-kickstart converge 失败已 FAIL-LOUD(现有),C 项扩列表后自动覆盖 cmux 脚本。

## 2. RC1 / B 项:启动路径盘点

| 入口 | 现状 | 目标 |
|------|------|------|
| launchd `com.flywheel.cmux-watcher`(KeepAlive+RunAtLoad,SUPERVISED=1) | 已装(~/Library/LaunchAgents,FLY-177);block-wait 模式(acquire_watcher_lock:5790-5798:抢不到 lease 就 sleep 等,不退出) | **唯一启动者**(不变) |
| `.zshrc` → `~/.flywheel/cmux-integration.zsh` → `flywheel-cmux-autostart &!`(每个 cmux 内 shell 打开都触发) | `exec "$SYNC_SCRIPT" --watch`(autostart:76)——**真启动路径**;靠 lease 的 unsupervised fast-exit(:5800-5806)避免双实例 | 降级为「job 卫兵」:只 `launchctl print` 探测 job 是否已加载,未加载才 `launchctl bootstrap`;**永不直接 exec watcher** |
| restart-services.sh | `--refresh` poke(见 1.4) | 不变 |
| 手动 | 随手 `flywheel-cmux-sync --watch` 可当第二实例候选(靠 lease fast-exit 挡) | 文档化:`launchctl kickstart -k gui/$UID/com.flywheel.cmux-watcher` = 唯一合法重启手势;`--once`/`--refresh` 仍开放(走 run_mutator_once lease) |

关键事实:repo HEAD 的互斥已健全——`acquire_mutator_lease`(:5556)incarnation-bound、`_ledger_transaction` 等全部 mutation 以 lease 为前提(:3108)。**07-23 的 7 实例是旧部署副本(无这些保护)互踩**,不是现行锁逻辑的洞。B 项的价值:①把「.zshrc 每开 shell 都尝试启动」这个结构性多余入口收掉(旧副本时代它就是实例增殖器);②固化唯一重启手势,防止未来回归。

维护模式标记(`FLYWHEEL_CMUX_MAINTENANCE_MARKER`,autostart:51-54)只挡非 supervised 路径——.zshrc 降级后此语义不变(launchd 侧由 `maintenance_entry_allowed`(sync:5671)把守)。

## 3. RC2 / A 项:watcher 可见性模型与 roster 素材

### 3.1 现状:无 roster

`sync_additive()`(sync:4897-4953,60s 周期)全部工作以 `get_tmux_agent_windows()`(:497,枚举 `flywheel` + `runner-*` 会话的窗)为宇宙;`tmux_windows` 为空时只做清理(:4904-4919)。窗不在这两类会话里(困进残骸会话 / server 死了)= 不存在。没有任何「应该有谁」的对照。

### 3.2 Lead roster 可零手工派生(逐字键匹配)

- launchd Lead job:`~/Library/LaunchAgents/com.flywheel.lead.<project>-<leadId>.plist`(生产现有 17 个,不含 .bak/.staged 变体——派生时必须过滤后缀非 `.plist` 的文件)。
- Lead tmux 窗名 = `${PROJECT_NAME}-${LEAD_ID}`(claude-lead.sh:1450:`local window_name="${PROJECT_NAME}-${LEAD_ID}"`,target `=flywheel:=${window_name}`)= **launchd label 去掉 `com.flywheel.lead.` 前缀**。cmux tab 标题 = 窗名(watcher create/rename 均以 window_name 为 title)。
- 豁免判定素材:plist `ProgramArguments[1]`(wrapper 路径)区分形态——`flywheel-lead-wrapper.sh`(Claude,tmux 窗形态)vs `flywheel-codex-lead-wrapper-*`(Codex headless/TUI,**不在** `flywheel` tmux 会话开窗);manifest `~/.flywheel/manifests/<label后缀>.json` 的 `leadBackend.backendId`(`claude-code` vs 其他)作旁证。v1 规则:仅 `flywheel-lead-wrapper.sh` 形态入「tmux 窗期望」;其余自动豁免(honest boundary:Codex TUI Lead 的可视对账不在 v1)。
- launchd 侧 disabled 状态:`launchctl print gui/$UID/<label>` 可探测 job 是否加载;plist 存在但 job 未加载(操作员显式 bootout)不应报「窗丢失」——roster 入册条件 = plist 存在 **且** job 已加载。

### 3.3 runner roster

Bridge StateStore sessions 表(sql.js,标准 SQLite 文件)是 runner 期望来源(running/parked 应有窗)。两条读取路径:
1. Bridge HTTP(dashboard 已有 sessions 快照 API,loopback + token);
2. 直接只读 sqlite 文件。

watcher 是 bash + 60s 周期,Bridge 挂了正是最需要可视的时刻——但 FLY-1374 正在重做 Bridge 内 sessions 真相,**runner 期望集的语义(哪些状态=应有窗)以 1374 落地后的口径为准**。故 v1 拆层:A-Lead(launchd roster,本单硬交付)+ A-Runner(sessions roster,接口与报警链路本单交付、期望口径参数化,读取走「Bridge API 优先、失败跳过本轮并低频报警」的降级顺序,不直读 sql.js 文件避免 mid-write 读损)。
runner 窗名 = Linear identifier(FLY-272),sessions 表有对应字段;孤儿定义 = sessions 报 running/parked 且 `runner-*` 会话及 `flywheel` 会话中均无同名窗。

### 3.4 只读观察窗(孤儿 runner)

「1434 viewer 手法」= 事故当晚对孤儿 runner 进程的手工处置:进程还活着但窗没了,PTY 无法重挂——只能挂**只读观察面**。可脚本化素材:runner transcript/log 路径可从 runner-state 目录(`~/.flywheel/runner-state/<execId>/`)与 tmux 日志推得;观察窗 = 在 `flywheel` 会话开 `[orphan] <identifier>` 窗跑 `tail -f <log>`,cmux 侧自然获得 tab(watcher 会为它建 tab)。约束:标题带 `[orphan]` 前缀、绝不参与 roster 对账的「已有窗」判定(否则观察窗会掩盖真窗缺失)、runner 终态或真窗回归时由对账器关闭。

### 3.5 报警通道

`_alert_cmux_cleanup`(sync:134)已封装 lead-alert.sh + signature 去重(claims.db,跨进程跨重启)。A 项新增报警(lead-window-missing / runner-orphan / roster-derive-failed)复用同通道,per-key signature,恢复后 latch 清除语义参照 FLY-1220 episode-latch(报一次,恢复前不重复)。

## 4. RC3 / D 项:tmux server 死因素材

- runner tmux server = **默认 socket** `/tmp/tmux-<uid>/default`(TmuxAdapter.ts:1285-1289 `tmuxDefaultSocketPath()`;可被 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 覆盖,生产未设)。Retro 所称「UUID socket」需在取证中核实(可能指 cmux 的 socket 或误记——取证第一步就是从 Bridge log 把事发 socket path 钉死)。
- spawn 时已有 ensure/rescue:`tmux-server-rescue ensure <socket> --verify … --create …`(TmuxAdapter.ts:1433-1454;scripts/lib/tmux-server-rescue.sh,FLY-1285)——server 死后**下一次 spawn** 会救活 server,但救不回已死 server 里的窗(runner 进程成孤儿)。
- tmux 行为事实:`exit-empty`(server option,默认 **on**)= 最后一个 session 销毁时 server 退出。「杀最后一个 session ⇒ server 联动退出」是完全正常的 tmux 语义——这使「有东西批量清 session」成为 RC3 的头号假说,也使 sentinel session / `exit-empty off` 成为与死因无关都成立的防复发闸。
- 取证素材源:① Bridge log `server exited unexpectedly` 首现时间戳(事发窗口锚点);② macOS unified log `log show --start … --predicate`(tmux 进程 exit/signal 记录、OOM/jetsam 记录);③ `~/.zsh_history` / Lead pane 历史(混乱窗口期是否有人/agent 跑过 kill-session/kill-server/pkill);④ launchd job 退出记录;⑤ FLY-1117 forensics 先例(engineering/doc/FLY-1117-forensics-0709-failure-chain/)的证据归档形态可复用。
- 已知混淆项:memory 记录「每晚 crash 常是 load 过载」(OOM/swap 压死 tmux 在 07-10 发生过)——OOM killer 假说必须与「显式 kill」假说并列取证,不预设结论。

## 5. E 项:双收养与 WAL 罢工的确切机制

### 5.1 E1 rename-lag 双收养(FLY-1443,ref 145+146)

create 链(`create_workspace_for_window`,sync:3938-4200):

1. 存在性检查按 **cmux title** 匹配(:3990-3997 `w.title == window_name`)。
2. TTL 去重 `create_recently_attempted(window_name, window_id)`(:3965),TTL = `FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS` **默认 30s**(:1841-1846),且**自声明 fail-open**(「hardening layer, not a safety-critical gate」)。
3. new-workspace(cmux 初始 title「Terminal N」)→ diff refs 得 new_ref → `_ledger_upsert prepared`(:4120)→ `rename-workspace`(:4135)。**rename 失败只 log WARN + return**(:4136-4137),留下 prepared 行,等 `reconcile_prepared_ledger`(:3336)后续补救。

07-23 复盘对号:17:41:26 第一轮走到步 3,rename 卡死 → ledger 留 `prepared|gen|145|FLY-1443`,cmux tab 停「Terminal 35」。17:42:31(+65s)第二轮:步 1 title 无匹配(还叫 Terminal 35)、步 2 TTL(30s)已过 → 再建 ref=146,这次 rename 成功 → `committed|gen|146|FLY-1443`。此后 145 的 prepared 行被 reconcile 补 rename → 也 committed → **同 (generation,title) 双 committed 行、双同名 tab**。

三个缺口,三层修法(与 exploration §3E 对应):
- **缺口 1**:create 前不查 ledger。`ledger_refs_for_title`(:3213)现成可用,却不在 create 链上。→ 建前查:同 (generation,title) 已有行 → 跳过 create,转驱动恢复。
- **缺口 2**:`_ledger_upsert`(:3190)只按 ref 去重(`awk '$3 != r'`,:3169),同 title 第二行畅通。→ upsert 层加 (generation,title) 唯一断言:插入 committed/prepared 行前若已存在**不同 ref** 的同 (generation,title) 行 → 拒绝 + 报警(fail-closed:宁可少一个 tab 等 reconcile,不可双 tab)。
- **缺口 3**:`reconcile_prepared_ledger` 补 rename 前不检查 title 已被其他 committed ref 占用 → 把竞态输家也推成 committed。→ reconcile 侧同键检查:title 已有 committed 归属 → 当前 prepared 行走 close guard 关闭(输家收尸)+ 报警。

「窗口身份键」的落法:ledger 行现为 `state|generation|ref|title` 4 字段,title 即窗名(窗名 = Lead/runner 身份,FLY-272 后 runner 窗名=Linear identifier,同 generation 内唯一)。**(generation,title) 就是窗身份键**——不必扩行加 window_id(避免 ledger schema 迁移与旧行兼容负担);window_id 作为第二证据仅在 dedup 对账(挑「谁真正持有窗」)时从 view session 现场取。dedup_workspaces_by_title(:764)已有按 title 收尸逻辑可参照。

### 5.2 E2 malformed WAL 静默罢工(FLY-1436 真因)

调用链:`sync_additive` → `refresh_linked_sessions`(:4397)→(linked_view/view_invariant 开启时)`prepare_linked_view_state`(:3591)→ `recover_all_view_constructions`(:3572)。

罢工机制(:3575-3588):for 循环遍历 `$VIEW_WAL_DIR/*.wal`,malformed(非单行 / 字段≠9 / 前缀不符 / 文件名与身份不匹配)→ `log WARN … preserved` + **`return 1` 中止整个函数**。上游:`prepare_linked_view_state` return 1 → `refresh_linked_sessions` return 1 → `sync_additive` 在 create 循环**之前** `return 0`(:4922-4925「pass deferred」)。恶果:一个坏文件 → 每轮 60s pass 全 skip、不建任何 tab、只有 watcher log 两行 WARN、零 Discord 报警——与 07-23 晚实测一致(手工 mv 掉 8a92246… 后 90s 恢复)。

修法定位:
- 循环内 malformed 分支:`mv` 到 `$VIEW_WAL_DIR/quarantine/<原名>.<epoch>` + `_alert_cmux_cleanup`(signature 含文件名+sha 前缀,claims.db 去重)+ `continue`。
- 语义辨析(review 重点):`recover_view_construction` 单文件内的「malformed → 保留 + return 1」是**深思熟虑的 fail-closed**(malformed 记录不授权任何 mutation)——这条**保持不变**;要改的只是**全量循环把单文件失败放大成全局罢工**这一层。隔离(quarantine)不是删除:文件保留取证,且移出 WAL 目录后不再授权 mutation,与「malformed 授权零 mutation」原则一致。
- `recover_view_construction` 的 rc=1 还有一个非 malformed 来源(canonical view collision,:3041-3042 保留 WAL 是对的)——循环处理 per-file rc 时须区分「malformed(隔离)」与「conflict(保留、继续下一个文件)」,后者也不该中止全循环但更不能隔离。

## 6. 测试与 QA 素材

- 现有 harness:`scripts/test-cmux-sync.sh`、`scripts/__tests__/test-cmux-autostart-flags.test.sh`、`flywheel-cmux-install-link-only.test.sh`、converge 的 hermetic 测试模式(`FLYWHEEL_STATE_DIR` 沙箱,converge:37)——bash 3.2 兼容(`/bin/bash` 3.2 跑 `bash -n`,平台事实见 memory)。
- watcher 可 `source` 化测试(sync:5818 BASH_SOURCE guard),函数级单测直接调。
- 真机验收(issue ①-⑥)需要独立 QA 段:杀窗计时、三路径并发启动、md5/symlink 对账注入漂移、WAL 注入坏文件、rename-lag 复现(可用 `cmux rename-workspace` 打桩延迟或 mock cmux_call)。
- 报警断言:claims.db 是跨进程账本,QA 可直接查(FLY-1220 部署铁证手法)。

## 7. 风险与依赖

| 风险 | 缓解 |
|------|------|
| C 项把生产 bin 从副本切回 symlink,若主 checkout 处于坏态(mid-pull)会放大 | converge 已有 `assert_sane_script_source` + trusted-root 前置;只在 source 健康时替换;替换原子(tmp+mv) |
| A 项报警误报(Lead 计划内 bootout / 维护窗口) | roster 入册条件=plist 存在且 job 加载;维护 marker(现有 `cmux-maintenance`)期间对账静默;episode-latch 报一次 |
| B 项 .zshrc 降级若 launchd job 意外缺失会失去最后自愈路径 | 降级后的 .zshrc 卫兵本身就是「未加载则 bootstrap」的自愈;比旧行为(直接再拉实例)更收敛 |
| E1 fail-closed 拒绝第二行可能延迟 tab 出现 | reconcile_prepared_ledger 每轮跑,prepared 行会被补 rename;延迟上限 = 一轮 60s,优于双 tab |
| watcher 5882 行 bash,改动面控制 | 全部修改挂在既有函数边界(见各节「修法定位」),不重构;每处独立 env 开关回退 |
| FLY-1374 并行改 Bridge sessions 语义 | A-Runner 期望口径参数化,落地顺序上 A-Lead 先行 |
