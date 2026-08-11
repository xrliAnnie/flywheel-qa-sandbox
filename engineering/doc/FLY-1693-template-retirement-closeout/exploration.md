# FLY-1693 模板退役收尾 — 探索

Issue: FLY-1693 (https://linear.app/geoforge3d/issue/FLY-1693/模板退役收尾12-个退役-摘出-bundled-seed-files-改两处默认值-删-yaml顺序不能反)
日期: 2026-08-11
基于: 无

## 1. 问题是什么

Annie 2026-08-11 拍板:workflow 模板 17 个里**退役 12 个、保留 5 个**。

- **保留 5**:`tpl_code` · `tpl_generic_menu` · `tpl_prd` · `tpl_design` · `tpl_prototype`(全部由 menu 系统从 `menus/shapes/*.yaml` 编译生成,FLY-1436 起是生产主力)
- **退役 12**:`tpl_eng_heavy` · `tpl_eng_light` · `tpl_eng_trivial` · `tpl_product_v1` · `tpl_eng_heavy_land_v1` · `tpl_eng_light_land_v1` · `tpl_eng_trivial_land_v1` · `tpl_eng` · `tpl_eng_land_v1` · `tpl_product_designer` · `tpl_product_prototype` · `tpl_generic`(全部是 `packages/teamlead/src/workflow-seeds/` 里的 bundled YAML,恰好一一对应)

她最初的指令是「直接删 12 个仓库文件」。Honey Lemon 核过后没有照做——直接删会当场炸(启动时逐个 `readFileSync`),并给出了四步顺序:① DB 打 `retired_at` ② 摘 `BUNDLED_SEED_FILES` ③ 改两处默认值 ④ 删 YAML。

本探索在四步基础上做了完整代码 + 生产库审计,确认了四步方向正确,同时发现了 issue 没写到的 **4 个缺口**,其中一个(隐藏第 0 步)不做的话第 1 步会当场被拒。

## 2. 审计发现的 4 个缺口(issue 原文没有覆盖)

### 缺口 A(🔴 关键):第 1 步之前还有隐藏的「第 0 步」——先解绑

`StateStore.retireWorkflowTemplate()`(`StateStore.ts:17009`)是**拒绝退役仍被绑定的模板**的:只要 `workflow_category_binding` 里还有行指向该模板,返回 `refused_bound`,一行都不会改。

生产库(`~/.flywheel/teamlead.db`,只读实查)ground truth:

- `flywheel` 项目:5 条 menu 绑定(code/prd/design/prototype/generic → 保留 5),✅ 不挡任何退役
- **`geoforge3d` / `growth` / `joycon-typeless` / `personal-assistant` / `tidal-echo` 各有一条 `*` → `tpl_eng_heavy_land_v1`**(owner `system:FLY-1434-land-migration`)——**这 5 条绑定会让 `tpl_eng_heavy_land_v1` 的退役被当场拒绝**

所以真实顺序是:**0)先处理指向退役名单的 system-owned 绑定(初稿 rebind,终稿 unbind,见 §4.2)→ 1)退役 → 2)摘数组 → 3)处置默认值 → 4)删 YAML**。

### 缺口 B:生产上根本没有「退役」的入口

`retireWorkflowTemplate` 目前**只有测试在调**——没有 Bridge 端点、没有 CLI、没有 boot 路径调它。第 1 步不是「执行一下退役」而是「先造一个退役的执行机制」。方案对比见 §4.1。

### 缺口 C:「两处默认值」里有一处是 dead export

- `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS`(`workflow-template.ts:1601`):**真实爆炸半径**。经 `ensureDefaultWorkflowBindings`(Bridge boot 时对 `~/.flywheel/projects.json` 里每个「一条绑定都没有」的项目播默认绑定)决定新项目的默认模板。处置见 §4.2:终选连播种机制一起删除,而非改指向。
- `DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID`(`workflow-template.ts:1599`):全仓 grep(含 tests、scripts、dist 消费方、package index)**零调用方**,也没被 re-export。它是一个纯 dead export。issue 说改成 `tpl_code`;审计结论是**删掉比改掉更诚实**(改完还是一行没人读的死代码)。这是对 issue 原文的一处显式偏离,交 design review 裁决。

