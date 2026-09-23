# FLY-2654 两项有前置条件的长期授权 — 实现记录
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: plan.md

> 当前交付以文末“Standing authority 完整实施与 QA attempt 1 返工”为准。此前 Part A /
> conditional-v2 各节是 PR #1247 的可审计历史，已被当前 standing 设计与 v3 实现取代，
> 不能作为现行权限或运行指引。

## 实现结果

只实现获批的 Part A。QA rework 后 `request-restart.sh` 明确保留 founder 当前直接指令
的 bare v1 票；预先绑定 issue/PR trigger 的条件路径才经 `restart-request.ts` 回读并核验
founder 单次指令、时间框、唯一 trigger、
实际 Lead/instance、工程频道播报、from/target SHA 与 one-use intent，再发布
`authorized-urgent-restart` v2 ticket。updater claim 前及 `restart-services.sh` 第一次
停服务前均重新核验；目标被固定为已验证的 `origin/main` SHA。

复审修正后，Lead instance 不再从 caller 环境接收或持久化 raw carrier claim：请求用
`instanceId=current`，CLI 从当前私有 runtime manifest、活 PID 及可用的新鲜公共 carrier
evidence 解析公开 digest，票/日志只保存 digest。同一 founder messageRef 是 one-use key，
更换 trigger kind/object/repository 不能再造波次。显式时间框由受控解析器从引用原文计算，
必须精确等于 `expiresAt`，所有分支均受原消息后 24h 硬上限约束。

零服务副作用的最终检查失败，只能在 checkout 仍干净、HEAD 仍等于冻结目标且
deployed SHA 未变时恢复工具记录的 `preMergeHead`。任何 service stop 之后继续由
原有 rollback 路径负责。完整 shape 的 founder-direct v1 票继续按原 claim-once 路径执行；
伪作者、过期/撤回/漂移、错误播报、已使用 intent、目标变化或无法回读 Discord 证据的
条件 v2 都 fail closed，不会降级成 v1 或 Lead 自批票。

R4 规则只澄清 AUTH-CANON(A) 已存在的条件式逐实例 founder 指令：条件达到后不必
要求 founder 把同一句话再发一次。它明确保留 FLY-1894“R4 不授予发起权”，不新增
standing carve-out、activation manifest、Raya pass、第三运输来源、R1/R2/R3/R5 权限
或一般“收尾后 Lead 自决”。Part B 已关闭并由 FLY-2679 取代。

## 评审 advisory 处置

- 在 Discord 原文上独立做固定时间词词法预扫；命中时间语言却申报 24h fallback
  会拒绝。`今晚` 与显式时钟反例均已覆盖。
- 消费者 sweep 扩到 `scripts packages engineering doc .lead .claude`，同步现行
  runbook 与 Lead identity。
- 条件式 Discord/message ref 不可回读时明确拒绝；founder 当前直接指令的 bare 路径保留，
  不从方向性文本推导它。
- updater 要求 ticket `targetSha === origin/main`，并对该 SHA 做 `--ff-only`。
- R4 文案逐字对账 FLY-1894；Part B 各级标题标为已关闭归档。
- Part B 关闭依据记录原频道/消息 `1516209714097291335/1550240284800188529`、
  `1516209714097291335/1550242249705660427` 与替代 Epic FLY-2679。

## TDD 与聚焦验证

QA rework 先把 bare producer 与 updater v1 consumer 两条回归写成红测（各 1 条失败），
再恢复原 founder-direct 运输并保持条件 v2 独立核验，两套聚焦脚本转绿。此前验证中发现
`lead-token-savings-launch.test.ts` 对 legacy bundle 的确定性 bytes/hash 断言红：规则
正文变化后 expected 仍为旧值。只刷新对应 fixture receipt，随后该文件 5/5 通过。

聚焦矩阵：

- `restart-request.test.ts`: 57/57；
- `request-restart.test.sh`: 14/14（含真实 CLI 跨进程 instance digest 与 stale PID 拒绝）；
- `update-flywheel-sources.test.sh`: 39/39；
- `conditional-restart.test.sh`: 7/7；
- `updater-trigger-policy.test.sh`: 4/4；
- `fly2567-rule-budget.test.ts`: 2/2；
- `lead-token-savings-launch.test.ts`: 5/5；
- `pnpm --filter flywheel-teamlead typecheck`: exit 0；
- `scripts/__tests__/ci-structure.test.sh`: PASS。

## 仓库验证

