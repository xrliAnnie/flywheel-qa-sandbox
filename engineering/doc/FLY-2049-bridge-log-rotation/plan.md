# FLY-2049 Bridge 日志轮转真运行 — 实施计划
Issue: FLY-2049 (https://linear.app/geoforge3d/issue/FLY-2049/infra日志-bridge-日志轮转未生效部署后-bridge-日志-94106mb-持续增长无任何轮转产物-查根因并让轮转真跑起来)
日期: 2026-08-25
基于: research.md

> **For agentic workers:** 必须按 `superpowers:test-driven-development` 的 RED → GREEN → REFACTOR 执行；本 DAG implement 节点不 dispatch successor/review agent。

**Goal:** 让 production/daily 自救 Bridge 的 JS stdout/stderr 在同一 Node PID 在线时按 10 MiB / 3 代真实轮转；主文件回落、有 `.1`，轮转前后字节连续，主日志没有长期 producer FD。

**Architecture:** `run-bridge.ts` 在 dynamic import 其余 runtime 和第一条应用日志前安装同步 rotating stdio adapter 与 uncaught monitor。每次 stdout/stderr write 调用 strict short-FD append；wrapper 与 daily 用单个 `>` 在每次启动时截断 raw-startup capture，保留 module/tsx/V8/native 诊断但不跨重启累积。日志层统一 fail-open：unsafe generation quarantine 后继续 rotate，stale lock 自动回收，2× stall 只停 rotation 并持续告警，Bridge 永不因日志层退出。R4 trial 使用独立日志。无 pipe、无 sidecar、无 `NODE_OPTIONS` 继承。

**Tech stack:** TypeScript、Node.js、Vitest、Bash 3.2、现有 package/shell harness。

---

## 0. 文件职责

| 文件 | 动作 | 单一职责 |
|---|---|---|
| `packages/config/src/log-rotate.ts` | 修改 | 保留默认 fail-open API；新增 strict result/no-follow/stall detection |
| `packages/config/src/__tests__/log-rotate.test.ts` | 修改 | strict symlink、generation、lock-stall、secure append |
| `packages/config/src/rotating-stdio.ts` | 新增 | stdout/stderr adapter、env boundary、failed/closed latches |
| `packages/config/src/__tests__/rotating-stdio.test.ts` | 新增 | 阈值、byte continuity、optional callback、failure callback、restore/re-entry |
| `packages/config/src/index.ts` | 修改 | 导出 adapter API |
| `scripts/run-bridge.ts` | 修改 | 先安装 adapter/uncaught monitor；runtime 改 dynamic imports；error marker/fail-open |
| `scripts/flywheel-bridge-wrapper.sh` | 修改 | 导出 main/raw-startup/marker；两条 exec 前用 `>` 截断 raw capture；dirty copy 更新 |
| `scripts/daily-standup.sh` | 修改 | packaged/monorepo 自救分支用相同绝对 defaults + truncate-on-start raw capture；错误 copy 更新 |
| `scripts/bridge-liveness-probe.sh` | 修改 | down copy 同时指向主日志与 rotation-error marker |
| `packages/teamlead/src/bridge/alert-kind-copy.ts` | 修改 | deploy failure copy 同时指向 marker |
| `scripts/r4/r4-window.sh` | 修改 | trial 使用独立日志；stormwatch 不再按 production log 旧行号切片 |
| `scripts/fly-1586-capture-evidence.sh` | 修改 | Bridge generations oldest→active 聚合，避免轮转后漏计 |
| `scripts/__tests__/flywheel-log-rotate.test.sh` | 修改 | 构建后真实 Node producer 的小阈值正向 proof + wiring placement guard |
| `scripts/__tests__/packaged-seams.test.sh` | 修改 | 两种 Bridge 启动命令不变，并断言 fixture env/raw capture 截断、真实 `/tmp` 未改 |
| `scripts/__tests__/r4-window.test.sh` | 修改 | trial 日志隔离与 stormwatch 读取合同 |
| `engineering/doc/FLY-2049-bridge-log-rotation/*` | 修改 | R1 findings、实现/QA 证据与游标 |
| `engineering/doc/milestones/FLY-2049.md` | 最后新增 | milestone 运行合同；必须是 PR 最后 commit |

不修改 cmux watcher、infra-bot launcher、launchd plist 或 package-onboard allowlist。config package 的 `dist` 已是 packaged dependency closure；不新增 runtime byte 到 cmux stable bin。两份 side log 由 Lead 合并登记为族单 **FLY-2056**（按系统分两节、留账不派），该 ID 写进 milestone。

## 1. RED — rotating stdio 单元契约

**Files:**

- Create: `packages/config/src/__tests__/rotating-stdio.test.ts`
- Test: `pnpm --filter flywheel-config test:run -- rotating-stdio.test.ts`

- [x] **1.1 缺失 API 先红**

从 `../rotating-stdio.js` import：

```ts
import {
  installRotatingStdio,
  installRotatingStdioFromEnv,
  writeBoundedRotationErrorMarker,
} from "../rotating-stdio.js";
```

运行定向 test，预期因为 module 不存在而 FAIL；保存 RED 输出。

- [x] **1.2 写 80 B threshold 正向 case**

使用注入 fake stream（可替换 `write` 的最小对象）与 temp log：

1. install 后依次写 `segment-01`、`segment-02`、`segment-03`；
2. 在 `.1` 出现后继续写 `post-rotation-sentinel`；
3. 断言 fake original write 在成功路径零调用；
4. 按 `.3/.2/.1/active` 拼接与所有输入 Buffer 完全相等；
5. active 含 sentinel，restore 后新写只走 original stream。

测试使用足够小的多个 chunk，明确钉住“写前 active 已达阈值才 rotate，chunk 不拆分”的现有语义；不错误断言每代严格 `<= maxBytes`。

- [x] **1.3 写边界/失败 case**

覆盖：

- env 没有 log path → no-op；
- max/keep 是 `0`、负数、小数、超 safe integer → 使用 default，并在 adapter 安装后写一次降级诊断；
- string encoding 转成正确 bytes；Uint8Array 原样写；
- callback 在成功 write 后恰好一次、异步触发；
- **没有 callback 的合法 bare write 不得排 microtask 或抛 TypeError**；
- log path 不可写时，`onWriteError` 只触发一次，failed latch 后所有 write 走 original；
- fixed marker 重复覆写不增长、内容截断在上限内、mode 0600、stale marker 可清理；
- restore 幂等；保存的旧 patched closure 在 restore 后也只走 original（closed latch）。

- [x] **1.4 strict rotation surface 先红**

扩展 `log-rotate.test.ts`：

- active 是 symlink 时 strict append 拒绝，target bytes 不变；
- rotation due 且 `.1/.2/.3` 任一是 symlink/非 regular 时改名 `.corrupt.<pid>.<ts>` 后继续；
- stale regular-file lock 与 stale directory lock 都按 5 分钟 mtime 回收；
- active 处于 `maxBytes..2×maxBytes` 且 fresh lock contention 时暂时 append；
- active 已 `>=2×maxBytes`、重新检查仍无法 rotate 时返回 `rotationStalled: true`，但 append 仍成功；
- secure append 使用 no-follow FD，active 在 inspect/open 间被换成 symlink也不写 target。

## 2. GREEN — 实现 adapter，复用唯一 rotation 算法

**Files:**

- Create: `packages/config/src/rotating-stdio.ts`
- Modify: `packages/config/src/log-rotate.ts`
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/__tests__/{rotating-stdio,log-rotate}.test.ts`

- [x] **2.1 定义可注入 stream boundary**

```ts
export interface RotatingStdioOptions {
  logPath: string;
  maxBytes?: number;
  keep?: number;
  stdout?: RotatingWritable;
  stderr?: RotatingWritable;
  onWriteError?: (error: Error) => void;
}
```

默认 streams 是 `process.stdout` / `process.stderr`；测试传 fake。保存 `stdout.write.bind(stdout)` 与 `stderr.write.bind(stderr)`，禁止之后通过 patched property 找 original。

- [x] **2.2 规范化 Node write overload**

helper 接受 `string | Uint8Array`、可选 encoding/callback：

- string 用合法 `BufferEncoding` 生成 Buffer；
- Uint8Array 不修改；
- `encoding` 位置若是 function，则它就是 callback；
- 其它非法输入交给 original write，保持 Node 自己的错误语义。

- [x] **2.3 strict short-FD append**

保留现有 callers 的默认 fail-open 行为；为 Bridge 增加返回结果的 strict mode：

```ts
appendRotatedLogSync(logPath, bytes, {
  maxBytes,
  keep,
  strict: true,
});
```

strict mode 每次 lstat active；只接受 regular non-symlink，并用 `O_NOFOLLOW | O_APPEND | O_CREAT | O_WRONLY` 打开。rotation due 时把 unsafe generations recoverable quarantine。短暂 lock contention可继续；若第二次检查 active 仍 `>=2×maxBytes` 且未 rotate，则当前 append 仍成功并返回 `rotationStalled: true`。adapter 随后只禁用 rotation，不禁用主日志 short-FD append。返回 `{ sizeBefore, rotationDue, rotated, rotationStalled }` 供测试/诊断，旧 callers 可忽略。

- [x] **2.4 write success/failure contract**

成功时返回 `true`；仅当 `typeof callback === "function"` 时执行 `queueMicrotask(() => callback())`。`rotationStalled` 分支只置 rotation-disabled latch、恰好一次调用 `onWriteError`，当前与后续 writes 仍进入 active；其它 catch 才置 failed latch并降级到绑定的 original stream，不从 patched property 自调用。

- [x] **2.5 env boundary 与 closed latch**

读取：

- `FLYWHEEL_BRIDGE_LOG_PATH`
- `FLYWHEEL_BRIDGE_LOG_MAX_BYTES`（默认 10 MiB）
- `FLYWHEEL_BRIDGE_LOG_RETENTION`（默认 3）

未给 path 时 no-op。非法 max/keep 改用 default；adapter 安装完成后通过 patched stderr 写一次 bounded warning。restore 只恢复一次，并让任何旧 closure 后续都走 original。

- [x] **2.6 bounded marker helper**

`writeBoundedRotationErrorMarker(path, error)` 与 `clearRotationErrorMarker(path)` 放在同一模块并由 unit test 直接覆盖。生产 `run-bridge.ts` 只写、不在 boot 时清 marker。marker 只接受 absolute path；parent 必须存在且非 symlink；使用同目录 `wx` temp、0600、截断后的 JSON（上限 4 KiB）再 rename。重复 failure 覆写同一 marker，绝不 append。

- [x] **2.7 导出并跑 GREEN**

在 `packages/config/src/index.ts` export types/functions。运行：

```bash
pnpm --filter flywheel-config test:run -- rotating-stdio.test.ts
pnpm --filter flywheel-config test:run -- log-rotate.test.ts
pnpm --filter flywheel-config build
```

Expected: PASS。

## 3. RED — 真实 Node producer 与 wiring placement

**Files:**

- Modify: `scripts/__tests__/flywheel-log-rotate.test.sh`
- Test: `bash scripts/__tests__/flywheel-log-rotate.test.sh`

- [x] **3.1 新增 dist-level live producer**

harness 使用构建后的 `packages/config/dist/index.js`，后台启动真实 Node：

```bash
FLYWHEEL_BRIDGE_LOG_PATH="$LIVE_LOG" \
FLYWHEEL_BRIDGE_LOG_MAX_BYTES=80 \
FLYWHEEL_BRIDGE_LOG_RETENTION=3 \
node --input-type=module -e '/* import dist, install, write paced chunks */' \
  >"$RAW_CAPTURE" 2>&1 &
producer_pid=$!
```

Node 安装 adapter 后分段写入预先定义的 payload；每段之间等待，最后 sentinel 后再保持在线 500ms。shell 轮询 `.1`，在出现时必须满足：

- `kill -0 "$producer_pid"`；
- `lsof -t -- "$LIVE_LOG" "$LIVE_LOG.1"` 不含 producer PID；
- active bytes 小于 `.1` 且包含 post-rotation sentinel。

producer EOF 后按 oldest→active 拼接并 `cmp` 输入，normal-path raw capture 必须为空。第二个 Node harness 安装与 `run-bridge.ts` 同形的 `uncaughtExceptionMonitor` 后故意 throw：进程必须非零，bounded 主日志必须含 stack sentinel，raw capture 同时保留 Node 默认 stack。第三个 bad-import harness 在 adapter 安装前失败，错误必须只落 truncate-on-start raw capture。

- [x] **3.2 新增 placement guard，而不是只 grep 名字**

用行号/awk 机械断言：

- `scripts/run-bridge.ts` 的 `installRotatingStdioFromEnv` 调用在第一条 `console.*` 前；
- 从文件头到 `main()` 的 module-scope `from "../packages/..."` specifier 只能是 config logging import；其它 package 依赖只能是 `import type` 或 `await import(...)`，防止 import-time output 先于 adapter；
- wrapper 的 `exec > "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" 2>&1`（单 `>`）在 packaged 与 monorepo 两条最终 exec 前，且其后没有 `>> /tmp/flywheel-bridge.log`；
- daily 的 node 与 npx 两分支都带 main/raw-startup/marker env，且 raw fd 都用单 `>` 进入同一 startup path；
- R4 不再包含 `R4_BRIDGE_LOG_START_LINES` 或 production bridge log 重定向。

- [x] **3.3 运行 RED**

在 wiring 尚未改前运行，预期 positive producer（入口未导出时可单独安装 adapter）通过、placement guard 因 run-bridge/wrapper/daily/R4 缺 wiring 而 FAIL。失败必须精确指向缺失入口，不得把旧 FLY-1887 cases 弄红。

## 4. GREEN — Bridge 入口安装与 canonical wrapper

**Files:**

- Modify: `scripts/run-bridge.ts`
- Modify: `scripts/flywheel-bridge-wrapper.sh`
- Modify: `scripts/bridge-liveness-probe.sh`
- Modify: `packages/teamlead/src/bridge/alert-kind-copy.ts`
- Modify: `scripts/__tests__/packaged-seams.test.sh`

- [x] **4.1 run-bridge 在第一条应用 log 前安装**

只静态 import `flywheel-config` 的 logging API；edge-worker/teamlead/config runtime 的其余 imports 改成 `main()` 内 dynamic imports。module scope 先：

```ts
const markerPath = process.env.FLYWHEEL_BRIDGE_LOG_ERROR_MARKER;
let rotatingStdio;
try {
  rotatingStdio = installRotatingStdioFromEnv({
    onWriteError: preserveRotationError,
  });
} catch (error) {
  preserveRotationError(error);
  process.stderr.write("[run-bridge] rotating stdio disabled ...");
}
if (rotatingStdio) {
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    process.stderr.write(renderUncaught(error, origin));
  });
}
```

marker 用同目录临时文件 + `wx` + 0600 + rename 覆写，message/stack 截断，总内容有固定 byte cap；boot 不清 stale marker，直到 operator 清理。marker path 缺失或 marker write 失败都只降级 raw stderr；rotation setup/write error 不调度 exit。monitor 只在 rotating stdio 实际启用时安装，手工终端模式不重复默认 stack。调用必须早于 runtime dynamic imports 和第一条 `console.*`。所有其它 package value imports 都必须是 `await import()`；仅类型依赖必须写 `import type`，防止 `transpileModule` 留下意外 runtime import。不通过 `NODE_OPTIONS`，子进程不继承 patch。

- [x] **4.2 wrapper 导出生产配置并释放主日志 FD**

在 port/PID/restart-storm/dirty-marker 检查全部通过、最终 `cd` 后设置：

```bash
export FLYWHEEL_BRIDGE_LOG_PATH="${FLYWHEEL_BRIDGE_LOG_PATH:-/tmp/flywheel-bridge.log}"
BRIDGE_RUNTIME_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
export FLYWHEEL_BRIDGE_RAW_STARTUP_LOG="${FLYWHEEL_BRIDGE_RAW_STARTUP_LOG:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-startup.log}"
export FLYWHEEL_BRIDGE_LOG_ERROR_MARKER="${FLYWHEEL_BRIDGE_LOG_ERROR_MARKER:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-log-rotation-error.json}"
BRIDGE_RAW_STARTUP_REDIRECT="$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" # unsafe 时 /dev/null
exec > "$BRIDGE_RAW_STARTUP_REDIRECT" 2>&1
```

marker 与 raw-startup parents 在原 launchd stderr 尚可用时创建/验证；安全时 raw redirection 必须是单个 `>`（每次启动截断）。unsafe/missing/unwritable raw capture 不碰目标，改用 `/dev/null` 并继续启动。既有 `exec node dist/run-bridge.js` 与 `exec npx tsx scripts/run-bridge.ts` 字面保持不变，PID/signal/KeepAlive 合同不动。

- [x] **4.3 operator copy 全部指向 bounded evidence**

同步更新四个位置：

- wrapper dirty-exit body；
- `bridge-liveness-probe.sh` down escalation；
- daily-standup 的 process-exit/startup-timeout 两条 error；
- `alert-kind-copy.ts` 的 `deploy_failed` copy。

统一文案：先看 `/tmp/flywheel-bridge.log`；canonical 启动/module/V8/native failure 看 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/bridge-startup.log`（daily fallback 看 `bridge-startup-daily.log`）；rotation failure 再看同 state dir 的 `bridge-log-rotation-error.json` 与 `lsof -ti:9876`。

