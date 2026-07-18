# FLY-1344 env 冷开关收编进 flag 控制台 — 实施计划

Issue: FLY-1344 (https://linear.app/geoforge3d/issue/FLY-1344/flags-env-冷开关收编进-flag-控制台-dag-force-legacy-优先founder-可见可操作理想热切换)
日期: 2026-07-17
基于: research.md
状态: round 4(Codex R1 全 7 条 + R2 全 4 条 + R3 全 4 条采纳,见 §7)

## 0. 目标与验收(founder 视角先行)

落地后,Annie 在 flag 控制台(手机报告页 **和** localhost console,两面等价)看到顶部 **DAG 面板**,并且:

- **「开 DAG」= 一组热命令,零重启**:勾「开 DAG」→ 复制框生成安全序列命令组(§2.S5:force_legacy on 起手 → 三/四根前置杆 → template_dispatch 殿后 → 全就绪后 force_legacy off)→ 粘给 Lead 执行 → 逐条即时生效,下一次 run start 即走模板派发。
- **「ship gate 应急回退」= 一条命令,即时**:`flywheel-comm feature-flags apply --name workflow_force_legacy --to on` — enrolled run 的 QA ship gate 立即回落 legacy reader(CLI 下一次调用现读 .env 即生效)。面板如实命名为「ship gate 应急回退」,**不**称「压制 DAG」(它不进派发谓词)。
- **「彻底关」**:安全序列(force_legacy on → template_dispatch off → 其余杆 off)。
- 面板呈现**三条独立派生事实**(不合并成一个假状态):v1 派发就绪度 / v2 派发就绪度 / ship reader 状态(forced_legacy / claims / **blocked_fail_closed**(force off ∧ claims_read off = 无 reader,enrolled QA 禁 ship))。任何杆双源分歧 → 该派生事实进 degraded 并同时展示两侧值。
- 全部 env flag 的生效路径 badge 与真实读取路径一致;`.env` 与 Bridge 进程分歧显式呈现(「已 stage 待重启」/「⚠ 分脑」)。
- **本 PR 自身不翻任何 flag**:merge 后生产字节行为不变(force_legacy 仍=1、四杆仍 off)。

硬时序:**merge 必须赶在「统一重启开 DAG」重启窗之前**。

## 1. 总览

```mermaid
graph TD
    subgraph 双 console(共享 DAG view model)
        P1[手机报告页 flag-report.html] --> C[复制框 apply 命令组]
        P2[localhost console snapshot+html] --> C
    end
    C -->|Annie 粘给 Lead| CLI[flywheel-comm feature-flags apply]
    CLI --> R[Bridge /api/fleet/flag/stage+apply<br/>loopback+same-origin+confirmToken+audit]
    R --> T[applyFlagToggle 事务<br/>①原子写 ~/.flywheel/.env ②in-proc 突变 process.env]
    T --> H1[Bridge call_time 读<br/>dispatch 谓词/StateStore 准入/shadow runtime/reQa USE-time]
    T --> H2[CLI dotenv_live 读<br/>ship-eligibility/verify-approval 现读 .env]
```

| # | 件 | 包 | 性质 |
|---|---|---|---|
| S0 | 共享 .env 解析 + 双源值合同(两套 console DTO) | config(+comm/teamlead 消费) | 地基 |
| S1 | registry schema:dotenv_live timing + direct 安全闸放行 {call_time, dotenv_live}(server+client 同一谓词) | config + teamlead | 机制 |
| S2 | claims_write 热运行时:presence-语义改 latched-enable 语义 + reQa USE-time 门 | teamlead | 机制(唯一行为面) |
| S3 | 注册表数据 sweep:五杆重分类 + 逐 consumer readSites 精确登记 + proofs | config | 数据 |
| S4 | 分歧呈现(staged/split-brain/degraded)接进两套渲染 | teamlead | 显示 |
| S5 | DAG 面板(三事实模型 + 安全序列命令组)投影到两套 console | teamlead | 显示 |
| S6 | goal 2 附录清单 | docs | 数据 |

## 2. 分件实施(TDD;提交顺序即依赖门,见 §5)

### S0 — 共享解析与双源值合同(先行地基,Codex R1#6/#4)

- `readEnvValueFromContent` 从 ship-eligibility.ts **抽到 flywheel-config 共享模块**(如 `packages/config/src/env-file.ts`);ship-eligibility、`verify-approval.ts:122-142` 的 live-file reader、新 resolver 全部改为共用(byte-same 由迁移测试锁定,不再复制实现)。
- **文件读取状态显式建模**(R2#4):共享 reader 返回 `{ status: "readable" | "unavailable", raw?: string }` — 区分「文件可读但 key 缺席」(按极性算出**确定的** `fileEffective`,绝不误判为不可用)与「文件不可读」(→ `divergence: "source_unavailable"` degraded:Bridge 值仅作带注释观测,方向性 preset/control 全禁用)。
- `FlagView` 值合同(R1#4,具名三值):
  - `bridgeEffective` — Bridge process.env 语义值(= 现 `effective`,旧字段保留兼容语义);
  - `fileEffective?` — `~/.flywheel/.env` 现读语义值(文件不可读 → 缺席);
  - `displayEffective` — **唯一、测试化的全函数选择规则**:文件可读且双源一致 → 该值;文件可读且分歧 → **不给确定值**,置 `divergence` 并由 UI 展示两侧;文件不可读 → `source_unavailable`(同样不给确定值)。含 `call_time + dotenv_live` 混合杆的两个 reader 都是权威 consumer,分歧 = 真 degraded,绝不选边。
  - `divergence?: "staged_restart" | "split_brain" | "bridge_stale" | "source_unavailable"`(前三类按 research §4 矩阵,第四类见上文文件状态建模)。
- **所有既有 consumer 显式定读哪个字段**:row badge / checkbox 的 `data-ff-to` 目标计算 / management mapper 的 `ManagedValue.current`(`management-existing-writers.ts:306-323`)/ DAG 派生 — 统一读 `displayEffective`;分歧时 checkbox 禁用(不生成方向可能错的命令),卡片展示双值。
- 测试:五组 split-brain 矩阵 — row badge / 单杆 target / preset target / DAG aggregate / apply 后自愈(apply 成功 → 双源一致 → divergence 清除)— **每组 × {可读一致, 可读分歧, 可读 key 缺席, 文件不可读} 四态**。

### S1 — schema 与 direct 安全闸(server + client 同源)

- `registry.ts`:`ReadTiming` 增 `"dotenv_live"`。
- server `flag-toggle.ts::isDirectToggleable` 与 client `feature-flag-render.ts::isFlagViewDirectToggleable`(:101-114,现硬编码全 call_time)**收敛到同一 shared helper**(config 层纯函数,两侧引用),放行 `every(timing ∈ {call_time, dotenv_live})`;其余守卫逐字不动。
- `effectLabel`:dotenv_live 计入热生效。
- 测试:registry 不变量更新(direct ⇒ 全 readSite ∈ {call_time, dotenv_live} ∧ proof;文件名按实际 `packages/config/src/__tests__/feature-flags-registry.test.ts`);shared 谓词单测矩阵(混 bridge_boot 拒);render checkbox 对 dotenv_live 杆真实出现(HTML 断言)。

### S2 — claims_write 热运行时(Codex R1#1/#2,唯一行为面改动)

**R1#1 定性:presence-语义是真开关**。`RunDispatcher.start` 凭 `workflowShadow` 存在性生成 shadowContext、触发 QA claims admission、给 fresh launch 生成 launchCommitPath(`run-dispatcher.ts:1152-1205`);`setupRunInfrastructure` 凭存在性构造 admission 且找不到 active run 会抛错(`run-infra.ts:1003-1036`);`PhaseOrchestrator` 多处凭存在性附加 shadowContext(`phase-orchestrator.ts:626-628,1077-1083,1405-1407,1887-1892`);OFF sentinel 断言无 writer 时 launchCommitPath=undefined、无 shadowContext、零 shadow run(`workflow-shadow-wiring.test.ts:106-119,428-438`)。**故不做「常驻 writer + hook 内短路」**,改为:

1. **hot runtime facade**:新 `WorkflowShadowRuntime`(持 process.env 引用,暴露 `enabled()` + `beginStartScope()`)。plugin.ts 常驻构造 runtime 并**常驻**挂 finalization hook。**能力/closure 一律常驻构造**(`setupRunInfrastructure` 仍在 Bridge 装配期跑一次,`plugin.ts:4902-5003` / `run-infra.ts:602-608`)— OFF 的语义是「锁存 OFF 时不调用」,**绝不是**「装配期不构造」(否则 OFF 启动后热翻 ON 拿不到 admission = 变相 boot gate,R2#1)。
2. **start-scoped 线性化合同**(R2#1):`RunDispatcher.start` 在明确的线性化点调 `runtime.beginStartScope()` — 返回 `undefined`(锁存 OFF:本次 start 零 **shadow** 副作用,shadowContext / onSpawn / admission 调用 / shadow 侧 launchCommitPath / delayed failure hook 全部不发生,admission 相关错误如「active workflow run not found」不可能触发)或一个**绑定该锁存值的 start-scoped seam**(锁存 ON:`RunDispatcher` 捕获此 scope,在 `await admitLifecycle`(`run-dispatcher.ts:1060-1113`)、onSpawn、launchCommitPath、以及 Blueprint promise 异步完成路径上的 `onDispatchFailed`(`:1385-1443`)**全程复用同一 scope,scope 内不再读全局 flag** — 等待期/执行期翻 OFF 不撕裂:已开的 start 按 ON scope 完整走完)。
   **generalizedExecution 例外(R3#1,写死公式)**:generalized engine launch 的 commit path 是**独立于 claims-write shadow 的既有 durability 合同**(`run-dispatcher.ts:1152-1158,1196-1205` 现行 `shadowCommitDir = req.generalizedExecution || this.workflowShadow`;`workflow-engine-dispatcher.ts:448-492` 传 launch token/commit callback 后 flag 可能已翻)— scope 绝不覆盖它:`shadowContext = startScope && !req.generalizedExecution ? … : undefined`;`shadowCommitDir = req.generalizedExecution ? launchCommitPath(executionId) : startScope ? launchCommitPath(executionId) : undefined`。claims-write 开关**永不**决定 generalizedExecution 自身的 launch credential/commit 生命周期(§4 不改 dispatch/claims 语义)。
3. **非 start-scoped hook 按 USE-time 当前值**:orchestrator 每个 transition、finalization hook 按各自调用时的 `enabled()` 决定(它们不属于任何一次 start 的锁存范围)。
4. scope 边界外的 hooks 保留 fail-safe 短路;**start scope 内禁止**(会造成 R2#1 描述的「有 admission/commit path、无对应 shadow transition」撕裂)。
5. **reQa 第二 boot capture**(R1#2,`plugin.ts:1235-1256` 仅 boot ON 才注入 → OFF 启动后热翻 ON 仍 503):`reQa` 能力在基础依赖齐全时**常驻接线**,`/api/workflow/re-qa/stage` 与 `/re-qa`(`workflow-decision-routes.ts:481-515`)在 **stage 和 apply 两个 USE-time 点**各自重查同一 live env;OFF 保持现 503 语义/零 token/零 respawn;stage 后翻 OFF → apply fail-closed。
6. 注册表:上述两处 bridge_boot readSite **在本件测试全绿后**才移除(§5 顺序门)。

- 测试(突变驱动,FLY-1232 真值表保真):
  - **穿过真实 `setupRunInfrastructure` + `RunDispatcher` 的 OFF→ON→OFF**(限定 **non-generalized normal fresh start**,R3#1):OFF 时全部存在性副作用为零(launchCommitPath=undefined、无 shadowContext、无 admission、无 commit-marker、QA 启动不因 shadow 抛错)= 现 sentinel(`workflow-shadow-wiring.test.ts:106-119,428-438`)逐字复跑;ON 时真写;再 OFF 立即停。**不以逐 hook 单测冒充**。
  - **generalized 保全 sentinel**(R3#1):`generalizedExecution + beginStartScope()===undefined` 时 launchCommitPath/commit gate **仍在**(独立 durability 合同不受 claims-write scope 影响)。
  - **翻转边界四矩阵**(R2#1):① ON-at-entry → await admitLifecycle 期间翻 OFF(scope 保 ON 走完,含 delayed failure hook);② OFF-at-entry → await 期间翻 ON(本次 start 保零副作用);③ ON start → Blueprint 失败前翻 OFF(onDispatchFailed 仍按 scope 走);④ **Bridge boot OFF → 热翻 ON → shared-branch QA start 拿到 admission**(反 boot-gate 回归)。
  - orchestrator transition 级 enable 翻转矩阵。
  - reQa route 级 OFF→ON→OFF + stage/apply 间翻转 fail-closed。

### S3 — 注册表数据 sweep(逐 consumer 精确登记,R1#6)

- `workflow_force_legacy`(R3#2 修正,与下文「readSite 落真解析文件」规则一致):readSites = **`ship-eligibility.ts` 内两行** — Bridge argsEnv-wins 模式(call_time)+ CLI/无-key 模式(dotenv_live);`toggleable: "direct"` + mixed-source proof。`merge-ship-gate.ts` 只进 caller note/proof table;**exact sentinel 逐字断言它不出现在 registry readSites**(防旧口径回流)。
- 四根启用杆:category → `"feature"`,`toggleable: "direct"`,note 记 FLY-1344 founder 直令 + FLY-1307 lineage + 组合谓词关系。claims_write 的 readSites 在 S2 完成后收敛(StateStore call_time + shadow runtime call_time + reQa USE-time call_time);claims_read 登记全部四条(R2#3):workflow-claims call_time + **ship-eligibility 双模两行**(Bridge caller 传 process.env 含 key → call_time;CLI/缺-key → dotenv_live;`resolveDefaultOffGate` 的 argsEnv-wins 语义 `ship-eligibility.ts:83-101`)+ **verify-approval.ts:122-142 dotenv_live**。
- **readSite 落在真正解析 key 的文件**(R2#3):force_legacy / claims_read / merge_approval_gate / qa_done_gate 的双模 readSites 都登记在 `ship-eligibility.ts`(不同 symbol/pattern 区分 Bridge caller 模式与 CLI 模式);`merge-ship-gate.ts` 只传 env、文件内无这些 envVar literal,**不冒充 key reader**,只进 note/proof table 作 caller 说明(drift reverse check 要求声明文件真含 envVar)。
- merge_approval_gate / qa_done_gate(**保持 readonly**):同上双模两行;删「改后需重启 Bridge」错误 note,note 改述真实混合语义与分脑可能。
- **directToggleProof 按实际登记 consumer**(R2#3 修正口径):每 direct 杆,经 `applyFlagToggle` 一次成功 apply 后,**该杆每个登记 consumer 的下一次真实调用**观察到新值,零重启 — template_dispatch / generalized / claims_write 只有 Bridge consumer(dispatch 谓词 / StateStore 准入 / shadow runtime / reQa 门);**claims_read / force_legacy 是 mixed-source**,同一次 apply 后须同时证明 Bridge(process.env 路径)与 CLI(注入 dotenvPath 的 evaluateQaShipGate)两侧。
- 具名杆 exact readSite sentinel:**与 §3 的 PR proof table 用同一枚举源**(单一口径,防两套清单漂移;现 drift reverse check 只验「声明文件含 envVar」不够)。
- 授权面 sentinel:五个真治理门(founder_consent_decision_mode / founder_attribution_gate / comm_bypass_bridge / lead_lease_bypass / founder_ux_gate)仍 governance_gate + readonly,shared direct 谓词对它们恒 false。

### S4 — 分歧呈现

- S0 合同接进两套渲染,**四类分支穷尽**(R3#4):「.env 已改,待重启生效」staged_restart /「⚠ CLI 与 Bridge 见值不同」split_brain /「.env 已改,Bridge 未拾取」bridge_stale /「.env 不可读,无法确认或操作;Bridge 值仅供观测」**source_unavailable**;分歧/不可用时该杆 checkbox 禁用。
- stage 基线语义不动(rawFrom 取 process.env;带外改文件由既有 fileSha 409 拦)。
- 测试:**四类分支 exhaustive assertion** × 两套渲染快照 + DTO secret-free(不许落入空白/default 分支)。

### S5 — DAG 面板(三事实模型,投影两套 console;R1#3/#5)

- **共享纯 view model**(config 或 teamlead 纯函数模块):输入五杆 FlagView,输出:
  - `v1DispatchReady`:template_dispatch ∧ claims_write ∧ claims_read(谓词与 `workflow-template-dispatch.ts:24-36` 同构,不含 force_legacy);
  - `v2DispatchReady`:再 ∧ generalized;
  - `shipReader: "forced_legacy" | "claims" | "blocked_fail_closed" | "degraded"`(R3#3,按 `ship-eligibility.ts:313-327` 真实逻辑:force ON → forced_legacy;force OFF ∧ claims_read ON → claims;**force OFF ∧ claims_read OFF → blocked_fail_closed**,即 durable-QA 会话 `qa_claim_gate_unenrolled_failclosed`、无任何 reader、enrolled QA 禁止 ship — 现测试 `ship-eligibility.test.ts:243-257` 锁定;绝不压成 generic off 误报);
  - v1/v2 派发事实独立三态:ready/on、off、`degraded`(任一成员杆 divergence → 不给确定值,列分歧杆)+ 缺杆清单。
- **投影到两面**(R1#5):`ConsoleSnapshot`(手机 flag-report)与 `ManagementSnapshotV1`(localhost `/api/fleet/snapshot`,`management-console-contract.ts:232-272` 增 dagPanel 字段)各自投影同一 view model;`fleet-console-html.ts` 增顶部 DAG 卡渲染。两投影等价由共享 view model + 双侧断言保证。
- **安全序列命令组**(R1#3 + R2#2,**状态感知生成 + 失败即停**):
  - **失败即停合同**:第一阶段命令组生成为 **`cmd1 && cmd2 && …` 单行**(粘进普通 shell,任一条 apply 非零退出即停,后续不执行 — 现换行拼接会在中条失败后继续跑,恰好制造 template ON + 缺杆态);`force_legacy off` 保持**刷新确认后的独立第二阶段**。
  - **状态感知 + 初态合同**:preset 由当前面板状态生成所需命令(复制框 JS 已持 data-current);**任一成员杆 degraded/divergent/source_unavailable → preset 禁用**。异常初态(template ON + 前置杆缺)下「开」序列**先修复**:`template_dispatch off` 起手归位安全态,再进 enable 相位 — 保证不变量对**所有允许点击的初态**成立。
  - 开(自安全态):`force_legacy on`(若已 on 则省略)→ `claims_write on` → `claims_read on` → `generalized on`(v2)→ `template_dispatch on` 殿后;第二阶段 `force_legacy off` 的**可执行条件 = 刷新后 shipReader 目标状态为 claims**(即 claims_read 已确认 ON,R3#3 — 不是四杆视觉「就绪」)。
  - 彻底关:`force_legacy on` → `template_dispatch off` **紧随** → 其余杆 off。
- 测试:view model 组合矩阵(2^5 关键组合 + divergence 注入);**前缀不变量(全初态版)**:对**每个允许点击 preset 的初态**,序列任意前缀执行后 ① dispatch 谓词绝不出现 template ON 而前置杆缺,② 全就绪前 ship reader 保持 legacy;**失败注入矩阵**(R2#2):对序列每个位置注入 apply 失败,断言后续命令未执行(&& 链真停)且面板落回自洽状态;两套 console 的验收测试**分别打真实** `/api/fleet/flag-report.html?interactive=1` 与 `/api/fleet/snapshot` + `fleet-console-html`(非 renderer 快照冒充)。

### S6 — goal 2 附录

`appendix-env-inventory.md`:24 个未注册 key 逐条处置建议(注册 readonly / allowlist+理由 / secret 标注);47 readonly 分类修正差异表。执行归 follow-up。

## 3. 测试与验收门

- 全仓 `pnpm -r test` + lint;drift 双向绿。
- **五杆 readSites 枚举 proof 表**(R1#7 硬验收):PR 描述附表 — 五杆 × 每个登记 readSite × 该 consumer 的 apply-后观察证据(测试名),「无 runner-inherited stale reader」按 **逐 consumer 结论**给出(runner spawn 继承 env 的读点若存在则必须列明并给出为何不受影响/如何覆盖),不以套件绿推断。
- Reverse-compat sentinel:默认值/极性零变化;生产 .env 不动时 resolve 输出 vs main 基线 diff 仅限新增字段。
- 真机 QA(529 房,独立 QA 阶段):①force_legacy console apply on/off → CLI 即时观察;②安全序列全组 → dispatch 谓词放行 + shadow runtime 真写(热,零重启)+ reQa route 热翻验证;③带外手改 .env → 两套 console 分歧行 + checkbox 禁用 + stage 409。
- Codex design review(本 plan)→ implement → Codex code review → 独立 QA → founder gate。

## 4. Byte-compat 与显式不做

不翻任何 flag;不改 dispatch 谓词/ship-eligibility 判定/claims 语义;不动真授权面治理门;不做 DB-backed flag 面(FLY-1091);不做批量 apply 原子事务(半批次由三事实面板暴露);不修 drift shell 盲区(附录记录);24 key 执行 = follow-up。S2 是唯一行为面,穿真实 dispatcher/run-infra 的 OFF 真值表复跑为硬门。

## 5. 单 PR 内提交顺序(依赖门,R1#7)

1. S0 共享解析 + 双源合同(含两套 DTO 字段);
2. S2 全部 presence-sensitive 热接线 + reQa USE-time 门,OFF/ON proofs 全绿;
3. S1 安全闸 + S3 数据 sweep(**四杆改 feature/direct 只在 1-2 全绿之后**——杜绝「UI 已可点、某 consumer 仍 boot-stale」窗口);此时才删两处 bridge_boot readSite;
4. S4 分歧呈现 + S5 面板/预设;
5. S6 附录。

merge 目标:统一重启窗之前;重启窗 runbook 行进 PR 描述。

## 6. Follow-up(建单,不在本 PR)

1. 24 个未注册 key 注册/allowlist 执行批次。
2. drift 扫描 shell/插件 fork 盲区。
3. conversational 大类可升 direct 批次评估(FLY-1243 模式)。

## 7. Design review 记录

- R3(Codex,xhigh,2026-07-17):CHANGES REQUESTED,3 阻塞 + 1 重要,**全部采纳**:
  1. generalizedExecution 的 launch commit path 独立于 claims-write scope(写死公式 + 保全 sentinel);
  2. 删 S3 与新规则矛盾的旧 force_legacy readSite 行(双模都落 ship-eligibility;sentinel 断言 merge-ship-gate 不在 readSites);
  3. shipReader 四态(补 blocked_fail_closed;phase-2 force off 可执行条件 = shipReader 目标 claims);
  4. S4 渲染补 source_unavailable 第四分支 + 四类 exhaustive 断言。
- R2(Codex,xhigh,2026-07-17):CHANGES REQUESTED,3 阻塞 + 1 重要,**全部采纳**:
  1. S2 改 `beginStartScope()` 线性化合同(锁存值绑定 scope、scope 内不读全局 flag、能力常驻构造 + 锁存 OFF 不调用;翻转边界四矩阵测试);
  2. 命令组失败即停(`&&` 单行)+ 状态感知 preset + 异常初态 repair-first + 失败注入矩阵;
  3. claims_read 补 Bridge call-time 双模登记(readSite 落 ship-eligibility 真解析文件;proof 口径改「每实际登记 consumer」;sentinel 与 proof table 同一枚举源);
  4. 文件读取状态三分支(readable+key-absent 算确定默认值 / unavailable → source_unavailable degraded + 控制禁用)。
- R1(Codex,xhigh,2026-07-17):CHANGES REQUESTED,6 阻塞 + 1 重要,**全部采纳**:
  1. S2 由「常驻 writer + hook 短路」改为 hot runtime facade + RunDispatcher.start 锁存 enable + orchestrator per-transition(presence-语义是真开关,`run-dispatcher.ts:1152-1205`/`run-infra.ts:1003-1036` 实证);
  2. 补 reQa 第二 boot capture 的 USE-time 门(`plugin.ts:1235-1256`);
  3. DAG 面板改三事实模型 + 安全序列(force_legacy 不进派发谓词,「suppressed」态废除);
  4. 双源值合同具名三值 + 全 consumer 选择规则 + 分歧 degraded;
  5. 共享 view model 投影两套 console + client/server direct 谓词同源;
  6. 逐 consumer readSites 精确登记(含 verify-approval 漏登点)+ mixed-source proof + 共享 env 解析模块;
  7. 提交顺序依赖门 + 五杆 readSites 枚举 proof 表。