- `pnpm lint`: exit 0；仅仓库既有 22 warnings，无 lint error；
- `pnpm -r build`: exit 0，23 个 workspace project 构建通过；
- `pnpm test:packages:run`: 在 head `632496c21` 上启动并生成 partial package-gate
  目录；其 build 阶段 exit 0。九个实现体同时跑本地全量导致主机争用后，Lead 依据
  FLY-2467 于 2026-09-18 05:50Z 终止本轮，并明确裁定不得重启、aggregate 改由精确头
  CI 提供。停止前 `summary.json` 已落盘的 11 个 package 中 9 个通过，
  `flywheel-claude-runner` 与 `flywheel-comm` 非绿：Claude 首轮 50/50 files、
  1,341 tests 通过但发生 `onTaskUpdate` RPC timeout；自动重试出现 1 个 SIGTERM/lock
  计时断言失败并再次发生 RPC timeout。Comm 的 204 files 中只有 1 个 5s backend
  migration 计时断言失败。TeamLead partial log 另记录 4 个争用形状断言（Bridge 5s
  timeout、Epic wiring 的 timeout/后台刷新、CommDB 临时目录竞态），但终止前没有把
  package 12 append 回 `summary.json`。因此这不是可用的本地 aggregate receipt，不能
  冒充 green 或产品失败。
- 随后设置 `VITEST_MAX_FORKS=1`，逐一隔离复跑实际失败的 5 个文件：Claude 目标
  1/1、Comm 目标 1/1、Bridge 目标 1/1、Epic wiring 整文件 3/3、CommDB 目标 1/1，
  合计 5/5 files、7/7 tests 通过，覆盖 aggregate 的全部 6 个失败断言。没有放宽
  timeout，也没有修改这些旁支实现。

本地全量按 Lead 裁定跳过，理由 FLY-2467 并发假红 + 九体争抢。最终 aggregate 权威
由不再移动的精确头 GitHub CI 验证，代码评审与 CI 收据在 PR/结构化 handoff 中记录。

## QA rework 代码复审修正

精确头 `d36029959` 的首轮代码复审（question
`1773dcb2-b935-4276-bd9e-184f448294e2`，request
`017940d5-bd35-49b7-b497-90f39c4b3c60`）给出三项 HIGH，均在 `729e570de`
按 TDD 修正：

- updater 在 checkout mutation 前从已 claim 的 conditional ticket 抽取并导出恢复所需
  环境变量；因此 restart final check 返回 82 时，父 shell 能执行真实 pre-merge restore，
  不再因空值转成 83 并永久烧掉 one-use intent；
- GitHub merged PR 回读现在提取 title/body/head ref 中的精确 issue id，且 repo 固定为
  `xrliAnnie/flywheel`；`issue_fix_landed` 必须由该 PR 真实点名同一 issue，不能拿无关
  PR 的 merge commit 充当条件完成证据；
- immediate 源消息先经过撤回/否定筛查，英文 `now`/`already` 使用 token 边界；
  `现在先不要重启` 与 `snow`/`knowing` 子串均 fail closed。

新增红测分别复现 `restore|||`/rc83、无关 PR 被接受、否定消息与英文子串被接受；修复后
`restart-request.test.ts` 41/41、`update-flywheel-sources.test.sh` 39/39，关联
`request-restart.test.sh` 14/14、`conditional-restart.test.sh` 7/7；精确触碰文件 Biome、
`bash -n`、TeamLead build、根 `pnpm lint` 与 `pnpm -r build` 均通过。

第二轮精确头复审指出第一轮的 immediate 否定词修复仍可能接受日常拒绝与完成态询问。
`07ee4a89b` 将 immediate 从“含现在/已经关键字”收紧为可枚举的正向重启请求语法：
重启附近的否定表达 fail closed，含询问标记时只接受明确的“现在马上重启可以吗”类
permission request；`现在还不能重启，等我确认完再说` 与 `重启已经做完了吗？` 红测
转绿，同时 founder 原句 `那你现在马上紧急重启可以吗？` 保持可接受。修后 TypeScript
44/44，关联 shell、Biome、TeamLead build、根 lint 与 recursive build 全绿。

第三轮精确头复审发现，新增“马上”正向语法会让计划 canonical 条件样板
`2655 修好了我们可以马上重启…` 被错误重标为无 PR/verdict 的 immediate。`64aafb47f`
要求 immediate 只要含 `修好/合入/之后` 等条件词，就必须同时存在明确的完成态断言
（`已经/已/already merged`）；否则 `trigger-immediate-conditional` fail closed。canonical
样板先红后绿，`已经修好了，现在马上紧急重启` 正向例保留。修后 TypeScript 46/46，
关联 shell、Biome、TeamLead build、根 lint 与 recursive build 均通过。