- [x] **4.4 packaged seam 双分支**

扩展 fixture stub 记录：

- `run_bridge_wrapper` 的 `env -i` 显式传 fixture main/raw-startup/marker paths，绝不落真实 `/tmp`/HOME；
- node/npx 看到三个 fixture env；wrapper 原始 stdout 的“Starting Bridge”之前仍可见，exec 目标的 raw sentinel 出现在 fixture startup capture；
- 连续运行 wrapper 两次，第二次 startup capture 只有第二次 sentinel，证明使用单 `>` 截断而不是 append；
- S1 仍只有 node，S2 仍只有 npx；不得放松旧 `! grep '^node '` sentinel。

Run:

```bash
bash scripts/__tests__/packaged-seams.test.sh
bash scripts/__tests__/bridge-wrapper-preflight.test.sh
bash scripts/__tests__/bridge-wrapper-fail-loud.test.sh
```

## 5. GREEN — daily 与 R4 绕行入口

**Files:**

- Modify: `scripts/daily-standup.sh`
- Modify: `scripts/r4/r4-window.sh`
- Modify: `scripts/__tests__/packaged-seams.test.sh`
- Modify: `scripts/__tests__/r4-window.test.sh`

- [x] **5.1 daily packaged/monorepo 分支对称接入**

定义三个 path。state root 用 set-u 安全的 host override fallback；daily startup 必须与 wrapper capture 分离：

