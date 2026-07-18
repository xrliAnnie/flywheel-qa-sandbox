# FLY-1344 env 冷开关收编进 flag 控制台 — 调研

Issue: FLY-1344 (https://linear.app/geoforge3d/issue/FLY-1344/flags-env-冷开关收编进-flag-控制台-dag-force-legacy-优先founder-可见可操作理想热切换)
日期: 2026-07-17
基于: exploration.md

> 所有锚点基于 merge 了 origin/main(fae547750,含 #626 = FLY-1307 PR-8)之后的本分支。

## 1. FLY-709 控制台机制(改造落点)

### 1.1 注册表与安全闸

- `packages/config/src/feature-flags/registry.ts` — `ReadTiming = call_time | bridge_boot | object_construction | cli_invocation | mixed`(:39);`FeatureFlagSpec.toggleable = direct | conversational | readonly`;direct 必填 `directToggleProof`(:81)。
- `packages/teamlead/src/bridge/flag-toggle.ts:70` `isDirectToggleable`:`source==="env" ∧ scope==="bridge_global" ∧ valueKind==="bool" ∧ toggleable==="direct" ∧ category!=="governance_gate" ∧ readSites 非空 ∧ 每个 readSite.timing==="call_time"`。
- schema 不变量测试:`packages/config/src/feature-flags/__tests__/registry.test.ts`(direct ⇒ 全 call_time + proof;governance/dormant ⇒ readonly)— **改 isDirectToggleable 必须同步改这里的不变量**。

### 1.2 apply 事务(已具备双路径热生效能力)

`flag-toggle.ts::applyFlagToggle`:文件锁内 → 重校验 `.env` SHA + live `process.env[envVar]`==rawFrom → **先原子写 `~/.flywheel/.env`**(env-file-writer)→ 再 in-proc 突变 Bridge `process.env`。envPath 固定 `~/.flywheel/.env`(plugin.ts:1768)。路由 `/api/fleet/flag/{stage,apply}`:loopback + same-origin + SHA 绑定单次 confirmToken + `fleet_admin_audit` 全程落审计行(flag-routes.ts)。

### 1.3 显示层

- `resolve.ts::resolveEnvEffective`:env flag 的 effective **只看 Bridge process.env**(:95-108)。
- `feature-flag-render.ts:29` badge:`readTimings.every(call_time) → 热生效,否则 需重启` — 二分,无 dotenv-live 概念。
- `feature-flag-report-html.ts`:全部 flag 渲染;仅 direct 出 checkbox → 生成 `flywheel-comm feature-flags apply --name X --to on|off` 复制命令(Annie locked control model:页面零网络回调,复制粘给 Lead 执行)。

## 2. DAG 五杆事实表(main @ fae547750 实证)

| 杆 | envVar | 注册类别/toggleable | 真实读取路径(锚点) | 今天热不热 |
|---|---|---|---|---|
| 派发总闸 | FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH | governance_gate / readonly | `workflow-template-dispatch.ts::isWorkflowTemplateDispatchEnabled`,统一谓词 `workflowTemplateDispatchBlockReason` 每次 start 现读 env(call_time) | **热**(process.env 突变即生效) |
| claims 写 | FLYWHEEL_WORKFLOW_CLAIMS_WRITE | governance_gate / readonly | ① `StateStore.ts:12938/14434` call_time;② **`plugin.ts::createWorkflowShadowWriterFromEnv` boot 构造**:≠1 → writer=undefined → dispatcher 预启/orchestrator hooks/post-ship T9 全 seam 休眠;`setWorkflowShadowFinalizationHook` 仅 boot 启用时挂 | **不热(唯一结构性挡板)** |
| claims 读 | FLYWHEEL_WORKFLOW_CLAIMS_READ | governance_gate / readonly | ① call_time(workflow-claims.ts);② CLI 侧 `ship-eligibility.ts::resolveWorkflowClaimsReadEnabled` **每次现读 ~/.flywheel/.env 文件** | **热** |
| v2 模板 | FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES | governance_gate / readonly | `workflow-template.ts:18` call_time(StateStore 准入 :12468/12654/12714/12935/14431) | **热** |
| 应急回退 | FLYWHEEL_WORKFLOW_FORCE_LEGACY | kill_switch / readonly | ① CLI:`ship-eligibility.ts:287 resolveDefaultOffGate` **每次现读 ~/.flywheel/.env**(文件权威含 key-absent,process.env 仅文件不可读时 fallback);② Bridge:`merge-ship-gate.ts::computeShipDecision` 传 process.env,key 在时 argsEnv 赢 → 读 Bridge 进程 env | **热**(apply 事务双写恰好双路径覆盖) |

配套 boot 事实:`importBundledWorkflowSeeds`(plugin.ts:3737)与 `ensureDefaultWorkflowBindings`(:3946)**无条件**执行,content-hash 幂等 — 种子/绑定不构成热启用障碍。`WorkflowEngineDispatcher` 构造时持 `env: process.env` **引用**(:5020)— in-proc 突变可见。

生产 .env 现值:`FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`(第 145 行);四根启用杆均未设(=off)。

### 2.1 force_legacy=1 今天真实作用

`evaluateQaShipGate`(ship-eligibility.ts:276-328):durable-QA 会话(session_role=qa ∧ chat_thread_role=qa)在 forceLegacy=false 时要求 claims_read 开且从 claims ledger 解裁决(claims 缺 → fail-closed);forceLegacy=true → 跳过 claims 路径,走 legacy `auto_qa_record` 读取。`workflow-claims.ts::isWorkflowLegacyForced` 无生产调用方(预留)。FLY-1307 注册 note 原文:「Roll back with workflow_force_legacy plus this flag off」。

### 2.2 claims_write 热接线改造面(方案 A′ 第五件)

需要动的点(全部 `packages/teamlead/src`):

1. `bridge/workflow-shadow-writer.ts::createWorkflowShadowWriterFromEnv` — 由「flag off → undefined」改为无条件返回 writer;flag 检查下沉到每个 hook 方法调用内(per-call `isWorkflowClaimsWriteEnabled(env)`,env 持 process.env 引用)。writer 方法均经 `safe()` 包裹(warn 不 throw),下沉检查不改错误面。
2. `bridge/plugin.ts:4845-4883` — writer 常构造;`setWorkflowShadowFinalizationHook` 无条件挂(hook 内部同一 per-call 检查);boot 日志行改为按当前 env 陈述(不再作为唯一开关点)。
3. byte-compat 证据:FLY-1232 的「flag off → 零 shadow 写」真值表已有 sentinel 测试;改造后 OFF 路径必须逐字同(突变验证:检查点从「writer 不存在」移到「writer 存在但每 hook 短路」,断言零 DB 写、零 probe 调用)。
4. 注册表:claims_write readSites 去掉 bridge_boot 行,timing 收敛全 call_time。

风险:FLY-1232/1307 的「single default-off switch point」是 Codex 批过的设计语义;本改造把单开关点从「构造与否」移到「每 hook 短路」,开关语义等价、检查点数量从 1 变 N(N=hook 数)。缓解 = 突变测试逐 hook 断言 + OFF sentinel 复跑。

## 3. 五杆收编的授权模型论证(Codex 预答)

- **不动的红线**:`isDirectToggleable` 继续结构性拒绝 `governance_gate`;真授权面治理门(founder_consent_decision_mode / founder_attribution_gate / comm_bypass_bridge / lead_lease_bypass / founder_ux_gate)零变化。
- **重分类依据**:四根启用杆当年标 governance_gate 的语义是「enable 决策待呈 Annie ship gate」(FLY-1307 plan §4.3);Annie 2026-07-17 直令(本单)即该决策的行使:开/关 DAG 的控制权交到控制台一句话。杆本身切换的是 pipeline 机制(claims ledger vs legacy 表、模板派发 vs 三段式 belt),**不是 merge 授权归属**:两条路径 founder approve + Codex gate + fail-closed 语义都在(§2.1;dispatch 谓词缺旗 = fail-closed 拒,1281 门序)。重分类为 `feature`(polarity opt_in 语义吻合),force_legacy 保持 `kill_switch`。
- **操作面授权不变**:唯一写入口仍是 loopback + same-origin + confirmToken 的 stage/apply + 全程 audit;页面永远只生成复制文本(零网络回调),执行者是 Annie 粘贴指令的 Lead — founder-in-the-loop 由控制模型构造保证。
- **组合半失败**:批量 = 逐条 apply 命令,非原子。面板组合状态行(§4)把「部分启用」显示为「⚠ 组合异常」+ 缺哪根杆,天然自暴露;不新造批量事务。

## 4. 显示诚实度:双源解析与分歧呈现

resolver 现只读 Bridge process.env(§1.3)。设计要求 env flag 双算:

- `procVal` = Bridge process.env 语义值(现状逻辑);
- `fileVal` = `~/.flywheel/.env` 现读语义值(复用 ship-eligibility 的 readEnvValueFromContent 同款解析,byte-same 语义;文件不可读 → 无 fileVal)。

| timing 类 | 权威 | 分歧时呈现 |
|---|---|---|
| 全 call_time | process.env(Bridge 内读) | fileVal≠procVal → 「.env 已改,Bridge 未拾取(下次重启拾取/或经 console re-apply)」 |
| 含 dotenv_live | 文件(CLI 权威)/process.env(Bridge 侧) | 分歧 = 真分脑 → 「⚠ CLI 与 Bridge 见值不同」响亮警告 |
| 含 bridge_boot / object_construction | boot 快照 | fileVal≠procVal → 「已 stage,待重启生效」(= issue 要的冷开关 stage 呈现) |

经 console apply 的改动双写一致,分歧只来自带外手改或重启前窗口 — 正是需要暴露的状态。stage 路由的 `rawFrom` 基线继续取 process.env(apply 门再校验文件 SHA,带外改文件 → 409 deny,行为已正确;对 dotenv_live flag 面板显示以 fileVal 为主)。

## 5. Goal 2 盘点数据

- 注册表 123 flag:13 direct / 63 conversational / 47 readonly;47 个 readonly env flag 的 timing 分布见 dump(设计工件,scratchpad 复现命令:node dump-flags.mts)。已知失真样本:`merge_approval_gate_killswitch` note「改后需重启 Bridge」与代码 live-.env 双向热读矛盾(ship-eligibility.ts 头注释);qa_done_gate / claims_read / force_legacy 同型。→ sweep = 注册表数据修正(timing/note),**不改这些杆的 readonly 地位**(merge 授权应急阀,保持只读)。
- 生产 .env 43 个 FLYWHEEL_* key:8 注册 / 11 allowlist / **24 两边都不在**(FLYWHEEL_AUTO_REPAIR、FLYWHEEL_ALERT_THREADS、FLYWHEEL_ROUNDTABLE_*×7、FLYWHEEL_SWAP_PRESSURE_*×2、FLYWHEEL_ACCOUNT_SELF_HEAL、FLYWHEEL_STUCK_ERRORSIG、FLYWHEEL_XHS_REVIEW、FLYWHEEL_DETECTION_GAP_SCAN、FLYWHEEL_PANE_MULTIFRAME、FLYWHEEL_NOTIFY_*×2、FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID、FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID、FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN、FLYWHEEL_ALERT_RATE_PER_MIN、FLYWHEEL_SANDBOX_REMOTE_URL、FLYWHEEL_RUNNER_BACKEND)。
- **测量口径(阳性对照)**:drift 测试只扫 4 个 src 目录的 `process.env.FLYWHEEL_*` 正则;我的 allowlist 提取是行首 `KEY:` 正则粗解析。阳性对照:FORCE_LEGACY 正确落「注册」桶。24 是上界 — 部分为 shell/插件 fork 消费(drift 结构性盲区)、部分或为 allowlist 折行漏解析。归类到人 = implement 阶段逐 key「注册(readonly 可见行)or allowlist(带理由)」,drift 测试此后强制收敛。token 类(FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN)绝不进注册表(DTO secret-free 红线),allowlist 标 secret。

## 6. 风险登记

| 风险 | 对策 |
|---|---|
| claims_write 热接线破坏 FLY-1232 OFF 真值表 | OFF sentinel 复跑 + 逐 hook 突变测试(断言零 DB 写/零 probe);行为检查点等价论证进 plan |
| 半启用组合(批量 apply 中断) | 面板组合状态行显式「⚠ 组合异常 + 缺杆名」;不造批量事务(boring) |
| 重分类被质疑削弱治理 | §3 论证 + 真授权面治理门零变化清单进 PR 描述;Codex design review 专项问 |
| registry.test.ts 不变量与新 timing 冲突 | 同 PR 更新不变量:direct ⇒ 全 readSite ∈ {call_time, dotenv_live} + proof;dotenv_live 的 proof 形态 = 写 .env 后同进程真实解析函数观察到新值 |
| 带外手改 .env 与 stage 基线竞态 | 既有 409(fileSha/rawFrom 复核)已覆盖;研究确认无需新机制 |
| resolver 读文件 IO | report 人驱动低频;每次渲染读一次文件,可接受 |
| 与 PR-8 后续(FLY-1307 收尾/QA caveats)撞车 | 本单不改谓词与 seam 语义(除 shadow-writer 构造点);registry 数据区冲突行级小 |
