# FLY-1944 宿主终端链收口 · 第二轮 — 调研

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21
基于: exploration.md(第二轮)

> 方法:三路并行只读审计(#912/#907 已合入面 / cmux app 控制面 / 在飞撞车面)+ 本 runner 宿主只读实测与事故窗日志取证。承重断言均带 文件:行号 或 [实测 2026-08-21];审计 agent 的两条关键断言经本人复核后**一条被推翻**(见 §5.1),引用时以本文为准。
> 行号基线 = `d97bd1173`(main,含 #912+#907)。`flywheel-cmux-sync.sh` 在 #907 中 +2278 行,任何早于它的行号引用已作废。

## 0. 会过期的结论表(续接者先读)

| 结论 | as-of | 重核命令 |
|---|---|---|
| **13 个存量 v2 Lead workspace 每 pass 被 `unreceipted same-title workspace preserved` 挡回,heal 不可达**(仅 workspace:107 flywheel-eng-lead 有 committed receipt) | 2026-08-21 15:20 PT 日志仍在刷 | `tail -400 /tmp/flywheel-cmux-watcher.log \| grep unreceipted`;`cat ~/.flywheel/state/cmux-view-ledger \| grep lead` |
| **growth-mufasa-lead / flywheel-codex-infra-bot-lead(codex 载体)在 cmux 无任何 tab**;12:05 PT 窗曾被 stale prepared 行(`Terminal 34/38` drift)占槽拒建,cmux generation 更替后 rename-lag 消息停了,但 tab 仍未出现 | 2026-08-21 15:2x PT | `cmux --json list-workspaces \| grep -E "mufasa\|codex-infra"`;`grep Rename-lag /tmp/flywheel-cmux-watcher.log \| tail` |
| 12 个 `flywheel-view-attach.sh cmux-FLY-202-*` 孤儿 helper 空转(cmux 中 FLY-202 workspace=0;几小时内 9→12 增长) | 2026-08-21 22:2xZ | `ps -axo command \| grep flywheel-view-attach \| grep -c FLY-202` |
| `/private/tmp/tmux-501/`:103 socket 文件,101 死;活 server 仅 `default`/`atlas`。宿主 `pgrep -x tmux` 总数 52(14 Lead 私有 + default + atlas = 16 可解释,~36 未归属) | 2026-08-21 22:0xZ | exploration.md §1 同行 |
| `respawn-pane` 在 cmux 0.61.0 (73) `--help` 存在(tmux compat),`capabilities` 139 method 无 `*.respawn`;FLY-1884 全程无真机生效实录 | 2026-08-21 | `cmux --help \| grep respawn; cmux capabilities \| grep -ic respawn` |
| deployed-sha=`d97bd1173`;watcher pid 6799(12:05:54 PT 起)心跳新鲜 | 2026-08-21 22:07Z | exploration.md §1 同行 |
| 在飞撞车面仅 #911(FLY-1940,Codex daemon 进程组/socket 收割);#772/#248 为僵尸 PR 勿当在飞 | 2026-08-21 | `gh pr list --state open --limit 60` |

## 1. 现状拓扑(founder 眼睛到 tmux 的完整链)

### 1.1 四层进程树(每个 cmux workspace surface)

```
cmux.app (pid 96759, 原生 macOS app, socket /tmp/cmux.sock)
 └─ /usr/bin/login
     └─ -/bin/zsh
         └─ helper:
              runner 镜像: /bin/bash ~/.flywheel/bin/flywheel-view-attach.sh cmux-<窗名>
              v2 Lead:     env -u TMUX ~/.flywheel/bin/flywheel-lead-attach.sh ~/.flywheel/sock/fw-*.sock
             └─ tmux attach-session(仅当目标 session 活着)
```

- helper 是 #907 引入的**常驻 2s 重连循环**(session 消失时显示「等待重建后自动重连…」),对 session 重建免疫——也因此对「workspace 已关」免疫:**无退出条件,孤儿全靠外部回收(现在没有)**。
- **存量并存三代载体**:①最老的一次性裸 `tmux attach -t '=cmux-…'`(workspace:93/94/103 标题仍是命令原文);②`env -u TMUX tmux -S <sock> attach` 一次性 Lead 形态(13 个存量 Lead tab);③helper 化(#907 后新建的)。#907 只改了**新建**路径的命令构造(`build_attach_command:3572` / `build_lead_attach_command:3610`),存量不迁移。

### 1.2 账本与 roster(「应该存在什么」的四个权威,无单一 registry)

| 权威 | 位置 | 管什么 |
|---|---|---|
| view-ledger | `~/.flywheel/state/cmux-view-ledger`(`flywheel-cmux-sync.sh:99`) | 窗镜像 workspace 收据,行 = `prepared\|committed \| generation \| ref \| title`。实测 22 committed + 1 prepared |
| node-registry/ledger | `cmux-node-registry` / `cmux-node-ledger`(`:117-118`) | FLY-1884 node 占位 tab(仅 runner execution,不含 Lead) |
| Lead roster | launchd `com.flywheel.lead.*.plist` → `derive_lead_roster()`(`:617`) | v2 Lead 应有集,行 = `carrier\|label\|expected-title\|socket` |
| runner roster | Bridge `GET /api/sessions?mode=live`(`bridge/tools.ts:148-160`) | 活 runner 节点(六态投影,FLY-1884 修正过 `mode=active` 漏 `pending/design_done` 的坑) |

cmux 自己的唯一持久态:`~/Library/Application Support/cmux/session-com.cmuxterm.app.json`(schema 含每 workspace 的 `processTitle` = **surface 启动 argv 全文**;实测 40 行与 `list-workspaces` 一致,mtime 新鲜)。**这推翻了 FLY-1884 research.md:120-129「无法证明 surface ownership」的 hard-gate 结论**——写盘时机未知,不能当实时源,但可当 ownership 佐证。app 不落地任何本地日志(全盘搜索空;遥测走 Sentry/PostHog 远端);可 tail 的只有 `/tmp/flywheel-cmux-watcher.log`(transition-only,静默是常态)。

## 2. 事故取证(第二轮立单的三个现场,全部有日志/进程证据)

### 2.1 19:1xZ Lead tab 空白 — 根因链已定位:**preserve 守卫把全部存量 Lead 锁在 heal 之外**

`ensure_v2_lead_workspace`(`flywheel-cmux-sync.sh:3765`)对已存在的同 title workspace:

```
state=$(ledger_candidate_receipt_state ...)        # 存量 stock 无 receipt → "none"
if [[ "$kind" == "named" && "$state" == "none" ]]; then
  log "WARN: unreceipted same-title workspace preserved for v2 Lead $title"
  return 0                                          # ← 在 _v2_lead_heal_surface 之前返回
fi
```

- 注释写明设计意图:「named 且无收据的行可能是 founder 自己的 workspace,只有 exact raw helper 语法才够格 mint ownership」——但存量 13 个 Lead tab 是 pre-#907 的一次性 `env -u TMUX tmux -S <sock> attach` 形态,**不匹配 helper 语法 → 永远 preserve**。
- 事故窗(12:05-12:06 PT)与此刻(15:20 PT)日志均在刷全部 13 个 Lead 的 WARN,~90s 一轮 [实测]。
- `_v2_lead_heal_surface`(`:3688`)本身是完整的五分类(healthy / missing / bare / no-pty / unclassified)+ `recover_attach_surface v2` 修复;判空信号 = `tmux -S <sock> has-session` + `_private_session_client_count`+`surface_looks_like_bare_shell`。**代码在,可达性为零。**
- 结论:19:1xZ「workspace 在册、surface 在、连接死」的 Lead tab,watcher 每 90 秒看一眼、每次都说「可能是 founder 的,不动」。founder 手工重建的新 tab(workspace:107 flywheel-eng-lead)反而拿到了 committed receipt,成为唯一受 heal 保护的 Lead tab [实测:view-ledger 仅此一条 lead 行]。

### 2.2 次级现场:stale prepared 行占槽,codex 载体 Lead 无 tab

12:05 PT 窗:`WARN: prepared ledger title drift ref=workspace:52/53/54 expected=<真名> observed=Terminal 38; preserving` + `Rename-lag receipt already owns logical slot; create deferred`(`growth-mufasa-lead` / `flywheel-codex-infra-bot-lead` / 三个 runner 名)[日志 7169-7176]。cmux generation 更替(app 重启)后 rename-lag 消息停止,但 **mufasa / codex-infra-bot 至今在 cmux 无任何 tab** [实测 list-workspaces]。#907 修的是新建路径的 `Terminal N` 异步命名竞态;**陈旧 prepared 行的老化/清算没有出口**(prepared 行只在同 generation 内被处理,drift 即 preserving,永不转移永不放槽)。FLY-1884 research 早记过同形态(workspace:52「每 90 秒刷一次 preserving,Mufasa 至今没有 tab」),跨两轮未愈。

### 2.3 helper 孤儿泄漏(A5)与 socket 残骸(A6)

- close 路径唯一 chokepoint `close_workspace_by_ref`(`:2019`):关前重重设防(guarded IPC/generation pin/freshness fence),**关后只看 rc 且默认模式恒返 0**(真 rc 在全局 `LAST_WORKSPACE_CLOSE_RC`);零 post-close 复验、零进程回收。
- 实测:12 个 `flywheel-view-attach.sh cmux-FLY-202-*` 孤儿(QA sandbox fixture 持续铸造),4 层树上三层幸存,2s 空转;宿主共 23 view + 15 lead helper,cmux 只有 40 workspace。
- census 库 `scripts/lib/cmux-mutator-process-census.sh`(FLY-1482)有三态纪律(rc=0 argv 已验证 / 1 消失 / 2 进程表不可信 fail-closed),**但谓词只认 watcher 自身**,不认 attach helper;仓库无任何 helper 回收逻辑 [grep 全仓]。
- socket:`/private/tmp/tmux-501/` 103 文件 101 死;log-janitor(FLY-1330)模块清单不含 socket;`restart-services.sh:270 audit_tmux_qa_residue_read_only` 只读审计并明写「不清理」,allowlist=`default`+`atlas`;52 个活 tmux server 中 ~36 个未归属(可能持有已删 socket 的僵尸 server)。cutover 工装 `inventory_tmux_servers`(`host-terminal-cutover.sh:326`)已有 ps lstart + lsof -U + file 三证 census 可复用。

## 3. #912/#907 已合入机制审计(round-2 依赖面)

### 3.1 #912(第一轮 W1/W3/W4 + W2 工装)——全部 SHIPPED,生产已生效

| 件 | 机制要点 | 位置 |
|---|---|---|
| watcher 心跳 | 纯 bash `printf > heartbeat`,写点:bootstrap/每 tick/backoff/park 限频 | `flywheel-cmux-sync.sh:11124` 等 |
| cmux IPC 硬墙钟 | `_cmux_bounded_spawn`(进程组 TERM→KILL,ping 10s/call 20s) | `:293` |
| 事件切片睡眠 | 健康态 3s 切片探 `$EVENT_FILE`(零 fork) | `:10034` |
| rider 看门狗 | GatePoller 60s 拍,`classifyCmuxWatcher` 8 分支安全矩阵,仅 `stalled`(心跳>300s+owner exact 验证)敢 recover;recover = tuple-bound TERM→launchd KeepAlive 重生 | `bridge/cmux-watcher-patrol.ts:96/378/565`、`plugin.ts:8274-8311`、`scripts/lib/restart-cmux-watcher.sh:126` |
| 镜像补开(A4) | `sync_additive`(`:9020`)每 4 tick(60s)全量状态对账,孤儿 `runner-*` 窗会被补开(非纯 event-driven);边界:只扫默认 server、上游 inconclusive 整轮 defer、`get_tmux_agent_windows` 读失败折空列表(`:551`,PR-1b 待改) | `:9020-9095` |
| W4 TUI 重试 | 10 attempts/5s-15s-60s-300s/30min episode(跨重启续算 `session.json.tuiWindowEpisodeStartedAt`);终局 `tui_window_lost` warning,run 不中断;**侧栏无降级标记**(node tab 不消费该事件) | `CodexTmuxAdapter.ts:107-122/621`、`plugin.ts:8759-8774` |
| W3 brew 护栏 | restart-guard P5(PreToolUse hook),runner(有 `FLYWHEEL_EXEC_ID`)deny、Lead/founder 放行+audit;QA 返工后 19 变形全 deny;边界:Codex runner 不走 Claude hook(沙箱 writable-roots 兜) | `scripts/hooks/flywheel-restart-guard.py:307-415/811` |
| W2 工装 | cutover 9 步 runbook + 双时钟预算闸 + 两次稳定零 quiescence + 回滚闭包实演;mutation 全部 operator 手打;无生产代码硬编码旧 tmux 路径 | `scripts/host-terminal-cutover.sh` |

### 3.2 #907(FLY-1884)——round-2 直接建在其上的机制

| 机制 | 要点 | 位置 |
|---|---|---|
| surface 自愈状态机 | `recover_attach_surface`:A 类 bare(注 attach)/ B 类 no-pty(`not a terminal` → dead-letter + `respawn-pane --command <canonical>`)/ C 类 unclassified(零 mutation 观察,连续两次 determinate + min-age 才转红「连接失效 · 点击重连」);持久重试表 `_attach_state_*` | `flywheel-cmux-sync.sh:3369` 族 |
| v2 Lead heal | `_v2_lead_heal_surface` 五分类 → `recover_attach_surface v2`;**被 §2.1 preserve 守卫挡在存量之外** | `:3688` |
| view-attach helper | 常驻 2s 重连,`has-session -t '=name'` exact 名;声明绝不 create/rename/destroy 权威 session | `scripts/flywheel-view-attach.sh` |
| node 占位 tab | `reconcile_node_presence`(`:1674`):runner execution 的 `node:<alias>·<hash>` tab,连续 2 轮同向证据才翻态;TTL 24h/cap 30 只管 summary 类;**只覆盖 runner,不含 Lead** | `:1674-1736` |
| create 事务 | UUID 授权(`--id-format both`)、`_prepared_rename_guard` 接受集修过 `Terminal N` 竞态;**遗留缺陷自记**:「`new-workspace` rc=0 不当活 pane 成功」= create 无活体验证(FLY-1884 plan.md:185);stale prepared 行无老化出口(§2.2) | `:4939` 族 |
| close 清洁度栅栏 | `node_cleanup_freshness_allows` mutation-boundary 三态 fence;**验收口径已写死**:单 tab 关闭 = 该 surface helper 的 per-PID census,全局零残留只作全量 teardown 断言(FLY-1884 plan.md:160)——**口径在,实现不在** | `:1319/:2896` |

## 4. 判空/修复信号可信度表

| 信号 | 等级 | 依据 |
|---|---|---|
| `tmux -S <sock> list-clients` 计数(v2)/ `view_session_client_count`(v1) | **PROVEN** | verify-sidebar `rule=v2-client-count`(`:9564`)/`rule=client-count`;fail-closed on rc≠0 |
| `#{pane_dead}|#{pane_pid}` pane 身份 | **PROVEN** | `rule=v2-pane`(`:9553`)/`rule=pane-identity`(`:9647`) |
| `read-screen` 末行 bare 判定 | **PROVEN** | `surface_looks_like_bare_shell:3040`;盲区:全空屏/死画面→非 bare 非 no-pty→unclassified |
| 标题 `^Terminal [0-9]+$` / `~` | **PROVEN** | B1 默认名识别(#907);一次 `list-workspaces` 可判,最廉价外部信号 |
| view-ledger receipt 状态 | **PROVEN** | `rule=receipt`/`rule=v2-receipt` |
| `respawn-pane` 修复原语 | **存在未证** | `--help` 有(tmux compat);`capabilities` 无 `*.respawn`;无实录。fallback 候选:`close-surface`+`new-surface`(均在 `--help`,保 workspace ref) |
| `surface-health` | **陷阱** | `in_window` 只对当前选中 workspace 为 true(39/40 健康 workspace 均 false);不带 `--workspace` 只返回当前 1 行 [实测] |
| `sidebar-state` / `identify` / `list-windows` / `wait-for` / `log`/`notify`/`set-progress` | SPECULATIVE | cmux `--help` 有、仓库零引用;机会点非依赖 |
| `session-*.json` `processTitle` ownership | SPECULATIVE | §1.2;写盘时机未知 |
| helper 进程 argv census | SPECULATIVE→本轮落地 | census 库三态纪律现成,加谓词即可 |

**判官复用**:`--verify-sidebar`(FLY-1596,#778 已合,`:9184-9730`)= 12 规则双快照只读判官,v1/v2 全覆盖。round-2 一切「修好了没有」以它为验收面,不造第二个 verifier。

## 5. 审计更正与撞车面

### 5.1 对审计 agent 断言的两条复核更正(引用以本文为准)

1. ~~「respawn-pane 不在 cmux --help 中,疑似幻影命令」~~ → **实测存在**(`cmux --help` 三行:`new-surface`/`close-surface`/`respawn-pane`;`cmux respawn-pane --help` 返回 tmux compatibility 说明)。风险降级为「存在但无生效实录」,设计仍按「先探测再依赖 + fallback」处理。
2. ~~「Lead workspace 完全没有 surface 修复代码」~~ → 代码**有**(`_v2_lead_heal_surface:3688`),但被 preserve 守卫挡在全部存量之外(§2.1),生产行为等效于无。修向从「新建 heal 路径」变为「**打通可达性(存量收编/adoption)**」——改动面小一个量级。

### 5.2 撞车面(与 exploration §6 一致,补充证据)

- **#911(FLY-1940,在飞)**:Codex daemon 进程组收割 + IPC socket 生死(`reapCodexDaemonForExecution` 等);其评审明确否决过「复制较弱 ownership 逻辑」——S2 的 helper 谓词(argv=attach helper 脚本)与其(argv=codex daemon)天然不相交,零接触。
- FLY-1596(#778)/FLY-1482(#768)/FLY-1605(#763)/FLY-1672(#800)均已合;CLAUDE.md 里程碑对 1482/1596 的「⏳ PR pending」为陈旧文案。FLY-1672 plan 明示 `select_live_view_window` / `refresh_linked_sessions` 的同类 stale-window race「留给后续单」= 本轮合法接管;其 QA 遗留两洞:201 条 event 排空 95s(>60s additive 周期)、真实 restart-services 后 5 分钟恢复未验证。
- FLY-1929 D② = 第一轮 plan 的 PR-1b(D1e),规格在 `plan.md`(第一轮)§6,三项目标改动逐一验证均未落地;#912 的 bounded-spawn watchdog fork 已计入其基线口径。

## 6. 缺口 → 工作面映射(设计输入终表)

| 缺口(exploration §3 编号) | 根因(本文) | 工作面 |
|---|---|---|
| A1 Lead tab 重启波不恢复 | §2.1 preserve 守卫锁死存量 + 存量载体是一次性 attach | S1a/S1b(存量收编 + heal 可达)|
| A2 app 存活期 surface 空掉 | unclassified 盲区(全空屏/死画面)+ respawn-pane 未证 | S1c(0-client 决定性信号入分类 + 原语能力探测)|
| A3 新生空壳 | create 无活体验证 + stale prepared 占槽无老化 | S1d + S1e(prepared 清算)|
| A4 复活体无镜像 | 已覆盖(sync_additive),旧字节事故 | 回归测试钉住即可 |
| A5 close 后进程残留 | 零 post-close 回收 + helper 无退出条件 | S2 |
| A6 孤儿 socket | 无 janitor | S3 |
| A7 启动宽限 | 已覆盖(C 类 min-age) | 红线约束继承 |
| A8 TUI-lost 侧栏标记 | node tab 不消费 episode | S4(小件可砍)|
| 19:19Z 考题 | 上述总和 + FLY-1672 遗留 race | S5(验收面 + race 接管)|
| B1 PR-1b | 未发货,规格现成 | 不并入本 PR,显式登记(开放问题①)|
