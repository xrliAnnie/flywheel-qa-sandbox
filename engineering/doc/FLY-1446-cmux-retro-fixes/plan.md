# FLY-1446 cmux 稳态 Retro 修复包 — 实施计划

Issue: FLY-1446 (https://linear.app/geoforge3d/issue/FLY-1446/cmux-稳态-retro-修复包-roster-对账-唯一启动者-合并即部署-server-死因-收养竞态去重)
日期: 2026-07-24
基于: research.md(Codex design review R1 8 项已全部吸收,见 §7 变更记录)

## 0. 目标 / 非目标 / 总体判断

**目标**:cmux 可视层 + 脚本部署层五项 Retro 修复(A roster 对账 / B 唯一启动者 / C 合并即部署 / D server 死因 / E 收养纪律),达成 issue 六条能力级验收。

**非目标**:Bridge sessions 状态真相(FLY-1374)、LeadWatchdog 域、cmux Electron 自身 bug、watcher 架构重构。

**总体判断(供 review 挑战)**:
1. **C 项偏离 issue 原文手段、保留其目标**:issue 说「发版自动 cp + md5 对账」;审计发现安装器设计形态本就是 symlink(合并即部署天然成立),病根是「symlink 被 cp 副本顶替后没人发现」。故 C 项 = converge-flywheel-bin.sh 强制 symlink 形态(副本=漂移,自动换回+报警),不新建 cp 管道。md5 对账在 symlink 形态下退化为 symlink 健康检查,converge 三个既有 mount 点(Lead 启动/每日 sweep/pre-kickstart)提供巡检频率,零新增定时器。
2. **B 项是收入口,不是造新锁**:repo HEAD 的 mutator lease 已健全,07-23 的 7 实例是旧部署副本互踩。B 项把 `.zshrc` 从「启动路径」降级为「launchd job 卫兵」,固化 launchd 为唯一 `--watch` 启动者。
3. **E 两项是纯 bug 修**,挂在既有函数边界,**不动 fail-closed 骨架**:E2 只把「语法性 malformed 单文件失败放大成全局罢工」这一层改掉,一切不确定性授权失败仍中止;E1 的唯一性写进 ledger 写事务内部。
4. **A 项分层**:A-Lead(launchd roster + carrier matrix)本单硬交付;A-Runner 侦测+报警本单交付(按真实契约:`@flywheel_exec_id` + `mode=active` 状态集 + Bearer token)。**只读观察窗降级为 follow-up 单**(对 issue 原文的显式偏离,真实理由:durable log/rotation 契约、receipt ownership、不可逆终态 allowlist 与真机场景矩阵四件启用前提尚未完成——是主动切单,不是端点缺失;鉴权 `GET /api/sessions/:id` **今天已存在**(tools.ts /sessions/:id,/api Bearer 挂载),follow-up **复用并 harden** 它:该 route 会从 execution_id fallback 到 identifier,故关闭授权必须校验响应 execution_id 与 receipt 全等,并注意 apiToken 未配置时 middleware no-op 的 caveat。启用契约已在 §1 A-Runner 尾部钉死;Linear follow-up 单要带上这段真实依据)。
5. **D 项证据先行**:易失证据保全(W0)先于一切代码工作;防复发闸(keepalive)只在 tmux-server-rescue 锁内一个 mount 点落地。

## 1. 工作项

### WP-0(先行)server 死因证据保全(D 的取证前半)

unified log / shell history / launchd 记录都会轮转——**证据保全先于一切代码工作**(FLY-1117 chain-of-custody 形态):

1. 保全原始输入到 `engineering/doc/FLY-1446-cmux-retro-fixes/evidence/`:
   - Bridge log 中 `server exited unexpectedly` 全部行 + 前后各 30min 原始切片(钉首现时刻 T0 与涉事 socket path——核实 Retro 所称「UUID socket」实指);
   - `log show --start <T0-30m> --end <T0+10m>`(tmux 进程 exit/signal、jetsam/OOM)原始输出;
   - `~/.zsh_history` 相关时段切片、`launchctl` 相关 job 记录;
   - 每份证据记录:采集命令、采集时间、时区、sha256(chain-of-custody 清单文件)。
2. 分析与结论写 `server-death-forensics.md`:结论三选一并给证据(显式 kill / OOM / exit-empty 连带);证据不足则列排除项 + 「下次事发需抓什么」。**不预设结论。**

### WP-C 合并即部署:converge 强制 cmux 脚本 symlink 形态(修 RC1 根)

**改** `scripts/converge-flywheel-bin.sh`(FLY-1389 P1-c 段扩展,新 P1-c′):

- 对 `flywheel-cmux-sync`、`flywheel-cmux-autostart` 两名字(仅此二者;`agent-team-transport`/`tmux-server-rescue` 无副本形态历史,维持现状):
  - **健康 symlink**(指向 trusted main checkout、目标存在且 sane)→ 不动。
  - **普通文件**(今日生产形态)→ 形态漂移。前置三闸全过(trusted root:`! is_temp_or_worktree_root`;source `assert_sane_script_source` + shebang;可 chmod)后按以下**原子序列**收敛:
    1. 留档:no-clobber 唯一路径 `<name>.bak-shape-<epoch>-$$`(hard-link 优先,失败退化 cp;`set -C` / `ln` 天然 no-clobber)。**留档失败 → 零替换 + alert**(绝不先 mv 走原文件制造缺口)。
    2. 同目录建唯一 temp symlink(`ln -s <src> <link>.tmp.$$`)→ `mv -f` 原子覆盖 canonical path。canonical path 全程可执行(先 link 后 mv,无窗口)。
    3. ONE alert(`bin_integrity_drift`,signature `<name>|copy-shape-converged|<src_sha 前 12>`)。
  - **坏 symlink / temp-worktree 目标** → 既有 P1-c 逻辑不变。
  - source 不 sane / 非 trusted root → alert only,绝不替换(既有 fail-safe 原则)。
- 并发安全:三个 mount 点可能并发跑 converge——留档名含 `$$` 不碰撞;替换是单次原子 mv,后到者看到健康 symlink 即 no-op。测试覆盖并发双跑。
- 逃生口:`FLYWHEEL_CONVERGE_CMUX_SYMLINK=0` → 本段跳过(默认 `1`;converge 自身进程读 env,mount 调用方 shell 环境即生效边界)。
- **不**把两脚本加进 `FILES` 内容收敛列表(copy 模式机制;symlink 形态下冗余)。
- `flywheel-cmux-install.sh` 不改(`ln -sf` 已是终态;注释补一句「converge P1-c′ 强制此形态」)。

**测试**:hermetic converge suite 新增——副本→symlink 收敛+alert+留档落位、留档失败零替换、并发双跑、坏 source 拒收敛、`=0` 旁路字节兼容、worktree root 拒绝;既有 P1-c 回归。

### WP-B 唯一启动者:.zshrc 降级为 job 卫兵

**改** `scripts/flywheel-cmux-autostart.sh`:

- `FLYWHEEL_CMUX_SUPERVISED=1`(launchd 路径):行为不变(`exec sync --watch`)。
- 非 supervised(.zshrc / 手动裸跑):**不再 exec watcher**:
  1. 维护 marker 存在 → 直接退出(连 bootstrap 都不做);
  2. `launchctl print gui/$UID/com.flywheel.cmux-watcher` 成功 → 退出 0(watcher 死活由 KeepAlive 负责);
  3. 未加载且 plist 存在 → `launchctl bootstrap gui/$UID <plist>` + log;
  4. plist 不存在 → stderr 提示跑 install,退出 0(shell 启动路径绝不 fail 出 .zshrc)。
- 逃生口:`FLYWHEEL_CMUX_AUTOSTART_EXEC=1` → 旧行为(应急直启;默认 `0`;由 autostart 既有 key-specific 解析器扩展读取,见 §2)。
- 唯一合法重启手势(usage 注释 + runbook):`launchctl kickstart -k gui/$UID/com.flywheel.cmux-watcher`。
- `.zshrc` integration 文件内容不变(它调用的就是 installed autostart 路径,symlink 恢复后自动是新代码)——**无需重跑 installer,无需 `--shell-only`**。

**测试**:`test-cmux-autostart-flags.test.sh` 扩展——非 supervised 不 exec、已加载幂等、未加载 bootstrap(launchctl 打桩)、`=1` 逃生口、marker 优先于一切。`/bin/bash`(3.2)`bash -n`。

### WP-A roster 对账器(修 RC2)

**改** `scripts/flywheel-cmux-sync.sh`:新增 `reconcile_roster()`,挂 `sync_additive()` 既有 60s pass,**两相拆分**(mutation 必须过 WAL 恢复闸):

- **R 相(read-only:派生/对账/episode 报警)**:两个分支都跑——有窗分支与 `tmux_windows` 为空分支(全窗尽失正是最该叫的时刻),且**不依赖** `refresh_linked_sessions` 成败(恢复失败轮、空窗轮的缺窗报警照发)。
- **typed inventory seam(R 相专用)**:R 相**不复用** `get_tmux_agent_windows()`——它对 flywheel/list-sessions/每个 runner session 的读取全是 `|| true`,读失败与真空同为空串,直接喂给 roster 会把一次 tmux IPC 失败放大成全员 missing/orphan。新增 typed 读取:保留真实 rc、原子解析完整快照,产出 `ok_nonempty | ok_empty | indeterminate` 三态;**只有 conclusive `ok_empty`/`ok_nonempty` 才授权** per-subject missing/orphan 判定与 healthy re-arm;`indeterminate`(binary/IPC 失败、局部 session 读失败、全局输出不可解析)→ 发 `roster-blind`/`roster-derive-failed` episode + **保留全部既有 subject 状态**(不得批量转坏或转健康)。「server 已死按真空处理」只能凭独立 server-generation/socket 证据,不得从任意 rc≠0 猜。A-Runner 的 `-a` 全局枚举同规则:命令失败/超时/不可解析 → 本轮零 orphan 结论。
- **M 相(任何 cmux mutation)**:A-Lead「有窗缺 tab」的补建**不另造 create 调用路径**——复用现有 post-refresh additive create loop(:4928-4934,在 `refresh_linked_sessions` 成功、blocked set 已知之后),roster 只负责点名与核销;blocked view 零 mutation(E2 契约)。

零新增定时器。每轮**第一步检查维护 marker**:存在 → 本轮零派生、零 mutation、零报警(既有 unhealthy episode 状态保留不清)。

#### A-Lead(硬交付)— carrier matrix 派生

派生源:`~/Library/LaunchAgents/com.flywheel.lead.*.plist`(精确 `.plist` 后缀,排除 `.bak`/`.staged` 等)。**wrapper 文件名不是 backend 判据**——标准 plist 对所有 backend 都写 `flywheel-lead-wrapper.sh` + manifest 路径,backend 由 wrapper 运行时从 manifest dispatch;专用 `flywheel-codex-lead-wrapper-*-tui*` 恰是必须入册的 windowed 形态。每个候选 label:

1. 读 canonical manifest `~/.flywheel/manifests/<label 去前缀>.json`(`leadBackend.backendId` 等字段)+ plist `ProgramArguments`,按**闭集** carrier matrix 判定(注意:TUI 形态由运行时 `FLYWHEEL_CODEX_LEAD_MODE=tui` 驱动且标准 wrapper 会 source 共享 `.env`——manifest/plist **无法推断** TUI 与否,所以专用 TUI wrapper 走**精确 allowlist**,且 allowlist 必须含 `flywheel-codex-lead-wrapper-codex-infra-bot.sh` 这种**文件名不含 tui** 的已知 TUI launcher):

| carrier | 判定(闭集) | 期望 | 动作 |
|---------|------|------|------|
| claude-tmux | 标准 `flywheel-lead-wrapper.sh` + manifest backendId `claude-code` | 先锁真实目标 `flywheel:=<project>-<leadId>` 窗,再对同名 cmux tab | 缺 tab 有窗→经 M 相补建;缺窗→alert |
| codex-tui-cmux | wrapper basename ∈ 精确 allowlist(当前:mufasa tui 系 + `…codex-infra-bot.sh`;allowlist 单点维护于 watcher,v1 honest boundary) | allowlist 条目声明的 cmux tab 存在性 | 缺→alert(v1 不代建 codex TUI) |
| headless / config-drift | 标准 wrapper + codex backend(当前生成形态一律按此归类),或任何不在闭集内的组合 | 生产硬规则:production Codex Lead 必须 windowed TUI(CLAUDE.md FLY-398) | alert `config-drift`(不静默豁免) |

未来若允许「标准 wrapper 的 TUI Codex Lead」,前置条件是先给 plist/manifest 增加 roster 可读的 per-job carrier 字段——**不得**靠共享 `.env` 推断。回归用例必须含 infra-bot 非 `*-tui*` 文件名形态。

2. `launchctl print gui/$UID/<label>` 失败(job 未加载 = 操作员显式下线)→ 本轮不入册,不报警。
3. **fail-loud 零局部结论**:任一已加载 plist 的解析失败 / manifest 读取失败 → 本轮 Lead roster 整体跳过 + alert `roster-derive-failed`(绝不带着半张名册下缺窗结论)。
4. 成本:17 plist × (plutil+launchctl),60s 周期可承受;plist 目录 + manifests 目录 mtime 快取为轻优化,首版允许直查。

#### A-Runner(侦测+报警硬交付;观察窗降级 follow-up)

真实契约(全部按当前 HEAD 源码锁定,不带假设默认值上线):

1. **期望源 URL**:安全默认 `http://127.0.0.1:${TEAMLEAD_PORT:-9876}`;`FLYWHEEL_BRIDGE_URL`/`TEAMLEAD_PORT` 经 key-specific 解析器载入(入传播表)。**发送 token 前严格校验 URL**:仅 `http` + loopback host(`127.0.0.1`/`localhost`)+ 合法 port;含 userinfo/path/query/fragment 一律拒绝(拒绝 = 本轮 blind episode,绝不把 token 发给继承来的任意 URL)。
2. **请求**:`GET /api/sessions?mode=active`,2s 超时;`Authorization: Bearer …` 经 `curl --config -` **stdin** 传入(daily-digest.sh:127-135 同款),token 绝不进 argv(`ps` 可见面)。active 状态集 = `running|ship_parked|awaiting_review|approved_to_ship`(StateStore 现集合;**明确本版不覆盖 `design_done`**——若未来要覆盖,须先在 Bridge 端提供有界、鉴权、schema 固定的 read endpoint。`FLYWHEEL_CMUX_RUNNER_ROSTER_STATES` flag 不设,状态口径随 endpoint 契约走)。
3. **token 载入**:watcher 用 autostart 同款 key-specific 解析器从 `~/.flywheel/.env` 提取 `TEAMLEAD_API_TOKEN`(绝不 source 整个 .env;值不落日志;仅在调用点读入局部变量)。
4. **窗口键**:execution id ↔ tmux 窗口 option `@flywheel_exec_id`。枚举**逐字采用现实现语义**:`tmux list-windows -a -F '#{session_name}\t#{window_id}\t#{@flywheel_exec_id}'`(`-a` 必须——launchd 非 tmux 上下文要枚举全部 session;session_name 用于 linked alias 去重),按 **distinct window id** 合并 alias;同 exec id 出现多个 distinct window id 或 malformed 行 → 该 exec **indeterminate**(不报 orphan 也不报健康)。**不按窗名匹配**(窗名是 `<issueId>-<runner>-<title>`;title 仅人读)。
5. **响应校验**:JSON parse + schema 必需字段(execution_id 等)+ 重复 execution id → fail-closed 本轮跳过;401/403/timeout/Bridge 不可达/URL 校验拒绝 → 本轮跳过 runner 对账 + `runner-roster-blind` episode 报警。
6. **孤儿判定**:active session 的 exec id 全局枚举无携带该 `@flywheel_exec_id` 的窗 → `runner-orphan|<exec_id 前 12>` 报警(episode 语义)。

**只读观察窗 → follow-up 单**(对 issue 原文「报警+挂只读观察窗」的显式偏离;§0 判断 4 给了理由)。follow-up 的启用契约在此钉死,照抄即可:身份键 = execution id;创建设 `@flywheel_orphan_exec_id` marker + 持久 receipt(exact window_id + tmux generation);内容 = 先钉死 durable log/rotation 契约再实现(绝不猜路径);**关闭授权** = 复用现有鉴权 `GET /api/sessions/:id`(需 harden:route 对 lookup 有 execution_id→identifier fallback,授权判定必须校验响应 execution_id 与 receipt **全等**,identifier 命中不算;apiToken 未配置时 middleware no-op 也要 fail-closed 处理)+ 显式不可逆 terminal allowlist;404/timeout/schema drift/`design_done` 一律 fail-closed 保留;roster「已有窗」判定排除 orphan marker 窗;重启后从 receipt 恢复 ownership。`mode=active` 中消失**不是**终态证据(`design_done` 可重采用)。

#### 报警 episode 语义(A 全域,修正 R1 #4)

现有 `_alert_cmux_cleanup` 进程内 latch 是 generation 域 + 64 上限,下游 lead-alert.sh eventId 是**永久** durable dedup——稳定 signature 恢复后无法再报。roster 报警(lead-window-missing / runner-orphan / runner-roster-blind / roster-derive-failed / config-drift)改用 **durable per-subject episode 状态**(参照既有 cmux flag transition latch 手法,`check_cmux_flag_state`):

- 每 subject 一行状态(state 文件,原子写):`<subject>|<episode_n>|<unhealthy|healthy>`;
- unhealthy 首见 → episode_n+1,发一次 alert,signature 含 episode_n(`lead-window-missing|<name>|e<episode_n>`)→ claims.db 每 episode 恰一条;
- 每轮对账即恢复检测:subject 回 healthy → 原子写回 healthy(latch 清除);再坏 = 新 episode 可再报;
- re-arm 规则逐 kind 写明(blind/derive-failed 同理);kind 复用现有 `cmux_cleanup`(shell+TS kind contract 不扩),新语义全在 signature。

**测试**:sourced-bash 单测——carrier matrix 闭集形态(标准 Claude / 标准 Codex→config-drift / allowlist TUI 含 **infra-bot 非 `*-tui*` 文件名回归例** / 未知组合→config-drift / 坏 manifest / plist 解析失败→零局部结论);episode 状态机(坏→报一次→恢复→再坏→再报);maintenance marker 每轮生效;**两相时序**(refresh 失败轮与空窗轮 R 相报警照发、M 相零 mutation;blocked view 零 mutation);**inventory 三态**(binary/IPC 失败、无 server、成功零窗、单 runner session 局部读失败、恢复后一轮——分别断言 episode 与零 mutation、subject 状态不批量翻转);A-Runner:URL 校验矩阵(非 loopback/带 path/userinfo 拒发 token)、token/URL key-specific 提取、curl --config stdin(argv 无 token 断言)、`-a` 枚举 + alias 按 distinct window id 合并、多 window id/malformed→indeterminate、schema/重复 exec id fail-closed、401/timeout blind episode。launchctl/plutil/curl/tmux 全打桩 + 真 tmux 沙箱段。

### WP-E1 收养竞态去重(rename-lag 双收养)

语义正名:`(generation,title)` 是「**一个逻辑可视槽位**」的唯一键(同 generation 内一个 title 至多一个 workspace),不是物理 tmux window 身份(系统允许同名 sibling,已有 highest-live-window winner 规则)。四处修改:

1. **新 helper** `ledger_rows_for_title <generation> <title>`:严格解析,返回 `prepared|committed` 两态行(现 `ledger_refs_for_title` 只见 committed,**看不见 rename-lag 留下的 prepared 行**——这是照旧实施仍会复现事故的根)。
2. **create 闸**(`create_workspace_for_window` 存在性检查后):`ledger_rows_for_title` 非空 → 不 new-workspace,log + return 0(prepared 行交 reconcile 补救,60s 内自愈)。
3. **唯一性进写事务**:`(generation,title)` 不同 ref 的冲突检查放进 `_ledger_transaction` **持有 inner lock 之后、写 tmp 之前**(:3168 upsert 分支内),不在外层 `_ledger_upsert` 先读后写(TOCTOU)。冲突 → 事务拒绝(return 1)+ alert `ledger-title-conflict|<title>|e<n>`(episode 语义)。fail-closed:调用方既有 WARN 路径接住,宁可 tab 迟 60s 不可双 tab。
4. **prepared 输家收尸 —— 专用 last-operation guard**(现有 close guard 只关 committed 行,unreceipted rollback 只授权 unnamed/provisional title,都不适用):`reconcile_prepared_ledger` 遇 prepared 行且同 (generation,title) 已有 **committed** 归属其他 ref → 走新 guard,一次性证明:当前 generation 未变 + exact prepared 行仍在 + exact committed owner 行仍在 + 输家 exact ref 仍存在且 observed title ∈ {provisional attach_cmd, 目标 title} → close + `_ledger_remove` + alert;任一证据缺 → 保留待下轮(fail-closed)。
5. **历史双 committed 检测(独立小项)**:reconcile pass 扫 committed 行按 (generation,title) 分组,>1 → **alert + 保守不动**(manual disposition)。不声称自动收敛——`dedup_workspaces_by_title` 在 ledger/invariant 模式明确直接返回,不能引为收尸路径;能从 exact attachment/source 证据证明 winner 的自动收敛留 follow-up。

**测试**:RED 基线复现(mock rename 首败:旧代码双 committed)→ 新代码单行且第二轮不 create;写事务内冲突拒绝(含并发注入);prepared 输家 guard 每一证据缺失分支;双 committed 检测只报不动。

### WP-E2 WAL 隔离(malformed 不再全局罢工;分型不降级)

**改** `recover_all_view_constructions`(:3572)——结果**分型**,不复用单一 rc=1:

| 分型 | 判定 | 处置 |
|------|------|------|
| `recovered` | 单文件恢复成功 | 继续 |
| `syntactic_malformed` | 纯语法/文件名身份问题(非单行 / 字段≠9 / 前缀不符 / 文件名≠身份 hash)——**循环层自查,不进 recover_view_construction** | `mv` 至 `$VIEW_WAL_DIR/quarantine/<原名>.<epoch>.$$`(mv 失败→原地保留+按 indeterminate 处理)+ alert `wal-quarantined|<file>|<sha 前 8>`(episode 语义)+ continue |
| `known_collision_preserved` | canonical view collision(已完整证明,WAL 应保留) | 保留 + 该 view/title 入本轮 **blocked set** + continue |
| `indeterminate_abort` | 一切其余 rc=1(generation 读失败 / WAL 读失败 / guard / rename / cleanup 失败) | **中止整轮**(现行为,fail-closed 不动) |

- **blocked set**:本轮后续 `reconcile_prepared_ledger` / `reconcile_keeper_inventory` / `repair_view_invariants` / create 对 blocked view/title **零 mutation**(其余 view 正常前进)——保住「该记录授权零 mutation」边界,同时不再让一个 collision 拖死全场。
- quarantine 目录在 `*.wal` 枚举之外,天然不再授权任何 mutation;文件保留取证。
- `recover_view_construction` 单文件内部语义**不动**;它需要把 collision 与其他失败可区分地返回(rc=2 for collision,或输出通道),实现取最小侵入方案。
- 逃生口:`FLYWHEEL_CMUX_WAL_QUARANTINE=0` → 旧行为(默认 `1`)。

**测试**:四类 syntactic malformed 注入→隔离+报警一次+**其余 WAL 与当轮 create 照常**(对照旧代码整轮 skip 的 RED 基线);collision→保留+blocked set 生效(该 view 零 mutation、他 view 前进);逐一注入 generation read / WAL read / rename guard / stage cleanup 失败→整轮中止且零 mutation。

### WP-D tmux server 防复发(取证=WP-0)

**单一挂载点**:keepalive policy **只**落在 `scripts/lib/tmux-server-rescue.sh` 的 socket lock 内——提取 `_tmux_rescue_policy_postcondition`(① `set-option -s exit-empty off`;② `has-session flywheel-keepalive || new-session -d -s flywheel-keepalive`;③ 对同一 reachable server PID 做前后验证),`_tmux_socket_ensure_locked` 的**每个 success 出口**(verified/created/rescued×2)统一经它返回;postcondition 失败 → fail-loud(alert + 非 success rc,调用方既有 hold 路径接住)。

- **watcher 不在锁外另写 tmux**:watcher/bootstrap 不加 keepalive 逻辑。生效路径 = 每次 runner spawn 的 ensure(TmuxAdapter → rescue CLI)+ rollout 一次显式 seed。理由:watcher 与 rescue 双写需要跨进程共享 socket lock,收益(提早几分钟种上)不抵复杂度。
- **新增 CLI 子命令 `tmux-server-rescue policy-enforce <socket>`**:同样取得 socket lock,只跑 policy postcondition(现 CLI 的 `ensure` 要求完整 `--verify/--create` argv,裸 `ensure <socket>` 会 rc=64 打 usage——不能当 seed 命令)。operator seed 与测试都走它。
- **新 verb 完整接入锁观测链(不留半截)**:rescue 框架多处把 verb 写死为 `ensure|recover` 闭集——lock instrumentation(`_tmux_rescue_prepare_lock_instrumentation`)、pending decision replay、owner evidence、`_tmux_rescue_run_with_lock` dispatch、usage。`policy-enforce` 必须加入**上述全部闭集**,拥有自己的 acquisition/decision receipt、crash replay 与长持锁报警语义(选「新 verb 全接入」而非映射到 ensure 的 instrumentation——审计里 policy seed 与真 ensure 必须可区分)。server unreachable → nonzero + 零 mutation。
- keepalive session 不在 `flywheel`/`runner-*` 名字空间 → watcher 与 roster 天然无视,零 tab 噪音。
- 逃生口:`FLYWHEEL_TMUX_KEEPALIVE=0` = **停止 enforcement,非状态回滚**(已持久化在 server 上的 `exit-empty off` 与 sentinel 不自动还原)。真回滚 = 显式 operator 动作(runbook:验 sentinel ownership + server 空载检查后 `kill-session -t flywheel-keepalive` + `set -s exit-empty on`),不做自动化。

**测试**:两个全新独立 socket——(a) enforcement on:ensure/policy-enforce 后杀光业务 session,server 存活;(b) `=0`:全程不写 option/不建 sentinel(旧行为,server 退出)。postcondition 失败注入 → 非 success rc;`policy-enforce` 子命令:互斥锁、acquisition/decision receipt、pending replay/长持锁报警、server unreachable → nonzero + 零 mutation。

## 2. 新增 env flag 清单(FLY-1412 治理:登记 registry,含 owner/意图/退役条件)+ 传播表

registry 登记不等于进程读得到——每个 flag 写明 process owner / 读取点 / 优先级 / 非法值 fallback / 生效边界。autostart 的 key-specific 解析器(`load_cmux_bool_flag` 手法)扩展复用,**绝不 source 整个 .env**;值与 token 分开校验(bool 只认 0/1,token 只认非空单行)。

| flag | 默认 | owner 进程 | 读取点 | 优先级 | 非法值 | 生效边界 |
|------|------|-----------|--------|--------|--------|---------|
| `FLYWHEEL_CONVERGE_CMUX_SYMLINK` | 1 | converge(mount 调用方 shell) | converge 自身 env | env only | 按 1 | 下一次 mount 运行 |
| `FLYWHEEL_CMUX_AUTOSTART_EXEC` | 0 | autostart | inherited > .env(key 解析器) | 同左 | 按 0 | 下一次 autostart 调用 |
| `FLYWHEEL_CMUX_ROSTER` | 1 | watcher | inherited > .env(autostart 解析后 export,launchd 路径同) | 同左 | 按 1 | watcher kickstart |
| `FLYWHEEL_CMUX_WAL_QUARANTINE` | 1 | watcher | 同上 | 同左 | 按 1 | watcher kickstart |
| `FLYWHEEL_BRIDGE_URL` / `TEAMLEAD_PORT`(非新增) | `http://127.0.0.1:${TEAMLEAD_PORT:-9876}` | watcher(A-Runner) | .env key 解析器 | inherited > .env | 校验不过→blind episode,拒发 token | 每轮 |
| `FLYWHEEL_TMUX_KEEPALIVE` | 1 | tmux-server-rescue(Bridge spawn 上下文 + operator shell) | rescue lib env;Bridge 侧经 TmuxAdapter 继承 Bridge env(.env 由 Bridge wrapper source) | env only | 按 1 | 下一次 ensure |
| `TEAMLEAD_API_TOKEN`(非新增) | — | watcher(A-Runner) | .env key 解析器,调用点局部读 | .env only | 缺失→A-Runner blind episode | 每轮 |

(R1 版的 `FLYWHEEL_CMUX_RUNNER_ROSTER_STATES` **取消**——状态口径随 `/api/sessions?mode=active` 契约,不留可配错的自由度。E1 为纯正确性修复,不设 flag。)

## 3. 测试与验收矩阵

| issue 验收 | 证明方式(真机 QA 段) |
|-----------|----------------------|
| ① 杀 Lead tab/窗 ≤2min 重建或报警 | 杀 tab→下轮 additive 重建计时;杀窗→claims.db 出现 `lead-window-missing|…|e<n>` 计时;恢复后再杀→e<n+1> 再报;两路 ≤120s |
| ② 3 路径并发触发单实例 | 同时 launchd kickstart + .zshrc 卫兵 + 手动 `--watch`;`pgrep -f 'cmux-sync.*--watch'` 恒 1;卫兵路径日志显示未 exec |
| ③ 改 repo 合并→部署同步 | 生产 bin 为 symlink 后天然成立;QA 注入:换回副本→跑 converge→断言 symlink 恢复 + 留档落位 + alert 一条 |
| ④ 死因报告+防复发落地 | evidence/ 链 + forensics.md 交付;keepalive 沙箱杀-last-session 存活 |
| ⑤ rename-lag 永不双收养 | mock rename 卡死复现→单 committed 行、单 tab;RED 基线对照 |
| ⑥ 坏 WAL 报警+隔离+继续建 tab | 注入坏 WAL→quarantine 落位 + claims.db 报警 + 同轮新窗 tab 照建 |

单测/harness:bash sourced 单测(watcher 函数级)、hermetic converge suite、autostart flags suite、真 tmux keepalive 测试(独立 socket ×2);全部 `/bin/bash`(3.2)`bash -n` + 现有 `scripts/__tests__` 通道进 CI。全仓 gate:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(本单不改 TS 包,预期只有既有基线)。

## 4. Rollout / 运维序列(merge 后)

0. (已在 WP-0 完成)证据保全不依赖部署。
1. merge → 生产 main checkout `git pull`。
2. 首个 converge mount(或手动 `scripts/converge-flywheel-bin.sh`)→ bin 两脚本换回 symlink(alert 各一条 + `.bak-shape-*` 留档,runbook 注明为预期)。
3. **一次受控** `launchctl kickstart -k gui/$UID/com.flywheel.cmux-watcher` → 新 watcher 上线。验收:watcher log 打印生效 flag 值 + `pgrep` 单实例 + 首轮 roster 对账日志。
4. keepalive seed:`tmux-server-rescue policy-enforce /tmp/tmux-<uid>/default`(新子命令,裸 `ensure <socket>` 缺 `--verify/--create` argv 会 rc=64 打 usage,不能用)。验收:命令 rc=0 + 前后同一 server PID + `show-options -s exit-empty` = off + `has-session -t =flywheel-keepalive` 成功。

(R1 版第 4 步「重跑 installer / --shell-only」**删除**——.zshrc integration 调用的就是 installed autostart 路径,symlink 恢复后行为自动更新;重跑完整 installer 反而有 bootout/bootstrap 与偏好写副作用。)

回滚:各 flag 旁路 + `kickstart -k`;keepalive 为「停止 enforcement」,状态回滚走 runbook 显式 operator 动作;C 项极端回滚 = `FLYWHEEL_CONVERGE_CMUX_SYMLINK=0` + 从 `.bak-shape-*` 手工还原(不推荐,runbook 记载理由)。

## 5. 风险清单(承接 research §7,R1 后更新)

- converge 换 symlink:留档先行 + 原子 mv,canonical path 无缺口;并发 mount 幂等。
- roster 误报:job 未加载不入册、维护 marker 每轮把关、durable episode 单发——三层;首周观察 claims.db 量。
- A-Runner 契约漂移(FLY-1374 并行):本版锁 `mode=active` 现契约 + fail-closed 校验;1374 若改 endpoint/状态语义,roster 侧只需跟随 endpoint(无本地口径 flag 可配错)。
- observer 窗移出本单 → 本单对既有窗零 mutation 新面;follow-up 落地前 runner 孤儿只报警不代偿(honest boundary)。
- watcher bash 面改动纪律:只加函数/只在列明行位插闸,禁止顺手重构;每 WP 独立 commit。

## 6. 顺序与工作量

W0 取证保全(0.5d,**最先**)→ C(0.5-1d)→ B(0.5d)→ E2(1d,含分型)→ E1(1-1.5d)→ A-Lead(1.5d)→ A-Runner 侦测报警(1d)→ D 防复发(0.5d)+ forensics 结论成文(0.5d,可并行)。observer 观察窗 = follow-up 单(启用契约已钉死于 §1)。单 PR 交付(同一系统,Annie 拆单原则),按 WP 分 commit;evidence/ + forensics.md 随 PR。含真机 QA 配合总计 ≈ 6-7 个工作日。

## 7. 变更记录

- R1(Codex design review,gpt-5.6-sol xhigh,CHANGES REQUESTED,8 findings)全部采纳:#1 carrier matrix 取代 wrapper 文件名过滤 + headless=config-drift 报警 + fail-loud 零局部结论;#2 A-Runner 契约全部改为现 HEAD 事实(exec_id/@flywheel_exec_id、mode=active 状态集、Bearer token 载入、fail-closed 校验),状态口径 flag 取消;#3 observer 窗 exec-id 身份 + marker/receipt mutation authority + 默认关;#4 durable per-subject episode 报警语义 + 维护 marker 每轮把关 + 复用 cmux_cleanup kind;#5 E1 改为 prepared 可见 helper + 写事务内唯一性 + prepared 输家专用 guard + 历史双行只报不动;#6 E2 结果分型(quarantine 仅限 syntactic,collision 入 blocked set,不确定性仍整轮中止);#7 取证升 W0 证据保全 + keepalive 单锁内挂载点 + flag 语义改「停止 enforcement」;#8 flag 传播表 + C 项留档先行原子序列 + 删 installer 重跑步骤。
- R2(CHANGES REQUESTED,4 HIGH + 1 MEDIUM)全部采纳:#1 carrier matrix 改闭集 allowlist(TUI 由运行时 env 驱动、manifest/plist 推断不出;infra-bot 非 `*-tui*` 文件名回归例;标准 wrapper+codex 一律 config-drift;未来标准 wrapper TUI 需先加 per-job carrier 字段);#2 A-Runner URL 安全契约(固定 loopback 默认 + 严格校验后才发 token)+ Bearer 经 curl --config stdin + `-a` 全局枚举/alias 按 distinct window id 合并/多 id indeterminate;#3 reconcile_roster 两相拆分(R 相 read-only 两分支恒跑,M 相复用 post-refresh create loop、过 WAL 闸与 blocked set);#4 observer 观察窗降级 follow-up(关闭授权依赖的鉴权 per-session read 端点不存在,启用契约钉死在 §1);#5 rollout 换 `policy-enforce` 新子命令(裸 ensure rc=64)+ 四项 seed 验收。
- R3(CHANGES REQUESTED,2 HIGH + 1 MEDIUM)全部采纳:#1 R 相新增 typed inventory seam(`ok_nonempty|ok_empty|indeterminate`;`get_tmux_agent_windows` 的 `|| true` 读失败≡空不可喂 roster;indeterminate 只发 blind episode、保留 subject 状态、零批量翻转);#2 observer 切单理由更正为真实依据(启用前提未完成的主动切单;`GET /api/sessions/:id` 已存在,follow-up 复用并 harden execution_id 全等 + token-unset no-op caveat——原「端点不存在」是我方事实错误,已当场核源码纠正);#3 `policy-enforce` verb 全量接入 rescue 锁观测闭集(instrumentation/replay/owner evidence/dispatch/usage),不映射 ensure,审计可区分。
