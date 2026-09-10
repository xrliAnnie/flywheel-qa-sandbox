# FLY-2455 529 房启动诊断 — 实施计划
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-08
基于: research.md

## 目标与执行合同

恢复干净 main 的真实 529 起房、Lead 收件与干净拆房，并让下次启动失败直接点名具体项。**只改善错误信息或 `--no-lead` 不算完成。**

Lead 已通过 question `c80a599e-0a9f-464b-80fe-d85c2fa17c75` 明确接受本计划顺序：本 design 不起拆；先实现诊断与真实 body 输出/退出证据；FLY-2454 隔离门通过后重跑并写 `root-cause.md`；根因修复在动代码前再过一次增量设计评审。最早 body 退出细节不属于本 design 的必得证据，不可冒称已解决。

按当前 DAG 的 implement/QA TURN 执行，不自行派发节点。每批执行 RED → 最小实现 → GREEN → 提交并更新本目录 progress。对不匹配的预期先归因，不靠放宽 readiness、跳过 identity 或延长超时消除失败。

技术栈：Bash 3.2、jq、现有 Python3、launchd、tmux。launchd 是 macOS 的服务管理器；tmux 是托管 Lead 终端会话的程序。没有 DB schema 或公开 CLI 迁移。

## C1：结构化失败快照，成功合同不变

文件：修改 `scripts/lib/qa-launchd-lead.sh`、`scripts/test-deploy.sh`；新增 `scripts/lib/qa-lead-diagnostics.py` 与 `scripts/__tests__/qa-lead-diagnostics.test.mjs`；扩展 `scripts/__tests__/fly1663-qa-launchd.test.sh`、`test-deploy-fly1389.test.sh`、`ci-shell-suite-enumeration.test.sh` 和 `.github/workflows/ci.yml`。

- [ ] RED：执行真实 verifier 的 fixture，分别制造 manifest 不存在、非法 JSON、缺 pid/socket、PID 不一致、PID 相等但 tmux 非零，断言 stdout 为空、exit 非零且 stderr 明确区分原因。原代码至少在非法/缺失 manifest 区分与 socket probe 原因上失败。
- [ ] 成功控制仍逐字为 `17981\t/socket/path\n`，不得向 stdout 添加提示；主/extra 的外层五列 TSV 及最终 deploy JSON 均保持不变。
- [ ] 在现有 60×1 秒循环之外，只在最终失败处执行一次快照。明确修改 `fly1663-qa-launchd.test.sh:690-701` 的旧总计零 print 断言为“循环内零 print、退出循环后恰好一次诊断 print”；用 sleep/stub 调用序列区分两个阶段。此处是经设计批准的诊断增量，仍禁止恢复 10Hz 探测。正常成功路径不调用 Python 诊断器。
- [ ] verifier 向诊断 helper 传结构化参数：label、manifest、调用点持有的 plist/log 路径、最后一次成功解析的 PID/socket、实际探测 tmux 绝对路径。新增参数只可选追加；旧两参数调用仍有效；两处主/extra 复用调用传完整上下文。
- [ ] Python helper 用 argv 数组运行有 timeout 的探测（每项最多 2 秒，总计最多 8 秒）；不 eval、不开 shell，不重试启动/停止。调用点先将 `${FLYWHEEL_QA_LAUNCHCTL:-launchctl}` 解析成绝对路径，连同 `qa_launchd_domain` 结果作为 argv 传给 helper；helper 不自行调用 bare launchctl，缺失 stub 不得回落真系统工具。一次 read-only print 获取任务状态、PID、last exit，按字段白名单解析。先区分“job not found”与“探测工具失败”，不能把权限错误当 job 不存在。
- [ ] 读取 plist 只验证 Label 与 ProgramArguments 的 wrapper/manifest 指针；EnvironmentVariables 永不出现在输出。manifest 只读取类型合格的 leadId/projectName/pid/socketPath。缺失、格式错、任务/指针失配分别保留，不由最后一项覆盖。
- [ ] tmux 使用当前 verifier 实际解析的绝对路径，记录 realpath/version、socket 是否存在、`has-session -t '=main'` 的 return code 和安全分类。stderr 先限长，在内存归类为 `protocol_mismatch`、`socket_unavailable`、`session_missing`、`probe_unavailable` 或 `unknown`；公开快照不透传原文。

