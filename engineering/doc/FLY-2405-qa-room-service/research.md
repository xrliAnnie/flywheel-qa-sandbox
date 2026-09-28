# FLY-2405 起房服务 — 调研
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-28
基于: exploration.md

## R1. runner 身份证明

- `FLYWHEEL_EXEC_ID` 出现在日志、提示词里，**不是秘密**；ingest token 所有 runner 共用，只证明"是某个 runner"。
- `FLYWHEEL_CALLBACK_TOKEN` 由 `TmuxAdapter.ts:299` 每次 launch 生成并只注入该 runner 的 env → 适合作"持有者证明"。
- 结论：请求头带 ingest token（通道认证）+ body 带 `execId` + `callbackProof`；Bridge 用 StateStore 里该 exec 的 launch 记录校验 callback token（常量时间比较），再从 `sessions` 行推导 `session_role`、`adapter_type`、`issue_id`。**payload 任何身份字段都不是权威**（同 `/review-requests` 纪律）。
- 若快照中 callback token 未持久化：实现期在 launch 时写入 `sessions.callback_token_hash`（sha256，不存明文），迁移用幂等 `ALTER TABLE ADD COLUMN`。

## R2. 角色许可

- 允许 `session_role ∈ {qa, implement}` 且 exec 状态为 running 的 runner 起房；generic/未认证节点 → `runner_role_refused`。
- Lead（持 apiToken 的 `/api/qa-rooms/*` 面）可 status 任意房、代拆任意房，不可替 runner 起房（起房必须有 owner exec）。

## R3. 执行面：`env -i` 最小环境

- Bridge 以 `spawn(bash, [script, ...args], { env: minimalEnv, detached: true })` 跑，`shell: false`，参数是数组——**无字符串拼接**，天然免 shell 注入。
- `minimalEnv = { HOME, USER, LOGNAME, TMPDIR, LANG, PATH }` + 白名单 `TEST_*`（正则 `^TEST_[A-Z0-9_]{1,64}$`，值 ≤ 4 KiB，拒绝 `TEST_BOT_TOKEN_*`——bot token 由脚本自己读 `~/.flywheel/.env`）。
- `PATH` 由 **toolDirectories** 生成：对每个必需工具 `node pnpm git jq tmux python3 gh sqlite3 codex` 在 **Bridge 自身 PATH** 上解析真实路径（`which` 等价，`fs.realpathSync` 前取 `dirname` of the resolved link），取目录去重。**不写死任何用户路径**（QA@1 根因：漏 codex → `/Users/<u>/.local/bin` 不在 PATH → `[qa-launchd] ERROR: Codex command is unavailable`）。
  - 必需工具解析失败 → 起房前 fail-closed（`tool_unavailable:<name>`），不跑脚本。
  - `codex` 仅在 `--codex-runner` 房为必需，其余房为可选（能解析就加）。
- 起房前：`pnpm install --frozen-lockfile` + affected build（在 `--expect-head` 对应的 worktree 内），防旧 dist。沿用脚本自身的 `/tmp/flywheel-qa-rebuild.lock` 串行化。

## R4. launchd 边界

- 起房服务只调用 QA 脚本；QA 脚本内部 launchctl 只操作 `com.flywheel.qa.*` label（生产 main 的 `qa-launchd-lead.sh`）。服务层额外加**负向守卫**：请求中任何字段含 `com.flywheel.` 且非 `com.flywheel.qa.` 前缀 → `production_label_refused`；slot 必须 ∈ `test-slots.json` 已定义集合；永不接受 plist 路径 / label 作为参数。

## R5. 残留判定（QA@2 HIGH-1）

- 错误做法：拿 `ps -axo command` 全文匹配房间路径 → 任何命令行里写了 `/tmp/flywheel-test-slot-6` 的无关进程（如只读观察循环）都判成残留。
- 正确做法："属于这间房"的集合 = 房间记录中的 `bridgePid`、`leadPid`、它们的**进程组**（`ps -o pgid`）、launchd QA label（`launchctl print gui/<uid>/<label>` 存在即残留）、`lsof -iTCP:<slotPort> -sTCP:LISTEN` 的监听者、`lsof -d cwd` 的 cwd 在房间目录内的进程。**命令行文字永不参与判定**。

## R6. 恢复与幂等（QA@2 HIGH-2 + QA 返工 2）

房状态机：`requested → deploying → ready → tearing_down → torn_down`，失败支 `deploy_failed` / `teardown_failed`。

- 快照策略：房间记录 `dbCreated` 标志（deploy 过程中 teamlead.db/comm.db 首次出现即置真）。
  - `dbCreated=false` → 拆房跳过快照，审计记 `snapshot_skipped:no_db_created`（无需 `--skip-snapshot`）。
  - `dbCreated=true` 且库在 → 必须快照，失败即 `snapshot_failed`（不拆）。
  - `dbCreated=true` 但库已不在（上次拆房已删数据目录）且状态为 `teardown_failed` → 记 `snapshot_missing:already_removed`，继续。
- 幂等收尾：`teardown_failed` 时 owner 或 Lead 再拆一次 → 重新计算 R5 残留；为空则 `torn_down`，**同一事务**释放 slot 锁 + service claim。

## R7. 已知拆房坑

- 死 Codex socket 软链：reap guard 把"软链存在"当"活会话"。修：软链目标不存在或 socket 无人监听（`lsof -U` 无持有者）→ 视为死，删软链并审计。
- 陈旧 `.flywheel-qa-launch-started` marker：teardown 只信 marker 判 `runtime_started`。修：marker 需同时匹配房间记录的 `deployId`，否则视为陈旧。

## R8. 负载门

- 起房前读 `sysctl -n vm.loadavg` 1 分钟值与活跃房数；issue 给定阈值 "≥144 排队"——解释为**进程负载指标 ≥144 时新请求进入 queued 而非 deploying**，由 Bridge 周期内已有 tick piggyback 复查（零新 timer，沿用 GatePoller 惯例）。阈值 env `FLYWHEEL_QA_ROOM_LOAD_GATE`（默认 144）。

## R9. e2e driver / pretrust 代跑

`$HOME` 根锁在沙箱里拿不到 → 服务提供可选 `--run-driver <allowlisted-name>`：只接受 `scripts/qa-*` 下白名单里的 driver 名称，在房 ready 后于沙箱外执行（同 env -i），pretrust 在沙箱外完成。结果写房间目录供 runner 读。

## R10. codex:rescue / 嵌套诊断（评估，不强求）

同一服务模式可扩成"一次性沙箱外 job"，但涉及把模型会话带出沙箱，风险面更大 → 本单只留接口形状（job kind 枚举预留），不实现。
