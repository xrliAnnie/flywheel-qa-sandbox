# FLY-2867 额外 Claude Lead 收件箱不起 — 探索

Issue: FLY-2867 (https://linear.app/geoforge3d/issue/FLY-2867/病根529-房-n-to-n-部署里-claude-载体的额外-lead-收件箱永远起不来inbox-ready-租约不出现-每次-120)
日期: 2026-09-24
基于: 无

## 1. 现象（issue 原文 + 证据目录）

`scripts/test-deploy.sh 2 --generalized --stub-runner --lead-label Product-Test --extra-lead 4:Finance-Test --expect-head 24e6b1a8`
在 FLY-2862 工作树里连跑两次（18:29、20:32 PDT，第二次时 Claude 额度已重置）都在同一步失败：

- 主 Lead `flywheel-test-2`（codex-app-server 载体）正常 ready；
- 额外 Lead `flywheel-test-4`（claude-code 载体）：`Confirmed dev-channels prompt` 之后，
  `${LEASE_DIR}/.inbox-ready-flywheel-test-4` 始终不出现，120 秒后 `campaign_abort`；
- 中止后的清理也不收敛：`[qa-launchd] ERROR: carrier=codex-tui step=updater-converge result=not-found`，
  随后 `QA Lead cleanup did not converge` / `generalized cleanup did not converge` /
  `provisioned Codex credential residue remains`，slot 2 与借用的 slot 4 锁都被保留，
  要 Lead 手删 `cdxh/flywheel-test-2/.flywheel-qa-launch-started` 与 `launchd/flywheel-test-2/pid` 才能 teardown。

证据：`~/.flywheel/qa-evidence/slot-2/20260925T0336Z-2862-n2n-fail/`。

证据里有两条容易被忽略的事实：

1. `extra-leads/slot-4/discord-state/gateway-health.log` 在 03:33:25Z 写了 `gateway shard 0 ready` ——
   额外 Lead 的 Claude 进程**起来了**，Discord 插件也**连上了**。缺的只是收件箱那一半。
2. `extra-leads/slot-4/lead.log` 只有 wrapper-v2 的启动行。这是正常的：`claude-lead.sh` 的 `log()`
   打到 tmux pane（`echo "[lead] …"`），不进 `lead.log`；pane 在中止时被杀，所以现场唯一能说明原因的那行字没留下。

## 2. 两个独立的缺陷

### 缺陷 A：Claude 载体 Lead 的收件箱 MCP 根本没注册

`.inbox-ready-<agent>` 只由 `packages/inbox-mcp` 在 `server.connect()` 之后写出
（`packages/inbox-mcp/src/index.ts`），路径 = `dirname(FLYWHEEL_COMM_DB)`（或 `FLYWHEEL_COMM_ROOT/<project>`）。
`qa_slot_start_lead` 给额外 Lead 的坐标与 `LEASE_DIR` 完全一致（都是 `${SLOT_DIR}/state/comm/${TEST_PROJECT_NAME}`），
所以不是路径不一致。

真正的问题在 `claude-lead.sh`（约 2706 / 2766–2795 行）：

```bash
INBOX_MCP_DIR="${SCRIPT_DIR}/../../inbox-mcp/dist"
…
elif [ -d "$INBOX_MCP_DIR" ]; then   # 注册 flywheel-inbox
else
  log "WARNING: inbox-mcp not built (${INBOX_MCP_DIR} missing), CommDB push disabled"
fi
```

529 房的 Lead 跑的是**被测工作树里的** `claude-lead.sh`，于是它找的是被测工作树的 `packages/inbox-mcp/dist`。
而 `test-deploy.sh` 的预检只构建 config / edge-worker / claude-runner / flywheel-comm / teamlead（+ 可选 voice），
**从不构建 inbox-mcp 与 terminal-mcp** —— 这两个包也不在 teamlead 的依赖闭包里
（`packages/teamlead/package.json` 不依赖它们），所以「按 teamlead 所需构建」的任何准备都会漏掉它们。

本机工作树普查（2026-09-24 20:5x，只读）：凡是只跑过 test-deploy 预检的工作树都是
`teamlead dist = 有、inbox-mcp dist = 无`，FLY-2862 正是其中之一；跑过 `pnpm -r build` 的工作树两者都有。

**本机复现（红 / 绿）**：在本工作树只构建 teamlead 依赖闭包后，用隔离 HOME 跑真 `claude-lead.sh` 的 dry-run
（`FLYWHEEL_LEAD_DRY_RUN=1`，标准部门 Lead）：

| 状态 | 输出 |
|---|---|
| inbox-mcp / terminal-mcp 未构建 | `WARNING: inbox-mcp not built (…/inbox-mcp/dist missing), CommDB push disabled`；launch plan 里**没有** `MCP_SERVER flywheel-inbox` |
| `pnpm --filter flywheel-inbox-mcp build`（+terminal，共约 6 秒）后 | `Inbox MCP: enabled`；launch plan 出现 `MCP_SERVER flywheel-inbox` 与 `MCP_SERVER flywheel-terminal` |

⇒ 没有 flywheel-inbox MCP ⇒ 没有进程会写 `.inbox-ready-<agent>` ⇒ 120 秒必然超时。与额度无关，100% 复现，
只要被测工作树没跑过全量 build。主 Lead 若是 Claude 载体也会撞同一条（本次主 Lead 恰好是 Codex，所以只在额外 Lead 上暴露）。

降级方式本身也是问题的一部分：`claude-lead.sh` 只往 pane 打一行 WARNING 就继续启动一个「收不到信的 Lead」，
`test-deploy.sh` 这边只看得到「租约没出现」，120 秒后给出一句无原因的超时。

### 缺陷 B：Codex 载体的停机收敛判据跟不上新版 Codex

`scripts/lib/qa-launchd-lead.sh::qa_launchd_stop_codex_entry` 在停掉 launchd 作业和 daemon 之后，要求：

- 如果这个 home「运行过」（launch marker 在 / runtime pid 在 / daemon pid 文件或 socket 在），
  那就**必须**在进程表里找到并停掉一个 `…/codex app-server daemon pid-update-loop`（updater）；
- 找不到（`QA_LAUNCHD_CODEX_UPDATER_NOT_FOUND`）就记 `updater-converge result=not-found` 并判失败 ⇒ 不 retire home ⇒
  `auth.json` 留在 `cdxh/` ⇒ 锁被保留。

这条「必须找到 updater」的判据写于 FLY-2301（Codex 0.14x，老 daemon 模型下 updater 必然常驻）。
现在宿主 Codex 已升到 0.157.0，daemon 换成了 managed 模型：

- 进程表只读观察：slot 1（Codex 0.156.1，17:53 起）daemon 是
  `…/cdxh/flywheel-test-1/packages/app-server-daemon/releases/0.156.1-…/bin/codex app-server --remote-control --listen unix:// --managed-daemon`，
  **三个小时里没有任何 `pid-update-loop` 进程**；slot 3（13:46 起，Codex 0.153.2，老模型）则仍有 updater。
- 失败现场的主 Lead 日志也写着 `Installing daemon from CLI version 0.157.0 into …/cdxh/flywheel-test-2/packages/app-server-daemon…`（managed 安装）。
- 0.157.0 二进制字面量里有 `--managed-daemon`、`app-server-updater.pid`、`standalone installer does not support guarded updates` 等 managed 模型的串。

⇒ 在 **slot home 的供给形态**下（managed 安装、没有 standalone 的 updater），「运行过但没有 updater」是**正常终态**，而不是「updater 藏起来了」。
注意这不是 Codex 版本不变式：生产的 0.157.0 home（raya / infra-bot）同时跑着 `--managed-daemon` daemon 和
`…/standalone/releases/0.157.0-…/bin/codex app-server daemon pid-update-loop`（设计评审 R1 指出）。修复因此不依赖「某版本有没有 updater」。

managed 布局还有第二处漂移（设计评审 R1 指出，已只读核实）：managed daemon 的 pid 记录是
`app-server-daemon/daemon.pid`（外加 `daemon.pid.lock`、`daemon-updater.pid.lock`），**没有** `app-server.pid`；
而停机路径只读 `app-server.pid`，所以 managed 下 daemon-converge 实际只在等 socket 消失，不看 daemon 进程本身。
现有判据把正常终态判成不收敛，于是**每一次** Codex 载体房的清理（部署中止路径和正常 teardown 都走 `qa_launchd_stop_registry`）都会卡住，
直到有人手删 launch marker / pid 文件让 `runtime_started=0`。

注：为进一步坐实，我尝试在 `/tmp` 起一个与 slot 同形的隔离 CODEX_HOME 跑真 `remote-control start/stop`，
该命令被本环境的权限拒绝，没有执行；以上结论只依赖进程表只读观察、失败日志与二进制字面量。

## 3. 要回答的问题 → 结论

| 问题 | 结论 |
|---|---|
| 插件没加载？ | 否。gateway-health.log 证明 Discord 插件已连上。 |
| MCP 没连上？ | **是** —— flywheel-inbox MCP 根本没被写进 `.mcp.json`（dist 缺失）。 |
| 卡在首启提示？ | 否。dev-channels 提示已确认，插件随后就绪。 |
| LEASE_DIR 路径不一致？ | 否。`qa_slot_start_lead` 注入的 `FLYWHEEL_COMM_DB/ROOT` 与 `LEASE_DIR` 同源同值。 |
| 身份或 token 注入缺失？ | 否。与租约无关（gateway 已用该 bot token 连上）。 |
| 清理为何不收敛？ | 缺陷 B：新版 Codex managed daemon 不起 updater，停机判据把「无 updater」当失败。 |

## 4. 修复方向（细节见 plan.md）

1. 预检补建 claude-lead.sh 运行时要加载的两个 MCP 包，并在预检里断言 inbox-mcp 的 dist 入口存在（缺 = 预检失败并点名，不再 120 秒后无名超时）。
2. 租约超时时给出**有名字的原因**（读该 Lead 工作区 `.mcp.json` 是否注册了 flywheel-inbox），让同类问题下一次在 deploy.log 里就能看见。
3. Codex 停机：不再把「找不到 updater」本身当失败；retire 前统一做一次**按 home 锚定的进程残留普查**（无论 updater 找没找到）；普查为空才算收敛，有任何引用该 home 的进程仍 fail-closed（并报残留数）。`daemon.pid` 也算「运行过」的证据。
4. 本机可跑的用例：真 inbox-mcp 进程 + 与 `qa_slot_start_lead` 同一套坐标 ⇒ 租约出现在 `test-deploy` 等待的那条路径上；真 `claude-lead.sh` dry-run ⇒ 注册了 flywheel-inbox；停机残留判据的红绿用例。
