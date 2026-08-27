# FLY-2029 Raya V1 地基 — 验证记录
Issue: FLY-2029 (https://linear.app/geoforge3d/issue/FLY-2029/rayav1-地基独立仓-codex-身份-raya-频道-v2-语音桥-试用期三指标自动记录)
日期: 2026-08-26
基于: plan.md

## 1. 范围与仓库

2026-08-26 Tadashi 转达 founder 的拆分：本单交 foundation + voice seam；
`apps/voice` 和真实语音房 E2E 归 FLY-2074。当前独立仓 head：

- `xrliAnnie/raya`：`0b954dbefdfb30b0293f339bf5d5027f7293d630`；
- `xrliAnnie/raya-memory`：`444ce00`；含独立 `MEMORY.md`，没有编造历史；
- 两仓均在 `fly-2029-raya-v1-foundation` 分支，尚未 merge；memory PR =
  `xrliAnnie/raya-memory#1`；
- `package.json` / `apps` / `packages` 中 `flywheel-` runtime reference = 0。

FLY-2074 seam 已由 `@raya/contracts` 明确：`apps/voice/dist/cli.js run`、必需/可选
`RAYA_*` key、`run/voice.pid`、`context-usage.jsonl`、start/resume builder，以及第二张
launchd job。model / effort / context window 不做 env option。

## 2. Codex 隔离与实测回执

- dedicated `CODEX_HOME=/Users/xiaorongli/.flywheel/raya/codex-home`，目录 mode = 0700，
  `auth.json` 与 `config.toml` mode = 0600；真实 App Server probe 后该目录按 Codex 原生行为
  生成了独立的 session/cache/state/internal-memory 文件，不读取或复用 host 默认 `CODEX_HOME`；
- 现有 `config.toml` 只含 Raya code checkout 的 project trust 条目；顶层 `model` /
  `model_reasoning_effort` / `model_context_window` 均不存在；
- `raya.env` mode = 0600；token 没有进入仓库或 plist；
- operator-owned identity 位于 `/Users/xiaorongli/.flywheel/raya/identity/IDENTITY.md`，
  mode = 0444，且不在 code/memory 两个 writable root 内；
- binary：`codex-cli 0.149.1`；
- 对真实 App Server 跑了 `initialize(experimentalApi=true)` → ephemeral `thread/start`；
- 服务端实际回执：model=`gpt-5.6-sol`、sandbox=`workspaceWrite`、network=true、
  cwd=`.../raya/code`，echo roots + cwd 规范化后恰好等于 code + memory；
- contract 另行拒绝 top-level `model` / `model_reasoning_effort` /
  `model_context_window`，三者只从每次 start/resume request 注入。

## 3. Discord 身份面

- dedicated bot id=`1542068543645024257`，API 实测 username=`Raya`、bot=true；
- profile 已换成 PRD 真图；repo asset SHA-256 =
  `4e06ce4fb2f52d95232e48e006fabe02ac224f32ba8d852e289f538aa0790dee`；
- `#raya` 已建立，channel id=`1542079099928059987`；按 PRD「分区 founder 自理」保持
  uncategorized；
- target voice room=`General`，id=`1485787273193853170`；
- 截止本记录，dedicated bot 的 guild list 仍为空，founder invite 尚未完成。此项是
  FLY-2074 live QA 的前置，不伪装为已进房。

## 4. 三指标与 install

brain runtime 每 60 秒 append `resource-usage.jsonl`，记录同一 runtime 的 process-tree
RSS、process count、brain/voice liveness、swap used/delta 与错误；voice 连续三样本 down
和恢复各告警一次；发送失败按 1/2/4/8 个样本间隔退避并在 5 次失败后停止，失败只进入实际
发送的 evidence row，不再让 `errorSamples` 随每分钟样本线性增长。FLY-2074 从 App Server
`thread/tokenUsage/updated` 逐字段 append actual `totalTokens` 与 nullable
`modelContextWindow`。`metrics summary --dir` 输出 trial 起止、RSS latest/peak、swap
start/latest/delta、context latest/peak/actual window、1M validity、存活覆盖、outage 与错误数。

安装后的 foundation 快照截至 19:07Z 已有 666 个 resource samples：RSS latest/peak =
65,077,248 / 101,269,504 bytes，swap trial start/latest/delta =
3,596,678,595 / 4,090,369,147 / 493,690,552 bytes，brainAliveCoverage = 1。
当前 `contextSamples=0`、`contextFilePresent=false`、`trialWindowValid=false`，因为 FLY-2074
尚未写入真实 token event；这份输出没有把 configured 1,050,000 冒充 effective window。
`voiceAliveCoverage=0` 且当前 580 个 error rows 都是 bot 尚未入 guild 时 voice-down 告警返回
Discord 403；数据保留了这段 outage，没有把未运行的 voice seam 记成健康。

founder 重启实测暴露原 installer 默认把 plist 写在 `RAYA_ENV_FILE` 邻近的临时注册目录：
`com.xrli.raya.brain` 虽在当前登录会话中 running，但 `launchctl print` 的 path 是
`~/.flywheel/raya/launchd/com.xrli.raya.brain.plist`，`~/Library/LaunchAgents` 没有 Raya job，
因此重启后不会自动注册。`40a8f70` 用 Node stdlib `homedir()` 把默认安装目标改为持久的
`~/Library/LaunchAgents/`，brain 与 voice 两条注册路径同时覆盖；两张 plist 的
`RunAtLoad` / `KeepAlive` / `ThrottleInterval` 语义不变，仍只含 `RAYA_ENV_FILE` 指针。

当前 FLY-2074 集成 checkout 已把两张 plist 生成到
`~/.flywheel/raya/launchd/FLY-2029-persistent-install/`；`plutil -lint` 两张均 PASS，secret scan
为 0，SHA-256 分别为 brain
`5836a0b55fdf40e6f18876a1ffc3fc676f241973d5d445c40d2fa5e6c4992fd0`、voice
`d60bf7dc5919604a484a66be2ed2527a9123a4f7b09296d040bd15399507020b`。managed sandbox 对
`~/Library/LaunchAgents` 写入返回 `EPERM` 后，question gate
`8444982d-989d-4c44-8f09-445a6df1142b` 由 Lead 于 00:06 PT 完成 operator install：两张文件均
位于 `~/Library/LaunchAgents/`、mode 0600、hash 与 staging 完全一致，`plutil -lint` PASS，
secret scan = 0。

brain 的当前会话模拟验收已完成：旧 job `bootout` rc=0，从
`~/Library/LaunchAgents/com.xrli.raya.brain.plist` `bootstrap` rc=0；本 runner 复核
`launchctl print gui/501/com.xrli.raya.brain` 为 persistent path、`state=running`、pid 99956、
runs=1。voice 的 persistent plist 同样已经安装，但其 FLY-2074 live acceptance 正在 General
房间使用当前 pid 13352，故未为本单打断它做第二次 bootout；当前加载 path 仍是旧 registration，
其下次安全重注册或正常登录会读取已经安装的 LaunchAgents 文件。真实 reboot 明确留到 founder
下次正常重启后由 Lead 核验，本单没有为验收重启机器。

## 5. QA 证据

在 Raya 工作仓与一个新 clone + 空 HOME（无 Flywheel env）各跑一遍：

- `pnpm install --frozen-lockfile`（clean-room）；
- `pnpm test`：contracts 13 + brain 40 = 53 passed；
- `pnpm typecheck`：PASS；
- `pnpm build`：PASS；
- `pnpm lint`：PASS；
- `pnpm audit --prod`：0 known vulnerabilities；
- source token exact match：0；generic credential-like tracked files：0；
- 两张 plist `plutil -lint`：PASS；plist secret scan：0。

当前 rework head 由 `git ls-remote` 固定为
`0b954dbefdfb30b0293f339bf5d5027f7293d630`；lockfile 下 53 tests、typecheck、build、lint、
production audit 全绿。新增 launchd 合同测试固定 per-user persistent path；既有测试证明 alert 失败只在样本 index 0/2/5/10/19 发送，5 次失败后
停止；无换行 torn 尾行不阻断 summary，完整坏行携带 absolute `file:line`。另在原工作仓把
stubborn-child preflight 连续跑 12 次，均为 5/5 passed。R1 对
`6dd14b8` 提出的 HIGH（recoverable sampling error 让 brain clean-exit）已修复：baseline/sample
write failure 留在 resident loop，下一次成功样本带出前一次错误；另补 spawn/stdin failure、
stubborn Codex child kill、跨 runtime swap summary、全表 config 扫描、shared env parser/0600、
identity overlap fence 与 bounded network timeout。R2 对 `b8ee5f6` APPROVED，并留下六项
非阻塞 advisory；其中 fresh install directory 与 failed alert retry 两项 MEDIUM 已由
`daf35d9` 最小修复，另把 README 的 voice runtime 表述收窄为 integration contract。
R3 对 `daf35d9` APPROVED；其中 reviewer 与 FLY-2074 同时复现的 test fixture 冷启动竞态已由
`f73d4eb` 改为有界 PID readiness / process-exit polling，不扩大生产超时。R4 已绑定到
baseline head `f73d4eb` 并 APPROVED。持久化 revision `40a8f70` 的 R5 code review 找到一个
blocking HIGH：默认大小写不敏感的 macOS volume 上，`realpathSync` 不会恢复磁盘真实大小写，
敏感路径 containment 可被 case variant 绕过。`0b954db` 先以两条 RED 测试复现 config guard
绕过与 Codex receipt 假拒绝，再把现有三处 canonicalization 最小改为
`realpathSync.native`；R6 对 exact head
`0b954dbefdfb30b0293f339bf5d5027f7293d630` APPROVED。代码 PR：`xrliAnnie/raya#1`；
记忆 PR：`xrliAnnie/raya-memory#1`。

R3 其余 advisory 按 policy 均为非阻塞：Discord outage 时 alert await 会让 row 最多晚写
10 秒、installer error 输出/目录 mode 的 operator UX、stale voice PID identity、目录通过
`X_OK` 的错误诊断、preflight grace timer linger，以及 sample gap 尚未量化。它们没有把
当前证据伪装成有效 1M trial；分别适合 FLY-2074 集成或后续 hardening，未在首个 foundation
PR 中继续扩 scope。

R4 新增 advisory 中，本次 QA rework 已让 metrics reader 容忍无换行的 torn 末行，并让完整
坏行以 `absolute-file:line` 失败；voice env 合同也显式纳入 `RAYA_HOME`、`RAYA_ENV_FILE` 与
reserved `RAYA_OPENAI_API_KEY`，同时把有默认值的 state/log 归为 optional。schema 允许省略
context window 时按 null 保留 token row、preflight 断言 server echo 的 xhigh，以及 PID
identity 上移 shared contracts 仍是非阻塞 follow-up。

R6 其余 advisory 按 review policy 均为非阻塞：text-channel-id provisioning、非零退出时的
KeepAlive 语义、stale voice PID ownership、Raya code-root isolation、startup-only path guard、
installer entrypoint existence 与 tests typecheck coverage。它们已通过 `ask --report` 转给 Lead；
本次 founder revision 明确要求保持既有 RunAtLoad / KeepAlive 语义，故没有继续扩入修订。

## 6. Flywheel 载体仓 QA

Flywheel 本身只增加过程文档，不增加 runtime code。当前 rework 上 `pnpm -r build` 全仓通过，
移除 exact-head reviewer checkout 后 `pnpm lint` exit 0（仅既有 warning）；
PR #960 的 hosted `Quick Gate (build + typecheck + lint)` 与总 `CI OK` 均为 SUCCESS。

本地 `pnpm test:packages:run` 首先只被 core 两个必须连接真实 Terminal/AppleScript 的 macOS
用例挡住；排除该宿主 GUI 文件后 core 19 files / 219 tests 全绿。随后对其余 21 个 package
跑完整 aggregate：除 teamlead 外全部通过；teamlead 在高并发下为 9,600 passed / 18 failed /
6 skipped，失败由 5–15 秒固定时限、一个 watcher teardown、宿主 npm cache `EPERM` 和 Vitest
worker RPC timeout 组成。把全部 11 个失败文件改为单 worker，并只给 `npm pack` 注入 task-local
cache 后，11 files / 165 tests 全绿；因此没有可在隔离条件下复现、也没有与本单 Markdown diff
相交的失败。两个真实 GUI 用例因当前 session 没有 Terminal automation connection 而不能执行，
不把原 aggregate 写成全绿。
