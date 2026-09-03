# FLY-2269 visual-capture 浏览器清理 — 调研
Issue: FLY-2269 (https://linear.app/geoforge3d/issue/FLY-2269/发布链泄漏-visual-capture-与-publish-report-同形的-chrome-页泄漏proofshot-start)
日期: 2026-09-02
基于: exploration.md

## 1. 仓库现状证据

### 1.1 visual-capture 的状态门

`packages/flywheel-comm/src/commands/visual-capture.ts` 当前有两个 stop 点：正常路径
在截图后设置 `proofShotStopAttempted=true` 再调用 `runProofShot(["stop"])`；finally
只在 `proofShotStarted && !proofShotStopAttempted` 时调用同一命令。

`proofShotStarted` 位于 `runProofShot(proofShotArgs)` 返回之后。start 若在打开 page、
启动 recording 的中途抛错，状态仍为 false，两个 stop 点都不可达。正常 stop 抛错时
attempted 已经为 true，finally 也不会再执行任何 Chrome cleanup。现有测试把
`runProofShot` 当纯调用记录器，只断言 stop 次数，无法观察 tab/renderer 是否真的
回到 baseline。

### 1.2 FLY-2215 已上线的同形修复

主分支 commit `68053c080`（PR #1033）已把 publish-report 改成直接
agent-browser cleanup：

- `session list --json` 判定 browser 是本轮创建还是既有共享；
- shared/unknown browser 独立采集 tab baseline；
- start 尝试后以稳定 tab-id 前后差识别本轮页；
- `record stop` 失败重试一次；
- owned browser 整树 `close`，失败才逐 id fallback；
- shared browser 只在 baseline 可信时逐 id close；
- probe/stop/close 失败 warning，不扩大所有权。

FLY-2215 的实现证据记录了真实 Chrome 控制组：一次 start 可出现两个相同报告 page
加一个 newtab，证明只关 active tab 不够；shared browser 连续发布 4 次、包含一次
record-stop 注入失败和下一轮三次 recording retry 后，总 page 数仍回到 baseline 3。
本单直接复用这套已经过评审和真机验证的所有权状态机，只把“按报告 URL 过滤”改为
visual-capture 的“全部 post-minus-pre 稳定 tab id”，因为 UI/3D capture 没有单一
恒定 URL（dev server、model viewer 与 camera navigation 都可能变化）。R1 指出这会
扩大不拿 ProofShot lock 的直连 agent-browser 用户的竞态窗口，因此 post-list 必须放在
start 返回/抛错的紧邻 finally，不能拖到全部 3D navigation 完成后。

### 1.3 既有安全边界

`acquireProofShotLockWithRetry()` 覆盖 visual-capture 的整个 start/capture/finally 区间，
可防另一条 Flywheel ProofShot 调用在 baseline 与 post-list 之间插入 tab。仍不把
“当前 active tab”当所有权证据；只有稳定 id 集合差才有 close 权限。

FLY-766 reaper 只回收带 runner browser-tmp owner 的终态 Chrome，不能替代 Lead/CLI
进程内的本轮 cleanup；扩大 reaper 会增加误杀范围，本单不改。

## 2. 已安装外部 CLI 契约

本机 `proofshot --version` 为 1.3.1，`agent-browser --version` 为 0.27.1。已安装源码与
CLI help 给出以下直接证据：

1. `agent-browser tab list` 返回稳定 `t1/t2/...` id，session 内不复用；
   `tab close <tN>` 可定点关闭。
2. `agent-browser session list --json` 和 `tab list --json` 是 FLY-2215 当前实现使用并
   测试过的机器可读接口。
3. ProofShot `startCommand()` 先 open browser，再尝试三次 `record start`；recording
   全部失败时进程失败发生在 page 已打开之后，正是 start-failure 泄漏窗口。
4. ProofShot `stopRecording()` 内部对 `agent-browser record stop` 设 15 秒 timeout，
   但吞掉异常；`closeBrowser()` 同样吞掉 close 异常。
5. ProofShot CLI 用 `.option("--no-close", ...)`，Commander 12 的实际 options 是
   `{close:false}`，而 stop 实现判断 `options.noClose`。因此当前安装字节仍会走
   browser close，不能作为 shared-session 安全方案。
6. ProofShot stop 最后生成 SUMMARY/viewer 并删除 `.session.json`；直接 record-stop
   不会做这两步。因此 visual-capture 改造必须显式处理本轮 session state，并在文档
   中披露 SUMMARY/viewer 的退化边界。
7. R1 对 installed bytes 的直接追踪还证明当前 visual-capture 已存在 session split：
   start 读取 `--output`，exec/stop 却从 cwd 的默认 config 解析
   `proofshot-artifacts`。现有 unit fixture 把文件造在 outputDir 顶层，掩盖了真实
   timestamp session 子目录。修复必须让 start/exec 明确解析到同一绝对 session root、
   递归 discovery 并对零 PNG fail-loud。
8. R2/R3 对 installed bytes 的复核补出一个不能用“所有命令统一 cwd”解决的约束：
   UI start 必带 `--run <devCommand>`，ProofShot 的 `ensureDevServer()` 会以 ProofShot
   进程的 `process.cwd()` 启动该命令，并从同一 cwd 读取 git branch/SHA。outputDir 是
   新建空目录；把 start cwd 改成 outputDir 会令默认 UI capture 稳定失败，也丢失 git
   metadata。start 必须保留调用方项目 cwd，并用绝对 `--output` 绑定 session root；
   只有 exec 使用 outputDir cwd。
9. `loadConfig()` 会从 cwd 向祖先寻找 `proofshot.config.json`。仅依赖默认
   `./proofshot-artifacts` 会受用户 HOME/祖先 config 漂移影响；outputDir 内的最小 config
   必须把 exec 的 output 固定为 `./proofshot-artifacts`，而 start 的绝对 `--output` 再次
   覆盖项目侧 config。已有 output-local config 只能验证兼容、不能覆盖或误删。

## 3. 超时策略

现有 `publish-report.ts::defaultRunAgentBrowser` 的 JSON 与非 JSON 两个
`execFileSync` 分支都没有 timeout。Node 的同步子进程默认可无限等待；外部观察中的
一次挂起约两分钟，record-stop retry 会把失败路径放大。

候选方案：

| 方案 | 判断 |
|---|---|
| 只给 `record stop` 加 timeout | 不足；session/tab/close 卡住仍能无限阻塞整个命令。 |
| 在两个 command 文件各写常量 | 可工作，但同一安全策略容易漂移，测试也重复。 |
| 新增内部 `agent-browser-runner.ts`，固定 15 秒 | 采用；两个调用方共享同一实现，JSON/非 JSON 都受限，无公共配置旋钮。 |
| 暴露 env/CLI timeout | 拒绝；Issue 明确要求常量，不加旋钮。 |

共享 runner 继续使用 `execFileSync(file,args)`，不经 shell；返回 JSON 的调用保留
UTF-8 stdout，其他调用继承 stdout/stderr。新增单测 mock `execFileSync`，分别断言
JSON 与非 JSON 分支都携带 `timeout: 15_000`，并证明 visual-capture 的 profile/
stream env 也传给 direct agent-browser 调用。实际 hang-stub 测试必须显式设置 40 秒
Vitest timeout（默认 5 秒会产生与被验行为无关的假红），并让 stub 派生继承 stdout 的
孙进程，覆盖 agent-browser daemon 形状；该慢测与其他 focused suites 分开运行。

## 4. visual-capture 目标状态机

```text
lock acquired
  → non-spawn session membership preflight
  → recheck immediately before start
  → present: shared baseline; absent: no tab-list; probe failure: unknown but continue
  → create/validate output-local ProofShot config
  → reject pre-existing .session.json; snapshot existing direct session dirs
  → mark startAttempted
  → proofshot start in project cwd with absolute --output
  → on exit 0 mark startReturned (recording cleanup authority)
  → non-spawn post membership
  → present: tab-list; owned uses empty baseline, shared uses captured baseline
  → absent/unknown: skip tab-list
  → read new .session.json; validate fresh in-root non-symlink sessionDir (artifact authority)
  → proofshot exec in outputDir cwd
  → capture PNGs
  → discover only current sessionDir; select/write manifest/optional notify
finally when startAttempted:
  → startReturned + post-present: agent-browser record stop (retry once)
  → owned: close whole browser; on failure close identified new ids
  → shared: close only post-minus-pre stable ids
  → absent/unknown: zero tab/browser close
  → remove only a proofshot-artifacts/.session.json created by this call
  → remove only an output-local config created by this call
  → close model server → release lock
```

关键顺序是先按 ownership 条件 stop recording，再关 tab/browser；即使 primary capture
抛错，finally 仍执行获授权的序列且最后重新抛原错误。cleanup 的 warning 不遮蔽
primary failure，也不把正常捕获降成失败。

## 5. 输入与失败处理

- JSON 必须是文本、`data.sessions`/`data.tabs` 必须为数组；否则 probe 失败。
- sessions 只接受 string；tabs 只接受 object 且 `tabId`/`url` 为 string。
- close 列表只保留 `/^t\d+$/`，避免格式漂移或恶意 JSON 把任意 label 当 close target。
- agent-browser 0.27.1 真机证据表明，`session list --json` 是不 spawn 的 membership
  probe；对不存在的 session 执行 `tab list --json` 则会成功
  spawn 一棵 browser 并返回 `t1 about:blank`；而 R8 在生产 present `default` 上实测同一
  tab-list 前后 membership 逐字不变。因此 tab-list 是条件操作：present 时可安全读取，
  absent/unknown 时禁用。present 采 shared baseline/差集，absent bootstrap 后确认为 owned，
  probe failure=unknown但继续 capture、零 tab/browser close。
- `No browser connected` / `No active session` 在安装字节中只是 stream-viewer React UI
  文案，不是 CLI error。删除围绕它们的 mock-only classifier；session-list/共享 tab-list
  的任意失败都 warning 并 fail-safe，post-list 失败也不猜 active tab。
- owned whole close 失败时只对 guarded post-list 已识别的稳定新 ids fallback；没有证据
  就不关。
- record stop 最多两次；两次失败均不授予额外 close 权限。
- start 前已有 `.session.json` 表示旧/活跃 ProofShot session；必须在任何 start/exec/
  record-stop/close 前 fail-loud 并完整保留。ProofShot start 的 exit 0 不足以证明成功，
  但 pre-check 已排除 already-active state 后，exit 0 足以授权本轮 recording 的 stop；
  只有新 state 指向 root 内 start 前不存在的直属非 symlink sessionDir 才能额外授权
  exec 与 artifact discovery。state 读取失败不能孤儿化已经可证属于本轮的 recording。
- pre-existing target 是生产常态 shared，present tab-list 采 baseline后继续 capture并只关
  差集。initial/second/post membership unknown 时继续 capture但无 tab/browser close 权限，
  本轮 browser/tab 可能残留并 warning。owned 确认后若外部用户
  蹭入同一 target 无法检测，整树 close 会结束整棵本轮创建的树；这是 Lead G3 明确接受
  的竞态残差，不新增探针。

## 6. Artifact 兼容性判断

visual-capture 的明确产品用途是 Runner fallback 自检，文档描述为结构化
PNG/WebM/SUMMARY。PNG 在 stop 前已经由 `proofshot exec screenshot` 落盘，WebM 由
direct `record stop` 保存；ProofShot SUMMARY/viewer 则依赖不安全的 stopCommand。

当前仓库 `discoverArtifacts()` 只枚举 outputDir 顶层，既有 unit tests 也在顶层造
fixture；真实文件却位于 `proofshot-artifacts/<timestamp_slug>/`。R1 将这项提升为 HIGH：
若直接删除 stop，旧 hard failure 会变成 exit 0 + 空 manifest。本单因此把 discovery
改为读取 start 新 state 后，只从校验过的本轮 sessionDir 确定性递归：start 在项目 cwd
运行并传绝对 `--output`，exec 在带最小 config 的 outputDir cwd 运行，两者解析到同一
root；start 前目录快照防止 state 回指旧轮次，selection 前要求至少一个 PNG。递归保持
现有 symlink-file artifact 兼容性，但绝不遍历 symlink directory，避免环；
正/负测试固定这两种语义。仍不复制第三方 bundle、不升级全局依赖；SUMMARY/viewer 退化
继续披露，不能以可能误关 shared browser 来换取它们。

## 7. 测试与真机矩阵

单测需要覆盖：

1. owned browser success、start failure、screenshot failure、whole-close failure fallback；
2. present 起手采 shared baseline、capture 成功、只关差集且外来 tab/membership 不变；
   absent→present 才 owned，guarded post-list + whole close 后 membership 回到调用前；
   probe unknown 继续 capture、零 tab/browser close；
3. start-before-open failure + post membership absent/unknown 时完整序列零 tab 命令；
   owned post-list JSON 失败不阻断整树 close；
4. record stop 首次失败重试一次、两次失败仍继续 ownership cleanup；
5. 任何 cleanup failure 不 mask primary error，lock/model server 仍释放；
6. shared start failure 不 stop 外来 recording；owned start failure 仍停止本轮 browser
   内可能已建立的 recording；
7. direct agent-browser 调用继承显式 env/profile/stream；ProofShot start 固定项目 cwd、
   带绝对 session-root `--output`，exec 与 direct agent-browser 固定 outputDir cwd；最小
   local config 不覆盖/不删除 pre-existing config；UI start 的 `--run` 可在项目 cwd 执行；
8. shared runner 的 15 秒 timeout 同时覆盖 JSON 与非 JSON execFileSync，并用实际 hang
   子进程测量约 15 秒返回；
9. nested PNG 与 symlink-file PNG 进入 non-empty manifest，symlink directory 不遍历，
   零 PNG 明确失败；同一 outputDir 两轮的第二轮 manifest 不含首轮路径；pre-existing
   state、missing/malformed/out-of-root/old/symlink sessionDir 全部 fail-loud；pre-existing
   state 零 stop，start exit 0 后的 state 校验失败仍 stop 本轮 recording。

独立 QA 使用同一隔离 host 台架跑 origin/main BEFORE 与 PR AFTER，各 N≥3，注入一次
ProofShot start/recording failure；每轮记录 CDP page 数与该 profile 的 renderer 数。
AFTER 必须回到 baseline、外来 tab 存活、下一轮 start 成功，并真实跑一轮 UI `--run`
证明 dev server 从项目 cwd 启动。present 起手臂必须在生产形状下 capture 成功、只关差集；
absent 起手臂必须 whole-close 回 baseline；probe unknown 仍成功但零 close。mock 只能
证明控制流，不能替代这组真机验收。BEFORE 预期 stop 处 exit 1、只提供泄漏计数，不与
AFTER 做 manifest 字段对比；台架还要从首轮起证明 session membership/tab/renderer 每轮
精确回到初始 baseline，并记录正常 session/tab list latency 与 15 秒余量。
