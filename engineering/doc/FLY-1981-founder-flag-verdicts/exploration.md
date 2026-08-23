# FLY-1981 flag 治理 founder 裁定执行批 — 探索

Issue: FLY-1981 (https://linear.app/geoforge3d/issue/FLY-1981/flag治理founder裁定执行批-复查结论9-条固化删除-auto-qa-整体退役-consentattribution)
日期: 2026-08-22
基于: 无(本单来源 = founder 2026-08-22 05:26Z 对 46-flag 互动复查页 r/0e146cc7 的圈选结论,原文逐字存档于 issue)

## 0. 本单性质

**执行单,不是方案探索单。** founder 已对 12 项逐条裁定(删/固化/退役),Lead 已在频道逐条回并获默认。本探索文档的职责是:

1. 把每条裁定对到**真实代码**(读点、生产现值、删除边界)——不做假设,全部实测;
2. 找出裁定落地时**真正存在自由度的三处**,给出选项与推荐;
3. 记录审计中推翻/修正 issue 假设的发现(有两处)。

零新 flag;安全语义只许更严不许更松(固化 = 写死「门在」,绝不写死「门不在」)。

## 1. 逐条审计结果(12 项)

审计方法:registry(`packages/config/src/feature-flags/registry.ts`)语义 + 生产 `~/.flywheel/.env` 实值 + `~/.flywheel/teamlead.db` 只读账本 + 全仓 grep 读点。生产值核对时刻:2026-08-22(本 worktree HEAD `c63ca48b7`,含 FLY-1778 store + FLY-1831 A9,前置已满足)。

### A 组 — 固化「门永远在/值写死」+ 删旋钮

| # | Flag | registry 语义 | 生产现值 | 固化目标 | 行为变化? |
|---|------|--------------|---------|---------|----------|
| 1 | `FLYWHEEL_REPORTS_TTL_DAYS` (`reports_ttl_days`) | value, default "7", 读点 `plugin.ts resolveReportsTtlMs`(含 `0 disables` 分支) | .env 未设 → 7 | 常量 7 天,删 env 解析(含 0-禁用分支) | 零 |
| 2 | `FLYWHEEL_WORKFLOW_RESUME` (`workflow_resume`) | opt_in bool default false;FLY-1778 store 托管(STORE_MANAGED_FLAGS 5 条之一),读点 = plugin.ts 两处 flag-store 注入 | **.env 实测 =1**(store `flag_values` 表现为空,无 override) | 固化 enabled:resume 注入无条件接通 | 零(现网已开) |
| 3 | `FLYWHEEL_INSTRUCTION_PATH_CHECK` (`instruction_path_check`) | kill_switch default_on,5 个读点(plugin/event-route/design-review-validation + CLI await-codex-gate ×2) | 未设 → ON | 校验永远做,删 5 处 `=0` 分支 | 零 |
| 4 | `FLYWHEEL_DESIGN_HTML_GATE` (`design_html_gate`) | governance_gate default_on,4 读点(complete.ts CLI + event-route + DirectEventSink + complete-marker-reconciler),全部是 `=== "0"` 逃生分支 | 未设 → ON | 门永远在,删 4 处逃生分支 | 零 |
| 5 | `FLYWHEEL_SHIP_CI_GUARD` (`ship_ci_guard`) | kill_switch default_on,单读点 `ship-ci-guard.ts probeShipCiGreen` 首行 `=0` 短路 | 未设 → ON | 门永远在,删短路 | 零 |
| 6 | `FLYWHEEL_CODEX_HARD_GATE` (`codex_hard_gate_killswitch`) | kill_switch default_on;读点 codex-gate.ts(Bridge)+ verify-approval.ts(CLI live-.env)+ auto-qa-held.ts(随 B 组一起死) | 未设 → ON | 评审硬门永远在(评审本体在 DAG 节点,此 flag 只是应急放行阀,阀删) | 零 |
| 7 | `FLYWHEEL_QA_DONE_GATE` (`qa_done_gate_killswitch`) | kill_switch default_on;读点 `ship-eligibility.ts resolveDefaultOnGate`(argsEnv → process.env → live-.env 三级) | 未设 → ON | 防盗门永远设防(无 QA 通过记录不许标完成),删 `qa_gate_off` 出口 | 零 |
| 8 | `FLYWHEEL_LEAD_CORE_MENTION_GATED` (`lead_core_mention_gated`) | opt_in default false;**双面性,见 §2 发现①** | 未设(operator 面从未开过) | 删 flag 面;launcher→runtime plumbing 面保留并改判 NON_FLAG_ALLOWLIST | 零 |
| 9 | `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE` (`founder_attribution_gate`) | governance_gate default_on;读点 `founder-attribution.ts resolveFounderAttributionGateOn`(CLI 每次调用);**529 QA 房 `test-deploy.sh:901-902` 靠 =0 放行,见 §3 选项 A** | 未设 → ON | 最严档写死(固化后不存在「能关掉门的开关」) | 生产零;**QA 房需改批准路径** |
| 10 | `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE` (`founder_consent_decision_mode`) | governance_gate enum off\|audit_only\|enforce,registry default "off";另有 legacy 别名 `FLYWHEEL_FOUNDER_CONSENT_ENABLED`(NON_FLAG_ALLOWLIST 记载) | **.env 实测 = `audit_only`**(见 §2 发现②) | **写死 audit_only**(现网现状档),连 legacy 别名一起删 | 零 |

### B 组 — 整体退役(带机制删除,先核后删)

| # | 对象 | 现状审计 | 退役含义 |
|---|------|---------|---------|
| 11 | auto-QA 管线(`FLYWHEEL_AUTO_QA` env + `qa.auto` project config) | **生产账本铁证:`auto_qa_record` 最后一次写入 2026-07-12,40+ 天零新增(全表 74 行);DAG QA 节点(session_role='qa')同期 flywheel 434 个,最新 = 今天**。机制家族:`auto-qa-{policy,config-source,coordinator(2230 行),effects,held}.ts` + `lead-rules-base/auto-qa-pipeline.md` + HeartbeatService stuck 巡检 + `qa_required` 快照写入 + A-1b backfill/A-3 orphan sweep | 删 spawn/协调机制全家;**`auto_qa_record` 表 + qa 防盗门读路径留作冻结历史账本**(见 §2 发现③) |
| 12 | `founder_milestone_report.enabled`(project config) | flywheel 现网 `.flywheel/config.yaml` **enabled: true, milestones [failed, blocked]**(其余项目均未配);机制:gate-poller `maybeEmitMilestoneReports` + `founder-milestone-config-source.ts` + ConfigLoader/types | 机制删除(founder 圈删):失去 failed/blocked 终态 @founder push;Lead relay + FLY-1687 巡检为现役覆盖面 |

### C 组 — 「新 flag 默认纳管」机械强制(founder 2026-08-22 14:38Z 追加)

现状:FLY-1455 守卫已拦裸 env 直读;FLY-1778 store 已让 5 条纳管 flag 可动态开关。**缺口:新增 flag 只登记 registry 不进 STORE_MANAGED_FLAGS,守卫不红**——纳管是「可选项」不是「唯一姿势」。C 组把它变成会变红的检查(见 §3 选项 C)。

## 2. 审计发现(修正/确认 issue 假设)

**发现① — `lead_core_mention_gated` 的「重复开关」结论成立,但结构比 issue 描述多一层:** 这个 env var 有两个身份。(a) operator flag 面:registry 登记、可被人工预设(`codex-lead.sh:97` 只在 env **缺席**时才从 projects.json 计算——预设可覆盖计算),从未被用过;(b) plumbing 面:launcher 按 projects.json 算出后 export 给 Codex Lead runtime(`codex-lead-runtime.ts:617` 读),**这条在生产每天在用**。「删 flag」= 删 (a):去 registry、删 `-z` 预设覆盖口,让 projects.json 成为唯一来源;(b) 保留原字节、改判 NON_FLAG_ALLOWLIST plumbing(FLY-1809 对 `lead_cross_dept_channel_ids` 的同款先例)。这同时解释了 founder 问的「显示 off 但工作」:flag 面 off,plumbing 面在工作。

**发现② — consent 现网不是 off:** `~/.flywheel/.env:149` 实测 `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only`。裁定语义「现网现状档写死」⇒ **写死 audit_only**,不是 registry default 的 off。这反而消解了与「绝不写死门不在」约束的紧张:audit_only = 评估器照跑、审计照写(`founder_consent_audit` 校准语料继续积累)、不拦截——机制全保留,只删模式旋钮 + legacy `FLYWHEEL_FOUNDER_CONSENT_ENABLED` 别名。`enforce` 专属死分支(gate-response-router 的 enforce 写路径)按净删除处理,但 `bridge-founder-consent` 作为 TRUSTED_BRIDGE_APPROVAL_WRITERS 成员**保留**(verify-approval 的历史回执可携带该归属)。

**发现③ — qa 防盗门与 auto-QA 的解耦线已经天然存在:** `evaluateQaShipGate` 是双路径:durable QA(session_role='qa')走 `workflow_claims` qa_verdict(DAG 现役路径,与 auto-QA 无关);legacy 路径读 `qa_required` 快照 + `auto_qa_record`。退役只杀**写者**(policy eval / coordinator / record 写入),**读者一行不动**——历史 session(七月 held PR 堆)落地时门照常评。副作用(刻意的、更严方向):退役后任何**非 DAG** 的 code-PR session 将以 qa_required=NULL → `qa_snapshot_missing_failclosed` 永久卡门(A-3 orphan sweep 与 manual-QA 端点一起死,不存在任何补 QA 证据的路——**含 founder:approveExecution 会因 qa_evidence_missing hold 拒绝,「founder 手工裁」出口不存在**,Codex R1 核实)。唯一受支持出口 = cancel + 在 pipeline.dag 下重派。生产证据显示 7 月中旬后不存在这样的活体(核查程序固化进 plan 的删前必核步骤,活体非零则停手上报)。

## 3. 真自由度三处 — 选项与推荐

### 选项组 A:attribution gate 最严档写死后,529 QA 房怎么批准 ship 卡?

现状 `test-deploy.sh` 给 slot Bridge/Lead 注 `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`,因为 slot 驱动用 lead-attributed `flywheel-comm respond` 批准,真门会拒。

- **A1(推荐,经 Codex R1/R2/R3 三轮收敛的终形)— QA 房批准一律走既有 `/api/actions/approve`(可信 writer="bridge"),零新 Bridge 代码。** 三轮演化:R1 发现直接换端点死锁(阻塞 gate 时 FSM=running);R2 一度设计「respond-equivalent writer」;R3 以 HEAD 源码证伪其前提(respond.ts 对 Lead approval-intent 在写入前即抛 `lead_ack_rejected`,旧 respond 批准路本已必死)。终形:engine(schema-v2)run 经 engineAuthority 准入(carrier 可 running)直接 POST approve;legacy 阻塞 gate 套件改走生产标准绑定路(`complete --route needs_review --question-id` 落 awaiting_review)再 POST approve→唤醒→resume verify+merge。真 `verifyApproval` 合同测试 + 对抗矩阵 + 双冒烟(预删除 + final-head)后才摘 =0 注入。收益:零 bypass、门在 QA 房真实设防、与生产 founder dashboard 同信任边界,且顺手修掉一条 HEAD 上已死的驱动路。
- **A2 — slot .env 覆盖 `DISCORD_OWNER_USER_ID` 为测试 id,驱动伪造 founder-shaped 归属。** 被 FLY-945 Fix E 写侧防伪(snowflake-shaped `--lead` 拒收)挡死,做不了;且属于「能被我伪造的字段不能自证」反模式。**否决。**
- **A3 — 留一个改名的 QA-only bypass seam(进 FLAG_EXEMPTIONS)。** 违背 founder「固化后不存在能关掉门的开关」的裁定精神;bypass 换名字还是 bypass。**否决。**

### 选项组 B:consent 固化的删除半径

- **B1(推荐)— 写死 `audit_only` 常量;删 `resolveDecisionMode` env 解析、`FLYWHEEL_FOUNDER_CONSENT_ENABLED` 别名、registry 行、feature-flag-render/console 面;evaluator/audit/中间件机制整体保留;enforce-only 死分支净删。** 行为零变化,审计语料延续,代码半径最小。
- **B2 — 顺手把 enforce 能力也全删(evaluator 只剩 audit 写)。** 超出裁定(founder 只说固化旋钮,没说砍 enforce 能力半径);且 enforce 路径与 audit 路径共享大量代码,强行剥离反而加大 diff。**否决**(enforce 专属且固化后不可达的分支照常净删,共享机制不动)。

### 选项组 C:「新 flag 默认纳管」的机械形状

- **C1(推荐,经 Codex R1 收紧——豁免面归零)— 不可变最大基线 + 守卫红线。** `LEGACY_UNMANAGED_BASELINE` 按 spec 名冻结全部现存非纳管 spec(**含存活 governance_gate 与 project_config spec**),守卫断言当前集合 ⊆ 字面量、只许缩;基线外的新 spec **必须** store-managed(env-backed codec + wrapper 读点 + seeded row + management-route 测试)。**公式不含 FLAG_EXEMPTIONS、不含 category 豁免**(新 spec 自贴 governance_gate 或只写 exemptions 都是逃生门,由阴性对照钉死);现行 store 只支持 env-backed flag ⇒ 项目级 store 授权出现前机械拒绝新 project_config spec。阳性对照(虚构新 flag → RED)+ 两个阴性对照。配套 `doc/engineer/implementation/flag-authoring-runbook.md`「加 flag 的唯一姿势」。规矩长在会变红的检查里。
- **C2 — 强制存量一次性全部迁入 store。** 半径爆炸(37 个 env flag,大量跨进程 shell/CLI 读者根本进不了 Bridge store),会把本执行单变成第二个 FLY-1778。**否决**——存量收敛由 FLY-1405 台账按批走。

### 附带裁定确认(非自由度,照办)

- **B 组 config-path tombstone:** `RETIRED_FLAGS` 现仅收 envVar。`qa.auto`、`founder_milestone_report.enabled` 是 config key,需要平行的 `RETIRED_CONFIG_PATHS` 墓碑——按 Codex R1 #6 收**整个顶层 `qa` 与 `founder_milestone_report` 路径**(含 skip_labels/agent/milestones 等子键;ConfigLoader parse 后 loud-reject,防 stale 块被静默吞),随本单落。
- **生产 `.env` 两条残值(`FLYWHEEL_WORKFLOW_RESUME=1`、`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only`)**:照 FLY-1831 先例,不在 worktree/live 直接改——runbook 交 updater 原子删除 + 班车部署 + live preflight。
- **与 FLY-1977 的重叠**(lead_core_mention_gated / reports_ttl_days):以本单 founder 裁定为准,FLY-1977 缩范围(issue 已写明)。

## 4. 决策记录

| 决策点 | 结论 | 依据 |
|--------|------|------|
| 12 项裁定语义 | 全部按 issue 执行清单,零偏离 | founder 原文 + Lead 频道逐条确认 |
| consent 固化档位 | **audit_only**(非 off) | 生产 .env 实测(发现②) |
| QA 房批准路径 | A1 终形(既有 `/api/actions/approve`,writer="bridge";engine authority / awaiting_review 两形态,零新 Bridge 代码) | 唯一不开后门且提升 QA 保真度的路;respond 批准路在 HEAD 本已必死(Codex R3 核实) |
| consent 删除半径 | B1(机制保留,旋钮+死分支删) | 裁定范围 + 最小 diff |
| C 组形状 | C1(冻结基线 + 红线守卫 + runbook) | founder「机械强制而非文档惯例」原话 |
| auto-QA 账本 | 表 + 门读路径冻结保留,只杀写者 | 防盗门永远设防(裁定 7)+ 历史 session 落地需要 |

## 5. 下一步

- [x] 代码审计(本文档)
- [ ] research.md:file:line 级读点/删除边界/测试资产全清单
- [ ] plan.md → codex-design-review → 实施
