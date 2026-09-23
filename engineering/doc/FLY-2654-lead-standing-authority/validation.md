# FLY-2654 Lead 有条件自决 — 交付验证
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: plan.md

> 当前交付以文末“Standing authority 实施定向验证”为准。此前 Part A / conditional-v2
> 评审与测试保留为 PR 历史，不代表当前 v3 standing 设计。现行设计门为 question
> `d8b48727-1ca1-4cdf-9478-eb5e1a4336f6` / request
> `99bc9f51-729e-4dd5-8a74-2d5eda7772e9` / round 3 / effective APPROVED。

## 设计审查
- review question: `a814bdc6-b251-4f17-91e2-98cebdd43123`
- accepted request: `733c7186-4e3d-48b4-92c6-cf5c94e30374`
- 首轮结果 effective CHANGES_REQUESTED；2 HIGH 与 8 advisories 的处置见 review-resolution.md。
- 第二轮 question `44911e5d-002e-46bd-89aa-d1eeb6209b00`；accepted request `45e1665b-3020-4c84-b47f-d17d14ccd2ce`；修订提交 `c40963eb6`；结果 effective CHANGES_REQUESTED（新增 continuity 缺乏可证明的闭包）。
- 第三轮 question `412792d5-6070-4a87-9daf-ec895e67c048`；accepted request `573e3ee4-9c04-4648-a2f5-a6d14f787c7f`；修订提交 `957358aee`；结果 effective APPROVED，三条 advisory 随后报告 Lead；Lead 两次重裁后不能将旧 APPROVED 用于新 Part A。
- 第四轮有界范围仅 Part A + Part B 隔离：question `7ea95d75-3f48-4efc-b148-927e0ef5ebdc`；request `23cc8d5f-1552-448d-abfd-d13a8d0ba77b`；初次提交 `5d9a1fd3d`；no_verdict 失败。按 Lead 指令修订自然时间框/时态后提交 `0f2ed1f4d`，同 requestId 重试后 effective reviewVerdict=APPROVED、reviewerVerdict=APPROVED，round=4，0 HIGH、5 MEDIUM、2 LOW；原始判决存 review-final.json。Part B 已被 founder 迁仓决定关闭，由 FLY-2679 取代。

## HTML 静态与交互检查
`node /tmp/fly2654-check-report.cjs` 的 Node VM + 最小 DOM harness 验证通过：
- 单一 nonced script、零 inline handlers、无自设 CSP、零外部依赖；JavaScript 语法有效。
- 8 个 section 都有留言框（包括汇总卡本身），实时汇总并以精确 marker 开头。
- 同 pathname 恢复、不同 pathname 隔离；localStorage 抛异常不影响输入。
- 4000 字意见拆分成每块小于 1800 字符、每块带 marker。
- clipboard 成功、API 不存在、Promise reject 三条路径；后两条走 execCommand fallback。
这是 DOM 替身的脚本功能验证，不是实际浏览器 QA。托管页验证待发布后补。

## 本地流程图限制
原始双例外图与重排后的 Part A 图均各执行两次相同标准本地命令（共四次）；最终图源只有 Part A：
```
mmdc -i engineering/doc/FLY-2654-lead-standing-authority/flow.mmd -o engineering/doc/FLY-2654-lead-standing-authority/flow.svg -w 1000 -b white --svgId FLY-2654-d1
```
均失败于 Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。按任务允许的失败路径保留 Mermaid 源并显示 `DIAGRAM PENDING LOCAL RENDER`；无伪造图、无远程渲染。

浏览器工具 `chrome_devtools.new_page` 返回 `MCP tool call requires approval, but approval policy is never`，因此未做真实页面截图或浏览器交互验证，也没有申请改变权限。

## 授权与生产边界
只新增本 issue 设计文档/HTML/图源，没有修改规则文件或运行代码，没有发紧急票、部署、重启、停体、merge 或自行派发后继。代码测试矩阵属于实施计划，未报告为已执行。Part A 无 standing/activation；Part B 的激活方案只归档，不要求后继实施它。实际条件式发票/重启的证据由 Part A 后继阶段出具。

## 当前范围与引用复核
通过 Linear GraphQL 实时读取到 FLY-2679（updatedAt=2026-09-17T20:29:56.616Z）。其描述明确 FLY-2654 Part A 继续、Part B 归档停用由该 Epic 拆除旧机制取代，并给出 founder 20:29Z 原始消息 id `1550242249705660427`（#flywheel-engineer）。本节点验证的是 Linear 记录及 Lead 指令，未独立从 Discord 回读该原始消息，未编造 contentDigest。

