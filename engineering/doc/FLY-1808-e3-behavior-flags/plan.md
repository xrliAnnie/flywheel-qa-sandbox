# FLY-1808 E3 会改变行为的 flag 逐条删除 — 实施计划

Issue: FLY-1808 (https://linear.app/geoforge3d/issue/FLY-1808/flag执行e3-会改变行为的-10-条逐条删-显式固化值不许批量)
日期: 2026-08-17
基于: research.md(v2:并入 Codex design review R1 全部 7 项)

---

## 0. 一句话

12 条「当前生效值 ≠ 真默认值」的 flag,逐条(不许批量)固化成**当前生效值**:10 条真删(其中 5 条派工开关挂 D-2 founder 征询后作为**一个决定**执行),2 条按硬门②推论**搬**为 invocation seam;每条在 PR 里单独写明固化值 + 三格证据。

## 1. 硬门合同(全程有效,逐条适用)

沿 E1(FLY-1806)三条 + Tadashi 实现期追加:

1. **解析器优先**:固化方向以解析器真缺省为准,`registry.default` 不是权威。每条 PR 判词逐字引用判读式(research.md §1 已备好底稿)。
2. **逐条固化值**:每删一条,PR 单独写明「固化成哪个值 + 为什么」。**不接受「本批统一固化成现值」这种整体表述**(issue 明令)。
3. **先改值再删**:现值 ≠ 缺省的,删除顺序必须保证任何中间态(commit 边界、部署窗口)生效值不变,且**「先改值」指改真实解析器缺省,不是只改 registry 行**——registry 与 runtime 在任何 commit 上不许背离。本单 6 条触发(五连开关 + cmux_linked_view),见 §3/§4 的 commit 排布。
4. **三格证据**:每条记 ①生产现值 ②absent-read 分支(与现值的关系、固化如何覆盖)③`registry.default` 合法性(无效不阻删但必须披露)。

## 2. 波次结构

| 波 | 条目 | 前置 | PR |
|---|---|---|---|
| **Wave A**(7 条) | `founder_ux_gate_killswitch`+`founder_ux_gate`(一体)· `runner_autocontinue` · `comm_bypass_bridge` · `cmux_linked_view` · `lead_dry_run`(搬)· `done_thread_reconcile`(搬) | 无(授权链干净) | PR-A(本分支) |
| **Wave B**(5 条,一个决定) | 五个派工开关整体焊死成开 | **D-2 征询答复**(§6) | PR-B(独立分支,答复后开工) |

Wave B 不因等待阻塞 Wave A;若 D-2 答复为「回到条款」,Wave B 按 §6.3 废弃并回 Lead 重新立项。

**时序(Tadashi 裁定,ask `f0b96060` 答复)**:D-2 重问**不等 implement**——并进 design 收尾交付,随设计 HTML 经 Tadashi 一次性呈 Annie,让她的决定有提前量。若答复(A)在 implement 开工前到达,Wave A+B **收敛为单 PR 交付**(逐条判词与 commit 排布不变,两波集合守卫在同一 PR 内先 Wave A gate 后 final union);两 PR 形态是答复未到时的 fallback。Wave A 实施照常推进,不等 Wave B 答案。

## 3. Wave A 实施步骤(PR-A)

> TDD:每个条目先落「inert 断言」RED(把被删 env 设成**输掉的那个值**,断言行为不变),再做删除转 GREEN。RED 必须落在**真实生产 seam** 上且实现前确实 RED(R1-#1 教训:名字匹配 ≠ flag 分支,先验证断言在改动前是红的)。

### 3.1 founder-UX 门整体拆除(#6 `founder_ux_gate_killswitch` 固化「门不在」;#7 `founder_ux_gate` 同)

**逐文件手术表**(R1-#5 补全;实现前以 `grep -ri "founder_ux\|founderUx\|FOUNDER_UX\|founder_facing_ux\|FOUNDER_UX_SIGNOFF_REQUIRED"` 重新全量清点,以清点结果为准):

| 区块 | 内容 | 处置 |
|---|---|---|
| `packages/teamlead/src/bridge/founder-ux/` | routes / signoff / stage-guard / trigger / verify + `__tests__` | 整目录删除 |
| `packages/teamlead/src/bridge/plugin.ts` | founder-ux route mount | 删除 |
| `packages/teamlead/src/bridge/actions.ts:1320` 一带 | retry 时的 founder-ux 传播 | 删除 |
| `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:2682` 一带 | successor 传播 | 删除 |
| `packages/flywheel-comm/src/commands/founder-ux.ts` | 公开 CLI 实现 | 删除 |
| `packages/flywheel-comm/src/index.ts` | 三条 founder-ux CLI 命令注册 + help | 删除 |
| `packages/flywheel-comm/src/commands/stage.ts` | `stage set implement` 的 founder-UX fail-close 特判与解释文案 | 删除 |
| `packages/config/src/founder-ux-config.ts` | `isFounderUxGateEnabled` / `resolveEffectiveFounderUxConfig` | 删除 |
| `packages/config/src/ConfigLoader.ts` | `founder_ux_gate` YAML 校验块 | 删除(validate 只读已知键,stale YAML 块自然被忽略——已核实无 unknown-key 严格拒绝) |
| `packages/config/src/types.ts` / `index.ts` | `FounderUxGateConfig` 等类型与导出 | 删除 |
| `packages/edge-worker/src/Blueprint.ts` | 构造参数 + prompt 注入块 | 删除 |
| `packages/teamlead/scripts/claude-lead.sh:2594-2639` | awk 读 mode + killswitch 判 + rules_bundle_add | 删除 |
| `lead-rules-base/founder-ux-rules.md` | 门的 Lead 规则文本 | 删除 |
| `DirectEventSink.ts` / `event-route.ts` / `run-infra.ts` / `runs-route.ts` | signoff 事件/路由接线 | 逐处删除 |
| `StateStore.ts` | **三**列:`founder_facing_ux` / `founder_ux_signoff_json` / `founder_ux_gate_mode`(ADD COLUMN @ 2912/2919/2928) | **三条 migration 全保留**(惰性历史数据;删 migration 断旧库重放);三列的 TS 类型字段与 read/write wiring 删除 |

步骤:

1. RED(输掉值显式注入):(a) `FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1` + 项目 config `founder_ux_gate.mode: enforce` 时 Blueprint prompt **不含** FOUNDER-UX GATE 块;(b) claude-lead.sh dry-run launch plan(`FLYWHEEL_LEAD_DRY_RUN=1`)同样注入 `=1`,断言 rules bundle 不含 `founder-ux-rules.md`;(c) 原 signoff 路由不再注册;(d) 旧 CLI 命令不再注册;(e) `stage set implement` 不再识别 founder-UX 专用错误;(f) 合法与畸形 stale `founder_ux_gate` config 块都不影响 config load / Lead launch。
2. 按手术表删除;收口 sweep 覆盖 `founder_ux` / `founderUx` / `FOUNDER_UX` / `founder_facing_ux` / `FOUNDER_UX_SIGNOFF_REQUIRED` / 三条 CLI 命令名(白名单:StateStore migration 语句与列注释、tombstone、历史文档)。
3. 台账:registry 两行删除;`RETIRED_FLAGS` 加 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED`(retiredBy FLY-1808);config key `founder_ux_gate.mode` 在 tombstone 旁注释点名(config-key 无 envVar 形态)。

### 3.2 `runner_autocontinue` 固化「关(机制不存在)」(#8)

1. RED:`FLYWHEEL_RUNNER_AUTOCONTINUE=1` 时 Bridge boot 不启动 armer poll。
2. **删整个 FLY-818① 机制**(R1-#6):`autocontinue-armer.ts` + 唯一消费链 `autocontinue-arming.ts` / `autocontinue-goal.ts` / `autocontinue-state.ts`(四文件合计 683 行)+ 全部对应测试 + `plugin.ts` import/boot wiring + `truth.ts:512` 的 `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` NON_FLAG_ALLOWLIST 行(companion knob 随机制同灭)。
3. runner-state 目录既有 goal/armed 残留文件:声明为惰性残留,不做破坏性清理。
4. 收口 sweep 用**具名清单不用泛化词**(R2-#5:泛化 `rg -i autocontinue` 会撞独立的 roundtable auto-continue 活链):四个文件/模块名 + `AutoContinueArmer` + FLY-818① 专属 helper/export + `FLYWHEEL_RUNNER_AUTOCONTINUE` / `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 两个 env,零命中;**显式不相关保留项**:`roundtableAutoContinue`、`FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE`(FLY-676/roundtable 活链)。FLY-818②(stuck→founder-page)以其自身测试证明 source diff 为零。
5. registry 行删除 + tombstone(`FLYWHEEL_RUNNER_AUTOCONTINUE`,另加 `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 一并入 tombstone,retiredBy FLY-1808)。

### 3.3 `comm_bypass_bridge` 固化「无旁路」(#9)

1. RED:`FLYWHEEL_COMM_BYPASS_BRIDGE=1` 且无 BRIDGE_URL 时 `respond` 对 `approve_to_ship` 一律 throw(bypass inert)。
2. 删 `respond.ts:88-116` 直写分支、`:257` 文案 override 半句、`:332` bypass audit reason、`index.ts:195` help 行;`writeBypassAudit` 若不可达列入 dead-code 清单一并删;registry 行删除 + tombstone。
3. PR 判词写明代价:Bridge 不可达时 founder 批准无逃生口,先修 Bridge(Annie 裁决的字面含义)。

### 3.4 `cmux_linked_view` 固化「关(独立视图)」(#10)——硬门③触发,commit 顺序固定

**真实调用图**(R1-#1 修正,推翻 research.md §2.4 的「26 处死分支」判断):env 唯一 TS/shell 生效读点是 `flywheel-cmux-sync.sh:3386-3391` 的 `linked_view_enabled()`,它**只**被 `check_cmux_flag_state()`(`:6843-6881`)消费,用于计算 A0B1 信息告警 latch(主循环 `:8651` 调用);view 构建/恢复机器(`_linked_view_matches()` / `prepare_linked_view_state()` / WAL 恢复 / `repair_view_invariants`)是**无条件活链**,与 flag 无关,**一行不动**。`flywheel-cmux-autostart.sh:48` 是第二个 env 读点。

- **commit A-1(先改真缺省,registry 三件套同翻)**:`flywheel-cmux-sync.sh:3387` `:-1`→`:-0`(含非法值 fail-safe 回 0);`flywheel-cmux-autostart.sh:48` 缺省 `1`→`0`;registry 同 commit 改 **`polarity: "default_on" → "opt_in"` + `default: true → false`**(R2-#1:`resolve.ts:143` 用 polarity 算 absent effective,`flag-routes.ts:75-96` / `management-existing-writers.ts:867-880` 用它决定「默认值删行 / 非默认值写 0/1」——只改 default 会让控制面写出与 runtime 相反的行;`feature-flags-direct-toggle.test.ts` 的 absent==default 断言也要求两者同翻)。同 commit 修掉所有会在中间态说谎的文本:registry 描述、sync 脚本的 default-on 注释、exact-metadata 测试。A-1 加 resolver + flag-stage/raw-write 测试:absent / `0` / `1` / 非法值 各自的 effective 与 on/off 写行结果。生产行为不变(`.env:136` 显式 `=0`)。
- **commit A-2(再删)**:删两处 env 读点与 `linked_view_enabled()`;**整族删除 flag-state 观测机制**——有意删除一个观测行为的单独 disposition(该观测族当前 B bit 恒 1、没有第二个真实 flag,不存在「保留族只摘一项」的形状,R2-#2)。手术清单:`CMUX_FLAG_STATE` latch 路径变量(`flywheel-cmux-sync.sh:105`)、`check_cmux_flag_state()`(`:6843-6881`)与主循环调用(`:8651`)、`cmux_flag_state` 事件 kind 在 `scripts/lead-alert.sh` informational/合法 kind 集、`LeadAlertNotifier` union 与 informational 集、`kind-contract.ts`、`alert-kind-copy.ts`、`infra-event-router` 说明,及全部对应测试。registry 行删除 + tombstone。
- RED(A-2 前,唯一 oracle,R2-#2):清空 latch、注入 `FLYWHEEL_CMUX_LINKED_VIEW=1`、驱动真实 check seam,断言「**不创建 `CMUX_FLAG_STATE` 文件且不发 `cmux_flag_state` 事件**」——改前会因创建 `A1B1|0` 文件而 RED,A-2 删除 check 后 GREEN。
- ship 步骤:`.env:136` 删行(§7)。

### 3.5 `lead_dry_run` 搬(#11)

registry 行删除;exemption 落账**形状**(R1-#7):现有 `QA_AND_INVOCATION_SEAMS` 是私有 string array、统一 map 成 owner=flywheel-eng-lead / issue=FLY-1455 / 通用 reason,装不下逐条归因 ⇒ **在 `FLAG_EXEMPTIONS` 追加显式 object**(不动 17 项数组,字节等价):`{ name:"FLYWHEEL_LEAD_DRY_RUN", kind:"env", persistentEnvAllowed:false, owner:"flywheel-eng-lead", issue:"FLY-1808", reason:"per-invocation dry-run launch-plan seam (FLY-231);约 30 读点、verify-anna-isolation.sh 与 buddy-captain-preview.sh 两个生产 setter,无单一冻结值" }`。**零代码行为变化**——读点与 setter 一字不动。守卫:FLY-1455 census 测试绿;既有 setter 脚本测试绿。**不加 tombstone**(env 仍被读,tombstone 语义冲突)。

### 3.6 `done_thread_reconcile` 搬(#12)

同 3.5 形状:registry 行删除,`FLAG_EXEMPTIONS` 追加 `{ name:"FLYWHEEL_DONE_THREAD_RECONCILE", kind:"env", persistentEnvAllowed:false, owner:"flywheel-eng-lead", issue:"FLY-1808", reason:"QA slot Linear 隔离接缝:生产从不设(absent=ON),test-deploy.sh:916 注 =0 防隔离房 sweep 扫真 Linear" }`。`done-thread-reconcile.ts:101` 判读式与 `test-deploy.sh:916` 注入一字不动。伴生两条 value knob 留在 registry(不在本单路由,PR 写明边界)。

### 3.7 PR-A 收尾

- FLY-1808 集合守卫测试(config 包)用**分波具名集合,不用总数**(R2-#4 + R4-#1:PR-A 不许断言含 Wave B 的最终集合,否则守卫反向逼 PR-A 提前删未授权 flag):
  - `WAVE_A_DELETED_ROWS`(**5**:#6 killswitch、#7 founder_ux_gate、#8 autocontinue、#9 bypass、#10 cmux_linked_view)→ registry 零行;
  - `WAVE_A_RETIRED_FLAG_ENVS`(**4**:#6/#8/#9/#10 的 envVar)+ **1 个 companion env**(`FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS`)→ 生产源码零读点(多形态 sweep:`process.env.X` / `env.X` / `env[KEY]` / shell `${X...}`)+ `RETIRED_FLAGS` 有账(tombstone 只承担 env,不伪装 config-key);
  - **1 个删除 project config key** `founder_ux_gate.mode` → registry/config read/type/validator 零残留(StateStore migration 白名单除外);
  - **2 个搬迁 env** → 四联断言:不在 registry、不在 tombstone、在 exemption、生产读点仍存在(R1-#7;两条搬迁的 registry row 消失由本四联集合单独负责)。
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 受影响 shell harness(cmux-sync / claude-lead / test-deploy smoke)。宿主负载例外按房规如实留证,canonical 结论以 CI 为准。
- codex code review(`codex:rescue`)循环至 APPROVED;独立 QA 节点按 DAG 走。
- 文档归档 + CLAUDE.md 里程碑 = PR 最后一个 commit。

## 4. Wave B 实施步骤(PR-B,拿到 D-2 答复「A. 条款对齐现状」后)

一个决定,五条一次落地。**消费者全量清单**(R1-#4 补全,实现前重跑 import/caller inventory 为准):teamlead 8 文件(workflow-claims / workflow-template-selection / workflow-engine-dispatcher / workkind-cutover / runs-route / workflow-template / workflow-template-dispatch / StateStore)+ **`bridge/merge-ship-gate.ts:300`、`bridge/external-merge-reconcile.ts:750`**(直接消费 `resolveWorkflowClaimsReadEnabled`,含恢复/完成路径)+ CLI 侧 `ship-eligibility.ts` / `verify-approval.ts`。

- **commit B-1(先改真缺省,不只 registry)**(R1-#2 + R2-#1):五个解析器全部翻成 default-ON、保留显式 `=0` opt-out——TS 谓词 `=== "1"` → `!== "0"`(`workflow-template-dispatch.ts:16,21` / `workflow-template.ts:17` / `workflow-claims.ts:123,128`);claims-read 的 argsEnv / live-`.env` / processEnv 三层(`ship-eligibility.ts:70-100`、`verify-approval.ts:145-162`)同改 absent=ON;registry 五行同 commit 改 **`polarity: "opt_in" → "default_on"` + `default: true`**(否则控制面「关闭」按 opt-in 规则删行,而删行在新 runtime 是 ON——声称保留的 opt-out 无法由 UI 写出)。同 commit 修掉所有中间态说谎文本:`workflow_template_dispatch` / `workflow_generalized_templates` / `workflow_claims_write` 的 registry 描述与 stale「must remain off until…」条款、`workflow-claims.ts:113-128` 的 DEFAULT-OFF 注释、`ship-eligibility.ts:90` 的 default-off 注释、exact-metadata 测试。B-1 测试矩阵与 A-1 对称(R3-#2):五条逐项覆盖 absent / `"0"` / `"1"` / 非法值 的 runtime + registry effective(`!== "0"` ⇒ `"1"` 与非法值均 ON),每行 on/off raw-write 结果;claims-read 另覆盖 argsEnv / live-`.env` / processEnv 三层来源各自的 absent/`0`/`1`/非法值与优先级用例。生产行为不变(`.env` 五行显式 `=1`)。
- **commit B-2(再删,只删最后的选择)**:
  1. RED:「显式 `=0` 也不再改变行为」——逐条注 `"0"`,断言 dispatch 准入、claims 写/读、gate-carrier epoch 铸造行为不变(恒 ON)。
  2. 删五个谓词函数与 `workflowTemplateDispatchBlockReason` 的 flag 检查(四个 block reason 及其文案随死);全部消费文件逐处内联 ON 分支;CLI 侧三层解析对该 key 整体删除。
  3. registry 五行删除 + tombstone 五条;集合守卫追加 `WAVE_B_DELETED_ROWS`(5)与 `WAVE_B_RETIRED_FLAG_ENVS`(5),并断言两波 union 恰为最终 10 row / 9 flag env + 1 companion env(R4-#1)。
- **历史合同测试矩阵**(R1-#4,分开逐条证明,不许合并成一句):
  - 新 run 恒 `gate_carrier_epoch=1`;
  - DB fixture 中**既有 epoch-0 run** 仍走 legacy prompt/fence/holder/scanner——现有 `StateStore.workflow-templates.test.ts:217-244` 的 epoch-0 用例靠 env=0 **创建** fixture,B-2 后不许删除,改写为**直接构造 DB 行**的 epoch-0 fixture(保住历史行为保护);
  - `claims_read_enrolled=0` 的 run 仍不从 ledger 或 live flag 推断;
  - legacy non-engine run 的 completion/finalization 仍走当前已部署语义;
  - enrolled engine run 仍走 claims/head-authority;
  - 保留 `ship-eligibility.test.ts` 现有「READ on + unenrolled → fail-closed」负例。
- **带时间点的 census**:B-2 开工前对 `teamlead.db` 做只读 active/held run census 存档(run 总数 / enrolled / epoch 分布 + timestamp + 查询语句),PR 附上——生产快照当前(2026-08-17 只读复核)活跃 engine run 均 `claims_read_enrolled=1`、`gate_carrier_epoch=1`,无活跃 engine epoch-0 run,但该事实随库漂移,以开工时 census 为准。
- 依赖被删可配置性的测试(argsEnv 注 0 断言 legacy 路径、blockReason 枚举断言)删除或改写为恒通过断言,逐条在 PR 列出——**epoch-0 fixture 类除外**(上表,改写不是删除)。
- 全仓门 + codex review + QA 同 3.7。

## 5. 测试策略汇总

| 层 | 内容 |
|---|---|
| inert 断言(每条 RED 先行) | 被删 env 设为输掉的值 ⇒ 行为 == 固化值;断言必须落在真实生产 seam,并先验证改动前确实 RED |
| 历史合同 | §4 矩阵:epoch-0 / non-enrolled / legacy non-engine 逐条,fixture 改 DB 直构 |
| 集合守卫 | **PR-A gate**(逐字镜像 §3.7):`WAVE_A_DELETED_ROWS`(5)+ `WAVE_A_RETIRED_FLAG_ENVS`(4)+ companion(1)+ config key(1)+ 搬迁四联(2)。**条件式 final gate**(仅 D-2 答 A 后,§4 B-2):追加 Wave B 两集合并断言 union == 最终 10/9+1。摘要层不许压回可被错误成员凑满的总数(R3-#3),PR-A 永不断言最终集合(R4-#1) |
| 定向回归 | workflow dispatch/claims/gate-carrier + merge-ship-gate + external-merge-reconcile;founder-ux 消费者所在文件套件 + flywheel-comm CLI/stage;respond/verify-approval/ship-eligibility;cmux-sync bash harness(flag-state latch);claude-lead dry-run plan |
| 全仓门 | lint / 22-workspace build / test:packages:run / 相关 scripts/__tests__ |

## 6. D-2 征询卡(逐字,由 Tadashi 转达;一张卡一个语义)

> **D-2 · 两个管 ship 授权的开关(`workflow_generalized_templates` / `workflow_claims_write`)——要你重新拍一次方向。**
> 你上次说「关掉删了算了,好像也没有在用」。「没有在用」经实测不成立,两个互不混淆的事实(R2-#3):
> ① **采用规模**:截至 {relay 时重跑 census 的 timestamp},账本已有 **{N} 个 workflow run / {M} 个 claim**(2026-08-17 只读快照:313 run / 261 claim;run 的 schema 分布 schema2=218 / schema1=36 / NULL=59)。
> ② **现在关会停什么**:当前 **5 个已发布、未退役模板全部是 schema 2**,而新派工串联要求 generalized + claims WRITE/READ ⇒ 关掉 = **当前派工链停摆**(你读的体检报告本身就是这条链产出的)。
> 另一半事实,不软化也不加码:**2026-07-19 启用时,当前找不到可援引的批准出处**——现有审计通路不记录这类 flag 批准,所以既不能证明批过,也不能证明没批,只能说无出处可引。
> 两个选项:
> **A. 条款对齐现状**——承认这条链,连同另外三个串联开关(template_dispatch / claims_read / gate_carrier)一起**焊死成开、永久去掉这个选择**(零行为变化)。
> **B. 回到条款**——先关掉、按原验收条款走完再说(整条派工链停摆,直到验收完成)。

### 6.1 征询时点与承载

设计 HTML(本节点交付物)带同一张卡 + 评论层;Tadashi 在 relay 设计交付时一并转达。**relay 前必须重跑同一只读 census 并替换卡内数字**(R1-#3:DB 在漂移,不带时间点的数字会失真);Wave B 的开工门绑定**修正后的卡片原文 + 她的答复**。census 的精确只读 SQL 钉死如下(R2-#3,重跑 = 逐字执行,不许只写表名):

```sql
-- sqlite3 -readonly ~/.flywheel/teamlead.db  (R3-#1:本 SQL 已于 2026-08-17 只读实跑验证,
-- 得到 313 / 261 / 59-36-218 / 5 个 schema-v2 template;同一只读事务取 timestamp 与一致快照)
BEGIN;
SELECT datetime('now') AS observed_at_utc;
SELECT COUNT(*) AS run_count FROM workflow_run;
SELECT COALESCE(CAST(json_extract(snapshot, '$.schema_version') AS TEXT), 'NULL') AS schema_version,
       COUNT(*) AS run_count
  FROM workflow_run
 GROUP BY 1;
SELECT COUNT(*) AS claim_count FROM workflow_claims;
SELECT t.template_id,
       t.current_published_revision AS revision,
       r.schema_version
  FROM workflow_template AS t
  JOIN workflow_template_revision AS r
    ON r.template_id = t.template_id
   AND r.revision = t.current_published_revision
 WHERE t.retired_at IS NULL
   AND t.current_published_revision IS NOT NULL
 ORDER BY t.template_id;
COMMIT;
```
若 relay 时 schema 真漂移 ⇒ **fail-closed**:先更新 plan 与卡片、重新过目后再征询,不许临场改写查询继续。

### 6.2 答 A ⇒ 按 §4 执行

### 6.3 答 B ⇒ Wave B 废弃

「关掉 + 按条款验收」不是 E3 的「冻结现值」形状:回 Lead 重新立项(内容:关闭序列、claims/enrolled run 的收敛、原条款的 pinned E2E 验收)。本单以 Wave A + 征询完成收口。

## 7. Ship 步骤(founder-gated,实现 Runner 不碰生产 .env)

| 步 | 动作 | 时点 |
|---|---|---|
| S1 | PR-A 正常 :cool: 流合并;restart-services 同步 cmux-sync 部署副本 + Bridge 重启(founder-ux 路由/armer 属 Bridge 侧) | Wave A |
| S2 | `.env:136`(`FLYWHEEL_CMUX_LINKED_VIEW=0`)删行 | S1 之后(此时已是 stale 行,删除零行为影响) |
| S3 | PR-B 合并 + Bridge 重启 | Wave B(D-2 答 A 后) |
| S4 | `.env` 五行派工开关 `=1` + 143 残注释删行 | S3 之后(同理 stale) |
| S5 | `FLYWHEEL_MAILBOX_DISCORD=1` **不动** | 永远(D-3 排除项) |

claude-lead.sh 改动随下次 Lead 启动生效,无需专门重启全舰。

## 8. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | D-2 答 B ⇒ 焊死方向作废 | Wave B 在答复前零代码;§6.3 显式分支 |
| R2 | founder-ux 拆除漏消费者 | §3.1 手术表 + 实现前全量 sweep 重清点 + 全仓 build + inert 断言 |
| R3 | 其他项目 config.yaml 有 stale `founder_ux_gate` 块 | ConfigLoader 只读已知键(已核实),stale 块惰性;3.1 RED-(f) 显式护住合法+畸形两形态 |
| R4 | claims_read CLI 焊死改变「无 .env 的新机器」行为(原 OFF→恒 ON) | E3 定义内的固化效果,PR 三格证据披露;生产机不受影响 |
| R5 | registry/truth/exemptions 热区与并行 E 系列冲突 | rebase 两边加性都保(FLY-247 教训) |
| R6 | cmux flag-state 观测项删除被误读为「零行为变化」 | §3.4 单独 disposition 写明:有意删除该观测行为;view 机器一行不动 |
| R7 | 删旁路后 Bridge 宕机窗口 founder 批准无出口 | Annie 裁决的字面代价;运维出口 = 先修 Bridge;PR 判词写明 |
| R8 | B-1/B-2 之间部署 ⇒ 生产短暂运行 default-ON 解析器 | 生产 `.env` 显式 `=1`,default 翻转对生产无观测差;B-1 测试锁「显式 0→OFF」保 opt-out 仍活 |

## 9. 验收

1. PR 描述含 12 行逐条表:固化值 + 为什么 + 三格证据(生产现值 / absent-read / registry.default 合法性)——**逐条,零整体表述**。
2. 条件式具名集合(R4-#1):**Wave A 集合永远必过**——`WAVE_A_DELETED_ROWS`(5)/ `WAVE_A_RETIRED_FLAG_ENVS`(4)+ companion(1)(inert 断言绿 + 零读点 sweep + tombstone)/ config key 零残留 / 2 搬迁(exemption 四联断言 + 读点行为字节不变)。**仅 D-2 答 A 时**要求最终 union(10 row / 9 flag env + 1 companion);答 B 时以 Wave A + 修正卡片与答复归档收口(§6.3)。
3. §4 历史合同矩阵逐条绿(epoch-0 fixture 为 DB 直构,不靠已删 env)。
4. D-3 在 PR 里显式列为排除项,`.env:162` 未被触碰。
5. 全仓门绿;codex code review APPROVED;独立 QA 节点 verdict。
6. Wave B 仅在 D-2 答 A 后存在;答复原文(或 Tadashi 转达 + 出处标签)+ relay 时重跑的 census 记入 PR-B。

## 10. 不在本单

D-3 双仓对齐 · `done_thread_reconcile` 两条 value knob · `qa_auto` / `doc_flow` / `skill_framework_mode` / `founder_consent_decision_mode` 等留用项 · `workflow_resume` · FLY-818 ②(stuck→founder-page)· StateStore 历史列清理(三条 migration 保留)· runner-state 残留 goal/armed 文件清理。
