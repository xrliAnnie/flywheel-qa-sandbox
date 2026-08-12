# FLY-1715 Discord plugin 极性真机 spike — 调研

Issue: FLY-1715 (https://linear.app/geoforge3d/issue/FLY-1715/runner-%E8%BF%9B%E7%A8%8B%E4%B8%8D%E5%BA%94%E5%8A%A0%E8%BD%BD-discord-plugin-server-%E4%B8%AA%E4%BE%8B-roguefly-1704-runner-%E5%90%8D%E4%B8%8B-bun)
日期: 2026-08-12
基于: plan.md

## 结论

Phase 1 采用 plan.md 的分支 A:Lead 侧 `claude-lead.sh` 零改动。`--dangerously-load-development-channels plugin:discord@flywheel-plugins` 会在两枚 Discord plugin key 均为 `false` 时继续显式启动 Discord channel；普通 Claude 调用则会被 `enabledPlugins=false` 阻断。

## 真机矩阵

所有调用都在本 FLY-1715 worktree 内执行，并把 `DISCORD_BOT_TOKEN` 覆盖为无效测试值、把 `DISCORD_STATE_DIR` 指向空临时目录，同时剥离 `TEAMLEAD_API_TOKEN` / `BRIDGE_URL` / `FLYWHEEL_INGEST_TOKEN`。因此 spike 不使用真实 Discord token，不触碰现存 Lead/Runner，也不修改机器级 `~/.claude/settings.json`。

| Case | 调用形态 | 观察 | 判定 |
|---|---|---|---|
| S0 阳性对照 | 当前机器设置(fork key=`true`)下运行 `claude mcp list` | 列出 `plugin:discord:discord …/flywheel-plugins/discord/0.0.4/start-adapter.sh - Connected` | 尺子能看到 fork adapter |
| S2 / S3 禁用 | 同一 profile，追加 `--settings`，两枚 Discord key=`false` | `claude mcp list` 完全不列 Discord；其它既有 MCP 仍列出 | per-launch false 确实阻断 adapter，且 key 必须覆盖 fork + official 两枚 |
| S1 Lead 形态 | 同一 false settings，再加 `--dangerously-load-development-channels plugin:discord@flywheel-plugins`，在 TUI 确认开发 channel | TUI 明示 `Channels (experimental) messages from plugin:discord@flywheel-plugins inject directly in this session` | development-channel flag 独立于 `enabledPlugins`，Lead 不需再追加 positive `--settings` |

## Harness 更正记录

首次尝试把 `CLAUDE_CONFIG_DIR` 整体切到临时目录，导致 subscription 登录不可见，三个 case 都在 plugin resolution 前以 `Not logged in` 退出；该轮不是阴性证据，已废弃。第二版保留已认证 profile，只覆盖 Discord/Bridge 凭据，并先跑 S0 阳性对照，随后才采信 false case。所有临时目录(包括复制过 `.claude.json` 的首版目录)已精确删除并复核无残留。

## 实施影响

- `setup-discord-plugin-default-off.sh` 可以安全把机器级 fork + official 两 key 翻为 `false`。
- Lead 保持既有显式 development-channel opt-in 与确认 poller，不新增第二枚 settings 来源。
- 非 Lead 的所有已知生产 spawn 面仍需 canonical security-last false 合并；机器级 default-off 只兜 ad-hoc/未知入口。

## 污染 tmux server 治愈复证

实现后另起隔离 tmux socket，由 server 启动环境注入六个污染值(`LEAD_ID` / `DISCORD_STATE_DIR` / `DISCORD_BOT_TOKEN` / `TEAMLEAD_API_TOKEN` / `BRIDGE_URL` / `PROJECT_NAME`)与一个 deny-list 外 canary。再通过生产 `buildAmbientSafeWindowCommand()` 的 gated 命令形态启动两个真实 tmux pane，原子采集 child env:

| Case | 六名污染 | `PROJECT_NAME` | registry runner identity | deny-list 外 canary |
|---|---|---|---|---|
| ctx=`flywheel` | 全部消失 | 精确恢复为 registry ctx `flywheel` | `FLYWHEEL_LEAD_ID` + `FLYWHEEL_INGEST_TOKEN` 在位 | 保留 |
| ctx 缺席 | 全部消失 | 变量不存在 | `FLYWHEEL_LEAD_ID` + `FLYWHEEL_INGEST_TOKEN` 在位 | 保留 |

验证输出为两 case 全布尔通过；隔离 server/socket 与临时证据目录在 `finally` 中清除，未连接或改动生产 tmux server。该复证同时刻意保留 canary，确认本单是精确六名 deny-list，不虚称开放集 env 已被净化。

## runner 运行时 master 回读复证

`flywheel-comm` CLI 真链路用 Node preload 替换 builtin `readFileSync` 做 fs 探针，并让本地 nudge fetch 固定返回 401。在只提供 whitespace-padded ingest、磁盘 `.env` 放置 master canary 的环境里依次执行 `ask` → `check` → `gate --no-block` → `ack-event`:三个 nudge 均发送规范化后的 ingest bearer，命令链成功，磁盘 master 文件读取次数为 0。Lead 的 master-tier 401/403 轮换回读仍由原单测覆盖。

## 实施验证记录

- `pnpm lint`:exit 0；仅保留仓内既有 13 条 warning，无本单 error。
- `pnpm -r build`:22 个 workspace package 全部构建成功。
- 本单触达面定向回归全部通过:config 4、Edge Blueprint 36、voice brain 40、ClaudeRunner/TmuxAdapter 199、teamlead reviewer/classifier/scoped-token 59、reports mount/router 48、flywheel-comm runner-tier CLI 87，共 473 个 Vitest case；另有 default-off 20、token preflight 9、voice managed restart 16、packaged Buddy provider 19，共 64 个 shell harness assertion；Buddy 总流程既有 11 条也复跑通过。
- Code review R2 的全仓 shell spawn sweep 补出 packaged Buddy 面。TDD RED 先让 Claude stub 对所有 model-bearing `--print` 强制校验唯一 `--settings`，smoke/start/resume 三 case 均按预期失败；GREEN 后三路径统一携 fork + official 两 key=false，contract harness 17/17、Buddy 总流程 11/11。
- Code review R3 再补首启 `/login` 与 shell deny-list 漂移守卫。TDD RED 中 `_acp_login_cli` 缺席令 login case 以 127 失败；GREEN 后 login 复用同一 inline settings，Python guard 从 canonical TS 导出解析 key set 并对 Buddy/default-off 两份 shell 数据做精确相等校验，contract harness 19/19。隔离 HOME 下真实 Claude CLI 以同一 argv 组合 `--settings <json> /login --help` 返回 0，确认参数组合可解析且未启动交互登录。
- 精确全仓命令 `pnpm test:packages:run` 已执行但未全绿:core 的 macOS Terminal `osascript` 测试被当前 sandbox 拒绝，最小 `tell application "Terminal"` 同样 exit 1；排除唯一 GUI 文件后 core 219/219 通过。并发 package wave 的既有 5 秒/15 秒阈值在宿主负载下超时；本单 ingest case 与两条同波旁证隔离复跑 3/3 通过，未触达的 `flywheel-claude-profile` case 隔离复跑 1/1 通过（13.8 秒）。未为本单放宽阈值或修改无关测试。
- `git diff --check`:通过。