快照 v1 合同（字段为示例；不把 PID/socket 快照当清理权威）：

```json
{
  "schemaVersion": 1,
  "phase": "topology",
  "reason": "session_probe_failed",
  "label": "com.flywheel.qa.lead.slot-2.flywheel-test-2",
  "manifest": "/tmp/flywheel-test-slot-2/launchd/flywheel-test-2/manifest.json",
  "manifestState": "runtime_published",
  "launchd": {"state": "running", "pid": 17981, "lastExitCode": null},
  "runtime": {"pid": 17981, "socketPath": "/tmp/slot-socket"},
  "probe": {"binary": "/opt/homebrew/bin/tmux", "version": "tmux 3.7c", "exitCode": 1, "kind": "socket_unavailable"},
  "body": {"state": "unknown", "exitCode": null},
  "observedAt": "2026-09-09T00:00:00.000Z",
  "observationKind": "post_failure_reprobe",
  "lastLoopObservation": {"launchPid": 17981, "manifestPid": 17981, "probeExitCode": 1}
}
```

稳定 reason 集合由 helper 单独定义：`manifest_missing`、`manifest_invalid`、`runtime_unpublished`、`plist_mismatch`、`launchd_job_missing`、`launchd_pid_missing`、`pid_mismatch`、`session_probe_failed`、`probe_unavailable`。保留 `checks` 数组列出同时发现的项；reason 依上述次序选最早可证实失败，证据不够用 unknown，不臆断“body crashed”。中文显示标签只用于报告，不参与机器判断。

`launchd/runtime/probe` 是 failure 后重新采样，必须带独立 observedAt；循环内部最后一次的 PID/socket/probe rc 与时刻另存在 lastLoopObservation。两者 generation 不同则显式 `generationChanged=true`，不能拼成一个原子现场；未能记录循环值时置 null。C3 以对应 generation 的原始捕获为主因证据，post-failure probe 只辅助。

- [ ] 原子写 mode 0600 的 `topology-failure.json` 到经过验证的 manifest 同目录，在 stderr 打一条短文本：`phase/reason/label/plist/manifest/launchPid/manifestPid/socket/probeKind/evidencePath`。拒绝控制字符；不打印环境、token、pane 正文。诊断写失败仍输出短 `diagnostic_write_failed`，保留原失败退出码。
- [ ] `qa_slot_start_lead` 必须先快照，再调用现有 exact-label stop；外层错误包含 phase 与证据路径，不再只有 bootstrap failed。bootstrap 本身失败时同样写 phase=bootstrap 的配置/label 诊断，不编造 topology 通过。
- [ ] GREEN：新测试完整通过；已有低频等待、成功 stdout、额外 Lead、Codex 分支、超时退出测试通过；补 malformed path/newline/symlink、工具缺失/超时、凭据 canary 的负例。
- [ ] CI 明确加入 `node --test scripts/__tests__/qa-lead-diagnostics.test.mjs`。同步扩展 `ci-shell-suite-enumeration.test.sh` 的 .mjs 枚举范围到 `qa-lead-*.test.mjs`，并断言删掉 CI 那行时枚举门 RED、恢复后 GREEN；不能靠现有只检查 qa-generalized 族的门宣称已收集。

## C2：在真实正文执行前固定输出与退出证据

文件：修改 `scripts/flywheel-lead-wrapper-v2.sh`、`packages/teamlead/scripts/lead-body.sh`、`packages/teamlead/scripts/claude-lead.sh`、`packages/teamlead/scripts/lead-rules-bundle.sh`、`scripts/lib/qa-launchd-lead.sh`、`scripts/lib/qa-multilead.sh`、`scripts/lib/qa-lead-diagnostics.py`、`scripts/test-deploy.sh` 的失败/认领路径和 `scripts/test-teardown.sh` 的诊断 residue 门；扩展 `scripts/__tests__/fly1663-lead-v2-runtime.test.sh`、`fly1697-v2-lease-body.test.sh`、`fly1663-qa-launchd.test.sh`、`fly1663-qa-launchd-mutants.test.sh` 及其 `fixtures/fly2301/claude-lead.plist` 预期，以及 `packages/teamlead/scripts/__tests__/fly1402-single-bundle.test.sh` 和 `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`。