第四轮精确头复审进一步证明，依赖条件词与完成态字面量的例外仍可把另一张 issue/PR 的
未来条件藏在同一条 immediate 文本里。`50d92ebf1` 改为结构性分流：只要 founder 原文
点名任一 issue/PR 对象，或含 `等…就/一…就/as soon as/when/if/after` 条件框架，
immediate 一律 fail closed，必须走有 PR、merge 与 verdict 证据的 conditional v2；只有
不点名对象的当前直接重启请求可走 v1。reviewer 给出的五条中英文绕过样例均先红后绿，
原 founder 直接请求及不点名对象的已完成态请求保持通过。修后 TypeScript 51/51，关联
shell 14/14、7/7、39/39，目标文件 Biome、TeamLead build、根 lint 与 recursive build
均通过。

第五轮精确头复审指出第四轮把结构门当成了旧条件词门的替代，而不是补充，导致
`Raya 那边修好了马上重启` 等用自然语言点名对象的条件指令重新漏入 immediate。
`fa767c99e` 改为三门并集：命名 issue/PR、显式条件框架，或含条件动作但没有明确完成态
断言，任一命中都拒绝 immediate。旧条件词正则同时移除会误伤 `然后/最后` 的裸 `后`。
reviewer 五条自然语言反例均先红后绿，`现在马上紧急重启，然后告诉我结果` 为正向回归。
修后 TypeScript 57/57，关联 shell 14/14、7/7、39/39，目标文件 Biome、TeamLead build、
根 lint 与 23-project recursive build 均通过。

第五轮修复后的精确头 CI run `35317662046` 在 Script Tests 2/5 的
`package-onboard-smoke` gate④ 发现新增的 compiled `FLYWHEEL_RESTART_REPO` 常量没有
exact-line inventory 注册。`efc0f859a` 只在 `audit-grep-allowlist.tsv` 增加该行及
customer-path disposition，不改运行逻辑。相同 smoke 在隔离 npm cache 下 25/25 通过；
`package-onboard.test.sh` 34/34、gate④ forms 12/12、masking 13/13 同时证明未扩大模糊
allowlist。首次本地 smoke 只因用户级 npm cache 权限失败，随后隔离 cache 的完整执行为
有效收据。

## 边界

本实现没有读取或复制生产数据库，没有生成真实紧急票，没有 deploy、restart、Raya
切换、停体、QA dispatch、ship approval 或 merge。票发布成功也只代表受理，不证明
重启完成；生产激活与真实 founder 消息验证仍属于后续独立 QA/ship/运行证据。

## QA 路由返工：同步 origin/main（2026-09-18）

QA 判定上一精确头的失败是路由性冲突，不是产品缺陷。分支合入
`origin/main@487799b80`，只人工处理两处冲突：

- `legacy-bundle.json` 同时保留 FLY-2654 的 conditional/founder-direct 演进和
  FLY-2702 的 package-gate WAITING 演进；由正文物化红测取得并回填合并后
  `bodyBytes=240516`、`sha256=5fafcdceb3554dca94ac90946a5f108089e4faa656e55ec75e1e68c2cbea0c68`。
- `update-flywheel-sources.test.sh` 保留 FLY-2654 的 v1/v2 双消费者、单票串行和
  one-use transition 断言，同时接受 main 上 FLY-2653/2523/2669 的 Codex home、
  observation 和成功 urgent 后单次 Raya pass 行为。运行时代码自动合并，无额外改动。

返工定向验证：restart verifier 57/57、request producer 14/14、conditional final guard
7/7、updater source 43/43、trigger policy 4/4、legacy rules receipt 5/5、rule budget 2/2、
Raya deploy 60/60、Raya standard migration 13/13、Raya prestop 21/21；TeamLead typecheck、
`pnpm lint` 和 `pnpm -r build` 均 exit 0。首次 build/typecheck 只因 main 新增 workspace
尚未按冻结锁文件安装、兄弟包 `dist` 陈旧而失败；`pnpm install --frozen-lockfile` 后同门
转绿。依 Lead 返工令没有运行本地全量。

## Replacement implement 同步（2026-09-19）

替换实现体取得 attempt 2 TURN 后先确认原 QA base `1f07d020c` 的两处冲突
已由 `4f661bf14` 解决，再把新的 `origin/main@4b8bed5c8` 合入分支。新增 main
提交未再触发冲突；`origin/main` 是新头的祖先。