```bash
BRIDGE_LOG_PATH="${FLYWHEEL_BRIDGE_LOG_PATH:-/tmp/flywheel-bridge.log}"
BRIDGE_RUNTIME_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
BRIDGE_RAW_STARTUP_LOG="${FLYWHEEL_BRIDGE_RAW_STARTUP_LOG:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-startup-daily.log}"
BRIDGE_LOG_ERROR_MARKER="${FLYWHEEL_BRIDGE_LOG_ERROR_MARKER:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-log-rotation-error.json}"
```

两条 nohup command 都显式传：

```bash
FLYWHEEL_BRIDGE_LOG_PATH="$BRIDGE_LOG_PATH" \
FLYWHEEL_BRIDGE_RAW_STARTUP_LOG="$BRIDGE_RAW_STARTUP_LOG" \
FLYWHEEL_BRIDGE_LOG_ERROR_MARKER="$BRIDGE_LOG_ERROR_MARKER" \
nohup node|npx ... > "$BRIDGE_RAW_STARTUP_LOG" 2>&1 &
```

现有 health/PID 行为不变。packaged seam 的 `env -i` 必须显式传 fixture log/marker path，stub 记录并断言两个 env；测试前后 snapshot 真实 `/tmp/flywheel-bridge.log*`，证明 fixture 不触碰它。

