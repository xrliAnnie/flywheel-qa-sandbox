# FLY-2560 机器试判证据接通 — 实现记录
Issue: FLY-2560 (https://linear.app/geoforge3d/issue/FLY-2560)
日期: 2026-09-14
基于: plan.md

## 当前游标

A-D 已实现，真实回放与 C1 新观察已记录于下文。当前待新头代码评审、PR 精确头 CI 及 needs_review 交接；历史测试收据按各批次保留。

设计批准收据在 `.flywheel/runs/4b67caf9-bfef-49f9-a0ef-8985c0b57510/codex/design-review.json`：
APPROVED，request `765b9c11-04ad-4774-be70-3244cc0f956c`，Lead acceptance
`49a83a3c-f193-4516-8f8b-a43162f58b99`。本次执行保持该设计。

## A：因果及验证

- 实际 `readShipJudgmentRepositories` 用未归一的 primarySlug 初始化 map，再和数据库 slug 直接比较；
  `Owner/Repo` 对 `owner/repo` 返回 undefined。先写测试，观察 1 failed / 1 passed。
- 仅对通过 slug schema 的配置和绑定 slug 做小写归一；不同 owner/repo、无效 slug、未封存 manifest 仍 fail closed。
- preflight 在 dry_run 启动以及卡采集时运行，空仓库、错误 slug、缺 Linear 凭据、缺 GitHub 凭据分别给出原因。
  凭据读取在 20 秒后收口，即使 resolver 不响应 AbortSignal；不记录 secret 或原始异常文本。
- 运行时缺输入写入 `input_unavailable:<reason>`，同原因诊断去重；off/auto 启动不触发凭据读取。
- 旧行输入失败路径显示「输入不可得」，不再显示「0 仓」。新账本三行文案属于 C。
- 红：preflight 8 failed（API 不存在）；runtime 2 failed / 3 passed（原 reason 为 project_sources_unavailable）；
  render 1 failed / 1 passed（原文含 0 仓）。
- 绿：`VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run`
  加 repository-scope、ship-judgment-input-preflight、ship-judgment-runtime、render 四文件：**17 passed**。
- `pnpm install --frozen-lockfile` 成功；初始 `pnpm -r build` 成功。
	实现后 `pnpm --filter flywheel-teamlead exec tsc --noEmit` 通过。
  本阶段上述六个格式化文件的 Biome 检查通过。全仓 lint、实现后全仓 build、aggregate package gate、review、PR/精确头 CI 尚待执行。

## 验收边界

C1、C3 尚未达到：未跑真实卡片离线回放或发布报告。C2 的本地缺 QA / 缺设计独立判定测试通过；线上采集和新卡面已接入，完整验收仍待真实回放。
快照必须使用当前 runner 合同指定的 `scripts/flywheel-snapshot-control.mjs runner`，不直接复制生产数据库。
未改变权限或 auto 开关，未 dispatch QA、merge、deploy。

## B：账本与权威读取（在线接入待续）

- `evidence-ledger.ts`：固定 schema、目标逐个判定再聚合、空 diff base 保持 null；缺设计/QA 各影响本项。
  模型只可否决；账本摘要排除观测时间，包含证据身份与目标摘要。纯 reducer 20 项通过。
- `evidence-authority.ts`：StateStore 包装只读查询，设计按 issue aliases + repo 读取最新状态，manifest 按 execution 关联；
  code 按精确 head；QA 按 repo/head、as-of QA attempt、issuer、候选一致性、撤销与过期判定。
  10 项实库测试先红后绿，验证未来 permanent claim 与未来 revocation 不倒灌。
- `evidence-migration.ts`：事务内父表重建，原列、约束、索引和三条触发器原文保留；
  FK 关闭期间临时启用 legacy_alter_table，避免其他表的触发器在父表 drop/rename 间隙引用不存在表；finally 恢复两项 PRAGMA。
  4 项测试通过：空库、3 旧意见加 clarification、重复迁移、无效 FK 回滚、StateStore 新库启动。
- `opinions` / `delivery`：可持久化无模型 input/evaluation 的证据意见并读回；校验目标集合、manifest revision、机械判决，
  语义身份只取数据库 evaluation。仅时钟变化不重复发布；证据变化仍走既有节流。
- `outcomes` / `learning` / `statistics`：无 input 时从已可见 evidence opinion 解析原目标集；
  证据策略与模型策略分开，未跑模型用 null，参与学习。新增端到端与既有回归共 59 项通过。
- outcomes 新读取 workflow_run_event 已登记 retention consumer `protect`；未新增表。
- 本批最终聚焦验证：evidence-authority / ledger / migration / opinions / learning 五组新测试，
  加既有 opinions / learning / outcomes 回归，**8 文件、100 tests passed**（77.32s）。
  包含模型返回 undetermined 时仍显示语义 undetermined、不能标为通过的回归。
  retention consumer gate：`ok:true, errors:[]`。
  本批最终代码 `pnpm --filter flywheel-teamlead exec tsc --noEmit` 通过。
- 预算问题已登记 Lead question `b5b6d27b-7eea-4d2b-b7b5-6aeb82ac4993`：
  计划中结构字段同时取上限的 ASCII ledger 实测 50,359 B，大于 49,152 B；Unicode 可更大。
  schema / DB 硬上限保持不变，最大对象预算证明尚未通过，等待明确边界；不截断仓库身份或偷偷调整结论。

下一步：一次 Git 生命周期内收集 materials、claim 报告适配器、runtime 无条件保留原料并附 ledger、history/epic 摘要；
然后 C 文案、D 真回放/托管、E 完整预算/重启/全仓验证和 review/PR/CI。

## B/C：在线原料与逐项展示

- 同一 prepared Git 生命周期缓存 diff / plan blob，确定性账本与可选语义模型共享读取。
  模型采集异常不清除已拿到的原料；采集前后复查设计、代码、QA 权威及绑定，避免复用旧材料。
- QA claim 的报告 URL 仅接受配置中的 report host、唯一 token 和已保留正文；不发起任意 URL 请求。
  缺 Linear key 只影响可选语义采集；Git/快照缺失时保留已拿到的 QA 权威。
- 卡面三行显示通过 / 不通过 / 缺具体证据；模型区分未跑、已跑但未形成否决、通过、否决。
  每条动态文本转义，整条长度预留省略说明；50 目标 / 64 refs / Unicode 压力场景不抛消息超限错误。
- Epic 和历史页增加三项短结论及缺项，不展开证据 ID；无模型意见使用证据 policy version。
- 红/绿收据：
  - claim-report / production materials：初始 14 failed；修复后 3 文件 15 passed。
  - Bridge evidence-only：初始 4 failed；修复后 4 passed。
  - 原 runtime-collect 夹具缺 responded_at，按实际完成流程补 stampCodexReviewJobResponded 后 1 passed；不放宽权威读取。
  - render：初始新增 7 failed；修复后新增及旧例 2 文件 9 passed。
  - Epic/history：初始 policy version 断言失败；修复后加 Epic 渲染回归 2 文件 4 passed。
- 本批 tsc --noEmit 通过。整合测试：19 文件，18 passed / 1 failed；90 tests，89 passed / 1 failed。
  唯一失败为既有 ship-judgment-routes 的 30 秒超时，未观察到断言不一致；原测试单独复跑仍 1 failed / 2 passed（同一 30 秒超时）。
  原红收据保留在 /tmp/fly-2560-integrated-evidence.log，不以聚焦绿替代整合绿。
  comm 同期报告 host load1=96.67 和 health deadline exceeded；这是环境观测，不作 flake 裁定。

## 外部依赖与预算裁定

- Lead question b5b6d27b-7eea-4d2b-b7b5-6aeb82ac4993 已答：
  保留 49,152 B cap 和 schema，超限明确 evidence_budget_exceeded，不产生判决、不截断身份；
  证明实际 reducer 边界与超限拒绝。plan.md 已更正 50,359 B 反例及结构最大值表述。
- 托管快照首次返回 snapshot_owner_unavailable。
  只检查环境变量是否存在，确认 execution/Bridge URL 存在而 TEAMLEAD_API_TOKEN 缺失；
  未复制生产 DB 或借用其他身份。能力恢复请求 edd38a5c-5532-4e63-b041-055f2c43fdbf 已登记。
  本地实现可继续；真实回放等授权快照可用后执行。

- 诊断续查：保持原测试/断言/timeout，在 /tmp 临时配置中把 Bridge import 移到 setup 阶段，
  检验冷导入是否耗尽计时窗口：Bridge preload 实测 **61,152 ms**，然后原测试 **3 passed**，
  首项执行 1,052 ms，测试总计 1,566 ms；完整诊断耗时 65.67s。
  收据 /tmp/fly-2560-routes-preloaded.log。这支持冷导入耗尽 30 秒窗口的因果解释，
  原始整合及单独运行仍是失败，未获门禁豁免；正式全仓门禁仍需执行。
  临时配置不进入生产代码或正式测试配置。

## D：只读回放工具及真实首轮

- 新 scripts/replay-ship-judgment-cards.mjs：决策时目标集优先可见意见的冻结绑定，再按当时 declared revision；
  primary PR 按当时 node binding 查找，不借用另一个仓库的同号 PR。
- 复用 ShipJudgmentLearning.canonical 与 EvidenceAuthorityReader，未另写一套 founder/QA 权威判断。
  canonical 拆分的红：方法不存在；绿：新增与既有 learning 共 26 tests。
- 回放函数、真实两仓 Git/squash、日期窗口、错批分母、HTML 转义、快照 inode/路径、WAL 封存只读：
  首批 14 tests 通过；随后补 diff 失败仍保留 plan 的红/绿，15 tests 通过。
- immutable SQLite adapter 使用参数绑定和只读连接，不生成 WAL/SHM、不迁移、不写生产或副本；
  输入含未 checkpoint 的 WAL 时拒绝。普通路径仍拒绝 .flywheel；唯一新增入口是明确指定、只读的托管快照。
- Lead question edd38a5c-5532-4e63-b041-055f2c43fdbf 已回答：
  runner 不持有 TEAMLEAD_API_TOKEN 是设计行为，非待修凭据。Lead 提供
  FLY-2560__teamlead-global__2026-09-15T00:10:02.469Z__4fcc8d1c-a4d2-4fd7-bfdd-1d77f10d9d19.db（0444）。
  本执行没有复制生产 DB。快照 1,745,580,032 B；
  SHA-256 9146fa9a18c63b5d45385f3c309e166200fe7b1877530b91605d67682cfe7ebd。
- 12 张首轮（17:00Z 后指定批次，排除同 issue 当日较早的卡）：会批 9、错批 0、弃权 3，
  非弃权一致率 9/9；不是最终发布结论。最大真实账本 1,737 B。
  2360 缺机器 design/code/QA 权威；2399/2496 原料 diff 超过旧 256 KiB 限制。
  原收据 /tmp/fly-2560-replay-twelve-r1/replay.json 与 replay.html 保留。
- FLY-2553 首轮未满足 C1：冻结 head 5ce2ca41，design request 3fa2ae34、code request 17fdf9d5、QA claim 1148 可读；
  但当前 PR1194 是 OPEN、head 已变为 5f1a1a72，快照没有该 PR 的 land_operation。
  不把缺失事后合入证明伪装成通过/不通过；C1 历史预检或窄范围现测裁定 question
  018a8aec-c5f1-4620-8bd7-5333e075e68e 待答。
- 新 workflow_run_event 只读消费者已登记 protect；retention gate 红（未分类）后绿（ok:true, errors:[]）。

## 真实 diff 上限修复与 E 进展

- 直接读取统计确认：2399 diff 1,287,593 B，2496 diff 604,193 B；旧上限 262,144 B。
  临时 raw diff 改为有界 2 MiB，保留其它存储/模型上限；不截断 diff 后谎称完整。
- 原料读取预算异常保留 cause code，并在 online materials 记录 diff_budget_exceeded；
  二次权威检查不能用 ready 覆盖这条输入诊断。已有 plan、QA、机械结论独立保留。
- 红：production diff_budget 仍返回 input.ready；修复后 Git reader 与 production materials **2 文件 9 tests passed**。
  新大 diff 正例及超过 2 MiB 负例均通过；原 git-input 测试断言/timeout 未变。
  首次该组两个 timeout 红收据保留，未改 timeout 后复跑通过。
- 50 目标 / 64 pooled refs 的实际 reducer 压力输出 39,110 B；
  超限 Unicode 输入明确 ledger_budget 拒绝，输入字节与身份未修改。2 tests passed。
  此证明覆盖该压力构造及真实样本，不再声称所有 schema 结构上限组合都能容纳。
- 完整 build 已启动；全仓 lint/package gate、重启补证、代码评审、PR/精确头 CI、托管 200 仍未完成。

## 2026-09-14 最终证据收敛

- 全仓 `pnpm -r build` exit 0（`/tmp/fly-2560-final-build.log`）；新增 QA 引用 helper 后 teamlead build exit 0。`pnpm lint` 首轮格式红，格式修正后 exit 0（`/tmp/fly-2560-final-lint-r2.log`），保留基线 warnings。
- 真 QA claim1148 同时含产品页、预览页、Ship report。原在线读取把多链接视为歧义；原离线读取错误取首个产品 URL。共享 `selectQaReportReference` 优先唯一明确 QA/Ship 标签，歧义拒绝，在线继续校验托管域名与留存正文。正例红→绿；同一行两个标签的负例也红→绿。10 tests pass；离线同源断言与脚本15 tests pass。
- 真实文件 migrate→close→reopen→migrate 测试通过；migration 文件5 tests pass，外键/触发器/旧记录保持。
- 12 卡最终回放见 `replay-evidence.json`：10 可批 / 0 错批 / 2 弃权；10/10 非弃权结论与 founder 一致。12 个实际决定全部为批准，不能估计错批风险。FLY-2360 缺结构化设计/代码评审及 QA claim；FLY-2496 缺批准设计，其他项独立通过。
- C1：原决策时权威证据（2026-09-14T21:26:55.531Z）+ 经 Lead 授权的新机械观察（2026-09-15T00:56:57.342Z）。固定 head `5ce2ca41b79b95980ef667c498d9bc9e9ca1e85a`；main `1e6a419cb1d20202696d9eda08781426e0ab5eee`。42 个 open PR/41 个其他 PR，分页文件数核对、每头与首尾 open 集合/main 复核稳定。merge-tree clean，但 PR1199、1191、103 有5处文件交集，②不通过。①通过（design3fa2ae34、code17fdf9d5/question9b6f01bf、diff9289960f）；③通过（claim1148、report84e47b1c）。无待补证。历史预检回执不存在，不把新观察冒充历史证据，也不纳入12卡统计。
- C1 首次临时观察脚本因给严格 inventory schema 多传字段而得 unknown，且清理方法名错误；已保留红结果，修正临时脚本后重跑得到上述明确结论。生产 schema 没有放宽。
- 托管（publish-only，无频道投递）：https://fw-reports-624a39.vercel.app/r/8eaf24628b62e947c7068a0ab11d19cb/ 。HTTP200，CSP占位符0、真实nonce script1。视觉/意见交互验证继续。
- `pnpm test:packages:run` 已启动，尚未得最终 receipt；代码评审、PR和精确头CI仍待完成。

## 2026-09-15 接手续修：阻塞迁移评审

- 接手 TURN implement epoch4；旧评审 question `79813efa-243d-4bc8-b6f3-8d0398f9fc25` 有效结论 CHANGES_REQUESTED，reviewedHeadSha `3ae08824d5aa686484e5a4a8d7c773e2ebc49153`。
- 仅修 HIGH `migration-global-fk-check-bricks-startup`：迁移外键检查限定于 opinion 和 clarification；无关历史孤儿记录不会阻断 StateStore 启动，也不会被清理。涉及表的违规仍回滚。
- TDD：新增真实文件 StateStore.create 启动回归，预置无关外键坏行，先得到 `evidence_migration_foreign_key_check`（1 failed / 5 passed）；最小修复后 **6 passed**，包含原迁移回滚、重开、触发器不变测试。日志 `/tmp/fly-2560-migration-r2-{red,green}.log`。初次夹具构造的 FK 错误已修正后再取得上述有效红收据。
- 本批两文件 Biome check --write 通过。旧本地 aggregate package gate 随前执行体中断，**interrupted — not relied on**。按 Lead handoff `44eb9386-869a-4982-b295-8451777f1d96` 不再运行 host 全套；最终以 PR 精确头 CI 为准。
- browser/mobile 验证由 QA 持有（Lead ruling `38c10ffd`），本执行不尝试 Chrome。托管报告已存在；实现交接不能声称视觉 QA 已完成。
- 原评审 1 MEDIUM / 4 LOW 为非阻塞 advisories，按仅修 blocking 指令保持本批范围；后续交 Lead 决定。

## PR CI 首轮与测试登记修复

- PR https://github.com/xrliAnnie/flywheel/pull/1202 已创建（非草稿）。首轮 CI run `34917695346`，head `2fcb11aaf3ad51fdd888d1ddb7eb1c71e38c956c`。
- Quick Gate 在执行 build 前被清单门禁拒绝：新增 `scripts/__tests__/replay-ship-judgment-cards.test.mjs` 未登记。此为本 PR 的真实遗漏，不能当基线或环境失败。
- 修复仅在既有 build 后 root Node contract suites 中增加该测试命令。当前头清单检查先红；增加登记后清单及其删除变异控制通过（62 Node suites）；回放测试 15/15 通过，日志 `/tmp/fly-2560-replay-ci-wiring-green.log`。
- 原 head 的代码评审 question `5095a16d-e382-44ba-8ab3-2bbeb5028704` 已登记 request `eb699fb2-9ac0-404b-9cb9-edc7d1bbb665`，CI 修复准备期间仍 pending。不在评审运行中推送；待评审结束后提交新头，重新登记精确头评审和 CI。
- 该轮最终有效 verdict **APPROVED**，reviewedHeadSha `2fcb11aaf3ad51fdd888d1ddb7eb1c71e38c956c`。2 MEDIUM / 3 LOW 已通过 ask --report 交 Lead 决定后续：旧 input 意见优先、无效 QA 状态文案、QA report 留存 digest 比对、迁移并发启动、共享 preflight 取消。无 blocking findings；本次 CI 修复不扩展这些范围。新头仍须新评审。

## QA返工 attempt2：卡面已知失败优先

Lead instruction `26ec0fa1-978e-4382-8576-920fc177cbeb`，QA claim1159，对53426fc31的真实规模在线采集FAIL。原精确头CI与评审通过不代表线上输入验收通过；完整QA分析见 `/tmp/fly-2560-qa/qa-report.md`。

首个回归：①fail + ③missing 原标题为「缺证据：③」，新增断言先红（1 failed/7 passed）；仅调整账本卡面标题优先列出已知失败项，逐项缺证据文案保留，不改权限/auto或聚合存储语义。修复后8/8通过，Biome通过。日志 `/tmp/fly-2560-rework-headline-{red,green}.log`。

下一步仍须完成库存预算/部分缓存、刷新失败不丢Git原料、机械快照失效诊断、42+PR/370files全链集成证明，再一次推送/新评审/CI/交接；本条不是返工完成。

## QA返工 attempt2：规模采集补证

- PR 身份及 main 分页完成后立即发布只供 Git 准备的 metadata；文件库存继续刷新，最终机械判定仍要求完整且未过期的快照。刷新失败/抛错不丢已读 diff、plan、QA，失效快照明确 input unavailable。合并缓存只在完整快照核验后写入。
- files 分页由20改100，保留2MiB响应上限与分页安全校验。新头仍核对逐PR身份、changed_files与重复路径；相同头的已验证文件和身份共同复用。部分刷新失败保留已验证缓存，fetchedAt=null，不能作为有效机械库存；重开后仅用于下一轮复用。120/h预算不变。
- 红收据：分页100、metadata提前可用、库存失败保留独立原料、过期快照诊断均先失败。修复后8文件48项通过；增加refresh抛错保护后production-evidence/production-scale共12项通过。teamlead build及类型检查通过。全仓lint一处新格式问题修正后exit0，保留18项既有warnings。最终新增抛错保护后tsc再次exit0。日志位于 /tmp/fly-2560-rework-*.log。
- 真实Git集成42个PR，含370/289文件PR，实跑prepareJudgmentGit、FrozenGitReader及merge probe：首次93请求，三项通过；同头第二次仅4请求，总97。强制429时①③仍通过，仅②缺机械库存。测试以plan实际读完才放行文件请求，证明两条路径解耦。
- 真实GitHub只读观察见 rework-production-observation.json：本地构建候选代码、远端旧PR头53426fc31，93请求、34.455秒，diff62文件完整、input ready，1仓41个其他在飞PR。②因真实13处交集不通过，标题不可自动批②。当前attempt2缺有效设计/QA权威，因此①③诚实显示缺证据；此观察不声称三项通过，也不是最终推送头QA。scratch数据库，无生产写入。
- 前一头评审/15项CI绿并未覆盖真实规模采集缺陷；本轮仍待新精确头review、CI以及独立QA。无权限/auto变更，无host全包重跑。

## implement attempt3：冲突后新评审 HIGH 修复

- 同步 main f022a0a7e 并保留双方 retention 登记后，新头7d5b7ac7e CI15/15通过；有效评审question95fc0741为CHANGES_REQUESTED，不能交接。
- Lead question2626e70e-2af1-4c8d-aab3-2ccafe148104授权仅修 `refresh-failure-discards-prior-file-cache`，其余3 MEDIUM/4 LOW记录于follow-ups.md，不作行为修改。
- 真实SharedProjectRefresh/StateStore路径：先缓存两个PR，再让metadata的api.prs抛request_budget_or_lease；原实现cacheForReuse从2条完整记录变0。第二条回归：改变首个PR头并让files返回rate limit，尚未遍历的第二个PR旧缓存变files_pending。两条先红（2 failed/1 passed），修复后3/3绿。日志 `/tmp/fly-2560-warm-cache-{red,green}.log`。
- 最小修复：失败partial与同configurationDigest的prior合并，保留尚未遍历的PR；同repo/PR/head/base的完整文件可复用，已观测不同head/base必须重新抓取。失败仍error、fetchedAt=null、mechanical_digest=NULL且不保留merge probes；read不能当fresh。schema 200 PR / 200仓和4MiB上限保持；合并越界保留此前有界cache，最终字节守卫仍拒超限。
- 4文件24项相关测试通过，含42PR/370和289文件、120请求预算真实Git集成及失败原料保留。全仓lint通过。未跑host全套；旧头CI不替代下一个新头。新头仍需review/CI后needs_review。
- teamlead build首轮TS2559（codex-daemon-teardown的beforeSignal/gracefulOnly）：main源码已有字段而本地claude-runner dist声明过旧。按依赖顺序重建flywheel-claude-runner后teamlead build exit0，无源码修复。日志 `/tmp/fly-2560-sync-runner-build.log`、`/tmp/fly-2560-warm-cache-build-r2.log`。评审LOW的本地复核失败因此已定位为陈旧产物，不再认作main源码缺陷。
