# FLY-1715 Discord plugin 极性真机 spike — 调研

Issue: FLY-1715 (https://linear.app/geoforge3d/issue/FLY-1715/runner-%E8%BF%9B%E7%A8%8B%E4%B8%8D%E5%BA%94%E5%8A%A0%E8%BD%BD-discord-plugin-server-%E4%B8%AA%E4%BE%8B-roguefly-1704-runner-%E5%90%8D%E4%B8%8B-bun)
日期: 2026-08-12
基于: plan.md

## 结论

Phase 1 只采用 per-launch non-Lead deny:Flywheel 控制的非 Lead spawn 显式携两枚 Discord key=false;机器级 key 与 Lead argv 均不修改。原 spike 以 TUI Channels 横幅推断 Lead 在机器 key=false 下仍连通,该判据被 QA 的进程/socket 实验推翻,结论作废。

## 真机矩阵

所有调用都在本 FLY-1715 worktree 内执行，并把 `DISCORD_BOT_TOKEN` 覆盖为无效测试值、把 `DISCORD_STATE_DIR` 指向空临时目录，同时剥离 `TEAMLEAD_API_TOKEN` / `BRIDGE_URL` / `FLYWHEEL_INGEST_TOKEN`。因此 spike 不使用真实 Discord token，不触碰现存 Lead/Runner，也不修改机器级 `~/.claude/settings.json`。

| Case | 调用形态 | 观察 | 判定 |
|---|---|---|---|
| S0 阳性对照 | 当前机器设置(fork key=`true`)下运行 `claude mcp list` | 列出 `plugin:discord:discord …/flywheel-plugins/discord/0.0.4/start-adapter.sh - Connected` | 尺子能看到 fork adapter |
| S2 / S3 禁用 | 同一 profile，追加 `--settings`，两枚 Discord key=`false` | `claude mcp list` 完全不列 Discord；其它既有 MCP 仍列出 | per-launch false 确实阻断 adapter，且 key 必须覆盖 fork + official 两枚 |
| S1 Lead 形态(废弃判据) | 同一 false settings,再加 `--dangerously-load-development-channels plugin:discord@flywheel-plugins` | TUI 仍显示 Channels experimental 横幅 | 横幅不证明 adapter 或 gateway 连通,不能用于部署决策 |
| QA 正逆序 | Claude 型生产 Lead 共享 key true→false 与 false→true,各含阳性对照 | true:adapter 1 且 ESTABLISHED 443 socket>0;false:adapter 0/socket 0;2/2 复现 | `[生产现状]` 14/16 个 Claude 型 Lead 依赖机器 key,不得翻 false;另 2 个 Codex/direct Lead 不走 plugin |

## Harness 更正记录

首次尝试把 `CLAUDE_CONFIG_DIR` 整体切到临时目录，导致 subscription 登录不可见，三个 case 都在 plugin resolution 前以 `Not logged in` 退出；该轮不是阴性证据，已废弃。第二版保留已认证 profile，只覆盖 Discord/Bridge 凭据，并先跑 S0 阳性对照，随后才采信 false case。所有临时目录(包括复制过 `.claude.json` 的首版目录)已精确删除并复核无残留。

## 实施影响

- 删除 `setup-discord-plugin-default-off.sh` 及部署步骤;本单不得改机器级 fork/official keys。
- Lead 保持既有共享 key 与启动参数,并以 adapter + gateway socket + 真收发验活,不再把横幅当证据。
- 非 Lead 的所有已知生产 spawn 面继续 canonical security-last false 合并;未知 ad-hoc 入口留 plugin 侧 follow-up。

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
- 本单触达面定向回归全部通过:config 4、Edge Blueprint 36、voice brain 40、ClaudeRunner/TmuxAdapter 199、teamlead reviewer/classifier/scoped-token 59、reports mount/router 48、flywheel-comm runner-tier CLI 87，共 473 个 Vitest case；另有 token preflight 9、voice managed restart 16、packaged Buddy provider 19，共 44 个 shell harness assertion；Buddy 总流程既有 11 条也复跑通过。合 main 后 `scripts/test-restart-services.sh` 的 hermetic fixture 已补齐 voice helper，127/127 通过；两份新 shell harness 现显式接入 CI（该 job 不 glob）。
- Code review R2 的全仓 shell spawn sweep 补出 packaged Buddy 面。TDD RED 先让 Claude stub 对所有 model-bearing `--print` 强制校验唯一 `--settings`，smoke/start/resume 三 case 均按预期失败；GREEN 后三路径统一携 fork + official 两 key=false，contract harness 17/17、Buddy 总流程 11/11。
- Code review R3 再补首启 `/login` 与 shell deny-list 漂移守卫。TDD RED 中 `_acp_login_cli` 缺席令 login case 以 127 失败；GREEN 后 login 复用同一 inline settings，Python guard 从 canonical TS 导出解析 key set 并对 Buddy shell copy 做精确相等校验，contract harness 19/19。隔离 HOME 下真实 Claude CLI 以同一 argv 组合 `--settings <json> /login --help` 返回 0，确认参数组合可解析且未启动交互登录。
- 精确全仓命令 `pnpm test:packages:run` 已执行但未全绿:core 的 macOS Terminal `osascript` 测试被当前 sandbox 拒绝，最小 `tell application "Terminal"` 同样 exit 1；排除唯一 GUI 文件后 core 219/219 通过。并发 package wave 的既有 5 秒/15 秒阈值在宿主负载下超时；本单 ingest case 与两条同波旁证隔离复跑 3/3 通过，未触达的 `flywheel-claude-profile` case 隔离复跑 1/1 通过（13.8 秒）。未为本单放宽阈值或修改无关测试。
- Implement 节点的 exact-head audit 补出 rollback 顺序缺口:voice-bridge 旧版本健康复验失败会在 Lead 恢复波次前提前返回。TDD RED 用真实提取的 `rollback_and_restart()` 注入 voice failure，确认 severe alert 发出但 Lead marker 缺席；GREEN 将 voice 复验移到 Lead 波次之后，仍 fail-close 且不推进 `deployed-sha`。合入最新 `origin/main` 后以 Homebrew Bash 置于 `PATH`（匹配 CI 的现代 Bash 语义）复跑整份 `scripts/test-restart-services.sh`，132 passed / 0 failed；系统 Bash 3.2 首轮唯一失败是既有 `((n++))` negative-control 在该旧版本不触发 `errexit`，生产/新增 case 均已通过。
- Buddy 全流程的 D3 sourced fixture 原先在 Bash 3.2 下以空 `FB_ARGS` 触发 nounset、令四个 stub-brain sample 假阴；fixture 现显式提供隔离 `--state-dir` 并预建目录，生产代码不变。TDD RED 为 10 passed / 4 failed，GREEN 为 11 passed / 0 failed；provider contract 19/19 同步通过。
- 合入 `origin/main` 后再次做 package 覆盖：`flywheel-core` 除当前 resident 无法连接 HiServices 的唯一 Terminal GUI 文件外 219/219；`flywheel-comm` 单包 1450 passed / 1 skipped；`claude-runner` 782 passed / 2 skipped 后仅 Vitest worker `onTaskUpdate` RPC 超时；`voice-bridge` 673/673。TeamLead 全包 9279 passed / 5 skipped，7 个失败中本单触达的 reviewer/classifier/scoped-token/report 五文件隔离复跑 107/107；其余来自未触达且与 `origin/main` 相同的既有 preflight/terminal 5 秒阈值、sandbox 下 npm cache 与进程探针限制。未修改或放宽这些无关测试来制造绿门。
- `git diff --check`:通过。
