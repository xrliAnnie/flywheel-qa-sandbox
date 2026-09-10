# FLY-2465 Codex 舰队自动切号 — 调研
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465/2371-根治-codex-舰队级自动切号限额信号-按最早重置挑号-切-codex-重起被收的体全池打满才发-founder)
日期: 2026-09-09
基于: plan.md

## 设计交付的验证边界

本文件证明文档与HTML交付检查，不证明功能代码或生产切号有效。实现/运行验收仍由plan.md第9节台架执行。

- 正式评审request `79bcf1a8-5c0b-4fa6-a2bb-0f8d69f0f6b6`，gate `afd3b066-d647-46ca-9a9e-86b64a0a1b47`。注册返回accepted=true、skipped=false。
- 本机codex-cli 0.153.2，仅导出JSON Schema及读取help，未执行账号探针。
- HTML 16KB，小于512KB；零外部scripts/styles/fonts，单inline nonce="__CSP_NONCE__"；无自带CSP meta或inline handler。
- Happy DOM实际执行静态脚本：每卡评论输入、localStorage保存/恢复、pathname隔离、localStorage抛异常继续填写、用户HTML字符串仅textContent显示、汇总首行精确marker、长文本含emoji分段≤1800字符、clipboard缺失与promise reject的execCommand fallback均通过。
- 构建脚本只把标题/图源经html.escape插入markup；inline JS为固定文本，不插入derived数据。运行DOM写入用textContent/value和createElement。

## 本地绘图失败（按合同允许的降级）

flow.mmd和model.mmd均执行mmdc并按标准参数重试一次：

```text
mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId FLY-2465-d1|FLY-2465-d2
```

四次均不能启动Chromium，错误为`mach_port_rendezvous.cc: bootstrap_check_in ... Permission denied (1100)`。未调用远程渲染服务。HTML每个图区明确显示`DIAGRAM PENDING LOCAL RENDER`，图源与HTML在同一目录，完整文字流程/数据说明保留；没有用CSS箭头伪造图。已通过Lead报告 `92f073f2-d330-4718-bcf5-3ea79500eb8c` 告知。

这意味着本节点不能声称图已渲染或做过真实浏览器视觉QA。交互逻辑已用DOM运行验证；发布后还须读取托管页确认nonce替换和CSP匹配。

## R1预览托管页检查（不是最终交付）

HTML提交 `96ef561ba` 已推送。使用publish-only成功，reportId `da76b794f1159c4738957ccc2d22b7f6`，没有发送频道消息。

托管URL：https://fw-reports-a53de2.vercel.app/r/da76b794f1159c4738957ccc2d22b7f6/

curl读取实际托管页：HTTP/2 200，`__CSP_NONCE__`残留0，单个script的实际nonce在发布注入的CSP中获授权，意见marker和渲染失败标记仍在。该发布早于有效评审通过，Lead已要求后续只交付最终批准版；旧链接仅作预览证据。早期DESIGN-HTML ready报告回执 `abbb0975-3f96-49e6-b3ef-057c940d4982`。这证明发布与脚本授权检查，不代替真实浏览器交互/视觉QA。

## 原始需求逐项覆盖

| 原始要求 | 设计合同 | 后续直接验收 |
| --- | --- | --- |
| 1 usageLimited与Codex审查429、vendor、生成号去重 | plan §2、§3.1、§6.2、§7；T1/T2/T5 | §9 A/E/G：两入口事件、同代唯一、不同代不串号 |
| 2 最早reset选号、失效token跳过、真probe才切 | plan §4、§5；T3/T4 | §9 B/D/E：排序、原始exec证据、失败live零写 |
| 3 受影响run terminate→start、成功后Lead事件 | plan §6.1、§7；T4/T6 | §9 A/F：真实API/新体工作、拒绝错误目标 |
| 4 全池满一条founder、零盲换 | plan §3.1、§4、§7；T2/T6 | §9 C/H：重启重放后实际消息1、launch无增加 |
| 5 每次尝试审计、STEP2可读 | plan §3、§7；T6 | §9 H：最近switch/失败行、坏记录可见 |
| business故障到六具恢复≤10分钟、零founder | plan §1、§6、§9 A；T7 | 隔离实机时间线、6/6真实新体、sink=0 |
| 不改Claude语义 | plan §1、§6.2、§8；研究consumer辨别 | §9 I原回归组及payload/状态对照 |
| full DOC-FLOW、评审、HTML、发布报告、phase route | 同目录全部文档、评审gate、托管检查、本ledger | 仅在有效APPROVED后执行phase_design_complete与park |