另外还有一组和「默认值」绑死的代码 issue 没提:`migrateSystemWorkflowBindingsToLand` / `rollbackSystemWorkflowBindingsFromLand` / `ENGINEERING_LAND_BINDING_MIGRATION`(FLY-1434 的 boot 迁移,把 `tpl_eng_*` 系统绑定搬到 `*_land_v1`)。退役后这组迁移的**源和目标全部是退役模板**,永久 no-op;而且 `bindWorkflowCategory` 退役后会拒绝任何指向退役模板的写(`StateStore.ts:17086` 守卫),它连理论触发路径都没了。属于净删除对象。

### 缺口 D:删 YAML 会连坐 build 和 CI

- `packages/teamlead/package.json` build 脚本里有 `cp -r src/workflow-seeds dist/workflow-seeds` —— 目录删了 build 直接挂
- `.github/workflows/ci.yml:45` 跑 `pnpm verify:workflow-seeds` —— `scripts/verify-workflow-seeds.mjs` `readdirSync` 该目录,目录删了 CI 直接挂(该脚本同时校验 menu seeds,需要改造成只校验 menu seeds,不是删掉)
- 40+ 个测试文件引用 `loadBundledWorkflowSeeds` 等符号作 fixture(重灾区 `workflow-template.test.ts` 用 `loadBundledWorkflowSeeds()[0]` 当锚定 manifest)——需要迁到 `loadWorkflowMenuSeeds()` 或内联 fixture
- 4 个历史 QA 脚本(`qa-fly-1244/1281/1307/1425`)import 这些符号,不在 CI 里

## 3. 关键降险事实(生产库实查)

1. **非 flywheel 项目几乎零 engine run 历史**:`workflow_run` 里除 flywheel 外只有 tidal-echo 一条 legacy 空记录。那 5 条 `*` 绑定**从来没真正派过单**。第 0 步(解绑)的实际爆炸半径 = 「未来新单」,不是「在跑的单」——解绑后候选为 null,逐字走今天的 legacy 路径。
2. **图形状同构**:`tpl_code` 和 `tpl_eng_heavy_land_v1` 的节点图完全一致(design→implement→qa→founder_gate→land),`ship_claims` 一致。唯一 loops 差异:`tpl_eng_heavy(_land_v1)` 多一个 `founder_feedback` 返工环(founder_gate→implement),`tpl_code` 没有——这也是 issue 附录要求抄走存档的定义(补环是 Annie 已知的后续单,max_iterations 要调大)。
3. **tier 兼容**:`tpl_eng_heavy_land_v1` 和 `tpl_code` 都没有 `tier_presets`,今天的 dispatch 也没传 tier(否则现状就会 `TIER_NOT_SUPPORTED`)。
4. **在途 run 安全**:退役名单里只有 `tpl_eng_heavy` 有 9 个 `held` run(零 active)。run 恢复走 pinned snapshot(`recoverWorkflowStartSelection` 明确 candidate-free,不回读当前模板),退役不动在途。
5. **17 行全 ACTIVE**:生产 `workflow_template` 恰好 17 行(12+5),全部 `retired_at IS NULL`,和 issue 的账对得上。

## 4. 方案选择

### 4.1 退役机制:boot reconcile(选)vs 一次性手术脚本(弃)

**选:Bridge boot 时的幂等 reconcile**(新函数 `retireLegacyWorkflowTemplates(store)`,放在 `plugin.ts` menu seeds import 之后):

- Pass 1(解绑):扫全表 `workflow_category_binding`,凡指向退役 12 且 owner 是 system 族(`system:bundled-default` / `system:FLY-1434-land-migration` / `system:FLY-1434-land-rollback`)→ `unbindWorkflowCategory` 四字段 CAS(project/category/template_id/owner 全等才删)+ `unbind` audit;founder/自定义 owner 的绑定**绝不碰**,响亮打日志;CAS 漂移进结构化 `errors`。
- Pass 2(退役):对 12 个 id 逐个 `retireWorkflowTemplate`;`not_found`(全新库)/ `already_retired`(重启)静默通过;`refused_bound`(founder 绑定挡着)进结构化 `blocked`,响亮 warn 不 crash。
- 异常边界:业务结果进 `blocked`/`errors`(部署 gate 要求两者为空);未知存储错误不捕获,boot fail-closed。