## 交付检查
- 探索/调研/当前 Part A 计划与完整关闭 Part B 档案已提交推送；正式有界评审 APPROVED。
- 7 条非阻塞建议已通过 ask --report 发给 Lead，报告 id `7176f69e-491b-49fa-a98a-19fca3801b98`；详见 handoff.md，不冒称全部修复。
- 计划保持送审原文；有效状态以 review-final.json、本文和 progress.md 为准。
- founder HTML 已按最终 A/B 范围重做；托管验证在发布后补记。

## QA rework 实现核验（2026-09-18）

- squash topology：conditional v2 不再要求 verdict 的 `headSha` 等于 squash 后的
  `origin/main`。verifier 从 GitHub 精确读取 merged PR，要求 `mergeCommit.sha ===
  targetSha`，并只接受绑定该 PR 精确 `headRefOid` 的 code-review/QA verdict；PR 编号、
  head、base、mergedAt 与 merge commit 都进入已核验结果，不能由票据自由文本自证。
- founder-direct：bare `scripts/request-restart.sh` 恢复当前 founder 直接紧急重启的 v1
  运输，不要求 code-review/QA verdict；显式 `--request` 仍只走严格 conditional v2，
  任一证据无效都不会降级成 v1。updater 对严格 v1 shape 保留新鲜度、目标 SHA 与
  claim-once 核验。
- 聚焦验证：`restart-request.test.ts` 57/57、`request-restart.test.sh` 14/14、
  `update-flywheel-sources.test.sh` 39/39、`conditional-restart.test.sh` 7/7、
  `updater-trigger-policy.test.sh` 4/4、rules receipt 5/5、rule budget 2/2、CI structure、
  path hygiene 与 child-process census 均通过；`pnpm lint` exit 0，`pnpm -r build` exit 0。
- package aggregate 未形成有效收据：九个实现体同时跑本地全量造成 FLY-2467 已知
  并发假红，Lead 于 05:50Z 终止本轮并裁定不得重启；停止前落盘 summary 的 11 个
  package 中 9 green、2 non-green，TeamLead 未 append 到 summary。实际 5 个失败文件在
  `VITEST_MAX_FORKS=1` 下逐一复跑 5/5 files、7/7 tests 通过。详单见
  `implementation.md`；本地全量按 Lead 裁定跳过，理由 FLY-2467 并发假红 + 九体争抢，
  最终 aggregate 权威留给不再移动的精确头 CI。
- 本节点没有生成真实重启票、部署、重启、dispatch QA、merge 或 ship。

## 精确头代码复审 rework（2026-09-18）

- 首轮 code review：question `1773dcb2-b935-4276-bd9e-184f448294e2`，request
  `017940d5-bd35-49b7-b497-90f39c4b3c60`，reviewed head `d36029959`，effective
  `CHANGES_REQUESTED`。
- 三项 HIGH 均由红测先证实：父 updater shell 没有 restore 环境值导致 rc83；
  `issue_fix_landed` 可借无关 merged PR；immediate 可把 `现在先不要重启` 和英文子串
  判成授权。
- 修复提交 `729e570de`：父 shell 在 mutation 前导出冻结 ticket 证据；PR 远端元数据
  必须点名同 issue 且 repo 固定为 Flywheel；源消息否定筛查与英文 token 边界 fail
  closed。
- 修后验证：TypeScript 41/41，updater 39/39，request producer 14/14，final-check
  7/7，TeamLead build、根 lint（0 error）与 23-project recursive build 通过。完整
  aggregate 仍遵守 Lead 的 FLY-2467 裁定，不在本地重启。

## 第二轮代码复审 rework（2026-09-18）

- question `6f0e1f11-425a-4386-ae3b-5c58c7fc483b`，request
  `b5781237-abc3-458c-87e2-e6535ff96e1b`，reviewed head `a9a3cd09b`，effective
  `CHANGES_REQUESTED`；唯一 HIGH 是 immediate 语义仍可接受日常拒绝与完成态询问。
- 新红测逐字覆盖 `现在还不能重启，等我确认完再说` 与 `重启已经做完了吗？`；
  `07ee4a89b` 改为正向请求语法、邻近否定 fail closed，并只对白名单 permission-request
  问句放行。founder 原句 `那你现在马上紧急重启可以吗？` 另有正向回归。
- 修后 TypeScript 44/44、request producer 14/14、final-check 7/7、updater 39/39；
  Biome、TeamLead build、根 lint 与 recursive build 通过。
- 同 head CI run `35314560653` 的 Quick Gate/classifier 通过，但其余 13 个 job 均未获
  runner；GitHub annotation 明确为 account payment/spending-limit admission failure，
  不是测试失败。恢复问题已问 Lead（question `78a760b5-86cf-498d-ab00-1a9daa88fbcd`）；
  该 head 后续已因代码修复失效，不复用其 CI 结论。

