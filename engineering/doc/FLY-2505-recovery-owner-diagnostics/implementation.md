# FLY-2505 recovery 留因与预算 — 实施验证
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505)
日期: 2026-09-11
基于: plan.md

本文件记录实现期证据。设计期 validation.md 的基线验证不充当本次实现验收。

## 实现范围

- core 统一诊断合同：固定 code/stage，非空安全摘要，受限字段解析；自由文本不能产生 readiness 退款。
- runner 捕获启动、连接、接入和清理失败；确认 child/socket 排空才允许两种 readiness 分类。cleanup 失败保留主因，commit 后结果继续走现有终态 sink。
- StateStore additive 列；reservationSeq 全 execution 单调、旧 episode 升级不重置历史；recovery/mutation purpose 隔离；同 token/revision/序号的失败以 IMMEDIATE 事务结算、固定事件去重、仅退款一次。
- charged 上限 2；readiness 最多 3 次失败且固定 15 分钟，最早重试间隔 30 秒；固定 300 秒 reservation 观察窗口不延长 60 秒 mutation authority。异常时间产生 charged unknown，不授予免费重试；authority deadline 溢出在写入前拒绝。
- 耗尽保存类型、触发边界、实际次数、最后失败引用；workflow Lead outbox 与结算同事务，重试复用首次冻结 payload。无 workflow 绑定的 legacy 路由保持既有行为。
- Heartbeat dead/declareZombie/reapOrphans 读取当前保护证据；handler await 后重新探活或计算最新 heartbeat；最终同步检查 revision/successor。deadline handler 失败最多让渡到固定 deadline+5min，generic fallback 保留诊断及事件引用。
- 演练消费者读取新 codex-recovery source，独立检查同 episode 的 reservation/charged/readiness 证据；新 episode 不修补旧 episode 缺证。workflow attempt 与 recovery reservation 分开解释。公开字段只包含固定 code/stage、计数、类型、事件引用；claim token 和原始诊断不进入 claim 投影。

## 最新验证回执

| 命令 / 范围 | 结果 | 回执 |
|---|---|---|
| pnpm lint | PASS，15 warnings；初轮本单两处格式错误已修复 | fly2505-full-lint-final.log |
| pnpm -r build | PASS，23 workspace projects | fly2505-full-build.log |
| pnpm test:packages:run | **FAIL**：config drift-scan boolean census 5000ms timeout；该包 787 PASS/1 FAIL，pnpm 随即停止，不能称全仓测试通过 | fly2505-full-packages.log |
| 全部 qa-fly-2456-*.test.mjs | **FAIL**：531 PASS/1 FAIL；liveness 临时 socket holder 探测 ETIMEDOUT | fly2505-all-drill-tests.log |
| Lead 授权隔离一次 drift-scan.test.ts | PASS：27 tests，census 518ms | fly2505-isolated-drift.log |
| Lead 授权隔离一次 qa-fly-2456-liveness.test.mjs | **FAIL**：holderError=EPERM，groupState=alive，verdict=unknown；另有宿主 .bashrc zsh 语法在 bash 中报错 | fly2505-isolated-liveness.log |
| 最终 TeamLead 定向组合（下列 9 文件） | PASS：184 tests | fly2505-final-teamlead.log |
| 最终 runner 定向组合（下列 4 文件） | PASS：269 tests | fly2505-final-runner.log |
| 最终 core 诊断合同 | PASS：9 tests | fly2505-final-core.log |

