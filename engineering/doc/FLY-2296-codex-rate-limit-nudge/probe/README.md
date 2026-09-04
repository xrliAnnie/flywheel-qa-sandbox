# FLY-2296 判别力探针(设计阶段一次性版本)

假 Codex app-server(`server.cjs`)接真 `codex resume --remote` TUI,用 `account/rateLimits/read` 回 95% 用量并推一次 `turn/completed`,让「Approaching rate limits → Switch to gpt-5.6-luna?」菜单按需弹出;再用 `$CODEX_HOME/config.toml` 里 `[notice] hide_rate_limit_model_nudge` 的有无 / 真假做红绿对照。

| 文件 | 用途 |
|---|---|
| `server.cjs` | node 假 app-server:unix socket 上的 JSON-RPC,按 `canned-*.json` 的方法名回结果,`__after__<method>` 里的通知在该方法应答后主动推送 |
| `probe.sh` | `probe.sh <run> <secs> [canned.json] [extra.toml]`:建隔离 home(只有 trust 段 + extra.toml)、起 server、tmux 起 TUI、抓 pane 到 `run-<run>/pane.txt` |
| `canned-menu.json` | 应答表;路径里的 `run-menu` 按运行名 `sed` 替换后即可用于其它运行 |
| `extra-true.toml` / `extra-false.toml` | 注入的 `[notice]` 片段 |
| `evidence/` | 2026-09-03 三组运行的 pane、server.log、config.toml 原样 |

依赖:本机 `tmux`、`codex`(0.153.0)、主仓 `node_modules/.pnpm/ws@8.19.0`(`server.cjs` 里是绝对路径,实现节点固化时改为仓内依赖解析)。工作目录在可写时固定为 `/private/tmp/fly2296`,否则用 `/tmp/fly2296`(unix socket 路径不能超过 104 字节,scratchpad / runner `TMPDIR` 路径太长)。

三组结果(见 research.md §7):无键 → 弹;`= true` → 不弹;`= false` → 弹。
