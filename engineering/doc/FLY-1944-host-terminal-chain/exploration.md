# FLY-1944 宿主终端链收口 · 第二轮 — 探索(接线员段 + 看门狗段追加验收)

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21
基于: qa-report.md(第一轮 QA)、第一轮 exploration/research/plan(已随 PR #912 合入 main)、Linear issue Done 后追加的 4 条 founder/Cass comment(17:22Z / 18:27Z / 19:19Z / 21:50Z)

> 第一轮文档(exploration/research/plan/qa-report)是 PR #912 的历史记录,原文已在 git 历史与 main 上。
> 本文件起,同名文档承载**第二轮**(本 run 776fe2a3,tpl_code DAG:design→implement(codex)→qa→founder_gate→land)。

## 0. 一句话

第一轮把「tmux 窗口 → cmux 镜像会话」这半条链修硬了;founder 在 issue Done 之后用当天三次真实事故把验收总口径收窄到**最后一厘米**——「cmux app 里 founder 眼睛真正看到的那块 surface」:任意重启波后全部 tab(Lead + runner + 一切在册 workspace)自动恢复或显式标记失效+自动重建、app 存活期间 surface 空掉要自愈、close-workspace 后进程树要归零、孤儿 socket 要回收。第二轮就做这最后一厘米,外加把第一轮遗留的 PR-1b(fork 优化)与运维段(W2/W5)的边界重新登记。

## 1. 会过期的结论表(续接者先读)

| 结论 | as-of | 重核命令 |
|---|---|---|
| deployed-sha = `d97bd1173`(含 #912+#907),生产 watcher pid 6799 跑新字节、心跳新鲜 | 2026-08-21 22:07Z | `cat ~/.flywheel/deployed-sha; pgrep -fl "flywheel-cmux-sync --watch"; cat ~/.flywheel/state/cmux-watcher-heartbeat` |
| tmux 仍全 3.5a(`/usr/local/bin/tmux` 唯一 link),W2 运维窗口未执行 | 2026-08-21 | `which -a tmux; tmux -V` |
| W5 playwright cutover 未执行(`playwright@claude-plugins-official=true`,receipt 不存在) | 2026-08-21(round-1 QA §4) | `grep playwright ~/.claude/settings.json; ls ~/.flywheel/state/mcp-on-demand*` |
| `/private/tmp/tmux-501/` 103 个 socket 文件,其中仅 `default`/`atlas` 有活 server,101 个死文件 | 2026-08-21 22:0xZ 实测 | `for s in /private/tmp/tmux-501/*; do tmux -S $s list-sessions >/dev/null 2>&1 && echo live $s; done` |
| 宿主 `pgrep -x tmux` = 52 个活 server(≫ 14 Lead 私有 + default + atlas,存在未归属 server) | 2026-08-21(审计 agent 实测) | `pgrep -x tmux \| wc -l`;逐 pid `lsof -U -a -p <pid>` 归属 |
| **12 个** `flywheel-view-attach.sh cmux-FLY-202-*` 孤儿 helper 空转,cmux 中 FLY-202 workspace = 0 | 2026-08-21 22:2xZ 本 runner 独立复核 | `ps -axo command \| grep flywheel-view-attach \| grep -c FLY-202; cmux --json list-workspaces \| grep -c FLY-202` |
| `respawn-pane` 在 cmux 0.61.0 `--help` 中**存在**(tmux compat 命令),但 `capabilities` 139 method 无 `*.respawn`,且无任何真机生效实录 | 2026-08-21 本 runner 实测 | `cmux --help \| grep respawn; cmux capabilities \| grep -i respawn` |
| cmux 存量 workspace 中仍有旧一次性裸 attach 语法(workspace:93/94/103)与残骸标题(`Terminal 29`、`~`) | 2026-08-21(审计 agent 实测) | `cmux --json list-workspaces` 看 title;`cmux read-screen --workspace <ref>` |
| FLY-1482(#768)、FLY-1596(#778)、FLY-1605(#763)、FLY-1884(#907)均已合入;在飞碰撞面只剩 **#911(FLY-1940)** = Codex daemon 进程组/socket 收割 | 2026-08-21 | `gh pr list --state open`;`git log --oneline --grep=<issue>` |
| CLAUDE.md 里程碑表中 FLY-1482/FLY-1596 仍写「⏳ PR pending」= **陈旧**,勿引用其状态 | 2026-08-21 | 同上 |

## 2. 为什么有第二轮(时间线)

| 时刻(Z) | 事件 |
|---|---|
| 08-21 17:23 | PR #912(第一轮 W1/W3/W4 + W2 工装)合入;issue 标 Done |
| 17:22 | founder comment:复活体 runner 窗口无 cmux 镜像,手工 `link-window` 补(事故发生在**旧字节**上) |
| 18:27 | Cass comment(1884 QA 定量):close-workspace 经常不回收进程(13 工作区 → 残留 8 helper + 8 shell);满负荷新 tab 有数秒空白渲染延迟 → 判空壳需启动宽限 |
| 18:29 | **PR #907(FLY-1884)合入**——给 `flywheel-cmux-sync.sh` +2278 行:surface 自愈状态机、node 占位 tab、view-attach 常驻 helper、close 清洁度栅栏 |
| 19:01 | 班车重启波,部署 `d97bd1173`(含 #912+#907);watcher 19:05:54 以新字节重启 |
| 19:1x | **founder 实测:Lead tab 挂死渲染空白**(workspace 在册、surface 在、底层连接死;Lead 进程未重启、tmux 会话活着),手工 `cmux new-workspace --command "tmux -S <lead socket> attach"` 补活。发生在**新字节部署后** |
| 19:19 | founder comment 下达**硬验收总口径**:任意重启波后 cmux 全部 tab(Lead+runner+一切在册 workspace)自动恢复或显式标记失效+自动重建;考题=「下一次真实班车重启后 founder 侧零手工、零空白 tab」。另点名 `/private/tmp/tmux-501/` 100+ 测试遗留 socket 回收 |
| 21:50 | Cass comment 收窄接线员段:cmux app 连续存活 25h45m,当天三次「坏」全部发生在 **app 存活期间的 surface/pane 层**;验收须覆盖三条独立路径:①重启波后全 tab 恢复 ②app 存活期间 surface 空掉→自动修复 ③新起 runner workspace 出生即空 |
| 21:59 | 本 run(776fe2a3)fresh dispatch,design 节点 = 本文档 |

**要点**:19:1x 的 Lead tab 空白发生在 #907 部署之后——不是「没部署」问题,是**结构性未覆盖**(见 §3)。

## 3. 验收条款 → 现状判定(三路审计 + 本 runner 复核)

| # | 验收条款(comment 出处) | 现状 | 证据要点 |
|---|---|---|---|
| A1 | 重启波后全部 tab 自动恢复——**Lead tab** 类(19:19Z) | **缺失(结构性)** | Lead workspace 走 `reconcile_lead_roster` / `reconcile_v2_lead_workspaces` 独立路径,只管「该有的 workspace 存不存在」,**没有 surface 健康修复**;`recover_attach_surface` 自愈状态机只扫 runner 镜像 ledger。判空信号(v2-client-count / v2-pane / v2-render)在 `--verify-sidebar` 里全部 PROVEN,但那是 operator 手动判官,不是自动修复环 |
| A2 | app 存活期 surface 空掉 → 自动修复(21:50Z ②) | **部分** | #907 已有 A(bare shell 注 attach)/ B(`not a terminal` → dead-letter + `respawn-pane`)/ C(不可分类零 mutation 观察)三分类。两个洞:(a) **`respawn-pane` 无真机生效实录**(`capabilities` 无 `*.respawn`,FLY-1884 无实测记录——若它 rc≠0,B 类修复从未生效);(b) 「渲染成功但内容已死」归 C 类 unclassified,永不修 |
| A3 | 新生 workspace 出生即空(21:50Z ③) | **部分** | 根因(cmux 0.61 异步默认命名 `Terminal N` 卡死 rename guard)#907 已修;但 FLY-1884 plan.md:185 自记缺陷:「`new-workspace` rc=0 不等于活 pane」——**create 路径至今无活体验证**。存量残骸(`Terminal 29`、`~`、旧裸 attach 语法 workspace)仍在生产 |
| A4 | runner-* 窗口无 cmux-* 镜像自动补建,含复活体(17:22Z) | **已覆盖(待回归证明)** | `sync_additive` 每 60s 全量状态对账会补开(`flywheel-cmux-sync.sh:9020`,非纯 event-driven);17:22Z 事故发生在旧字节上。边界:只扫默认 tmux server;上游 inconclusive 整轮 defer |
| A5 | close-workspace 后进程树归零 ≤60s(18:27Z) | **缺失** | 7 处 close 调用点关后只看 rc(且默认模式恒返 0),零 post-close 回收验证;本 runner 复核:**12 个 FLY-202 孤儿 view-attach helper 此刻空转**(2s 重连死循环,4 层进程树上三层全部幸存)。census 库(FLY-1482)有现成三态纪律但只认 watcher 自身,不认 attach helper |
| A6 | 孤儿 socket 回收(19:19Z) | **缺失** | 无任何组件清理 `/private/tmp/tmux-501/`(log-janitor 不覆盖 socket;restart-services 只读审计明写「不清理」);实测 103 文件 / 101 死;另有 52 活 tmux server 中 ~36 个未归属(需 census) |
| A7 | 空壳判定带启动宽限,防高负载误杀(18:27Z) | **已覆盖** | #907 C 类:连续两次 determinate round 且达 min-age 才转红;继承为红线约束即可 |
| A8 | TUI 开窗失败重试+可见标记(06:17Z/09:29Z,round-1 W4) | **已覆盖(标记部分)** | 重试梯子 10 attempts/30min episode(跨重启续算)已 ship;终局 `tui_window_lost` warning 告警已接;**cmux 侧栏上无降级标记**(node 占位 tab 不消费该事件)——founder 在侧栏看不出「这个体开窗失败正在重试」 |
| B1 | PR-1b / D1e fork·cache 优化(issue 正文①③,承诺自 FLY-1929 D②) | **未发货** | round-1 plan §6 规格完整、数据门控、「PR-1 合入后解锁」;三项目标改动逐一验证均未落;#912 反而给基线加了 bounded-spawn watchdog fork |
| B2 | W2 tmux 3.7c 运维窗口(founder-gated) | **工装齐,窗口未执行** | `host-terminal-cutover.sh` 9 步 runbook + 预算闸 + quiescence + 回滚闭包全部 ship;mutation 全部 operator 手打 |
| B3 | W5 playwright cutover(FLY-1867 硬门 or founder supersede) | **未执行(gate 未满足)** | 17:03Z 裁决:W5 分段留在本 issue 内追踪,不因 ship 关单 |

## 4. 第二轮的关键新证据(三路并行审计 + 本 runner 复核,细节见 research.md)

1. **Lead workspace 无 surface 修复路径**是 19:1x 事故的结构性解释:存量 Lead tab 的 surface 是旧的一次性 `tmux -S <sock> attach` 裸命令(#907 的 helper 化只作用于**新建**的 workspace);重启波杀掉 attach client 后 surface 掉回裸 shell/死态,而 Lead reconcile 只验 workspace 存在性 → 永不修。
2. **`respawn-pane` 是 B 类修复的承重单点且未经真机证明**。本 runner 实测:`cmux --help` 有它(tmux compat 命令),但 socket `capabilities` 139 个 method 无 `*.respawn`,FLY-1884 全程无实测记录。设计必须「先探测再依赖」:修复原语按运行时能力探测选择(`respawn-pane` → `close-surface`+`new-surface` fallback → fail-closed 观察),不许静默假设。
3. **helper 孤儿泄漏是此刻正在发生的实证**(12 个,且随 QA 活动增长):#907 的 2s 重连 helper 让 attach 对「session 重建」免疫,同时也让它对「workspace 已关」免疫——helper 没有任何退出条件,close-workspace/app 恢复路径也不杀它。回收必须外部做:census 库加 attach-helper 谓词 + per-PID 三态回收。
4. **`--verify-sidebar`(FLY-1596,#778 已合)是现成的 12 规则只读判官**,v1/v2 两条路径的判空信号全部 PROVEN。第二轮的自动修复环应**复用它的规则作判据、以它作验收判官**,不重造探测器。
5. **未归属 tmux server**:52 个活 server 中 default+atlas+14 Lead 只解释 16 个;其余 ~36 个(多为 QA 残留、socket 文件可能已删)需要 census 后纳入回收边界。cutover 工装里的 `inventory_tmux_servers`(`host-terminal-cutover.sh:326`,ps+lsof+file 三证)可直接复用。

## 5. 方向与备选(第二轮工作面 S1–S5)

设计红线继承第一轮(Tadashi/founder 口径):**简单优先 / 净删除优先 / 不加新告警层**(新 alert kind 走现有管道=允许;新守护 daemon/新通知通道=禁止)。新增一条(从 #907/#911 撞车面推出):**只调用已合入机制,不重写**;修它们的缺陷可以,平行造第二套不行。

### S1 — surface 自愈补全:Lead 纳管 + 存量收编 + 修复原语能力探测(核心,答 A1/A2/A3)

- **S1a Lead workspace 纳入 surface 自愈**:把 `recover_attach_surface` 状态机(或其同构最小子集)扩展到 Lead workspace 类。判空复用 verify-sidebar 已 PROVEN 的三信号(`tmux -S <sock> list-clients` 计数 / `#{pane_dead}|#{pane_pid}` / `read-screen` bare 判定),修复动作 = 把 surface 收编为 `flywheel-lead-attach.sh` helper 载体(与新建路径同构)。fail-closed:信号 inconclusive 不动。
- **S1b 存量收编(legacy stock migration)**:对仍跑旧一次性裸 attach 语法/残骸标题(`Terminal N`、`~`)的存量 workspace,经修复原语统一迁到 helper 载体。这一步同时消灭「(b) 类活残骸」并让下一次重启波的恢复全部走 helper 的 2s 自愈。
- **S1c 修复原语 = 运行时能力探测**:`capabilities`/`--help` 探测 → 优先 `respawn-pane --command <canonical helper>`;不可用则 `close-surface` + `new-surface`(保 workspace ref 不变);都不可用 → C 类观察 + 状态字,绝不静默。implement 的 TDD 必须含一次真机 positive control(自建 scratch workspace 上真跑一次修复原语)。
- **S1d create 活体验证**:`new-workspace` rc=0 后按 #907 已有的宽限纪律(连续 determinate + min-age)验活,不活走同一修复原语。答 A3 的「create 成功≠活 pane」。
- **弃选**:给 helper 加自杀逻辑(检测 workspace 已关自退)——helper 无法可靠区分「session 正在重建」与「永别」,退出条件放外部 census 更简单且不碰 #907 的抗性设计;重写 Lead reconcile 为第二套自愈状态机——违反「只调用不重写」。

### S2 — close-workspace 后 per-PID 回收 + 孤儿 helper 清扫(答 A5)

- census 库(`scripts/lib/cmux-mutator-process-census.sh`)新增 attach-helper 谓词(argv 形状:basename ∈ {flywheel-view-attach.sh, flywheel-lead-attach.sh} + 第一参数为 session 名/socket 路径),复用三态纪律(rc=0 已验证 / 1 消失 / 2 进程表不可信即 fail-closed)。
- 两个消费点:①`close_workspace_by_ref` 关后对该 surface 的 helper PID 做 TERM→有界等待→KILL(per-PID,不用全局 pgrep——FLY-1884 plan.md:160 已把验收口径写死);②watcher 既有 60s additive pass 里挂一个有界孤儿清扫(helper 的 session/workspace 双双不存在 + 连续两轮确认 → 回收),清掉存量 12 个与未来增量。
- **弃选**:碰 #911(FLY-1940)的 Codex daemon 进程组/socket 收割——那是它在飞的地盘,双方 census 谓词天然不相交(argv 形状不同)。

### S3 — 孤儿 tmux socket/server janitor(答 A6)

- 复用 cutover 工装的 `inventory_tmux_servers` 三证 census(ps lstart 身份 + lsof socket 归属 + file 架构),对 `/private/tmp/tmux-501/`:**死 socket 文件**(连接探活失败)直接删;**活孤儿 server**(socket 名匹配测试前缀 `fly*`/`qa*` 且非 allowlist)TERM→KILL。allowlist fail-closed:`default`、`atlas`、`~/.flywheel/sock/fw-*`(Lead 私有),不认识的**只告警不动手**(继承 restart-services 只读审计的 severe 口径)。
- 落点候选:log-janitor(FLY-1330)加一个模块(有 dry-run receipt/审计骨架,04:15 日拍)vs watcher maintenance 内(更快但加重 9837 行单体)。倾向 **log-janitor 模块**:清理是日拍慢活,不该进 15s 热环。
- **弃选**:清 `~/.flywheel/sock/` 下的 Lead socket——那是 FLY-1663 的生命周期地盘,由 launchd/lease 管理。

### S4 — TUI-lost 侧栏降级标记(答 A8 余量,小件)

- node 占位 tab(#907)消费 `tui_window_lost`/`restored` episode:重试期间 status pill 显示「开窗重试中」,终局显示「查看窗不可用」。纯显示层,零新告警。可作为 S1 的搭车件;若 implement 超预算可单独砍(honest boundary 登记)。

### S5 — 重启波收敛验收 + FLY-1672 记档残洞(答 19:19Z 考题)

- 接管 FLY-1672 plan 明确记档不修的两处:`select_live_view_window` / `refresh_linked_sessions` 的同类 stale-window race 改走已合入的 `window_source_pane_alive` 双字段判定。
- 验收考题按 founder 原文落成可执行判据:真实重启波(下一次班车或 W2 窗口)结束后 ≤5min,`--verify-sidebar` 双快照全绿 + founder 侧零手工。E2E 只能在真机波上验,QA 节点先以 529 房/隔离 socket 验机制、真机波作 ship 后自然观察项(与 FLY-1596 验收同口径)。
- **不做**:改 drain 吞吐(FLY-1672 QA 的 201 条/95s)——S1b 存量收编 + helper 化后,重启波的恢复主体从「重建 workspace」变成「helper 2s 自动重连」,drain 压力天然下降;先量后动,避免对 9837 行热环无据优化。

### PR-1b(B1)的处置建议

本 run 的 land = 一个 PR。S1–S5 已是一个 correctness PR 的合理上限;PR-1b 是收益型、数据门控、动同一个 9837 行热文件——**建议不并入本 PR**,由 Lead 在本 PR 合入后另派(规格已在 round-1 plan §6,零设计欠账)。这是第二次顺延,必须在 plan 的 honest boundary 与 founder HTML 里显式写明,不许静默消失。→ 开放问题 ①。

## 6. 禁区与边界(撞车面裁决)

| 面 | 归属 | 本轮姿态 |
|---|---|---|
| surface 自愈状态机 / node 占位 tab / close 清洁度栅栏 / view-attach helper | FLY-1884(#907,已合) | **调用与扩展**(Lead 类纳管、修它的 respawn 承重缺陷),不平行重写 |
| Codex daemon 进程组收割 + daemon IPC socket 生死判定 | FLY-1940(#911,在飞) | **不碰**;S2 谓词与其 argv 形状不相交 |
| `--rebuild-views --handover` / `--verify-sidebar` / restoredv1 | FLY-1596(#778,已合) | verify-sidebar 作**判官**复用;不建第二个 verifier |
| watcher 单写者 lease / handoff / census 库骨架 | FLY-1482(#768,已合) | census 库**加谓词**,lease 语义不动;「watcher 让位窗口 = 已知合法空档」建模进 S5 验收 |
| `window_source_pane_alive` 双字段判定 | FLY-1672(#800,已合) | S5 把它扩到记档的另两处调用点(其 plan 明示留给后续单) |
| Lead 生命周期(launchd/lease/私有 socket 创建) | FLY-1663/1726 | 不碰;S1a 只管 cmux surface 层 |
| W2 运维窗口 / W5 cutover | founder-gated 运维段 | 不重设计;plan 只登记顺序约束(本 PR 部署后再开 W2 窗口,S5 考题搭窗口验收) |

## 7. 开放问题(带给 design review / Lead / founder)

1. **PR-1b 拆不拆**:建议本 PR 不含、合后另派(§5 末);需要 Lead 认可这个顺延及其登记方式。
2. **孤儿 server 的杀权**:S3 对「活孤儿 tmux server」动手(TERM→KILL)超出纯文件删除;测试前缀 allowlist + 三证 census + 只告警不认识的,是否足以让 Lead/founder 放心把它放进无人值守日拍?保守替代 = 只删死 socket 文件,活 server 永远只告警(founder 手清)。
3. **S1b 存量收编的节奏**:一次性全量迁(下一波重启前完成,风险=批量 mutation)vs 逐轮渐进(每 pass 限 N 个,风险=下一波重启前没迁完)。倾向渐进 + 每 pass 上限,重启波考题前以 `--verify-sidebar` 确认收编完成度。
4. **A8 侧栏降级标记(S4)保不保**:小件,可砍;砍则登记 follow-up。