完整原始回执与 SHA-256 manifest 保存在本机私有目录：
`/Users/xiaorongli/.flywheel/artifacts/FLY-2505/implement-validation-20260911/`。
全量红回执保留；隔离绿不将其改写为绿。未新增 scripts/__tests__/*.test.sh。

TeamLead：StateStore.codex-recovery、execution-mutation-lease、codex-session-reown、codex-session-reown-wiring.structure、codex-recovery-context、run-infra-codex-recovery、HeartbeatService.zombie-reconcile、HeartbeatService、crash-reaper。
Runner：CodexTmuxAdapter、codex-daemon-adapter-helpers、codex-daemon-runtime、codex-daemon-goal-runtime。

## 关键负例与持久性

- 60 秒 lease 到期后 70 秒同 token 结算仍可退款；takeover、purpose、revision、successor、commit 竞争阻止旧结果改账；300 秒 reservation 保护到点失效。
- 事务事件插入失败回滚；同 reservation 重复结算读固定 receipt；重复 outbox UID 不重新生成内容，冲突身份失败回滚。
- 文件 DB 关闭重开保持 readiness deadline、cooldown、原预算；legacy schema 添加列后再重开保持数据。
- charged 两次、readiness 三次、跳维护 tick 后 deadline 先到分别按真实触发类型耗尽。
- 迟到 ownership receipt、等待 TURN 时失败、commit 后 reconcile 抛错不形成第二次退款或错误的 precommit 终态。
- recovery 在慢取证期间开始、最后 server probe 期间安装 successor、deadline handler 期间恢复为 alive、handler 抛错后的重探测、orphan handler 后新 heartbeat 均有执行测试。
- v1 多次 readiness 后成功、三种 exhaustion trigger、错误计数/事件引用、缺 receipt、后续 episode 缺证隔离、workflow attempt=2 非 recovery 第二次均有演练消费者测试；legacy fixture 标签保持。

## 操作与验收边界

不修改 pinned plan，不改变已失败历史 session，不调整宿主 shell 配置，不重启服务，不运行生产 DB/slot 重启演练，不合并或部署。additive schema 回滚保留列和审计事件；旧版本忽略新策略，可能保守提前失败，不保证在途 readiness 继续。

Lead instruction fa77aaa6-7645-47d4-b398-89baa9e048dc 授权两个失败文件各隔离一次；已执行并报告。
## 残留与 Lead 裁定

question gate a60e3994-d661-4f2b-9627-b18211c49019 已答复：liveness 隔离红属于宿主/沙箱观测限制（EPERM 探不到 socket holder），本单未改该脚本或宿主配置；保留证据、不再重跑，继续 review/PR，以 exact-head CI 和 QA 为准。同一测试若在 exact-head CI 也红，立即停下原文报告 Lead，不自行修宿主。

隔离红原始路径：`/Users/xiaorongli/.flywheel/artifacts/FLY-2505/implement-validation-20260911/fly2505-isolated-liveness.log`。错误为 `holderError=EPERM`、`groupState=alive`、`holderPids=[]`、`verdict=unknown`。全量同测试曾为 ETIMEDOUT，两份回执均保留。尚无 code-review、PR 或 exact-head CI 回执。

## R1 返工（进行中）

Lead instruction 1c24bd8e-3df0-4880-843a-a164ccdaa13b 指定四条必修；R1 reviewed head 为 2e3db4d471deacd32e7c318e21e8e2c2486541a3，gate d8672ed3-4084-4b63-8e5d-2313c3ee1cd4，effective CHANGES_REQUESTED。其余建议仅归档，不扩展行为。

- quota-preauth-error-identity-erased 已修：保留 dispatch 的 codex_quota_pre_auth_rejected Error.message，同时保留安全 typed recoveryFailure。新增原标识断言 RED（1 failed）；修复后 runtime 47 PASS。重建 runner 后 TeamLead src/codex-quota 选择的 6 文件/68 tests PASS，包含 launch-fail-open 原有两条回归。构建前消费者仍用旧 dist 的失败回执保留。日志 /tmp/fly2505-r1-quota-{red,green,consumer,consumer-green}.log 与 /tmp/fly2505-r1-runner-build.log。
- 待修：revision takeover deadlock、untyped error fallback、dispatch/postcommit resultText。全部完成后同步 main、推送同一最终头并请求 R2；R2 期间冻结。
- Lead 交接提供的真实复现：前任执行 ab8c8dc2-d6f0-4413-b54b-78d3efadb614 在 Bridge 重启后 reown 两败被判死，触发本替换体；来源为 Lead instruction ec4d46f9-a7df-49e0-a4ee-61d8579670ec。本节点未独立读取该生产 session，不能将其作为修后成功证据。

R1 后续必修证据：
- recovery-claim-deadlock-on-revision-bump：39493fecd，真实 StateStore RED 复现旧 token 在 revision=1 永久拒绝；新 claim 的内部接管结算保留旧 reservation 的 charged 记录，旧回调仍不允许跨 revision 退款。StateStore 恢复 31 tests PASS。
- untyped-error-message-dropped：75416f98a，统一 normalize 在已有 fallback 后读取 Error.message 或 string，经同一清洗，永远保持 unknown/charged。core 新用例 RED→10 PASS；重建 core 后 reown/runtime 48 PASS。
- result-text-overwritten-outside-recovery-lane：分类结果 seam 的 dispatch/postcommit 原输出保留用例先 2 RED；修复后完整 adapter 128 PASS，再覆盖缺省共享 hook 的兼容接管回调。诊断替换只用于 recovery precommit；共享 commit hook 优先，旧调用方以 awaited receipt 成功作边界。原“failed owner”测试改为真实 resume 入口，不能用 dispatch 冒充 recovery。

对应原始日志：/tmp/fly2505-r1-revision-{red,green}.log、/tmp/fly2505-r1-untyped-{red,green,consumers}.log、/tmp/fly2505-r1-resulttext-{red,green,final}.log。尚需合 main 后 full gates、R2 与 exact-head CI；本节不声称这些已通过。

## 合 main 后 R1 返工验证

合并提交 706efbf18；StateStore 顶部导入保留两侧。lint 最终 PASS（15 warnings）；pnpm -r build PASS；定向 StateStore/lease/reown/runtime 82 PASS；最终 runner 四文件 272 PASS，含 adapter129、daemon66、goal47、helpers30；core10 PASS。

pnpm test:packages:run **FAIL**：runner 1282 PASS/1 FAIL/2 skipped，另有 Vitest worker onTaskUpdate 超时。唯一断言失败为本分支早期将 spawn-identity failure 测试期望改成通用 unknown 文案；本轮恢复真实原因后该期望陈旧，已改为同时断言 message=session identity persist failed 与 recoveryFailure.code=owner_failed_unknown。最终 runner272 定向绿，不把全量回执改写为绿；后续包未获得这次全量通过证明，以 exact-head CI 为最终依据。未新增 shell 测试；不重跑 Lead 已裁定的宿主 liveness。

原始回执与 R1 判决已复制到 /Users/xiaorongli/.flywheel/artifacts/FLY-2505/implement-r1-rework-20260911/，SHA256SUMS 固定字节校验。R2/exact-head CI 和 QA 尚待完成。

## R3 前返工（Lead 五项 MEDIUM 必修）

Lead instruction 7eca0f29-6ed8-4d9f-b633-be04c3c82654 禁止在 R2 APPROVED 后直接交接，要求五项 RED/GREEN。原头 ed5c431f2 的 CI run34576601341 全绿仅属于旧头；不替代本轮检查。

- legacy-summary-drops-uuid-and-snake-case：UUID 替换为 [id] 后检测 opaque blob；关键词按下划线/连字符分词。三个实际错误 RED，core14 GREEN，仍不授予 readiness 退款。
- reown-abort-reason-dropped：capabilities/recycle 六种原因转换为可读诊断并标 context/teardown；六例 RED，reown46 GREEN，原误标 preflight 断言同步修正。
- daemon-spawn-original-message-lost-on-dispatch：普通 Error.message 保留早退、spawn error、socket deadline 原因，结构化 recoveryFailure 仍用固定安全合同。三个 RED，daemon runtime66 GREEN；安全断言检查 code 而非通用文案。
- precommit-settlement-claim-lost-is-silent：一次安全 stale/nonaccounting 观察，保留 failure/episode/reservation，不能改账；RED→reown47 GREEN。
- finalize-exhaustion-throws-inside-claim-transaction：逐候选隔离 RED→reown48 GREEN；active run 消除历史 binding 假歧义，告警路由不依赖已清空的 node.execution_id，真实 StateStore RED→32 GREEN。settlement throw 在事务外保留原诊断及安全结算错误，不改变回滚/退款规则，RED→reown49 GREEN。TeamLead typecheck PASS。

Lead question 28b43e75-ba2f-4657-b830-0c38968e750c 已确认：耗尽事件+必要 Lead outbox 同事务不变，真实 UID 冲突/DB 写失败仍回滚；不得跳过告警直接结算；修 active binding/identity 假抛错、事务外观察和逐候选隔离满足该项。

本轮回执在 /tmp/fly2505-r3-*.log，最终聚合前将复制归档。还需全仓门、最终头 R3（上限）、新 exact-head CI 与 needs_review 完成路由；未合并/部署/重启。

## R3 提交前最终回执

- pnpm lint 最终 PASS（15 warnings）；初轮 noImplicitAnyLet 已补明确 ReturnType。
- pnpm -r build PASS；TeamLead typecheck PASS。
- pnpm test:packages:run **FAIL**：runner 50 文件/1283 tests PASS、2 skipped，但 Vitest worker Timeout calling onTaskUpdate 导致非零退出，pnpm 未继续后续包。无失败断言，不将该全量命令记成绿。
- 最终 TeamLead 计划九文件组合 195 PASS；演练 observe/report-pair/verdict 三消费者 89 PASS；core14 与 daemon runtime66 的 RED/GREEN 见前节。未新增 shell 测试；未重跑宿主 liveness。

所有 /tmp/fly2505-r3-*.log 原始字节复制到 /Users/xiaorongli/.flywheel/artifacts/FLY-2505/implement-r3-validation-20260911/，含 SHA256SUMS。R3 与新 exact-head CI 尚待运行；原 R2/旧头 CI 不充当本轮证明。
