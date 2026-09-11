# FLY-2483 现在要你看 — 实施报告
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-10
基于: plan.md

已实现独立于 Epic 的三路 attention 和固定四段展示；真实 Discord 点击验收仍待 QA，尚未发布或上线。

## 改了什么

当前 founder 门、项目级未答问题、Linear 非终态 founder-review 标签单独读取后合并。保留完整问题身份、所有来源和收件角色，排除自动评审、已回答/被替代问题、无效旧门及单独的 declared_blocked。未知身份保留记录，不能从正文猜测单号。

新增 attention.v1 唯一词表、严格 v2 Cell 校验、等待起点验证和 HTML/Markdown 四段。已有 Epic 成功路径卡片保持原字节；没有 Epic 声明时继续显示 attention，同时 residual 与 dependency CLI 明确返回范围不可用。

实例级 discord_config 只持久化一份配置，缺失或非法时清空旧值。同项目真实 chat_threads 绑定经过别名/权威频道/冲突校验，生成 guild/thread 地址；缺任一输入禁用链接。页面不回显问题正文、执行身份或原始出处键。

实际 JSON/HTML 字节预算保留原 Epic 和完整 attention 行。超量时只保留可装下的完整前缀，并明确显示清单不完整；回执只保存来源。

## 怎么验证

每批先运行失败测试，再实现最小修复。主要 RED 包括缺少项目 reader、旧/已答问题进入、分页越界、外置正文分类未知被抹掉、权威频道丢失、过期门复活、无 Epic 返回错误、实际 HTML 超过 512 KiB、未知身份重复问题未折叠、角色出处被换成另一个问题。

最终相关测试：25 个文件、376 项通过，命令退出 0。覆盖三路 exactly 3、重叠去重、多问题保留、旧 session/长期未答、孤立身份、跨项目、来源失败、非法日期、缺 guild/thread、冲突/恶意 URL、内部 ID 隐私、完整四段、v1 未知状态、scope 缺失、迁移/重启/回滚兼容以及实际 HTML 预算。CLI 另外通过真实 materializer → generator → receipt → HTTP 200 fetch seam 验证两种缺范围结果，42 项通过。

实际体积探针：200 条候选，每条标题包含 1800 个需转义字符。保留 54 条完整记录和原有 5 个 Epic item；最终 JSON 232978 bytes、HTML 521029 bytes、首行 JSON 3605 bytes，budget 为 source_truncated。该数值只证明此 fixture 的容量，不代表任意 1000 条都可展示。

相关测试命令：

```sh
pnpm --filter flywheel-teamlead exec vitest run src/epic-page/__tests__ src/__tests__/StateStore.attention.test.ts src/__tests__/StateStore.attention-gates.test.ts src/__tests__/StateStore.attention-identity-thread.test.ts src/bridge/__tests__/linear-attention-query.test.ts src/bridge/__tests__/linear-epic-query.test.ts src/bridge/__tests__/epic-page-route.test.ts src/bridge/__tests__/epic-residual-scan.test.ts src/bridge/__tests__/epic-page-refresher.test.ts src/__tests__/epic-page-publisher.test.ts src/__tests__/statestore-epic-page.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.attention.test.ts src/__tests__/epic-page-signals.test.ts src/commands/__tests__/dependency.test.ts
```