- [ ] RED：真实 wrapper + 立即打印 `FLY2455_BODY_FAILURE_CANARY` 后 exit 42 的 fixture body；证明即使 main pane 瞬间消失，也留有该次退出 42 和捕获的输出。不得用 stub wrapper 人工发布 manifest 代替此测试。另有存活 body 控制证明 stdout 仍连终端、PID 拓扑不变。
- [ ] 新增唯一 QA opt-in `FLYWHEEL_QA_LEAD_DIAGNOSTICS_DIR`，只由 QA plist trusted env 注入，值是 manifest 所在的 `launchd/<leadId>`。默认 unset 时生产 wrapper/body 字节行为不变；不让 manifest.launchEnvironment 重写此受信入口。
- [ ] wrapper 在 source env/处理 manifest 前保存此 trusted 值，随后清除来源可变副本；将变量名加进 manifest env 的 `identity_launch_env_conflict` 禁止分支。在完整路径校验后，显式追加到 `SERVER_ENV` 一次，使值越过末尾 `env -i` 到 `--publish-and-start`/body；保持六个 argv 的原合同，不增加第七参。以环境 canary 验证 trusted plist 值到达 body、恶意 manifest 同名项被拒、unset 不产生该变量。
- [ ] 在 wrapper 读取此值后、任何文件写入前校验：绝对路径、无控制字符、非 symlink 目录、owner 当前 uid、mode 0700、realpath 等于 manifest 父目录；父目录须属于本次 `test-slot-N` 的 `/private/tmp/flywheel-test-slot-N/launchd/<leadId>`，项目与 agent 取 canonical identity。额外 Lead 以 host project 的 N 和自身 leadId 校验，不能错误用 borrowed slot N。
- [ ] 在 `--publish-and-start` 进入真实 body 前，用同一个绝对 tmux 二进制对本私有 socket/当前 pane 安装 `pipe-pane -o` recorder，再发布/进入 body。pipe recorder 仅复制终端输出，不把正文 stdout/stderr 改成管道，不新增 parent wait shell，不改 `exec /bin/bash lead-body.sh` 的 PID 关系。
- [ ] recorder 是 Python helper 的 `record` 模式，argv 与管道命令的路径用既有 Bash `%q` 正确转义；创建私有 `body-output.log`，单次部署总保留上限 256 KiB，达到上限仍继续 drain、停止保存并写 truncated 标记，防止阻塞正文或磁盘无界增长。原始输出只在 mode 0600 的 slot 文件里，绝不 tail 到共享 stderr、提交或 HTML；QA 选取必要行后人工净化。
- [ ] wrapper 的 `--publish-and-start` 用已经传入的绝对 tmux `$5` 写 carrierTmux 的 binary/realpath/version/architecture 和 carrierPid；body-status 合并这些字段，不再丢掉 server 端证据。记录调用点 resolved binary，不能事后从 PATH 推导。helper 失败只记 probe_unavailable，不运行替代版本。
- [ ] wrapper/body 通过同一 helper 原子合并 `body-status.json`：schemaVersion、carrierPid、carrierTmux、bodyPid、startedAt、endedAt、exitCode、exitObservation、claudeExitCode、observedShellExitCode。body 入口在可能早退的配置读取前写 started；只有受信 QA 路径验证通过并实际安装 `trap '_v2_body_exit "$?"' EXIT` 后，私有 `_V2_BODY_EXIT_TRAP_ACTIVE` 才为 1。所有外部入口初始化此状态为 0，不导出、不采信继承环境或函数名；同 shell source 的内部移交须保留实际安装状态，host .env 不得覆盖。诊断 OFF 或安装失败保持 0。测试必须注入同名 ambient flag、仅定义同名函数，确认都不能绕过生产清理。
- [ ] **统一两处 EXIT 所有权判据**：`lead-body.sh:107` source `claude-lead.sh`；`:3018` 的 bundle/non-dry-run trap 安装处和 `lead-rules-bundle.sh:314-324` 的 `_rules_bundle_commit_once` 清除处，都只按 `${_V2_BODY_EXIT_TRAP_ACTIVE:-0} = 1` 判断。开启时，前者仅登记 `_V2_RULES_CLEANUP_READY=1`，后者保留复合 EXIT trap，照常写 receipt、设 `_RULES_BUNDLE_COMMITTED=1` 和清旧 generation；关闭时，两处的原 install/clear 行为逐字保留。ready 只在原本会安装 bundle trap 的位置登记，不能让 dry-run 删除原本刻意保留的 bundle。`:3006/:3012` 的显式失败清理保持不变。
- [ ] 将返回型、幂等的 `_v2_body_finalize` 与退出型 `_v2_body_exit` 分开：后者立即保存原 rc、防递归、调用前者并用原 rc 退出。finalize 只在 ready=1 时执行原 `_rules_bundle_uncommitted_cleanup`；已 committed 时原函数自然无动作。清理和诊断写入各自局部捕获失败，不改变全局 errexit，不覆盖主退出码。绝不从通用 EXIT 回调调用已有 signal cleanup；原 INT/TERM 子进程与 poller 清理保留，两个信号目前都退出 143。
- [ ] **关闭私有 server 前先记录结果**：`claude-lead.sh:3385-3387` 先保存 `_v2_exit="$CLAUDE_EXIT"` 再 `tmux kill-server`，后者可能先终止 shell。因此在该 kill 前，诊断开启时显式调用 finalize，记录 `claudeExitCode` 与 `exitCode=_v2_exit`、`exitObservation=pre_server_stop`、endedAt；这里的 exitCode 是已决定的正文返回结果，`observedShellExitCode` 必须仍为 null。若 EXIT 随后发生，只补实际 shell rc/观测时刻，不覆写先前结果、不重复清理/生成终态；若提前失败仅走 EXIT，则 `exitObservation=shell_exit`、exitCode 与 observedShellExitCode 为保存的 rc，尚未运行 Claude 时 claudeExitCode=null。SIGKILL 且未到任一记录点只留 started/unknown，不能把 tmux 中断状态 143 冒称 Claude 返回 143。正常路径既有 receipt 和 server 停止顺序、PID 关系均保留。
- [ ] 除 stub body 快速退出测试，再扩展 `fly1697-v2-lease-body.test.sh`：真 source `lead-body.sh → claude-lead.sh → lead-rules-bundle.sh`，临时 HOME/状态/项目和受控外部命令、Claude child stub，**bundle 模式且非 dry-run**，经过真实 commit_once 主线。覆盖 materialize 前失败、显式 materialize/sentinel 失败、清理登记后 transport 拒绝、receipt commit 失败、child 42/0/TERM/INT、recorder/cleanup 写失败。断言清理语义、原始 rc、捕获正文、诊断字段；mock kill-server 必须在被调用时就看见已记录的结果；显式 finalize 后再 EXIT 只产生一个结果，实际 shell 状态单独补记。只有 dry-run 或 legacy fixture 不能作为该回归主证据。
- [ ] 增加明确 OFF×bundle 生命周期控制：异常退出前未 committed 的 bundle 被删，成功 commit 后原 EXIT trap 被摘除且 active bundle 保留。ON×成功 commit 则复合 trap 仍在、active bundle 保留；ON/OFF×legacy/dry-run 保持旧有保留语义。`fly1402-single-bundle.test.sh` 直接测真实 helper 的两种 ownership 分支，TeamLead 单 worker 测试保护 receipt/cleanup 合同。
- [ ] status 与输出按 carrier PID 关联，快照只有匹配 manifest/当前 launchd 代才引用 body 结论。重启时新 generation 的 started 原子覆盖 status；保留输出中的 generation 边界。旧记录只能展示 stale，不能据此判本次失败。仅 label registry 仍拥有清理权。
- [ ] recorder/helper 不存在或安装失败应产生明确 `diagnostic_capture_failed`，不能谎称捕获成功；正常生产 opt-out 不依赖新增 helper。诊断器只采证、不重启、不阻止真实退出。
- [ ] GREEN：立即退出/正常运行/信号退出/未开启诊断/路径恶意输入/两 Lead/旧 generation/满额输出/写失败均通过。核对 tuple、窗口、进程父子关系和 `%0` 退出导致私有 server 退出的现有行为。
- [ ] **敏感输出 residue 门**：失败部署保留目录不等于允许释放所有权。停止 recorder/对应 Lead 后，若存在未处置 body-output.log，保留本 slot 与 campaign 的锁并写非数字标记 `diagnostic-evidence-pending`。以一个共用 evidence-residue 检查结果约束所有释放点，文件不存在且 recorder 已退出才可放行；未能读取/确认按 pending 处理。只增加本 slot 证据的所有权状态，不扩大任何停止进程范围，不修改 FLY-2454 的进程隔离算法。
- [ ] **逐个覆盖释放/再认领消费者**：`test-deploy.sh` 的 `cleanup_on_failure` 中 generalized 分支 `:588`、ordinary claiming 分支 `:620`、borrowed locks `:636` 都先过 residue 门；显式提前释放的 Lead readiness 失败 `:1767`、Bridge died `:2194`、Bridge timeout `:2208` 同样过门或收敛到同一失败释放 helper。不能让外层 EXIT 因锁已删而无法补记 pending。实现前用 rg 复查全部锁删除调用，列明哪些发生在 Lead/capture 创建前、无需该新增检查。
- [ ] `claim_slot` 与 `scripts/lib/qa-multilead.sh:322-360` 的 `qa_multilead_claim_one` 在 stale/dead-PID 分支之前明确拒绝 `diagnostic-evidence-pending`，延用 cycle-failed 的拒绝方式；不能把非数字 marker 当死 PID 自动 reclaim。extra Lead 原始文件仍属于 host slot runtime，检查必须包含所有已登记 Lead，borrowed locks 的 owner 元数据保留，指向同一个负责处置的 host，不能到 borrowed slot 目录找错证据。
- [ ] QA 在退出本轮前通过 helper `discard --runtime <validated-runtime>` 删除原始输出，或先将必要片段净化写入本单证据再 discard；默认 teardown 执行同一 discard，确认 recorder 已结束、文件确实不存在后才清锁。若取证必须暂留，向 Lead 报该 exact slot 的 evidence-pending 与清理责任，不能报“拆干净”。snapshot/status 等不含正文的白名单记录可保留；不存在无人负责的“清理完成但原始输出留在 /tmp”。
- [ ] fixture 逐项覆盖 generalized/ordinary/borrowed/Lead readiness/Bridge died/Bridge timeout/teardown 中断与删除失败；有 canary 输出时锁不可消失、主/extra 再认领均拒绝，安全 discard 后才可释放。同时有无 diagnostics 和无 residue 控制，保持原释放条件；stderr/公开 JSON/已清理目录均无 canary。沿用进程隔离现有或 FLY-2454 已合入的 helper，不复制或改写它的权限。

