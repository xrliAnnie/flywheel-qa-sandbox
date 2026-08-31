# FLY-2100 flag_values 加范围列(逐项目 flag 存值) — 探索

Issue: FLY-2100 (https://linear.app/geoforge3d/issue/FLY-2100/flaga地基-flag-values-加范围列全项目-项目名逐项目-名册-scope-生效-解析顺序-项目默认-管理台按项目读-db)
日期: 2026-08-27
基于: 无(上游为 Epic FLY-2099 founder 定案,v4 HTML「DB 怎么扩成按项目存值」段)

## 1. 要解决什么

今天 Flywheel 的 feature flag 有两类存值面:

- **Bridge-global env flag**(`scope: bridge_global`):其中 6 个已被 SQLite flag store 接管
  (`flag_values` 表,FLY-1778),管理台可以 stage→apply 直改,有 changelog 审计。
- **逐项目 project_config flag**(`scope: project`,如 `doc_flow` / `proofshot`):值散在各项目仓的
  `.flywheel/config.yaml` 里。管理台只能**看**(resolver 读 config 算出 `effectiveByProject`),
  不能**改**;没有统一审计;`store-policy.ts` 里写死「new project_config specs are forbidden
  until project-scoped store authority exists」—— 本单就是在建这个 project-scoped store authority。

FLY-2100(Epic FLY-2099 的 Batch 1 / A 单)把 `flag_values` 从「一 flag 一行」扩成
「一 (flag, scope) 一行」:`scope='*'` = 全项目,`scope=<projectName>` = 逐项目。
写入按名册(`~/.flywheel/projects.json`)校验;解析顺序 **项目行 → `*` 行 → 默认**;
管理台按项目读 DB 并给「项目」下拉设值/清值;CLI 加 `--project`;changelog / 周扫描带 scope。

## 2. 现状审计(关键事实)

### 2.1 存储层(packages/teamlead/src/StateStore.ts)

- `flag_values`:PK `flag_name`,列 `has_override / raw_value / last_effective /
  value_last_changed / revision / updated_at / updated_by`,CHECK(has_override=1 ⟺ raw 非空)。
  当前**只有 6 行**(STORE_MANAGED_FLAGS:loop_profiler, shipped_husk_force, flag_retirement_scan,
  workflow_rework_reentry, skill_framework_mode, workflow_turn_divergence_alerts)。
- `flag_value_changelog`:append-only 审计,PK 自增 id,`flag_name` + action
  (`seed/set/clear/default_shift/bypass_recovery`),索引 `(flag_name, id)`。
- `ensureFlagValueRows`:Bridge 启动 seed / bypass 恢复;**有身份断言** —— 表里出现
  非 STORE_MANAGED_FLAGS 的 flag_name 直接 throw(4690 行)。扩 scope 时这条断言必须同步扩。
- `applyFlagValueChange`:CAS(expectedRevision)写 + changelog;**只支持已存在的行**
  (missing_row 拒),没有 insert / delete 路径 —— 逐项目行是「写时才建、清值即删」,要补。
- `flag_scan_state`(FLY-1781):PK `flag_name`,存 canonical / streak;逐项目 flag 目前把
  **整个 per-project 向量** JSON 成一个 canonical(scan.ts `canonicalizeFlagSample`),
  任何一个项目变值就重置整个 flag 的 streak。

### 2.2 解析层(packages/config/src/feature-flags/resolve.ts)

- `resolveFlag`:bridge_global → 单值 `effective`(env + .env 双源比对);
  project → `effectiveByProject[]`,**从 config.yaml 算**(`resolveConfigValue`,
  缺 config → 默认值,坏 config → error 行)。
- config 包**不能 import teamlead**(依赖方向),DB 覆盖只能发生在 teamlead 侧:
  `enrichFlagViewsWithStore(views, runtime)`(flag-store-runtime.ts)是现成的 DB 叠加点,
  今天只叠 6 个 global store flag。

### 2.3 写入面

- **flag-routes.ts**(`POST /api/fleet/flag/stage|apply`):stage 算 canonical + 发单次
  confirmToken,apply 验 token + CAS。store-managed 走 `FlagStoreCanonical`
  (rawFrom/rawTo/revision/actor/reason),其余 direct env flag 走 .env 写。
  **canonical 没有 scope 字段**。
- **CLI**(flywheel-comm `feature-flags`):子命令只有 `report` 和 `apply`
  (`--name --to on|off|<enum> --reason`),没有 `set`/`clear`,没有 `--project`。
  注意 `report --project` 已存在但语义是「发布到哪个项目频道」—— 命名冲突要在设计里说清。
- **management console**(fleet-console-html.ts 新台):Feature Flags 页已渲染
  per-project override 列(`buildFlagView.projectOverrides`),但 writeCapability 对
  project 值恒 readonly(conversational / store-managed 均拒)。

### 2.4 展示面

- feature-flag-render.ts(issue 点名的「管理台 flag 页」):Apple 卡片,`renderFlagState`
  对 project flag 逐项目渲染 badge;控制位只有 direct env flag 的开关/枚举下拉。
  被 localhost FleetConsole(mode=console)与手机 copy-paste 报告
  (feature-flag-report-html.ts,mode=phone,生成 `feature-flags apply …` 命令行)共用。

### 2.5 运行时消费点(诚实边界的根)

`doc_flow` 的真实运行时读点是 **edge-worker Blueprint.runInner 读
`this.docFlowConfig.enabled`,来源仍是项目 config.yaml**;`proofshot` / `pipeline_*` 同理。
本单只改 resolver / 管理台 / CLI / 审计 / 扫描,**不动任何运行时读点**(C 单删 config.yaml
读路径时才切)。⇒ 中间态存在「管理台显示 DB 值、runtime 仍按 config.yaml 行为」的窗口,
必须在管理台明示分歧(divergence badge),不能假装一致。

## 3. 方案空间

### 3.1 scope 列放哪(定案照抄 Epic,不再展开)

同表加列 `scope TEXT NOT NULL DEFAULT '*'`,PK 改 `(flag_name, scope)`。founder 已在
FLY-2099 v4 定案;备选「另建 flag_project_values 表」被否 —— 两表意味着两套
CAS/changelog/enrich 代码路径,违背单一写点。

### 3.2 哪些 flag 允许逐项目行(本单需要拍板的第一个点)

写入约束是 registry 的 `scope` 字段:`bridge_global` 拒项目行(400),`project` 允许
`*` + 项目行。但「允许」≠「全部开放写」:project flag 里有 governance
(checkpoint_enabled)、dormant(ponytail)、readonly(skill_framework_split_participation)、
per-collection 数组键(xiaohongshu_auto_create,configKey 带 `[]`,一项目一值表达不了它)。

候选:
- **A. 只开 doc_flow**(验收最小集)—— 但管理台「项目下拉」就只对一张卡有意义,
  C 单迁移范围也说不清。
- **B. 开全部 project flag** —— 把 governance / dormant / 数组键也开了,语义站不住。
- **C. 开「简单布尔 + 非 governance + 非 dormant + 非 readonly」的 5 个**:
  `doc_flow, pipeline_dag, pipeline_work_kind, proofshot, xiaohongshu_learning`,
  显式白名单 `PROJECT_STORE_MANAGED_FLAGS`(沿用 STORE_MANAGED_FLAGS 的字面集合 + 策略校验
  idiom)。排除名单逐个给理由。

**倾向 C**:白名单是既有 idiom(FLY-1981 authoring gate 能机械校验),排除项各有硬理由,
且正好构成 C 单的 config.yaml 删除范围。

### 3.3 解析顺序里 config.yaml 站哪一级

定案顺序是 项目行 → `*` 行 → 名册默认(registry default)。本单双读的插入点:
**DB 有行用 DB(项目行优先,其次 `*` 行),无任何 DB 行才回落 config.yaml,config 再缺
才是 registry default**。推论要写明:一旦给某 flag 写了 `*` 行,所有没写项目行的项目
的显示值都被 `*` 行遮蔽,config.yaml 里的旧值不再参与显示 —— 这是有意的
(C 单本来就要删它),但要在管理台/审计里可见。

### 3.4 「清值」的语义

Global store flag 今天的 clear = `has_override=0` 且行保留(6 行永在,由 seed 保证)。
逐项目行如果沿用这套,会出现「行在但无意义」的第三态。定案:**scoped 行只在有值时存在,
set 总写显式 raw("0"/"1",即使等于默认 —— 项目行 off 要能压过 `*` 行 on),clear = 删行 +
changelog 记 to_present=0**。`*` 行对 project flag 同理(写时才建)。6 个 global env flag
的 `*` 行保持旧语义不动(byte-compat)。

### 3.5 周扫描按 (flag, scope) 计稳定天数

`flag_scan_state` PK 扩成 `(flag_name, scope)`;逐项目 flag 一项目一行(scope=projectName,
样本 = 该项目**解析后的**生效值),global flag 保持一行(scope='*')。flag 级候选判定
(要不要摆到 Annie 面前)= 名册匹配 + 所有 scope 的 streak 都 ≥ 7 天(min-over-scopes),
与今天「整向量 canonical」的触发时机等价 —— 差别只在报告里能看到每个项目各自稳定了几天,
以及一个项目抖动不再抹掉其他项目的账。keep anchor / run item 仍 flag 级(最小改)。

## 4. 关键风险 / 边界

1. **显示 vs 行为分歧窗口**(§2.5):DB 写了、runtime 还读 config —— 管理台必须对
   「DB 值 ≠ config 值」的项目行打 divergence 标,报告如实;这是 C 单的存在理由,不是本单缺陷。
2. **PK 迁移**:better-sqlite3 下 PK 变更要走 rebuild(建新表→搬数→drop→rename),
   必须幂等(以 scope 列是否存在为哨兵),迁移中 6 行全部落 `scope='*'`。
3. **名册漂移**:项目被移出 projects.json 后其行成孤儿 —— 解析按名册循环,孤儿行自然不参与;
   不自动删(审计留痕),边界写明。
4. **CLI 命名冲突**:`report --project`(发布目的地)与新 `set/clear --project`(scope)
   同名不同义;set/clear 是新子命令,语义在各自 usage 里写死。
5. **bypass 模式**(FLYWHEEL_FLAG_STORE=0):项目行不可用,双读整体回落 config(旧行为);
   scoped 写在 bypass 下 409(与现有 store flag 一致)。

## 5. 结论

走「同表加 scope 列 + 显式 PROJECT_STORE_MANAGED_FLAGS 白名单(5 个)+ 写时才建/清值即删 +
enrich 层叠加 DB(config 兜底)+ 扫描 per-scope 计账」。细节进 research.md / plan.md。
