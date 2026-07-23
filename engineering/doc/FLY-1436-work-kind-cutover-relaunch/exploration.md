# FLY-1436 work-kind cutover 解冻返工 — 探索
Issue: FLY-1436 (https://linear.app/geoforge3d/issue/FLY-1436/解冻1418-work-kind-binding-cutover-分档路由上线解锁-honey-lemon接替-fly-1418)
日期: 2026-07-22
基于: 无(上游 = FLY-1418 committed design:`flywheel-FLY-1418` 分支 `engineering/doc/FLY-1418-work-kind-cutover/{exploration,research,plan,design-correction}.md`,plan 已 codex-approved R8 + Bridge review APPROVED,但冻结于执行前)

## 0. 这张单的本质

**解冻返工单,不是从头设计。** FLY-1418 已把 work-kind cutover 设计到 codex-approved(R8)+ Bridge design review APPROVED,随后被 Tadashi 冻结(feature-flag 域整修待规划)。Annie 2026-07-23 03:18 直令解冻,本单(FLY-1436)接替执行。1418 的 EXECUTION HOLD 写明了重开门条件,本 design 的任务 = **逐条满足重开门条件,把 1418 设计对照今天的 ground truth 增量修订成可执行 plan**:

1. 折入 `design-correction.md`(Lead 教学与哨兵对所有当前+未来可派 Runner 的 Lead 通用,按运行时 `lead_id` 参数化,绝不 Tadashi-only)——1418 plan C15 已折入,继承即可;
2. **avoid or explicitly approve the fleet-wide updater-lock blast radius**(R8 advisory ①);
3. **derive P5 route evidence from actual template schema versions**(advisory ②)——1380 已 ship,模板 schema 现在是实测事实而非假设;
4. **re-verify the incumbent wildcard schema/route**(advisory ③);
5. 对照当前 branch 重验全部 file:line 锚点与生效面。

与 1418 设计时代相比,ground truth 发生了**三个决定性变化**(§2),其中主 env flag 的生产现状直接改写翻转次序与回滚矩阵。

## 1. 今天的 ground truth(2026-07-22 实测,worktree = main `948275e3`)

| 事实 | 状态 | 证据 |
|---|---|---|
| FLY-1407 引擎 | ✅ merged(不变) | main 含全部 work-kind 路由面(`runs-route.ts:1182-1265` 校验、`:1647` v2 entry、409/400 码全在) |
| FLY-1380 模板 | ✅ **ship + 部署 + 独立 QA 真机全过**(PR #678 `75383c2d`,QA=FLY-1432 PR #679) | 生产 `workflow_template`:12 模板全 published rev 1、零 retired。**schema 实测:`tpl_generic`/`tpl_product_v1`/`tpl_product_designer`/`tpl_product_prototype` = schema-2;`tpl_eng`(带 tier_presets)/`tpl_eng_land_v1` 及全部 `tpl_eng_*` 存量 = schema-1** |
| FLY-1380 **没有交付 activation/迁移工具** | ✅ 确认(ship-note 原文:「那些动作属于后续一次性 cutover 及其 activation gate」) | `engineering/doc/FLY-1380-seed-workkind-templates/ship-note.md:37` |
| 生产 binding | 6 项目各恰一行 `*→tpl_eng_heavy`(updated_by=system:bundled-default),零词表外行 | `sqlite3 ~/.flywheel/teamlead.db` 实测 |
| 生产主 flag 域 | **`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1` + `CLAIMS_READ=1` + `CLAIMS_WRITE=1` 在活 Bridge 进程 env;`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` 不存在(= off,default false)** | `ps eww <bridge-pid>`(lsof :9876)+ `~/.flywheel/.env` 双证 |
| flag 层级 | schema-1 派发需 DISPATCH+claims;**schema-2 额外需 GENERALIZED**(一个 fail-closed 谓词) | `workflow-template-dispatch.ts:29-41` |
| `pipeline.work_kind` | 全 fleet 不存在;flywheel 有 `dag: true`(work_kind 硬依赖 dag,`work_kind_requires_dag`) | `.flywheel/config.yaml:258-268`、`three-stage-config-source.ts:37-101` |
| work-kind 收据面 | `workflow_route_decision` 生产 **0 行**(从未被触发,符合 off 预期) | 实测 |
| v2 模板节点 prompt | repo 根 `agents/`(`designer-executor.md`、`generic-executor.md`、`prototype-executor.md`),1380 已交付,**与 legacy 的 `.flywheel/agents/engineering/{pm,prototype}-executor.md` 是两套不同文件** | seeds `agent_file:` 字段 + `ls agents/` |
| legacy prompt 资产 | `.flywheel/agents/engineering/pm-executor.md:60-61,340-350` / `prototype-executor.md:60,294-304` 仍要求 `no-three-stage` 派发(待改写,继承 1418 C2) | grep 实测 |
| Gemini `dispatch_runner` | schema 无 `taskCategory`,`required:["issueId","projectName"]`(待加 required enum,继承 C8) | `gemini-agent/src/tools/schemas.ts:66-94` |
| 词表 | 5 canonical(`prd/designer/prototype/code/research`)+ ENG_TIERS(trivial/light/heavy,default heavy) | `work-kind.ts:2-13` |
| tpl_eng@heavy ≡ tpl_eng_heavy | tier preset 补回 implement `effort: xhigh`,节点/边/loop 逐字段等价 | 两 yaml diff 实测 |

## 2. 三个决定性变化(相对 1418 设计前提)

### 变化① 主 flag 现实:GENERALIZED 生产 off ⇒ 次序与回滚矩阵重写

1418 设计的前提是「生产主 flag ON,v2 binding 一写即被消费 ⇒ 静默改道」。**今天的现实相反:GENERALIZED off。**逐路径核证(`runs-route.ts` + `workflow-template-selection.ts` 当前 main):

- **GENERALIZED off + v2 binding 已写(任意行)**:candidate 解析不看 flag(`workflow-template-selection.ts:121-131` 只查表)→ schema-2 candidate → DAG entry 被 `generalized_disabled` 拒(`runs-route.ts:1351-1355`)→ 三段块因 `candidateSchemaAtEntry===2` 被跳过(`:1400`)→ v2Entry 成立(`:1551-1556`)→ selection 内 `blocked` throw(`selection.ts:189-190`)→ **409 `GENERALIZED_WORKFLOW_REJECTED`(`runs-route.ts:1626-1631`)**。⇒ **keyless 派发不是"静默改道",是全瘫(fail-loud 409)**。
- ⇒ **硬次序约束不变但理由更硬:binding 写入必须严格在 GENERALIZED=1 生效(活 Bridge 进程 env)之后**,无例外。
- ⇒ **回滚矩阵颠覆**:1418 的 lever ①「主 flag off = 唯一紧急 containment」**不再成立** —— binding 已写后关 GENERALIZED,keyless 全瘫 409;单独 revert `work_kind` config 同理(off 域 keyless lookup `*`→v2 → 同一 409)。**binding restore(快照恢复 `*→tpl_eng_heavy`)升为第一杆**:DB 操作、即时、无 deploy,恢复后其余 flag 杆才恢复各自的 containment 语义。
- **反向红利**:GENERALIZED=1 可以**提前独立翻**(Step 1):现有 binding 全 schema-1,`blockReason(1)` 不读 GENERALIZED ⇒ 对现有派发形态零变化(诚实边界:显式传 v2 `templateId` 的请求从 409 变为可 materialize —— 生产从未发生过此形态,`workflow_route_decision` 0 行旁证;另两个读点是 StateStore v2 revision 的 authoring guard(`StateStore.ts:13289,13475`),admin 面,不在派发路径)。翻它需要 **编辑 `~/.flywheel/.env` + Bridge 重启**(FLY-193 纪律:先改 env 再重启,launchd KeepAlive 会自动 respawn)。

### 变化② 1380 没交付迁移工具 ⇒ binding 写入工具归属改判:本单自建

1418 C9「本单不自造写入工具」的前提(1380 交付 activation-gate 迁移工具)已被 ship-note 证伪。冻结期"两单都不建"的指令已被解冻决定取代;1436 issue 任务列表明确含「binding 写入」。⇒ **本单自建一个受控迁移工具**,把 1418 C9 的消费合同原地转为**自有交付物的验收标准**:显式 activation 参数 + dry-run + 全目标 preflight(exact 查询 published+fresh-eligible)+ expected-old baseline 校验 + 快照(路径+hash)+ **六行单 DB 事务** + 每行 audit + exact 复读 + restore(删 exact 行 + 回写 `*`)。自建反而消掉了 1418 最大的不确定点(「1380 工具形态未定,journal 活性合同兜底」整节)——**直接选单事务形态,journal 备选整块删除**。写入面现状:`bindWorkflowCategory()` 每行单事务、无删除 API(继承 1418 research §6 事实,需按当前 StateStore 重验行号)——工具在 StateStore 层加内部 authoring API(镜像 `retireWorkflowTemplate` 的"管理 seam、HTTP 不暴露"模式)。

### 变化③ P5 route 证据按实测 schema 重推(advisory ②③)

1380 实际交付:**code→`tpl_eng` 是 schema-1(带 tier_presets)**,不是 v2。⇒ 目标 binding 六行写入后:
- `taskCategory=code` → exact 命中 tpl_eng(schema-1)→ **`pipeline_dag_v1` route**(dagEntry,`dag-auto-` key),default tier=heavy ≡ 今天 tpl_eng_heavy 形态;
- `prd/designer/prototype/research` → exact 命中 schema-2 → **`workflow_v2` route**(`wf2-auto-` key);
- absent → `generic_fallback` 单 session(candidate-free,不查 binding,`runs-route.ts:1259-1264,1285-1301`)+ `WORK_KIND_DEFAULT_FALLBACK` outbox 提醒;
- `*→tpl_generic`(v2)行:work_kind on 域 keyless 不消费它(absent 走 generic_fallback);它的消费面 = 未来 work_kind 回滚(off)域的 keyless —— 写入它是 PRD §3.2 的原样目标,但**回滚语义按变化①重推**(off + GENERALIZED on:keyless → v2 generic;off + GENERALIZED off:409 —— 所以 binding restore 永远先于关 GENERALIZED)。
- **incumbent wildcard 复核(advisory ③)**:`*→tpl_eng_heavy`(schema-1)六行现状实测无漂移;`tpl_eng_heavy` 未 retired、published rev 1。

### 附带变化:ship 链与 updater-lock(advisory ①,等 ship-chain 审计收口)

FLY-1375(engine-owned land flow)等 8 个 commit 落在 1418 design 之后。deploy barrier(1418 C14 五证)与 updater-lock 协议修复(PR-A 工具面)必须对照当前 `self-ship-*.sh` / `update-flywheel.sh` 重验:若 stale-lock bug 已被后续工作修掉,PR-A 的锁协议修复整块可删;若还在,R8 advisory 要求「avoid or explicitly approve」—— 倾向 **avoid**:能否用「quiescence 证据 + 有界观察窗口」替代 fleet-wide 锁协议改动,在 research 定稿。

## 3. 继承/重写决策表(对 1418 plan 逐条)

| 1418 决策 | 处置 | 理由 |
|---|---|---|
| C1 flywheel-only pilot | **继承** | 前提未变 |
| C2 prompt 资产边界(两个 legacy agent 文件;模板节点 prompt 归 1380) | **继承**(1380 已交付根 `agents/` 三件,preflight 只核 published) | 边界更清晰了 |
| C3 先翻开关后写 binding | **继承并升级**:三步序列 GENERALIZED(env+重启)→ work_kind(config,与 PR-B 同窗)→ binding 紧随 | 变化①:409 全瘫比静默改道更硬 |
| C4 窗口行为格 | **继承**(absent→generic;显式→409 fail-loud;partial 消灭靠单事务) | 逐路径重核过,当前 main 行号已换 |
| C5 两 PR + docs PR;工具随 PR-A | **结构继承,工具面按 advisory ① 重裁** | 等 ship-chain 审计 |
| C6 ②拍 dual-state 文本 | **继承** | founder correction 语义不变 |
| C7 ③拍哨兵(SHA 读回+payload 生成) | **继承** | — |
| C8 Gemini required enum 同窗 | **继承**(schema 现状无 taskCategory,实测) | — |
| C9 消费 1380 工具 | **重写:自建**(变化②),单事务形态,journal 备选删除 | 1380 无工具 |
| C10 五 founder gate | **继承结构**,呈报走 Lead relay;DAG 节点语境下 G-GO=翻 flag 的 founder gate(issue 明确 founder-gated) | — |
| C11 回滚三杆+时点矩阵 | **重写**:binding-restore-first;GENERALIZED off 降为「binding 已恢复 v1 后」的收尾杆;TEMPLATE_DISPATCH off 仍是全局 DAG containment(爆炸半径=生产在用的 v1 DAG 全回三段,只作最后手段) | 变化① |
| C13 三金丝雀三分支 | **继承 + 按变化③改证据**(code→pipeline_dag_v1;valid 由真实 dept Lead 从 prompt 面发起——**用 Honey Lemon 当正样本**,同时满足 C15「Tadashi 不得是唯一正样本」+ 本单标题「解锁 Honey Lemon」) | — |
| C14 deploy barrier 五证+锁 | **重验后继承/裁剪**(advisory ①) | ship 链有 8 commit 漂移 |
| C15 Lead 通用合同 | **全文继承**(design-correction.md 原文合同) | founder correction |

## 4. 不做的(负空间,继承 1418 并追加)

- 不改引擎路由代码(1407 收口;发现缺陷=开新单);
- 不著作/修改模板节点 prompt 与 seeds(1380 已交付;根 `agents/` 三件不动);
- 不切 flywheel 以外项目;不动其它项目 config;
- 不做 Codex gateway 派单工具面(`dispatch_runner` 之外);
- 不 retire 旧模板于主序列(继承 1418 P6 拓扑:retire 是独立 follow-up issue + pre-mutation founder gate);
- **不复用 FLY-1418 的 branch/worktree 写代码**(它是冻结历史;本单在 FLY-1436 branch 全新落地,设计文档以引用继承)。

## 5. 风险雷达(进 research/plan 细化)

1. **GENERALIZED 翻转需 Bridge 重启** —— 重启纪律(FLY-193/FLY-239:先改 env、精准杀、18+ sessions 保活)+ 低峰窗口;Step 1 独立提前做可以把重启从翻转窗口里拿出去。
2. **updater-lock advisory ①** —— research 收口 avoid/approve 二选一。
3. **③拍全 dept Lead 重启波及面** —— 继承 1418 风险 2。
4. **窗口内真实派单** —— 双保险(机制 fail-loud + 运维不主动派单)。
5. **Gemini 词表同源** —— enum mirror + 同源断言测试(继承 C8)。
6. **工程单"回归"的诚实边界** —— issue 验收「现有工程单派发字节不变」精确化:PR-A 阶段 routing-neutral(字节不变);**翻转后** flywheel 工程单形态 = 显式 `code`→tpl_eng@heavy(≡ 今天 tpl_eng_heavy)/ keyless→generic 单 session+提醒(founder correction 语义,不是字节不变)。G-GO 呈报写明。
7. **本单是 DAG run 节点** —— design/implement 分节点执行;implement 节点的执行 owner 纪律(唯一 owner、violation 检测)继承 1418 P0。