在合并后的实际树上重新运行锁定验收：`restart-request.test.ts` 87/87；
request producer 14/14；updater source 44/44；conditional final guard 7/7；trigger
policy 4/4；rules receipt 5/5；rule budget 2/2；Raya deploy 60/60；migration
13/13；prestop 21/21；CI structure 与 Codex home cadence 均 PASS。TeamLead typecheck、
`pnpm lint`（exit 0，只有主分支已有 warning）、`pnpm -r build`（24/25 workspace
scope）和 `git diff --check` 均 exit 0。依既有 Lead 并发假红裁定仍不在本机重跑
`pnpm test:packages:run`；最终 aggregate 由本次推送后的 exact-head CI 证明。

## Standing authority 完整实施与 QA attempt 1 返工（2026-09-20）

本轮按重派要求从 PR #1247 现有历史继续，没有重做。Lead 原样保存的 stranded WIP
`b554c478e` 先经定向测试和差异审计整理为 `1a22e6cbe`；随后按批准计划依次完成：

- `e170f5b6f`：把 R1 Raya 载体切换与 R4 Lead 收尾重启写成两个精确 standing 条目，
  同步 AUTH-CANON(B)、activation manifest 形状、独立确认者要求与 Lead 运行指引；R1
  merge/ship 主体、R2、R3、R5 未放宽。
- `0215f489c`：增加仅允许两条条目的严格 manifest/activation verifier、非作者 CoS
  confirmer、完整不可变执行包和 active pointer；Claude 真实进程 receipt 与 Codex
  真实 thread/turn receipt 均绑定同一 rules digest/entry digest。完整包实测 49,014 项、
  669MB，manifest digest 为
  `b14cbba77402d0abb8e7c241836ad891d7cec8e1b9307ad9658753d630c37aff`；这只是隔离
  构建/核验证据，本节点没有激活生产条目。
- `97058c89b`：Raya 账本增加 founder/standing 互斥 union 与旧账本 CAS 原位迁移；P2
  停机窗口前每轮 fresh `origin/main` 生成新 revision 并重建 quiet15m 证据，进入停机
  后冻结本轮 target，下一正常班车继续追 main。Flywheel 自身已 caught-up 时也保留一次
  独立 Raya pass；merge 不发票、不增加 scheduler。
- `c24720c34`：显式 `--request` 只接受 schema-v3 `lead-closeout-restart`；未 started v2
  原字节归档为 `retired-conditional-authority`，started v2 仅完成既有恢复，bare v1 保持
  AUTH-CANON(A) 兼容且不会由 v3 失败自动调用。

v3 producer 使用固定四正例/十四反例 full-match 语法，只把 founder 当日消息当作前置
事实，不把它重分类为单次授权。withdrawal census 合并项目 general/chat/alert、所有 active
issue/phase thread 及 CommDB 历史已知 DM/route；任一后续 founder 消息、摄取形状损坏或
分页缺口均使当前 decision 失效。scope 先从 StateStore 全量 nonterminal sessions 取主
列表，再与全部项目 CommDB active sessions、最新 activation、精确 review/QA receipt、
park 状态、`active_turn_id`、phase/turn wake、tmux、recovery digest 及 Git clean/pushed
head 交叉核对；任一单边孤儿、active turn、新 wake、未 push 或恢复证据漂移都拒绝。

发票顺序被代码固定为：先显式 `scope-snapshot` 物化 `current.json` 与四类 receipt；再发
绑定 decision/revision、intent ref、scope digest、target、目的、打断集合和恢复预期的
工程播报；最后才 `prepare`。producer 不会在播报后重物化 scope。显式 v3 create/revoke
会先校验 active pointer、CLI digest 和完整 manifest，再 `exec` 不可变包内 producer；
caller 伪造 package-active 环境、包篡改或包外脚本均以 78 fail closed，bare v1 不经过
这条 standing 入口。

updater claim 后仍不写 `started`。`restart-services.sh` 在第一次停服务前用旧已确认包
重新枚举 scope、核验原意图/后续上下文、active manifest、公告、from/target 与 clean
checkout；全部通过后才原子 `prepared→started`。此前拒绝写 `consumed-no-deploy` 并仅
恢复本波 admission；真正停服后的失败只完成同一 started wave 的安全恢复，不造第二波。
同一 intent 的 revision 只允许在可证零服务副作用的 `consumed-no-deploy` 后继续，
started/unknown 永不自动重发。v3 拒绝后 30 分钟内的 bare v1 会写
`possible-closeout-fallback`、关联 decision 并对缺失单次授权引用报 anomaly；该审计不
授予 v1 权限。

本轮还修复了两个在审计中发现的最终闸门漏洞：停驻 marker 不再遮住非空
`active_turn_id`；scope 会枚举所有项目 CommDB，从而拒绝只在 CommDB 出现的孤儿在飞体。
运行文档、restart guard、spin/orchestrator 和 launchd 注释都已改为 direct-founder v1
与 active standing closeout v3 两类受控紧急票，并明确“先 scope、后播报、再发票”。