## 第三轮代码复审 rework（2026-09-18）

- question `10b0c704-8d8e-42a0-927b-590bdd2a3d74`，request
  `2519c07a-94fa-4deb-88c7-960b80eac0b7`，reviewed head `cef09ccd8`，effective
  `CHANGES_REQUESTED`；唯一 HIGH 是 canonical 条件样板可被改标 immediate，绕开
  pullRequest/verdict evidence。
- `64aafb47f` 增加条件词与明确完成态的组合门：有 `修好/合入/之后` 而没有
  `已经/已/already merged` 时，immediate 必须拒绝。plan.md canonical 样板为红绿测试，
  明确完成态另有正向回归。
- 修后 TypeScript 46/46、request producer 14/14、final-check 7/7、updater 39/39；
  Biome、TeamLead build、根 lint 与 recursive build 均通过。

## 第四轮代码复审 rework（2026-09-18）

- question `08dd6f56-23f6-4d05-9596-1771950845a3`，request
  `bfa3ff72-03f6-442c-ae72-fce927875202`，reviewed head `e830a92eb`，effective
  `CHANGES_REQUESTED`；唯一 HIGH 证明固定条件词清单仍能漏过另一张 issue/PR 的未来条件。
- 五条 reviewer 原样反例先红：`2650 已经修好了，等 2655 修好后马上重启`、
  `等 2655 上线就马上重启`、`2655 一好就马上重启`、英文 as-soon-as issue 与 when PR。
- `50d92ebf1` 改为结构性分流：任何点名 issue/PR 对象或含明确条件框架的原文均不能标成
  immediate，必须走 conditional v2；对象为空的直接 founder 当前重启请求保持可用。
- 修后 TypeScript 51/51、request producer 14/14、final-check 7/7、updater 39/39；
  目标文件 Biome、TeamLead build、根 lint 与 recursive build 均通过。

## 第五轮代码复审 rework（2026-09-18）

- question `388dd766-6195-49e5-9807-5ba486368f71`，request
  `3ff31337-b0d9-4358-8e70-17171abd79c7`，reviewed head `73c7c5e6e`，effective
  `CHANGES_REQUESTED`；唯一 HIGH 是第四轮移除旧条件词门后，自然语言对象仍可漏入。
- reviewer 五条原样反例先 5/56 红；`fa767c99e` 使用命名对象、条件框架、未完成条件动作
  三门并集，并从条件词中移除会误伤普通顺序表达的裸 `后`。
- `Raya 那边修好了马上重启` 等五条转绿；`现在马上紧急重启，然后告诉我结果` 新增正向
  回归。修后 TypeScript 57/57、request producer 14/14、final-check 7/7、updater 39/39；
  Biome、TeamLead build、根 lint 与 23-project recursive build 均通过。

## 精确头 CI packaged inventory rework（2026-09-18）

- run `35317662046` 绑定 `ff040b691`；其 Script Tests 2/5 在
  `package-onboard-smoke` gate④ 失败：compiled `restart-request.js` 的固定 Flywheel repo
  常量是未注册的 repo-access reference。该失败是严格 inventory 缺口，不是测试 flake。
- `efc0f859a` 增加一条 exact compiled line 注册及 customer-path disposition，未改变
  restart verifier 行为或 authority。
- 同一 smoke 在隔离 npm cache 下 25/25；package-onboard 34/34、gate④ forms 12/12、
  masking 13/13，证明精确行放行且各类变体/组合仍 fail closed。必须在包含本修复的
  literal-last milestone 新头上重新取得 review 与 CI；旧 APPROVED/CI 不复用。

## QA 路由返工：主分支同步（2026-09-18）

- QA 指定 base `1f07d020c` 与 `origin/main@487799b80` 的两处文本冲突已在 merge commit
  `4f661bf14` 解决；没有修改自动合并的运行时代码。
- rules receipt 先红于合并后正文长度 240516，再红于新 SHA-256，按测试实际值回填后
  5/5 green；这证明 fixture receipt 来自合并正文而非任选一侧。
- updater source 首轮 42/43，唯一红项是 main 新规则使 founder-direct v1 成功后也执行
  一次 Raya pass；只更新该预期后 43/43 green。重叠 conditional v2 仍只 claim 一票，
  started/succeeded 各一次，保留另一票给下一 invocation，并在成功后执行一次 Raya pass。
- FLY-2653 相关 `updater-raya-deploy.test.sh` 60/60、`raya-standard-migration.test.sh`
  13/13、`raya-prestop.test.sh` 21/21；FLY-2654 的 57/57、14/14、7/7、4/4、2/2
  定向矩阵全绿。
