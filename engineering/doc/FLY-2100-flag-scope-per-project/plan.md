# FLY-2100 flag_values 加范围列(逐项目 flag 存值) — 实施计划

Issue: FLY-2100 (https://linear.app/geoforge3d/issue/FLY-2100/flaga地基-flag-values-加范围列全项目-项目名逐项目-名册-scope-生效-解析顺序-项目默认-管理台按项目读-db)
日期: 2026-08-27
基于: research.md(其中两处事实由 Codex R1 勘误:render 的 console mode 无生产调用方;Bridge 监听端口由 TEAMLEAD_PORT 决定,BRIDGE_URL 只影响 CLI 客户端)

## 0. 范围与假设

**做**(Batch 1 / A 单,无依赖;C 单依赖本单):
1. `flag_values` / `flag_value_changelog` 加 `scope` 列(`'*'`=全项目,projectName=逐项目),
   `flag_values` PK 扩为 `(flag_name, scope)`,存量 6 行迁 `'*'`。
2. registry 的 `scope: bridge_global | project` 生效为写入约束(bridge_global 拒项目行 400)。
3. 解析顺序 项目行 → `*` 行 → config.yaml(本单 byte-compat 双读)→ registry 默认;
   `FlagView.effectiveByProject` 经 DB 叠加计算。
4. 管理台「按项目」行读 DB:手机 flag 报告页(feature-flag-render.ts + 
   feature-flag-report-html.ts,**真实唯一的交互控制面**,Annie locked control model =
   页面只生成命令、粘给 Lead 执行)加「项目」下拉,生成 `feature-flags set/clear
   --project` 命令行;新 management console(fleet-console-html.ts)的 per-project 列
   **只读显示** DB 叠加后的值,写指路 CLI。**唯一写入执行面 = CLI → 
   `/api/fleet/flag/stage|apply`。**
5. CLI `feature-flags set/clear` 带 `--project`(缺省 `'*'`;`apply` 保留为 `set` 别名)。
6. changelog / 审计带 scope;周扫描新增 **per-(flag, scope) 稳定天数账本**
   (纯增量新表,flag 级候选/ask 生命周期逐字节不变)。

**不做**:不新增任何 flag;不删 config.yaml key 或其读路径(C 单);不动 env flag 存值面
(B1/B2);不动任何运行时消费点(Blueprint / scheduler 仍读 config.yaml);不给
management console / 旧 FleetConsole 加任何页面直写路径(render 的 `console` control
mode 无生产调用方,本单不为它接线 —— 控件只做 phone 模式);不改 flag 级退役扫描的
候选判定、ask_count、departure、anchor 语义。

**关键假设**(实现前如与 Epic FLY-2099 定案冲突,以 Epic 为准并上报):
- A1. 逐项目可写白名单 `PROJECT_STORE_MANAGED_FLAGS` =
  `{doc_flow, pipeline_dag, pipeline_work_kind, proofshot, xiaohongshu_learning}`。
- A2. scoped 行「写时才建、set 写显式值、clear 即删行」;6 个 global env flag 的 `'*'`
  行为逐字节不变。
- A3. 本单存在「管理台显示 DB 值、runtime 仍按 config.yaml」的分歧窗口,以黄标明示。
- A4. scoped clear 的 changelog `to_effective` 记哨兵串 `inherit`(见 Step 2),不记
  跨源回落预览 —— 回落值属于读取面,写入审计只记录本行 presence/raw 的变化。

## 1. 数据流(目标态)

```mermaid
flowchart LR
  subgraph write [写入(唯一执行面 = CLI)]
    Phone["手机 flag 报告页<br/>「项目」下拉 → 生成命令"] -- "复制粘给 Lead" --> CLI
    CLI["flywheel-comm feature-flags<br/>set/clear --project"] --> RT
    RT["POST /api/fleet/flag/stage → apply<br/>校验: registry scope + 名册 + 白名单"]
  end
  RT --> FV[("flag_values<br/>PK (flag_name, scope)")]
  RT --> CL[("flag_value_changelog<br/>+ scope(兼职 scoped CAS 序号)")]
  subgraph read [读取面]
    FV --> EN["enrichFlagViewsWithStore<br/>(teamlead)"]
    CFG[("各项目 .flywheel/config.yaml")] --> RS["resolveAllFlags (config 包)"]
    RS --> EN
    EN --> VIEW["FlagView.effectiveByProject + scopedStore<br/>项目行 → * 行 → config → 默认"]
  end
  VIEW --> Card["手机报告卡片(控件=生成命令)"]
  VIEW --> Mgmt["management console(只读显示)"]
  VIEW --> Scan["周扫描 per-(flag,scope) 稳定账本(新表,纯增量)"]
```

## 2. 实施步骤(TDD;每步 RED → GREEN)

### Step 1 — config 包:策略 + 纯解析(无 SQLite 依赖)
- `store-policy.ts`:加 `PROJECT_STORE_MANAGED_FLAGS`;`getFlagStoreCodec` 覆盖 5 个
  project flag(按 polarity 复用 optIn/defaultOn codec)。
- **authoring gate 两条互斥完整分支**(Codex R1 #6 + R2 #1):
  `LEGACY_UNMANAGED_BASELINE` 保持 FLY-1981 的「不可增长的历史 maximum ledger」字面
  语义**一字不动**;**active legacy 集 = baseline − STORE_MANAGED_FLAGS −
  PROJECT_STORE_MANAGED_FLAGS**(派生,不是第二份字面表)。`validateFlagAuthoringPolicy`
  重构为:每个 registry spec 必须命中且只命中 {active legacy, STORE_MANAGED_FLAGS,
  PROJECT_STORE_MANAGED_FLAGS} 中一个 active 分支;新增两条断言:两个 managed 集
  互斥;当前 registry 全表逐 spec 恰好命中一个分支(RED/GREEN 都要有)。
  global-store 分支保留全部现有检查
  (bridge_global + env + direct + codec 合同);**project-store 分支自有检查**:
  `scope==='project' && valueKind==='bool' && category!=='governance_gate' &&
  !dormant && toggleable!=='readonly' && configKey 存在且不含 '[]'/'*' && 有 codec 且
  codec.parse 显式 "0"/"1" 双态正确`。无 exemption 旁路。新 project_config spec 的
  禁令从「一律禁」改为「必须入 PROJECT_STORE_MANAGED_FLAGS 并过 project 分支」。
- `resolve.ts`:`FlagEffectiveByProject` 加可选 `via`;新增纯函数
  `resolveScopedEffective`(项目行 → `*` 行 → configRow 兜底)。`resolveFlag` 不变。
- **runbook 同步**:`doc/engineer/implementation/flag-authoring-runbook.md` 更新
  project-store 路径与本单中间态限制(交付物之一)。
- 测试:两分支 gate(RED:白名单塞 governance/dormant/数组键成员必红;一个不在
  legacy baseline 的合成 project spec 走 project 分支必绿);三级取值顺序、项目行压
  `*` 行、`*` 行遮蔽 config、无行回落 config、via 标注。

### Step 2 — StateStore:迁移 + scoped CRUD(含 CAS 重设计)
- `migrateFlagValueStore`:幂等 rebuild `flag_values`(事务内;哨兵 = PRAGMA 查
  scope 列;存量 6 行落 `'*'`);changelog `addColumnIfMissing` scope + 索引
  `(flag_name, scope, id)`。**迁移前自动备份,固定名 + 一次性**(Codex R2 #4,防
  crash-loop 无界复制):固定路径 `<db>.pre-fly2100.bak`,`existsSync` 已存在则跳过
  并记「复用既有备份」,否则 `wal_checkpoint(FULL)` + `VACUUM INTO` 一次;测试:
  迁移失败后二次启动仍只有一份备份、原备份不被覆盖。**不动 `flag_scan_state`**
  (Step 6 改为增量新表)。
- `ensureFlagValueRows`:身份断言扩(`'*'` 行 ∈ STORE∪PROJECT 集;非 `'*'` 行 ∈
  PROJECT 集且 scope 非空);seed/recovery 仍只管 6 个 global `'*'` 行;SQL 补 scope。
- **scoped CAS 用 changelog 序号,不用 revision**(Codex R1 #3,防 delete→recreate
  ABA):对 `(flag, scope≠global 六行)` 的写,fence =
  `SELECT COALESCE(MAX(id),0) FROM flag_value_changelog WHERE flag_name=? AND scope=?`
  (changelog append-only ⇒ 跨删建单调)。stage 记 `expectedChangeSeq`,apply 在同一
  事务内复核后写行 + 写 changelog。global 六行保持现有 revision CAS,逐字节不变。
- `applyScopedFlagValueChange(name, scope, op, rawTo, expectedChangeSeq, actor,
  reason)`(新方法,不改现有 `applyFlagValueChange` 签名/合同):
  - set:UPSERT 显式 raw("0"/"1");行不存在则 INSERT(revision 列对 scoped 行仅作
    内部计数,不参与 CAS)。
  - clear:行存在 → DELETE + changelog(action='clear', to_present=0, to_raw NULL,
    `to_effective='inherit'` —— **哨兵串,schema 注释写明:scoped clear 后本行不再
    有 store 意见,生效值由读取面按 项目行→*行→config→默认 现算**);行不存在 →
    `missing_row`。
  - 返回类型独立定义(delete 成功无 row:`{ok:true, deleted:true}`),不复用
    `ApplyFlagValueChangeResult`。
- 读侧:`getFlagValueRow(name, scope='*')`、`listScopedFlagValueRows()`(一次拉全部
  project 白名单 flag 的行)。
- 测试:旧库迁移(6 行落 `'*'`、changelog 保留、二次启动幂等、备份文件存在);
  **ABA 双测**(existing→delete→recreate 后旧 fence 必拒;missing→insert→delete 后
  旧 `expectedChangeSeq=0` 必拒);set/clear/missing_row;哨兵 `inherit` 落账;身份
  断言拒未知组合。

### Step 3 — flag-routes:scope 写入约束
- `FlagStoreCanonical` 加 `scope: string` + `op: "set"|"clear"` + scoped 用
  `expectedChangeSeq`(global 沿用 revision;sha 自动覆盖新字段)。
- `handleFlagStage` 入参加 `project?: string`(默认 `'*'`)、`op?`。
  **op/scope 分流必须发生在现有早期 guard 之前**(Codex R3 #2:现在的
  `!spec.envVar || !isDirectToggleable(spec)` guard 会把 project spec(无 envVar、
  conversational)在进入 scoped 逻辑前就 400;`to` 必填校验对 `op==='clear'` 放宽)。
  校验链(400,fail-closed):① flag 必须在 registry;②
  **spec.scope==='bridge_global' 且 project!=='*' → 400**(mailbox_queue 验收点);
  ③ spec.scope==='project' → 必须 ∈ PROJECT_STORE_MANAGED_FLAGS,且 project ∈
  {'*'}∪名册(deps 注入 `projectNames: () => string[]`),否则 400 带现名册;
  ④ project flag 的 to 必须 boolean(clear 忽略 to)。
- **clear 的两种服务端语义,按 flag 类别定案**(Codex R3 #2,取兼容路径):
  - bridge_global store flag + `'*'` + clear → 映射为 `rawTo=null`,走**现有**
    `applyFlagValueChange`(行保留、has_override=0、revision CAS、changelog
    to_effective=registry default)—— 与今天「设回默认删 .env 行」同族语义,
    只是多了显式动词;
  - project flag(任意 scope)+ clear → 走新 `applyScopedFlagValueChange`,
    DELETE 行 + `inherit` 哨兵;
  - 其余 bridge_global 非 store flag 的 clear 本单 fail-closed 400(usage 写明)。
  rawTo:project flag set → 显式 "1"/"0"(不走 computeRawTo 的 default→null)。
- `handleFlagApply`:kind==='flag_store' 且 scoped → 重复 ②③ 校验后走
  `applyScopedFlagValueChange`;global set 分支逐字节不变;global clear 走上述
  rawTo=null 映射。
- plugin.ts 挂载处注入 projectNames(取 managementProjects)。
- 测试:mailbox_queue+project → 400;doc_flow set flywheel=on / '*'=off 落行;
  unknown project → 400 带名册;checkpoint_enabled / ponytail / xiaohongshu_auto_create
  scoped 写 → 400;project clear 删行 + `inherit` 落账;**global store flag clear:
  stage/apply 全链、行保留(has_override=0)、revision CAS 仍生效、changelog
  to_effective=registry default**;非 store 的 global flag clear → 400;bypass →
  409;stage 后第三方改动(含 clear→recreate)→ apply 409。

### Step 4 — 读取叠加 + 两个展示面
- **新增 secret-free scoped DTO**(Codex R1 #2):`FlagView.scopedStore?: {
  rows: Array<{scope: string; raw: string; value: boolean|string}>;  // 只含存在的行
  }`(present 由「行在不在 rows 里」表达;revision 不进 DTO —— stage 时服务端自取
  fence)。`effectiveByProject`(解析结果,带 `via`)与 `scopedStore`(行级真相,
  驱动控件)分开,互不冒充。
- `enrichFlagViewsWithStore(views, runtime, projectNames?)`:project 白名单 flag 在
  ready 模式:effectiveByProject 逐项目重算(`resolveScopedEffective`),挂
  scopedStore,打 `projectStoreManaged: true`;DB 覆盖值 ≠ config 解析值的行标
  divergence;bypass 不叠、不挂 scopedStore。
- `feature-flag-render.ts`(**只做 phone control mode;console mode 不接线不扩展**):
  项目行 badge 带 via 小标 + 分歧黄标(「runtime 仍按 config,C 单切换」)。
  **控件状态完全绑定 scopedStore 的 presence**(Codex R2 #2):
  `projectStoreManaged` 卡渲染「项目」`<select data-ffp-scope>`(`'*'` + 名册项目),
  并把每个 scope 的 `{present, value}` 映射以 data 属性嵌进卡片
  (`data-ffp-state='{"*":{"p":1,"v":"0"},"flywheel":{"p":0}}'` 之类,HTML-escape);
  值下拉 `<select data-ffp-value>` 的选项与选中态由所选 scope 的 presence 决定:
  - 无行:基线选项为明确的「继承(未设行)」且选中;on/off 可选,选了生成 set
    (**继承态显示的解析值不作为控件基线** —— 尤其 `'*'` 无行时各项目 config 值
    可能互不相同,没有单一 effective 可当 current);
  - 有行:选中显式 on/off(=行值),另有「清除(回落继承)」选项,选了生成 clear;
  - phone 脚本在 scope 切换时按映射**重置**值下拉的选项、选中态与 dirty 判定,
    重建命令行(`feature-flags set/clear … --project … --reason phone-report`,
    纯本地拼串,零回连)。
  - **命令拼串必须复用 fleet-apply-command.ts 的 shellQuote/shq SSOT**(Codex R3
    #1:`'*'` 不加引号会被 zsh glob 展开,Lead 粘贴时参数随当前目录变化):新增
    `FleetCmd.flagCommand(...)`(TS builder + JS 版,沿用既有 parity 测试模式),
    name / to / scope / reason 全部动态 token 单引号包裹;**不在 phone 脚本手写
    第二套 escape**。测试:输出必含 `--project '*'`;星号 scope / 普通项目名 /
    带单引号 token 的 TS/JS parity。
- `management-existing-writers.ts`(只读显示修正,Codex R1 #2 尾 + R2 #2 收窄):
  project flag 的 global 列的 `current` 值改为:scopedStore 有 `'*'` 行 → 行值;
  无行 → registry default(现状)。**不加 badge、不动 management-console-contract /
  fleet-console-html**(验收里删去 badge 项);writeCapability 保持 readonly,
  reason 文案指路 `flywheel-comm feature-flags set --project`(并说明 `*` 行由 CLI
  管理)。projectOverrides 显示 enrich 后的值。
- 测试:enrich(叠加顺序、bypass 回落、非白名单不叠、scopedStore 只含存在行);
  render(via 标 / 黄标 / presence 映射 data 属性 / 「清除」仅对存在行);phone 脚本
  状态机:**继承态 OFF → 选 off 生成 set**、**present OFF → 选清除生成 clear**、
  absent `'*'` ↔ present 项目行来回切换时选项/选中/dirty 正确重置;management
  provider 的 global cell(有 `'*'` 行/无行/全项目被项目行遮蔽/名册为空四态)。

### Step 5 — CLI set/clear
- `feature-flags set --name <flag> --to on|off|<enum> [--project <name|*>] [--reason …]`;
  `feature-flags clear --name <flag> --project <name|*> [--reason …]`(clear 必须显式
  给 --project);`apply` 保留为 set 别名。body 带 `{project, op}`。usage 写清:
  set/clear 的 --project 是 scope、report 的 --project 是发布频道;clear 支持面 =
  project 白名单 flag(删行回落)+ 6 个 global store flag(清 override 回默认,
  行保留),其余 fail-closed(与 plan Step 3 服务端语义一致)。
- 测试:组包、clear 必带 --project、别名兼容、非 0 退出码传递、global/project
  clear 两形组包。

### Step 6 — 周扫描:纯增量 per-scope 稳定账本(不动 flag 级生命周期)
(Codex R1 #5 采纳后的重设计:**`flag_scan_state` 表、computeFlagScan 的候选/ask/
departure/anchor 全部逐字节不变** —— flag 级 canonical 仍是整向量,触发时机不变。)
- 新表 `flag_scan_scope_state(flag_name, scope, canonical, streak_started_at,
  streak_samples, last_sampled_at, PRIMARY KEY(flag_name, scope))` —— 纯增量,无迁移。
- **完整读写合同**(Codex R2 #3):StateStore 新增 `getFlagScanScopeState()`;
  `ComputeFlagScanInput` 加 `prevScopeState: FlagScanScopeState[]`(Bridge 调用点与
  `prevState` 同时取);缺失行初始化 = 空状态(canonical null / streak 0),等价
  `emptyState`;compute 只对「当前 registry ∩(project flag × 当前名册 ∪
  bridge_global × {'*'})」的组合推进,其余组合不出现在 `nextScopeState`。
- `computeFlagScan` 返回值加 `nextScopeState`(project flag 逐项目样本推进;
  bridge_global flag 落 `('*')` 行;名册守卫失败 → 该 flag 的 scope 行本轮不推进,
  与 flag 级 indeterminate 一致);`commitFlagScan` 同一事务 upsert scope 行 +
  DELETE 已不在上述组合里的 (flag, scope) 行(账本修剪;flag 级 departure 不变)。
- **报告重试的 per-scope 数据来源 = scope 账本表,靠既有单 pending-run 结构保护**
  (Codex R2 #3 尾):`flag_scan_one_pending` 唯一索引保证 pending run 存在期间不会
  有下一次 commit;scope 表只在 commitFlagScan 事务里写 ⇒ 「pending 期间 scope 表
  不被改写」成为结构不变量,report leg 重试读到的 per-scope 天数与 commit 时一致。
  把该不变量写成测试(pending run 未 publish 时再次 due 的 commit 必须被拒且
  scope 表无写入)。
- **报告渲染显式接收 scope-state snapshot,两个来源按场景分流**(Codex R3 #3):
  `renderFlagScanReport` 加 snapshot 入参 —— dry-run 传 `proposed.nextScopeState`
  (本轮预览,含新建/递增的 scope 行);已 commit 的 report leg / crash-retry 传
  `getFlagScanScopeState()`(受 pending-run 不变量保护)。测试:不写 DB 的 dry-run
  断言本轮新增/递增的 per-scope 天数出现在预览里,且与随后真实 commit 的报告一致。
- 扫描报告对 project flag 附 per-scope 稳定天数行(run_items 表不动)。
- 测试:**跨两个独立 compute/commit 周期 streak 接续**(第二轮从
  `getFlagScanScopeState()` 读回并 +1,不清零);项目 A 变值只重置 A 的 scope 行
  (B 不动),同轮 flag 级 canonical 照旧重置(对拍旧行为);名册增删 → scope 行
  增/删,flag 级 departure/candidate 不受影响;bridge_global 行落 `'*'`;报告渲染
  per-scope 天数;pending-run 不变量。

### Step 7 — 全仓自验 + 真 Bridge 验收(隔离配方)
- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(全仓)。
- 真 Bridge 隔离配方(Codex R1 #7 修正):独立 `HOME=$(mktemp -d)`、独立
  `TEAMLEAD_DB_PATH`、**`TEAMLEAD_PORT=<空闲端口>`**(Bridge 监听端口的真正来源)、
  CLI 侧 `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:<同端口>`、隔离 `~/.flywheel/projects.json`
  (含 flywheel + 至少一个第二项目)、隔离 `.env`;**禁止调用 restart-services.sh**;
  收尾 kill Bridge 进程并确认端口释放。
  - `doc_flow` set flywheel=on + '*'=off → flag-report.html 与 snapshot 显示
    flywheel=ON、其余项目=OFF(`*` 行遮蔽 config),via 标正确;
  - `mailbox_queue --project flywheel` → 400;
  - clear flywheel 行 → 回落 `*` 行;clear `*` 行 → 回落 config;
  - 管理台截图(浅色)附 QA 报告。

## 3. 验收 ↔ 步骤映射

| 验收项 | 步骤 |
|---|---|
| PK 迁移单测 | Step 2 |
| scope 名册校验 | Step 3 |
| bridge_global 拒项目行(mailbox_queue) | Step 3 |
| 三级取值顺序 | Step 1(纯函数)+ Step 4(叠加) |
| 双读回落 | Step 1/4 |
| 真 Bridge doc_flow 一致性 + 管理台截图 | Step 7 |
| changelog/审计带 scope | Step 2/3 |
| 周扫描 (flag, scope) 计稳定天数 | Step 6 |

## 4. 风险与回滚(Codex R1 #7 重写)

- **迁移风险**:rebuild 在事务内,失败即整体回滚;哨兵幂等,重启重试安全;迁移前
  `VACUUM INTO` 备份落盘。
- **降级是 forward-only,「revert PR 即回滚」不成立**:DDL 落盘后,旧 binary 读复合
  PK 库的行为未定义(`WHERE flag_name=?` 可能多行命中,旧身份断言可能 throw)。降级
  路径只有两条,PR body 写明:① `FLYWHEEL_FLAG_STORE=0` bypass(整个 flag store 旁
  路,现有机制);② 从迁移前备份恢复(丢弃其后的 flag 写)。为 ① 补一条降级测试:
  迁移后的库 + bypass 模式启动必须正常服务。
- **显示/行为分歧窗口**(A3):黄标明示;QA 报告如实写「runtime 行为未变」。
- **孤儿行**(项目移出名册):flag_values 不自动删(审计留痕、不参与解析);
  扫描 scope 账本按 Step 6 修剪。两种处置不同是有意的:一个是审计面,一个是时钟面。

## 5. 交付物

- 代码 + 测试(Step 1-6),全仓门禁绿(Step 7),隔离真 Bridge 验收记录 + 浅色截图。
- `doc/engineer/implementation/flag-authoring-runbook.md` 更新(project-store 路径)。
- milestone 新文件 `engineering/doc/milestones/FLY-2100.md`(PR 最后一 commit,不碰
  CLAUDE.md)。