## C3：隔离门通过后复现并冻结根因

负责人为后续持 TURN 的 implement/QA；本 design 不执行。

- [ ] 首先取得 **FLY-2454 已落地且对应起拆全路径隔离测试通过**的证据（不是仅 issue 状态）。核对 stale reclaim、失败 trap、normal teardown、extra-lead 清理均只允许 slot 进程；未通过就向 Lead 注册待办，继续 C1/C2 hermetic 工作，禁止真机起拆。
- [ ] 记录干净 main SHA、完整参数、OS、两端 tmux 绝对路径/版本/架构、slot registry 与时间。从最新 main 创建一次性干净 checkout 并完成 build identity 校验；原始基线不含 FLY-2455 行为修改。有占用的 slot 不抢占；原参数的 2/3 组合不可用时与 Lead 选等价空闲组合并明确差异。
- [ ] 重现原命令 `TMPDIR=/tmp/q7 bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test`；另外在加入诊断的 head 使用完全相同参数重现；`--expect-head "$(git rev-parse HEAD)"` 核对构建来源。配套隔离修复已改变 baseline 时记录其 SHA，不冒称历史字节。
- [ ] 在清理前将 mode 0600 原始证据保存到本单 QA artifact 区（SQLite 如需备份用 online backup，不直接 cp 活库）；报告只提交净化摘录、命令、时间和 SHA-256。分别记录总耗时、Lead 启动段、Bridge ready 段、拆除段。
- [ ] 根据同一次 snapshot 判断 H1/H2：若协议错，核对实际探测客户端与 server；若 body exit，读取该 generation 原始输出的最早失败行；若二者都不成立，记录新原因。不得按错误末尾猜测。
- [ ] 写 `root-cause.md`：精确失败项、生产源码位置、同一变量 A/B、最小修复文件/代码/测试、对 FLY-2174 两项的排除、与 FLY-1948 同源与否、回滚边界。**此文档和新补充方案必须先过一次新的 design request-review，有效 APPROVED 后才能写根因修复代码。**