- `pnpm install --frozen-lockfile` exit 0；`pnpm -r build` exit 0；TeamLead typecheck exit 0；
  `pnpm lint` exit 0（仅 main 带入的非阻塞 warning）。依 Lead 明令没有跑全量 package tests。

## 主分支同步后代码复审 R1（2026-09-18）

- review question `60c5eefb-4f79-404c-9a76-9f4ac3797914` / request
  `a5910828-d111-4a5f-9b17-018339b10f0c` 在 `49f0e8d4c` 返回两项 HIGH。
- conditional source refusal 红测：`issue_fix_landed` 与 `pr_merged` 各可接受一条明确拒绝
  重启的 founder 文本；共享否定门修复后 TypeScript 59/59。
- founder-direct v1 ancestor 红测：ticket target 为 fresh main 的祖先时被消费且 0 deploy；
  仅 v1 恢复 ancestry 判断与 latest-main deploy 后 updater source 44/44。v2 exact target
  freeze 及二次 fetch guard 未放宽。
- 触碰文件 Biome、Bash syntax、根 `pnpm lint`、`pnpm -r build` 均 exit 0；未运行全量。
- 当前 CI run `35423979072` 是 `runner_name=""`、`steps=[]` 的账户计费零步失败；Lead
  明令不得重复 rerun，等待额度恢复后再对最终不变头重跑。

## 主分支同步后代码复审 R2（2026-09-18）

- review question `492afc5d-a14d-48b1-b95c-b28365f3d5e9` / request
  `6a68e06d-8050-457c-acac-2fe1699aec1a` 在 `c7528e035` 返回同 findingKey 的一项 HIGH。
- reviewer 的五条“先问我/我来决定/需要重启吗/check with me”原句和一条 PR question
  均先红；conditional source 改为必须有正向即时/deadline directive，且不能把决定保留给
  founder。修后 65/65，包括既有明确“11 点前重启”正向用例。
- 触碰文件 Biome、根 `pnpm lint`、`pnpm -r build` 均 exit 0；未处理非阻塞 advisory，
  未运行全量。下一轮为 Lead 规定的 R3 上限。

## 主分支同步后代码复审 R3 / 最终 R4 修复（2026-09-18）

- review question `21088648-eff8-4f0f-adca-24912de0926b` / request
  `3453053e-420b-4e55-aa23-a3d05bd8ec77` 在 `cf2064b44` 返回唯一 HIGH：裸 `就`
  与不完整的 deferral denylist 仍可接受把重启交给班车、等待 founder 通知或同意的文本。
- reviewer 五条原样反例在修复前 5/72 红。Lead 通过问题
  `485cc07c-a00f-4ef0-8cd5-f768bb4d3aee` 裁定不再逐句扩自然语言枚举，而是 fail closed：
  未来条件、推迟、转交和等待后续同意均不是授权；只有已完成条件 + 当前无条件重启指令
  可继续绑定精确 issue/PR v2 证据。
- `1bf0e8db0` 实现该边界；五条反例与两条明确正例转为 72/72。触碰文件 Biome 与
  `git diff --check` 通过；根 `pnpm lint` exit 0（25 条仓内既有 warning），
  `pnpm -r build` exit 0。依 Lead 指令没有运行本地全量，也没有 rerun 计费墙后的 CI。

## 最终 R4 复审后的 Lead 有界修复（2026-09-18）

- question `c2679238-bf17-4bcd-8f60-4d0d991dc38f` / request
  `7a966ea0-7c1a-416c-8226-f516e9907f8c` 在 `142ae03f7` 返回两项 HIGH：中文未来
  从句仍可夹带在已完成断言后；权限正文/运行指引仍与最终裁定相反。
- question `e8151533-edc9-4761-ae44-53f701264e5e` 请求 Lead ruling。Lead 拒绝带已知
  HIGH 发货，授权最后一个有界修复：完整 allowlist、规则文本同步、到时再问 founder。
- 新红测先得到 reviewer 四条精确绕过与性质拼接共 8 个失败；实现后又用红测证明 caller
  可把任意未来从句伪装成 `timeFrame.expression`，再为 deadline 增加独立正向语法。
  最终 `restart-request.test.ts` 87/87，R3/R4 九条原样反例全拒、三条明确正例全过、
  每条正例拼接三个从属条件均拒。
- R4、Lead identity、restart guard、bridge ship discipline 已同步为“未来条件只触发到时
  再问”。legacy bundle 真实物化 receipt 为 240435 bytes / SHA-256
  `9f67220e87bb7f24ddadd36c3da805f2fe269e298588d561c4f278b43cadd429`；receipt 5/5、
  rule budget 2/2、`pnpm lint` exit 0（25 条既有 warning）、`pnpm -r build` exit 0。
