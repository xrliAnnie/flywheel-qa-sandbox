# FLY-1942 通信层防线三件套 — 实施记录
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: plan.md

实施依据：v5；设计批准记录 `.flywheel/runs/7b4efd03-d28a-4263-b8bd-eff580ce5ba0/codex/design-review.json`，Lead acceptance `3a7f34d5-81f3-45bb-a3dc-c751495d80d5`。开局顺序确认 `a22ada50-f16b-47ec-8130-12ea2062b603`：C1→C2→C3，C4 优先并行，随后 C5→C6→C7；评审期间不推提交、只修 blocking、最多 R3 后交 Lead 裁定。

## 已完成分块

- C1：StateStore 三态、队列区分 `recipient_missing` / `recipient_terminal`，旧 alias 仅在队列边界兼容。共用 terminal predicate 下沉到 flywheel-comm。RED：新 terminal/missing 队列用例仍 QUEUED；StateStore 返回旧 alias。GREEN：comm 57 项、TeamLead 127 项；TeamLead build 通过。提交 `f3d2206a2`。
- C2：send/respond 在入队前校验 durable lineage 与 StateStore；唯一前缀展开、未知/歧义/终态显式错误；stdout 单行 ID、stderr 核验提示、JSON 元数据；gate/engine 问题保留回答合同；公共消息规则加入全 ID 与后验 ACK。RED：send 对无效/终态收件人仍成功、respond 仍写终态回复、CLI exit/hints 不符。GREEN：11 个 comm 测试文件 229 项（包含 CLI 59 项、turn-wait 回归）、真实 StateStore+CommDB+RunnerMailboxLane 3 项、公共规则 26 项。comm 和 TeamLead build 通过。日志 `/tmp/fly1942-c2-aggregate.log`、`/tmp/fly1942-cli-green.log`、`/tmp/fly1942-rules-green.log`、`/tmp/fly1942-c2-teamlead-build.log`。
- C4：见 `c4-evidence.md`；313 项护栏、11 项临时安装器测试、62 块 FLY-2456 路书扫描与 dry-run。提交 `5a6362212`。

- C3：引擎 liveness gate、land/account-switch 接线与通知按 sender 回落完成。writer 33 项；队列 44 项；合并 TeamLead 5 文件 85 项；TeamLead build 通过。writer 证据见 `c3-writer-evidence.md`，fallback RED 为预期两条通知实际零条；GREEN 日志 `/tmp/fly1942-fallback-green2.log`、`/tmp/fly1942-c3-aggregate.log`、`/tmp/fly1942-c3-teamlead-build.log`。两位 Lead 的内容和窗口隔离，非 Lead sender 不回落，owning Lead 优先。

## 调用方与边界

send 直接用例清单：commands、send-mailbox、declare-state、lead-lease-enforce、fly2278-mailbox-cancel；respond 直接用例：commands、respond-mailbox、respond.gate、lead-lease-enforce、verify-approval。对应成功路径伪 ID 改为已注册 UUID；未知收件人旧成功用例改为拒收零行断言。测试 helper 的角色标签与 execution ID 是不同域。run-dispatcher 两条实际 preregistration 调用位于 `run-dispatcher.ts` 的 launch/relaunch 路径。

真实文件串联测试证明 CommDB=completed + StateStore=awaiting_review 仍被 claim 为 LEASED；StateStore=completed 时 CLI 拒收，绕过 CLI 后 lane DEAD；StateStore 不可读时 CLI 告警放行，lane 仍以实际终态作最终处置。

## 未完成

C5 订阅治理已交付（见下节）；C6 env 已交付（c6-evidence.md）；C7 fork 本地实现与测试已完成（c7-client-evidence.md、c7-integration-evidence.md），PR 尚未创建。全仓 lint/build/test、完整代码评审、PR 与 implement completion 尚未完成。以上聚焦测试不代表全仓或生产验收。

Codex Lead 订阅的生产回放需要活的 Codex Lead runtime；若不可用，仅以明确标记的假时钟/台架替身提供本地证明。不得把台架结果称为生产证明。无 merge/deploy/restart/QA dispatch。

## C5 完成

动态订阅已落盘、限于显式 roundtable 父频道并受 TTL/cap 管理；两个 runtime 在 gateway 开始读积压前完成 restore。查询与退订使用同源 state dir/secret，CLI 查询只读、退订经认证 socket。证据见 c5-evidence.md、c5-operator-evidence.md、c5-launcher-evidence.md。聚焦 aggregate 249 项通过后，补充恢复期间退订竞态的 RED→GREEN（最终 wiring 8 项）；operator 17 项；launcher 31/23/64 项全部通过。TeamLead build 已通过，最后 membership 复查改动由后续全仓 build 覆盖。无生产回放、全仓门禁或 review/PR 结论。

C1 lineage 前提复核：run-infra.ts 统一选择 TmuxAdapter/CodexTmuxAdapter；run-dispatcher.ts 的 fresh 与 retry 均在 blueprint 启动前调用 preRegisterCommDb（936、1695），其 1244 行调用 registerSession 写入持久身份。校验不依赖短暂的进程自注册窗口；预注册本身失败时未知身份仍应 fail-loud。

## 全仓门禁进行中

首轮 build 通过。首轮 lint 3个本次修改的测试格式错误，修正后重跑通过（15条既有warning）。首轮 `pnpm test:packages:run` 在 config 的2个 drift断言失败：新的 FLYWHEEL_ROUNDTABLE_SUBSCRIPTION_TTL_MS 缺少非开关归类。已在 NON_FLAG_ALLOWLIST 加入带 FLY-1942 原因的数值配置条目，对应14项测试通过；完整包门与build/lint正在重跑。首轮失败保留，不以聚焦绿色替代。

第二轮 build/lint 通过。完整包门 R2 在 flywheel-comm 失败：4个 E2E 夹具仍是 exec-* 虚构ID、另1个 dependency 测试5000ms超时。仅迁移 E2E 夹具到已注册UUID（并将StateStore读取隔离为临时缺失路径），原始问答/发信断言不变；dependency文件未改。两文件独立46项通过；完整包门R3正在重跑。6个最终shell/guard套件全部exit0，详细日志索引 `/tmp/fly1942-final-shell.json`。

完整包门R3：Comm160文件/2307项、Config50文件/788项、其余已运行包通过；Claude Runner50文件/1257项通过，但Vitest报告1个 onTaskUpdate RPC timeout、退出1。完整包门仍红（`/tmp/fly1942-full-tests-r3.log`），不得用断言全绿替代。下游 edge-worker/teamlead/voice-bridge/voice-codex 单独补跑中。已向Lead提问 c5af927d-42af-4f52-bafc-a42fe69627e2：保留全量红回执、转draft PR/正式review并要求exact-head CI；尚未收到裁定。

Lead c5af927d-42af-4f52-bafc-a42fe69627e2 已裁定：保留全量RED，四个下游包各以 `VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run` 补一次并留exit；不改无关测试/运行时代码。可开PR/冻结code review，但exact-head CI绿+review过才needs_review，最多R3。先前默认并发下游命令已用自身session中断（TeamLead exit130，其他3包完成），不计作指定串行补跑；指定四包顺序补跑现已开始。

补跑与审查修复已完成：三份mailbox夹具53项回归通过，通用QA环境清理清单增加本次TTL变量后脚本全绿；没有无关生产改动。Fork R1 HIGH部署marker遗漏在988a5a4修复，详见review.md。进入新HEAD CI和forkR2→rootR1顺序审查。
