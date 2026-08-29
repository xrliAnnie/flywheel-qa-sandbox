# FLY-2103 config.yaml flag 退役(Batch C) — 调研
Issue: FLY-2103 (https://linear.app/geoforge3d/issue/FLY-2103/flagcconfigyaml-退役-9-个-project-config-flag-处置checkpointsenabled)
日期: 2026-08-28
基于: exploration.md

代码事实清单(全部 2026-08-28 在 main(d4e08f4a5)worktree 实查)。

## 1. 上游已就位的能力(FLY-2100,#971)

- **StateStore**(packages/teamlead/src/StateStore.ts):
  - `getFlagValueRow(name, scope = "*")`(:4718)、`listScopedFlagValueRows()`(:4753)、
    `applyScopedFlagValueChange({name, scope, op, rawTo, expectedChangeSeq, actor, reason})`(:5096)、
    changelog-seq CAS、`listFlagValueClocks`。
  - `ensureFlagValueRows` 身份断言:`'*'` 行 ∈ STORE∪PROJECT 集;非 `'*'` 行 ∈ PROJECT 集。
    → ponytail / split 入集后断言自动放行,无需改。
- **flag-routes**(packages/teamlead/src/bridge/flag-routes.ts):
  - project 分支校验(:180-192):`PROJECT_STORE_MANAGED_FLAGS` 成员 + 名册项目;**不检查
    toggleable**(direct-toggleable guard 只管 bridge_global 路,:263)。
  - 写入面:`POST /api/fleet/flag/stage` + `/apply`(plugin.ts:2317/2330)。
- **CLI**:`flywheel-comm feature-flags set/clear --project <name|*>`(FLY-2100 Step 5)。
- **resolveScopedEffective**(resolve.ts:274):项目行 → `*` 行 → configRow 兜底;本单删 configRow 兜底。
- **enrichFlagViewsWithStore**(flag-store-runtime.ts:83):PROJECT 分支叠 scopedStore + valueClocks +
  `runtimeConfigValue / runtimeDivergence: "config_pending_cutover"`(:151-165,本单删)。

## 2. 九个 flag 的读点归宿(逐个)

### 2.1 checkpoint_enabled — 固化删
- 唯一读点:Blueprint.ts:2290-2315,`for (const [cpName, cpConfig] of Object.entries(this.checkpointConfig))`,
  `:2294 if (!cpConfig.enabled) continue;` → **删该行**,声明即启用。
- 类型:`CheckpointConfig.enabled?: boolean`(types.ts:183)→ 删字段。
- ConfigLoader:285-286 shape 校验 → 改为「present 即 throw」。
- registry spec(registry.ts:326-347)整删;`LEGACY_UNMANAGED_BASELINE` 删名。
- config.yaml:6 个项目全部 checkpoint 都要删 `enabled: true` 行(geoforge3d/joycon/pa/growth 各 3 个,
  flywheel 4 个,tidal-echo 2 个)。

### 2.2 xiaohongshu_auto_create — 固化删(写死 true)
- 唯一读点:packages/teamlead/src/xiaohongshu-scheduler.ts:168 `autoCreate: col.auto_create ?? true`
  → `autoCreate: true`(trigger body `auto_create: true` 字段保留,:210 —— skill 合同字段)。
- 类型:`XiaohongshuCollectionConfig.auto_create?: boolean`(types.ts:352)→ 删。
- ConfigLoader:collections 元素校验段(~:553)删 auto_create 分支 → 改「present 即 throw」。
- registry spec(:390-410)整删;baseline 删名。
- config.yaml:无项目设过,无删除项。

### 2.3 doc_flow — 迁 DB
- 运行时读:run-infra.ts:1010 `docFlowConfig = flywheelConfig?.doc_flow`(boot)→ Blueprint 构造参数
  (:854);Blueprint.ts:1991 `if (this.docFlowConfig?.enabled === true)` 注入 DOC-FLOW 块。
- run-infra.ts:1111-1114 `docDeptByProject.set(name, docFlowConfig?.default_department)`(resume 计算机)
  —— 只用 department,不看 enabled,**不动**。
- 归宿:Blueprint 增 call-time reader(run-infra 用 `runInfraOpts.flagStore`(:1079 已有)组
  `() => storeDocFlowEnabled(flagStore, projectName)`);`DocFlowConfig.enabled` 删,块内
  `default_department` 保留(仍 boot 读,不是 flag)。
- 注入条件变为 `docFlowEnabled() === true && default_department 存在`;department 缺失时保留现有
  「skip + console.warn」路(:1997)。
- ConfigLoader:366-385:`enabled` present 即 throw;块 present → `default_department` **必填**
  (原「enabled=true 才必填」条件随 key 死亡)。
- config.yaml 删 key:flywheel / joycon-typeless / personal-assistant / tidal-echo(4 处,值全 true)。
- 迁移行:4 个项目行 raw="1"。

### 2.4 pipeline_dag / 2.5 pipeline_work_kind — 迁 DB
- 运行时读:`loadWorkKindConfigStrict`(pipeline-config-source.ts:37,call-time fresh yaml read):
  - runs-route.ts:2116(fresh master dispatch)
  - workkind-cutover.ts:784
  - `reconcileDefaultDagCategoryBindings`(:143,boot 时逐项目)
  - `loadPipelineConfigByProject`(:90)—— 消费者待实施时 rg 复核(疑仅 boot 展示/枚举)。
- 现语义(必须保):无文件/无块 → `{workKind:false, dag:true}`(FLY-1981);非 ENOENT 读错 →
  `{workKind:false, dag:false}` fail-closed + warn;`work_kind && !dag` → `work_kind_requires_dag` 拒;
  `work_kind` 非 bool → `work_kind_not_boolean` 拒。
- 归宿:新 `readPipelineEnrollment(flagStore, projectName): WorkKindConfigResult` —— store 行
  (项目→`*`)→ registry default;store 读抛错 → fail-closed `{workKind:false, dag:false}` + warn;
  `work_kind_requires_dag` 组合校验保留在读点(行可组合出违例)。yaml 解析路整删。
- **registry default 翻转**:pipeline_dag `opt_in/false` → `default_on/true`(exploration F1/D3);
  work_kind 维持 `opt_in/false`(absent=false 与今天一致)。
- ConfigLoader:421-434 dag/work_kind 校验 → `pipeline` 块 present 即 throw(PipelineConfig 仅这两
  key,块整体退役);`PipelineConfig` 类型 + `FlywheelConfig.pipeline` 删。
- config.yaml 删 key:仅 flywheel(dag: true / work_kind: true)→ 整个 pipeline 块删。
- 迁移行:flywheel pipeline_dag="1"(default-equal,仍写,显式声明留审计)、pipeline_work_kind="1"。

### 2.6 proofshot — 迁 DB
- 运行时消费:run-infra.ts:1006 `skillsConfig = flywheelConfig?.skills` → DirectEventSink 构造
  (:191,emitStarted 时把 effective proofshot config 持久化进 `session_params.proofshot.config`,
  :277);Blueprint slot 7。auto-trigger(proofshot-trigger.ts)读 session_params,不直读 config。
- 归宿:effective config 组装点(DirectEventSink.emitStarted 的持久化前)`enabled` 改 store 读
  (`storeProofshotEnabled(flagStore, projectName)`,call-time = session start);
  `skills.proofshot` 其余 key(dev_command / port / capture_stages / vision_* / allowlist)仍 config。
  DirectEventSink 构造参数补 reader closure(run-infra 处 flagStore 可得)。
- 类型:SkillsConfig.proofshot 的 `enabled` 字段删(proofshot-defaults.ts DEFAULT_PROOFSHOT_CONFIG
  同步)。ConfigLoader:167-168 → present 即 throw。
- config.yaml:无项目设过,无删除项;无迁移行。

### 2.7 xiaohongshu_learning — 迁 DB
- 读点:packages/teamlead/src/xiaohongshu-scheduler.ts:102-103
  `if (!learning?.enabled || !learning.collections?.length) continue;`(planLearningRuns)。
- 生产接线现状:planLearningRuns 唯一非测试调用方是 `scripts/xiaohongshu-scheduler.ts`
  (launchd 入口,gated pilot,plist 未装 —— 头注写明)。Bridge 进程内无消费。
- 归宿:`planLearningRuns` deps 注入 `learningEnabled(projectName): boolean`;scripts 入口以
  **只读**方式取值(直连 StateStore 只读快照或 Bridge API,实施时定,脚本本就要求 Bridge 在跑
  才能 POST /api/runs/start)。「enabled 而 collections 空」从 load-throw 改为 scheduler 显式日志跳过
  (exploration F6)。
- ConfigLoader:469-470 enabled 校验 → present 即 throw;:591-598 非空 collections 交叉校验删。
  `XiaohongshuLearningConfig.enabled` 字段删,collections 等保留。
- config.yaml:无项目设过;无迁移行。

### 2.8 ponytail — 迁 DB(`*`=false,exploration D1/P2 定稿)
- 现状:run-infra.ts:1011-1018 刻意 `ponytailConfig = undefined`(FLY-615 v1 dormant);
  Blueprint:859 构造参数,:1040 `resolvePonytailRequested(input, this.ponytailConfig, …)` per-run。
- 字节等价证明:ponytail.ts:116 `projectOn = projectConfig?.enabled === true`;:124(labels
  unreadable)与 :150(project 层命中)都仅在 `=== true` 时改变行为 → `*`=false ≡ undefined。
- 归宿:run-infra 删 dormant 注释块,传 reader closure
  `() => (storePonytailEnabled(flagStore, projectName) ? { enabled: true } : undefined)`;
  Blueprint 参数同位改为 reader(positional ctor,位置不动)。spec:`dormant` 删、
  `toggleable: conversational`、note 更新(FLY-615 per-issue 路不动,`*`=false 由迁移种子落行)。
- ConfigLoader:439-451 → `ponytail` 块 present 即 throw(块仅 enabled 一个 key,整块退役);
  `PonytailConfig` 保留(resolver 运行时类型,不再是 config 类型)——从 FlywheelConfig 摘除。
- config.yaml:无项目设过;迁移行:`*` 行 raw="0"(**须在新代码部署后写**,老 Bridge 白名单拒收)。

### 2.9 skill_framework_split_participation — 迁 DB(过渡)
- 读点:run-infra.ts:1077-1078 `makeSkillFrameworkParticipationReader(configPath)`(每 dispatch
  fresh yaml read,skill-framework-participation.ts)→ Blueprint。
- 归宿:reader 改 store 版:`(projectName) => storeSkillFrameworkSplitParticipation(flagStore, projectName)`
  (行:项目→`*`→default true);store 读抛错 → **保留 fail-closed 合同**(Blueprint catch → 钉 A + warn)。
  yaml reader 模块整删(含 whitelist-mapping 校验 —— 那是 yaml 形状防御,store 行无此攻击面)。
- spec:`toggleable: readonly → conversational`(exploration D2)。
- ConfigLoader:404-407 → `skill_framework` 块 present 即 throw(块仅 split 一个 key);
  `SkillFrameworkConfig` 类型 + FlywheelConfig 成员删。
- config.yaml:无项目设过;无迁移行。过渡性质:FLY-1834 四臂结账后连 `skill_framework_mode` 一起删,
  本单不为它添任何长期机制。

## 3. config 包公共面变更汇总

- **registry.ts**:删 2 spec;pipeline_dag default/polarity 翻转;7 个迁移 spec 的 readSites 全部改
  delegated flag-store-runtime 命名 wrapper(exploration D5);ponytail dormant 删;2 个 toggleable
  改 conversational。
- **store-policy.ts**:`PROJECT_STORE_MANAGED_FLAGS` 5→7;`LEGACY_UNMANAGED_BASELINE` 9→7;
  `getFlagStoreCodec` 的 PROJECT 分支按 polarity 自动覆盖新成员(ponytail opt_in→optInCodec、
  split default_on→defaultOnCodec、pipeline_dag 翻转后→defaultOnCodec),**零改动**;授权门公式零改动
  (两个新成员 spec 改后如实通过 project 分支)。
- **resolve.ts**:删 `FlagResolveCtx.projectConfigs`、`resolveConfigValue`、project 分支的 config 遍历、
  `runtimeConfigValue / runtimeConfigError / runtimeDivergence` 字段、`resolveScopedEffective` 的
  configRow 参数(改为 default 兜底行);`getByPath` 若零引用则删(实施时 rg)。dormant 分支(:341)
  随最后一个 dormant flag 死亡 → 按 dead-code 规则列出待批。
- **ConfigLoader.ts**:9 key 拒绝(每 key 专属错误信息,指向 flag store + FLY-2103);doc_flow 块
  present → default_department 必填。
- **types.ts**:`CheckpointConfig.enabled`、`DocFlowConfig.enabled`、`XiaohongshuCollectionConfig.auto_create`、
  `XiaohongshuLearningConfig.enabled`、proofshot `enabled`、`PipelineConfig`、`SkillFrameworkConfig` 删。

## 4. teamlead 包变更汇总

- **flag-store-runtime.ts**:新增 `readScopedBoolean(runtime, name, projectName)`(断言 PROJECT 集
  成员;`getFlagValueRow(name, projectName)` → `getFlagValueRow(name, "*")` → registry default;codec
  parse)+ 7 个命名 wrapper(registry readSites 的 resolverSymbol 与之一一对应,一 wrapper 一 flag,
  照搬 global 家族命名纪律);`enrichFlagViewsWithStore` 去 configRow / runtimeDivergence。
- **feature-flag-render.ts**:删黄标段(:172-176 一带)。
- **pipeline-config-source.ts**:`loadWorkKindConfigStrict` / `loadPipelineConfigByProject` yaml 路删,
  换 store 版;`reconcileDefaultDagCategoryBindings` 改用 store 版(签名已有 store)。
- **skill-framework-participation.ts**:整删,store reader 取代。
- **run-infra.ts**:配置加载段(:990-1027)按 §2 逐项收缩;Blueprint 构造传 reader closures。
- **DirectEventSink.ts / Blueprint.ts(edge-worker)**:按 §2.3/2.6/2.8 接 reader。
- **plugin.ts**:`resolveAllFlags` ctx 去 projectConfigs;`ffConfigCache` 本体保留(F5)。

## 5. 迁移脚本形状(exploration F8)

- `scripts/migrate-fly2103-project-flags.ts`(npx tsx;`--dry-run` 默认,`--apply` 才写)。
- 读侧:`~/.flywheel/projects.json` + 各项目 `.flywheel/config.yaml` **raw yaml parse**(不走新
  ConfigLoader —— 它会拒 key)+ 现有行(只读快照,幂等判定用)。
- 写侧:逐行走 Bridge `stage → apply`(带 fence),actor `migration:FLY-2103`;行已存在且 raw 相同
  → skip(幂等);dry-run 输出「将写/将跳过」全表。
- 预期写集:doc_flow×4(joycon-typeless / personal-assistant / tidal-echo / flywheel,raw="1")、
  pipeline_dag flywheel="1"、pipeline_work_kind flywheel="1";部署后第二遍:ponytail `*`="0"。
- 跑两遍:部署前(老 Bridge 只收 5 个白名单成员的行)+ 部署后(补 ponytail `*` 行),同一脚本幂等。

## 6. 部署时序(exploration F7 展开)

```
merge flywheel PR(代码 + flywheel 自己的 config.yaml 删 key + 脚本)
  └─ 不触发部署(FLY-1959 班车解耦;main checkout 部署时才 pull)
→ 迁移脚本 第一遍(对着在跑的老 Bridge API;dry-run 核对后 --apply)
→ merge 5 个外部 repo config PR(GeoForge3D / joycon-typeless / personal-assistant / growth / tidal-echo)
→ 00:00/12:00 班车部署:新代码 + flywheel 清理后 config 原子落地
→ 迁移脚本 第二遍(补 ponytail `*`=0)
→ 验收对照快照(§7)
```
窗口风险(如实):外部 repo 的 main checkout 若在「config PR merge → 班车」窗口内被 pull 且老
Bridge 在该窗口内 dispatch flywheel 工作 → 仅 flywheel `work_kind` 强制在窗口内掉回 false(dag 因
FLY-1981 absent=on 语义不受影响;doc_flow 是 boot 快照不受影响)。压窗口手段:config PR 紧贴班车
merge。此外若窗口内老代码 Bridge 意外重启且外部 config 已删 key → 该项目 doc_flow 注入在窗口内
掉线(概率低,列入 PR body 风险)。

## 7. 验收器材

- 隔离真 Bridge 配方复用 FLY-2100 plan Step 7(独立 HOME / TEAMLEAD_DB_PATH / TEAMLEAD_PORT /
  FLYWHEEL_BRIDGE_URL / 隔离 projects.json + 6 项目 fixture config;禁 restart-services.sh;收尾杀进程)。
- 前后对照:老代码+老 config vs 新代码+seeded rows+新 config,逐项目比:doc_flow 注入(4 开 2 关)、
  DAG enrollment(6 全 on)、flywheel work_kind(on)、其余 flag 默认、ponytail 全 OFF。
  已知显示差:pipeline_dag 5 项目 false→true(D3 诚实化,行为无差)。
- rg 验收串(issue 原文):
  `rg 'doc_flow\.enabled|pipeline\.dag|skills\.proofshot|ponytail\.enabled|skill_framework\.split|auto_create|checkpoints\.[a-z_]+\.enabled'`
  读点层(packages/*/src 非 registry/truth 名册数据、非测试 fixture)零命中。
- ConfigLoader:9 个残留 key 各一条报错测试。