- 未运行本地全量、未 rerun CI；精确头自动 CI 仍是账户额度导致的零步失败。

## 托管核验（已完成）
- URL: https://fw-reports-42fba7.vercel.app/r/c018a2dc6a267a2b761a5f0c9c532575/
- publishOnly=true、messageId=null、delivered=false，符合静默发布要求。
- HTTP 200；nonce 占位符残留 0；单一 script nonce 与 CSP 匹配；脚本文本与已提交 HTML 完全相同；8 个留言框；外部依赖 0。
- 完整 source/hosted SHA-256 与边界见 hosted-verification.json；真实浏览器 QA 仍未执行。
- DESIGN-HTML ready 已按精确格式报告 Lead，报告 id `4706d03a-0d1c-46ac-98b8-94852745d0c7`。
- 交付内容只含当前 Part A 与已关闭 Part B 的历史说明；本次没有实现或实际紧急票。

## Standing authority 实施定向验证（2026-09-20）

本轮遵守重派额度约束，只跑直接相关定向测试；没有运行或申请本地/远端 full CI，也没有
把 focused green 称为 aggregate green。

- TeamLead v3 verifier/scoping/context：4 files、126/126 tests；包含四个原样正例、十四个
  原样反例及 prefix/suffix/newline/quote 性质拒绝，inactive manifest、跨日、跨频道后续
  founder 消息、active turn、新 wake、CommDB 单边孤儿、未 push head 和 scope drift。
- request producer：25/25；包含显式 v3 只进 active immutable package、caller 伪造
  package-active 环境拒绝、package tamper 拒绝且无 mutable fallback，以及 bare v1 不被
  standing 入口重解释。
- final pre-stop guard：8/8；v3 仅在最后边界写 started，source/scope/clean/one-use 任一
  漂移零 stop，started v2 只恢复，安全 restore 只允许原 pre-merge clean HEAD。
- updater source：48/48；未 started v2 原字节退役、started v2 恢复、v3 单波 claim/
  duplicate/consumed-no-deploy/result、scheduled/urgent 后各一次 Raya pass。
- updater trigger policy：4/4；Raya prestop：21/21；Raya deploy：64/64。
- TeamLead `tsc --noEmit` exit 0；四个相关 shell 文件 `bash -n` exit 0；restart guard
  388/388（含 bare v1 与显式 `--request` 两个合法入口）；`git diff --check` exit 0。
- rules bundle/truth/budget、child-process census 与 TypeScript path hygiene 共 5 files、
  71/71；新增 `git`/`tmux` 探针的 census 从 1 精确更新为 3，没有放宽扫描器。
- package-onboard 36/36、gate④ forms 12/12、masking 13/13；Raya standing 条款里的固定
  repo slug 先被 gate④ 拒绝，再以一条 exact-line customer-path disposition 登记后转绿。
  完整 package-onboard-smoke 的 packaging、真实安装、Bridge/Lead/package gate 与零运输
  检查均已到达，但最终 24 pass/2 fail：两项都在 packaged Codex launcher 被本机
  `CODEX_HOME_LAUNCH_FENCE unavailable reason=owner_identity_unavailable` 拒绝，未把该轮
  记为 green，也未据此修改本单代码。
- shell path hygiene 13/13；CI structure PASS；teamlead shard contract 9/9。

这些是实现头的 focused 证据，不替代最终 exact-head code review、CI 或独立 QA。执行包
只在 `/private/tmp/FLY-2654-package-proof-20260920-1644/release` 隔离构建/核验；没有写
active production pointer。没有读取/复制 live `teamlead.db` 或 `comm.db`，没有真实票、
deploy、restart、activation、QA dispatch、ship 或 merge-to-main 副作用。

## 最终 main 同步验证（2026-09-20）

- 合入 `origin/main@a62456f76` 的 merge commit 为 `7769c0930`，ort 无冲突；增量属于
  FLY-2638 Discord attachment 入站，未改 FLY-2654 权限设计。
- 首次 TeamLead typecheck 因 sibling `flywheel-comm/dist` 陈旧而出现 5 个新 attachment
  字段类型错误；定向构建 `flywheel-comm` 后同命令 exit 0，没有修改源代码绕过。
- restart + standing authority 9 files、146/146；`flywheel-comm` 的
  `discord-chat-ingest.test.ts` 32/32。最终 code review 必须绑定同步后的新 literal-last
  milestone head，不能使用同步前任何 review/CI 收据。