- [x] **5.2 R4 trial 完全隔离 production log**

新增：

```bash
R4_TRIAL_LOG="${R4_TRIAL_LOG:-$R4_ROOT/bridge-trial.log}"
R4_TRIAL_RAW_STARTUP_LOG="${R4_TRIAL_RAW_STARTUP_LOG:-$R4_ROOT/bridge-trial-startup.log}"
R4_TRIAL_ERROR_MARKER="${R4_TRIAL_ERROR_MARKER:-$R4_ROOT/bridge-trial-rotation-error.json}"
```

`r4_start_trial` 在 Bridge 已 quiesced 后清理精确的 trial active/.1/.2/.3/startup/marker，导出 rotating env，nohup 用单 `>` 截断 trial startup capture。`r4_stormwatch` 按 `.3 → .2 → .1 → active` 读取有界 trial surface 搜索 `Fatal`；删除旧的 production line-offset 变量/逻辑。

- [x] **5.3 R4 tests**

新增 source-level case 调用真实 `r4_start_trial`（stub npx）并断言：

- env 指向 fixture trial log；
- raw-startup 与 error marker 都指向 fixture；两次 start 后 capture 只保留第二次 raw sentinel；
- `/tmp/flywheel-bridge.log` 未被创建/修改；
- `r4_stormwatch` 能从 trial `.1` 或 active 发现 `Fatal` 并失败。

