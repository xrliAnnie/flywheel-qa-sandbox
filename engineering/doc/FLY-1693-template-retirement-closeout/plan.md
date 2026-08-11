# FLY-1693 模板退役收尾 — 实施计划

Issue: FLY-1693 (https://linear.app/geoforge3d/issue/FLY-1693/模板退役收尾12-个退役-摘出-bundled-seed-files-改两处默认值-删-yaml顺序不能反)
日期: 2026-08-11
基于: research.md(v2,含 Codex design review R1 修订)

## 0. 一句话

单 PR 原子完成:新增幂等 boot reconcile(先**解绑**指向退役名单的 5 条 system 绑定,再给 12 个模板打 `retired_at`),把「退役」升级为**所有 fresh dispatch 的硬边界**(候选解析 + materialize 事务双重拒绝),整体删除 bundled-seed 死机器、FLY-1434 land 迁移与**默认绑定播种机制**,最后删 12 个 YAML 并修好 build/CI 连坐——四步在一个部署单元里落地,不存在危险中间态。

## 0.1 相对 issue 原文的三处显式修正(均有审计证据,R1 已过 Codex)

| issue 原文 | 修正 | 理由 |
|---|---|---|
| 第 1 步之前无前置 | 补第 0 步:**unbind** 5 条 system 绑定 | `retireWorkflowTemplate` 对被绑定模板 `refused_bound`(research §2.2) |
| 第 3 步「三条默认绑定改指保留模板」 | **删除**默认播种机制(`ensureDefaultWorkflowBindings` + `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS`) | 保留 5 全是 menu 模板,其 role 解析强制读目标项目 `.flywheel/menus/ic-roster.yaml`(`workflow-menu.ts:522` → `workflow-run-snapshot.ts:424`);5 个受影响项目与未来新项目**都没有该资产**——绑上 `tpl_code` = 未来派单确定 materialize 失败。无绑定 → 候选为 null → **逐字走今天的 legacy 路径**(这些项目 engine run 历史 ≈ 0,legacy 正是它们的现状)。菜单 onboarding 是各项目未来的独立 cutover,不塞进本单 |
| 第 3 步「`DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID` 改成 tpl_code」 | **删除**该 dead export | 全仓零调用方、未 re-export;改完仍是死代码 |

## 1. 范围

**做**:issue 四步(按上表修正)+ 第 0 步 + **退役硬边界**(Codex R1 HIGH-2:非 enforced 显式选模板、binding 候选、materialize 事务三处都要拒退役模板)+ 连坐面(build cp / CI verify 脚本 / 测试 fixture / 历史 harness)。
**不做**:不补 founder_feedback 返工环(后续单;定义存档 research §5);不动 workkind-cutover restore 面;不做 5 个项目的 menu onboarding;不删 DB 行/revision 历史。

## 2. 改动清单(按文件)

### 2.1 `packages/teamlead/src/StateStore.ts`

**新增 `unbindWorkflowCategory`**(镜像 `bindWorkflowCategory` 的形状):

```ts
unbindWorkflowCategory(input: {
  project: string;
  taskCategory: string;
  expectedTemplateId: string;   // CAS:行已漂移则不删
  expectedUpdatedBy: string;    // CAS:owner 已变(founder 接管)则不删
  updatedBy: string;
}): { status: "removed" | "not_found" | "drifted" }
```

- 事务内:精确行匹配(project, task_category, template_id, updated_by 全等)→ DELETE + audit;否则 `not_found` / `drifted`(不动行)。
- **audit action 新增 `'unbind'`**:`workflow_template_audit` 的 CHECK 约束用既有 rebuild-migration 模式扩展(逐字复刻 `template_retire` 当年的迁移块,`StateStore.ts:4185-4226`),detail 记 `{project, task_category, removed_template_id, previous_owner}`。
- 该表 append-only 触发器不变(DELETE 的是 binding 表,不是 audit 表)。

**`materializeWorkflowRun` 写事务内补退役复核**(Codex R1 HIGH-2 的 TOCTOU 关闭):在既有 expected-selection CAS(`StateStore.ts:17764` 区域,现比 revision/digest/schema/binding)中增加 `current.retired_at === null` 检查,失败即事务回滚、抛与既有 CAS 一致的 selection-drift 错误。pinned-snapshot 恢复路径(`recoverWorkflowStartSelection`、rework/resume)**不经过**该函数的 fresh 分支,不受影响。

### 2.2 `packages/teamlead/src/workflow-template-selection.ts`

`resolveWorkflowTemplateCandidate`:**所有 fresh 候选统一拒绝退役模板**——

- 显式 `leadTemplateId`(不论 workKindEnforced):`template.retired_at != null` → 抛(enforced 分支保留既有 `WorkKindRouteError("TEMPLATE_NOT_FRESH_ELIGIBLE")` 合同;非 enforced 分支抛带模板 id 的明确错误)。
- binding 来源候选:同一检查(闭环防御——正常闭环后不该存在指向退役模板的绑定,但异常库/竞态窗口必须拒绝)。
- `recoverWorkflowStartSelection` 与一切 pinned-snapshot 路径保持 candidate-free,零改动。

### 2.3 `packages/teamlead/src/workflow-template.ts`

**新增**(约 +55 行):

```ts
export const RETIRED_BUNDLED_TEMPLATE_IDS = [ /* 12 个 id,见 research §1.1 */ ] as const;
const RETIREMENT_OWNER = "system:FLY-1693-retirement";
// 允许被本 reconcile 解绑的历史 system owner(字符串是 DB 数据,不是代码依赖)
const SYSTEM_BINDING_OWNERS = new Set([
  "system:bundled-default",
  "system:FLY-1434-land-migration",
  "system:FLY-1434-land-rollback",
]);

export function retireLegacyWorkflowTemplates(
  store: Pick<StateStore,
    "listWorkflowCategoryBindings" | "unbindWorkflowCategory" | "retireWorkflowTemplate">,
  log?: (message: string) => void,
): { unbound: number; retired: number; blocked: string[]; errors: string[] }
```

行为(异常策略按 Codex R1 M-3 写死):

1. **Pass 1 unbind**:`listWorkflowCategoryBindings()` 过滤 `template_id ∈ RETIRED_BUNDLED_TEMPLATE_IDS`:
   - owner ∈ `SYSTEM_BINDING_OWNERS` → `unbindWorkflowCategory`(CAS 带上实测 template_id/owner);`removed` 计数,`drifted`/`not_found` 记 `errors`(结构化,不是吞掉)
   - 其他 owner → log `preserved custom binding …`,该模板届时自然落入 Pass 2 的 `refused_bound`
2. **Pass 2 retire**:12 个 id 逐个 `retireWorkflowTemplate({actor: RETIREMENT_OWNER, reason: "FLY-1693 founder-approved template retirement"})`:
   - `retired` → 计数;`not_found`(fresh DB)/`already_retired`(重启幂等)→ 静默
   - `refused_bound` → refs 进 `blocked`(响亮 log,不 crash——founder 绑定挡路时 Bridge 必须照常起,留人工裁决)
3. **异常边界**:`refused_bound`/`drifted` 这类**业务结果**进 `blocked`/`errors`,boot 继续;`listWorkflowCategoryBindings`/`unbindWorkflowCategory`/`retireWorkflowTemplate` 抛出的**未知存储错误(DB/integrity/save)不捕获,向上抛,boot fail-closed**——退役没做完的 Bridge 不许装健康。
4. 部署 gate:boot 汇总行必须 `blocked=[] errors=[]`(见 §4)。

**修改/删除**(约 -190 行):

- 删 `BUNDLED_SEED_FILES` / `loadBundledWorkflowSeeds` / `importBundledWorkflowSeeds`
- 删 `DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID`(dead export)
- 删 `DEFAULT_ENGINEERING_WORKFLOW_BINDINGS` + `ensureDefaultWorkflowBindings`(§0.1 修正 2;唯一调用方在 plugin warm,一起删)
- 删 `ENGINEERING_LAND_BINDING_MIGRATION` / `migrateSystemEngineeringBindings` / `migrateSystemWorkflowBindingsToLand` / `rollbackSystemWorkflowBindingsFromLand` / `BUNDLED_DEFAULT_OWNER` / `LAND_MIGRATION_OWNER` / `LAND_ROLLBACK_OWNER` 常量(owner 字符串以字面量留在 `SYSTEM_BINDING_OWNERS`)

### 2.4 `packages/teamlead/src/bridge/plugin.ts`

- 删 `importBundledWorkflowSeeds(store)`(4066)及 import
- `importWorkflowMenuSeeds(store)` 之后插入 `retireLegacyWorkflowTemplates(store)` + 汇总 log(unbound/retired/blocked/errors)。位置保持在 menu import 后(unbind/retire 本身不依赖 menu seeds,但统一「seeds 就绪 → reconcile」的 boot 叙事)
- warm 回调(4304–4311):删 `ensureDefaultWorkflowBindings` 与 `migrateSystemWorkflowBindingsToLand` 两个调用(warm 只剩 config cache 预热)

### 2.5 `packages/teamlead/src/workflow-seeds/`(整目录删除,12 个 YAML)

### 2.6 `packages/teamlead/package.json`

- build 脚本保留 `rm -rf dist/static dist/workflow-seeds`,只删 `cp -r src/workflow-seeds dist/workflow-seeds`(`dist/static` 拷贝保留)——增量 build 也必须清掉旧 `dist/workflow-seeds`,不让前一个 artifact 的 12 个 YAML 混进新部署包

### 2.7 `scripts/verify-workflow-seeds.mjs`

- 改造成只校验 menu seeds(`loadWorkflowMenuSeeds()` 全量 + snapshot/gate-authority 检查),删 bundled 分支。根 `package.json` 的 `verify:workflow-seeds` 与 `.github/workflows/ci.yml:45` 不动

### 2.8 历史 harness(不在 CI;Codex R1 M-4 + R2 M-3 修订)

- 9 个可执行历史 harness(`scripts/qa-fly-1244-os-proof.mjs` / `qa-fly-1281…` / `qa-fly-1307…` / `qa-fly-1425…` + `engineering/doc/**` 下 5 个引用相关符号的 `.mjs`):**整个可执行 body 替换为最小 stub** —— shebang + stderr 打印 retired 原因(`RETIRED by FLY-1693: bundled workflow seeds removed; see engineering/doc/FLY-1693-template-retirement-closeout/`)+ `process.exit(1)`,**不保留任何旧 import/旧符号**(只加 header 不行:ESM 会在 top-level `process.exit` 前解析静态 import,用户看到的会是 module-load failure 而不是 retired 说明)。纯 Markdown 历史引用原样保留。
- **postcondition(可照抄的精确命令,零豁免;Codex R3 M-2:限定源码/可执行扩展,不误伤历史 `.txt` 证据——`engineering/doc/FLY-1432-*/evidence/*.txt` 两份保留原样)**:
  ```bash
  rg -l "loadBundledWorkflowSeeds|importBundledWorkflowSeeds|BUNDLED_SEED_FILES|DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID|DEFAULT_ENGINEERING_WORKFLOW_BINDINGS|ensureDefaultWorkflowBindings|migrateSystemWorkflowBindingsToLand|rollbackSystemWorkflowBindingsFromLand|ENGINEERING_LAND_BINDING_MIGRATION" \
    packages scripts engineering/doc \
    -g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs' -g '*.cjs' -g '*.sh'
  ```
  必须**零命中**(rollback 脚本 §2.10 用参数/SQL 字面量,不引用这些符号,天然满足)。实施后原样跑一次并把「零命中」写进验收。

### 2.9 测试迁移(Codex R1 M-4 的 fixture 策略)

- **新增 test-only legacy manifest factory**(`__tests__/fixtures/legacy-workflow-manifests.ts`):内联提供 schema-v1 heavy 形态与 `tpl_generic` no-code 形态的 manifest 构造器,供**继续存在的运行时兼容面**的测试使用——pinned `tpl_generic` no-code 兼容(`StateStore.ts:26782`)、legacy engineering ship-ready(`StateStore.ts:31318`)、held/pinned run 恢复、rework。这些覆盖**不许**随 seed 删除而消失。
- 只在「测 current shipped seeds」的用例里把 `loadBundledWorkflowSeeds()` 换成 `loadWorkflowMenuSeeds()`;断言语义有任何变化在 PR 里逐条点名。
- land-migration / ensureDefault 专属测试随符号删除。

### 2.10 `scripts/fly-1693-rollback-retirement.mjs`(checked-in 可执行回滚;Codex R3 HIGH-1)

回滚不再是伪代码,而是随 PR 入库的脚本(复用 teamlead 的 better-sqlite3 依赖,模式对齐 FLY-1648 手术脚本):

- **输入**:`--db <path>`(默认生产 teamlead.db)+ **必填** `--after-audit-id <n>`(部署验证时记录的 pre-deploy audit high-water mark,见 §4.1)或 `--audit-ids <csv>`(显式 source unbind audit ids)——消除「rollback 后再部署再 rollback」时按 actor 匹配的含糊。
- **source audit provenance(fail-closed;Codex R4 HIGH-1)**:selector 选出的**每一行**必须同时满足——id 存在且唯一;`action='unbind'`;`actor='system:FLY-1693-retirement'`;`template_id === detail.removed_template_id` 且 ∈ 退役 12;`detail.previous_owner ∈ SYSTEM_BINDING_OWNERS`;project/category/detail 字段全部合法。任何一行不满足(选错 id、外来 actor 的 unbind、malformed detail)→ 整体拒绝,**不得**把它转成 restore authority。
- **打开/依赖合同(Codex R4 M-2,对齐 FLY-1648 与 `StateStore.openForMaintenance`)**:apply 以 `fileMustExist: true` 打开,只设 connection-local `busy_timeout` + `foreign_keys=ON`,绝不 migrate/DDL/改持久 pragma(裸 `new Database(path)` 会在错误路径创建空库,禁止)。TDD 实证 WAL 模式下即使原库以 `{readonly: true, fileMustExist: true}` 打开也可能改动原 `.shm` read marks;因此 dry-run 先验证原库存在,再将 main/WAL/SHM 按存在态 byte-copy 到临时 snapshot,仅对 snapshot 用 `{readonly: true, fileMustExist: true}` 打开,结束后清理临时目录;这样原三个文件前后字节不变。better-sqlite3 是 `packages/teamlead` 的私有依赖(root 无声明),脚本用 anchored `createRequire(packages/teamlead/package.json)` 解析,不吃 workspace hoist 运气。
- **默认 dry-run**:打印 preflight 三量(retired_n / 匹配的 unbind audit 行 / current bindings 逐行 absent/equal/different)与将执行的完整语句;物理零写(含不产生 WAL/SHM 副作用)。
- **apply 唯一规范序列**(单连接,Codex R4 HIGH-1 钉死):`BEGIN IMMEDIATE` 取得写锁后,**在同一事务内**查询并验证全部 source audit rows(上述 provenance)→ 构造 expected set(拒绝重复 (project,category) 互相冲突的期望)→ 重读 current bindings 判 absent/equal/different(different → 抛)→ 冻结 `to_restore` → **然后才允许第一条 mutation**:①清 12 个 id 的 `retired_at` ②对 `to_restore` 逐行 INSERT binding ③逐行 INSERT `rebind` audit(actor `system:FLY-1693-rollback`,detail 含 source unbind audit id + reason)→ COMMIT。任何异常由事务 wrapper 自动整体 ROLLBACK + 非零退出,零残留。validation 逻辑在 JS 层实现(不依赖只在 trigger 内合法的 sqlite `RAISE()`),但**全部发生在写锁内**——dry-run 与 apply 之间、validation 与首条 mutation 之间不存在 TOCTOU 窗口。
- **脚本级测试**(进 §3 测试 11):absent / equal(幂等跳过)/ different(整体拒绝零写入)三形态 × unbind-only / retire-only / mixed 三部分态;二次执行幂等;rollback→redeploy→再 rollback(显式 audit ids 消歧);provenance 反例(foreign action/actor、missing id、malformed/mismatched detail)全部整体拒绝;双连接 interleaving(第二个 writer 在 `BEGIN IMMEDIATE` 后只能等待/`SQLITE_BUSY`,不能插在 validation 与 mutation 之间提交);missing/typo db path 不创建文件;dry-run 前后主库与既有 WAL/SHM 字节态不变;从 repo root 真跑一次 CLI 证明依赖解析。

## 3. TDD 计划(RED → GREEN)

新 suite `workflow-template.retirement.test.ts` + StateStore/selection 增量:

1. **unbind+retire 主线**:seed menu 5 + 内联 seed 12,造 5 条 land 绑定(system owner)→ reconcile → 绑定行**删除**、12 行 `retired_at NOT NULL`、audit 恰 5 `unbind` + 12 `template_retire`
2. **founder 绑定保护**:一条 owner=`founder:annie` 的绑定 → 原样保留、该模板进 `blocked`、其余 11 照退、不抛
3. **幂等**:连跑两遍,第二遍 unbound=0/retired=0/audit 零新增
4. **fresh DB**:只 seed menu 5 → 全 `not_found` 静默、零 audit
5. **CAS 防御**:unbind 前行被并发改走(template_id 或 owner 漂移)→ `drifted` 进 errors、行不动
6. **异常边界**:store 方法抛未知错误 → reconcile 向上抛(boot fail-closed 锚)
7. **退役硬边界四连**(Codex R1 HIGH-2 指定):
   a. 非 enforced 项目显式 `leadTemplateId` = 退役模板 → 拒绝
   b. 异常库中 binding 仍指向退役模板 → binding 候选拒绝
   c. candidate 读取后、materialize 事务前发生 retirement(测试内直接对 store 打 `retired_at` 模拟竞态)→ 事务 CAS 拒绝
   d. 既有 held/pinned snapshot run 恢复、rework 照常(candidate-free 回归锚)
8. **legacy 兼容面回归**:legacy manifest factory 驱动的 `tpl_generic` no-code 兼容与 legacy ship-ready 测试全绿(证明覆盖没有随 fixture 迁移丢失)
9. **无绑定 → legacy 路径**:5 项目形态(无绑定)下 `resolveWorkflowTemplateSelection` 返回 null(逐字 legacy fallback 锚)
10. **`'unbind'` audit CHECK rebuild 迁移锁定**(Codex R2 M-2;生产真实起点 ≠ 既有 `template_retire` 迁移测试的更老 fixture):
    - 起始 schema:CHECK **含 `template_retire`、不含 `unbind`**,预置若干历史 audit 行
    - reopen 后:CHECK 同时含两者;旧行 id/at/actor/action/detail 逐字原样;`_no_update`/`_no_delete`/`_no_replace` 触发器与 `idx_workflow_template_audit_template` 索引重建;AUTOINCREMENT 继续递增;`unbind` 行可写
    - **第二次 reopen 不再 rebuild**(`sqlite_master` rootpage / row count 不变)——实现以 `unbind` 作为最新 sentinel 判断分支,避免拿同一份旧 `sqlite_master.sql` 连跑两次 rebuild
    - 该 case 同时接替被 stub 化的历史 migration harness(`qa-migration-control` 类)承担的旧库升级覆盖
11. **rollback 脚本测试**(§2.10 完整矩阵):absent/equal/different × unbind-only/retire-only/mixed;different 分支零写入整体拒绝;二次执行幂等;显式 audit-ids 消歧 rollback→redeploy;provenance 反例(foreign action/actor、missing id、malformed/mismatched detail)整体拒绝;双连接 interleaving(`BEGIN IMMEDIATE` 后第二 writer 只能等待/`SQLITE_BUSY`);missing/typo db path 不创建文件;dry-run 前后主库+WAL/SHM 字节态不变;repo root 真跑 CLI 验依赖解析

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `pnpm verify:workflow-seeds` + §2.8 postcondition。

## 4. 部署与验证(implement/qa 节点执行)

1. merge 后、重启前:**记录 pre-deploy audit high-water mark**(`SELECT MAX(id) FROM workflow_template_audit`,只读)写进 ops note/PR——这是 §2.10 rollback 脚本 `--after-audit-id` 的输入
2. Bridge 重启(self-ship 纪律)
3. **生产验证清单**(只读 sqlite):
   - `workflow_template`:12 行 `retired_at NOT NULL`,5 行保留 ACTIVE
   - `workflow_category_binding`:恰 5 行(flywheel menu 绑定逐字不变);geoforge3d/growth/joycon-typeless/personal-assistant/tidal-echo **零行**
   - `workflow_template_audit` 尾部:5 `unbind` + 12 `template_retire`
   - Bridge boot log 汇总行:`unbound=5 retired=12 blocked=[] errors=[]`(**gate:非空即部署失败,走回滚**)
4. 行为冒烟:flywheel 正常派一单 tpl_code;显式指定 `tpl_eng_heavy` 的请求被拒(硬边界实证);再次重启验幂等(audit 零新增)
5. QA 节点(独立):529 房 fresh-DB 路径 + 生产库副本 reconcile 彩排(VACUUM INTO 快照,复用 memory 配方);副本上验证 §4.3 全部断言后才许生产重启;rollback 脚本(§2.10)也在副本上实跑一遍 apply+re-deploy

## 5. 回滚(founder-gated;执行体 = §2.10 checked-in 脚本,Codex R1 M-5 + R2 HIGH-1 + R3 HIGH-1 收敛)

代码 revert 不会自动恢复 DB(`importWorkflowTemplateSeed` 不清 `retired_at`)。核心纪律:**回滚与前向同等 authority-safe——绝不覆盖部署后新出现的 founder/custom 绑定;audit 由回滚事务自己显式写,不依赖旧 binary 补账**(旧 `ensureDefaultWorkflowBindings` 见到任一绑定即跳过、旧 to-land 迁移只认 non-land 源——两者都不会为 raw restore 补 audit)。所有 preflight/CAS/事务/审计语义都固化在 `scripts/fly-1693-rollback-retirement.mjs`(§2.10)里并有脚本级测试(§3 测试 11),不留人工 SQL 判断。

操作序列:

1. **停写入者**:停 Bridge(launchd bootout,按 bridge-ship-discipline:先改 KeepAlive 配置再杀)
2. **dry-run**:`node scripts/fly-1693-rollback-retirement.mjs --after-audit-id <部署时记录的 high-water mark,§4.1>` → 人工核对 preflight 三量(retired_n∈[0,12],unbind audit 行,current bindings 逐行 absent/equal/different 判定)与将执行语句
3. **apply**:同命令 + `--apply`。脚本单连接 `BEGIN IMMEDIATE`,mutation 前完成全部校验(期望集冲突、异值 binding → 非零退出零写入);同事务清 `retired_at` + 恢复缺失绑定 + 逐行写 `system:FLY-1693-rollback` `rebind` audit;COMMIT
4. **回退 binary**:revert PR / checkout 旧 SHA → build → 重启 Bridge(旧 binary 的 `importBundledWorkflowSeeds` 需要 seed YAML 在位,revert 已恢复)
5. **后置断言**(只读):12 行全 ACTIVE;绑定与期望恢复态逐行相等(different 分支触发时 = 人工裁决清单);旧 binary boot 成功且 `verify:workflow-seeds` 绿;audit 尾部 rollback rebind 行数 = 实际恢复行数
6. 部分完成态矩阵(unbind-only / retire-only / mixed)与二次执行幂等均由脚本测试矩阵锚定(§2.10/§3.11)

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 解绑后 5 项目「拿不到模板」 | 这是**现状保持**:候选 null → 逐字 legacy 路径;这些项目 engine run 历史 ≈ 0(research §1.3)。menu onboarding 是未来独立 cutover |
| 退役硬边界误伤在途 | 恢复/rework 全部 candidate-free(pinned snapshot);测试 7d 锚定 |
| reconcile 在坏库上装健康 | 未知错误 fail-closed 向上抛;业务阻挡进结构化 blocked/errors + 部署 gate 非空即回滚 |
| 删错东西 | research §2/§3 逐符号零调用方证据 + §2.8 postcondition + design review 把关 |
| 回滚不可执行 | 执行体 = checked-in 脚本(§2.10)+ 脚本级测试矩阵,dry-run 默认、apply 单事务 fail-closed,覆盖部分完成态与 redeploy 消歧 |

## 7. 提交序列(单 PR)

1. `test: retirement reconcile + retired hard-boundary suites (RED)`
2. `feat: unbindWorkflowCategory + audit 'unbind' migration; retired_at hard boundary (candidate + materialize CAS)`
3. `feat: retireLegacyWorkflowTemplates boot reconcile; drop default-binding seeding + land migration + dead export`
4. `chore: remove bundled seed machinery + 12 seed YAMLs; rework verify script; legacy manifest fixture factory; retire historical harnesses`
5. `docs: FLY-1693 design docs + milestone`(CLAUDE.md 里程碑按惯例作为 PR 最后 commit)
