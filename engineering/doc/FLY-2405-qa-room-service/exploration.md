# FLY-2405 起房服务 — 探索
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-28
基于: 无

## 1. 问题陈述

Codex runner 跑在 macOS Seatbelt 沙箱（seatbelt：操作系统给进程套的"权限笼子"，限制它能碰的文件、进程和系统服务）里。它在沙箱内调用
`scripts/test-deploy.sh` / `scripts/test-teardown.sh` 起、拆 529 测试房（QA room：一套隔离的 Bridge + Lead + 状态库，用于真机端到端验证）时撞上三堵墙：

| 墙 | 现象 | 后果 |
|---|---|---|
| launchd 域 | `launchctl bootstrap gui/501 <plist>` → `Bootstrap failed: 5`（EIO） | 房里的 Lead 起不来 |
| 进程可见性 | 沙箱内 `ps`/`lsof` 看不到沙箱外进程 | 拆房的 reap guard 判断不了谁活着，拆不干净 |
| 嵌套沙箱 | 房里再起 codex 要 `sandbox-exec` → `Operation not permitted` | codex:rescue、529 harness preflight、嵌套诊断都跑不了 |
| `$HOME` 根锁 | `runner-workspace-trust.sh` pretrust-dual 在 `$HOME` 下 `mkdir ~/.claude.json.lock` 被拒 | Codex QA 跑不了 generalized e2e driver |

founder 2026-09-26 选 **A**：由 Bridge（沙箱外常驻进程）提供「起房 / 拆房」服务，runner 只发请求。

## 2. 现状审计（本分支快照 + 生产 main 参考）

- 起房：`scripts/test-deploy.sh`（1552 行）。slot 锁 = `mkdir /tmp/flywheel-test-slot-<N>.lock` + `pid` 文件；预检锁 `/tmp/flywheel-qa-rebuild.lock`（pnpm install + build 串行化）；`--mode slot|mirror|roundtable`、campaign / `--extra-lead`。生产 main 另有 `--generalized [--codex-runner] --expect-head <sha>` 与 `scripts/lib/qa-launchd-lead.sh`（`gui/$(id -u)` 域 launchctl bootstrap）——本分支快照落后，设计按"脚本是黑盒"对待，不依赖其内部。
- 拆房：`scripts/test-teardown.sh`（501 行）。按 cwd（`lsof -d cwd`）、port（`lsof -iTCP:<port>`）、Lead/Bridge pid 找进程；cmux 会话 owner 判定。
- Bridge runner-facing 路由样板：`POST /review-requests`（`plugin.ts:1307`）= ingest-token 认证 + late-bound coordinator + "payload 是被验证的输入，身份在服务端从 sessions 行推导"（`review-request-coordinator.ts:296` 用 `adapter_type` 推作者家族）。
- runner 身份材料：`FLYWHEEL_EXEC_ID`（公开）+ `FLYWHEEL_CALLBACK_TOKEN`（`TmuxAdapter.ts:299` 每次 launch 注入，仅本 runner 持有）+ `sessions.session_role`（`StateStore.ts:1290`）。
- runner CLI 样板：`flywheel-comm request-review`（先本地落意图、有界重试、以 durable-accepted 为成功）。

## 3. 候选方向

| 方向 | 说明 | 结论 |
|---|---|---|
| A. Bridge 起房服务 | 认证 API + `flywheel-comm room deploy|status|teardown`；Bridge 在沙箱外 `env -i` 跑现有脚本 | **选定**（founder） |
| B. 给 Codex 体开 `danger-full-access` | 去掉沙箱 | 拒：扩大所有 Codex runner 的破坏半径，违背 FLY-245 结构安全思路 |
| C. 需要房的节点只派 Claude 体 | 调度层绕开 | 拒：Codex/Claude 不对等，founder 明确要"一视同仁" |

## 4. 关键问题（进入调研）

1. 身份：共享 ingest token 不能区分 runner——用什么证明"我是 exec X"？
2. 归属：谁起的谁拆、Lead 可代拆；房被判失败后怎么收尾？
3. 执行面：Bridge 子进程的环境要最小（`env -i`）但工具要全（node/pnpm/git/jq/tmux/python3/gh/sqlite3/**codex**）。
4. 残留判定：只能认"属于这间房"的进程，不能按命令行文字匹配。
5. 拆房前快照：有库必须快照；从未建库的房直接跳过并审计。
6. 不给生产 launchd 任何操作权。
