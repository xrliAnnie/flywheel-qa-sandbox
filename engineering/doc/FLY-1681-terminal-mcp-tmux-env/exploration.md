# FLY-1681 terminal-mcp 剥离 TMUX env — 探索

Issue: FLY-1681 (https://linear.app/geoforge3d/issue/FLY-1681/flywheel-terminal-mcp-从-v2-lead-座位探测-runner-全假阴性-tmux-客户端命中私有-server)
日期: 2026-08-12
基于: 无

## 1. 问题是什么

2026-08-10 quota 事故排查中实测:从 v2 载体上的 Lead 调用 flywheel-terminal MCP:

- `runner_terminal_list`:8/8 个 runner 全报 `alive=false`(实际全活)
- `runner_terminal_capture`:报 `can't find session: runner-flywheel`

同一时刻 Bash `TMUX= tmux ...` 直查默认 server:runner-flywheel session 8 窗全在、runner 进程全活。**仪器全面撒谎,方向 = 假阴性。**

风险不是「看不见」本身,而是**基于假阴性的误处置**:Lead 会把自己的 runner 判成全死 → 误报 founder「runner 全灭」/ 误重派 / 误清理。当天靠人肉发现,没造成误杀。

## 2. 机制(已从"高置信假设"升级为"实锤")

issue 里的机制假设本节全部验证通过,证据链:

1. **v2 座位形态**:`scripts/flywheel-lead-wrapper-v2.sh` 用 `env -i … tmux -D -S <私有socket>` 起前台私有 tmux server(socket = `~/.flywheel/sock/fw-<project>-<lead>-<hash>.sock`),Lead 的 claude 跑在其 body pane 里。tmux 给 pane 内进程注入 `TMUX=<私有socket>,<server_pid>,<session_idx>` 和 `TMUX_PANE=%0`。
2. **env 继承链**:claude 按 `.mcp.json` spawn flywheel-terminal MCP server(`packages/teamlead/scripts/claude-lead.sh:1846-1868` 用 jq 生成配置,env 字段只是**叠加**在继承环境之上)⇒ MCP 子进程继承 `TMUX=<私有socket>`。
3. **tmux 客户端解析规则**:tmux 客户端在 `TMUX` 已设且未显式给 `-S`/`-L` 时,连接 `$TMUX` 里的 socket ⇒ terminal-mcp 的裸 `tmux capture-pane / list-panes / send-keys` 全部命中**私有 server**。
4. **目标在另一个 server**:runner session(`runner-flywheel:@xxx`)全在**默认 server**(`/tmp/tmux-501/default`)⇒ 私有 server 上找不到 ⇒ `list-panes` 失败 ⇒ `alive=false`;`capture-pane` 报 `can't find session`。与症状逐字吻合。

**2026-08-12 全舰进程实测**(`ps eww` 逐个查 13 个活着的 terminal-mcp 进程):13/13 个 Lead(flywheel-eng-lead / flywheel-cos-lead / cos-lead / ops-lead / product-lead / rafiki / reflection / joycon / sub / tidal-echo ×3 / claude-infra-bot)的 terminal-mcp env 全带 `TMUX=~/.flywheel/sock/fw-*.sock,...` — **全舰失明不是推测,是当前生产状态**。

对照:本 runner 自己的 env 是 `TMUX=/private/tmp/tmux-501/default,...`(runner 就 spawn 在默认 server 里)⇒ runner 座位不触发此 bug。旧世界 Lead 也在默认 server 的共享 session 里,所以此 bug 是 v2 迁移(FLY-1663)后才暴露的**环境错配**——工具无罪但没适配新座位。

## 3. 影响面

- **受影响工具**:terminal-mcp 5 个走本地 tmux 的工具(capture / list / search / status / input),共 4 个 `execFileAsync("tmux", ...)` 位点(`tmuxCapture`、`tmuxAlive`、`send-keys` ×2),全在 `packages/terminal-mcp/src/index.ts`。
- **不受影响**:`close_runner`(纯 Bridge HTTP,无本地 tmux);inbox-mcp(grep 证实零 tmux 调用);Bridge/edge-worker 侧 TmuxAdapter(Bridge 从 launchd 起,TMUX 未设,裸 tmux 天然命中默认 server;FLY-1285 rescue 路径更是显式 `-S`)。
- **过渡 workaround 已在用**:Lead 巡检改 Bash `TMUX= tmux ...`(2026-08-10 起 eng-lead 巡检 cron 已按此运行)——不失明,但 MCP 工具本身仍是坏的。

## 4. 「有没有本来就想查私有 server 的调用」——审计结论:没有

这是 issue 点名要防的破坏面。三路证据:

1. **schema 层**:terminal-mcp 的所有 tmux target 都来自 CommDB `sessions.tmux_window`,该列是 `session:window` 字符串(如 `runner-flywheel:@649`),**没有 socket 维度** ⇒ 这张表在结构上只可能描述一个 tmux 命名空间。而所有写入方(runner spawn 路径)都写默认 server 的 session ⇒ 工具的隐含契约就是「查默认 server」。
2. **写入方审计**:TmuxAdapter(claude-runner)从 Bridge 进程 spawn(无 TMUX env → 默认 server),rescue 路径显式 `-S tmuxDefaultSocketPath()`;Codex/Antigravity/Kimi adapter 同链路。没有任何写入方把私有 server 的 window 写进 sessions 表。
3. **QA 隔离房**:slot 的 runner 由 slot Bridge 经同一 TmuxAdapter spawn(无 TMUX env → host 默认 server)。slot Lead 若坐在隔离 socket 里,其 terminal-mcp 今天同样失明;修后反而恢复正确。`test-deploy.sh` 里仅有的 `tmux -S` 是 sandbox main pane 自用,与 terminal-mcp 无关。

## 5. 修法方向(issue 已圈定,探索确认可行)

**只减不加**:terminal-mcp 所有 tmux 子进程调用统一在 exec 边界剥离 `TMUX`(等价 `env -u TMUX`)。这与已验证 48h+ 的 workaround `TMUX= tmux ...` 字节等价——同一台机器上的地面真相就是它。不加配置、不加探测层、不加 socket 推导。

候选形态(research 阶段定案):

- **A. exec 边界剥 env**(倾向):单一 `execTmux()` 收口,child env = 继承环境去掉 `TMUX`(+顺手去掉 `TMUX_PANE`,它在默认 server 上是无意义残留)。tmux 自己的默认 socket 解析逻辑(含 `TMUX_TMPDIR`)原样保留。
- B. 每个调用显式 `-S <默认socket路径>`:需要在 terminal-mcp 里复刻 tmux 的 socket 推导(`$TMUX_TMPDIR`/`/tmp` + `tmux-<uid>/default`),repo 里虽有先例(claude-runner `tmuxDefaultSocketPath()`)但那是跨进程 rescue CLI 的参数需要;这里属于重复造轮子。
- C. 在 claude-lead.sh 的 .mcp.json env 里写 `TMUX: ""`:只修了 Lead 启动器这一个 embedding,工具本身还是坏的(测试、QA slot、未来载体全都要各自记得修),不是 root-cure。

## 6. 生效时机的诚实边界

MCP server 进程与 Lead 的 claude session 同生命周期(session 启动时 spawn、常驻)。修复 merge + 部署后,**已在跑的 Lead session 里的旧 MCP 进程不会自愈**,要等该 Lead 下一次 claude session 重启(全舰重启车或自然换代)。不需要 Bridge 重启。

## 7. 待 research 阶段回答

1. execTmux 收口的具体形态(纯函数 + 注入 execFile,现有 lifecycle.ts 测试惯例)
2. RED 测试怎么真实复现 bug(real-tmux 双 server 沙箱,不碰 host 默认 server)
3. 防回归静态守卫(禁止 index.ts 再出现裸 `execFileAsync("tmux")`)是否值得加
