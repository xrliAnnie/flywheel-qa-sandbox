# FLY-1693 模板退役收尾 — 调研

Issue: FLY-1693 (https://linear.app/geoforge3d/issue/FLY-1693/模板退役收尾12-个退役-摘出-bundled-seed-files-改两处默认值-删-yaml顺序不能反)
日期: 2026-08-11
基于: exploration.md

本文是全部触点的逐文件证据台账。生产库数据均来自 `sqlite3 "file:~/.flywheel/teamlead.db?mode=ro"` 只读实查(2026-08-11,Bridge 在线,WAL 并发读)。

## 1. 生产库 ground truth

### 1.1 `workflow_template`(17 行,全部 ACTIVE)

| template_id | scope | published rev | retired_at | 处置 |
|---|---|---|---|---|
| tpl_code | global | 4 | NULL | **保留** |
| tpl_generic_menu | global | 4 | NULL | **保留** |
| tpl_prd | global | 4 | NULL | **保留** |
| tpl_design | global | 4 | NULL | **保留** |
| tpl_prototype | global | 4 | NULL | **保留** |
| tpl_eng_heavy | global | 5 | NULL | 退役 |
| tpl_eng_light | global | 4 | NULL | 退役 |
| tpl_eng_trivial | global | 2 | NULL | 退役 |
| tpl_eng_heavy_land_v1 | global | 4 | NULL | 退役(**被 5 项目绑定**) |
| tpl_eng_light_land_v1 | global | 3 | NULL | 退役 |
| tpl_eng_trivial_land_v1 | global | 1 | NULL | 退役 |
| tpl_eng | global | 5 | NULL | 退役 |
| tpl_eng_land_v1 | global | 4 | NULL | 退役 |
| tpl_product_v1 | global | 2 | NULL | 退役 |
| tpl_product_designer | global | 2 | NULL | 退役 |
| tpl_product_prototype | global | 3 | NULL | 退役 |
| tpl_generic | global | 3 | NULL | 退役 |

### 1.2 `workflow_category_binding`(10 行)

| project | task_category | template_id | updated_by |
|---|---|---|---|
| flywheel | code | tpl_code | system:fly-1436-cutover |
| flywheel | prd | tpl_prd | system:fly-1436-cutover |
| flywheel | design | tpl_design | system:fly-1436-cutover |
| flywheel | prototype | tpl_prototype | system:fly-1436-cutover |
| flywheel | generic | tpl_generic_menu | system:fly-1436-cutover |
| geoforge3d | * | **tpl_eng_heavy_land_v1** | system:FLY-1434-land-migration |
| growth | * | **tpl_eng_heavy_land_v1** | system:FLY-1434-land-migration |
| joycon-typeless | * | **tpl_eng_heavy_land_v1** | system:FLY-1434-land-migration |
| personal-assistant | * | **tpl_eng_heavy_land_v1** | system:FLY-1434-land-migration |
| tidal-echo | * | **tpl_eng_heavy_land_v1** | system:FLY-1434-land-migration |

加粗 5 行是退役的唯一阻挡(`retireWorkflowTemplate` → `refused_bound`)。全部 system owner,无 founder 自定义绑定。

### 1.3 `workflow_run` 对退役 12 的引用

- **active:0**。held:仅 `tpl_eng_heavy` ×9。其余状态(terminated/canceled/completed)只是历史。
- 非 flywheel 项目的 engine run 历史 ≈ 0(仅 tidal-echo 一条 legacy 空记录:task_category、template_id 均空)。**5 条 `*` 绑定从未真正派过单。**

### 1.4 保留 5 vs 退役核心模板的 manifest 差异

节点图(id:type)**完全同构**:`design:design → implement:implement → qa:qa → founder_gate:gate → land:land`(tpl_code vs tpl_eng_heavy_land_v1 实查)。`ship_claims` 一致(`["qa_passed","founder_approved"]`)。

loops 差异(唯一实质差异):

| template | qa_retry(qa→implement) | founder_feedback(founder_gate→implement) |
|---|---|---|
| tpl_code | ✅ | **❌ 无** |
| tpl_eng_heavy | ✅ | ✅ |
| tpl_eng_heavy_land_v1 | ✅ | ✅ |

tier_presets:`tpl_code`、`tpl_eng_heavy(_land_v1)`、`tpl_eng_light/trivial(_land_v1)` 都**没有**;只有 `tpl_eng` / `tpl_eng_land_v1` 有(两个都在退役名单)。生产 dispatch 未传 tier(否则现状即抛 `TIER_NOT_SUPPORTED`)。

### 1.5 menu 模板的项目侧资产依赖(Codex R1 HIGH-1 实查)

保留 5 是 schema-v2 menu 模板,`design/implement/qa` 等节点携带 `role`;materialize 时 `buildWorkflowRunSnapshotV2` 对每个 role 调 `resolveMenuAgentFile(canonicalRoot, role)`(`workflow-run-snapshot.ts:424-429`),后者**强制读取目标项目的 `.flywheel/menus/ic-roster.yaml`**(`workflow-menu.ts:522-535`,缺文件/缺 role 即抛)。逐项目实查 `.flywheel/menus/` 存在性:

| project | projectRoot | `.flywheel/menus/` |
|---|---|---|
| flywheel | ~/Dev/flywheel | ✅ |
| geoforge3d | ~/Dev/GeoForge3D | ❌ |
| joycon-typeless | ~/Dev/joycon-typeless | ❌ |
| personal-assistant | ~/Dev/personal-assistant | ❌ |
| growth | ~/Dev/growth | ❌ |
| tidal-echo | ~/Dev/tidal-echo | ❌ |

⇒ 把这 5 个项目 rebind 到 `tpl_code` = 未来新单从「走 legacy 路径」变成「确定 materialize 失败」。这是初稿方案(rebind)被推翻、终稿改为 unbind + 删除播种机制的决定性证据。

### 1.6 运行时仍在依赖旧模板 id 的兼容面(fixture 策略依据)

- `StateStore.ts:26782-26783`:pinned `tpl_generic` no-code 兼容分支(按 snapshot.template.id 判断)
- `StateStore.ts:31318-31322`:legacy engineering ship-ready 分支

这两处服务的是**已 pin 的历史 run**(含 9 个 held tpl_eng_heavy),不依赖 seed 文件,退役后必须继续被测试覆盖 —— 所以测试 fixture 不能一刀切换成 menu seeds,要建 test-only legacy manifest factory(plan §2.9)。

## 2. 代码触点台账

### 2.1 `packages/teamlead/src/workflow-template.ts`

| 符号 | 行 | 现状 | 处置 |
|---|---|---|---|
| `BUNDLED_SEED_FILES` | 1547 | 12 个文件名,恰好 = 退役名单 | 连同下两个函数整体删除 |
| `loadBundledWorkflowSeeds()` | 1564 | boot 逐个 `readFileSync`,文件缺失即抛 | 删除 |
| `importBundledWorkflowSeeds()` | 1589 | 唯一生产调用 `plugin.ts:4066` | 删除(含调用点) |
| `DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID` | 1599 | `"tpl_eng_heavy"`;全仓零调用方、未被 re-export(**dead export**) | 删除(issue 原文说改成 tpl_code;见 exploration §2 缺口 C) |
| `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS` | 1601 | 3 条,全指退役模板;消费方 `ensureDefaultWorkflowBindings` | 删除(§1.5:menu 模板不能当无条件默认) |
| `ENGINEERING_LAND_BINDING_MIGRATION` | 1607 | FLY-1434 迁移表,源+目标全是退役模板 | 删除 |
| `ensureDefaultWorkflowBindings()` | 1634 | boot warm 给零绑定项目播默认 | 删除(不删的话,unbind 后下一次 warm 又把绑定播回来) |
| `migrateSystemEngineeringBindings()` + `migrateSystemWorkflowBindingsToLand()` + `rollbackSystemWorkflowBindingsFromLand()` | 1657–1747 | to_land 有 `plugin.ts:4308` 调用;rollback 零生产调用方 | 三个全删(见 §3 安全性论证) |

### 2.2 `packages/teamlead/src/StateStore.ts`

| 符号 | 行 | 与本单的关系 |
|---|---|---|
| `retireWorkflowTemplate()` | 17009 | 只读复用。事务内:有绑定 → `refused_bound`;已退役 → `already_retired`;不存在 → `not_found`;成功 → 打 `retired_at` + `template_retire` audit。**生产目前零调用方** |
| `bindWorkflowCategory()` | 17074 | 只读复用。校验目标「已发布 + 未退役 + scope 允许」→ upsert + `rebind` audit。**退役后没人能再绑回退役模板**(17086 守卫) |
| `getWorkflowCategoryBinding()` | 17126 | 只读复用。精确 category 优先,否则回落 `*` |
| `workflow_template.retired_at` 列 + `template_retire` audit action | 4085/4176 | schema 早已就位(含旧库 ALTER 迁移) |
| **新增** `unbindWorkflowCategory()` | — | CAS 精确行匹配(project/category/template_id/owner 全等)→ DELETE + `unbind` audit;audit CHECK 约束用既有 rebuild-migration 模式(4185-4226 的 `template_retire` 块)扩展 |
| **修改** `materializeWorkflowRun()` 写事务 | ~17764 | expected-selection CAS 增加 `retired_at IS NULL` 复核(关 TOCTOU,Codex R1 HIGH-2) |

### 2.3 `packages/teamlead/src/bridge/plugin.ts`

| 行 | 现状 | 处置 |
|---|---|---|
| 4066 | `importBundledWorkflowSeeds(store)` | 删除;menu seeds import 之后插入新 boot reconcile `retireLegacyWorkflowTemplates(store)` |
| 4067 | `importWorkflowMenuSeeds(store)` | 保留(保留 5 的 seed 来源;unbind 方案下 reconcile 不再依赖它,位置保持只为统一「seeds 就绪 → reconcile」叙事) |
| 4304–4311 | warm 回调:`ensureDefaultWorkflowBindings` + `migrateSystemWorkflowBindingsToLand` | 两个调用都删除(warm 只剩 config cache 预热) |

### 2.4 选择/恢复路径

- `workflow-template-selection.ts:59-116`:现状 `retired_at` 只在 `workKindEnforced && leadTemplateId` 分支检查(fresh-eligible)——非 enforced 项目 Lead 显式指定退役模板仍可派。**本单改动**(Codex R1 HIGH-2):所有 fresh 候选(显式 + binding 来源)统一拒绝退役模板;enforced 分支保留既有 `WorkKindRouteError("TEMPLATE_NOT_FRESH_ELIGIBLE")` 合同。
- `recoverWorkflowStartSelection`(同文件 479):**candidate-free**,只读 pinned snapshot —— 9 个 held `tpl_eng_heavy` run 的恢复/rework 不受退役影响。零改动。
- `workkind-cutover.ts`:`FLY1436_BASELINE_BINDINGS` 引用 `tpl_eng_heavy`;退役后 restore 被 `validTargetTemplates` 判 `RESTORE_TARGET_INVALID`(响亮拒绝)。不改,如实记边界。

### 2.5 build / CI / 脚本 / 测试

| 位置 | 现状 | 处置 |
|---|---|---|
| `packages/teamlead/package.json` build | `cp -r src/workflow-seeds dist/workflow-seeds` | 删除该段(目录没了 build 会挂) |
| `.github/workflows/ci.yml:45` + 根 `package.json:18` | `pnpm verify:workflow-seeds` → `scripts/verify-workflow-seeds.mjs` `readdirSync(workflow-seeds)` | 脚本改造成只校验 menu seeds(`loadWorkflowMenuSeeds`),CI 项保留 |
| `scripts/qa-fly-1244-os-proof.mjs` / `qa-fly-1281…` / `qa-fly-1307…` / `qa-fly-1425…` | import 被删符号;不在 CI | 显式 retired 声明 + `process.exit(1)`,绝不 exit-0 假绿(plan §2.8) |
| `engineering/doc/**` 下 5 个引用相关符号的 `.mjs` 历史 harness | 可执行文件 | 同上处理;纯 Markdown 历史引用原样保留 |
| `scripts/__tests__/workkind-cutover.test.mjs` | 引用 tpl_eng_heavy(cutover 合同) | 按不变(cutover 面不动) |
| 37 个 package `__tests__` 文件 | 引用 `loadBundledWorkflowSeeds` 等作 fixture(重灾区 `workflow-template.test.ts` 以 `loadBundledWorkflowSeeds()[0]` 为锚) | 只在「测 current shipped seeds」处迁 `loadWorkflowMenuSeeds()`;§1.6 的 legacy 兼容面覆盖迁 test-only legacy manifest factory;land-migration/ensureDefault 专属测试随符号删除 |
| `packages/teamlead/src/workflow-menu.ts` | `MENU_SOURCE_DIRECTORY` = 仓库根 `menus/shapes/*.yaml`(5 个 shape 文件都在) | 不动 —— 与 workflow-seeds 目录无关 |

## 3. 「删掉 land 迁移」安全性论证

删除 `migrateSystemWorkflowBindingsToLand` 一族之所以安全:

1. 触发条件是存在 system-owned `*/light/trivial` → `tpl_eng_*`(非 land)绑定。生产实查:不存在(5 条全已是 land_v1,本单 reconcile 还会把它们解绑)。
2. 即便未来有人想手工绑回 `tpl_eng_heavy`:`bindWorkflowCategory` 的「未退役」守卫直接拒绝 —— 迁移的输入态从结构上不可再现。
3. 反向论证(留着的坏处):如果保留迁移且某库真出现输入态,迁移会调 `bindWorkflowCategory(target = tpl_eng_heavy_land_v1)`,目标已退役 → **boot 抛异常,Bridge 起不来**。留着不是中性,是隐性 boot 炸弹。

## 4. 部署语义

- 单 PR 原子落地(四步不可拆 PR,这正是 issue「顺序不能反”在单仓下的正确形态:不存在「删了 YAML 但代码还在读」的中间提交)。
- 生效 = merge 后 Bridge 重启(self-ship 流程)。boot 顺序:`importWorkflowMenuSeeds` → `retireLegacyWorkflowTemplates`(unbind pass → retire pass)→ warm(只剩 config cache 预热)。
- 全新库(529 QA 房 / 新装机):12 个模板从未 seed → reconcile 全部 `not_found` 静默;menu seeds 正常播;新项目**不再播默认绑定**(无绑定 → 候选 null → legacy 路径)。
- 二次重启:`already_retired` + unbind 无输入 → 全程 no-op(幂等)。

## 5. 附录:founder_feedback 返工环定义存档(issue 要求原样抄走)

来源:生产库 `tpl_eng_heavy` rev 5 / `tpl_eng_heavy_land_v1` rev 4 的 manifest(两者逐字一致):

```yaml
id: founder_feedback
from: founder_gate
to: implement                     # 各模板终点不同,见下
loop_when: founder_feedback_kickback
exit_when: founder_approved
max_iterations: 3                 # Annie:3 太少,后续补环时要调大
on_limit: escalate                # 到限升级给人,不自动放行
```

后续给保留模板补环时的 kickback 终点(issue 原文):`tpl_code→implement` · `tpl_generic_menu→execute` · `tpl_prd/design/prototype→produce`。

(退役只打标记,定义在 `workflow_template_revision.manifest` 里永久可查;此份存档是快捷索引。)