## R1 verdict 与 R2 修复映射

R1 gate `afd3b066-d647-46ca-9a9e-86b64a0a1b47` 的首次审查进程因Bridge更新失败；依Lead指示复用request重试后，2026-09-09 19:15Z有效 verdict 为 CHANGES_REQUESTED。不是APPROVED。R2仅修下面2 HIGH、4 MEDIUM、2 LOW；不实现代码。

| findingKey | R2明确改动 | 后续测试 |
| --- | --- | --- |
| pool-credential-clobber-no-liveness-proof | §5删除outgoing自动回存，原profile零覆盖，隔离证据不可选；承认陈旧存档需维护 | T4/J 身份正确但链失效、pool另有活链；成功/失败均保持旧pool原hash |
| credential-propagation-model-false-copy-fanout | §1.1/T0明确878旧副本事实、FLY-2404生产前置、活跃清点和drained迁移 | J 六进程跨严格刷新权威边界，不能用600秒新生健康替代 |
| provision-copy-outside-install-lock | §1.1/§5.6/T4在目标home检查实际链接/身份/代数；旧快照拒绝 | 选择前的旧provision与切号并发、普通副本零launch |
| patrol-helper-not-in-packaging-surfaces | §7/T6覆盖两套FILES、first adoption、PO_SCRIPT_FILES、packaged audit及Node sanity | converged state/bin与packaged STEP2实际执行 |
| admission-guard-has-no-owning-task | §3.1/T2明确vendor解析位置、不可变reservation、waiter状态、同key重入 | paused Codex=1reservation/1waiter/0launch；Claude不阻塞；取消不启动 |
| review-wrapper-quota-wait-shares-total-budget | §6.2/T5独立quota等待与一次完整重跑预算；75区别124 | fake clock等待1500后执行1200；wait1801=75；exec1801=124 |
| plan-file-paths-wrong | §8表完整路径，真实bridge/plugin、DirectEventSink和profile模块 | 本地rg文件清点；新文件均明确新增 |
| vendored-release-hash-inputs | §8/T5明确installer四组列表、helper全依赖、lib/与flat路径 | helper-only改动改变release hash并执行新版；缺失fail-loud |

Lead instruction `6e2c8b54-fc3a-4b23-812a-175b6ccd1e14`：总计最多3轮；后轮新增非HIGH不扩计划；若R3仍非有效APPROVED则冻结报Lead。最终HTML只在有效APPROVED后publish/report。


## 最终有效设计评审

2026-09-09，R2：**reviewVerdict=APPROVED，reviewerVerdict=APPROVED**。受审设计head `ddb435a0d`；request `4c7be99b-2c05-455d-b173-e7674db5d760`；gate `baae6323-533c-4958-baae-833165d537de`；delivery nonce `9173d4c7-a839-4861-9db1-0280c17461e3`。无阻塞发现。以下3项MEDIUM只记录，不改变批准方案；按Lead范围指示交Lead决定后续，报告回执 `f0d6de92-3a42-4385-a158-8a9be1f1678d`。

### queued-start-202-misreads-as-success（MEDIUM）

New guard-4 returns HTTP 202 CODEX_QUOTA_QUEUED with run/execution ids, but no caller is taught to distinguish it from a successful start

NEW in R2. Guard 4 now returns 「202 `CODEX_QUOTA_QUEUED`+同run/execution/startKey」. 202 is 2xx, and the shape carries the same identifiers a real start returns. Verified callers do not survive this: packages/gemini-agent/src/tools/bridge-client.ts:99 returns `{ ok: res.ok, httpStatus: res.status, ... }`, and registry.ts:113-114 wires `dispatch_runner` straight to POST /api/runs/start — so a Lead's dispatch tool reports ok=true with a runId/executionId for a run that has zero admit and zero physical launch. packages/teamlead/lead-rules-base/runner-reengage-rules.md:32 teaches Leads only the 409 rejection shape, and packages/qa-framework/suites/fly-60-hard-gate.md:112 asserts 「Bridge log POST 200」 + a sessions row with status=running as the success criterion. Failure scenario: a Lead dispatches during a quota pause, its tool returns ok, the Lead tells the founder the runner is up, and nothing exists until recovery lands (or forever, if readiness/probe never recovers). The server-side contract is well specified — the accurate carve-out 「不把202写进永久successful start-response cache」 does make the same-key replay fall through the FLY-1434 gate at runs-route.ts:1728-1737, since `getWorkflowStartResponse` is exactly the condition that gates the `start_attempt_not_current` rejection. What is missing is the caller half: say the body carries `success:false`, or pick a non-2xx status, and list the caller-side updates (bridge-client, Lead rules, qa-framework) in T2's red-side evidence, which today asserts only server state (「1reservation+1waiter+0launch」).

