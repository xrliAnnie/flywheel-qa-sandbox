# FLY-1681 terminal-mcp 剥离 TMUX env — 实施计划

Issue: FLY-1681 (https://linear.app/geoforge3d/issue/FLY-1681/flywheel-terminal-mcp-从-v2-lead-座位探测-runner-全假阴性-tmux-客户端命中私有-server)
日期: 2026-08-12
基于: research.md

## 0. 一句话

terminal-mcp 的全部 tmux 子进程调用收口到一个 `execTmux()`,child env 剥掉 `TMUX` + `TMUX_PANE`(保留 `TMUX_TMPDIR`),使工具无论坐在哪个 tmux server 里都查**默认 server**——与已验证的 `TMUX= tmux ...` workaround 字节等价;只减不加,零配置零新机制。

## 1. 改动清单(全部在 `packages/terminal-mcp`)

### 1.1 新文件 `src/tmux-exec.ts`

```ts
// FLY-1681: terminal-mcp's contract is the DEFAULT tmux server — CommDB
// sessions.tmux_window is a socket-less `session:window` target, so it can
// only ever describe the default namespace. A v2 Lead seat injects
// TMUX=<private fw-*.sock> into our env; inheriting it redirects every bare
// tmux client call to the private server → fleet-wide false-negative
// (2026-08-10 incident). Strip TMUX (+ the equally seat-scoped TMUX_PANE)
// at the single exec boundary. TMUX_TMPDIR is deliberately preserved: it is
// the legitimate "where is the default server" steering knob.
export function sanitizeTmuxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export interface ExecTmuxOptions {
  timeout: number;
  /** test seams — production call sites pass neither */
  env?: NodeJS.ProcessEnv;
  execFileFn?: typeof execFileAsync;
}

export async function execTmux(
  args: string[],
  opts: ExecTmuxOptions,
): Promise<{ stdout: string; stderr: string }> {
  const run = opts.execFileFn ?? execFileAsync;
  return run("tmux", args, {
    encoding: "utf-8",
    timeout: opts.timeout,
    env: sanitizeTmuxEnv(opts.env ?? process.env),
  });
}
```

要点:
- `delete` 键(等价 `env -u TMUX`),不是置空串——无歧义。
- `env`/`execFileFn` 仅为测试注入 seam,生产 4 个位点一律不传。
- 返回类型与现用 `execFileAsync` 一致,调用侧改动最小。

### 1.2 `src/index.ts` — 4 个位点换用 execTmux(行为除 env 外零变化)

| 现状 | 改为 |
|---|---|
| `tmuxCapture`: `execFileAsync("tmux", ["capture-pane", ...], { encoding, timeout: 5000 })` | `execTmux(["capture-pane", ...], { timeout: 5000 })` |
| `tmuxAlive`: `execFileAsync("tmux", ["list-panes", ...], { timeout: 3000 })` | `execTmux(["list-panes", ...], { timeout: 3000 })` |
| input: `send-keys -l <text>`(timeout 5000) | `execTmux([...], { timeout: 5000 })` |
| input: `send-keys Enter`(timeout 5000) | `execTmux([...], { timeout: 5000 })` |

参数、`-t` target、timeout、错误处理路径全部原样;唯一语义变化 = child env 少了 `TMUX`/`TMUX_PANE`。

### 1.3 不改的东西(明确圈出)

- `close_runner`(纯 Bridge HTTP)、CommDB 读路径、scope guard、lifecycle.ts、status.ts——零改动。
- `claude-lead.sh` MCP 注册——零改动(root-cure 在工具边界,启动器不打补丁)。
- inbox-mcp、TmuxAdapter、Bridge——零改动。

## 2. TDD(RED → GREEN)

新文件 `src/__tests__/tmux-exec.test.ts`:

### 2.1 纯函数单测(无 tmux 依赖)
1. `sanitizeTmuxEnv` 删 `TMUX` + `TMUX_PANE`;
2. 保留其余键(抽查 `PATH`、`TMUX_TMPDIR`、`FLYWHEEL_LEAD_ID`);
3. 输入本就无 TMUX 时等值拷贝、不改原对象(无副作用)。

### 2.2 注入 seam 单测
4. `execTmux` 以 `execFileFn` spy 断言:cmd=`tmux`、args 透传、timeout 透传、env 已 sanitize(spy 收到的 env 无 `TMUX` 且含传入的其他键)。

### 2.3 real-tmux RED/GREEN 复现(`tmux-exec.real-tmux.test.ts`,沿用 real-tmux 先例但两处加强——Codex R1 HIGH-1)

**三套 env 显式定义**(测试宿主自己就坐在 tmux 里、进程 env 带 `TMUX=<当前socket>`,不剥掉它,沙箱 setup/probe 会连去宿主 server——沙箱必须先对自己做一遍被测修复):

```
T       = mkdtemp()
baseEnv = { ...process.env, TMUX_TMPDIR: T };  delete baseEnv.TMUX; delete baseEnv.TMUX_PANE
          // 隔离"默认" server 的 create / probe / kill / teardown 全部只用 baseEnv
seatEnv = { ...baseEnv, TMUX: `${T}/private.sock,12345,0`, TMUX_PANE: "%0" }
          // 模拟 v2 座位;私有 server 的起停始终显式 `-S ${T}/private.sock`
```

5. 沙箱:用 baseEnv 起隔离默认 server(session `runner-fly1681-<rand>`,socket 落 `T/tmux-<uid>/default`)+ 显式 `-S` 起 `T/private.sock` 私有 server。
   - **RED 自证**:裸 `execFile("tmux", ["list-panes", "-t", session], { env: seatEnv })` → 必须失败(命中私有 server,重现 bug;若意外成功说明沙箱失真,测试 fail)。
   - **GREEN**:`execTmux(["list-panes", "-t", session], { env: seatEnv, timeout })` → 成功(剥 TMUX 后回落 `TMUX_TMPDIR=T` 的隔离默认 server)。
   - **阴性对照**:用 baseEnv kill 该 session 后,`execTmux` 同调用 → 失败(修复不会把"死"也说成"活")。
   - teardown(afterAll,幂等):baseEnv kill 隔离默认 server + `-S` kill 私有 server + rm -rf T。
   - **能力门**:不用 `tmux -V`(本轮 review 环境就是 `-V` 成功但 socket 建立 `Operation not permitted`)——沿用 `scaffold-prune.real-tmux.test.ts:25-39` 的 functional probe:在同一隔离 env 里真 create/list/kill 一次,socket 操作不可用才 `describe.skip`,把基建限制与产品失败区分开。

### 2.4 静态守卫(Codex R1 MED-3 修订)
6. 遍历 `src/**/*.ts`(排除 `__tests__/` 与唯一豁免的 `tmux-exec.ts`),用对空白/换行/单双引号容忍的正则断言零裸 tmux 子进程调用:`/\b(execFile(?:Async|Sync)?|spawn(?:Sync)?)\s*\(\s*["']tmux["']/s`——现状 capture 位点就是 `execFileAsync(` 换行后接 `"tmux"` 的写法,精确 substring 抓不到;只扫 index.ts 也防不住未来新文件。防未来第 5 个位点绕开收口复活 bug。

顺序:先写 2.1–2.4 全红(2.3 的 GREEN 分支对着未改的裸实现红,RED 分支绿),再落 1.1/1.2 转全绿。

## 3. 验证门(全 repo,非只改动包)

1. `pnpm lint`(biome 全仓)
2. `pnpm -r build`(拓扑序;terminal-mcp dist 必须重建)
3. `pnpm test:packages:run`(定向补跑 `pnpm --filter flywheel-terminal-mcp test`)
4. 既有 `scope/lifecycle/status` 测试零回归(本单未触它们的被测面)

## 4. 部署与验收(实现节点之后的链路,写明给 QA/ship 节点)

- **生效条件**:merge → 生产 `git pull` + `pnpm -r build` → **各 Lead 的 claude session 重启**(MCP 进程与 session 同生命周期,旧进程不自愈;全舰重启车即覆盖)。无需 Bridge 改动/重启。
- **验收(在部署+重启后的真 v2 Lead 座位上做;阴性对照按现有 list 契约措辞——Codex R1 HIGH-2)**:调 `runner_terminal_list`,与 `TMUX= tmux` 直查结果一致——
  - 阳性对照:至少一个真活 runner 报 `alive=true`;
  - 阴性对照:kill 一个专用 QA 测试窗(其 CommDB 行仍为 `running`)后,list 报该行 **`alive=false`(class 仍 =running,这是 `classifyRunnerRow` 的既有契约:running 行永不隐藏、liveness 只作标注)**,并用 `runner_terminal_status` 对同一 session 断言 `{"status":"dead"}`(该工具在 tmux 探活失败时就是这个输出)。**不要**期望它显示 `class=dead`——dead 分类只属于 CommDB terminal 行,且默认 `active_only=true` 会隐藏 dead 行;更不要为凑验收去改 lifecycle 分类(超出本单 scope)。
  - 追加:`runner_terminal_capture` 能取回真屏幕内容(2026-08-10 的第二个症状)。
- **反假验守则**(memory 教训):验收座位必须确认其 MCP 进程是新 dist 之后 spawn 的(`ps eww <pid>` 看 TMUX 仍在——TMUX 在不在 env 里不变,变的是工具行为;用 dist mtime + 进程 start time 判新旧)。

## 5. 风险与已否决方案

| 风险 | 处置 |
|---|---|
| 某调用其实想查私有 server | 已三路审计否定(schema 无 socket 维度 / 全部写入方落默认 server / 13/13 生产进程反证)——research §5 |
| `TMUX_TMPDIR` 被误剥导致语义漂移 | 明确保留;real-tmux GREEN 断言本身依赖它,剥了测试必红 |
| 未来新增 tmux 位点绕开收口 | §2.4 静态守卫 |
| 已在跑的 Lead 看起来"修了还是坏" | §4 生效条件写死:session 重启后才生效,验收含新旧进程判别 |

已否决:B(每调用显式 `-S` + 自行推导默认 socket——复刻 tmux 语义,多一处对齐负担);C(claude-lead.sh 给 MCP env 写 `TMUX: ""`——只修一个 embedding,工具本身仍脆);D(加目标 socket 配置——加而不减,且无使用场景)。

## 6. 诚实边界

- 本单只修 terminal-mcp。Lead 在 v2 座位上用 **Bash 裸 tmux** 仍会命中私有 server——那是座位属性,`TMUX= tmux` 纪律继续适用(巡检 cron 已如此)。
- 不改变 list 工具「CommDB status + tmux 探活,不见 Bridge FSM」的既有能力边界。
- 不处理「Lead 想观察另一个 Lead 的私有 server」这类未来需求(无现实调用方;真出现时是新 issue)。
