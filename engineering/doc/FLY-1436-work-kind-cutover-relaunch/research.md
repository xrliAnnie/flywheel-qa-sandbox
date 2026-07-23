# FLY-1436 work-kind cutover 解冻返工 — 调研
Issue: FLY-1436 (https://linear.app/geoforge3d/issue/FLY-1436/解冻1418-work-kind-binding-cutover-分档路由上线解锁-honey-lemon接替-fly-1418)
日期: 2026-07-22
基于: exploration.md

所有 file:line 均在本 worktree(= main `948275e3` 派生)或生产机就地核过;继承自 FLY-1418 research 的结论均已对当前 branch 重验,凡行号/事实有漂移处以本文为准。

## 1. 上游状态(全部就位,1418 时代的 blocker 已清零)

| 上游 | 状态 | 证据 |
|---|---|---|
| FLY-1407 引擎 | ✅ merged | work-kind 校验/路由/收据面全在(§4 逐点重验) |
| FLY-1380 模板 | ✅ **ship + 部署 + FLY-1432 独立 QA 真机全过**(PR #678/#679) | 生产 `workflow_template` 12 行全 published rev 1、零 retired;ship-note「warm 零新 binding audit row」验收已过 |
| FLY-1380 activation 工具 | ❌ **未交付**(设计内不交付) | ship-note.md:37「那些动作属于后续一次性 cutover 及其 activation gate」 |
| FLY-1402 launcher ①拍 | ✅ Done | bundle 拼接 + `RULES_BUNDLE_SHA` 哨兵(§8) |
| FLY-1418 design | ✅ codex-approved R8 + Bridge review APPROVED,冻结于执行前 | `flywheel-FLY-1418` branch doc 文件夹;重开门条件 = 本文 §7/§4/§2 逐条覆盖 |
| founder corrections | ✅ 生效 | ①absent 软兜底、②route 可见性(1407 lineage);③Lead 通用性(`design-correction.md`,folded 为 1418 C15,本单全文继承) |
| 解冻授权 | ✅ Annie 2026-07-23 03:18 直令解冻立修 | FLY-1436 issue 正文 |

## 2. 生产现状(2026-07-22 实测)

- **binding**(`sqlite3 ~/.flywheel/teamlead.db`):6 项目各恰一行 `*→tpl_eng_heavy`(`updated_by=system:bundled-default`),零词表外行。⇒ cutover 写入 = flywheel 替换 1 行 `*` + 新增 5 exact(其余 5 项目不动)。
- **模板 registry**(实测,advisory ②③ 的 ground truth):12 模板全 `current_published_revision=1`、`retired_at IS NULL`。schema_version:**`tpl_generic` / `tpl_product_v1` / `tpl_product_designer` / `tpl_product_prototype` = 2;`tpl_eng`(tier_presets: trivial/light/heavy)/ `tpl_eng_land_v1` / 全部存量 `tpl_eng_heavy|light|trivial(+_land_v1)` = 1**。`tpl_eng`@heavy ≡ `tpl_eng_heavy`(yaml diff:tier preset 补回 implement `effort: xhigh`,其余逐字段等价)。
- **flag 域**(活 Bridge 进程 `ps eww` + `~/.flywheel/.env` 双证):`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`、`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1`、`FLYWHEEL_WORKFLOW_CLAIMS_READ=1`;**`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` 不存在 = off**(registry default false)。**翻转载体(codex R1-1 纠正)**:`workflow_generalized_templates` 与 `workflow_template_dispatch` 在 registry 均为 **`toggleable: "direct"`**(FLY-1344 founder-controlled lever,`registry.ts:3076-3079,3030-3033`)——官方路径 = `flywheel-comm feature-flags` stage→single-use confirm→apply(`flywheel-comm/src/commands/feature-flags.ts:91-149`),apply 在锁内做 `.env` SHA-CAS + live 值 CAS → 原子持久化 → mutate 活进程 `process.env`(`flag-toggle.ts:109-155`),**免 Bridge 重启、自带 audit**。手编 `.env` + 重启的方案废除(绕过 CAS/confirm/audit 且引入无谓重启半径)。
- **config**:仅 flywheel 有 `pipeline:` 段(`three_stage: true`、`dag: true`,`.flywheel/config.yaml:258-268`);`work_kind` 键全 fleet 不存在。`work_kind` 硬依赖 `dag:true`(`three-stage-config-source.ts:96-101` `work_kind_requires_dag`),flywheel 满足。
- **work-kind 收据面**:`workflow_route_decision` 生产 **0 行**(off 域从未触发,负空间旁证)。
- **CoS 基线**:三个 CoS 的 installed plist(`com.flywheel.lead.{geoforge3d-cos-lead,flywheel-flywheel-cos-lead,tidal-echo-tidal-echo-cos-lead}.plist`)**全部已含 `FLYWHEEL_LEAD_ROLE=cos`** 实测 ⇒ launcher 字面量臂(`claude-lead.sh:2160-2163` 只匹配 `cos-lead`)的口径缺口被 plist env 臂覆盖;③拍前 verify-or-set(幂等)扩为三 CoS 全核。
- **updater plist 漂移(新发现)**:生产已装 `com.flywheel.updater.plist`(mtime Jul 5)= **06:00-only calendar、无 `QueueDirectories`**;仓库模板已是 00:00/12:00 + QueueDirectories。⇒ marker 入队后的触发只有 `ssr_kickstart`(`self-ship-restart.sh:93`)与 06:00 calendar;fallback sweep 的意外触发面比 1418 分析的更窄(无 QueueDirectories 持久触发)。本单**不收敛 plist 漂移**(scope 纪律,呈报即可);窗口选择避开 06:00。
- **self-ship queue**:`~/.flywheel/self-ship-pending.d/` 现存 1 活 marker(Jul 22)——cutover 前置检查必须含「queue 内无外部 pending marker」项。

## 3. 生效面矩阵(步序的物理基础;继承 1418 §3,按现状修订)

| 行为源 | 生效动作 | 验证 |
|---|---|---|
| `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES`(env) | **audited direct-toggle**:`flywheel-comm feature-flags` → Bridge `/api/fleet/flag/{stage,apply}`(SHA-CAS + 原子持久化 + live `process.env` mutate,**免重启**;§2 flag 域) | 活进程 `ps eww` + `.env` file 双证 |
| `pipeline.work_kind`(config.yaml) | 每次 dispatch 现读生产 canonical checkout(`three-stage-config-source.ts:1-14` 只读 mainline,不读 worktree)⇒ **生产 pull 即生效,免重启** | 下一发派单 route decision |
| `pm-executor.md` / `prototype-executor.md`(`.flywheel/agents/engineering/`) | fresh spawn 读盘 ⇒ pull 即生效 | 金丝雀 spawn 注入 prompt |
| `department-lead-rules.md` + identity(bundle 装载) | merge + deploy 后**重启 Lead** | 哨兵读回(§8) |
| Gemini `dispatch_runner` schema | **deploy 含 `pnpm build`**(dist 不随 pull 下发);voice-bridge 非常驻,下一次 voice session 生效 | 生产 dist import 断言 |
| binding 行(teamlead.db) | 写入即在场 | exact 复读 + audit row |

## 4. 窗口语义核证(GENERALIZED-off 世界;本单最重要的重验)

### 4.1 「v2 binding 已写 + GENERALIZED off」= keyless 派发 409 全瘫(非静默改道)

逐点(当前 main):candidate 解析**不看 flag**(`workflow-template-selection.ts:58-131` 纯查表)→ schema-2 candidate → DAG entry 被 `generalized_disabled` 拒(`runs-route.ts:1351-1355`,`workflow-template-dispatch.ts:29-41`)→ 三段块因 `candidateSchemaAtEntry !== 2` 不成立被跳过(`runs-route.ts:1396-1400`)→ `v2Entry` 成立(`:1551-1556`)→ selection 内 `blocked` throw(`selection.ts:189-190`)→ **409 `GENERALIZED_WORKFLOW_REJECTED`**(`runs-route.ts:1626-1631`)。
⇒ **硬次序:binding 写入必须在 GENERALIZED=1 于活 Bridge 进程生效之后**;且**回滚域里「关 GENERALIZED」「revert work_kind」在本单目标 binding 已写时都会制造这同一个 409 瘫痪**(off 域 keyless lookup `*`→v2 同路径)。精确表述(codex R1-2):触发条件是 **keyless 实际选中 schema-2 candidate** —— 本单目标集的 `*→tpl_generic` 恰好满足;不是「任何 v2 binding 在场」的全称命题(仅 exact 五行、`*` 未动时,keyless 仍走 v1 `*` 行)。⇒ 1418 lever ① 的「主 flag off = 紧急 containment」在 **Normal 回滚域**被推翻,**binding restore 升为正常回滚第一杆**;但 `TEMPLATE_DISPATCH off` 在 candidate 解析**之前**短路(`runs-route.ts:1288-1301` `!workflowDispatchEnabled` → candidate-free legacy,test `runs-route.dag-entry.test.ts:283` 实证)——它仍是 **Emergency containment 杆**(restore 控制面自身故障时唯一可用,§7.3 双路径)。

### 4.2 翻 GENERALIZED=1(binding 未动)的行为边界(codex R1-2 修订)

直接读点三处:`workflow-template-dispatch.ts:38`(blockReason 对 schema-2)、`StateStore.ts:13289,13475`(v2 revision authoring guard,admin 面)。但 **blockReason 是共享谓词**,间接控制 selection / materialization / **active-run admission·recovery / side-effect consumption**(`StateStore.ts:13844-13860,15934-15948`、`workflow-engine-dispatcher.ts:877-890`、`runs-route.ts:1083-1099`)⇒ 翻 on 除影响未来请求外,还可能**释放此前因 flag off 被 hold 的 schema-2 active run / pending side effect / start reservation**。本轮只读实测三者均为 0(生产从未有 v2 run),但这是会漂移的状态 ⇒ **apply 紧邻前置必须重跑 fail-closed 三零 preflight(active schema-2 run=0 / pending schema-2 side effect=0 / schema-2 reservation·recovery 待收敛=0),任一非零停下呈报**。诚实边界:①显式传 v2 `templateId` 从 409 变可 materialize;②v2 authoring 解锁(无 caller);③上述 held-state 释放面(由三零 preflight 收口)。

### 4.3 Step 2 窗口(work_kind on + binding 未写)行为格(继承 1418 C4,重验)

- absent → `genericFallback`(`runs-route.ts:1259-1264`)→ `freshNoThreeStageLegacy`(`:1284-1286`)→ candidate-free(`:1288-1301`,**不查 binding**)→ legacy 单 session + `WORK_KIND_DEFAULT_FALLBACK` outbox 提醒(`:2449-2483` 域)✅
- 显式合法 category → exact 查询缺行 → `WORK_KIND_BINDING_MISSING` 409(`selection.ts:72-81`,fail-loud)✅
- 非法 → 400 `INVALID_TASK_CATEGORY` + allowed 词表(`runs-route.ts:1218-1228`)✅;非法 routingOverrides → 400(`:1205-1215`);`no-three-stage` override 与 category/templateId 同传 → 400 `ROUTING_CONFLICT_CONFIRM_REQUIRED`(`:1248-1258`)
- templateId 显式 → 照走(fresh-eligible 校验 `selection.ts:84-95`)✅
- **partial 写入态**(工具崩溃):已写 kind=终态行为、未写 kind=409、absent 不受影响——无静默错误路由;消灭 partial 终态 = 写入工具单事务硬要求(§6)。

### 4.4 终态行为格(work_kind on + 六行已写)+ P5 route 证据(advisory ②③ 收口)

- `code` → exact `tpl_eng`(schema-1,tier default heavy)→ **`pipeline_dag_v1` route**(dagEntry,`dag-auto-` key;`runs-route.ts:1367-1379`)≡ 今天 tpl_eng_heavy 形态;
- `prd|designer|prototype|research` → exact schema-2 → **`workflow_v2` route**(`wf2-auto-` key,`:1551-1563`);
- absent → generic 单 session + 提醒(同 4.3);非法 → 400;
- `*→tpl_generic` 行:on 域 keyless **不消费**(absent 走 candidate-free);其消费面 = 未来 work_kind off 回滚域 keyless(GENERALIZED on 时走 v2 generic;off 时 409 —— §7.3 时点矩阵);
- incumbent wildcard 复核(advisory ③):`*→tpl_eng_heavy` schema-1、published、未 retired,六行现状与 1418 快照零漂移。

### 4.5 ②拍先行(翻转前)安全性(继承 1418 §7,重验)

off 域显式传 category → `workKindEnforced=false` → 非法 string 不拒(`selection.ts:72-76` 只在 enforced 时抛)→ exact miss 回落 `*→tpl_eng_heavy`(v1,= 今天 keyless 同路);产品单照 agent 文件带 `no-three-stage` → label 继承(`runs-route.ts:1286`)→ legacy 单 session。⇒ ②③拍与翻转间天级窗口行为不变;②拍文本纪律:不得让 Lead 提前停带 `no-three-stage`。

## 5. 改动面逐文件(更新行号)

1. **`packages/gemini-agent/src/tools/schemas.ts:66-94`**(dispatch_runner,现 `required:["issueId","projectName"]`):加 `taskCategory` required enum(5 值 mirror `work-kind.ts:2-8` + 同源断言测试)。handler args 直通,零 handler 改动。
2. **`packages/teamlead/lead-rules-base/department-lead-rules.md:140-192`**(「Action Gate: When to Start a Runner」):新增通用 work-kind 派发指引(C6 dual-state 文本 + C15 参数化 `<lead_id>` 示例)。今天 0 处 taskCategory(全 base 目录 grep 实证)。**这是唯一能覆盖全部 9 个(+未来)派发 Lead 的落点**——GeoForge product/ops 等 Lead 的 identity 无任何派发示例,只靠 base 规则。
3. **identity 示例 sweep**(仅补示例,不承载语义):`.lead/flywheel-eng-lead/identity.md:56-58`、`.lead/flywheel-product-lead/identity.md:247-249`(本 repo,curl 无 taskCategory);其余项目 repo 的 identity(joycon:62、growth rafiki:94 / reflection:153 散文式)**不在本 repo 改动面**——由 P2 重启验收时逐 Lead 读回把关,repo 外 identity 的示例修正作为 P2 附带操作(生产文件,呈报后动)。
4. **`.flywheel/agents/engineering/pm-executor.md`(:60-61,:340-350)/ `prototype-executor.md`(:60,:294-304)**:去 `no-three-stage` 要求改 work-kind 语义(⑤-4 压 founder 门)。v2 模板节点 prompt(repo 根 `agents/` 三件)= 1380 已交付,**不动**。
5. **`.flywheel/config.yaml:258-268`**:`pipeline.work_kind: true` + 注释(owner=FLY-1436、回滚=revert 本行 + binding restore 先行)。
6. **binding 写入/恢复工具**(§6,自建,本单最大新增交付)。
7. **staging fixture**:钉「TEMPLATE_DISPATCH on + GENERALIZED off + v2 binding → 409 `GENERALIZED_WORKFLOW_REJECTED`」与「+ GENERALIZED on + work_kind off + v2 `*` binding → keyless 走 v2 generic」两格(§4.1 与 §7.3 的回归锚)。
8. **不动**:引擎路由代码、seeds、根 `agents/`、`ensureDefaultWorkflowBindings`、其它 rules 文件、`cos-lead-rules.md`、其它项目 config、Codex gateway 工具面、`self-ship-queue.sh` 锁协议(§7 决策)、updater plist。

## 6. binding 写入工具(自建)——设计约束与形态

**现状事实**:StateStore 已迁 native better-sqlite3(FLY-663 shim,`StateStore.ts:11,82-107`);binding API 仅 `bindWorkflowCategory`(`:13698`,每行独立事务)/ `get`(`:13750`)/ `list`(`:13763`),**无删除/恢复 API**;HTTP 面只有只读 GET(`workflow-template-routes.ts:36-93`),mutation 无路由(有意纪律)。

**形态定案:Bridge 进程内版本化 cutover 路由 + 薄 CLI**(codex R1-3/R1-4 + R2-3 + R3-1 修订),不做外部进程直写 DB:
- 理由:teamlead.db 单写者纪律(一切写在 Bridge 进程内,1380 seed 同);进程内 `db.transaction` 满足「六行单事务」;better-sqlite3 事务保证无 partial 提交。
- **server-side authority(CLI 断言不是 trust boundary)**:路由 = **两口** `/api/workflow/cutovers/FLY-1436/{stage,apply}`,`stage` 接受 server-validated **`kind=activate|restore`**,`apply` 统一执行两类 mutation(**无独立 /restore 口**;restore 走同一 stage→confirm→apply 模型)—— server 端**写死** project=flywheel、activation id、六行目标集与 actor;不接受任意 bindings CRUD。安全底座三件:①loopback host 校验;②**`apiToken` 未配置时 503**(通用 `tokenAuthMiddleware` 在 master token 缺失时会放行,`plugin.ts:994-1008`,不能复用作 fail-closed);③constant-time master Bearer 校验。
- **kind 分流 preflight truth table(R3-1)**:`activate` = 全量前置(exact baseline CAS + published/fresh + live flags + `work_kind` + deployed SHA/资产 digest);`restore` = **只**要求 master auth + 原 activation committed receipt + snapshot/hash 完好 + 当前 exact state == committed target + DB 可写 —— **显式允许 `TEMPLATE_DISPATCH=0` / GENERALIZED 任意态 / PR-B 已漂移的事故态**(restore 是恢复通道,containment 动作绝不能自锁它);apply 事务内 recheck 同按 kind 分流。
- **apply handler 五步单义协议(R2-3)**:①master auth + canonical shape/hash 校验;②**先查 durable claim**(同 id+同 hash 已 committed → 只读返回原 receipt、不需要 token;同 id+异 hash → 409);③未命中 committed claim 才 verify-and-consume single-use token(token store 单次消费、Bridge 重启清空 ⇒ 未 commit 的重启后必须重新 stage);④事务内再查 claim(关并发 race)→ kind 分流 CAS → mutation → audit → receipt 同事务 commit;⑤commit 后丢响应重试(含已消费 token)= 200 原 receipt。
- **exact-only 查询**:现有 `getWorkflowCategoryBinding` 带 exact→`*` fallback(`StateStore.ts:13750-13760`)**不能做 baseline CAS**;新增 exact-only getter。
- **durable receipt**:最小 cutover claim 行(`operation_id / activation_id / kind / canonical_hash / snapshot_hash / status / result_json / timestamps`)与 binding mutation、audit **同一 DB 事务**(先例:请求 hash→durable report,`StateStore.ts:2579-2590`)。**restore CAS「当前 exact state == 该 activation committed target」并引用原 receipt**(防重复 restore 误删后续合法新行)。
- **audit 形态**:`workflow_template_audit.action` CHECK 固定值(`StateStore.ts:2803-2817`)⇒ 不做 migration,统一 `action='rebind'` + typed `detail` JSON(operation_id / kind / before / after / 删除行清单)。
- **三零 shared helper(R3-3 + R4-1)**:exact 谓词统一锚定「flag flip 可释放的非终态」= 关联 `status='active'` schema-2 run,落成一个 read-only StateStore helper(**P1-exit/P4/一切 GENERALIZED-off 收尾**共用;P0a 只做现有只读 SQL 的非权威侦察——helper 属 PR-A 交付):①active schema-2 run=0;②关联 active run 的未 terminal side effect=0;③关联 active run 的、`workflow_start_stage` 未达 `responded` 的 reservation=0。terminal run 遗留行只作 diagnostics 不进 gate(admission/recovery/dispatcher 全要求 active run:`workflow-template-selection.ts:469-475`、`StateStore.ts:15934-15948`、`workflow-engine-dispatcher.ts:877-890`;`terminateWorkflowRunByOperator` 只改 run status 不 settle ledger/stage,`StateStore.ts:16640-16746`)。reservation 表 append-only(禁 UPDATE/DELETE trigger,`StateStore.ts:12999-13018`),历史完成行(stage=`responded`,`:13021-13027`)永远在,绝不按裸行数计。
- 测试全表 = plan C9′(response-loss / replay / restage / 并发 / restore kind-分流三场景 / 三零 helper 历史行不计等)。
- StateStore 层内部 authoring API(镜像 `retireWorkflowTemplate` 管理 seam 模式)承载单事务;1418 C9 journal 备选合同**整块删除**。

## 7. deploy barrier 与 updater-lock(advisory ① 收口)

### 7.1 链路重验:相对 1418 基线字节零改动

`git diff 11bbec10 -- scripts/lib/self-ship-queue.sh scripts/update-flywheel.sh scripts/self-ship-restart.sh .claude/commands/spin.md` 全空(FLY-1375/1425/1426/1427/1415 均未触碰)。当前行号:marker 入队 `self-ship-restart.sh:87`、kickstart `:93`(定义 `:42-47`);pull `update-flywheel.sh:85`、restart-services 调用 `:88`、marker ack `:153`、锁释放 `:242`(ack 先于释放,继承事实);fallback sweep `:192-203,232`;`pnpm build` 在 `restart-services.sh:1175`;ancestor-or-equal 判据 `scripts/lib/self-ship-queue.sh:180-187`(核心 `:186` `merge-base --is-ancestor`)。FLY-1375 的 engine land 节点只存在于 `*_land_v1` 模板(dormant,无 binding 指向),**flywheel 自身 PR 仍走 `:cool:` + self-ship**,`tpl_eng_heavy` 无 land 节点 —— barrier 模型照旧成立。

### 7.2 advisory ① 决策:**AVOID —— 不修 fleet 锁协议,不与 updater 抢锁**

stale-lock bug 原样仍在(`self-ship-queue.sh:319-334`:`:322` 拿 owner 的 ps command 比对 **acquirer 自己的** `$ident`,`:333` `stored_ident` 显式仅诊断)——1418 的判断「普通 operator 建的锁会被 updater 当 stale 回收」依然成立,**因此本单不建 operator 锁**,并把 1418 PR-A 的整个锁协议修复(wrapper + holder/fencing + mixed-version 合同 + 并发测试族)从 scope 删除。替代机制(检测+收敛,而非互斥):

1. **窗口唯一 ship 者**:cutover 窗口由 G-GO 划定,operator 是窗口内唯一 ship 发起者;P0 检查 `self-ship-pending.d` 无外部 pending marker;窗口避开 06:00 calendar(生产 plist 实测唯一定时触发);
2. **只读 quiescence barrier(codex R1-5)**:own-marker ack **不等于** updater 已退出(ack 在 `update-flywheel.sh:153`,同进程随后继续扫 queue/fallback,锁释放在 `:242` 才收尾)⇒ barrier 通过后、写 binding 前追加只读静默探针:updater lock 目录不存在**且**其记录 owner 进程已退出 + pending dir **完全为空**(不止"无外部 marker")+ 有界 quiet interval 内 deployed-sha / live-config / 资产 digest 零漂移;`stage`(dry-run)后、`apply` 前**重跑同一探针**,任何证据取不到或漂移即 fail-closed 不写;
3. **写前断言 + 写后再断言**:binding 写入(秒级、Bridge 进程内单事务)前后各做 live-config `work_kind===true` + 关键资产与 mergeSHA 一致断言;写后断言失败 = 检测到并发 deploy → 立即走 restore 分支;
4. **crash 恢复重入断言**:任何中断后恢复的第一步 = 按 durable receipt(§6)对账收敛 + 重跑全部断言再决定前进/回滚。
   **残余 TOCTOU 明示**(进 G-GO 风险包):最后一次探针到事务提交之间存在不可消除的秒级窗口;由唯一 ship 者纪律压概率、写后断言+receipt 对账收敛后果。**blast radius 对比**:修锁协议 = 每个 updater 每次 run 都吃新控制面代码(R8 明确不安的 fleet-wide 半径);AVOID = 零控制面变更。

### 7.3 barrier 五证(继承 C14,裁掉锁段)与回滚矩阵(重写)

**barrier**(PR-B merge 后、写 binding 前,全过才动笔):(a) 本单 marker 被 ack;(b) `merge-base --is-ancestor <mergeSHA> <deployed-sha>`;(c) Bridge health;(d) 生产 dist import 断言 Gemini schema 五值 required;(e) live-config 断言(`work_kind===true` + 两 markdown 与 mergeSHA 版本一致)。deadline 20 分钟,超时按 deploy-in-flight 子矩阵(继承 C11-(i)(ii)(iii),按 §2 plist 现状简化:无 QueueDirectories ⇒「尚未 pull」态的意外触发面 = 06:00 + 他人 kickstart,窗口纪律已排除)。

**回滚合同(codex R1-6/R2-2/R2-4/R3-1 收敛版;权威细节在 plan C11′,此处为事实依据)**:
- **Normal rollback(Bridge/DB/receipt 健康,binding 已写)**:restore by operation receipt(杆①,DB 即时无 deploy;restore 前置按 kind 分流,不复用 activate 全量前置——§6)→ exact 复读验回全 v1 baseline → revert PR-B + 标准 deploy(杆②;必须在杆①后,否则 keyless 409,§4.1)→ 三零重跑 → GENERALIZED off(杆③,audited direct-toggle)。
- **Emergency containment 分两类**:(a) Bridge 可达、restore/DB 路径故障 → 先 **`TEMPLATE_DISPATCH off`(audited direct-toggle)** —— candidate 解析**前**短路、恢复 legacy 单 session(`runs-route.ts:1288-1301`,test `:283` 实证;flag panel fail-stop 顺序同此,`dag-flag-panel-apply-e2e.qa.test.ts:161-178`)→ 验证 legacy → 按 receipt 对账 + restore(restore 在 dispatch off 下必须可用,§6 truth table)→ revert PR-B → 重开决策 → GENERALIZED off;(b) **Bridge 不可达/重启循环** → 停机本身 = 临时 containment;重启前按 G-GO 预批 offline 原子步骤改 `.env` `TEMPLATE_DISPATCH=off`(备份→临时文件→`mv` 原子替换)→ 起 Bridge → file+live 双证 + legacy probe → 按 receipt 续对账。
- **Pre-binding abort matrix**(「GENERALIZED 已 on、binding 未 commit」四态)与**三零在任何 GENERALIZED-off 收尾前必重跑**:权威定义在 plan C11′;第三零谓词 = §6 shared helper。
- **爆炸半径明示**:TEMPLATE_DISPATCH off 期间现役 v1 DAG 新派发回三段、active engine run 的 admission/side-effect 被 hold —— 进 G-GO 包连同重开条件呈报。
- active pinned run 免疫不改道(snapshot 固化,继承保持项)。

### 7.4 cutover-state(轻量化;真相源 = DB durable receipt)

保留 repo 外断点记录 `~/.flywheel/state/cutovers/FLY-1436.json`(schema:`phase / mergeSha / operationId / snapshotPath+hash / updatedAt`,原子 rename 写),由 CLI 维护——**它只是 phase/导航 hint;幂等续跑与结果判定的唯一真相源 = DB 内 durable cutover claim/receipt(§6)**。**删除** 1418 的 lease/generation/fencing 大机器——不与 updater 抢锁后,唯一并发面 = crash 接管,合同 = 接管人 Tadashi 先确认原 operator 进程已死 → **按 DB receipt 对账收敛** → 重入断言 → 幂等续跑。**quiescence owner 证据的可执行时序(codex R2-5)**:若观察时 updater lock 尚在,先捕获其记录的 owner PID/start-identity,再等待该 owner 退出且 lock 消失;若首次观察 lock 已不存在,以进程缺席证据替代(`pgrep update-flywheel` 空 + launchd 无 active run)。`handoff 后禁止写任何 repo checkout` 纪律继承(progress.md 终笔在移除 worktree 前)。

## 8. Lead 教学面(C15 通用合同的落地事实)

- **spawn-capable Lead 枚举(生产 `projects.json` `canSpawnRunners:true`,9 个,全 claude-code backend)**:flywheel-eng-lead、flywheel-product-lead(Honey Lemon)、product-lead、ops-lead、joycon-lead、**rafiki-lead、reflection-lead**(注意:growth 两 Lead 是真派发 Lead,非 companion)、tidal-echo-content-lead、sub-lead。非派发:3 CoS(均 false)、companion belle/mufasa、2 infra bot、external anna(manifest 已 orphan)。**Codex-backend Lead 今天结构上不可派发**(`ProjectConfig.ts:116-146`:codex-app-server 要求 `canSpawnRunners=false` 直到 FLY-251)⇒ Codex 派发面无消费者,不改;未来覆盖由 synthetic fixture + 「FLY-251 接线时必须接教学」的显式 follow-up 注记承载。
- **装载路**:`department-lead-rules.md` 仅 non-cos dept Lead(`claude-lead.sh:2225-2231`;cos 判定 `:2160-2163` = `FLYWHEEL_LEAD_ROLE=cos` 或字面 `cos-lead`);三 CoS plist 均已设 role env(§2)⇒ 三 CoS 都不装载,阴性对照可用任一 CoS。
- **哨兵机制**:bundle 头 `RULES_BUNDLE_SHA=<sha> FILES=<n>`(`lead-rules-bundle.sh:125-139`,PROBE 行要求逐字复述);校验 `check-rules-truth.mjs:118-128,167-170`(cos 禁含 / dept 必含 department-lead-rules.md `:74-81`);launcher 缺哨兵 FATAL(`claude-lead.sh:2607-2611`)。
- **正样本选择**:valid 金丝雀由 **Honey Lemon(flywheel-product-lead)** 从 prompt 面发起(`taskCategory=research` 或 `prd`)——同时满足 C15「Tadashi 不得是唯一正样本」与本单「解锁 Honey Lemon」的产品语义;Tadashi 作 `code` 回归旁证样本。

## 9. 风险核证补遗

- **Lead 重启波及(P2)**:遵守既有 restart 纪律,低峰窗口;GENERALIZED 翻转已改走 direct-toggle(免 Bridge 重启),重启半径只剩 Lead 面。
- **flag 翻转时点(codex R1-1/R3-5)**:GENERALIZED 是 issue 红线点名的 activation flag ⇒ 翻转动作收拢到 **G-GO 之后**的受控序列内(不提前);P0a 验证 production feature-flags 控制面(HTTP no-op stage、丢弃 token 不 apply + CLI 本地无副作用检查;**不用 `feature-flags report`**——它会 publish + Discord 投递),不可用则 fallback 方案(含原子性论证)进 G-GO 包请 founder 显式批。
- **Gemini 词表同源**:enum mirror + 断言测试(gemini-agent 不依赖 teamlead 包,mirror 形式);词表未来扩时同 PR 改。
- **voice session 验收依赖 Annie 在场**:不可得则具名 deferred(owner=Tadashi、触发=下次 voice session、关闭证据=回显含 taskCategory)。
- **P6 拓扑**(retire 旧模板 / docs PR)继承 1418:retire = 独立 follow-up issue + pre-mutation founder gate,不阻塞本单 close。
