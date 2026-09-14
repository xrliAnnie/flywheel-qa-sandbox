# FLY-2390 判据 c 聚合 — 实施记录
Issue: FLY-2390 (https://linear.app/geoforge3d/issue/FLY-2390/1143b3-判据-c-聚合消费-fly-942-原始事件-版本归因-watchdog-heartbeat源健康-报-bug-打版本-tag)
日期: 2026-09-10
基于: plan.md

## 偏离/补充

- Lead 裁定 `93b0060d-1725-4f80-aa41-f869a42912e6`：StateStore 观测唯一键采用 `(event_id, source_commit_key, origin, occurrence)`。shell 与 Bridge 各自分配 occurrence，原三列键会把两条路径的 occurrence=1 混为一条。shell 伴表及四元游标保持原合同；evaluator 仍按窗口内 eventId 去重、取最高 severity。回归测试见 `StateStore.release-readiness.test.ts` 的双来源观测及事务回滚用例。
- `RETENTION_MS` 的实际导出位于 `scripts/lib/fly-2006-retention-registry.mjs`，retention engine 从该处导入；evaluator 复用同一导出。
- founder 裁决窗口按绑定日报的发布时间判断，避免重复扫描更新 observedAt 延长旧日报的否决期限。
- retention engine 对已有实体 `__rowid` 列不再追加同名 rowid 投影；实际 inventory→apply 回归暴露了重复投影造成的 CAS mismatch。保留原有 CAS 校验与本计划的 surrogate key，三张表均验证删除收据及严格 14 天边界。
- shell 复用 `FLYWHEEL_STATE_DIR` 作为 state 根目录，便于主机测试隔离。缺口意图先于配置/工具检查，观测与四条原有 claim 语句同事务；原语句经 SHA-256 字节比对不变。主机 Bash 3.2 实测发现既有 strict-delivery 测试空数组展开失败，测试辅助函数改用位置参数，生产投递分支未改。

## 当前验证范围

C1 已通过 policy、subject、evaluator 的 20 项定向测试。C2 的 StateStore、retention sweep 与 standing-policy 共 47 项测试、实际消费者门、TeamLead 类型检查通过。全仓验证、代码审、回放日报与 PR 交接尚未完成；本记录不代表验收完成。

C3 的 notifier 五个套件共 83 项测试通过；七个 lead-alert shell 套件在 `/bin/bash` 下通过（strict-delivery 修正测试辅助函数后 28/28）。新增 shell 测试覆盖缺配置、未知 Lead、缺工具、sqlite 失败、重复 no-token、缺版本、SQL 引号与旧 claim 字节合同；CI 枚举通过。C4–C7 未完成。

C4 服务部分：每次 collect 同步读取部署 SHA 和两个 outbox，缺目录、损坏 JSON、非普通文件及无效字段均阻断 green；publication 的扫描状态由摄取器维护，不信任文件传入。evaluate 使用同一 14 天保留常量取证并追加完整结论。service/evaluator/StateStore 共 21 项定向测试及 TeamLead 类型检查通过。rider、GatePoller 与 plugin 装配尚未完成，进度仍为 3/7。

C4 shell 投影部分：复用现有 sqlite stdin helper，按四元游标每页 500、每轮最多 10 页查询；StateStore 原子投影后才更新内存游标。两个真实 SQLite 定向测试覆盖同秒 501 条、重放无重复、无效归因、投影失败游标保留及积压 600 秒、源表缺失；类型检查通过。完整 rider 的 outbox/heartbeat/founder 流程仍待实现。

C4 rider 流程已实现：single-flight tick、目录探针、部署锚点快照、gap/publication 摄取后 landed、heartbeat 成功追加后才 ACK Bridge 粘性计数；publication 在 sqlite await 期间改写时保留待下一轮摄取。founder 按当前 subject 的 14 天内日报集合扫描，两种 emoji 均读到末页，20 页上限或任一失败记 scan error；无反应不删除旧 down，另一日 up 不覆盖它。rider/service/evaluator/StateStore 共 26 项定向测试、TeamLead 类型检查通过。GatePoller/plugin 接线、C5–C7 尚未完成，整体仍为 3/7；这些测试未访问真实 Discord。

C4 接线完成：GatePoller 在现有第 1、21…tick 调用独立隔离的 readiness callback；plugin 在启动 poller 前构造 rider，启动身份注入 notifier/rider，W1 freshness 直接复用现有 tracker。Discord reactions GET 设置 10 秒超时，缺 token 保持扫描失败。GatePoller/teardown/rider/service/subject 共 28 项定向测试、现有 Bridge 启动集成测试 2 项、TeamLead 类型检查及 Biome 通过；启动测试的 readiness/claims/alert 路径隔离在临时目录。进入 C5 HTTP 路由及 create-issue 集成，服务实例将在该路由组合处接入；全仓及真实 Discord 验收尚未执行。

C5 首批 HTTP 路由已挂载：verdict 即时取证落账、verdicts 历史、已存在 issue 的手动 bug-report 幂等写入、master-only bug-intent resolve。默认鉴权复用 tokenAuthMiddleware，resolve 另加现有 masterOnlyAuthMiddleware；服务端固定 resolvedBy，重试返回 canonical receipt。手动上报已有 issue 无外部创建步骤，直接以 finalized 写入独立报告记录；重复 issue 返回原记录，不改版本。真实 HTTP 与 StateStore/service 共 14 项定向测试、类型检查、Biome、retention consumer gate 通过。render、create-issue 新 bug 流程、comm 命令、env 登记与 C6–C7 仍待完成；整体保持 4/7。

C5 create-issue 已集成：bug 严格 boolean；每次按 team 解析配置 Bug 标签，UUID 传入仍参与判定；查询失败写持久源健康，显式 bug:true 仍记 bug。调用方直接传 Bug 名称而解析失败的提前返回路径也记录源失败。pending intent 先于 Linear create，成功返回 identifier 后才 finalize；失败不清 pending，意图写失败不调用 Linear。页脚显示完整版本身份，重复追加替换自己的页脚，身份不可读标 unknown。create-issue/页脚/路由共 47 项定向测试和 TeamLead 类型检查通过；旧父子关系测试 mock 改为区分 Bug 与 scope label，UUID 测试补充预期的 Bug 查询。12 个 readiness 配置环境变量已登记 NON_FLAG_ALLOWLIST，既有 flag-truth 测试通过。CLI、render 和 C6–C7 仍未完成。

C5 CLI 完成：release-bug-tag 支持 --issue（可附 --commit/--base-version）及 --resolve-intent 搭配 --issue 或 --abandon/--reason。使用 master token、10 秒超时、标准 parseArgs；冲突/重复参数先拒绝，HTTP/网络错误非零退出，不自行重试。两项定向测试、Comm 类型检查通过；实际 index 入口无效参数返回 JSON 和退出码 1。check-flag-truth shell suite 通过。C5 完成，render 路由与渲染器在 C6 一起实现；C6/C7 尚未完成。

C6 渲染器与 HTTP render 已实现：同一 collect 输入用于落账及 HTML，日期严格校验，超过 512 KiB 返回 413；复用既有 escapeHtml。页内包含版本/本机 SHA/窗口/理由/事件/bug/源健康/outbox/日报扫描/founder/阈值；heartbeat 按分钟取较差健康状态，判定函数与 evaluator 共用，缺失分钟单独标灰。renderer/evaluator/HTTP 共 10 项定向测试和 TeamLead 类型检查通过。尚未生成回放 sample、执行视觉检查或实现发布脚本/plist/janitor，整体仍为 5/7。

C6 发布与保留已实现：render 响应头返回同次评估的 commit/base，脚本据此生成 publication；先原子写 intent 再 publish-report，只有成功且带 messageId 才写 published，否则 failed。同日 pending/landed 均幂等；脚本保留自己的意图副本，rider 在发送期间移走 intent 后仍能写 final。主机 Bash 3.2 hermetic suite 覆盖以上路径及空频道 no-op，通过。08:00 plist 以 copy/0,1 登记，固定清单同步更新；plist lint、launchd manifest suite、CI shell 枚举通过。既有 janitor state_residue 模块仅对两个 landed 目录实施 14 天清理，复用路径/open-file/mtime guards；完整 suite 40/40 通过，pending/近期文件保留。TeamLead 类型检查及 render 响应头 HTTP 测试通过。未安装 launchd、未发送真实日报；回放样例及视觉检查仍待完成。

C6 回放夹具已完成：构造的原始观测、旧/当前/20 天部署锚点、版本 bug、损坏及未摄取 outbox、失败标签源和三日报 founder 集合，产出 green/hold/unknown 三态，逐项理由保存在 fixtures/verdicts.json。report-sample.html 标明回放样例，测试逐字对比当前渲染器输出；replay/report 测试及 TeamLead 类型检查通过。视觉仍未通过：proofshot 启动 Chromium、导航和 390px 布局诊断成功，但截图命令多次超时；Chrome DevTools MCP 因环境 never 审批策略拒绝调用。已发 Lead 报告，正在停止并打包 proofshot 会话；尚无可检查截图，不把 DOM 诊断当视觉证明。

Lead 裁定 `f6edb993-12d9-4a26-ac7a-4084507e34a2`：停止沙箱截图重试，视觉验收交 QA；implement 交付确定性 sample、无浏览器结构检查、HTTP render 200/正确响应头，并在 PR 明确 `visual acceptance deferred to QA`。本轮完成这些 implement 项：`scripts/verify-release-readiness-report.mjs` 复用现有 HTML scanner，检查决策、11 个证据/时间轴区块及 512KiB；缺区块、超限、script 注入反例均被拒。HTTP 测试现经过实际 createBridgeApp 挂载，返回 200/text-html 及预期 commit/base 响应头；这是隔离 HTTP 集成证据，不是生产部署证明。sample SHA-256 `2105b3a076fa60efbed9fe3f07ee8e46d2e3559dbac5cc00ae6006022ba2c84f`，41478 字节。Proofshot 已停止，0 截图且未产出视频，日志保留 `/tmp/fly2390-proofshot-artifacts`。C6 implement 项完成；QA 视觉验收仍未完成。

C7 进行中：全仓 pnpm lint 最终通过（15 warnings），pnpm -r build 通过；pnpm test:packages:run 已启动，尚未取得结果。保留原始收据 `/tmp/fly2390-full-lint.log`、最终 lint `/tmp/fly2390-full-lint-final.log`、build `/tmp/fly2390-full-build.log`、包测试 `/tmp/fly2390-full-packages.log`。遵循 Lead 同条裁定：主机争用导致的全套红保留证据，不反复重跑，exact-head CI 单独作为权威证据。

C7 本地门结果：`pnpm lint` exit 0（15 warnings）；`pnpm -r build` exit 0；`pnpm test:packages:run` exit 1。TeamLead 980 文件通过、1 文件失败，13107 tests passed / 1 failed / 7 skipped；另有 Vitest `onTaskUpdate` RPC timeout。唯一断言失败是既有 `fly-2341-db-hygiene-script.test.ts` 的 lineage 用例，预期首批归档 100，实际 64。该测试、operator 脚本和 terminal-row-archive 实现均无分支差异；归档器每页 64、每页预算 25ms、每次调用预算 50ms，结果与负载下预算提前结束一致。仅一次隔离复核 4/4 通过（exit 0，`/tmp/fly2390-db-hygiene-isolated.log`）；未重跑全包，不将隔离通过改记为全包通过。其他完成的包全部通过。已向 Lead 报告完整失败收据；精确 HEAD CI 待 PR 创建后核验。

新增两个 shell suite 均已以主机 `/bin/bash` 执行通过：`lead-alert-version-observation.test.sh`、`release-readiness-report.test.sh`。相关 janitor 全套 40/40、launchd manifest、CI shell 枚举、flag truth 通过。节点结构检查再次通过，sample 41478 bytes；批准 plan blob 仍为 `96e93af14be4988908d235d30bc83e9a234582f3`。本轮 fetch 后 origin/main 等于 merge-base `d964e9fcada02a0006b54337b28382ce474dab3e`。

Proofshot 遗留只服务合成 fixture 的本地 Python HTTP 进程（127.0.0.1:43190，PID 85334）停止命令被沙箱拒绝，已通过 Lead report `91c7aef2-4445-40e9-aab3-847479e761f0` 披露，未绕过限制。没有生产发布、真实 Discord 发送或视觉验收证据。**visual acceptance deferred to QA**。

R1 effective CHANGES_REQUESTED，审查 HEAD `bd8426c59796c448d545fd91710f613c1d144dfc`，原文见 code-review-r1.md。两个 HIGH 和一个实际 CI 漏项按 Lead 授权 `defe9584-e4ba-4f13-a5da-7e9f0f835e0c` 集中修复：包内 evaluator 定义 14 天常量，retention registry 从其构建产物复用，移除包运行时向仓库 scripts 的越界导入；新 plist 加入既有 PATH registry；**plan 12/F4 pre-ingest count self-poisoned heartbeat; ruling defe9584**，heartbeat 改用摄取后最小 re-scan，真正 pending、无效文件、读取和摄取失败仍不健康，GET 同步扫描不变。批准 plan blob 未变。九条 MEDIUM/LOW 延后，不修改计划或扩展实现。

包布局回归先红 ERR_MODULE_NOT_FOUND；rider 回归先红 expected pending0/actual1，随后验证落地成功 healthy、卡住的 publication unhealthy。修复后七套 55 tests 通过，含实际 retention inventory/apply；PATH suite 21/21，通过主机 /bin/bash。原 HEAD CI 最终 12 项通过，PATH 分片及 CI OK 失败；原始日志 `/tmp/fly2390-ci-script2.log`。修复后全仓验证及 R2 尚待取得；授权要求本轮一次 push、再 R2，R2 有 HIGH 则停止请示 Lead。

R1 修复后全仓门：`pnpm lint`、`pnpm -r build` exit 0（`/tmp/fly2390-r1-full-lint.log`、`/tmp/fly2390-r1-full-build.log`）；`pnpm test:packages:run` exit 1（`/tmp/fly2390-r1-full-packages.log`）。TeamLead 981 files passed / 1 failed，13101 tests passed / 8 failed / 7 skipped，另有 onTaskUpdate RPC timeout。失败仅在无分支改动的 codex-quota-probe：10ms 等待后 callback-order 断言 actual[]/expected[first]，后续七项 5000ms timeout；原 db-hygiene 失败未复现。没有进一步重跑，不把本地全包记绿。Lead 收据 `1d913527-070d-47ad-b50c-5a2f825b5606`。再次 fetch，origin/main 与 merge-base 均为 d964e9fcada02a0006b54337b28382ce474dab3e；plan blob 仍96e93af14be4988908d235d30bc83e9a234582f3。下一门为单次推送后的精确 HEAD R2 与 CI。

R2 effective APPROVED，reviewed HEAD820fc9af29700da1d9a235f8047b80b2c31a737f，11项非阻断建议已报告 Lead（ef2830e7-1d8d-40c6-916d-e1bd2cf5363c），原文 code-review-r2.md。PR 已转 ready。随后精确 HEAD CI 的 PATH 检查通过，但同一 shell2分片在 package-onboard-smoke 发现 workspace:* 残留：新运行时依赖 flywheel-release-contract 未进入 payload package list；原始日志 /tmp/fly2390-r2-ci-script2.log。

Lead 授权6a0e650d-b9f1-4a4a-a387-2dfc998af9be 进行最后一次纯打包修复：补 PO_PACKAGES、release-contract:src 既有资产声明及四个实际 .mjs 文件的精确 allowlist。真实文件名为 index/grammar/identity/validator，无 version.mjs。既有 assembly 的 dist guard 和 gate③ 的 src 禁止对登记的原生 JS main 作最小支持：必须入口存在、资产明确登记；未登记/缺失入口以及 TypeScript/测试仍拒绝。不改 runtime 功能、package.json 或批准 plan。Hermetic suite 两次预期红后33/33绿，增加真实 payload 闭包导入与无workspace协议断言。

真实 package-onboard-smoke 首次因宿主 ~/.npm 缓存权限失败，保留 /tmp/fly2390-r3-package-smoke.log；换任务独立 NPM_CONFIG_CACHE=/tmp/fly2390-npm-cache 后复现 src gate拒绝，保留 /tmp/fly2390-r3-package-smoke-isolated-cache.log。修复 gate 后原完整 smoke 正在运行（/tmp/fly2390-r3-package-smoke-final.log），已产出通过gate的tarball，release-contract真实导入/版本规范化及voice闭包检查通过，npm安装/Bridge启动等后续结果尚待取得。只允许本批一次push、R3；R3非APPROVED或新精确HEAD CI仍红时停止请示Lead。

最终纯打包修复验证：`/bin/bash scripts/__tests__/package-onboard.test.sh` 33/33；`NPM_CONFIG_CACHE=/tmp/fly2390-npm-cache /bin/bash scripts/__tests__/package-onboard-smoke.test.sh` exit0，**24 passed / 0 failed**（/tmp/fly2390-r3-package-smoke-final.log），实际 npm pack/install、所有包导入、原生better-sqlite3、Bridge /health、Lead dry-run及Raya注册/preflight均通过。`pnpm lint` exit0（/tmp/fly2390-r3-full-lint.log）。本批只改打包脚本、测试和清单，没有运行时TS/依赖元数据改动；不再重跑已按Lead上限执行的全包测试，既有本地失败收据继续保留。提交ffcbd1d6f，fetch后main仍d964e9f、计划blob96e93af未变；下一步单次push与最终R3/CI。

技术合并返工（Lead授权b3c962f5-0bc9-480e-9ee1-2caa3114dfed、后续430711b5-9e00-4f06-bab0-d7852ad0e3ec）：main前进到bece7de15使PR冲突、CI不排队。此前85989815d的一行gate4修复经9/9+打包33/33并获有效APPROVED；该批准不延用到mergeHEAD。执行git fetch/merge origin/main，仅StateStore.ts顶部相邻import冲突，双方原文均保留；LeadAlertNotifier与Comm index自动合并，不删改main的receipt/TURN wait/voice行为，计划blob仍96e93af14be4988908d235d30bc83e9a234582f3。

合并验证：pnpm -r build、TeamLead tsc --noEmit、pnpm lint均exit0；TeamLead22套416/416（readiness、create-issue、retention、FLY-2504 receipt、workflow/projector/rework、patrol），Comm4套139/139（TURN wait/worktree-turn、patrol、complete）通过；retention consumer gate ok。日志/tmp/fly2390-merge-{full-build,tsc,lint,focused,comm-focused,retention-gate}.log。未重跑被限制的全包测试，历史本地红继续披露。合并进度与本记录纳入同一个merge commit，避免进度CLI在MERGE_HEAD期间尝试部分提交。按授权只push该merge commit，然后恰好一次新审查；APPROVED+精确HEAD CI绿后needs_review1156，否则停止请示。


Engine rework attempt 2（2026-09-11，request rework:1ee7df3be3a2eece5d7ee81dd5fbb0724645a4d8456e850c75b05fc1cb3e390b）：旧 HEAD d1e909df3 的 CI 全绿，但当前 main ca869ad6d638cf9aec34f0ed321a20bd1e6c4c09 已使 PR 冲突。技术合并仅 StateStore.ts 顶部 import 冲突，保留 readiness 类型与 main session-terminal import 双方原文；其余自动合并已检查，无新增行为或设计改动。plan blob 仍 96e93af14be4988908d235d30bc83e9a234582f3。

本轮 pnpm -r build、pnpm lint、TeamLead tsc --noEmit 均 exit 0；TeamLead 15 files / 98 tests，Comm 2 files / 17 tests 均通过；两套新增 shell 测试、retention consumer gate 与 41478 字节日报结构验证通过。日志 /tmp/fly2390-rework2-{build,lint,tsc,focused,comm,shell-observation,shell-report,retention}.log。保持既有 Lead 不重跑全包裁定，历史全包 exit 1 不改记绿。样本 hash 不变，真实浏览器视觉仍交 QA。下一步提交、推送、新 HEAD review/CI，随后 needs_review 1156；不 ship。

## Replacement 3: R1 blocking rework (2026-09-11)

TURN implement attempt 3 / epoch 6 confirmed. Restored only the named stash `0ec8e71134c89d2c618916b52662d5df37ee6373`, with no conflicts. Verified Lead decision `d3fbd3cf-89c0-4356-80c2-d745b5dd5cf7`; pinned plan unchanged, amendment-founder-signal.md records its bounded change. Both shell producers and Bridge service/rider now append `state/release-readiness` to the FLYWHEEL_STATE_DIR root. Zero eligible publications or unset/blank report channel yield unknown; a healthy scanned publication without thumbs down still permits green.

Restored regressions run against pre-fix production code: 6 expected failures (zero publication, three missing-channel variants, exported-root shell-to-rider gap, mounted route outbox path). Restored fixes: 11 files / 50 tests pass, including real shell-to-StateStore gap ingestion with default and exported roots. Both shell suites pass. `pnpm lint` and `pnpm -r build` exit 0. Logs: `/tmp/fly2390-replacement3/{red,green,shell-observation,shell-report,lint,build}.log`. Only restored test formatting was adjusted; no advisory scope added. Historical full-suite failures remain disclosed; host full suite not rerun under Lead instruction. R2 and fresh exact-head CI remain required before needs_review #1156; QA retest and fresh founder approval remain downstream gates.

## Rework R2 → R3 (2026-09-11)

R2 question `7cb60ad7-9502-4cc2-ba51-2cf47fc96576` reviewed `502ed674178178d8dbaf6c4a80ab81eb06c3c47b`: CHANGES_REQUESTED, one new HIGH `shell-cursor-drops-same-second-rows`. Prior two HIGH resolved; nonblocking findings retained in rework-review-r2.md and deferred. Per replacement brief, only new HIGH fixed before final R3.

The timestamp/event-id cursor could permanently miss a later insert with an earlier tuple. Projection now uses SQLite rowid insertion order in the existing append-only, composite-primary-key claims table. This also covers scripts whose observation timestamp precedes a delayed commit; merely holding back the open second would not cover that case. Existing observation timestamp and identity remain evidence fields. A nullable `last_source_rowid` cursor column is added idempotently; an old cursor replays from rowid 0, using the existing event uniqueness guard, until it has an insertion cursor. Atomic event/cursor writes, 500-row pages, ten-page limit and oldest-pending backlog remain. No source-table mutation or new dependency. This supersedes only the plan's projection ordering detail under the authorized blocking-fix scope; pinned plan unchanged. The source remains append-only: pruning/rebuilding it would require an explicit cursor migration in that future change.

New late-insert regression RED: only z-first ingested, a-later and earlier-observed-delayed-commit absent. GREEN: 53 tests across 11 readiness/StateStore suites; old-schema reopen, new-schema reopen, replay and 501/5001 rows are covered. Atomic projection rollback rerun passes. `pnpm lint` / `pnpm -r build` exit 0; retention consumer gate checked. Logs `/tmp/fly2390-replacement3/r3-*`.

CI at superseded 502ed6741 finished with all work jobs passing except Unit(light): unchanged voice-core headless-brain test asserted argv must not contain hi, but random temporary path was `/tmp/voice-identity-iRThiu/identity.md`. Isolated test 11/11 passed. No voice-core edits; original CI failure retained. New R3 head must obtain fresh review and CI before needs_review #1156; QA retest and fresh approval remain downstream.

## Engine conflict rework attempt 4 (2026-09-13)

Request rework:15f8cd5ba085280a20e3f80a7f59d73cddf820ba943d0e476ef1822a00102955, base 10be80c8813e03e1542bb912839e6e141ce7978c; TURN implement attempt 4 / epoch 9. Merge origin/main 26ebc4931ba41e0a626ee14075f6de5359815ab5. Three manual conflicts: preserve both StateStore import groups; preserve both retention consumer lists; reconcile retention test counts against merged registry and production fixture (155 protected current/reference, 219 total, 216 without retired). No additional behavior change; pinned plan unchanged.

Validation in progress under /tmp/fly2390-rework4/: lint exit 0, retention consumer gate ok, both task shell suites pass, report structure verifier ok (41520 bytes, 11 headings). Build, focused regression and required full package suite are running; results are not yet claimed. New head review and CI remain required, followed by needs_review #1156. QA visual acceptance remains downstream.

Post-merge dependency synchronization: initial build/routes failed because local node_modules lacked newly merged yauzl; pnpm install --frozen-lockfile installed the locked packages without manifest changes. Rebuilt successfully (build-synced.log); readiness/StateStore/retention 13 suites / 86 tests pass (focused-synced.log). Required full package run exited 1 in Comm: one 5s CLI timeout and two migration tests using stale compiled TeamLead validator. All three suites pass in isolation after rebuild (99 tests, comm-isolated.log). Full package run after completed build is in progress (full-tests-synced.log); its final receipt will be included in PR/report, not inferred from isolated tests. First-run failures retained.


## Engine conflict rework attempt 5 (2026-09-13)

Request rework:e28d9aec1ecc87126da54593c57bc93bf88cacd7657823706573953fca54d9e8; TURN implement attempt 5 / epoch 11. Base 6aab03408d6bc83993fd04004d1840e5c4e4bf90; merge main 7ed515939. Three manual conflicts preserve both StateStore import groups, release-contract and phase-protocol package assets, and both asset allowlists. No new feature behavior; pinned plan blob remains 96e93af14be4988908d235d30bc83e9a234582f3. Validation logs: /tmp/fly2390-rework5/. Lint passed; remaining validation running. Previous attempt rebuilt full-package run ended exit 1: Comm 179 files passed, cli.test.ts two failures (2480 tests passed, 3 skipped); this is retained separately from focused green results. Fresh review and exact-head CI required before needs_review #1156. QA owns visual acceptance and downstream retest.

Attempt 5 validation: pnpm lint and pnpm -r build exit 0 after frozen-lockfile install. Readiness/StateStore/retention 13 suites / 86 tests pass; package-onboard 33/33, both task shell suites, retention consumer gate and 41520-byte/11-heading sample verifier pass. pnpm test:packages:run exits 1 in config: 52 files / 817 tests passed; fly1981-final-ledgers.test.ts has two 15-second timeouts. One authorized isolated rerun also has the same two timeouts (9 passed); the file is byte-identical to the pre-rework head. No additional full or isolated rerun, no unrelated fixes. Exact-head CI remains authoritative and pending. Commands initially using nonexistent test/verifier paths were corrected; those command errors are not test passes. Lead instruction 61745a73-ae29-42b5-aef9-87fad0bcc580 confirms conflict-only scope and one isolated rerun.

Final attempt 5 receipts (Lead request 6351c7bf-4262-4163-8ff9-64e9e21a52b9): reviewed head 5e4cb6619 APPROVED (eecf6b9f-6108-46af-b55c-652a338c0688); ten nonblocking advisories reported. CI 34800774965 attempt 1: all other work jobs passed; TeamLead 3/3 had 343 files/4092 tests pass, one skipped, only onTaskUpdate RPC timeout, 551.29s. Lead e8b2a713 authorized one failed-job rerun. Attempt 2: 342 files/4091 tests pass, one failed/one skipped; DirectEventSink.test.ts:1605 expected updateIssue once, got zero, 439.33s. Both DirectEventSink source/test unchanged from pre-rework; single local whole-file isolate 65/65 passed, 3.34s. Lead 6351c7bf identifies the same flake observed in FLY-2490/2361 and authorizes needs_review with the red receipt, no third rerun/no code change; Lead owns a separate flake issue. CI is not green. All raw logs in /tmp/fly2390-rework5/. create-issue/teardown 52/52 also passed. These final documentation-only receipts follow the Lead request; final-head review is refreshed after committing them.
