# FLY-1608 529房既有缺陷×2:Lead 秒死 + boot drain 吞生产 marker — 调研

Issue: FLY-1608 (https://linear.app/geoforge3d/issue/FLY-1608/529房既有缺陷2-test-deploy-从仓库根起-lead-秒死729-起全坏-complete-marker-boot-drain)
日期: 2026-08-02
基于: exploration.md

本文是对本仓实际代码的逐行审计,回答 exploration 留下的三个未解问题,并给出全部修改位点的事实坐标。所有行号基于分支 `flywheel-FLY-1608`(base = main `fdb74221`)。

## 1. 缺陷 ① 事实链

### 1.1 守卫本体

`packages/teamlead/scripts/claude-lead.sh:70-80`:

```bash
set -euo pipefail

# FLY-1502: after the machine cutover is armed, no legacy Lead supervisor may
# enter its restart loop. ...
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
  node --input-type=module -e \
    'import("flywheel-v2-kernel").then(({requireLegacyWriterAllowedFromEnvironment}) => requireLegacyWriterAllowedFromEnvironment(process.env))'
fi
```

- `node --input-type=module -e` 的 bare specifier(`"flywheel-v2-kernel"`)解析基准 = **node 进程 cwd**,从 cwd 向上逐层找 `node_modules/flywheel-v2-kernel`。
- import 失败 → unhandled rejection → node 非零退出 → `set -e` 直接杀掉整个 supervisor。**没有任何解释性输出**,只有一个裸 `ERR_MODULE_NOT_FOUND` 栈 —— 和"authority 拒绝启动"(`requireLegacyWriterAllowedFromEnvironment` throw)在退出形态上无法区分。
- 守卫位于第 77 行,在 `SCRIPT_DIR` 计算(第 209 行)**之前** —— 修复需要在守卫处就地取 `$(dirname "$0")`。

### 1.2 kernel 的安装位置(为什么仓库根解析不到)

- 包名 `flywheel-v2-kernel`,目录 `packages/v2-kernel`(`packages/v2-kernel/package.json:2`)。
- 唯一声明依赖它的 workspace 包:`packages/teamlead/package.json:68` — `"flywheel-v2-kernel": "workspace:*"`。
- 实测主仓(`~/Dev/flywheel`):
  - `node_modules/flywheel-v2-kernel` → **不存在**(pnpm 不把 workspace 依赖 hoist 到根,根 package.json 不依赖它)。
  - `packages/teamlead/node_modules/flywheel-v2-kernel` → 存在(symlink,含 dist)。
- ⇒ cwd=仓库根 → 解析必败;cwd=`packages/teamlead`(或其任意子目录)→ 解析成功。

### 1.3 生产为什么没事

`~/.flywheel/bin/flywheel-lead-wrapper.sh`(生产 wrapper,两个 backend 分支各一处):

- `:222`(codex-app-server 分支)与 `:231`(claude-code 分支)都是 `cd "${FLYWHEEL_DIR}/packages/teamlead"` 后 `exec "$LEAD_SCRIPT"`。
- 生产 Lead 的 supervisor cwd 恒为 `packages/teamlead` → 守卫恒可解析。已验:生产 Lead 8/2 04:44 起,活着。

### 1.4 529 房怎么踩的

`scripts/test-deploy.sh` 两个 Lead 启动位点,均**不改 cwd**、直接 `bash` 绝对路径脚本,子进程继承调用者 cwd:

- `:1158`(主 test Lead):`env ... bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" ... &`
- `:1450`(extra-lead / campaign 模式):同构。

test-deploy 本身是 cwd 无关的(`:14-15` 用 `$(dirname "$0")` 推导 `SCRIPT_DIR/REPO_ROOT`)—— 唯独 claude-lead.sh 子进程这一环继承了调用者 cwd。529 房的操作习惯是在仓库根跑 `bash scripts/test-deploy.sh ...` ⇒ 7/29(FLY-1502 落地)起必死。FLY-1606 runner 的绕法 = 手动 `cd packages/teamlead` 再起,精确复刻生产 wrapper,证明了机制。

### 1.5 波及面

- 守卫只存在于 `claude-lead.sh`。`codex-lead.sh` **没有** FLY-1502 守卫(grep 全仓 `flywheel-v2-kernel` 的 shell 引用仅 claude-lead.sh:79 一处)→ 本单不碰 codex-lead.sh。
- claude-lead.sh 其余部分对 cwd 无硬依赖(所有内部引用走 `SCRIPT_DIR`/绝对路径;FLY-1502 之前从仓库根跑 529 一直是好的,即为实证)。

## 2. 缺陷 ② 事实链

### 2.1 写入侧(marker 从哪来)

`packages/flywheel-comm/src/commands/complete.ts:700-707`(`writeMarker()`):

```ts
const home = process.env.HOME ?? homedir();
const dir = join(home, ".flywheel", "state", "complete-failed");
```

- Runner 的 `flywheel-comm complete` 打不通 Bridge 时写 fail-close marker 到这里。**HOME 硬派生,无 env 覆盖**。
- 同文件 `:221` 已有同构先例:`const gateMarkerDir = process.env.FLYWHEEL_GATE_MARKER_DIR?.trim();`(FLY-123,gate marker 的 env 缝)—— complete marker 没有对应物。
- flywheel-comm 内 `complete-failed` 的写入仅此一处(`src/commands/complete.ts`;`gate-marker.ts` 是另一套 gate marker 体系,已有 env)。

### 2.2 读取侧(谁扫这个目录)—— 全部经两个 default 函数收口 ✅

`packages/teamlead/src/bridge/complete-marker-reconciler.ts:72-89`:

```ts
export function defaultMarkerDir(): string {
  return join(process.env.HOME ?? homedir(), ".flywheel", "state", "complete-failed");
}
export function defaultQuarantineDir(): string {
  return join(process.env.HOME ?? homedir(), ".flywheel", "state", "complete-failed-quarantine");
}
```

生产调用点逐一核对(exploration 未解问题 1 的答案:**是,全部收口**):

| 调用点 | 文件:行 | markerDir 来源 |
|---|---|---|
| boot drain(本次事故现场) | `plugin.ts:8841` `reconcileCompleteFailedMarkers({...})` — **不传 markerDir/quarantineDir** | `reconcileCompleteFailedMarkers` 内 `:1010` `deps.markerDir ?? defaultMarkerDir()` |
| 单 marker 重放(heartbeat/monitor-loss 三处) | `HeartbeatService.ts:938,1060,1129` → `tryReconcileComplete(execId, deps)` | `:402` `deps.markerDir ?? defaultMarkerDir()` |
| done-running sweep 的 pending-marker 探测 | `done-running-reconciler.ts:94,182` | 参数默认值 `defaultMarkerDir()` |

⇒ 读取侧**单点修复可行**:让 `defaultMarkerDir()` 认 env,所有生产路径自动跟随。quarantine 默认值 = `~/.flywheel/state/complete-failed-quarantine` **恰好等于** `defaultMarkerDir() + "-quarantine"`,可改写为派生式而保持字节兼容。

### 2.3 事故复盘(实测行为)

slot Bridge 启动 → `plugin.ts:8841` boot drain 用默认(生产)目录 → 扫到生产的 FLY-1606 marker → 用 **slot 的 StateStore**(`TEAMLEAD_DB_PATH=${SLOT_DIR}/teamlead.db`)查 execution → 测试库 FSM 拒 → marker 被 `git mv` 进**生产** quarantine 目录(`defaultQuarantineDir()` 同样是生产路径)→ 日志 `scanned=1 reconciled=0 quarantined=1`。生产失去了它唯一的待重放件(恢复归 FLY-1607)。

反向污染同样真实:529 房的 Bridge 崩溃测试(`reference_529_room_bridge_crash_test_recipe`)正是 marker 被写出的场景 —— slot Runner 的 fail-close marker 会落进**生产** complete-failed 目录,下次生产 Bridge 重启就会拿生产 DB 重放测试 marker。所以修复必须覆盖**写入侧**,只挡读取侧(如"slot 跳过 boot drain")不成立。

### 2.4 Runner env 怎么构造(exploration 未解问题 2 的答案:不会自动继承,必须显式透传)

- Runner tmux 窗口的 env 由 adapter 显式 `-e` 注入:`packages/claude-runner/src/TmuxAdapter.ts:444-470`(`FLYWHEEL_BRIDGE_URL` / `FLYWHEEL_INGEST_TOKEN` / `FLYWHEEL_STATE_DB_PATH` 等逐个 push)。tmux 窗口继承的是 tmux server 的 env,不是 Bridge 进程的 —— FLY-191 Phase 2 的 QA 教训(`FLYWHEEL_STATE_DB_PATH` 必须显式透传否则 Runner 读错库)与此同构。
- Codex 侧先例:`CodexTmuxAdapter.ts:1413` 注入 `FLYWHEEL_GATE_MARKER_DIR`;`codex-home.ts:134` 的 passthrough 白名单也含它。
- ⇒ `FLYWHEEL_COMPLETE_MARKER_DIR` 的透传照抄这两条既有轨道:TmuxAdapter 基类 env 块(claude/antigravity/kimi 子类共用 `createSession` 的 envArgs 构造)+ Codex 侧 env/passthrough。

### 2.5 test-deploy 的注入位(exploration 未解问题 3 的答案:有单点)

`scripts/test-deploy.sh:608-741`:`LEAD_EXTRA_ENV=()` / `BRIDGE_EXTRA_ENV=()` 数组在此初始化并集中追加(如 `:730` `LEAD_EXTRA_ENV+=("FLYWHEEL_PROJECTS_FILE=...")`),Bridge 的两个启动分支(reply-by-issue ON `:1512-1533` / OFF `:1545-1561`)都展开 `${BRIDGE_EXTRA_ENV[@]}`,Lead 两个启动位点都展开各自 EXTRA_ENV。**在数组初始化区各追加一行即可覆盖所有分支,零双写漂移**。

slot 隔离 env 的既有同类(证明这是房间的标准模式):`TEAMLEAD_DB_PATH`、`FLYWHEEL_BIN_DIR/HOOKS_DIR`(FLY-1389 P1-a)、`DISCORD_STATE_DIR`、`FLYWHEEL_PROJECTS_FILE`、FLY-529 的 `FLYWHEEL_ALERT_QUEUE_DIR/DEADLETTER_DIR/CLAIMS_DB`。

## 3. 命名与先例对齐

- 选名 `FLYWHEEL_COMPLETE_MARKER_DIR`:与同文件的 `FLYWHEEL_GATE_MARKER_DIR` 逐字同构(`FLYWHEEL_<marker 类型>_MARKER_DIR`)。
- 全仓 grep 确认:`FLYWHEEL_COMPLETE*` / `*COMPLETE_MARKER_DIR*` 目前零命中,无撞名。
- quarantine 不另设 env:恒派生 `<markerDir>-quarantine`,单旋钮全隔离,消灭"只设了 marker dir、quarantine 还漏生产"的半隔离脚枪。

## 4. 风险与既有测试面

- `complete-marker-reconciler` 已有 unit + integration 测试(`packages/teamlead/src/__tests__/complete-marker-reconciler{,.integration}.test.ts`),均通过 `deps.markerDir` 注入临时目录 —— default 函数改动不影响它们;需**新增** env-override + unset 字节兼容 sentinel 用例。
- `done-running-reconciler.test.ts` 同上(有 markerDir 注入缝)。
- adapter 侧照抄 `FLYWHEEL_GATE_MARKER_DIR` 的既有测试形态(`CodexTmuxAdapter.test.ts:689`、`codex-home.test.ts:883-890`、`ClaudeCodeAdapter.test.ts:244-271`)。
- shell 侧:`scripts/__tests__/` 是既有 bash harness 位置,新增守卫 cwd 回归测试落这里。
- 守卫修复的 fail-closed 语义保留:任何守卫失败仍 `exit 1`,只是 stderr 多出分流指引(module 装不上 → 指向 pnpm install/build;authority 拒绝 → 指明 v2 cutover fail-closed,属预期)。
