# FLY-1676 channel 注册假绿修正 — Rework 说明

Issue: FLY-1676 (https://linear.app/geoforge3d/issue/FLY-1676/chore-把-discord-plugin-fork-整个追平上游-rebase-我们的定制-修好自动同步-founder-裁定不)
日期: 2026-08-10
基于: qa-report.md、plan.md

## 1. 触发原因

QA 在 PR #802 head `877311b4` 上证明:`plugin:discord@flywheel-plugins` 经 `--channels` 启动时被 Claude CLI 的 exact `(plugin, marketplace)` allowlist 拒绝。adapter 仍会从 pointer installPath 启动,因此原来的 process-root 验收是假绿;真实结果是 Lead 健康但 Discord 入站为零。

## 2. Lead 裁定

采用 A:`--dangerously-load-development-channels plugin:discord@flywheel-plugins`;拒绝新增机器级 `allowedChannelPlugins` / `channelsEnabled` 权威。pointer Discord 与现役 `server:flywheel-inbox` 共用一个 variadic development-channel 参数列表。

硬依赖:**FLY-1679 / PR #801 先落地**。它把 development-channel 确认 poller 接进 v2 carrier;没有它,冷启动会卡框。依赖审计又发现 PR #801 当前只在 `INBOX_MCP_ENABLED=true` 时起 poller,但 companion/external 明确是 false,而 pointer Discord 的 dev channel 始终存在;所以 #801 必须先补上 inbox-false 冷启动支持。FLY-1676 的 cutover preflight 必须同时看见新 selector 与 `_poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &` call site,缺一 fail-stop。

## 3. 实现与 TDD 证据

- RED:launcher 的真实 argv block 在 inbox off/on 两态都不等于期望 development-channel 列表(`27 passed, 2 failed`);
- GREEN:`CLAUDE_ARGS` 固定以 `--dangerously-load-development-channels plugin:discord@flywheel-plugins` 开头,inbox 开启时只追加 `server:flywheel-inbox`;聚焦套件 `29 passed, 0 failed`;
- RED:真实 `preflight_pointer()` 仍接受旧 `--channels`,并拒绝「新 selector + FLY-1679 wiring」(`19 passed, 2 failed`);
- GREEN:preflight 同时断言 development-channel selector 与 FLY-1679 call site;cutover 套件先达 `21 passed, 0 failed`;
- 依赖审计 RED:PR #801 当前把 poller 放在 `INBOX_MCP_ENABLED=true` guard 内,新增真实 launcher fixture 后为 `21 passed, 1 failed`;GREEN:preflight 进一步拒绝该 guard 形态,要求 poller 对所有加载 Discord development channel 的 Lead 生效,套件 `22 passed, 0 failed`;
- R4 审查 RED/GREEN:cutover 原本要到停舰队、deploy/build/install/settings 全部 mutation 后才发现 FLY-1679 不合格;新增 target-blob preflight 后在任何 bootout/repo mutation 前 fail-stop,套件 `23 passed, 0 failed`;
- R4 authority-map RED/GREEN:FLY-183 shell orphan reaper 原本只认 `claude-plugins-official` 两种布局;新增 pointer cache 的 exact-boundary inner/wrapper/launcher 三形态与 `discord-backup` 阴性用例,T15 通过。宿主 sandbox 下既有 T2/T3/T6 的真实进程 signal 用例仍因 process-table 权限失败,新增纯表 matcher 用例独立为绿,真实宿主/CI 继续负责 destructive 断言;
- RED/GREEN:自升级 pre-pull guard 的真实 `origin/main` fixture 从旧 selector 换成 development-channel selector 后先红(`T8 ... escaped`),更新 guard 后 queue 套件 `19 passed, 0 failed`;
- `/bin/bash -n` 对 launcher/cutover 均通过。

### 真 CLI A/B(v2.1.227,完全隔离插件账本)

在新建的临时 `HOME` + `CLAUDE_CONFIG_DIR` 内真正执行 marketplace add / plugin install,安装条目为 `discord@flywheel-plugins` 0.0.4,`gitCommitSha=e1b061b0...`,installPath 位于临时树。同一安装做单变量对照:

- 阴性:`--channels plugin:discord@flywheel-plugins` 进入 TUI 后明确显示 `plugin:discord@flywheel-plugins · not on the approved channels allowlist`;
- 阳性:`--dangerously-load-development-channels plugin:discord@flywheel-plugins` 显示专用确认框;**只发一个 `1`,没发 Enter** 后进入会话,channel banner 保留 pointer selector,且无 allowlist 拒绝。

检查边界:生产 `settings.json` 与 `installed_plugins.json` 前后 sha256 逐字节不变;生产 settings/installed/known-marketplaces 中 `flywheel-plugins` 命中均为 0;现役 legacy checker 仍返回 `OK: Discord plugin matches fork (e1b061b)`。隔离目录与 tmux server 已删除,未启停任何生产 Lead/Bridge。

## 4. 尚需 land/QA 真机证明

1. FLY-1679 已 land,`SKIP_DEV_CHANNELS_WORKAROUND=1` 冷启动零人工按键;
2. 真 CLI 新 selector 不出现 allowlist 拒绝,旧 selector 阴性对照仍被拒;
3. pointer MCP 根路径正确(只证明 provenance);
4. 另一 bot 的真实 Discord 入站抵达 Lead并得到回复(才证明 channel 注册 + allowBots);
5. `fetch_messages` 真拉历史;
6. merge 到 cutover 全程部署冻结,plugin patch version 单点未漂移。