Run:

```bash
bash scripts/__tests__/r4-window.test.sh
bash scripts/__tests__/packaged-seams.test.sh
```

## 6. REFACTOR 与正向验收

- [x] **6.1 收敛重复 env 解析**

只在 TypeScript adapter 内解析 max/keep；shell 只传字符串，不复制 rotation 算法。变量命名在 wrapper/daily/R4 一致。marker/raw-startup parents 在继承的主日志 stderr 关闭前创建/验证；raw-startup 必须用单 `>` 重建，禁止 `>>`。

- [x] **6.2 定向测试全绿**

```bash
pnpm --filter flywheel-config test:run
bash scripts/__tests__/flywheel-log-rotate.test.sh
bash scripts/__tests__/packaged-seams.test.sh
bash scripts/__tests__/r4-window.test.sh
bash scripts/__tests__/fly1663-bridge-launchd.test.sh
bash scripts/__tests__/package-onboard.test.sh
pnpm --filter flywheel-teamlead test:run -- alert-kind-copy
```

- [x] **6.3 保存故意灌阈值的 QA 证据**

记录 producer PID、`.1`/active 的 inode 与 byte size、`cmp` 结果、lsof 零 holder、sentinel 所在 generation、uncaught monitor stack、bad module 在 raw-startup 的 stderr、strict failure marker size。不得以“配置存在”代替运行证据。