允许的最小修复方向仅是证据的结果：客户端漂移则统一 QA Claude 启动/verify/dev-prompt 的实际 tmux authority，并保护 Codex；正文早退则修具体已证实的输入或依赖来源，保留 identity、插件与模型校验。若触及生产启动策略、非 slot 清理或独立 Discord 漏洞，交 Lead 定界，不能直接扩入本单。

## C4：根因修复与整条链验收，不以诊断收尾

- [ ] 在 C3 增量方案指定的真实边界先写 RED，最小修复后 GREEN。每个新增行为有对应证据，不能先更新 stub 期待再称修复。
- [ ] 从最新 main 干净整合的最终 head 启动完整 slot：`TMPDIR=/tmp/q7 bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test --expect-head "$(git rev-parse HEAD)"`。再跑 QA 常用 `--alerts` 变体以保护旧修复；普通/extra 均须实际在线。若只需单 Lead 的新增根因 case，仍不能省原两 Lead 参数回归。
- [ ] 保存真实 HTTP status 200 和 `/health` 的 buildSha/artifactBuildSha，必须匹配该次 head；独立核对每个已注册 Lead 的 label、manifest PID/socket 与 live lease（Claude）或 heartbeat/TUI（Codex 回归适用时）。不能只采存在但失效的 lease 文件。
- [ ] **先确认发送身份和权限**：当前 2/3 组合使用 slot 3 bot `1493075160025272452`（凭据选择器 `TEST_BOT_TOKEN_3`）向 slot 2 频道 `1493080993173737583` 的 bot `1493072948683341976` 发送；反向检查使用 slot 2 bot 向 slot 3 频道 `1493080995862413439`。执行时从 `test-slots.json` 重新解析并记录配置摘要，值漂移需重新核对，显示名不当身份。对实际目标频道做 POST 唯一权限探针再 DELETE 自己的探针、GET 确认目标 bot 身份；不能拿 alertChannel 的 preflight 代替。还须核对目标 access 的 allowBots 包含该 sender。若 403、未邀请或 allowBots 不含它，向 Lead 报“发送前置条件未满足”，由 Lead 协调 slot 权限，不自行扩权，不用 founder 本人账号发送，不把该情况诊断成 Lead 启动故障。
- [ ] 上述 slot bot 前置通过后，发唯一 `FLY-2455-<attempt>-<nonce>` 标记并 @ 目标 bot；保存 Discord message ID 与实际 Lead 收到/回应同一 nonce 的证据、时刻和消费记录。不向生产频道投递，不改 access allowlist 让测试通过。只有 REST POST 成功不足以证明收件。
- [ ] 若能起房但收件仍失败，比较启动失败项：同一断点就在本单修并重测；独立 Discord 通道问题向 Lead 报回 FLY-1948，记录未满足项，不虚称本单收件验收已过。由 Lead 按依赖协调补证，不扩大本单为 Discord 重构。
- [ ] 运行 `bash scripts/test-teardown.sh 2`（前提 C3 隔离证据已过）。确认 registry 每一 exact label absent、对应进程 generation 已退出、slot 端口关闭、socket/slot state/锁按合同清理；对照清理前的非 slot 进程 PID+start-time 仍存活。不能靠全局 pkill/kill-server 或删共享 state “清干净”。
- [ ] 保存完整起/拆命令、起止 UTC 与 elapsed seconds；失败路径明确具体 reason/label/path。完成一次正常起/拆和一次受控失败路径（fixture 中注入失效项，真机不故意破坏宿主）。

