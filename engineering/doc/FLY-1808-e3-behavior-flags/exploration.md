# FLY-1808 E3 会改变行为的 flag 逐条删除 — 探索

Issue: FLY-1808 (https://linear.app/geoforge3d/issue/FLY-1808/flag执行e3-会改变行为的-10-条逐条删-显式固化值不许批量)
日期: 2026-08-17
基于: 无(上游为 FLY-1782 体检产物 `product/doc/FLY-1782-flag-recheck/`)

---

## 1. 这单是什么

FLY-1782 flag 体检的最后一张执行单,也是风险最高的一张。E1(FLY-1806,46 条功能类,已 Done,PR #859)和 E2(FLY-1807,急停开关批,已 Done,PR #860)处理的都是「当前生效值 == 真默认值」的 flag——删掉判断、留下默认分支,行为零变化,可以批量。

**本单的 flag 恰好相反:当前生效值 ≠ 真默认值。** 代码里删 flag 的自然写法(删掉 `if`、留一条分支)会默默留下**默认**那条分支——对本单每一条,那都是**错的**那条。所以:

- **不许批量**:每条必须单独写明「固化成哪个值 + 为什么」。
- **方向已定死**(issue 正文):一律冻结在**当前生效值**。这是 Annie 的规则「一直 enable 且没问题 ⇒ 保持 enable,把 disable 那条线删掉」的直接应用——保住现在的行为,去掉那个选择。落回默认 = 改变行为,与清理意图相反。

## 2. 范围演化:10 → 12,以及三个前置问题

Issue 正文写 10 条,之后两条 comment 改变了账目。**执行范围以 comment 为准 = 12 条**:

| 来源 | 条目 |
|---|---|
| issue 正文 · 五个派工开关(串联,按 1 个决定处理) | `workflow_template_dispatch` · `workflow_generalized_templates` · `workflow_claims_write` · `workflow_claims_read` · `workflow_gate_carrier` |
| issue 正文 · Annie 单独裁决并入 | `founder_ux_gate_killswitch` · `founder_ux_gate` · `runner_autocontinue` · `comm_bypass_bridge` |
| comment `7e777ad4`(HL 路由,D-1) | `cmux_linked_view` |
| comment `b83c4b73`(E1/E2 设计期退出并入,+2) | `lead_dry_run`(E1 退出:有生产 setter)· `done_thread_reconcile`(E2 退出:QA 隔离依赖 OFF 值) |

HL 同时路由进来三个**执行前必须先解决**的前置(comment `7e777ad4`):

- **D-1 `cmux_linked_view`**:她的裁决在(「关掉删了算了」),但固化值当时未定。生产显式 `=0`(关),而默认是**开** ⇒ 落回默认会当场改掉她每天看的 cmux 侧栏。**本单方向规则直接解决它**:冻结现值 = 固化成关 —— 既保行为,又与她的原话一致。执行须守 E1 硬门③的顺序(先改默认值、再删,不许反)。
- **D-2 两个管 ship 授权的开关**(`workflow_generalized_templates` + `workflow_claims_write`):她的初始意向「关掉删了算了,好像也没有在用」的前提已被实数证伪(22 个 workflow run / 31 个 claim 全跑在其上;关掉 = 整条派工链停摆),且 7-19 启用时**查不到批准记录**(audit.md §5 D-2,三次判断被推翻的全过程)。**状态 = 未结**。执行前必须带实数重新征询 Annie,不得呈现为「她已确认」。
- **D-3 `FLYWHEEL_MAILBOX_DISCORD`**:处置已在 comment 顶部更正定死 = **不动**(维持现状不需要她批准),路由给工程做双仓对齐(主仓已标退役、Discord 插件 0.0.4 仍在读)。**不在本单删除名单里**;本单唯一责任是不碰它、并在 PR 里写明这条显式排除。

## 3. 探索中的关键发现(改变设计形态的三件)

### 3.1 `lead_dry_run` 根本没有「单一固化值」——它不是 flag,是调用参数

Registry 只登记了 1 个读点(`codex-lead-runtime.ts`),实测全仓约 30 处:`claude-lead.sh` 15+ 处(FLY-231 structured dry-run launch plan 整套机制)、五个 codex lead 启动脚本、`canonical-lead-identity.sh`、TUI runtime。且有两个**生产 setter** 逐次设 `=1` 取 launch plan:`scripts/verify-anna-isolation.sh:122`、`scripts/lib/buddy-captain-preview.sh:148`。

它的「值」按设计逐次调用不同——**per-invocation 参数没有可冻结的单一现值**,按硬门②「写不出固化值的不许删」,它不可删。正确处置是**搬**:从 FEATURE_FLAGS registry 迁到 `exemptions.ts` 的 `QA_AND_INVOCATION_SEAMS`(该名单已收 `FLYWHEEL_CMUX_DRY_RUN`、`FLYWHEEL_LEAD_V2_DRY_RUN`、`FLYWHEEL_BUDDY_PREVIEW_DRY_RUN`——dry-run invocation seam 正是这个类目的既有住户)。行为字节不变;flag 台账少一条。搬有本轮先例(FLY-1809 两条、tally §2「搬 2 条」)。

### 3.2 `done_thread_reconcile` 的 OFF 值是 QA 房的 Linear 防火墙

生产现值 = ON(env 缺席,判读式 `!== "0"`)。但 `scripts/test-deploy.sh:914-916` 给每个 QA slot Bridge 显式注入 `=0`——防止隔离房的 sweep 扫**真 Linear** 并归档真 thread。焊死 ON 会拆掉这道隔离。它同样不是产品行为选择,而是 QA 环境接缝 ⇒ 同 3.1 处置:**搬**进 `QA_AND_INVOCATION_SEAMS`,env 读点字节不变,生产(不设)永远 ON,QA 房继续注 `=0`。

伴生两条 value knob(`done_thread_reconcile_interval_min` / `_max_per_run`)不在本单路由范围,留在 registry 原地不动(交 E 系列后续/FLY-1405),PR 里写明这条边界。

### 3.3 founder-UX 门「删」的真实尺寸

`founder_ux_gate_killswitch`(env,unset ⇒ OFF ⇒ 门全舰禁用)+ `founder_ux_gate`(project config enum,absent → enforce,但被 killswitch 短路)。四处消费者(Blueprint 注入 / status route / stage-guard / claude-lead.sh)已逐一核实**全部**先查 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` 才生效 ⇒ 今天门在全舰物理不生效 ⇒ 「固化成门不在」= 删除整个 FLY-598/869/900 机制 = **零行为变化**。尺寸不小:`bridge/founder-ux/` 五个文件(~621 行)+ `founder-ux-config.ts` + ConfigLoader 校验块 + Blueprint / claude-lead.sh / DirectEventSink / event-route / run-infra / runs-route / StateStore 各处接线 + `founder-ux-rules.md` base 文件。StateStore 的两个历史列(`founder_ux_signoff_json` / `founder_ux_gate_mode`)保留为惰性历史数据,不做破坏性迁移。

## 4. 方案取舍

### 4.1 波次:一刀切 vs 两波(选两波)

- **方案 A · 单 PR 12 条**:被 D-2 否决——两个 ship 授权开关未结,「执行前必须重新征询」;把 7 条已可执行的活扣在她的答复后面没有任何收益。
- **方案 B · 两波(选定)**:
  - **Wave A(7 条,立即可执行)**:`founder_ux_gate_killswitch` + `founder_ux_gate`(一体拆门)· `runner_autocontinue` · `comm_bypass_bridge` · `cmux_linked_view` · `lead_dry_run`(搬)· `done_thread_reconcile`(搬)。每条授权干净:两条 primary 书面裁决、一条 HL/Tadashi 裁决、D-1 由方向规则闭合、两条搬不改行为。
  - **Wave B(5 条,一个决定)**:五个派工开关整体,**挂在 D-2 重新征询之后**。Issue 明令「按 1 个决定处理,不是 5 个开关」——虽然 D-2 只点名其中两个,但五条是串联链(`workflowTemplateDispatchBlockReason` 一个谓词收口),把三条先焊死、两条留活口会造出一个半焊接的怪链,且若她选「回到条款」(关掉走验收),链上任何一条焊死都是错的。**一个决定覆盖五条**。
- **方案 C · 五条也拆开(焊三留二)**:被上一行的理由否决。

### 4.2 D-2 重新征询的形态

征询文本在 plan.md 里逐字给出(带实数:22 run / 31 claim / 停摆判据 / 无批准记录 / 两个选项),由 Tadashi 走 founder 面转达(Runner 不直接面对 founder,`feedback_founder_facing_issue_creation_via_lead`)。设计 HTML 里同样放一张 D-2 决策卡(评论层可留言),作为第二个应答面。**Wave B 的 PR 在拿到她的答复前不开工**;若答复是「回到条款」,Wave B 变成另一形状的工作(关闭 + 按条款验收),超出 E3 的「冻结现值」形态,须回 Lead 重新立项——plan 里显式写这条分支。

### 4.3 「搬」偏离 issue 的「删」措辞

`lead_dry_run` / `done_thread_reconcile` 两条的处置是搬不是删——这是对 issue 措辞的偏离,但是硬门②的直接推论(写不出固化值/固化会拆 QA 隔离)。已按「授权内做不到 ⇒ 上报别自扩权」通过 `flywheel-comm ask` 向 Tadashi 报备该偏离(非阻塞),plan 按搬编写;若 Lead 否决则该两条退回 needs-decision,不影响其余 10 条。

## 5. 不做的事(诚实边界)

- **不碰 D-3**(`FLYWHEEL_MAILBOX_DISCORD`):双仓对齐另行立项。
- **不碰**五连开关的历史语义分支:`gate_carrier_epoch=0` 的 legacy 路径、claims 未注册 run 的 legacy 读——它们键在 run 数据上,不在 env 上,焊死 env 不动它们。
- **不删** StateStore 历史列、不做破坏性 DB 迁移。
- **不碰** `done_thread_reconcile` 的两条 value knob、`qa_auto`、`skill_framework_mode`、`doc_flow`、`founder_consent_decision_mode` 等留用/另行处置项。
- **不替 Annie 决定 D-2**:Wave B 只在她答复后按答复形状执行。