- [x] **6.4 sweep 现有 Bridge log readers**

更新 `scripts/fly-1586-capture-evidence.sh`：对 `.3/.2/.1/active` 中实际存在的 regular files按 oldest→active 聚合 bytes/count/last-40，不使用宽泛 `bridge.log*`（避免把 lock/marker 算进去）。结构 guard 钉住 generation list；R4 reader 已由 Task 5 覆盖。

- [x] **6.5 把 side-log deferral 变成有 owner 的 follow-up**

通过 `flywheel-comm ask --lead flywheel-eng-lead --exec-id ...` 请求分别建立：

1. cmux watcher Bash/launchd log bounding（含消除脚本内双 `>>`）；
2. Codex infra-bot TUI audit/UI stream 分离与 bounded retention。

Lead 已回复：合并为族单 **FLY-2056**，分 cmux watcher 与 Codex infra-bot 两节，按 founder freeze 留账不派。research 已记录，milestone 必须在范围边界与 follow-up 两处引用 FLY-2056。

- [x] **6.6 更新 docs**

research/plan 补最终文件名、测试输出与 reviewer changes；progress cursor 更新到 implement/qa。milestone 明确：旧 106 MiB 首次启动先保留为 `.1`，按 2026-08-25 约 20.9 MB/day 的观测速率，约 1.5 天/三次后由 retention 淘汰，部署瞬时峰值约 136 MiB，不需要手工删除。

同一 milestone 写 `rotation_stalled` runbook：Bridge 始终在线、rotation-disabled、active 继续 short-FD append；先按 marker 检查 fresh lock/权限/I/O，确认安全后等正常部署窗口重启 adapter，再验证 `/health`、`.1` 与 active。unsafe generation 已自动 quarantine，stale ordinary-file/directory lock 5 分钟后自动回收。严禁在线移动 active。PR body 单独包含 Summary、Test plan、Linear issue、正向 proof与 R1 四条 MEDIUM disposition；不把 research.md 直接当 PR body。

## 7. 全仓 gate、代码审查与 PR

- [ ] **7.1 全仓必跑 gate**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/flywheel-log-rotate.test.sh
bash scripts/__tests__/packaged-seams.test.sh
bash scripts/__tests__/r4-window.test.sh
bash scripts/__tests__/bridge-wrapper-fail-loud.test.sh
```

任何失败先按 systematic debugging 找根因；不把无关 baseline failure 偷标为 PASS。

执行结果：lint/build 通过，四个本单 shell gate 全绿，config 671/671；`pnpm test:packages:run` 如实为 exit 1。根因分离见 research §6.4：real Terminal 需要当前 runner 不具备的 GUI/XPC；全仓并发触发未改慢测试与 Vitest worker timeout；npm pack 的宿主 cache EPERM 用独立 cache 复核通过。缩小复跑证明本单改动面与绝大多数超时文件通过，`createLeadRuntime-preflight.test.ts` 的既有 2/4 失败仍保留为非本单 baseline，不把 7.1 勾成 PASS。

- [ ] **7.2 Codex code review**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code \
  --lead flywheel-eng-lead \
  --exec-id cfe41697-f0f3-48a9-bea2-c5d258528a03 \
  --no-block "Code review requested for FLY-2049"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <id>
node "$FLYWHEEL_COMM_CLI" check <id>
```

