# FLY-2922 held 统一恢复口 · QA@3 返工 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: exploration.md

## R1. 房间的 tmux 到底住在哪（单一真相来源）

| 来源 | 结论 |
|------|------|
| `scripts/lib/qa-slot-env-contract.json` `TMUX_TMPDIR` 条目 | `disposition: redirect`，`value: ${SLOT_DIR}`，`boot: mustBeUnderRoot` —— 房间 Bridge 及其子进程都在 `<slotDir>` 命名空间起 tmux |
| `packages/claude-runner/src/codex-runner-tui-window.ts` `tmuxSocketPath()` | Codex runner 显式 `-S`，路径 = `realpath($TMUX_TMPDIR)/tmux-<uid>/default` —— 与 `TMUX_TMPDIR=<slotDir>` 的默认 server **是同一个 socket**（未设 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 时；房间合同不设它） |
| tmux 自身规则 | 未给 `-S/-L` 时，socket = `$TMUX_TMPDIR/tmux-<uid>/default`；若环境里有 `$TMUX`，客户端会**优先连 `$TMUX` 指向的 server** |

**推论**：driver 只要把子进程 env 设成 `TMUX_TMPDIR=<slotDir>` 并删掉 `TMUX`/`TMUX_PANE`，就能在 Claude runner 与 Codex runner 两种房间里都命中正确 server。选 `TMUX_TMPDIR` 而不是自己拼 `-S` 路径，是为了不复制 tmux 的路径规则（realpath、uid 目录）——一处真相，少一处漂移。

## R2. driver 的 tmux 调用面（审计 PR #1374 头）

- `scripts/qa-529-generalized-e2e.mjs`：`probeExecution(slotDir, commDb, executionId)` 是唯一 tmux 调用点（pane 身份 + 存活 + `@flywheel_exec_id` 绑定）。
- 其它 liveness 信号：`processAlive(stub.pid)` 走 `kill(pid,0)`，与命名空间无关。
- 结论：把探活收进库函数 `probeRoomPaneAlive({target, executionId, slotDir, env, spawn})`，driver 只调这一个函数，测试可注入 `spawn`。

## R3. 为什么 step 4 被卡死而不是报错

`classifyImplementPark` 对 `rework_reachable_wait` 的判据：`node=done ∧ session=ship_parked ∧ terminal_at=null ∧ park_opened ∧ reason=rework_reachable_wait ∧ processBody=null ∧ liveness=alive`。前 6 项房内全部成立，唯独 liveness 被错判 dead → 返回 `null` → driver 把 `null` 当「还没到」继续轮询 → 无限等待（近 2h）。所以修复点只在输入（liveness），分类规则不动。

## R4. 负面守卫（防止修歪）

| 守卫 | 为什么 |
|------|-------|
| slotDir 缺失 / 空 / 相对路径 → **抛错** | 静默回落宿主命名空间 = 复现本 bug |
| target 形态非法（非 `session:@window` / `%pane`）→ 返回 false 且**不 spawn** | 防止 tmux 模糊匹配到别的窗口 |
| `@flywheel_exec_id` 必须等于期望 executionId | 同名窗口复用时不把别人的 pane 当成本体 |
| 不改宿主 `process.env` | 探活是纯函数式子进程注入 |

## R5. 与 origin/main 的冲突（`scripts/test-deploy.sh`）

- main 侧：FLY-2405 起房/拆房、FLY-2902 等对 test-deploy.sh 的加性改动。
- 本分支：generalized 房间逻辑（`--generalized --codex-runner --qa-stub-runner`，以及 QA@2 修过的「stub 只按 QA 执行作用域注入」）。
- 策略：`git merge origin/main`（**merge 不 rebase**，保留 QA 已审历史），逐块保留两侧；冲突块若是同一变量/函数的两种改法，以「main 的房间生命周期 + 本分支的 generalized flag 分支」组合；取舍写进 PR 描述。
- 验证：`scripts/__tests__/test-deploy-generalized.test.sh` + 与 test-deploy 相关的现有 shell 测试。

## R6. 真 tmux 测试是否可行

本机有 tmux。可在短路径 `/tmp/qa529-room-XXXX` 起一个独立 server（`TMUX_TMPDIR` 隔离，短路径避免 unix socket `sun_path` 104 字节上限），同时准备一个空的宿主命名空间 `/tmp/qa529-host-XXXX`：
- 旧逻辑（宿主命名空间 display-message）→ 非 0 退出 = 判 dead（RED 证据）；
- 新逻辑 `probeRoomPaneAlive` → alive；换 executionId → false；
- 把两种 liveness 喂给 `classifyImplementPark` → 新逻辑得 `rework_reachable_wait`，旧逻辑得 `null`。
测试结束 `kill-server` + 删目录。无 tmux 的环境 skip（CI 仍跑纯注入单测）。
