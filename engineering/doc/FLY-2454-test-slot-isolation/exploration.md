# FLY-2454 529 房 test slot 隔离洞修复 — 探索
Issue: FLY-2454 (https://linear.app/geoforge3d/issue/FLY-2454/529-房隔离-修两处-test-slot-隔离洞-test-deploy-走漏-resident-codex-三根-env-slot)
日期: 2026-09-09
基于: 无

## 1. 一句话

529 房(`scripts/test-deploy.sh` 起的隔离测试 slot)曾两次伤到生产:slot Bridge 的孤儿清扫器杀掉生产 Codex 舰队(FLY-2231),slot 的 terminate 越界杀掉生产 tmux 服务器(FLY-2287)。本单要把「slot 只能碰自己的东西」从**靴带脚本里的约定**升级为**Bridge 进程自己会拒绝的边界**,并用修前红、修后绿的阴性对照把它钉在 CI 里。

## 2. 先说清楚:两处洞的 env 走漏部分**已经在 main 上修掉了**

审计 `origin/main`(d7b75c755)得到的事实,和 issue 原文的时间线对得上:

| 病根单 | 走漏的 env | 修复 PR | 现状(main) |
| --- | --- | --- | --- |
| FLY-2231 | `FLYWHEEL_CODEX_HOMES_ROOT` / `FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` | FLY-2174 #1021 (2026-09-01) | `scripts/test-deploy.sh:901-903` 三根 later-win 到 `${SLOT_DIR}/state/...` |
| FLY-2287 | `FLYWHEEL_COMM_DB` 及全部 `FLYWHEEL_*` | FLY-2284 #1083 (2026-09-05) | `scripts/test-deploy.sh:760-790` 对 caller env 做模式 deny(`FLYWHEEL_*|DELIVERY_*|*_DB|*_DIR|*_TOKEN|CODEX_HOME`),再显式重投影 |

FLY-2287 事发时的代码头是 `/private/tmp/fly2248-head`,早于 #1083,所以它复现的是**修前**形状。也就是说 issue 的四条「要做」里,第 1 条(枚举 + 白名单)已完成约 70%,第 2 条(动手前校验目标归属)**完全没做**,第 3 条(阴性对照)只有 env 层面的 hermetic 断言、没有「真起一个像孤儿的进程 + 一个 tmux 窗口,证明清扫器与 terminate 不碰」的承重测试,第 4 条(台架文档)未动。

这一点必须写进 founder 报告:**本单不是重做 2174/2284,而是补上它们没做的那一角——Bridge 侧的自我边界。**

## 3. 还剩什么洞(审计清单)

### 3.1 env 层:deny 模式不是白名单,而且有三处仍指向 `~/.flywheel`

`test-deploy.sh` 现在的做法是「默认放行,按名字模式删掉危险家族,再把 slot 坐标一条条加回去」。它够用,但不是 issue 要的「显式白名单」,具体缺口:

1. **slot Bridge 的 CommDB 仍在生产 HOME 下**:`FLYWHEEL_COMM_DB=${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}/comm.db`(`test-deploy.sh:1973`)。它不是生产那颗库,但违反 FLY-2287 写明的修法要求「slot 启动 fail-closed 拒绝任何指向 `~/.flywheel` 的 DB/socket 路径」。而且 Bridge 进程**根本不读这个变量**——Bridge 内部用 `commDbPathForProject()`(`packages/teamlead/src/bridge/commdb-path.ts`)按 `FLYWHEEL_COMM_ROOT || ~/.flywheel/comm` 推导,所以 `FLYWHEEL_COMM_DB` 对 Bridge 只是个摆设,真正的坐标 `FLYWHEEL_COMM_ROOT` 反而没设。
2. **slot 里 Bridge 与 Codex Lead 的 CommDB 路径不一致**:Codex TUI Lead 载体用 `${SLOT_DIR}/state/comm/${TEST_PROJECT_NAME}/comm.db`(`test-deploy.sh:1548`),Bridge 用 HOME 下那颗。两边各写各的库。这是审计里意外撞到的,本单只记账并在设计里顺手统一,不另立结论(是否已造成 Lead 收不到信,交给 QA 核)。
3. **CommDB 路径推导散在 ≥12 处、三套词汇**(`FLYWHEEL_COMM_DB` / `FLYWHEEL_COMM_ROOT` / `FLYWHEEL_COMM_DIR` / 硬编码 `homedir()`),见 research.md §3。这正是「镜像词汇」问题:改一处不等于改全。
4. **`TMUX` / `TMUX_PANE` / `TMPDIR` 不在 deny 家族里**,靠三条分支各自手写 `-u TMUX` 和 `TMPDIR=` 覆盖,`TMUX_PANE` 干脆没清(runner pane 里起房时它是生产 pane id;目前无消费者,但它就是那种「等到有人消费才炸」的坐标)。
5. **没有 kill ledger 的 slot 归档**:FLY-2231 之所以「事后归因极难」,是因为清扫器的审计行落在 slot 的 StateStore 与 `${SLOT_DIR}/kill-ledger/`,teardown 一拆全没。

### 3.2 进程层:Bridge 的每一条杀路都「信任输入坐标」,没有「目标属于我」的校验

全仓所有 runner-affecting 的 kill 都汇到一个咽喉:`auditedSignal()` / `auditedSignalAsync()`(`packages/claude-runner/src/kill-ledger.ts`)。它做的是「先写 ledger 再发信号」,**不判断目标是谁的**。调用它的七处:

- `codex-runner-orphan-reaper.ts`(FLY-2231 的凶手:pgid SIGTERM/SIGKILL)
- `mcp-descendant-reaper.ts`(pane pid 的 MCP 子孙)
- `codex-daemon-runtime.ts`(Codex daemon 进程组;terminate / closeRunner 走的 `reapCodexDaemonForExecution`)
- `tmux-lookup.ts`(`kill-window`,含带 `-S <socket>` 的精确杀与不带 `-S` 的默认服务器杀)
- `TmuxAdapter.ts`(scaffold 窗口清理)
- `codex-runner-tui-window.ts`(TUI 窗口关闭)
- 另有 `terminal-tab-reaper.ts` / `viewer-session-reaper.ts` 直接 `execFile("tmux",["kill-session",...])`,未经 ledger(kill-path-inventory 归为 out-of-scope 的 viewer 会话)

每一处的守卫都是**身份守卫**(argv 精确、socket 精确、lsof 持有者精确、pgid 新鲜),FLY-2174 的 reaper 尤其严密——但它们回答的问题是「这个进程是不是那个 execution 的」,不是「那个 execution 是不是我这个 slot 的」。输入坐标一旦被走漏(2231)或库被共享(2287),身份守卫全绿,照杀。**这就是 issue 第 2 条要补的那一角。**

### 3.3 关于 FLY-2287 的精确杀链,我不能从代码里复原

FLY-2287 记录的是「slot env 里 `FLYWHEEL_COMM_DB` 指向生产 → terminate 进程树杀越界 → 生产 tmux 服务器(pid 87199)死亡、QA 体 curl exit 137」。静态读 `close-runner.ts` / `actions.ts handleTerminate` / `codex-daemon-runtime.ts`,每条 pgid 杀都有 `pgid === pid || pgid === ppid` 与 `pgid <= 1` 的拒绝,理论上不该碰到祖先。审计到此我**无法证明**具体是哪条路发出了那个 SIGKILL,也无法排除是 CommDB 行里的 tmux 目标让不带 `-S` 的 `tmux kill-*` 走到了默认服务器。

设计上的应对不是猜:**把「目标坐标必须在我的隔离根之下」加在咽喉处**,不管哪条路、哪种输入被毒化,越界一律拒绝并留痕。这样 2287 的精确链条不影响修法覆盖面;它留给 QA 的阴性对照去实测。

## 4. 目标与非目标

**目标**

1. 一份显式的 slot 坐标白名单(单一来源),Bridge 与两种 Lead 载体、runner 都从它派生;不在名单上的坐标一律清空或改指 slot。
2. Bridge 进程在 slot 模式下**启动即自检**(fail-closed):任何将要用于破坏性动作的坐标不在隔离根下就拒绝启动。
3. 每一次破坏性信号在动手前校验目标归属(socket / codex home / ledger / tmux socket 路径都在隔离根下),不属于就拒绝 + 审计行 + StateStore 事件 + stderr 告警。
4. 阴性对照测试:真起一具「像孤儿」的 Codex daemon 与一个真 tmux 窗口在「生产侧」夹具里,slot 侧清扫器与 terminate 都不碰;把守卫去掉(或隔离根不设)同一场景必须能杀掉它们——修前红、修后绿,进 CI。
5. teardown 前先归档 slot 的 kill ledger 与 boundary 拒绝事件(评价「有没有越界」的证据不能随房一起拆)。
6. 台架文档:529 路书 / qa-framework README / e2e 引用处写清隔离契约与真机快照法。

**非目标(边界,照 issue)**

- 不改生产 Bridge 行为:所有新守卫由 `FLYWHEEL_ISOLATION_ROOT` 触发,生产从不设它,代码路径逐字等价。
- 不动 FLY-2352 的修复代码(`codex-session-reown.ts`)。
- 不修 slot Lead bootstrap。
- 不重构 `auditedSignal` 之外的 kill 序列顺序(各 call site 的「battle-tested kill sequence」保持)。

## 5. 方案选择

### 5.1 白名单的形态

| 选项 | 做法 | 取舍 |
| --- | --- | --- |
| A. `env -i` 全清 + 基础 passthrough 名单 | 最严格的字面「白名单」 | Bridge 与它起的 runner 需要多少宿主 env(PATH/PNPM_HOME/LANG/凭据族…)没有盘点过;FLY-2284 评审已把「required-env-inventory」判为 scope 外。现在硬切 = 房间随机坏,而且坏法是静默的 |
| **B. 坐标轴白名单(推荐)** | 把「坐标类」名字(路径 / DB / socket / 身份)全部收进一份契约文件,每个名字标注处置(redirect→slot / clear / 有理由的 passthrough);`test-deploy.sh` 三条 Bridge 分支与两种 Lead 载体只从这份契约生成 env;现有模式 deny 保留为**兜底网**,并扩到 `TMUX*` / `TMPDIR` / `*_ROOT`;凡命中家族却不在契约里的名字,清掉并在 launch-manifest 记一行「unclassified coordinate cleared」 | 满足 issue 的「显式白名单 + 不在名单一律清空/改指」;凭据类 env 维持 FLY-2284 已批的继承范围,不引入新的未知 |
| C. 维持现状 deny | 零改动 | 不满足 issue 第 1 条;三处 `~/.flywheel` 残留照旧 |

选 B。契约文件同时被 Bridge 侧启动自检消费(见 5.3),这样脚本与进程读的是同一份名单,而不是两套互相镜像的清单。

### 5.2 CommDB 搬进 slot 还是留在 HOME 下

| 选项 | 做法 | 取舍 |
| --- | --- | --- |
| A. 留在 `~/.flywheel/comm/<slot-project>/`,启动自检对它开一条具名例外 | 改动最小 | 例外本身就是一个新洞;Bridge 与 Codex Lead 的路径不一致继续存在;不满足 2287 修法要求 |
| **B. 统一到 `FLYWHEEL_COMM_ROOT=${SLOT_DIR}/state/comm`(推荐)** | Bridge 已经认 `FLYWHEEL_COMM_ROOT`;两种 Lead 载体显式拿到 `FLYWHEEL_COMM_DB`;`claude-lead.sh:676` 改成 `${FLYWHEEL_COMM_DB:-…}`(与七个 codex lead 脚本同款写法);`flywheel-comm --project` 与 Bridge 内三处硬编码 `homedir()` 的只读探针改走 `commDbPathForProject()`;inbox-mcp 的 lease 目录改为 `dirname(commDbPath)`(生产下二者相等,字节不变) | 触及生产 Lead 脚本与 CLI,但每处都是「env 未设 ⇒ 原路径」的等价改写;顺手消灭 Bridge/Codex-Lead 路径不一致 |

选 B。风险点在 research.md §3 逐条列出消费者与等价性论证。

### 5.3 「目标属于本 slot」怎么判

考虑过三种证明:

1. **进程 env 溯源**(目标进程环境里带同一个 `FLYWHEEL_ISOLATION_ROOT`):最直观,但 macOS 上 `ps -E`/`ps eww` 在本 runner shell 里实测**读不到任何 env**(2026-09-09,两种写法各 0 条),`qa-launchd-lead.sh` 的同款探针也只在 `/proc` 可读时可靠。不能作为主判据。
2. **祖先链**(目标是 Bridge 的后代):Codex daemon 与 tmux 服务器都会 reparent 到 launchd(ppid=1),对本单最关键的两类目标恰好失效。
3. **坐标归属**(目标的 socket / codex home / ledger / tmux socket 路径 canonical 后落在隔离根之下):每条杀路在动手时手里**都已经握着**这样一个路径(reaper 有 `candidate.socketPath` 与 `codexHome`;daemon runtime 有 `opts.socketPath`;tmux 路径要么显式 `-S socketPath`,要么可以在同一条 `display-message` 里顺手读出 `#{socket_path}`)。确定性、跨平台、与 issue 措辞一致(「按 slot 前缀 / socket / DB 路径」)。

选 3 作为唯一判据;1 与 2 不做。落点是 `auditedSignal` 的输入增加一个可选 `boundary` 证据字段,slot 模式下**必须提供且全部在根下**,否则返回新的失败种类 `boundary_refused`。生产模式下该字段被忽略,行为逐字不变。

不带 `-S` 的 `tmux` 调用(`isTmuxSessionAlive`、viewer/terminal reaper 等)由**启动自检**兜底:`TMUX_TMPDIR` 必须在根下且 `TMUX` 必须为空,否则 Bridge 不起。这样默认服务器就是 slot 服务器,plain `tmux` 不可能解析到生产。

### 5.4 阴性对照怎么「修前红」

env 层的修复已在 main,所以「修前」只能是**关掉新守卫**。设计成同一夹具跑两遍:设 `FLYWHEEL_ISOLATION_ROOT` ⇒ 目标存活、`boundary_refused` 计数 = 1;不设 ⇒ 目标被杀。后一遍就是 2231/2287 形状的复现,证明夹具与断言承重。夹具用真进程(真 tmux 服务器、真 detached socket holder、真 lsof),复用 FLY-2174 在 `test-deploy-generalized.test.sh:942-995` 已跑通的配方;CI 的 Unit job 已装 tmux + lsof,teamlead 已有 `tmux-lookup.real-tmux.test.ts` 先例。

## 6. 给 Lead 的两个非阻塞问题(继续独立推进)

1. 5.2 选 B 会改 `packages/teamlead/scripts/claude-lead.sh` 一行与 `flywheel-comm resolve-db-path.ts` 的 `--project` 分支(均 env 未设即原值)。若 Lead 认为生产 Lead 脚本本轮一字不能动,退回 5.2-A 并把例外写死为 `${HOME}/.flywheel/comm/flywheel-test-[1-4]/` 四条精确路径。
2. 真机演练的 2231 形状需要「像孤儿」的诱饵活过清扫器的 2 小时年龄门(`CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS = 7200`),没有任何 env 能缩短它。建议:真机只做 2287 形状(生产 tmux 诱饵窗口 + slot terminate)与舰队快照逐字比对;2231 形状的承重证明由 hermetic 测试承担,除非 QA 愿意为演练预留 ≥2h15m 停留。

## 7. 假设

- 529 房的 slot 目录约定不变:`SLOT_DIR=/tmp/flywheel-test-slot-<N>`;隔离根就是它(canonical 后 `/private/tmp/...`,比较时两边都 `realpath`)。
- 生产 Bridge / Lead / runner 的环境里永远没有 `FLYWHEEL_ISOLATION_ROOT`;白名单契约与自检只在 test-deploy 路径生效。
- teamlead vitest 在 CI(ubuntu-latest)能起真 tmux 与 lsof(ci.yml:181 已保证)。