CHANGES_REQUESTED 必须修完并开新 gate；APPROVED advisories 用 `ask --report` 回 Lead。

- [ ] **7.3 milestone 必须是 PR 最后 commit**

先读 `engineering/doc/milestones/README.md`。所有 code/docs 已提交且测试全绿后，新增 `engineering/doc/milestones/FLY-2049.md`，写入 side-log follow-up IDs 与旧 106 MiB transient retention 说明，不改 `CLAUDE.md`；这个新文件与必要 doc archive 是最后 commit。

- [ ] **7.4 push、开 PR、完成 bounded node**

PR base `main`，body 有 Linear 链接与完整测试证据。不请求 ship/merge/restart。最后：

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

## 8. 设计审查 R4 通过条件

- [ ] cmux/infra-bot 从实现范围删除，已由 FLY-2056 两节承接并要求 milestone 两处引用；
- [ ] daily 与 R4 两条绕行入口有真实行为测试，不只 grep；
- [ ] 无 pipe/sidecar，故无 async crash-tail、startup liveness、orphan owner 问题；
- [ ] normal full-rate output 不走 raw fd；startup capture 每次启动用单 `>` 重建，module/tsx/V8/native 诊断可查；
- [ ] rotation failure 只覆写 bounded marker，Bridge fail-open；probe 在线首报/小时重醒，四个 operator pointers 已列入文件表；
- [ ] bare write 没有 callback 时不触发 TypeError；invalid numeric env 降级 default；
- [ ] active/generation symlink 与 2× threshold stall 有 RED/GREEN；
- [ ] packaged seam 原 node/npx sentinel 不放松；
- [ ] run-bridge 安装 placement 在第一条应用日志与所有非-config runtime imports 前；module-scope guard 覆盖 `transpileModule` 风险；
- [ ] chunk 不拆分与最多超阈值一个 write 的语义写清；
- [ ] restore/re-entry 使用 closed latch；
- [ ] FLY-1586 与 R4 reader 都按 generation-aware surface 工作；
- [ ] milestone 有 Bridge-online、rotation-disabled 的人工恢复 runbook；
- [ ] 正向 proof 断言 PID 连续、产物、回落、byte continuity、后续 sentinel、uncaught stack、bad-module startup stderr、零长期主日志 FD。

## 9. Implement attempt 2 — operator rework

- [x] RED：stale ordinary-file lock 不回收；symlink `.1` 抛 `log_generation_unsafe`；2× fresh-lock stall 抛错并把后续 bytes 导向 raw FD；`run-bridge` next-tick 退出；probe 无在线 rotation marker lane。
- [x] GREEN：ordinary-file/directory stale lock 都做 inode/mtime guarded reclaim；unsafe generation 改名 `.corrupt.<pid>.<ts>` 后继续 rotate，symlink target bytes 不变。
- [x] GREEN：`rotationStalled` result 让 adapter 只关闭 rotation attempt，当前与后续 stdout/stderr 仍写 active；`run-bridge` 的 setup/write callback 不再 exit，也不在 boot 清 marker。
- [x] GREEN：wrapper/daily raw capture 失败改为不碰 unsafe target、经 `/dev/null` 继续启动；packaged/node 与 monorepo/tsx seam 均保持原命令。
- [x] GREEN：外部 liveness probe 增加独立 rotation marker episode，首次立即提醒、默认 60 分钟重醒、marker 人工清除后 all-clear。
- [x] 定向证据：config 673/673、probe 31/31、packaged seams 17/17；重新构建 config dist 后 live producer 14/14，PID 38267 在线，`.1` 528 bytes、active 367 bytes、byte cmp 一致、零长期 FD。
- [ ] 更新 milestone 与 PR body 的四条 MEDIUM disposition，完成全仓 gate、精确 head code review 与 Lead report-back。
