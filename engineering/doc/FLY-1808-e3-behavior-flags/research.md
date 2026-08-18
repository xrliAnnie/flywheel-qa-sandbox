# FLY-1808 E3 会改变行为的 flag 逐条删除 — 调研

Issue: FLY-1808 (https://linear.app/geoforge3d/issue/FLY-1808/flag执行e3-会改变行为的-10-条逐条删-显式固化值不许批量)
日期: 2026-08-17
基于: exploration.md

本文是 E1 硬门①(固化方向以**解析器的真缺省**为准,registry.default 不是权威)和 Tadashi 三格证据(①生产现值 ②absent-read 分支 ③registry.default 合法性)在**设计期**的落账。全部判读式逐字取自本 worktree HEAD(`e54ece67b`,含 E1 PR #859 / E2 PR #860);生产值取自 `~/.flywheel/.env` 直读 + FLY-1782 audit 已核的活 Bridge 进程环境。

## 1. 逐条证据表(12 条)

> 列说明:**判读式** = 解析器原文(硬门①权威);**生产现值** = 当前生效值;**absent-read** = 读不到 env/config 时实际走的分支;**固化成** = 本单的显式固化值(冻结现值)。

### 1.1 五个派工开关(Wave B,一个决定,挂 D-2 征询)

| # | flag / envVar | 判读式(file:line) | 生产现值 | absent-read | registry.default | 固化成 |
|---|---|---|---|---|---|---|
| 1 | `workflow_template_dispatch`<br>`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH` | `env.… === "1"`<br>`workflow-template-dispatch.ts:16` | **开**(`.env:160`,注释「2026-07-31 Annie 拍板恢复 DAG 派工」) | 关 | `false`(合法,≠现值) | **开** |
| 2 | `workflow_generalized_templates`<br>`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` | `env.… === "1"`<br>`workflow-template.ts:17` | **开**(`.env:150`,光秃无注释;**无可援引批准出处**——审计通路不记录此类批准,沉默证明不了两边 **→ D-2**) | 关 | `false`(合法,≠现值) | **开**(待 D-2 答复) |
| 3 | `workflow_claims_write`<br>`FLYWHEEL_WORKFLOW_CLAIMS_WRITE` | `env[KEY] === "1"`<br>`workflow-claims.ts:123` | **开**(`.env:141`;fleet 翻转审计行 `2026-07-19T00:54:09Z` 只证何时经何面翻开;**无可援引批准出处,沉默证明不了两边 → D-2**) | 关 | `false`(合法,≠现值) | **开**(待 D-2 答复) |
| 4 | `workflow_claims_read`<br>`FLYWHEEL_WORKFLOW_CLAIMS_READ` | `env[KEY] === "1"`<br>`workflow-claims.ts:128`;另有 CLI 侧 live-`.env` 读:`ship-eligibility.ts:40`(`resolveDefaultOffGate`)、`verify-approval.ts:149-159` | **开**(`.env:142`) | 关(CLI 侧:`.env` 可读则以 `.env` 为权威,含 key-absent) | `false`(合法,≠现值) | **开** |
| 5 | `workflow_gate_carrier`<br>`FLYWHEEL_WORKFLOW_GATE_CARRIER` | `env.… === "1"`<br>`workflow-template-dispatch.ts:21` | **开**(`.env:151`) | 关 | `false`(合法,≠现值) | **开** |

**串联证据**:`workflowTemplateDispatchBlockReason()`(`workflow-template-dispatch.ts:29-42`)一个 fail-closed 谓词收口:dispatch 需 #1+#3+#4;schema v2 另需 #2。今天所有已发布模板都是 schema 2 ⇒ 少开一个整条链停摆。生产谓词消费者(Codex R1 补全):teamlead 8 文件(`workflow-claims.ts` / `workflow-template-selection.ts` / `workflow-engine-dispatcher.ts` / `workkind-cutover.ts` / `runs-route.ts` / `workflow-template.ts` / `workflow-template-dispatch.ts` / `StateStore.ts`)+ `bridge/merge-ship-gate.ts:300`、`bridge/external-merge-reconcile.ts:750`(直接消费 `resolveWorkflowClaimsReadEnabled`)+ CLI 侧 `ship-eligibility.ts` / `verify-approval.ts`。**运行量证据带时间点**:audit 时点为 22 run / 31 claim;2026-08-17 两次只读复核已漂移到 312→313 run / 261 claim(313 中 schema2=218 / schema1=36 / NULL=59)——总 run 数证明**采用规模**,不证明每条历史 run 都依赖两个 gate;「关掉会停」的成立证据是**当前 5 个已发布模板全为 schema2 + 新派工串联要求**。引用时必须重跑 census 并标注 timestamp。

**焊死语义边界**(不碰的):`gate_carrier_epoch=0` 的 legacy run 语义键在 run-frozen epoch 上(registry note 原文「The run-frozen gate_carrier_epoch, not the live env, owns prompt, fence, holder, and scanner behavior」);claims enrollment 是 per-run typed marker(「never inferred from these flags」)。焊死只改「新 run 的准入恒通过」,历史 run 分支保留。

**claims_read 的 CLI 特殊性**:`resolveDefaultOffGate` 支持 argsEnv 测试覆盖 + live-`.env` + processEnv 三级;焊死后该 key 的三级解析整体删除(CLI 侧恒 ON),依赖「argsEnv 注 0」做 legacy 路径断言的测试属于被删除的可配置性,一并清理。

### 1.2 Annie 单独裁决四条(Wave A)

| # | flag / envVar | 判读式 | 生产现值 | absent-read | registry.default | 固化成 |
|---|---|---|---|---|---|---|
| 6 | `founder_ux_gate_killswitch`<br>`FLYWHEEL_FOUNDER_UX_GATE_ENABLED` | `env.… === "1"`<br>`founder-ux-config.ts:79` | **OFF(门全舰禁用)**——`.env` 零命中 | OFF(门禁用) | `false`(合法,==现值) | **门不在**(机制整体删除) |
| 7 | `founder_ux_gate`<br>project config `founder_ux_gate.mode` | `resolveEffectiveFounderUxConfig`:absent → `enforce`(FLY-869);但四处消费者全部先查 #6 =1 才生效(Blueprint.ts:2275 / claude-lead.sh:2635 / status route / stage-guard) | **不生效**(被 #6 短路;flywheel 自身 config 无该块) | `enforce`(但被 #6 短路 = 实际无效果) | `"enforce"`(合法,但**语义上与现实脱钩**——absent-read 的组合真值是「门不在」) | **门不在**(config 键随机制拆除) |
| 8 | `runner_autocontinue`<br>`FLYWHEEL_RUNNER_AUTOCONTINUE` | `this.env().… === "1"`<br>`autocontinue-armer.ts:90`;boot gate `plugin.ts:10305` | **OFF**——`.env` 零命中,canary 从未发生(armer 从未启动) | OFF | `false`(合法,==现值) | **关(机制不存在)** |
| 9 | `comm_bypass_bridge`<br>`FLYWHEEL_COMM_BYPASS_BRIDGE` | `env.… !== "1"` → 拒绝直写<br>`respond.ts:88` | **OFF(无旁路)**——`.env` 零命中 | OFF(拒绝直写,报错指引 BRIDGE_URL) | `false`(合法,==现值) | **无旁路**(应急直写分支删除) |

- #6/#7 是一体的:killswitch(FLY-900)叠在 per-project mode(FLY-598/869)之上,「删」= Annie 原话「删掉就可以了」= 把 FLY-598/869/900 三层机制整体拆掉。四处消费者短路已逐一核实 ⇒ **删机制 = 零行为变化**。
- #8 出处是 **primary 书面裁决**(FLY-1782 comment `57704cd4` S-2【⑧」,她明确知道等于放弃未做过的 canary)。
- #9 删除后 `approve_to_ship` 在 Bridge 不可达时**无逃生口**(严格 fail-closed)。这是「无旁路」的字面代价,Annie 已裁决;PR 判词必须写明。

### 1.3 D-1 + 设计期并入两条(Wave A)

| # | flag / envVar | 判读式 | 生产现值 | absent-read | registry.default | 处置 |
|---|---|---|---|---|---|---|
| 10 | `cmux_linked_view`<br>`FLYWHEEL_CMUX_LINKED_VIEW` | `case "${FLYWHEEL_CMUX_LINKED_VIEW:-1}"`<br>`flywheel-cmux-sync.sh:3387`(非法值 fail-safe 回 1);`flywheel-cmux-autostart.sh:48` 缺省 1 | **关**(`.env:136` 显式 `=0`) | **开** ⚠️ 与现值相反 → 硬门③ 触发 | `true`(合法,≠现值) | **固化成关(独立视图)**;先改缺省再删,顺序不许反 |
| 11 | `lead_dry_run`<br>`FLYWHEEL_LEAD_DRY_RUN` | `= "1"` 判等,散布全仓约 30 处(claude-lead.sh 15+ 处、5 个 codex lead 脚本、`canonical-lead-identity.sh:133`、`codex-lead.sh:142`、两个 TS runtime) | **per-invocation**:守护进程路径恒 OFF(`.env` 零命中);两个生产 setter 逐次设 1(`verify-anna-isolation.sh:122`、`buddy-captain-preview.sh:148`) | OFF | `false`(**registry readSites 严重不全**:只登记 1/约 30) | **搬** → `exemptions.ts` **`FLAG_EXEMPTIONS` 显式 object**(不改 `QA_AND_INVOCATION_SEAMS` 数组),零代码行为变化 |
| 12 | `done_thread_reconcile`<br>`FLYWHEEL_DONE_THREAD_RECONCILE` | `env.… !== "0"`<br>`done-thread-reconcile.ts:101` | **ON**(`.env` 零命中,absent=ON) | ON | `true`(合法,==现值) | **搬** → 同上(`FLAG_EXEMPTIONS` 显式 object);生产恒 ON 不变,QA 房 `test-deploy.sh:916` 继续注 `=0` 防扫真 Linear |

D-1 的固化方向由本单方向规则闭合:冻结现值 = 关,与她的裁决原话「关掉删了算了」一致(她的裁决存在,缺的只是固化值,HL comment 已确认此路径合法:「若要保持现状(关),则必须先改默认值再删」)。

## 2. 机制面清点(删除手术的解剖图)

### 2.1 founder-UX 门(#6/#7,最大件)

| 区块 | 内容 | 处置 |
|---|---|---|
| `packages/teamlead/src/bridge/founder-ux/` | `routes.ts` / `signoff.ts` / `stage-guard.ts` / `trigger.ts` / `verify.ts` + `__tests__`(约 621 行 src) | 整目录删除 |
| `packages/config/src/founder-ux-config.ts` | `isFounderUxGateEnabled` / `resolveEffectiveFounderUxConfig`(80 行) | 删除 |
| `packages/config/src/ConfigLoader.ts:455-…` | `founder_ux_gate` YAML 校验块 | 删除(validate 只读已知键,stale YAML 块自然被忽略——已核实无 unknown-key 严格拒绝) |
| `packages/config/src/types.ts` / `index.ts` | `FounderUxGateConfig` 类型与导出 | 删除 |
| `packages/edge-worker/src/Blueprint.ts:973/2264-…` | 构造参数 + prompt 注入块 | 删除 |
| `packages/teamlead/scripts/claude-lead.sh:2594-2639` | awk 读 mode + killswitch 判 + rules_bundle_add | 删除 |
| `lead-rules-base/founder-ux-rules.md` | 门的 Lead 规则文本 | 删除 |
| `DirectEventSink.ts` / `event-route.ts` / `run-infra.ts` / `runs-route.ts` | signoff 事件/路由接线 | 逐处删除(实现期以 `grep -ri "founder_ux\|founderUx\|FOUNDER_UX\|founder_facing_ux\|FOUNDER_UX_SIGNOFF_REQUIRED"` 零命中收口,fixture/tombstone/migration 除外) |
| (Codex R1 补全)`flywheel-comm/src/commands/founder-ux.ts` + `index.ts` 三条 CLI 命令 + `commands/stage.ts` implement fail-close 特判 + `bridge/actions.ts:1320` retry 传播 + `workflow-engine-dispatcher.ts:2682` successor 传播 + plugin route mount | 公开 CLI 与引擎传播面 | 全部删除 |
| `StateStore.ts:2912/2919/2928` | **三**列:`founder_facing_ux` / `founder_ux_signoff_json` / `founder_ux_gate_mode` + ADD COLUMN 迁移 | **三条迁移全保留**(惰性历史数据;删迁移断旧库重放)。三列的 TS 类型字段与 read/write wiring 删除 |

### 2.2 AutoContinueArmer(#8)

(Codex R1 补全)armer 是 `autocontinue-arming.ts` / `autocontinue-goal.ts` / `autocontinue-state.ts` 的**唯一生产消费者**——四文件合计 683 行整体删除 + `plugin.ts:10299-10305` boot gate 与 import + 相关测试 + `truth.ts:512` 的 companion knob `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` NON_FLAG_ALLOWLIST 行。runner-state 既有 goal/armed 残留文件声明惰性、不清理。FLY-818 ②(stuck→founder-page)是独立机制,零接触。

### 2.3 comm 旁路(#9)

`respond.ts:88-116` 应急直写分支(含 `writeBypassAudit` 调用)+ `:257` 报错文案里的 override 指引 + `:332` audit reason 常量 + `index.ts:195` help 文本。`founder-consent-audit.ts` 的 `writeBypassAudit` 若因此不可达 → 按 dead-code 清单列出。删除后 respond 对 `approve_to_ship` 的行为:无 BRIDGE_URL ⇒ 一律 `throw`(文案去掉 override 半句)。

### 2.4 cmux linked view(#10)

**⚠️ 本节初稿判断被 Codex R1 推翻并已修正**:初稿把 26 处 `linked_view` 名字命中当成了「flag 的死分支」——错。真实调用图:env 唯一生效读点 `linked_view_enabled()`(`flywheel-cmux-sync.sh:3386-3391`)**只**被 `check_cmux_flag_state()`(`:6843-6881`)消费,用于 A0B1 信息告警 latch(主循环 `:8651`);view 构建/恢复机器(`_linked_view_matches()` / `prepare_linked_view_state()` / WAL 恢复 / `repair_view_invariants`,如 `:7006` / `:7014`)是**无条件活链**,函数名含 linked_view 但与 flag 无关,一行不动。删除面 = 两个 env 读点(sync `:3387` + autostart `:48`)+ flag-state 观测项(有意删除的观测行为,单独 disposition)。**部署面**:cmux-sync 有部署副本 md5 对账(FLY-1446 C),合并后走正常 restart-services 同步;`.env:136` 行在 ship 步骤清理(代码删读点后该行成 stale,但不影响行为)。

### 2.5 搬迁载体(#11/#12)

(Codex R1 修正形状)`QA_AND_INVOCATION_SEAMS` 是私有 string array,统一 map 成 owner=flywheel-eng-lead / issue=FLY-1455 / 通用 reason / `persistentEnvAllowed:false`——装不下逐条 FLY-1808 归因 ⇒ 落账改为在 `FLAG_EXEMPTIONS` 追加两个**显式 object**(17 项数组字节不动),各带 `issue:"FLY-1808"` 与专属 reason。registry 行删除 + `RETIRED_FLAGS` **不**加(env 仍被读,tombstone 语义是「不许再读」)。FLY-1455 漂移守卫四账收口,搬迁 = registry→exemption 账目转移,守卫加**四联断言**:不在 registry、不在 tombstone、在 exemption、生产读点仍存在。

## 3. 台账与守卫房子样式(实现要跟的)

- **tombstone**:`truth.ts` `RETIRED_FLAGS`(`{ envVar, retiredBy }`)——只承担 **env** tombstone。具名集合(R2-#4):**9 个退休 flag env**(#1-#6、#8-#10)+ **1 个退休 companion non-flag env**(`FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS`),均 `retiredBy: "FLY-1808"`;#7 `founder_ux_gate.mode` 是 **project config key**,不进 env tombstone,由「registry/config read/type/validator 零残留」守卫单独收口。
- **集合守卫**:E1(PR #859)加了 31 条集合守卫测试;本单同款——per-wave 守卫断言「这批 envVar 在生产源码零读点、registry 零行、tombstone 有账」。
- **E1 实现期三格证据**(Tadashi 追加硬门,对本单同样生效):每条 PR 判词记 ①生产现值 ②absent-read 分支(≠现值即本单存在意义,逐条写明固化方向如何覆盖)③registry.default 合法性。本文 §1 表即为底稿。
- **E2 的 OFF sentinel 教训**(FLY-1807/FLY-1205 lineage):固化 ON 的删除要配 reverse-compat 断言——固化后代码路径 == 现值路径,逐条定向测试。

## 4. 生产 `.env` 清理清单(ship 步骤,代码删除后执行)

| 行 | 内容 | 动作 |
|---|---|---|
| 136 | `FLYWHEEL_CMUX_LINKED_VIEW=0` | Wave A ship 后删行 |
| 141/142/150/151/160 | 五个派工开关 `=1`(含 160 的 Annie 拍板注释、143 的 7-27 freeze 注释残行) | Wave B ship 后删行(拍板注释的史料价值已由 audit.md 承载) |
| — | `FLYWHEEL_MAILBOX_DISCORD=1`(162) | **不动**(D-3 显式排除) |

## 5. 悬而未决 / 依赖

1. **D-2 征询**(Wave B 的门):征询卡文本见 plan.md §6,由 Tadashi 转达。她答「条款对齐现状」⇒ Wave B 按本文执行;答「回到条款」⇒ Wave B 废弃,回 Lead 重新立项(形状是关闭+验收,不是冻结)。
2. **搬 vs 删的偏离报备**:已发 `flywheel-comm ask`(question `f0b96060`),plan 按搬编写;Lead 否决则 #11/#12 退回 needs-decision。
3. **并行冲突面**:registry.ts / truth.ts / exemptions.ts 是 E 系列共同热区,FLY-1455(PR #862 系列)与本单可能相邻;实现期 rebase 按「两边加性都保」处理。