本节点没有创建真实票、使用真实凭证、激活条目、部署、重启、dispatch QA、请求 ship、
把 PR merge/push 到 main。独立 confirmer 的真实生产 activation、真实 founder 消息离线回放、
host 执行和最终 QA 仍需后续节点在其权限内证明。

## 最终 review 前同步 origin/main（2026-09-20）

fresh fetch 发现 `origin/main@a62456f76`（FLY-2638 inbound Discord attachments）不再是
本分支祖先。技术 merge `7769c0930` 由 ort 自动完成、无冲突；main 修改了
`flywheel-comm/discord-chat-ingest` 及 TeamLead Discord 入站消费者，本单
`closeoutFounderChannels` 正好复用其 envelope parser，因此在最终复审前重新验证而不复用
旧头证据。首次 TeamLead typecheck 只因 `flywheel-comm/dist` 仍是合并前类型而报新 attachment
字段不存在；定向 `pnpm --filter flywheel-comm build` 后同一 typecheck 转绿。standing +
restart 9 files、146/146，合并源 `discord-chat-ingest.test.ts` 32/32。该同步没有修改
FLY-2654 权限语义，后续 milestone 重新成为 literal-last commit。

## 最终伪造 active 环境回归（2026-09-20）

round 3 reviewer 指出原回归只覆盖 pointer 缺失，没有锁住真实旁路：pointer、package
digest 和 entry 都有效，但 caller 从可变 checkout 伪造
`FLYWHEEL_STANDING_PACKAGE_ACTIVE=1`。`db1595efa` 构造完整 synthetic pointer/package/CLI，
并断言 mutable updater 必须以 `active-package-script-mismatch` 和 rc=78 拒绝。移除
root/script identity 比较的受控 mutant 精确红 49/50；恢复生产条件后同一 suite 50/50，
shell syntax 与 diff check 通过。mutant 未提交、未 push，生产代码字节未变。

## QA2 返工：激活可达、注册表作用域、变异体（2026-09-22）

QA2（head `15656d418`，request `rework:0b70738289…`）判三条硬红。本轮由替换实现体在
现有头上增量修复，未重做、未改设计。

**硬红 1：两条 carve-out 在该头上不可达。** QA 证明 `stageStandingAuthorityCandidate`
零个非测试调用方，且 confirm 入口只认 `codex-app-server` 载体，而生产 `flywheel-cos-lead`
行是 `claude-code`。`1ec9f8cbe`：

- `standing-authority-confirmation-route.ts` 的载体校验按 backend 分派：claude-code 确认者
  提交 `claude-lease:g<generation>`，路由用 `validateClaudeLeadLeaseAuthorization` 对实时
  lead-lease 库核验绑定 generation 与存活 pane；codex 确认者保持原 carrier evidence 校验。
  identityDigest、cos 角色和固定确认者 id 仍只从 projects.json 解析，不收 caller 自称。
- 新增 `standing-authority-activation-cli.ts` 作为已交付的操作员路径：`stage`（Engineering
  Lead 暂存 pending 候选，绝不激活）、`confirm`（独立确认者向 Bridge 入口提交；由 Bridge
  校验载体并写权威行）、`status`（经同一 verifier 回读 Bridge 账本，是回读不是自证）。
- `standing-authority-activation-e2e.test.ts` 用真实 route、真实 store、真实 lead-lease 库
  （本进程作为已绑定 pane）和账本 fixture 做一次端到端激活：作者 Lead、过期 generation、
  codex 形状 claim 各被 403；确认后 `loadVerifiedStandingAuthority` 与 `status` 回读到
  `confirmerIdentity=flywheel-cos-lead`、`carrierClaim=claude-lease:g1`，且确认者 ≠
  author/implementer。这是隔离环境证据，生产条目仍未激活。

**硬红 2：整文件 `registry_digest` 让无关改动拒绝部署。** `4932d971e`：

- `scripts/lib/raya-registry-identity.jq` 与 `raya-registry-identity.ts` 定义 Raya 作用域
  投影：Raya 项目行 + Raya lead 行（去掉 model/effort/modelContextWindow）。vitest 对同一
  组 fixture（含非 ASCII、控制字符、畸形形状）跑 jq 并断言两实现语义相等。
