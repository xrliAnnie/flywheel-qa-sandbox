# FLY-2867 额外 Claude Lead 收件箱不起 — 调研

Issue: FLY-2867 (https://linear.app/geoforge3d/issue/FLY-2867/病根529-房-n-to-n-部署里-claude-载体的额外-lead-收件箱永远起不来inbox-ready-租约不出现-每次-120)
日期: 2026-09-24
基于: exploration.md

## 1. 代码面（修改点与其现有契约）

| 文件 | 现状 | 与本单的关系 |
|---|---|---|
| `scripts/test-deploy.sh` 预检（约 448–580 行，`/tmp/flywheel-qa-rebuild.lock` 内的子 shell） | 构建 config(仅 generalized) / edge-worker / claude-runner / flywheel-comm / teamlead / voice(仅 voice fixture)；退出码 11–19 已占用 | 缺 inbox-mcp、terminal-mcp 的构建与断言（缺陷 A） |
| `scripts/test-deploy.sh` 主 Lead 与额外 Lead 的租约等待（约 1956–2000、2178–2197 行） | 只轮询 `.inbox-ready-<agent>`；超时只报「did not become ready」 | 超时无原因（缺陷 A 的放大器） |
| `packages/teamlead/scripts/claude-lead.sh`（约 2706、2766–2795 行） | `inbox-mcp/dist` 不存在时打 WARNING 并跳过注册 flywheel-inbox | 真正的触发点；**不改**（生产 Lead 启动语义，见 §4） |
| `packages/inbox-mcp/src/index.ts` + `comm-db-path.ts` | `connect()` 后写 `dirname(commDb)/.inbox-ready-<lead>`；`FLYWHEEL_COMM_ROOT`+项目名优先于 `FLYWHEEL_COMM_DB` | 不改；新用例用真 dist 驱动 |
| `scripts/lib/qa-launchd-lead.sh::qa_launchd_stop_codex_entry` | 运行过 + 找不到 updater ⇒ `updater-converge result=not-found` ⇒ 失败 | 缺陷 B |
| `scripts/lib/qa-launchd-lead.sh::qa_launchd_codex_updater_pids` | `LC_ALL=C ps -ww -axo pid=,command=` + 精确 argv 后缀 + `CODEX_HOME` 环境探针 | 残留普查复用同一条 `ps` 调用（测试桩已按这个字面量打桩） |
| `scripts/lib/qa-room.sh` | 529 房纯函数助手，被 test-deploy 与 fly1389 假仓库都 source/拷贝 | 新助手放这里 |

## 2. 测试面

- `scripts/__tests__/test-deploy-fly1389.test.sh`：**唯一**穿过真实预检的隔离 E2E（假仓库 + 桩 pnpm `exit 0` + 桩 claude-lead.sh 自己写租约）。
  预检加了断言后，假仓库必须补 `packages/inbox-mcp/dist/index.js`、`packages/terminal-mcp/dist/index.js` 夹具，否则全部 E 用例在预检就死。
  这里也最适合放「dist 缺失 ⇒ 预检点名失败、且不认领 slot」的阴性 E2E（桩 pnpm 的 build 什么都不产出，正好模拟「build 没产出」）。
- `scripts/__tests__/fly1663-qa-launchd.test.sh`：codex-tui 停机的全部契约用例（成功收敛、argv 漂移不算收敛、未启动 home 可 retire、daemon 活着要失败、bootout 失败……）。
  新的两个用例（managed daemon 无 updater 且无残留 ⇒ 收敛；无匹配 updater 但仍有进程引用该 home ⇒ 失败并报残留数）放这里。
- `scripts/__tests__/fly1663-qa-launchd-mutants.test.sh`：变异点只涉及 plist/argv/env/manifest/诊断调用点，不涉及 updater 收敛逻辑，无需改。
- CI：`ci.yml` 的 Script Tests 分片在跑 shell 用例前都有 `pnpm build`（全量），所以新用例可以依赖 inbox-mcp / teamlead 的 dist，缺就**失败**而不是 SKIP。
  `ci-shell-suite-enumeration.test.sh` 要求每个新 `scripts/__tests__/*.test.sh` 在 ci.yml 里字面枚举（或进 manual-only 清单）。
- 已有 `claude-lead.sh` dry-run 用例（`fly231-companion-launch-plan.test.sh` 等）证明：隔离 HOME + `FLYWHEEL_LEAD_DRY_RUN=1` 会写 `.mcp.json` 并在 launch plan 里列 `MCP_SERVER\t<name>`，不启动 tmux、不碰真实账号。
- kill-path / child-process 清册只扫 `packages/**/*.ts` 生产文件；本单只改 shell，不新增 kill 调用，不触发。

## 3. Codex managed daemon 的事实（只读取证）

| 观察 | 来源 |
|---|---|
| 宿主 `codex` = 0.157.0（raya 的 standalone release） | `codex --version`、`~/.local/bin/codex` 软链 |
| slot 1（0.156.1）daemon 为 `…/packages/app-server-daemon/releases/0.156.1-…/bin/codex app-server … --managed-daemon`，三小时无 `pid-update-loop` | `ps -ww -axo pid,ppid,lstart,command`（只读） |
| slot 3（0.153.2，13:46 起）仍是老模型：`…/standalone/current/codex app-server daemon pid-update-loop` 常驻 | 同上 |
| 失败现场主 Lead：`Installing daemon from CLI version 0.157.0 into …/packages/app-server-daemon…` | `qa-evidence/…/lead.log` |
| 0.157.0 二进制含 `--managed-daemon`、`app-server-updater.pid`、`standalone installer does not support guarded updates` | `strings`（只读） |

| managed daemon 的 pid 记录叫 `app-server-daemon/daemon.pid`（+ `daemon.pid.lock` / `daemon-updater.pid.lock`），没有 `app-server.pid` | 设计评审 R1 只读核实 slot 1 与 slot 2 残留 home |
| 生产 0.157.0 home（raya / infra-bot）同时有 managed daemon 与 `pid-update-loop` | 设计评审 R1 只读 `ps` |

结论：在 slot home 的供给形态下，「home 运行过 + 没有 updater」是合法终态（这是供给形态的事实，不是版本不变式）。
不能再用「必须找到 updater」作为收敛证明，也不能只靠某个 pid 文件名；统一改用「没有任何进程引用该 home」。

## 4. 方案比较

### 缺陷 A

| 方案 | 取舍 | 结论 |
|---|---|---|
| A1 预检构建 inbox-mcp + terminal-mcp，并断言 inbox-mcp dist 入口存在 | 直接消除前提缺失；两包 tsc 本机约 6 秒；预检本来就是「让被测工作树可跑」的地方 | **采用** |
| A2 让 `claude-lead.sh` 在缺 inbox-mcp 时 fail-closed | 改的是**生产** Lead 启动语义（生产从已全量构建的 main 跑，不受影响，但属于另一件事） | 不做，记为后续可选项 |
| A3 只在 test-deploy 里断言、不构建 | 仍然要人手 `pnpm -r build`，QA 照样被挡 | 否 |
| A4 在租约等待循环里发现 `.mcp.json` 无 flywheel-inbox 就提前中止 | 同一 slot 目录可能残留上一次失败的 `.mcp.json`，提前中止会误判 | 只做**超时时的原因诊断**，不提前中止 |

terminal-mcp 不影响就绪判定，但缺了它 Lead 没有 `close_runner` 等工具，房里的 Claude Lead 与生产不等价；与 inbox-mcp 同根（都是 claude-lead.sh 从工作树加载的 MCP），一并构建，只把 inbox-mcp 设为就绪硬断言。

### 缺陷 B

| 方案 | 取舍 | 结论 |
|---|---|---|
| B1 「找不到 updater」不再单独判失败；retire 前（home 运行过且此前无失败）统一做一次**按 home 锚定的进程残留普查**（argv 含该 home 的原样路径、规范路径或 `/tmp`↔`/private/tmp` 别名，且其后不紧跟路径名字符），有界轮询；为空才收敛（v2：评审 R1 建议由 NOT_FOUND 分支扩为统一契约） | 与 Codex 版本无关；任何仍引用该 home 的进程（含 argv 漂移的 updater、残留 TUI、code-mode-host）都让它继续 fail-closed | **采用** |
| B2 检测到 `packages/app-server-daemon/` 就放行 | 靠版本布局嗅探，下次布局变又坏；且放过了真残留 | 否 |
| B3 把 managed 安装路径下的 updater 也纳入精确匹配并杀掉 | 新增杀进程面；解决不了「根本没有 updater」 | 否 |

现有用例「argv 漂移（`pid-update-loop-v2`）不算收敛」在 B1 下依然成立：漂移进程的 argv 含该 home 的二进制路径 ⇒ 普查非空 ⇒ 失败。

## 5. 本机/真机验证边界

- 本机可证：预检构建与断言（红绿）；真 `claude-lead.sh` dry-run 注册 flywheel-inbox；真 inbox-mcp 进程按 529 房坐标把租约写到 `test-deploy` 等待的路径并在退出时删除；codex 停机新判据（红绿）。
- 只能真机证：Discord 通道 ready、founder 身份消息在额外 Lead 频道被收下并回复（整圈）—— 交付 4 的真房一次 + QA 判据。
- 隔离 CODEX_HOME 真 daemon 实验本次被环境权限拒绝，未执行；缺陷 B 的判据改动本身对「有残留」仍 fail-closed，因此即便 managed 模型下存在未知形态的 updater，最坏结果与今天相同（不收敛），不会变成误删。