## C5：回归、集成与报告

实现节点先运行：

```sh
node --test scripts/__tests__/qa-lead-diagnostics.test.mjs
bash scripts/__tests__/fly1663-qa-launchd.test.sh
bash scripts/__tests__/fly1663-qa-launchd-mutants.test.sh
bash scripts/__tests__/fly1663-lead-v2-runtime.test.sh
bash scripts/__tests__/fly1726-lead-identity-wrapper.test.sh
bash scripts/__tests__/fly1697-v2-lease-body.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash packages/teamlead/scripts/__tests__/fly1402-single-bundle.test.sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/lead-rules-bundle.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
pnpm lint
pnpm -r build
pnpm --filter './packages/*' --filter '!flywheel-core' --filter '!flywheel-release-contract' test:run --pool=forks --maxWorkers=1 --no-file-parallelism
pnpm --filter flywheel-core exec vitest run --passWithNoTests --pool=forks --maxWorkers=1 --no-file-parallelism --exclude '**/tmux-viewer.macos.test.ts'
pnpm --filter flywheel-release-contract test:run
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
```

禁止裸 `pnpm test:packages:run`：它会收集 macOS 上真实打开 Terminal.app 的 `tmux-viewer.macos.test.ts`。使用上述按 runner 分组的命令：Vitest 包单 worker forks；`flywheel-release-contract` 的 Node test runner 单列原 test:run 命令，明确报告仅排除该真实 GUI 用例；核对各 test:run 脚本接受传参，不接受 Vitest 参数的包按其原命令单独执行，不能把参数错误当环境失败。检查当前 CI scripts 分片与受影响 TeamLead tests，test:run 不等于未配置该脚本包的全覆盖。按最终改动补受影响 TeamLead 显式测试，同样固定单 worker。失败给出同一命令的 main 对照，不能把环境失败写成绿。最终 PR 的 HEAD、mergeability 和 CI rollup 必须重新读取；新增提交后旧 CI 不算 exact-head 证据。