- `updater-raya-deploy.sh` 的预激活 rebind 门改为语义比较投影：账本带 `registry_identity`
  时只对 Raya 身份漂移 fail-close，并以 `raya-registry-identity-drift:<paths>` 具名；旧的
  整文件账本字节未变仍可通过，字节变了只有当 Raya 行仍匹配迁移独立冻结的事实
  （`lead_bot_user_id`、canonical `projectDir`、canonical 载体）才放行并原位升级账本；
  注册表不可读或旧账本无法核验各有独立原因。`RAYA_DEPLOY_STATE/DETAIL` 对保持精确
  `awaiting_rebind/awaiting_pre_activation_rebind`（观测分类器依赖），具名原因经
  `RAYA_DEPLOY_REASON` 进入 refused 回执与班车日志。
- `raya-migration-init.ts` 新账本记录 `registry_identity`；`raya-migration-proof.ts` 在冻结投影
  存在时比较投影（`proof-registry-identity-drift`），仅旧账本仍绑整文件字节。
- 19 个差分臂跑在真实门上：frozen/legacy 两种账本 × 无关 Lead effort、新 Lead 行、9-19 的
  尾换行、Raya tuning 均部署；Raya bot/载体/工作区/整行删除均拒绝并列出字段；另有
  `updater_raya_pass` 全程往返断言状态对与回执原因。

**硬红 3：两个存活变异体。** `77e6cb9d1`：

- vitest：十条经 digest 绑定、其他前提全部满足的非匹配 founder 意图必须
  `intent-unverified`；八条必需播报行逐条删除必须 `announcement-unbound`。
- `request-restart.test.sh` 原本全程用 node shim 驱动 transport，dist 变异体永远绿。新增块
  用真实 `packages/teamlead/dist/bin/restart-request.js` 断言同样的负例，让不可变包实际运输
  的字节被证明。
- 变异验证：源码两处 `if (false)` 分别令 v3 vitest 红 10/20、1/20；dist 两处令 shell 套件红；
  全部还原并核对 dist 哈希一致。

本轮没有发真实重启票、没有动生产 `~/.flywheel/raya/migrations/*/manifest.json`、没有激活
生产条目、没有跑本地全量。QA2 要求的 529 N-to-N confirm 往返与真实 #engineer 播报仍属
QA 在其权限内完成的验收。

## 代码复审 round 5（QA2 返工头）HIGH 修复（2026-09-22）

同家族复审门 `14a28091`（request `e2ab8940`）对 `f160650ef` 判 CHANGES_REQUESTED：1 HIGH、
5 MEDIUM、1 LOW（MEDIUM/LOW 按 `medium_low_findings_are_non_blocking_v1` 进 PR Follow-ups）。

- HIGH `intent-ledger-reprepare-after-sideeffect-failure`：`transitionRestartIntent` 的
  `failed → prepared(zeroSideEffects)` 合法项没有检查 `prior.zeroSideEffects`，而 updater 在停服
  后的部署失败写的正是不带该标志的 `failed`，于是同一 founder 意图可被重新 prepared 成第二波，
  且账本被改写成“上一波零副作用”。修复：该合法项要求 `prior.zeroSideEffects === true`；并新增
  `side-effects-not-provable`——只有 `prepared` 行（→ consumed-no-deploy）或已带标志的行才能携带
  zeroSideEffects，`started/failed/unknown` 行永远不能事后加戳。旧 v2 测试里
  “started → failed(zero) → 换票”是同一漏洞的语义，改为断言新不变量。vitest（v3 + legacy）与
  dist 驱动的 shell 块都新增 prepared → started → failed → 再 prepared 的回放，断言 `already-used`
  且账本行保持 `failed` 无标志。
- MEDIUM `standing-state-dir-env-ignored-by-ts-consumers` 一并修：新增
  `resolveStandingAuthorityStateDir(home, env)`，Bridge 路由、v3 producer 上下文与 Raya standing
  授权三处共用；否则 529 slot 设置 `FLYWHEEL_STANDING_AUTHORITY_STATE_DIR` 时 shell 篱笆已进包而
  TS verifier 读默认目录报 `standing-authority-inactive`。
- 其余 advisory（revision-2 audit 键、waiver 可达性/范围、withdrawal 水位、summary preflight 的
  tsx 来源、legacy 注册表 fallback 只核四字段）记入 PR Follow-ups，未在本头改动。

## 代码复审 round 6 HIGH 修复（2026-09-22）