## 自动 CI 守卫返工（2026-09-20）

- 精确头 `191a74845` 的自动 CI 暴露两项本分支遗漏：
  `FLYWHEEL_STANDING_AUTHORITY_STATE_DIR` / `FLYWHEEL_STANDING_PACKAGE_ACTIVE` 未进入
  non-flag accounting，新增的当前 TURN 投影读取未进入 FLY-1674 精确兼容清单。
- Lead 在问题 `c190aefb-0118-42b2-824a-faff199d81df` 明确要求只修这两项、移动头后重新
  code review，并等待新 exact-head CI green；全仓既有 lint backlog 不在本单处理。
- `18bb15347` 只增加两条带理由的 non-flag 登记，以及 production read/test fixture 两条
  exact path + token 清单；运行语义未改变。
- 定向复验：`feature-flags-drift.test.ts` 14/14，`fly1674-residue.test.sh` 85/85。
  没有运行本地 aggregate 或调用 `ci-full ensure`。

## 新增文件 Biome 定向修复（2026-09-20）

- exact-head run `35550601014` 的 14 个矩阵 job 中，除 Quick Gate 外均 green；Lead 对照
  main job `105923159065` 与本头 job `106184507998` 后确认并非全仓存量，而是本 PR
  18 个新增可检查文件中的 3 个机械 Biome error。
- 对这 18 个新增文件执行定向 `biome check`，精确定位为 `restart-request.ts` 的 import
  顺序和一处换行，以及 `restart-scope.test.ts` 的一处换行。`4d8b3d994` 仅应用这些
  formatter/organize-imports 安全变更，不改运行语义、不改全局配置、不处理 25 个 warning。
- 复验：新增 18 文件 Biome 0 errors；`restart-request.test.ts` +
  `restart-scope.test.ts` 2 files、116/116。没有运行本地 aggregate 或手动请求 full CI。

## updater active-package 授权守卫（2026-09-20）

- code review round 2 的 `updater-package-active-env-unverified` 原为 MEDIUM advisory；Lead
  明确将其提升为本单必修，因为 caller-set active 标记不能制造或转移 AUTH-CANON 权限。
- 变异体先证明旧实现会在 pointer 缺失时以 rc=0 接受伪造 active 环境；`c34151511`
  改为无论首次进入还是 active re-entry 都验证 regular/non-symlink pointer、manifest 与
  CLI digest、完整 package digest、resolved updater entry、package root 和当前物理脚本。
  任一不符写稳定 reason 并 rc=78 fail closed。
- 同一变异体转为 rc=78 且记录 `active-package-pointer-missing`；updater source 49/49，
  `update-flywheel.sh` 与测试 `bash -n` 通过。没有运行本地 aggregate 或手动请求 full CI。

## retention consumer 精确清单（2026-09-20）

- exact-head run `35551941878` 的 Quick Gate 已通过 Biome，随后由 FLY-2006 retention
  consumer gate 拒绝 `restart-request.ts` 新增的四个未分类只读 consumer：
  `chat_threads`、`mailbox`、`phase_chat_threads`、`runner_phase_wakes`。
- `5293e5690` 按 exact file/relation/baseTable/usage 将四条登记为 `candidate_guarded`；这些
  读取只形成收尾重启的当前证据，缺失即拒绝，不改变 retention 删除规则，也不从缺失推断
  授权。专门测试同时锁定完整四条清单和漏登失败。
- 复验：production retention consumer gate 0 errors；定向 Node 测试 10/10；配置与测试
  Biome clean。没有运行本地 aggregate 或手动请求 full CI。

## QA2 返工定向验证（2026-09-22）

- TeamLead 构建（`pnpm --filter "flywheel-teamlead..." build`）exit 0；本轮新增/修改文件
  Biome 0 errors，全仓 `biome check` 25 warnings 与基线相同、0 errors；`git diff --check`
  与四个 shell 文件 `bash -n` 通过。
- TeamLead vitest 13 files、217/217（route、activation E2E、activation store、standing
  authority、package、proof、init、standing、manifest、restart-request、v3、registry
  identity、closeout context）；proof/init 补充 registry_identity 用例后 2 files、37/37。
- 变异体：`restart-request.ts:652` 与 `:744` 改 `if (false)` 分别使 v3 vitest 10 failed /
  1 failed；同两处改在 dist 使 `request-restart.test.sh` 的 dist 守卫块 FAIL；全部还原后
  dist sha256 与备份一致，源码 dirty=0。