报告沿项目 ship report 骨架，**零表格**，至少说明：问题与最终行为、根因与修复、改动边界、版本/commit/PR、真实起拆与消息证据、起拆耗时、测试与 exact-head CI、FLY-1948/2454 依赖状态、回滚。最终合并仍由 ship workflow，部署仍由独立 updater；本 design 和本计划不授予 merge/restart 权限。

## 数据持久化、迁移与回滚

沿用 label `com.flywheel.qa.lead.slot-<carrier-slot>.<agent>`、manifest、registry、成功 TSV/JSON；无身份/显示名迁移，无 DB schema。新诊断文件仅是 slot 内可选证据，旧 slot 无文件时读者必须 unknown，不自动改写/重启。schemaVersion 不识别时拒绝把诊断当有效证据，原始启动失败仍保留。

诊断代码可回退并移除 QA plist opt-in；不能因此改变 slot 启动主体或全局生产门。根因修复回滚方案由 C3 按真实原因给出，经同一增量评审；不能预先授权回滚 FLY-2454 隔离或放宽 identity。回滚前先由当前 slot owner 处置 evidence-pending 原始输出，不能回退 residue 门后留下无人管理的敏感文件。

## Design 节点交付检查

- [ ] exploration/research/plan 以及图解 HTML 同目录，Mermaid 本地渲染，所有卡片可本地批注与汇总复制。
- [ ] design review 有效 APPROVED；提交并 push；progress 记录 gate ID、评审结论与根因捕获尚待 C3 的事实。
- [ ] publish-report --publish-only；验证托管页并向 Lead 报 DESIGN-HTML ready URL。
- [ ] complete --route phase_design_complete，再 park。保持当前 goal 为 phase keep-alive，直到 issue-terminal 指令；不自行派发 implement/QA。