同家族复审门 `f90e7909`（request `c4de99a5`）对 `a9578e177` 判 CHANGES_REQUESTED：round 5 的
HIGH 只堵了同一次调用内的加戳，但行写入 `...prior` 让 `zeroSideEffects` 跨状态粘滞——producer 的
合法重提交（prepared → prepared，`rr_mark_prepared` 总带 `--zero-side-effects`）会在 prepared 行
种下标志，随后 started、停服后的 failed 都继承它，于是又满足 `failed + prior.zeroSideEffects`
的换票条件。修复 `c…`（见 git log）：行写入显式剥离继承的标志，只有本次调用证明（守卫已过）或
“非 started 且前态非 started”才保留；即 `started` 一旦铸出，该行与之后所有行都不带标志。
vitest 与 dist 驱动的 shell 块新增回放：prepared(零) → prepared(零) 种标志 → started 后标志消失
→ failed 无标志 → 再 prepared 被 `already-used` 拒绝。

同轮 MEDIUM `v2-recovery-refusal-not-recorded-terminal`：`update-flywheel.sh` rc=82 分支对已
`started` 的 v2 恢复票写 `failed --zero-side-effects`，会被新守卫拒绝且被 `|| true` 吞掉，行停在
`started` 可再消费。改为记录不带标志的 `failed`（started → failed 合法），`update-flywheel-sources`
新增静态断言锁住该分支。LOW `standing-state-dir-dotenv-only-value-diverges`：v3 producer 改为只从
进程环境解析 state dir，与 shell 篱笆和 Raya 路径一致。

## 复审 round 7 APPROVED 后的 origin/main 技术同步（2026-09-22）

`8417fc68b` 取得同家族复审 APPROVED（gate `57fe1158`，round 3；剩一条降级 MEDIUM 进 Follow-ups）
后，GitHub 对该头不建任何 check suite：`origin/main` 在 05:01 前进到 `54e314f75`（FLY-2736/2499/
2763 R3/2693/2746/2643/2763 R2 七个合入），PR 变为 `mergeable=false / dirty`。按 QA2 判据做技术
merge `b736c0198`：唯一冲突是 `fly2567/legacy-bundle.json`（两侧都在同一 rules bundle 摘要上追加
各自合同描述），合并 meaning 同时保留 FLY-2643 与 FLY-2654，并按测试自身的 materializer 重算
合并后 body 字节数与 sha256；其余（`raya-migration-init/proof.ts` 的 `LEAD_LIVE_VERIFY_TIMEOUT_MS`、
plugin/StateStore/truth/ci.yml/restart-services）由 ort 自动合并。未改任何 FLY-2654 语义。

## 第二次 origin/main 技术同步（2026-09-22）

`cf5bc0e7f` 的 round 8 复审与自动 CI 尚未结束时，`origin/main` 又合入 `48603db64`（FLY-2751，PR
#1274），同一 `fly2567/legacy-bundle.json` 摘要 fixture 再次冲突。merge `a746b4ad4` 用同样方式解决：
meaning 合并 FLY-2643/2654/2702/2751，按测试自身 materializer 重算 body 241960 字节 /
`a45ce4d6…`；`StateStore.ts` 由 ort 自动合并。无 FLY-2654 语义改动。round 8 门对旧头的判决不复用。

## 代码复审 round 9：常驻规则预算与两条 MEDIUM（2026-09-22）

同家族门 `03aa96c5`（request `93fad7a9`）对 `26ebe8c1f` 判 CHANGES_REQUESTED：HIGH
`resident-rule-budget-exceeded-after-main-sync`——FLY-2567 常驻规则预算门（`fly2567-rule-budget.test.ts`，
上限为 `rules-inventory.json` bundle_chars × 0.75 = 161258.25 码点）在该头 161970，超 711.75；本单
`founder-only-authority.md` 相对合并基线 +2146 码点，而 main 新合入的 FLY-2643/2751 规则用掉了余量。
这是 teamlead 3/4 分片的真实 CI 红（run `35690033639` 亦因此失败）。修复只裁剪 BEGIN/END 条目
标记之外、本单新增的导语/说明（R4 “transport, not the right to initiate” 段、R4 票据来源与
硬红线措辞、R1 Raya 段两条 bullet、AUTH-CANON(B) 清单导语与 entry-extraction 说明、R5 导语、
例外句），共 −765 码点，条目正文字节与两个 entryDigest（`46b0b883…`、`224e0c79…`）逐字节未变，
pending 示例 manifest 无需重算；`lead-rules-bundle.test.ts` 钉住的 `com.flywheel.lead.raya-raya` 等
短语保留。`legacy-bundle.json` 的 bundle 摘要按测试 materializer 重算为 241089 字节 / `8abcc826…`。

