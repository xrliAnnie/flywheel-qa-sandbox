# FLY-2446 通用 voice 进程 — 实施验证
Issue: FLY-2446 (https://linear.app/geoforge3d/issue/FLY-2446/语音-通用-voice-进程会议模式所有-lead-可挂rg随身模式先-raya-用独立-codex-realtime-进程语音文字经)
日期: 2026-09-09
基于: plan.md; implementation-addendum.md; design-correction.md

## 恢复核验与修复

从已提交的 A–F 实现恢复，未重写 pinned plan。当前仍在 implement，未达到交接条件。

- `3f14c4b94`：voice 包固定单 fork，排除 macOS viewer；CI light shard 明示归属。
- `7125070d2`：真实 Node package import 先以 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  失败，再导出窄 CoS port；G46 网络异常先得到错误的 `transport_error`，修为
  计划规定的 `bridge_unreachable`。两文件六项测试通过。
- `9fa27d62f`：260 帧提前入队的回归先证明旧实现丢前十帧；去掉静默截尾后
  保留顺序。尾部不足一帧的回归先失败，再补静音排出。
- `1d5caa1be`：从 Raya `0f77e97` 提取纯 Uplink、SpeechGate、Silero 与音频原语；
  原测试先以缺模块失败，提取后 42 项通过。模型和许可证随包发布；真实 ONNX
  语音 fixture 推理通过。未提取 InboxReader 或抢话仲裁。
- `d221a0e17` / `c1c3be054`：说话时段归属与房间实际 VAD/20ms 时钟接线。
  房间回归先观察到零静音帧，再验证持续送静音、授权语音通过、非语音抑制、
  stop 后停止送帧，以及三秒后转写的归属。歧义不会归给后来的说话人。
- `aecaa4116`：续租覆盖 warming、presence 与 outbound；独立本地 deadline、
  不可恢复的旧 lease fencing、启动取消、朗读中终止与子进程清理均有红绿回归。
  无归属的转写只保存脱敏匿名 evidence 并提示重说，不进入 mailbox。

- `5b2819430`：Codex runtime 的认证 inbox probe 返回实际 `ignoredAuthorIds`；
  voice preflight 核验运行中取信器能力，缺席或不可达 fail closed。相关五文件 174 项通过。
- `72c197e7d`：固定 root nonce 重试窗和 ending 起点，取消竞态保存外部回执并清理；
  additive 时间戳迁移与恢复/取消有 26 项聚焦测试。
- `bbfb8c19f`：有效 lease 的 `she-left` / `voice-stop` 从 live 正确终结；
  text-stop 仍须经 ending，未知原因与失效 lease 拒绝；19 项控制面回归通过。

## 已执行的本地门禁

这些证据只证明本地范围，不代表真房、exact-head CI 或正式代码审通过。

- `pnpm lint`：修复后 exit 0，3108 files，14 warnings，未自动改动全仓。
- `pnpm -r build`：修复后 exit 0，包含 voice-codex 与 ONNX 类型编译。
- `pnpm --filter flywheel-voice-codex test`：19 files / 116 tests 通过，单 fork。
- 控制面 `voice-session voice-host huddle-config lead-resolve channel-permissions`：
  15 files / 71 tests 通过，单 fork。
- `bash scripts/__tests__/flywheel-voice-wrapper.test.sh`：22/22 通过。
- `bash scripts/__tests__/ci-structure.test.sh`：通过。
- `node scripts/fly-2006-retention-consumer-gate.mjs`：`ok=true`。
- `pnpm install --offline --frozen-lockfile`：exit 0；保留既有 Discord `ws` 锁定版本。
- 第一轮 `pnpm test:packages:run --pool=forks --maxWorkers=1 --minWorkers=1`：
  **exit 1，非绿**。claude-runner 45 files / 1105 passed / 2 skipped 后发生
  `[vitest-worker]: Timeout calling "onTaskUpdate"`；后续包未跑到。
  日志 `/private/tmp/fly2446-resume-packages.log`。第二轮同样 exit 1，
  日志 `/private/tmp/fly2446-audit-packages.log`；也是相同 RPC 超时。
  合入最新 main 后第三轮也是 **exit 1**：1137 passed / 1 failed / 2 skipped，
  同一 RPC 超时另加 kill-path-inventory 的 15s 超时；聚焦扫描 3.4s 通过，
  不能据此改称完整门禁通过。日志 `/private/tmp/fly2446-rebased-packages.log`。
- 单独完整 TeamLead 运行中出现 `account_switch_wake_sweep` 类型失败；聚焦 31/31
  通过。依赖构建完成比全套开始晚 8 秒，可能存在旧模块缓存（推断，未捕获
  当时加载内容）；这是验证编排缺陷，后续全套不得与构建重叠。
- Lead `b5f3a669-2555-4115-9552-823325c48412` 分诊裁定：主机五个 runner
  并发门禁；两项按 `VITEST_MAX_FORKS=1` 单文件复跑通过后按负载影响披露，
  不改 timeout；既有 onTaskUpdate RPC 超时作为已接受产物。两项依指定环境
  重跑 exit 0：kill-path 1/1（1.4s），flag-store 31/31。日志分别为
  `/private/tmp/fly2446-kill-inventory-ruling.log`、`/private/tmp/fly2446-flag-store-ruling.log`。
  这项裁定允许继续一次 push/review，不等同于全仓门禁绿。

## 尚未完成

- Flywheel #1134 与 Raya #61 均已合入。Flywheel 依 Lead `2cca6076` 裁定保留
  远端历史，以普通 merge 合入 `main@04ff8800`，没有 force push；合并树与
  rebase 验证树一致。计划 blob 仍为 `588227c29a5736db08d84c381a3950e50391a37e`。
- Raya nested `c24c527231afd817ce159fd5423e3728c01445a0` 已实现显式模块 loader、
  CLI voiceIntent 注入、公开 reason 映射；仅四个 `packages/cos` 文件。
  156 项测试、lint/typecheck/build 与真实构建跨仓模块隔离 HTTP smoke 通过；
  提交后五项门禁全部 exit 0；Raya PR 为 https://github.com/xrliAnnie/raya/pull/71 。
  记录目录 `/private/tmp/fly2446-raya-final-20260909T180527Z/` 含 receipts.json、
  五份日志、smoke 脚本与 SHA256。
- Lead `2cca6076-8c15-49b2-8bd3-f69db3c02502` 裁定：Raya 无 CI，禁止本单新增
  workflow；以 exact-head 本地五项门禁记录替代。Flywheel 保持 CI 14/14。
- `scripts/qa/fly2446-two-lead-run.mjs` 已由 `0deef7eac` / `e5f6ff554` 实现，
  19 项 hermetic 测试与 CI 结构检查通过；两场真语音房、波形、SQL 三方账、
  实际 `selectMeetingTranscript` 与 RG 正负对照尚未执行，不能算 PASS。
  旧 Raya harness 已被 #61 移除；Lead `c7213d53-ed55-4292-85a2-94882764b750` 已裁定实现阶段交付
  驱动和 hermetic dry-run，QA 阶段执行；输入契约见 `qa-driver.md`。真房执行当前被未合入的
  FLY-2455 slot Lead bootstrap 阻挡，G **NOT_RUN**。
- 五秒归属窗口问题已依 `c4ba872b-6b0d-4b9c-8029-f39284d89ae7` 裁定修复：
  未消费 speaking epoch 保留至 final；混合/歧义匿名脱敏，不推断归属。九项测试通过。
- 尚无 Flywheel 锚 PR、正式 code review APPROVED、Flywheel exact-head CI 或 needs_review receipt。

## 诚实边界

前台「只应一字、不回答」是提示级约束，自言句以 `🤖` 标出，计数不承诺 0。
端到端节奏不给数字；会中断电只有 evidence 转写；镜像窗外未知会丢话并提示重说。
抢话 v1 默认关，插话排队不静默丢弃。Huddle 权限故障以 preflight 503 明报，
本实现不创建 bot、不调整生产权限。本次未运行 realtime，未新增平台 credit 消耗。

## 部署与回滚边界

无生产 registry、launchd、raya.env 修改；测试不借生产 Lead 进房。
部署需显式设置 `RAYA_FLYWHEEL_VOICE_INTENT_MODULE` 为构建后的绝对入口路径，
并按计划核验测试/生产各自的 bot、权限、模式与证据目录。配置步骤由班车执行。

Raya 仓 merge ≠ deploy:生产 checkout/brain 重启/preflight 由班车完成,
以 `~/.flywheel/raya/deploy-receipt.json` 为准,本 QA 不宣称上线。

回滚按 plan §5：停新单元、撤新配置；证据表、journal 与 evidence 保留。
恢复旧 Raya voice 需另行授权。

## 恢复回执修正（2026-09-09，代码审 HIGH）

主仓请求 `86edb63f-6ac9-49b2-8589-ca00df9db2b3` 在 `135fe75e0` 返回
CHANGES_REQUESTED，唯一 HIGH 为 `voice-daemon-restart-brick`。Lead 指令
`2b63f247-6eda-4c6a-9c30-f07678fddc71` 与问题
`8b8055d2-d271-4659-aa6c-9421f491946e` 授权只修复恢复路径，随后一次普通
push、一次新主仓精确头审查；Raya 必须等主仓 APPROVED 后才送审。其余 finding
列作 PR follow-up，不改实现；本次不增加抽象、不改 StateStore 或路由合同。

- RED：真实 StateStore reserve → desired → claim → 30 秒时 sweep 为
  `failed(lease_lost)`；renew 与终态写均被拒，真实 daemon.run 在 409 处失败。
  日志 `/private/tmp/fly2446-recovery-store-red-focused.log`：1 failed / 15 passed。
  daemon 回执 409/404/403 三个用例也先失败，日志
  `/private/tmp/fly2446-recovery-red.log`：3 failed / 119 passed。
- 最小修正：仅在 `recover()` 的 daemon_restart 回执处捕获不可重试 4xx，
  随后移除旧持久文件、继续循环。网络错误、408、429、5xx 继续抛出并保留文件；
  不恢复旧 lease 的投递权限，不修改会话终态。未改变 runOnce 的错误处理。
- GREEN：voice-codex 完整 19 文件 / 122 测试 exit 0；TeamLead voice-session
  11 文件 / 60 测试 exit 0，均单 fork。真实 sweep 回归验证进入 idle loop、
  旧文件消失、第二次 recover 不重发回执且 Bridge 行仍为 failed。
  日志 `/private/tmp/fly2446-recovery-voice-green.log` 与
  `/private/tmp/fly2446-recovery-teamlead-green.log`。
- `pnpm lint` exit 0（14 warnings）；`pnpm -r build` exit 0。
  `/private/tmp/fly2446-recovery-lint.log`、`/private/tmp/fly2446-recovery-build.log`。
  build 完成后才启动完整 `pnpm test:packages:run --pool=forks --maxWorkers=1
  --minWorkers=1`（`VITEST_MAX_FORKS=1`），结果待回填，不能称全仓绿。
- 真实 sweep 的首次筛选命令误用了 `test -- <filter>`，启动了全套；已中断，
  该次不是测试通过证据。正式 RED 使用 `exec vitest run <file>` 精确筛选。

完整门禁最终结果：`/private/tmp/fly2446-recovery-packages.log`，exit 1。
claude-runner 46 文件 / 1138 passed / 2 skipped，零失败断言，但出现
`[vitest-worker]: Timeout calling "onTaskUpdate"`，递归任务在这里退出，后续包
未运行。flywheel-comm 已完成 150 文件 / 2141 passed / 2 skipped。既有 Lead
`b5f3a669-2555-4115-9552-823325c48412` 明确将该 RPC 超时保留为 accepted artifact；
本次再次实查裁定并报告 `4ecb6b0d-fc13-4433-acae-482f79b1c2d5`。不把此前或本次
聚焦通过解释为完整 package gate 通过。新头仍须 CI 14/14 与正式代码审 APPROVED。

负向测例仅扩展既有两个测试文件，不增加未登记 CI 测试文件；其他七条主仓 advisory
与六条 Raya advisory 保留在 PR 正文作 follow-up。package-onboard 范围已由 Lead
`f602df8c-a786-4f24-b7eb-ed925403ccd9` 明确批准 voice 三包、wrapper、license 与
小于 20 MB 的模型，作为 pinned plan 非目标的授权修正；模型大小与负向安装测试
已记录在 PR 正文。该裁定不授权本轮进一步扩张实现。

## launchd 与测试隔离修正（2026-09-09）

主仓 `f44088d31` CI run `34402118354` 14/14 SUCCESS，但正式 review
`24984c74-3a88-40ee-af51-2d7e5af0c4eb` 为 CHANGES_REQUESTED。
Lead 问题 `a1c77138-40f8-4364-9b8f-4cb50ba4c5b2` 明确仅授权修复两个 HIGH：
`voice-launchd-keepalive-assert-mismatch` 和 `voice-wrapper-test-touches-production`，
之后一次普通 push、一次新主仓审查与 CI；Raya `d4e6b13` 不动。

- KeepAlive RED：真实 predicate 与提交的 plist 产生 3 个失败（loaded restart、
  错误布尔策略被接受、重启后策略丢失）。最小修正为显式 `on-failure` 检查；
  voice 在重启前后都要求仅 `SuccessfulExit:false`，其他调用方默认仍要求布尔 true。
  plist 不变。测试不再 stub predicate，只隔离 loaded/restart 外部操作。
- 环境隔离 RED：继承纯临时目录变量时，旧测试读取假宿主 `.env` 标记并产生
  2 个预期失败。每次 wrapper 调用改为 `env -i` 显式白名单；告警走临时记录器。
  测试注入假的宿主目录和额外 `FLYWHEEL_*` 标记，断言未读取、未泄漏且只记录
  一次预期配置告警。未读取真实 `.env`，未调用真实告警或 launchctl。
- GREEN：wrapper 31/31，macOS 原生 plutil 与 Linux plistlib 测试适配各一次；
  supervisor 9/9、Bridge launchd 3/3、CI enumeration/structure 通过。
  日志 `/tmp/fly2446-{keepalive,env}-suite-{red,green}.log`、
  `/tmp/fly2446-wrapper-linux-parser.log`、`/tmp/fly2446-supervisor-green.log`、
  `/tmp/fly2446-bridge-launchd-green.log`。
- `pnpm lint` exit 0，14 warnings；`pnpm -r build` exit 0。
  随后单 fork 完整 package gate exit 1：flywheel-comm 152 文件、2170 passed、
  2 skipped；claude-runner 46 文件、1138 passed、2 skipped，零失败断言但有
  `onTaskUpdate` RPC 超时，后续包未运行。日志
  `/tmp/fly2446-high-fixes-{lint,build,packages}.log`。重新读取 Lead
  `b5f3a669-2555-4115-9552-823325c48412`：该 RPC 超时仍为 accepted artifact；
  不是全仓绿。本节聚焦结果不替代新头 CI、正式 review 或真房 QA。

## QA attempt 1 退回后的限定修复（implement attempt 2）

QA claim 989 对 `ef7786061` 给出 qa_failed。Lead 指令
`609a1f3c-139c-42c2-aa56-3259413e0f02` 及答复
`2ca80397-daf9-463e-9f4e-7dcab2cdce11` 限定本轮三项；已读纠正后的 QA
报告 `/tmp/claude-501-fly2446/ship-report.html`，不重放前身 needs_review。

- `9ac062d57`：会议模式缺省开启，显式 false 拒绝，RG 仍须显式 true。
  真 HTTP router + 临时 StateStore 的 D 用例先返回 voice_mode_not_enabled，
  修正后 201；D/E/F、仅 RG 字段、RG 缺省/false/true 共七组，逐组核对
  201/403 和 reservation 是否存在。没有改生产 registry。
- 运维输入先检查 mode 与 huddle 凭据，再验证 evidence 目录；删除重复目录
  校验。mode 关闭 + 无效路径先 RED 400，后 GREEN 403；huddle 缺失或 bot
  环境缺失 + 无效路径先 RED 400，后 GREEN 503，均未调用 preflight。
- `renewVoiceSession` 只加测试，不改实现。真实临时 DB 分别构造有效未过期
  lease + 错 token、相同 token + NULL expiry；外部断言拒绝回执且整行不变。
  分别只删除对应 JS 守卫，两个 mutant 各 exit 1，准确失败在各自的
  `expect(receipt).toBeUndefined()`；避免 SQL 挡住写入却返回假成功被漏测。
  两次变异后均恢复原始 StateStore 字节。
- RED/GREEN 日志：`/tmp/fly2446-attempt2-default-{red,green}.log`、
  `/tmp/fly2446-attempt2-ladder-{mode,huddle}-{red,green}.log`。
  变异日志 `/tmp/fly2446-attempt2-renew-{token,null}-mutant.log`。
  构建后聚焦 `/tmp/fly2446-attempt2-focused.log`：2 files / 32 tests，exit 0。
- `pnpm lint` exit 0（14 warnings）；`pnpm -r build` exit 0。
  日志 `/tmp/fly2446-attempt2-{lint,build}.log`。
  构建结束后完整 `VITEST_MAX_FORKS=1 pnpm test:packages:run --pool=forks
  --maxWorkers=1 --minWorkers=1` 已启动，日志
  `/tmp/fly2446-attempt2-packages.log`；本段写入时仍在运行，不能称通过。
- `main@e79cdb2d5` 已在当前分支内。Raya `d4e6b13` 冻结，未改 wrapper、plist、
  生产配置。后续仍需唯一一次普通 push、新 ROOT 审查 APPROVED 和新头 CI 14/14。
  旧头审查/CI不替代本轮证据；真语音房与上线验收仍归 QA/班车。

本轮完整门禁最终回执：exit 1；claude-runner 46 文件、1138 passed / 2 skipped，
零失败断言，唯一 unhandled error 为 `[vitest-worker]: Timeout calling "onTaskUpdate"`；
后续包未运行。flywheel-comm 已完成 152 文件、2170 passed / 2 skipped。
日志 `/tmp/fly2446-attempt2-packages.log`，工具 session 86478 已结束。
重新读取 Lead `b5f3a669-2555-4115-9552-823325c48412` 的裁定：此零失败断言 RPC
超时仍为 accepted artifact，允许继续 push/review，不是完整本地绿门禁。

本轮 codex:rescue companion 能力探测（底层 `task --help` 会尝试初始化 thread）
在初始化处 exit 1：fs sandbox helper exit 71 / sandbox_apply Operation not permitted。
未产生审查结论，未绕过沙箱；已报告 `33d8762f-74ae-4c4b-8f7a-f83df4ddff39`。
按 Lead 指令继续正式 ROOT request-review；不得把此探测算作代码审通过。