完整门：pnpm lint 通过，pnpm -r build 通过。pnpm test:packages:run 的两次默认并发尝试均在既有 FLY-1715 CLI 测试触发 5 秒超时；其单独重跑 474ms 通过。第三次使用包并发 1、Vitest worker 上限 2：CommDB 155 文件、2209 项通过；runner 49 文件、1224 项通过，但 Vitest 内部 onTaskUpdate RPC 超时，进程退出 1，后续包未完成。因此第三次仍是完整门失败。Lead 在问题 874b4bd7-118e-4bf6-8798-71a29add1cdc 裁定停止追逐本机负载重跑，允许按失败原文披露后开 PR，交接必须等待最终 HEAD 的 Bridge review 与 CI 14/14。第四次单 worker 诊断没有绿色回执，不作为放行证据；没有改测试、断言或超时。没有新增 scripts/__tests__/*.test.sh。

## 已知边界与未通过项

本地没有截图或视频。proofshot 已尝试，录制三次超时；改用可写的隔离 socket 后 Chrome 在 DevToolsActivePort 前退出，既有 CDP 连接也超时。markup、四段、隐私、响应式断言是本地视觉相关证据的全部，不宣称浏览器视觉通过。Lead 在问题 3ccc5ece-c938-4b62-b1ff-d1854ade207d 明确允许携此缺口交接。

QA 必须用自己实际生成的页面，真实点击 thread_url，并截图证明进入对应讨论串。fixture 地址、HTTP 200、字符串断言都不是这项证据；本报告没有替代截图。

codex:rescue 已通过安装的 companion task 包装器执行，但创建会话时 sandbox_apply 被拒绝，helper exit 71；没有产生 rescue 评审结论。Lead 在问题 051cf112-4d7b-44bf-b7aa-e4b3c67c5a41 确认本环境使用 Bridge 对最终 HEAD 登记的跨模型 request-review 作为正式代码评审门。正式评审及 CI 状态以交接报告为准。

Lead 指令 1f759eb6-2598-40b2-abb0-3009c3e1148f 已落实：成功身份查询保留 resolved/unresolved 计数；查询失败才是 source_unavailable。新增 identity_reads 两个原始健康度 Cell，使校验、预算、freshness、receipt 都能从事实重算这一区别。未修改已固定的 plan.md。

## 风险与回退

标签来源没有可证明的等待起点，显示不知道。配置移除后旧静态页不会即时撤销，需等下一次刷新。数据库与 Linear 不是全局原子快照；页面导航不增加批准权。

常规代码回退会移除 attention 展示，保留增量 discord_config 表及历史回执；旧程序可忽略新表。未修改批准状态、部署策略或 Epic 范围规则。

## 证据与版本

实现提交：aaf1d67bc、c2bbefbe0、9ce3afcf8。最终 HEAD、PR、跨模型评审和 CI 以随后冻结的交接记录为准。

本地原始执行日志：`/tmp/fly2483-focused-final.log`、`/tmp/fly2483-build-final.log`、`/tmp/fly2483-lint-final.log`、`/tmp/fly2483-packages.log`、`/tmp/fly2483-packages-final.log`、`/tmp/fly2483-packages-bounded.log`、`/tmp/fly2483-packages-serial.log`、`/tmp/fly2483-cli-rerun.log`。复现用 HTML/JSON fixture 位于 `/tmp/fly2483-visual/`，只供隔离本地检查，不是线上验收产物。

## 最终评审后的 CI 修复

首轮 frozen HEAD `a57d8c714` 的正式评审为 APPROVED，问题 `b759f5ca-6c49-455c-96ea-5f7fdf008f3f`；同 HEAD CI 11 项通过，Quick Gate 与 TeamLead 第 1 分片失败，汇总门失败。因此未执行阶段完成。

`832f4dd91` 按 Lead 裁定 `cbbae877-4ebb-4ccc-8d9e-cdc152d59c6a`、`dfc27189-5b71-4889-9bd9-71e281d077a9` 修复三处遗漏：CommDB 在问题域内输出规范的 pending attention 状态并移除原始 transport 字段；旧 liveness E2E 显式提供 attention fixture 和当前 generator；discord_config 登记 protectedCurrentOrReference，保留策略的精确 schema fixture 同步新增一表。没有放宽 guard、删除规则或接口必填要求。

RED：原始 residue gate exit 1；新问题域测试 1 失败 / 7 通过；两份既有 CI closure 测试 5 失败 / 28 通过。GREEN：问题域 8 项通过，liveness/retention/attention-sources 共 46 项通过，原始 residue gate 通过且其 4 项负向测试通过。替换版本 pnpm lint、pnpm -r build exit 0；按 Lead 先前裁定不继续追逐本机完整包门，本地完整门仍无绿色回执。日志为 `/tmp/fly2483-question-state-{red,green}.log`、`/tmp/fly2483-ci-closure-{red,green}.log`、`/tmp/fly2483-replacement-{lint,build}.log`。

首轮建议已报告 Lead，按授权本轮不扩修：权威不可确认的门可能静默排除、未知 protected checkpoint 静默排除、身份 metadata 查询未分批（MEDIUM）；预算与发布时钟不同、gates rawCount 含探测行（LOW）。旧 APPROVED 不覆盖替换版本；仍必须新 HEAD 的正式评审与 CI 14/14 后才能交接。

## 冲突返工（Implement attempt 2，2026-09-10）

结论（实测）：合入 origin/main 977660ab3，保留 E2 attention 和 #1151 的折叠 Epic 卡、审计 sidecar。#1148 此时尚未在 main，不提前引入其实现。最终头仍须新评审与 CI；本段不宣称 QA 通过。

改动：attention 为 main 第一子元素，四段与真实来源生成的 Discord href 均在折叠外；Epic 仍默认折叠。保留主线 scope.v2 / parent / counts 语义，修复交叉合并造成的无 scope 校验失败：null roots 继续走完整 unavailable 检查，空 scope 的 root_counts 必须为空。保留 E3 的预留 Lead 格子位置与机器句。retention 两侧表集合并后为 204（protectedCurrentOrReference 为 143），同步生产 schema fixture。

验证（实测）：新增整合 DOM 回归在旧头 RED（没有折叠 Epic），合并后 GREEN；首次整合发现无 scope 被 roots 数组校验提前拒绝，修复后 attention/materializer/HTTP/CLI 均恢复。TeamLead 定向 33 文件 512 项通过，Comm 定向 4 文件 66 项通过。pnpm lint、pnpm -r build 均 exit 0。真实 attention 三行、60 子单与 68 个合成 Lead 格子（各 280 字）组合 HTML 342203 bytes，低于 480 KiB；Lead 格子仅为预留位置测试，不宣称 #1148 已整合。没有新增 shell 测试。

未通过项（未测）：本轮按返工令仅跑定向套件，不重跑上轮已披露失败的本地完整包门，不将其改写为绿。390px / 1440px 新布局视觉和真实 Discord 点击由 QA 重取，当前实现节点没有这两项新证据。正式评审沿用已裁定 Bridge request-review，不重复失败的 rescue 初始化。

风险回退：退回本次合并会同时退回新主线布局，不能只凭旧截图判断。保持 pinned plan 原字节；不改生产配置，不执行服务重启或部署。

证据与版本：本轮原始运行日志位于 /tmp/fly2483-red.log、/tmp/fly2483-focused2.log、/tmp/fly2483-comm2.log、/tmp/fly2483-lint.log、/tmp/fly2483-build.log；它们为本机临时证据。可持久复验的测试随 PR #1147 提交，最终代码版本以该 PR 新评审头为准。

## 第三次 implement：主线合并返工

一句话结论：按 cb97301f-a163-4995-89f7-626b95161ddd 合入 origin/main 92532e22a（包含 #1148、#1149、#1151），保留 attention 页首独立展开与 Lead 注释卡头可见，未改变批准计划。

改了什么（实测）：冲突按两侧并集解决；来源、模型、词表、HTML/Markdown、注释衰减脚本同时保留。注释 freshness 使用已归一的 snapshot，修复无 Epic 时的空指针。保护表注册保留 discord_config 与 lead_note，精确总数 205、非退役 202、保护引用 144。组合预算测试使用真实 attention 与真实 Lead 注释，替换单侧占位；补齐 materializer/CLI/Lead 注释 E2E 的显式依赖。

怎么验证（实测）：先观察无 scope 两例空指针、缺失依赖及表计数失败，再最小修复。TeamLead 41 文件 589 项通过（maxWorkers=2）；Comm 4 文件 66 项通过。pnpm lint、pnpm -r build 通过。60 子单 + 3 条 attention + 76 处 280 字注释的 HTML 为 443109 bytes，8 个折叠卡头均有注释，attention 不在 details 内。本轮没有新增 shell suite。

未通过项：首次并发运行有 5000ms 超时与旧 CLI dist 无 lead-note 命令，构建完成后两 worker 重跑通过；不修改超时或断言。本地完整包门沿用前述失败与 Lead 裁定，本轮按定向返工令不重跑。新头代码评审和 CI 待推送后执行；真实 thread 点击与新布局浏览器证据仍属 QA，当前未测。

风险回退：并发主线推进可能再次产生冲突；本轮普通 push 一次后冻结 HEAD。技术 merge 不代表 PR 合并、部署或 QA PASS。

证据链接与版本：PR https://github.com/xrliAnnie/flywheel/pull/1147；运行日志 /tmp/fly2483-r3-red2.log、/tmp/fly2483-r3-focused-final.log、/tmp/fly2483-r3-comm2.log、/tmp/fly2483-r3-lint-final.log、/tmp/fly2483-r3-build.log 为本机临时证据，可复验测试在 PR 内。

## 冻结头评审 HIGH 最小修复

一句话结论：8dd6bbbe2 的 CI 14/14 通过，但评审 dcd8c6c0-180e-4dcc-a340-e820c47e2f22 指出 protected-non-founder-checkpoint-questions-silently-dropped（HIGH），因此不能交接；按 Lead fec5f6c2 裁定只修此项。

改了什么：删除按 protected + 非 founder checkpoint 丢弃未答问题的过滤；founderKinds 仍仅以 own-key allowlist 分类 founder 门，其余保持 question，不把投递保护状态当成来源排除依据。自动 review、已回答、停止报告等原排除规则保留。

怎么验证（实测）：真实 CommDB 覆盖 question、design_direction、toString 在 markQuestionProtected 前后完全相同，回答后退出且正文不泄漏；先 4 fail / 7 pass，再 Comm 4 文件 69 pass、TeamLead attention 3 文件 71 pass。pnpm lint 与 pnpm -r build 通过；日志 /tmp/fly2483-high-red.log、/tmp/fly2483-high-green.log、/tmp/fly2483-high-teamlead.log、/tmp/fly2483-high-lint.log、/tmp/fly2483-high-build.log。

未通过项：替换头评审与 CI 待执行；真实 Discord 点击仍由 QA 验证，当前未测。本地完整包门沿用既有失败与裁定。全部 MEDIUM/LOW advisories 仅报告，不修改。

风险回退：未知 checkpoint 保持未答问题语义，不授予 founder 权限。按 Lead 要求一次普通推送后冻结，同 request-id 复审；若再有 HIGH，带 findingKey 询问 Lead，不继续修改。

证据与版本：PR https://github.com/xrliAnnie/flywheel/pull/1147，新头以本轮 literal-last milestone 提交为准；批准 plan 字节未变。