### probe-rotation-strands-candidate-profile（MEDIUM）

The R2 no-write-back rule is asymmetric: after a successful probe that refreshed the chain, every install-abort path discards the rotated credential and leaves the candidate's pool copy holding a consumed refresh token

NEW in R2 (surfaced by the fix for pool-credential-clobber-no-liveness-proof). §5 step 1 already concedes 「探针临时凭据可能刷新，取探针最终版本」, and §4 says 「所有临时文件0600，退出销毁」. Write-back to the candidate profile happens only at step 5. But steps 3-4 define three aborts AFTER a successful probe: manual-switch detected (「撤销本选择」), stale_selection (fingerprint / proof age>90s), and concurrent profile digest change (「取消本次安装，不覆盖新内容」). In all three the isolated home is destroyed with the rotated credential inside, while ~/.codex/profiles/<candidate>/auth.json still holds the pre-rotation refresh token. Per FLY-2404 exploration.md §3.2, Codex refreshes proactively once the JWT exp is within 5 minutes and refresh tokens rotate, so the stranded pool copy then fails with refresh_token_reused and §4's own rule (「读到 invalid_grant/revoked…隔离该号」) quarantines the account until a manual save/login. The outgoing side got an explicit named cost (「代价明确」) precisely because preserving old bytes is safe there; on the candidate side preserving old bytes is what destroys them. Narrow window and it degrades into the documented manual-repair path, so not ship-blocking, but §5 should either persist the probe's final credential before the abort checks or name this cost the way it names the outgoing one.

### paused-waiters-have-no-aging-escalation（MEDIUM）

readiness_failed and repeated probe_failed each emit exactly one Lead diagnostic and zero founder messages, yet both are states in which recovery will never arrive on its own while waiters accumulate indefinitely

NEW in R2 (introduced by the T0 readiness gate plus the guard-4 waiter). §1.1 says a failed readiness check gives 「阻止开启自动切号，Lead 一条诊断」, and §7 says 「禁用自动切号时仍保持quota暂停和Lead诊断，不回落盲换体」, with the founder budget fixed at 0 for everything except pool exhaustion (「一次probe失败：usage_limit仍仅1，Lead可操作诊断仁1，founder0」). Guard 4 abandons a waiter only on 「取消/人工hold/终态」 — there is no age-based transition anywhere in the plan, and §5 keeps the alert latch held (「同 incident 告警 latch 保持；无新证据不反复 exec」). Failure scenario: FLY-2404 migration has not landed on a host, readiness=false, business hits its cap; every subsequent Codex start returns 202 and parks a waiter, the whole Codex lane stalls behind one Lead diagnostic that may already have been read and dismissed, and the founder-visible signal stays 0 because the pool is not exhausted. The fail-closed posture is the right call and is honestly disclosed in §10, but the plan should bound it — e.g. escalate when a pause with no viable recovery path (readiness_failed, or probe_failed with no new evidence) exceeds a stated age or waiter count — rather than leaving 「paused forever」 indistinguishable from 「paused for 90 seconds」.

最终HTML内容同步批准状态；本地评论脚本检查仍通过。实际功能代码、生产切号、真实探针与迁移没有在设计节点执行。Mermaid本地渲染例外由Lead接受，仍明确标待渲染。最终托管回执如下。


## 最终托管与交接证据

最终HTML提交 `c55b17a1a` 已推送（批准方案为 `ddb435a0d`，之后只记录评审状态/交付证据，plan.md未改）。

最终URL：https://fw-reports-a53de2.vercel.app/r/8dc1695cf06ba4e564c124d7ed02e534/

reportId `8dc1695cf06ba4e564c124d7ed02e534`，publishOnly=true，messageId=null。实际GET HTTP/2 200；nonce已替换且匹配注入CSP；精确意见marker、第二轮批准文本和两个真实渲染失败标记均保留，零外部脚本/样式依赖。最终DESIGN-HTML ready报告回执 `14a07034-2f83-40f0-a4c1-34a9b692b641`，明确取代R1预览。

本记录提交推送并更新progress后，执行指定phase_design_complete和park；完成命令的Bridge事件为阶段交接权威。不创建PR、不实施、不merge、不部署，不结束issue级resident goal。