理由:这是本仓绑定迁移的**现成模式**(FLY-1434/FLY-1244 的 boot 迁移即此);自部署(生产、529 QA 房、任何副本库一视同仁);幂等免运维;audit 表自动落 `unbind` + `template_retire` 账。弃一次性手术脚本(FLY-1648 模式):那套 backup/CAS/operator-gate 重仪式是为「改 run 台账」设计的,这里改的是配置层、且已有拒绝不安全操作的存储方法兜底,上重仪式是过度设计。

### 4.2 默认绑定与 5 条存量绑定:解绑 + 删除播种机制(选)vs rebind 到 tpl_code(弃,Codex R1 HIGH-1)

初稿选了「rebind 到 `tpl_code` + 默认改单条 `*`→tpl_code」。Codex design review R1 指出并经实查证实的致命事实:**保留 5 全是 menu 模板,节点带 `role`,materialize 时 `resolveMenuAgentFile`(`workflow-menu.ts:522`,经 `workflow-run-snapshot.ts:424`)强制读取目标项目的 `.flywheel/menus/ic-roster.yaml`——而 6 个项目里只有 flywheel 有该资产**(逐项目 ls 实查)。把没有 menu 资产的项目绑到 `tpl_code`,等于把「未来新单」从「走 legacy 路径」改成「确定 materialize 失败」。

**终选:解绑 + 删除播种。** 5 条 system 绑定直接 unbind(新增带 CAS 与 audit 的 `unbindWorkflowCategory`);`ensureDefaultWorkflowBindings` + `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS` 整体删除(不删播种机制的话,下一次 boot warm 又给零绑定项目播回来,自相矛盾)。无绑定 → 候选 null → **逐字走今天的 legacy 路径**,与这些项目的实际现状(engine run 历史 ≈ 0)一致。各项目未来接入 menu 体系是独立的 onboarding cutover,不属于本单。

### 4.3 摘数组的诚实做法:整套 bundled-seed 机器一起删(选)vs 留空数组(弃)

12 个全摘之后 `BUNDLED_SEED_FILES` 是空数组,`loadBundledWorkflowSeeds`/`importBundledWorkflowSeeds` 变成空转的死机器,build 还在拷空目录、CI 还在校验空目录——这正是 issue 里点名的「看起来修好了」形态。**选:函数、数组、plugin.ts 调用、build cp、目录一起删**,`verify-workflow-seeds.mjs` 改造成只校验 menu seeds(CI 项保留,改名与否交实现)。保留 5 的 seed 来源(`menus/shapes/*.yaml` → `importWorkflowMenuSeeds`)完全不受影响。

## 5. 有意不做的事(边界)

- **不给保留模板补 founder_feedback 返工环**——那是 Annie 已排期的后续单;本单只按 issue 要求把 loop 定义原样抄进 research.md 附录存档。
- **不动 FLY-1436 cutover 的 restore 面**(`workkind-cutover.ts`)——退役 `tpl_eng_heavy` 后 restore 会被 `RESTORE_TARGET_INVALID` 响亮拒绝,这是正确行为(baseline 已被 founder 判死),历史 claim 记录保持可审计。
- **不做 5 个项目的 menu onboarding**——解绑后它们走 legacy 路径(= 现状);接入 menu 体系是各项目未来的独立 cutover。
- **不删 DB 里的模板行和 revision 历史**——退役是打标记(`retired_at`),YAML 定义在 `workflow_template_revision.manifest` 里永久可读。

(初稿曾把「Lead 显式指定退役模板仍可派单」列为不堵的边界;Codex R1 裁定这破坏 closeout 语义——「已退役但仍可派新单」正是 issue 点名的「看起来修好了」形态。已改入 scope:所有 fresh 候选统一拒绝退役模板 + materialize 事务内复核,pinned/恢复路径不动。见 plan §2.1/§2.2。)
