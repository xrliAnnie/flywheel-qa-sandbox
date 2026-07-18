# FLY-1344 env 冷开关收编进 flag 控制台 — 探索

Issue: FLY-1344 (https://linear.app/geoforge3d/issue/FLY-1344/flags-env-冷开关收编进-flag-控制台-dag-force-legacy-优先founder-可见可操作理想热切换)
日期: 2026-07-17
基于: 无

## 1. 问题定义

Annie 直令(2026-07-17,[FLY-1307] thread):「为什么少数底层开关还是环境变量?特别是 DAG 这一套,你不是应该把它改正确才行吗?」

两个目标:

1. **优先:DAG 开关收编** — `FLYWHEEL_WORKFLOW_FORCE_LEGACY`(或其继任开关)进 flag 控制台:founder 可见当前状态、可下指令切换;理想改造为热开关。**时间硬约束:赶在下次统一重启开 DAG 之前 merge**,让此后开/关 DAG 是控制台一句话的事。
2. 盘点其余 .env 冷开关,能热化的热化,不能的至少纳入控制台可见层(带 restart-required 标记)。

## 2. 现状审计(codebase 实证,非 issue 假设复读)

### 2.1 FLY-709 控制台现状

- **注册表** `packages/config/src/feature-flags/registry.ts`:123 个 flag(13 direct / 63 conversational / 47 readonly;48 kill_switch / 66 feature / 9 governance_gate)。每条声明 `readSites[].timing`(call_time / bridge_boot / object_construction / cli_invocation / mixed)。
- **可见层**:`GET /api/fleet/flag-report.html` 渲染**全部** flag,每条带「热生效/需重启」badge — 但 badge 只按 `readTimings.every(call_time)` 二分(`feature-flag-render.ts:29`)。
- **可操作层**:仅 `toggleable: "direct"` 的 flag 有 checkbox → 生成 `flywheel-comm feature-flags apply --name X --to on|off` 命令(Annie 复制粘给 Lead 的 locked control model)。apply 事务(`flag-toggle.ts`):锁内 re-verify → **先原子写 `~/.flywheel/.env`** → 再 in-proc 突变 Bridge `process.env`。
- **安全闸** `isDirectToggleable`(`flag-toggle.ts:70`):env + bridge_global + bool + 声明 direct + 非 governance_gate + **全部 readSite timing === call_time**。governance_gate 永不 web-toggle 是 FLY-709 锁定红线。

### 2.2 FORCE_LEGACY 的真实语义(与 issue 文字有出入,已实证)

- **生产现状**:`~/.flywheel/.env` 第 145 行 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`。
- **唯一生产消费点** = `packages/flywheel-comm/src/ship-eligibility.ts:287` `evaluateQaShipGate`:durable-QA 会话(session_role=qa ∧ chat_thread_role=qa)默认走 **claims ledger** 读 QA 裁决;`forceLegacy=1` 时强制回退 legacy `auto_qa_record` 读取。`workflow-claims.ts` 的 `isWorkflowLegacyForced` 导出后**无生产调用方**(为 Bridge 侧准入预留)。
- **它不是「DAG 总开关」**。DAG 派发的启用杆是 FLY-1307 PR-8 的统一组合谓词:**template_dispatch ∧ claims_write ∧ claims_read**(v2 额外 ∧ generalized_templates),全部 governance_gate、default-off。FORCE_LEGACY 是**应急回退杆**(kill_switch):enrolled run 的 ship-eligibility 立即回落 legacy 读法。FLY-1307 plan 原文:「回退 = force_legacy + flag off」。
- **读取路径已经是「热」的,只是控制台不承认**:
  - CLI 侧(runner 的 verify-approval / ship-eligibility):`resolveDefaultOffGate` **每次调用现读 `~/.flywheel/.env` 文件**(文件权威,process.env 仅 fallback;FLY-827/FLY-869 的 BIDIRECTIONALLY-LIVE 模式)→ 改文件即生效,无需任何重启。
  - Bridge 侧(`merge-ship-gate.ts::computeShipDecision` 传 process.env;key 在 argsEnv 里存在时 argsEnv 赢)→ 读 Bridge 进程 env;而 FLY-709 apply 事务恰好会 in-proc 突变它 → 走 apply 通道同样即时生效。
  - **结论:现有 apply 事务(写 .env + 改 process.env)天然让 FORCE_LEGACY 双路径热生效。唯一的挡板是 `isDirectToggleable` 不认 `cli_invocation` timing。**
- **控制台当前把它显示为「需重启」— 这是错的**(timing 非全 call_time → badge 判 需重启)。同病:`merge_approval_gate_killswitch` 注册条目 note 写「改后需重启 Bridge」,但代码实际是 live-.env 双向热读(ship-eligibility.ts 头注释明说 re-arm 即刻生效)。注册表存在**成效路径分类失真**。

### 2.3 DAG 启用杆全景(FLY-1307 PR-8,在途)

| 杆 | envVar | 类别 | 真实生效路径 | 重启? |
|---|---|---|---|---|
| 模板派发总闸(PR-8 新增,尚未注册) | FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH | governance_gate | 待定(PR-8) | 待定 |
| claims 写 | FLYWHEEL_WORKFLOW_CLAIMS_WRITE | governance_gate | call_time + **bridge_boot**(plugin.ts 接线) | **是** |
| claims 读 | FLYWHEEL_WORKFLOW_CLAIMS_READ | governance_gate | call_time + dotenv-live(CLI) | 否(但治理门不给 toggle) |
| v2 模板 | FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES | governance_gate | call_time | 否(同上) |
| **应急回退** | FLYWHEEL_WORKFLOW_FORCE_LEGACY | **kill_switch** | dotenv-live(CLI)+ process.env(Bridge) | **否** |

### 2.4 盘点面(goal 2)

- 47 个 readonly env flag 里,timing 分布混杂:一批实为 call_time(如 three_stage 系列)、一批 dotenv-live 被记成 call_time/cli_invocation、一批真 bridge_boot/object_construction。「需重启」badge 有系统性失真。
- 生产 .env 43 个 FLYWHEEL_* key:8 个已注册 flag、11 个 drift-test allowlist(plumbing/value)、**24 个两边都不在**(FLYWHEEL_AUTO_REPAIR、FLYWHEEL_ROUNDTABLE_* 系列、FLYWHEEL_SWAP_PRESSURE_* 等 — 多为 shell 脚本或 drift 扫描 4 个 src 目录之外的消费点)。测量口径:drift 正则扫 4 个 src 目录 + 我的 allowlist 解析为正则粗提取,此数是上界,需 implement 时逐个核。

## 3. 方案

### 方案 A(推荐):新增 dotenv_live 生效路径类 + FORCE_LEGACY 收编 direct + DAG 面板分组呈现

四块,全部落在 FLY-709 既有骨架上,零新状态面:

1. **注册表 schema 增 `ReadTiming` 值 `dotenv_live`**:「每次使用时现读 `~/.flywheel/.env`(文件权威,process.env fallback)→ 写文件即生效」。把 workflow_force_legacy、merge_approval_gate、qa_done_gate、workflow_claims_read 等 live-.env 读的条目改到诚实分类,badge 逻辑同步(dotenv_live 也算 热生效);错误的「需重启」note 纠正。
2. **`isDirectToggleable` 扩展**:全部 readSite ∈ {call_time, dotenv_live} 即可(其余不变:声明 direct + 非治理门 + directToggleProof)。dotenv_live 的 proof 测试形态:applyFlagToggle 写 .env 后,**不重启进程**,下一次 resolveDefaultOffGate(真实解析函数)即观察到新值;Bridge 侧 process.env 突变同证。
3. **workflow_force_legacy → `toggleable: "direct"`**:控制台/手机页出 checkbox,Annie 一句 `flywheel-comm feature-flags apply --name workflow_force_legacy --to on|off` 完成热切换。安全论证:kill_switch 类别(非治理门,FLY-709 红线不碰);**方向安全** — 拨 ON 是回退到 legacy(保守方向),拨 OFF 只是解除压制,DAG 是否真跑仍由治理门四杆 + 重启决定,不存在从 web 页面提升 merge authority 的路径;走既有 loopback + same-origin + confirmToken + audit 全套。
4. **DAG 面板(报告页顶部新分组卡)**:把 §2.3 五杆聚合成一张卡 — 派生一行总状态(「DAG 派发: 未启用 / 已启用 / 已启用但被 FORCE_LEGACY 压制 / 组合异常」)+ 每杆一行(当前值 + 生效路径 badge + 治理门 readonly 标注)。**冷开关的 stage 呈现**:resolver 对 env flag 同时算「.env 文件值」与「Bridge 进程值」,二者不一致 → 显式标「.env 已改,待重启生效」(bridge_boot 杆)或「⚠ 分脑:CLI 与 Bridge 见值不同」(dotenv_live 杆被带外手改时)。治理门翻转本身不给按钮,但面板生成**可复制的 .env 编辑命令 + 重启提示**(copy-paste 文本,页面零回调,与 Annie locked control model 一致)— 这就是 issue 说的「明示改后需重启生效并可 stage」。

goal 2 在此方案下 = 注册表分类修正 sweep(数据改动,非行为)+ 分脑/待重启检测天然覆盖全部 env flag + 24 个未注册 key 清单交 implement 按 drift 规则「注册 or allowlist」收编(shell 侧消费的注册为 readonly 可见行)。

### 方案 B:DB-backed 动态 flag 面(StateStore 表 + 推送)

热切换不走 .env,建 flag 表,Bridge/CLI 都查库。**否**:新增一整个状态面与既有 .env 单一真相源冲突,FLY-709 花五轮 review 锁定的 stage/apply/audit 全要重做,和 FLY-1091(动态 flag PRD)是另一个量级的活,不是本单的「收编」。

### 方案 C:只做可见层(DAG 面板 + 分类修正),不给 FORCE_LEGACY toggle

**否**:直令明确要「可下指令切换」,且 FORCE_LEGACY 的热切换在现骨架上是低边际成本(§2.2 结论:机制已在,只差放行 + proof)。

### 方案 D:治理门(claims_write 等)也放进 direct

**否**:FLY-709 锁定红线「治理门永不 web-toggle」,这些杆直接改 merge authority 语义;开 DAG 是 founder-gated 重启动作,保持 Lead 执行 + Annie 批准,控制台只负责看得见、stage 得出、命令生成得出。

## 4. 关键设计判断(供 Lead 确认)

1. **「开 DAG」保持冷(重启窗执行),「关 DAG/应急回退」做热** — 与 FLY-1307「enable 决策呈 Annie ship gate」的治理设计一致;Annie 的「理想热切换」在回退方向完整满足,启用方向以 stage+命令生成满足(issue 的 fallback 条款)。
2. FORCE_LEGACY 不改语义、不造继任开关 — PR-8 已把它编进回退故事(「回退 = force_legacy + flag off」),本单只改它的可操作性与显示诚实度。
3. 与 PR-8 的并行协调:template_dispatch 注册时直接按新分类落表;本单不动 PR-8 的四杆语义,只提供它们的呈现层。冲突面 = registry.ts 数据区,行级冲突小。
4. 时序:本单 merge 进「统一重启开 DAG」同一重启窗 → 重启后控制台立即具备 DAG 面板 + FORCE_LEGACY 热拨杆能力。

## 5. 风险面(research 阶段展开)

- stage/apply 的 canonical(rawFrom 取 Bridge process.env)对 dotenv_live flag 的基线语义 — 带外手改 .env 后的 409 行为要定义清楚。
- resolver 给 dotenv_live flag 读文件 = 每次渲染一次文件 IO(可接受,report 是低频人驱动)。
- 24 个未注册 key 的归类工作量上界;drift 扫描不覆盖 shell 消费点的结构性缺口(记录,不在本单修)。

## 6. Brainstorm gate 结论(Tadashi,2026-07-17)— 两处修订

方向批准(方案 A 四件套 + FORCE_LEGACY=应急回退杆的口径确认),附加两条改变设计范围的输入:

1. **#626 已 merge,PR-8 谓词已在 main**。本分支已 merge main 同步。据 main 实态复核:
   - `workflow_template_dispatch` 已注册(governance_gate,call_time);统一谓词 `workflowTemplateDispatchBlockReason`(workflow-template-dispatch.ts)纯 call_time,每次 start 现读 env。
   - 种子导入 `importBundledWorkflowSeeds` 与 `ensureDefaultWorkflowBindings` 在 boot **无条件**执行(content-hash 幂等)— 不构成热启用障碍。
   - **唯一 boot 冻结点** = `createWorkflowShadowWriterFromEnv`(plugin.ts):CLAIMS_WRITE≠1 → writer=undefined → 全 seam 休眠;`setWorkflowShadowFinalizationHook` 也仅在 boot 时启用才挂。→ claims_write 今天是真 restart-bound。
2. **需求升格:「开 DAG」也要是 Annie 的控制台一句话热切换,不重启**(不只回退方向)。§3 方案 A 的「开 DAG 保持冷」不再成立,设计升级为**方案 A′**:
   - 新增第五件:**claims_write 热接线改造** — shadow writer 改为无条件构造(廉价对象),flag 检查移到每次 seam 调用内部(per-call `isWorkflowClaimsWriteEnabled(process.env)`);finalization hook 无条件挂、内部检查。OFF 时真值表逐字保持(FLY-1232 byte-compat sentinel 背书)。改造后四根启用杆全部 call_time → 热。
   - **四根启用杆重分类**:governance_gate → feature(toggleable direct + 各自 directToggleProof)。治理依据:Annie 的 FLY-1344 直令就是把「开/关 DAG」的控制权交到控制台一句话 — 类别当年标 governance 是因为「enable 决策待呈 Annie」,该决策现在由她本人以直令形式做出。这些杆改变的是 pipeline 机制(claims ledger vs legacy 表),不是 merge 授权归属:两条路径都 fail-closed、founder approve + Codex gate 在两边都强制。真正的授权面治理门(founder_consent_decision_mode / comm_bypass / founder_attribution 等)一个不动。
   - **「开 DAG」对 Annie 的那句话**(设计定稿写进 plan):DAG 面板一个「开 DAG」勾选 → 复制框生成一组 apply 命令(template_dispatch on + claims_write on + claims_read on + generalized on + force_legacy off)→ 粘给 Lead 执行 → 逐条热生效,零重启。「关 DAG(应急止血)」= force_legacy on 一条,即时;「彻底关」= 四杆 off。批量非原子(逐条 stage/apply),半途失败由面板组合状态行显式暴露(「组合异常」),不造新事务机制。
