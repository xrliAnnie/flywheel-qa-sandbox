# FLY-2100 flag_values 加范围列(逐项目 flag 存值) — 调研

Issue: FLY-2100 (https://linear.app/geoforge3d/issue/FLY-2100/flaga地基-flag-values-加范围列全项目-项目名逐项目-名册-scope-生效-解析顺序-项目默认-管理台按项目读-db)
日期: 2026-08-27
基于: exploration.md

逐文件核对本单要碰的每个面,给出代码级事实与改动锚点。行号以当前 main
(worktree flywheel-FLY-2100, base e33f87d70) 为准。

## 1. 存储层

### 1.1 `flag_values` / `flag_value_changelog`(StateStore.ts:4546-4599)

事实:
- `flag_values` PK = `flag_name`(4549);CHECK `has_override=1 ⟺ raw_value 非空`(4557-4560)。
- `flag_value_changelog` PK = 自增 id,action ∈ `seed/set/clear/default_shift/bypass_recovery`,
  索引 `idx_flag_value_changelog_flag(flag_name, id)`(4582)。
- 生产库现存 6 行(STORE_MANAGED_FLAGS),全部隐含「全局」语义 ⇒ 迁移目标 `scope='*'`。
- FLY-1981 的退役清理(4593-4598)按 flag_name DELETE —— PK 扩了以后语义不变
  (删该 flag 的所有 scope 行,退役=整个身份退役)。

改法(幂等 rebuild,哨兵 = `PRAGMA table_info(flag_values)` 是否含 `scope` 列):
1. `CREATE TABLE flag_values_new`:同列 + `scope TEXT NOT NULL DEFAULT '*'` +
   `CHECK (length(scope) > 0)`,PK `(flag_name, scope)`。
2. `INSERT INTO flag_values_new SELECT flag_name, '*', … FROM flag_values`。
3. `DROP TABLE flag_values; ALTER TABLE flag_values_new RENAME TO flag_values`。
4. changelog 用现成 `addColumnIfMissing`(StateStore.ts:2160)加
   `scope TEXT NOT NULL DEFAULT '*'`,新索引 `(flag_name, scope, id)`(旧索引留着不碍事)。

注意:better-sqlite3(FLY-663 迁移后)支持事务内 DDL;整个 rebuild 包进一个
transaction,防止半迁移状态。

### 1.2 `ensureFlagValueRows`(StateStore.ts:4680-4858)

事实:
- 4687-4693 身份断言:表里出现非 STORE_MANAGED_FLAGS 的 flag_name 直接 throw。
- seed / bypass-recovery / default_shift 全部只面向 6 个 global env flag。

改法:
- 断言改为:`scope='*'` 行允许 STORE_MANAGED_FLAGS ∪ PROJECT_STORE_MANAGED_FLAGS;
  `scope≠'*'` 行只允许 PROJECT_STORE_MANAGED_FLAGS。其余仍 throw。
- seed / recovery 循环**只管 6 个 global flag 的 `('*')` 行**,project flag 行是
  写时才建(§1.3),启动不 seed —— 这是双读回落 config 的前提(无行 ⇒ config)。
- 所有内部 SQL 的 WHERE / ON CONFLICT 补 `scope`。

### 1.3 `applyFlagValueChange`(StateStore.ts:4860-4949)

事实:CAS(expectedRevision)+ UPDATE-only;无 INSERT(missing_row 拒)、无 DELETE;
`getFlagValueRow(name)` 单行读(4601)。

~~改法第一稿(expectedRevision=0 表缺行、to_effective 记回落值)~~
**已作废(Codex R1 #3/#4)**:删行后 revision 重建为 1 有 delete→recreate ABA;
回落值在 route 层取不到且 `*` 行清除后的回落是逐项目向量,写不进单个
to_effective。定案改为(见 plan Step 2):
- global 六行:现有 `applyFlagValueChange` 签名/合同逐字节不变。
- scoped 写走**新方法** `applyScopedFlagValueChange`,CAS fence = 该 (flag, scope)
  的 changelog `MAX(id)`(append-only ⇒ 跨删建单调,无 ABA);set = UPSERT 显式
  "0"/"1",clear = DELETE + changelog(`to_effective='inherit'` 哨兵,schema 注释
  写明语义);delete 成功返回 `{ok:true, deleted:true}`(独立类型,不复用
  ApplyFlagValueChangeResult)。
- changelog 全部写 scope 列。
- 读侧:`getFlagValueRow(name, scope='*')`;新增 `listFlagValueRows(name)` /
  `listAllFlagValueRows()`(enrich 一次拉全表,行数 ≤ 每 flag×(项目数+1),很小)。

### 1.4 `flag_scan_state`(StateStore.ts:4954-4968, 5106-, 5453-)

事实:PK `flag_name`;upsert `ON CONFLICT(flag_name)`(5455-);`getFlagScanState()`
全表读;`ask_count`/`last_asked_run_id` 在 upsert 中有意不更新。

~~改法:同款 rebuild 加 scope 列,PK `(flag_name, scope)`。~~
**已作废(Codex R1 #5)**:`flag_scan_state` 还承载 flag 级生命周期
(ask_count / last_asked_run_id / last_retiring_issue / departure / rowsModified===1
断言),PK 扩了会全部炸。改为**不动此表**,另建纯增量的
`flag_scan_scope_state(flag_name, scope, canonical, streak…)` 只记 per-scope 稳定
账本;flag 级候选/ask/departure/anchor 逐字节不变(见 plan Step 6)。

## 2. 策略层(packages/config/src/feature-flags/store-policy.ts)

事实:
- `STORE_MANAGED_FLAGS`(61-68)= 6 个 bridge_global env flag。
- `getFlagStoreCodec`(116-130)只认这 6 个;defaultOnCodec / optInCodec 已存在
  (94-102),对显式 raw "0"/"1" 双向解析正确 —— scoped 行可直接复用(scoped 行
  has_override 恒 1、raw 恒显式)。
- `validateFlagAuthoringPolicy`(173-)C-group 门:非 baseline 的新 spec 必须
  store-managed 且 bridge_global env;`new project_config specs are forbidden until
  project-scoped store authority exists`(216-219)。
- `getStoreEligibility` 拒 governance_gate / protected_legacy / 非 managed。

改法:
- 新增 `PROJECT_STORE_MANAGED_FLAGS: ReadonlySet<string>` 字面集合 =
  `{doc_flow, pipeline_dag, pipeline_work_kind, proofshot, xiaohongshu_learning}`。
  排除理由(写进注释,供 authoring gate 校验口径):
  - `checkpoint_enabled`:governance_gate + 通配 configKey(`checkpoints.*.enabled`)。
  - `xiaohongshu_auto_create`:configKey 带 `[]`(per-collection),一项目一值表达不了。
  - `skill_framework_split_participation`:readonly 退出杠杆,读纪律独立(FLY-1356)。
  - `ponytail`:dormant + Annie-exception。
- `getFlagStoreCodec` 对这 5 个按 polarity 返回 defaultOnCodec / optInCodec
  (5 个全是 bool;xiaohongshu_learning/proofshot/doc_flow/pipeline_* 均 opt_in →
  optInCodec;白名单成员如未来含 default_on 也天然覆盖)。
- 新增策略校验(进 validateFlagAuthoringPolicy 或并列函数,测试兜底):
  PROJECT_STORE_MANAGED_FLAGS 每个成员必须 `scope==='project' && valueKind==='bool' &&
  category!=='governance_gate' && !dormant && toggleable!=='readonly' && configKey 不含
  '[]'/'*'`,且必须有 codec。216-219 的禁令措辞更新:新 project_config spec 必须同时
  进 PROJECT_STORE_MANAGED_FLAGS(地基已存在,禁令从「一律禁」收窄为「必须入管」)。

## 3. 解析层

### 3.1 纯函数(packages/config/src/feature-flags/resolve.ts)

事实:`FlagEffectiveByProject = {projectName, value?, error?, isDefault?}`(39-46);
`resolveFlag` project 分支从 `ctx.projectConfigs` 算(302-337);config 包不能 import
teamlead ⇒ DB 行只能以纯数据形式进来。

改法(保持 resolveFlag 本身 byte-compat,新增纯函数供 teamlead 调):
```ts
// rows: 该 flag 的 DB 行(纯数据),configRow: resolveFlag 算出的 config 行
export function resolveScopedEffective(input: {
  spec: FeatureFlagSpec;
  projectName: string;
  rows: ReadonlyArray<{ scope: string; raw: string | null }>;
  configRow: FlagEffectiveByProject;      // config.yaml 兜底(其内部已含 registry default)
  codec: FlagStoreCodec;
}): FlagEffectiveByProject & { via: "project_row" | "star_row" | "config" | "default" }
```
顺序:`rows` 中 scope===projectName → codec.parse;否则 scope==='*' → codec.parse;
否则原样返回 configRow(via 按其 isDefault 标 "config" 或 "default")。
`FlagEffectiveByProject` 加可选 `via` 字段(向后兼容,旧消费者不读)。
三级顺序的单测放 config 包(不依赖 SQLite)。

### 3.2 DB 叠加(packages/teamlead/src/bridge/flag-store-runtime.ts)

事实:`enrichFlagViewsWithStore(views, runtime)`(103-169)只叠 6 个 global flag;
`readFlagValue` 对非 managed throw(43-45);bypass 模式用 env 快照。
唯一装配点 = plugin.ts `currentFlagViews()`(4690-4697),此处拿得到
`managementProjects`(名册)。

改法:
- `enrichFlagViewsWithStore` 加第三参 `projects?: readonly string[]`(或并列新函数,
  倾向加参 —— 只有一个生产调用点)。对 `view.scope === "project"` 且
  `PROJECT_STORE_MANAGED_FLAGS.has(view.name)` 的 view:
  - runtime.mode === "ready":读该 flag 全部行,逐项目跑 `resolveScopedEffective`
    重算 `effectiveByProject`;打 `projectStoreManaged: true`(FlagView 新可选字段,
    render 靠它决定是否给「项目」下拉)。
  - runtime.mode === "bypass":不叠(整体回落 config,旧行为),
    `projectStoreManaged: false` + note。
- **divergence 明示**(exploration §4.1):对每个项目行,若 DB 覆盖后的值 ≠ config
  算出的值,在行上带 `configShadowed: true`(或复用 via ≠ "config" 即知),render 层
  出黄条「runtime 仍按 config.yaml(C 单切换)」。

## 4. 写入面

### 4.1 flag-routes.ts(stage/apply)

事实:`FlagStoreCanonical`(52-63)无 scope;`handleFlagStage` 对
STORE_MANAGED_FLAGS 走 store canonical(167-220),要求非空 reason,bypass 409;
`handleFlagApply` 验 token + `applyFlagValueChange`;`computeRawTo`(97-104)
default→删行语义只适用于 global env 流。挂载在 plugin.ts 2286/2299,
`flagRouteDeps` 组装处可注入名册。

改法:
- `FlagStoreCanonical` 加 `scope: string`(sha 自动覆盖;旧 canonical 无 scope,
  token 单次即时消费,无需迁移兼容)。
- `handleFlagStage` 入参加 `project?: string`(默认 '*')与 `op?: "set" | "clear"`
  (默认 set)。校验顺序(全部 400,fail-closed):
  1. `project !== '*'` 或 `op==='clear'` 时 flag 必须存在于 registry;
  2. **spec.scope === 'bridge_global' 且 project !== '*' → 400**(名册 scope 生效;
     mailbox_queue 验收点在这);
  3. `spec.scope === 'project'` → 必须 ∈ PROJECT_STORE_MANAGED_FLAGS(governance /
     dormant / readonly / 数组键在此被拒),且 project ∈ {'*'} ∪ 名册(deps 注入
     `projectNames: () => string[]`,即 managementProjects 的 projectName 列表),
     否则 400 `unknown project scope`;
  4. project flag 的 to 必须 boolean(5 个全是 bool);`op==='clear'` 时忽略 to。
  - rawTo 规则:project flag set → 显式 `to ? "1" : "0"`(**不走** computeRawTo 的
    default→null);clear → null。global store flag('*' 行)沿用 computeRawTo 不变。
  - ~~stage 前读行按 revision 记 fence(缺行=0);clear 的 effectiveTo 记回落值~~
    **已作废(Codex R1 #3/#4)**:scoped fence 改用 changelog `MAX(id)`
    (`expectedChangeSeq`),clear 的 to_effective 记 `inherit` 哨兵(见 §1.3 与
    plan Step 2/3)。
- `handleFlagApply`:kind==='flag_store' 且 scoped → 走
  `applyScopedFlagValueChange`;对 project flag 重复 stage 的 2/3 号校验(token 只证明
  「canonical 没被改」,不证明「canonical 当初合法」→ 服务端 allow-set 是权威的
  既有原则,FLY-709 头注)。

### 4.2 CLI(packages/flywheel-comm/src/commands/feature-flags.ts)

事实:子命令 `report` / `apply`;`apply` 组 `{name, to, reason}` 打 stage→apply
(93-151);`report --project` = 发布目的地(158)。

改法:
- 新子命令 `set`(= apply 的超集)与 `clear`:
  - `feature-flags set --name <flag> --to on|off|<enum> [--project <name|*>]
    [--reason <text>] [--bridge-url <url>]`
  - `feature-flags clear --name <flag> --project <name|*> [--reason <text>]`
    (clear 必须显式给 --project,防手滑清 global;'*' 也要显式写)
- `apply` 保留为 `set` 的别名(存量文档/手机报告命令兼容),同样接受 --project。
- body 加 `{project, op}`;reason 必填规则:store-managed(global 或 project 白名单)
  一律要 reason(沿用现规则的精神)。
- usage 字符串写清 set/clear 的 --project 是 scope,report 的 --project 是发布频道。
- **消费者 sweep 不触发**(CLAUDE.md FLY-1914):本单只加子命令,不删不改名。

### 4.3 management console 写路径(management-existing-writers.ts)

事实:`createFlagWriter` 只写 direct env 非 store flag(.env);store-managed 拒
(805-810);project override 值 writeCapability 恒 readonly。

改法:**本单不给新台加第二条写路径**(单一写点 = flag/stage+apply 路由;新台的
projectOverrides 因 §3.2 的 enrich 自动显示 DB 值)。writeCapability reason 文案对
PROJECT_STORE_MANAGED_FLAGS 成员改为指路「用 feature-flags set --project」
(~~或旧台项目下拉~~ **已作废,Codex R2 #5:旧台/console 直写通道已整体删除,
页面只生成命令**,见 plan §0)。新台的可写化留给后续 issue,避免本单同时动两套
stage/apply 协议。

## 5. 展示面(feature-flag-render.ts + feature-flag-report-html.ts)

事实:`renderFlagState` 逐项目 badge(166-184);控制位 `renderFlagControl`
只对 direct env flag(195-226);phone 报告脚本把勾选/下拉变化拼成
`feature-flags apply …` 命令行(feature-flag-report-html.ts:93-148)。
**勘误(Codex R1 #1)**:render 的 `console` control mode 在生产**没有调用方** ——
真实 localhost 管理台是 fleet-console-html.ts(management coordinator 流),不渲染
这些卡片;所以「console 模式按钮由 FleetConsole 接线」是我此前的错误假设。
手机 copy-paste 报告页是这套卡片唯一真实的交互控制面。

改法:
- 项目行 badge 带 via 标(`项目行` / `*行` / `config` / `默认`,小灰字),
  DB≠config 时黄标「runtime 按 config,C 单切换」。
- `projectStoreManaged` 的卡片加「项目」控制条:
  `<select data-ffp-scope>`(选项:`*` + 名册项目)+
  `<select data-ffp-value>`,**值下拉的选项与选中态由所选 scope 在 scopedStore 里
  的 presence 决定(presence-based 状态机,Codex R2 #2 定案,细节见 plan Step 4)**:
  无行 → 基线「继承(未设行)」,on/off 生成 set;有行 → 选中显式行值,
  「清除(回落继承)」生成 clear;scope 切换时 phone 脚本按嵌入的
  `{present, value}` 映射重置选项/选中/dirty。
  - phone 模式:变化 → 生成 `feature-flags set --name F --to on --project P --reason
    phone-report` 或 `feature-flags clear --name F --project P --reason phone-report`
    行进复制框(纯本地拼串,沿用零回连模型)。
  - ~~console 模式:生成同款 stage/apply POST(body 带 project/op)。~~
    **已作废(Codex R1 #1)**:console mode 无生产调用方,本单不为它接线;
    控件只做 phone 模式,唯一写入执行面是 CLI(见 plan §0)。
- render 需要名册 ⇒ `renderFeatureFlagsHtml` / `renderFlagCard` 加可选
  `projectNames` 入参(或从 view.effectiveByProject 取行名 —— 后者更稳:enrich 后
  的 effectiveByProject 就是按名册逐项目的,直接用它,免传参)。**采用后者**。

## 6. 周扫描(scan.ts + flag-retirement-scan.ts)

事实:`canonicalizeFlagSample` 对 project flag 把整向量 JSON 成一个 canonical
(154-195);`FlagScanState` 无 scope;`advanceState` 纯函数逐 flag 推进;
候选条件 = streakSamples≥2 且 streak ≥ 7 天(363-376);名册不匹配 → 整 flag
indeterminate。

~~改法(第一稿:FlagScanState 加 scope、nextState 变 per-scope 数组)~~
**已作废(Codex R1 #5)**:上述第一稿低估了 flag_scan_state 上的 flag 级生命周期
耦合。定案改为(见 plan Step 6):flag 级扫描(canonical 整向量、候选、ask、
departure、anchor、`nextState`)**逐字节不变**;另建纯增量表
`flag_scan_scope_state(flag_name, scope, canonical, streak_started_at,
streak_samples, last_sampled_at)` 记 per-scope 稳定账本,`computeFlagScan` 返回值
**新增** `nextScopeState` 字段;commit 时 upsert 并按名册/registry 修剪失效 scope
行;报告对 project flag 附 per-scope 天数(run_items 表不动)。

## 7. 名册(projects.json)与校验点

- Bridge 内权威名册 = `managementProjectSource.projects()`(plugin.ts:4674-4683,
  热重载)→ 注入 flagRouteDeps.projectNames。
- CLI 不自读 projects.json(单一校验点在 Bridge 路由;CLI 传什么都由服务端裁决,
  错名 400 带 `unknown project scope: <name>` + 现名册列表,便于自纠)。
- StateStore 层不读名册(依赖注入的 scope 已被路由校验;防御性只校验非空字符串 +
  flag/scope 相容性,靠 §1.2 的身份断言兜底)。
- 孤儿行(项目移出名册):解析循环按名册走,孤儿行不参与;不自动删;
  管理台不显示;changelog 永久留痕。写进诚实边界。

## 8. 测试盘点(现有 + 新增落点)

现有直接相关:
- `packages/teamlead/src/__tests__/StateStore.flag-value-store.test.ts`(store CRUD/CAS)
- `packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts`(enrich/读穿)
- `packages/config/src/__tests__/feature-flags-resolve.test.ts`(resolver)
- `packages/config/src/__tests__/feature-flags-store-policy.test.ts`(authoring gate)
- `packages/config/src/__tests__/feature-flags-scan.test.ts`(computeFlagScan)
- `packages/teamlead/src/bridge/__tests__/`(flag-routes 的 stage/apply 测试,
  与 flag-retirement-scan.test.ts)
- `packages/flywheel-comm/src/commands/__tests__/feature-flags.test.ts`(CLI)

新增(对应验收):PK 迁移幂等 + 存量 6 行落 '*';scope 名册校验(未知名 400);
bridge_global 拒项目行(mailbox_queue);三级取值顺序(config 包纯函数);双读回落
(无行→config,有 '*' 行遮蔽 config,项目行压过 '*' 行);clear 删行 + changelog
to_effective 记 `inherit` 哨兵(~~回落值~~ **已作废,Codex R2 #5**,见 §1.3 /
plan Step 2);bypass 下 scoped 写 409 + 双读回落 config;per-scope 扫描
streak(一项目变值不重置他项目;完整清单见 plan Step 2/4/6)。

## 9. 会过期的结论(as-of 2026-08-27)

| 结论 | 依据 | 重核命令 |
|---|---|---|
| flag_values 现存 6 行且全 global | STORE_MANAGED_FLAGS 集合 | `sqlite3 ~/.flywheel/teamlead.db "select flag_name from flag_values"` |
| 名册 6 项目 | ~/.flywheel/projects.json | `node -e` 读 projectName 列表 |
| CLI 无 set/clear 子命令 | feature-flags.ts | `git log -S "sub === \"set\"" packages/flywheel-comm` |
| 新台 flag 写路径只覆盖 direct env | management-existing-writers.ts:793- | `git log -S createFlagWriter` |
| doc_flow 运行时读点在 edge-worker 读 config.yaml | Blueprint.ts:1991 | `grep -n docFlowConfig packages/edge-worker/src/Blueprint.ts` |