- shell 顺序运行：`updater-raya-deploy` 83/83（原 64 + 19 差分臂）、`request-restart`
  28/28（原 27 + dist 守卫块）、`raya-prestop` 21/21、`update-flywheel-sources` 51/51、
  `conditional-restart` 8/8、`raya-standard-migration` 13/13、`updater-trigger-policy` 4/4、
  `packaged-seams` 18/18、`shuttle-unit-results` exit 0、FLY-2006 retention gate exit 0、
  claude-runner kill-path inventory 5/5。
- 观察：`request-restart.test.sh` 第一个用例（stub `git ls-remote`，1s 超时）在与 vitest
  并行运行时出现一次 rc=124；顺序运行与 HEAD 副本各自 27/27、28/28。该用例与本轮改动
  无关，未修改。
- 消费者扫描：`updater-raya-deploy.sh` / `update-flywheel.sh` / `raya-migration-proof.ts` /
  `raya-migration-init.ts` / confirm route / activation store 的 `git grep -lF` 命中里，
  文档、`ci.yml`/ci-source fixture（未改步骤）、`kill-path-inventory.json`（无新 kill）、
  `lead-backend-migration*`、`LeadAlertNotifier`、`alert-kind-copy`/`kind-contract`、
  dashboard prototype、launchd plist、`converge-flywheel-bin`、`package-onboard*`、
  `provision-fleet-host`、`lead-alert.sh`、`hooks/*restart-guard*` 只是字符串引用或未触及
  的路径，未运行；其余全部在上表运行。
- 未运行本地 aggregate；exact-head CI 与 529 N-to-N 由复审后按 Lead 交接执行/由 QA 拥有。

## 代码复审 round 5 修复验证（2026-09-22）

- TeamLead 构建 exit 0；改动文件 Biome 0 errors；`git diff --check` 通过。
- vitest：`restart-request.test.ts` + `restart-request-v3.test.ts` 136/136（含新增
  started→failed 后 `side-effects-not-provable` / `already-used` 回放）；activation store /
  standing / manifest / E2E / route 定向套件绿；state-dir 解析器 3 断言。
- shell：`request-restart.test.sh` 28/28（dist 块新增账本回放，断言
  `restart-request-side-effects-not-provable`、`restart-request-already-used`、终态 failed 无标志）；
  `update-flywheel-sources`、`conditional-restart`、`test-restart-services` 结果见本节末。
- 账本消费者 shell 套件顺序运行：`update-flywheel-sources` 51/51、`conditional-restart` 8/8、
  `test-restart-services` 165/165；全仓 `biome check` 25 warnings / 0 errors。

## 代码复审 round 6 修复验证（2026-09-22）

- TeamLead 构建 exit 0；dist 含新行写入逻辑；Biome 0 errors（全仓 25 warnings 基线）；
  `git diff --check`、`bash -n update-flywheel.sh` 通过。
- vitest：v3 + legacy ledger + activation store + closeout context 4 files、142/142（新增
  “种标志 → started 丢弃 → failed 终态”回放）。
- shell 顺序运行：`update-flywheel-sources` 52/52（新增 rc=82 静态守卫）、`conditional-restart`
  8/8、`test-restart-services` 165/165、`request-restart` 见下一行。
- `request-restart` 28/28（dist 回放断言 plantedZero=true、startedZero=null、终态 failed 无标志、再 prepared 为 already-used）。

## origin/main 同步后验证（2026-09-22，merge `b736c0198`）

- `pnpm --filter "flywheel-teamlead..." build` exit 0；TeamLead `tsc --noEmit` exit 0；
  全仓 `biome check` 25 warnings / 0 errors；`git diff --check` 通过。
- vitest 14 files、226/226（含 `lead-token-savings-launch` 5/5，bundle 摘要按合并后规则重算为
  241689 字节 / `94a60a18…`）。
- shell 顺序运行：`request-restart` 28/28、`updater-raya-deploy` 83/83、`update-flywheel-sources`
  52/52、`conditional-restart` 8/8、`raya-prestop` 21/21、`test-restart-services` 174/174（main 侧
  新增 9 例）。
- ci.yml 守卫：`ci-structure`、`ci-shell-suite-enumeration`（84 Node suites）、`ci-matrix-coverage`
  （24/24）、`ci-classify` 全部 PASS。
- 头再次移动，复审必须重新绑定新的 literal-last milestone 头；round 7 的 APPROVED 不复用。

## 第二次 origin/main 同步后验证（2026-09-22，merge `a746b4ad4`）

- build / `tsc --noEmit` exit 0；vitest 14 files、226/226；`request-restart` 28/28、
  `updater-raya-deploy` 83/83、`update-flywheel-sources` 52/52、`conditional-restart` 8/8、
  `raya-prestop` 21/21、`test-restart-services` 174/174；ci.yml 四守卫 PASS；Biome 0 errors；
  `git diff --check` 通过。