同轮 MEDIUM 一并修：① `merge-added-out-of-package-executions`——main 的 FLY-2643 在
`restart-services.sh` 新增三处 `${FLYWHEEL_DIR}/scripts/...`（verify-agent-visibility、bounded-run），
改为 `${FLYWHEEL_RUNTIME_DIR:-${FLYWHEEL_DIR}}`，并在 `test-restart-services.sh` 加源码断言：不允许
任何 `${FLYWHEEL_DIR}/(scripts|packages)` 引用、RUNTIME_DIR 形式 ≥ 48 处，防止后续 merge 悄悄扩大；
② `intent-ledger-reprepare-after-sideeffect-failure` 最后一个种子——`started` 转换携带显式
zeroSideEffects 一律 `side-effects-not-provable`，vitest 与 dist 回放各加一条断言。

## QA3 路由性返工：第三次 origin/main 同步（2026-09-22）

QA3（request `rework:134f200d…`，base `639f15185`）判定全部判据通过（含 529 真实 Discord 播报臂
3/3、复用 attempt-1 harness 的 12 臂注册表差分、两处 dist 变异体红），唯一阻塞是 main 在跑判期间合入
`6706d59a5`（FLY-2758：Raya P4b install 失败时恢复标准 Lead），PR 转 CONFLICTING。技术 merge
`c18a8f060`：唯一冲突 `scripts/__tests__/updater-raya-deploy.test.sh` 为两侧在文件末尾各自追加的
用例块，按“两侧意图并集”保留本单 19 个注册表差分臂与 FLY-2758 的 restore 用例；
`scripts/lib/updater-raya-deploy.sh` 由 ort 自动合并。QA 指出 FLY-2758 改动的正是预激活门所在 lib，
因此在合并树上重新跑了完整 Raya deploy 套件（105/105）而不是沿用旧证据。无 FLY-2654 语义改动。

## Land 冲突返工：第四次 origin/main 同步（2026-09-22）

founder 已批准 `c73b17632`，但 land 时 `origin/main` 已前进到 `58693d28c`（FLY-2655 / FLY-2688），
PR 再次 CONFLICTING（Lead 返工 `rework:99fff4fa…`，implement attempt 5）。技术 merge `8c263bbba`：

- 唯一冲突 `fly2567/legacy-bundle.json` 头部四字段。meaning 两侧并集（本单 FLY-2654 条目 + main 的
  FLY-2655 voice duty 条目），revision 取 main 的较新值；bodyBytes/sha256 用测试自身 materializer
  从合并后规则字节重算，未手改哈希（242017 = 239088 基线 + 928 main + 2001 本分支）。
- `StateStore.ts`、`bridge/plugin.ts`、`ci.yml`、`truth.ts`、`deployment.ts`、kill-path 清单、
  `ci-structure.test.sh` 由 ort 自动合并；两侧改动区域不相交（main 为 voice，本单为 standing authority）。

合并后 FLY-2567 常驻规则预算门转红：main 的 FLY-2655 在 `department-lead-rules.md` 常驻加 14 行，
main 自身 160354 码点、余量 904；本单净增 1381（两个条目标记块 1737，标记外已净减 356），合计
161735 > 161258.25。按 Lead 对问题 `f86cf144` 的裁定（选 A、范围收窄）提交 `981f0aa4b`，只压缩
四段非规范叙述，够 477 即停：

| 段落 | 改前要点 | 改后 | 语义不变的理由 | 码点 |
|---|---|---|---|---|
| Executor-merge 的 FLY-921 历史 | 10 行事件叙述 | 6 行，保留时间线、三件手工活、reconcile “backstop — not permission” | 历史叙述，不产生授权；否定授权的括号句原样保留 | −178 |
| Roadmap「per-context trust tier」四条 | 含示例“scheduled overnight ship”、冗长 end-state | 同四条要点，删示例与重复措辞 | 该 phase 标题即 “not authorized”，内容是展望 | −197 |
| Track 2 关系段 substrate 段 | 5 行解释 | 3 行一句 | 解释性；“not a source of authorization” 等规范句未动 | −85 |
| R1「Why today not yet」 | “Today the rule routes back to the founder so that…” | “Routing to the founder surfaces that mismatch…” | 同义改写一句 | −22 |

合计 −482 码点，常驻总量 161253 ≤ 161258.25。R1–R5 条款、AUTH-CANON、R4 红线与传输段、R5 导语、
任何“谁能做什么/什么不算授权”的句子均未改；两个条目块逐字节不变（entryDigest `46b0b883…`、
`224e0c79…`，与 pending manifest 示例一致，脚本比对）。legacy bundle 重算为 241531 字节 /
`9f810d93…`（242017 − 486 字节）。未改 FLY-2567 预算上限，未把规则移到按需文档。无 FLY-2654 产品语义改动。
