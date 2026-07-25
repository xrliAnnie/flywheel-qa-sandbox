# FLY-1446 cmux 稳态 Retro 修复包 — 探索

Issue: FLY-1446 (https://linear.app/geoforge3d/issue/FLY-1446/cmux-稳态-retro-修复包-roster-对账-唯一启动者-合并即部署-server-死因-收养竞态去重)
日期: 2026-07-24
基于: 无

## 1. 问题是什么

2026-07-23 全天 cmux 可视层事故:侧栏 tab 数 18→8→7 乱跳、13 个 Lead 无 tab、名字错挂,founder 完全失去对机群的可视。Retro(https://fw-reports-a53de2.vercel.app/r/b53b99fedd8e3a78256ce45b05d743e2/)钉出三层根因链:

- **RC1 部署腐化**:repo 里已修好的 `flywheel-cmux-sync.sh` 7 天没部署到 `~/.flywheel/bin`,旧版(无 singleton 保护)在生产跑,launchd + 重启脚本 + 手动三条启动路径各拉一份 → **7 个 watcher 实例互踩**。
- **RC2 可见性缺陷**:watcher 的世界 = 「flywheel / runner-* 会话里**看得见的窗**」,没有 roster(名册)概念。窗一旦丢出视野(困进残骸会话、tmux server 事故),watcher 不报警、不寻找、不重建——「没有 tab」和「一切正常」在它眼里无差别。
- **RC3 tmux server 事故**:07-23 晨托管 runner 窗的 tmux server 整体退出,Bridge 大量 `server exited unexpectedly`,killer 未钉死。

当晚又抓到两个新实锤(E 项):

- **E1 rename-lag 双收养竞态**:17:41:26 watcher 为窗 @1557(FLY-1443)建 workspace ref=145,但 cmux 侧 rename 卡死,tab 停在「Terminal 35」;17:42:31 下一轮按标题找不到「FLY-1443」→ 同一个窗又建了 ref=146 → 双同名 tab(founder 截图抓获)。
- **E2 损坏 view-WAL 静默罢工**:watcher 遇到一个 malformed WAL 文件后,**每轮 refresh 全部 skip**、不建任何新 tab、零报警(FLY-1436 tab 缺失的真因);手工隔离坏文件后 90 秒自愈。

本单承接 **cmux 可视层 + 脚本部署层** 的全部 Retro 修复(A-E 五项)。FLY-1374 承接 Bridge 内状态真相(进程↔sessions 对账、sessions↔Discord 幂等重渲染),两单不同代码区、可并行。

## 2. 代码审计核心发现(细节见 research.md)

| # | 发现 | 含义 |
|---|------|------|
| 1 | `scripts/flywheel-cmux-install.sh` 的**设计形态是 symlink**(`ln -sf` repo → bin),即「合并即部署」本来就该自动成立 | RC1 的真正机制不是「缺一个 cp 步骤」,而是**部署形态漂移**:生产 bin 下的 `flywheel-cmux-sync` / `flywheel-cmux-autostart` 是普通文件副本(FLY-1272 hotfix 时代换上的),symlink 断了没人发现 |
| 2 | `scripts/converge-flywheel-bin.sh`(FLY-954/FLY-1389)已存在,挂三个 mount 点(Lead 启动 / 每日 update-flywheel / restart-services pre-kickstart),做 checksum 对账 + 自动修复 + 报警——**但 cmux 两脚本只有「已是 symlink 才修 symlink」的分支**(`[ -L ] || continue`),普通文件副本直接跳过 | 修 C 项 = 补 converge 的覆盖缺口,不是新造一套机制 |
| 3 | **此刻生产就有活漂移**:`~/.flywheel/bin/flywheel-cmux-autostart`(md5 `1e2f6c50…`)≠ repo(`0d603daa…`),差异 = FLY-1364 的第三个 flag `FLYWHEEL_CMUX_STRICT_VIEW` 没进生产 autostart | deployment-copy disease 第三犯,实锤 C 项必要性 |
| 4 | watcher 单实例保护(`acquire_mutator_lease`,incarnation-bound)与 launchd 监督模式(FLY-177 SUPERVISED=1 block-wait)在 repo HEAD 已健全;7 实例互踩是**旧部署副本**没有这些保护 | 修 B 项 = 收掉多余的「启动」入口(.zshrc autostart 仍是启动路径),让 launchd 成为唯一启动者,其余路径只许「戳」 |
| 5 | `sync_additive()`(60s 主对账)只遍历 `get_tmux_agent_windows()` 看得见的窗;Lead/runner 应该有几个窗、应该有几个 tab,没有任何 authoritative 来源 | 修 A 项的挂载点就在这条 60s 通道里(项目口味:零新增周期负载) |
| 6 | Lead 窗名 = `${PROJECT_NAME}-${LEAD_ID}`(claude-lead.sh:1450),与 launchd label `com.flywheel.lead.<X>` 后缀**逐字一致**;manifest `~/.flywheel/manifests/<X>.json` 带 `leadBackend.backendId` | roster 可从 launchd plist 清单零手工派生;headless/TUI Codex Lead 可由 wrapper/manifest 判定豁免 |
| 7 | E1 机制:create 的存在性检查按 **cmux title** 匹配(`w.title == window_name`),rename 卡住 → title 永远不匹配 → 再建;ledger 行 `state|generation|ref|title` 按 **ref** upsert 去重,同 (generation,title) 两行都能 committed;`create_recently_attempted` TTL 只有 30s,挡不住 65s 后的第二轮 | 修 E1 = 建前先查 ledger(按 title/window 身份),ledger 补同 (generation,title) 唯一约束,而不是提高 TTL |
| 8 | E2 机制:`recover_all_view_constructions()` 遇单个 malformed WAL → `return 1` **中止整个循环**;`prepare_linked_view_state` → `refresh_linked_sessions` 失败 → `sync_additive` 在 create 循环**之前**整轮 return;只有 log WARN,零报警 | 修 E2 = 单文件隔离(quarantine)+ fail-loud 报警 + 其余 WAL 继续处理 |
| 9 | runner tmux 在**默认 socket**(`/tmp/tmux-<uid>/default`)上,由 `tmux-server-rescue`(FLY-1285)在 spawn 时 ensure;tmux `exit-empty` 默认 on → 最后一个 session 被杀,server 就退出 | 修 D 项防复发的最小闸 = server 保底 session(sentinel)或 `exit-empty off`;死因取证要靠 log 时间线交叉 |

## 3. 五个修复项的设计方向(+ 被否掉的路)

### A. roster 对账器(修 RC2)

**方向**:从 `~/Library/LaunchAgents/com.flywheel.lead.*.plist` 派生 authoritative Lead roster(label 后缀 = 期望 tmux 窗名 = 期望 cmux tab 标题),每轮 60s additive pass 对账三层:roster ↔ tmux 窗 ↔ cmux tab。
- 缺 tab、窗还在 → 走现有 `create_workspace_for_window`(roster 只是把「看见窗才建」变成「按名册点名」)。
- **连 tmux 窗都没了 → 报警**(lead-alert.sh,claims.db 去重),绝不沉默。不代替 launchd 重建 Lead(那是 KeepAlive 的职责);watcher 报警覆盖的是「launchd 也没救回来」的兜底层。
- runner 侧:活 runner(Bridge sessions 表 running/parked)应有窗;无窗孤儿 → 报警 + 挂只读观察窗。
- 豁免:headless / 非 tmux 形态 Lead(如 codex-infra-bot)按 wrapper 类型自动豁免,不入窗期望。

**否掉的路**:
- 手工维护 roster 文件 —— issue 明确「零手工维护」;launchd 清单本身就是唯一真相(Lead 的存在性由它定义)。
- watcher 自己重建 Lead tmux 窗 —— 越权。窗的生命周期属于 claude-lead.sh/launchd;watcher 只管「可视」和「报警」。

### B. 唯一启动者(修 RC1 互踩面)

**方向**:launchd(com.flywheel.cmux-watcher, KeepAlive)是唯一 `--watch` 启动者。`.zshrc` 集成从「后台拉起 watcher」降级为「确保 launchd job 已加载,未加载则 bootstrap」;restart-services 维持现状(只 `--refresh` 戳,已经是 poke);手动路径文档化为 `launchctl kickstart`。

**否掉的路**:删掉 `.zshrc` 集成 —— 保留它作为 launchd job 掉载(bootout 后忘记 bootstrap)的自愈钩子,但它永远不再直接 exec watcher。

### C. 合并即部署 + md5 对账(修 RC1 根)

**方向**:恢复并强制执行「symlink 是唯一合法部署形态」:converge-flywheel-bin.sh 把 `flywheel-cmux-sync` / `flywheel-cmux-autostart` 的检查从「是 symlink 才管」升级为「**必须是指向主 checkout 的健康 symlink**」——普通文件副本 = 漂移,自动替换回 symlink + 报警。三个现有 mount 点(Lead 启动 / 每日 sweep / pre-kickstart)自动获得巡检频率,发版(merge 到 main + git pull)即生效,零 cp。

**否掉的路**:issue 原文的「发版自动 cp + md5 对账」—— cp 副本模式本身就是这病的宿主(cp 一旦漏跑就腐化);repo 已经用 symlink + converge 解决了同类问题(lead-wrapper 等),cmux 两脚本走 checksum-copy 反而造出第二套机制。symlink 形态下「md5 对账」退化为「symlink 健康检查」,converge 已有该逻辑,补齐「非 symlink 形态也要收敛」即可。**采纳 issue 的目标(部署副本永不漂移+巡检报警),替换它的手段(cp→symlink)**,plan 会明确此偏离供 review。

### D. tmux server 死因取证(RC3,症状不预设结论)

**方向**:两部分。
1. **取证**:从 Bridge log(`server exited unexpectedly` 首现时刻)+ `log show`(macOS unified log,tmux/related 进程退出记录)+ launchd job 历史 + shell history 交叉钉时间线;产出独立 forensic 报告(doc 交付物,结论可以是「证据不足,列出排除项」——不预设结论)。
2. **防复发**(与死因无关都值得做):默认 socket 的 tmux server 挂一个保底 sentinel session(`flywheel-keepalive`,detached、零消耗)+ server 级 `exit-empty off`,使「杀掉最后一个 session」不再连带杀 server;tmux-server-rescue 的 ensure 路径顺手校验。

### E. 收养纪律(E1 双收养 + E2 WAL 静默罢工)

**E1 方向**:三层闸。
1. create 前先查 ledger:同 (generation, title) 已有 prepared/committed 行 → 不再 new-workspace,转而驱动既有行的恢复(reconcile_prepared_ledger 已会补 rename)。
2. `_ledger_upsert` 补唯一性:同 (generation, title) 第二行 = 违约,拒绝 + 报警(而不是静默双 committed)。
3. 周期对账发现双行(历史残留)→ 保留「view session 真正持有该窗」的那行,另一行走现有 close guard 关闭 + 报警。

**E2 方向**:`recover_all_view_constructions` 从「一坏全停」改为「单文件隔离」:malformed WAL → `mv` 到 `quarantine/` + lead-alert 报警(claims.db 去重)+ **continue 处理其余 WAL**;refresh 不再整轮 skip。隔离而非删除(保留取证);同一文件只报一次。

## 4. 验收(issue 原文能力级验收,逐条可测)

| # | 能力 | 对应修复 |
|---|------|---------|
| ① | 杀任一 Lead 的 tab/窗 → ≤2min 自动重建或报警,绝不沉默 | A |
| ② | 同时从 3 个路径触发 watcher → 始终单实例 | B(+现有 lease) |
| ③ | 改 repo 脚本合并 → 部署副本自动同步,对账绿 | C |
| ④ | server 死因报告 + 防复发措施落地 | D |
| ⑤ | 同窗口 rename-lag 下反复扫描 → 永不双收养 | E1 |
| ⑥ | 人为塞坏 WAL → 报警 + 隔离 + 继续建 tab,不静默 | E2 |

## 5. 边界(本单不做)

- Bridge 内 sessions 状态真相、Discord 渲染 —— FLY-1374。
- Lead 进程本身的死活(LeadWatchdog 域)—— watcher 只管可视层的窗/tab 与报警。
- cmux 应用(Electron)自身的 bug 修复 —— 只做 watcher 侧防御。
- runner 观察窗不是 runner 恢复机制 —— 只读、明确标注,不冒充真窗。