## 代码复审 round 9 修复验证（2026-09-22）

- `fly2567-rule-budget` 2/2（裁剪后 161205 ≤ 161258.25）；条目标记内字节与 entryDigest 与 HEAD
  逐字节一致（脚本比对）；`lead-token-savings-launch` 5/5（fixture 重算）；`lead-rules-bundle`、
  `rules-bundle-truth`、`rule-sources`、`external-agent-contract`、`fly350-fullaccess-deploy`、
  `standing-authority`、`standing-authority-loaded-rule`、activation E2E 全绿。
- restart-request v3/legacy vitest 含新增 `started` 显式标志拒绝；`request-restart` 28/28（dist
  回放新增 startedStamp 断言）；`test-restart-services` 175/175（新增包外引用守卫）；
  `fly2030-summary-prefix-pair` PASS；Biome 0 errors；`git diff --check` 通过。

## 第三次 origin/main 同步后验证（2026-09-22，merge `c18a8f060`）

- build / `tsc --noEmit` exit 0；vitest 17 files、283/283（含 fly2567-rule-budget、bundle fixture、
  lead-rules-bundle、rules-bundle-truth）；`updater-raya-deploy` 105/105（83 + FLY-2758 22）、
  `request-restart` 28/28、`update-flywheel-sources` 52/52、`conditional-restart` 8/8、
  `raya-prestop` 21/21、`raya-standard-migration` 13/13、`test-restart-services` 175/175；
  ci.yml 四守卫 PASS；Biome 0 errors；`git diff --check` 通过；推送前 `origin/main` 无新提交。
- 529 真实 Discord 播报臂与注册表差分由 QA 在新头上按其 harness 重跑（QA3 已明确要求）。

## 第四次 origin/main 同步后验证（2026-09-22，merge `8c263bbba` + 预算压缩 `981f0aa4b`）

- `pnpm install --frozen-lockfile`（main 改了 lockfile）；`flywheel-comm...`、`flywheel-teamlead...` 构建 exit 0；
  `pnpm lint` 0 errors / 25 warnings 基线；`git diff --check` 通过。
- vitest teamlead 29 files、348/348：本单全部 bin/bridge 测试（standing-authority ×6、restart-request v3/legacy、
  restart-scope、closeout-context、raya-migration init/proof/standing、raya-registry-identity、confirmation route）、
  rules-truth / FLY-2567 bundle 套件（`rules-bundle-truth`、`rules-bundle-truth-process`、`rules-bundle-materialize`、
  `rules-bundle-legacy-alert`、`lead-rules-bundle`、`fly2567-rule-budget`、`lead-token-savings*` ×5、`rule-sources`、
  `external-agent-contract`、`fly350-fullaccess-deploy`）、`deployment.test.ts`。压缩前 `fly2567-rule-budget`
  红（161735 > 161258.25），压缩后绿。
- 交集文件直测：main 侧 voice StateStore/route/capability + `raya-standard-migration` 9 files 85/85；config truth
  5 files 129/129；claude-runner `kill-path-inventory` 5/5；`fly-2006-retention-consumer-gate` 通过。
- shell 顺序运行：`updater-raya-deploy` 105/105（含本单 19 个注册表差分臂）、`request-restart` 28/28（含 intent /
  播报绑定 dist 负例）、`update-flywheel-sources` 52/52、`conditional-restart` 8/8、`raya-prestop` 21/21、
  `raya-standard-migration` 13/13、`test-restart-services` 175/175、`fly1402-single-bundle` 41/41、`fly879` 38/38、
  `run-codex-infra-bot-tui` 19/19、`run-codex-lead-mufasa-tui-fullaccess` 23/23、`test-fly26-rules-split` 93/93、
  `fly2030-summary-prefix-pair`、`legacy-swap-broadcast-retirement` 13/13、`fly1674-residue` 85/85、
  `codex-home-reconcile-cadence`；ci.yml 守卫 `ci-structure`、`ci-shell-suite-enumeration`（85 Node suites）、
  `ci-matrix-coverage`（24/24）、`ci-classify` 150/150。
- `fly231-companion-launch-plan` 49 通过 / 5 失败（T8 golden 缺 main FLY-2643 的 `visible-tui-default.md`）；
  在 `origin/main@58693d28c` 检出上同样 49/5，测试文件与 main 一致，且不在 CI 中：基线失败，非本单引入。
- 529 真实 Discord 播报臂与 QA attempt-1 的 12 臂注册表差分 harness 不在仓内，由 QA 在新头上重跑；
  仓内对应的 19 个注册表差分臂与播报/意图绑定负例已在上面重跑通过。
