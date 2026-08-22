# FLY-1778 动态 flag store 重做 — 调研

Issue: FLY-1778 (https://linear.app/geoforge3d/issue/FLY-1778/flag治理地基第3批-动态-flag-store-重做-值存-sqlite-read-on-use-产出-value-last)
日期: 2026-08-21
基于: exploration.md

---

## 1. 落点技术事实(全部实测,非转述)

### 1.1 StateStore(teamlead.db)引擎与 migration 模式

- 引擎:**better-sqlite3 ^12.8.0**(`packages/teamlead/package.json`),FLY-663 起替换 sql.js WASM,保留 sql.js 形状兼容 shim(`StateStore.ts:220–330`);WAL + `synchronous=NORMAL` + `busy_timeout=5000`;`save()`/`flush()` 均为 no-op(WAL 下每次 run 即 durable)。
- 原生句柄 `this.db.raw`(可拿 `prepare`/`transaction`/`pragma`)。
- migration 模式:无版本号表,`migrate()`(`StateStore.ts:2710`)里幂等 DDL 顺序执行。最贴近本单的样本是 FLY-1781 刚加的 `migrateFlagRetirementScan()`(L4439):`CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` + `addColumnIfMissing()`(L2071,`PRAGMA table_info` 探列后幂等 `ALTER TABLE ADD COLUMN`)。**本单照抄此形态,新增 `migrateFlagValueStore()`。**
- 跨进程只读范式已存在:`flywheel-comm` 的 `ship-eligibility.ts:252` 等用 `readonly: true, fileMustExist: true` 开 teamlead.db,路径来自 `FLYWHEEL_STATE_DB_PATH`。v1 用不上(纳管人口读点全在 Bridge 进程内),但证明「将来要跨进程 reader 时不缺先例」。

### 1.2 既有翻转链的精确形态(本单在其上做加法)

| 环节 | 文件 | 事实 |
|---|---|---|
| 准入判据(单点) | `packages/config/src/feature-flags/direct-toggle.ts:31` | `isDirectToggleMetadata`:env ∧ bridge_global ∧ (bool ∨ 非空 enum) ∧ direct ∧ 非 governance_gate ∧ !dormant ∧ 全 timing ∈ {call_time, dotenv_live} |
| 路由(stage/apply) | `packages/teamlead/src/bridge/flag-routes.ts`,挂载 `plugin.ts:2281/2294`(`POST /api/fleet/flag/stage`、`/apply`) | server 算 canonical(rawFrom/rawTo/fileSha),SHA 绑定单次 confirmToken;**挂载在 Bearer 中间件之前,鉴权 = loopback + same-origin(CLI 与 console 同为本机同源调用方,server 无法区分二者——Codex R2#5 实核,早稿「Bearer=CLI」不成立)** |
| apply 核 | `packages/teamlead/src/bridge/flag-toggle.ts:87` | `.env` 文件锁 → 重校 fileSha + live rawFrom(否则 409)→ 原子写 `.env`(persist-first)→ 改 `process.env`(call_time 读点立即生效) |
| 审计 | `packages/teamlead/src/bridge/fleet-admin-audit.ts`(`~/.flywheel/audit.db`) | staged / apply-requested / apply-result / denied;**fail-closed 行为在 `ManagementChangeCoordinator` 侧;`flag-routes.ts` 现状忽略 staged 返回值、无 apply-requested(Codex R1#6 实核)——本单只在 managed 分支补齐,legacy 分支一字不动** |
| 管理台面 | `fleet-console-html.ts:350 renderFlags()` + `management-existing-writers.ts`(writer `existing-direct-flag-v1`) | 只有 `isDirectToggleable` 的 flag 可点,其余渲染 disabled + 拒因 |
| 手机报告 | `plugin.ts:2119 GET /api/fleet/flag-report.html` + `feature-flag-render.ts` | `?interactive=1` 生成 CLI copy-paste 命令;`effectLabel()` 按 timing 显示「热生效/需重启」 |

### 1.3 46 条 flag 的人口结构(env × bridge_global = 35 条,逐条实算)

分桶(v1 判词;M0 以代码事实终审):

| 桶 | 判词 | 成员(按当前 registry) |
|---|---|---|
| **A. v1 纳管候选(5)** | env·bridge_global·bool/enum·direct·非治理·非安全保护·全读点在 Bridge 进程内 | `flag_retirement_scan` · `workflow_rework_reentry` · `skill_framework_mode`(enum;**有 registry 未登记读者**:`Blueprint.ts:1190`(edge-worker,需注入 seam)、`runs-route.ts:1220`、`run-dispatcher.ts:663`,经导入常量直读)· `workflow_resume`(未登记读者 `workflow-engine-dispatcher.ts:1755/:1860`)· `workflow_turn_divergence_alerts`。M0 以导入常量追踪法补全调用图;seam 代价不成比例的候选缩出 A 桶 |
| **B. 安全保护集,留 legacy(6)** | live re-arm / 跨进程 `.env` 现读 / ship 安全链(代码事实核定) | `mailbox_queue`(dotenv_live + deploy-barrier 联动) · `merge_approval_gate_killswitch`(dotenv_live) · `qa_done_gate_killswitch`(dotenv_live) · `codex_hard_gate_killswitch`(**隐藏 live 读点** `verify-approval.ts:292`) · `auto_qa_killswitch` · `ship_ci_guard`(cli,ship 链) |
| **C. 治理门,永不进 store(4 env + 1 config)** | category = governance_gate | `design_html_gate` · `founder_consent_decision_mode` · `founder_attribution_gate`(**实际 live 读 `.env`,声明是 cli_invocation**) · `lead_lease_bypass`(+ `checkpoint_enabled` 属 project_config) |
| **D. 跨进程读者,v1 不纳管(5)** | 读点在 CLI/别的进程 | `converge_cmux_symlink` · `cmux_view_helper` · `cmux_node_presence` · `instruction_path_check`(call_time+cli 混合) · `lead_core_mention_gated`(mixed,保守归此桶,M0 终审) |
| **E. value 类数值,v1 不纳管(11)** | valueKind = value(自由字符串无界目标集,与现行准入判据一致地拒) | `liveness_activity_window_ms` · `deferred_approval_ttl_ms` · `founder_reply_deadletter_age_ms` · `issue_display_sweep_ticks` · `ship_gate_grace_ms` · `merge_reconcile_window_days` · `ship_gate_card_grace_ms` · `reports_ttl_days` · `ghost_guard_wait_ms` · `done_thread_reconcile_interval_min` · `done_thread_reconcile_max_per_run` |
| **F. project_config,超出本单(11)** | 值在各项目 config.yaml,已 call_time | `qa_auto` `doc_flow` `proofshot` 等 11 条 |
| 其余 bool·conversational/readonly(4) | 机制上可进 store,但无翻转入口消费(readonly 无人翻、conversational 走 Lead 对话)→ v1 不纳管,机制留好生长点 | `voice_qa_presence_override`(object_construction) · `external_merge_reconcile` · `publish_broker`(bridge_boot) · `issue_gate_supersede_mode`(enum readonly) |

**restart-frozen 读点全集(原 FLY-1405 的残余,共 6 处)**:`voice_qa_presence_override`(object_construction)· `issue_display_sweep_ticks`(object_construction)· `reports_ttl_days`(object_construction)· `ghost_guard_wait_ms`(bridge_boot)· `publish_broker`(bridge_boot)· `lead_core_mention_gated`(mixed)。**Codex R1#10 裁定:这 6 处属非纳管 flag 的独立行为手术,不在四件套内——本单只在 M0 逐处记录现状立据,手术拆 follow-up 单**(对 issue 原文范围 3 的显式收窄,M0 复审时报 Tadashi 确认)。它们今天都是 readonly/conversational,无翻转入口消费,call-time 化对用户不可见。

**FLY-1405 的 45 条幸存者标记 → 现存 10 条**(exploration §1.2),全部落在上表 B/C/E/A 桶内,M0 manifest 逐条给最终判词即收口——不给 registry 加任何新承接字段。

### 1.4 登记不可信的两个实锤(M0 方法论的依据)

1. `codex_hard_gate_killswitch`:registry.ts:390–397 **明写**它的 CLI live `.env` 读点「deliberately NOT listed as a call_time readSite here so `isDirectToggleable` still accepts this flag」——任何拿 registry `readSites` 自动生成 manifest 的脚本都会漏掉这个读点,DB-only 迁移会静默破坏 FLY-827 re-arm 契约(FLY-1091 工程 PRD §5.8 点名的反例)。
2. `founder_attribution_gate`:声明 `cli_invocation`,实际 `founder-attribution.ts:128` live 读 `.env`。

**⇒ M0 的真源 = `readEnvValueFromContent`(`packages/config/src/env-file.ts:14`)全调用点 grep + 每 flag 读点逐个开文件核对,registry 只作索引。** 这正是 FLY-1150 plan §1.2 的教训(「安全集以代码事实核定,timing 标注只作线索」),被本次调研独立复现。

## 2. 方案:单权威 flag value store

### 2.1 DDL(StateStore 新增:两张值/账表 + 一张就绪围栏表)

```sql
CREATE TABLE IF NOT EXISTS flag_values (
  flag_name TEXT PRIMARY KEY,
  has_override INTEGER NOT NULL DEFAULT 0 CHECK (has_override IN (0,1)),
  raw_value TEXT,                     -- has_override=1 时的 raw;canonical 同 .env 写法
  last_effective TEXT NOT NULL,       -- 类型化有效值的 canonical 文本("true"/"false"/enum 值)
  value_last_changed INTEGER,         -- ms epoch;NULL = store 视界内值从未变过
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) > 0),
  CHECK ((has_override = 0 AND raw_value IS NULL)
      OR (has_override = 1 AND raw_value IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS flag_value_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('seed','set','clear','default_shift','bypass_recovery')),
  from_present INTEGER,  from_raw TEXT,
  to_present INTEGER NOT NULL, to_raw TEXT,
  from_effective TEXT,   to_effective TEXT NOT NULL,
  changed_by TEXT NOT NULL CHECK (length(changed_by) > 0),
  changed_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) > 0)
);
CREATE INDEX IF NOT EXISTS idx_fvc_flag ON flag_value_changelog(flag_name, id);

-- 旁路围栏(R2#1 + R3#3:DDL 强制单行单键,不留任意 key/value 余地)
CREATE TABLE IF NOT EXISTS flag_store_meta (
  key TEXT PRIMARY KEY CHECK (key = 'bypass_seen'),
  value INTEGER NOT NULL CHECK (value IN (0,1)),
  updated_at INTEGER NOT NULL
);
```

与旧 FLY-1150 DDL 的三处刻意差异:

| 旧(FLY-1150) | 新(本单) | 理由 |
|---|---|---|
| 主键 `(scope_kind, project, flag_name)` | 主键 `flag_name` | v1 只收 bridge_global;project override 是明确 non-goal(四件套边界)。将来要 project 层 = 幂等 ADD COLUMN + 重建 PK 的一次 migration,代价已知且可控 |
| 无 `value_last_changed` 列,拆 transitions 账本 + 60s sweep | **列内直存**,写事务内一步到位 | 单权威 + 单写者使然:值只可能在 apply 事务/boot 对账两处变,无需观测机 |
| `feature_flag_cutover` epoch 表 | 无 | 成员关系静态在代码里(§2.2),没有运行时演进 |

继承旧设计的部分:`has_override` 双态 + CHECK 约束、CAS `revision` 乐观锁、changelog `reason` NOT NULL、CLEAR = 置 `has_override=0` 保留行(删行会重置 revision → ABA,FLY-1091 工程 PRD §5.4 的裁定)。

### 2.2 成员关系:代码内静态 allowlist(store-policy 形状)

```
packages/config/src/feature-flags/store-policy.ts(新)
  STORE_MANAGED_FLAGS: ReadonlySet<string>   // v1 = A 桶 5 条
  getStoreEligibility(spec): { eligible } | { refused: reason }
    拒绝顺序:category === "governance_gate" → 拒
            ∈ PROTECTED_LEGACY_FLAG_NAMES(B 桶,代码事实核定)→ 拒
            valueKind 非 bool/enum → 拒
            ∉ STORE_MANAGED_FLAGS → 拒(缺席即拒,绝无隐式候选)
```

改成员 = 改这份代码过 PR。值不过 PR,成员过 PR——治理归治理,值归值。

### 2.3 读路径:Bridge 进程内 read-on-use(per-flag 具名 wrapper)

```
packages/teamlead/src/bridge/flag-store.ts(新)
  私有原语 readFlagValueRow(store, name) → {hasOverride, raw, revision, ...} | undefined
  每条纳管 flag 一个导出的具名 wrapper(名字静态绑定 flag):
    storeWorkflowResumeEnabled(store) → 读行 → codec 解析 → effective(bool/enum 简单 flag)
    storeSkillFrameworkModeControl(store) → 读行 → **raw 控制值在场性**(R2#2:
      由真实调用点喂给 owning resolver 携 issueIdentifier 解析,store 绝不预解析 split)
```

- 每次调用做 StateStore prepared point lookup(同进程 better-sqlite3,µs 级),**永不 boot 快照**;
- 行存在:`has_override ? parse(raw) : default`(bool/enum 简单 flag 的 wrapper 内完成);`skill_framework_mode` 的 wrapper **只返回 raw 控制值在场性**,由调用点喂给 owning resolver(R2#2 两层拆分);raw 在场性语义(`via: default/forced` 归属)逐字节保留(R1#4);
- **失败契约 = 与 StateStore 其余读写同一契约:错误向上传播,不吞不落**。早稿的「fail-open 回落 legacy thunk」被 Codex R1#3 推翻:回落即重开第二权威(store 值 OFF 可被 legacy ON 顶掉且不落账),`value_last_changed` 随之失真。boot ensure 成功是 store 就绪门;就绪后行缺失 = invariant violation,throw;
- 逃生口:`flag_store` kill_switch(新 registry 行,env,default_on,**readonly + `bridge_boot` timing**——boot 级状态,进/出旁路 = 改 `.env` + 重启;R3#1:若可 direct 翻,运行时切权威会绕过 boot 围栏,正是钟洞本身)——`FLYWHEEL_FLAG_STORE=0` = 应急旁路,**完整生命周期真值表见 plan §3.2**(R2#1):旁路 boot 跳过 ensure gating(store 故障不 brick Bridge)+ managed apply 409 + FlagView `no_clock:bypass` + best-effort 写 `flag_store_meta` 围栏;恢复 boot 见围栏 → 每条 managed flag 落 `bypass_recovery` 观测并**保守推进钟、同时把当前 codec 结果刷进 `last_effective` 与 changelog `to_effective`**(R4#3:旁路期间 registry default 可能变过,不刷会让下一次正常 boot 重复报一次 `default_shift`)→ 清围栏才回 `ready`。`no_clock` 是 FlagView/UI 契约(现役扫描不读新字段,消费属 follow-up)。该 flag 自身**永不纳管**(自指),注册 registry 行而非 exemption。

纳管 flag 的读点手术:各读点改调**该 flag 的具名 wrapper**,registry `readSites` 换 `delegated` pattern(`resolverModule`/`resolverSymbol` = 该 wrapper)。泛型 accessor 不构成 flag 级 drift 证据(`delegatedEvidence()` 只验 import + 调用,不验 flag 名实参,Codex R1#2)——具名 wrapper 让 flag 身份静态可证。**跨包读者不反向 import**:`Blueprint.ts`(edge-worker)的读点由 teamlead `run-infra.ts` 构造 Blueprint 时注入 reader 闭包(TeamLead 本就构造它)。`feature-flags-drift.test.ts:249-267` 的 delegated 精确 roster 需同步更新(早稿「零 guard 改动」不成立)。

### 2.4 写路径:apply 事务(managed 分支)

stage 复用既有 CLI 路由(`/api/fleet/flag/stage|apply`);**legacy `FlagCanonical`(`kind:"flag"`)形状与行为逐字节不变**,managed 走**新判别形状**(`kind:"flag_store"`,含 revision/actor/reason;Codex R2#4:给 legacy 加 authority 字段会污染其 canonical/confirmToken/审计字节,违反 B 桶红线)。进路由先按 store-policy 分支——B 桶 direct flag 走 legacy 分支**照常成功且字节不变**。审计契约补课**仅 managed 分支**(R1#6 实核三缺口):staged 返回值必须检查、失败拒发 token;apply 前补 `apply-requested`、失败拒入事务。CLI 加 `--reason`(非空校验);actor = 稳定 server 主体 `bridge-local-operator`(R2#5:该路由 loopback+same-origin,无法区分 CLI 与 console 调用方——如实记「本机操作面归属」,不谎称调用者身份;调用方自报 actor 一律忽略),actor+reason 进 managed canonical 与 confirmToken 哈希。apply:

```
StateStore 单事务(better-sqlite3 .transaction):
  0. 独立准入:name ∉ STORE_MANAGED_FLAGS 或 ∈ RETIRED_FLAGS → typed reject
     (R1#8:mutator 自卫,防未来进程内调用方绕过路由写 rogue 行)
  1. 重读行;revision ≠ canonical.revision → 409(CAS)
  2. codec 计算 old_effective(行现态)与 new_effective(rawTo)
  3. 写 raw/has_override,revision+1(每次写必增,含同值重写),updated_at/by
  4. old_effective ≠ new_effective:
       value_last_changed = now, last_effective = new_effective
     相等(同值重写):只动 updated_at/revision ——「同值重写不得误触」结构性成立
  5. 插 changelog 行(set/clear,from/to 全字段,changed_by=actor,reason)
     —— 与值变更同一事务:无账即无变更(R1#6)
事务外:fleet_admin_audit apply-result(事后账无法回溯 fail-closed,如实标注;既有对账机制兜底)
```

managed flag **不写 `.env`、不改 `process.env`**;`flag-toggle.ts` 对 managed flag 返回 409 指路 store 路由(FLY-1150 已验证过的防误写形状)。`.env` 里的残留旧行对 managed flag 无效,console 渲染「env 行已被 store 接管」提示(复用既有 divergence 展示位)。

### 2.5 boot ensure(幂等单趟,非周期机;时序与失败语义按 Codex R1#9 钉死)

**时序**:`plugin.ts` 里 `StateStore.create()`(migrate 完成)之后、**任何 managed reader / dispatcher / 路由 / console 快照 / 扫描器构造之前**跑;ensure 成功才发布 store 就绪。**ensure 失败 = Bridge 启动失败**(与既有 migrate 失败同契约,fail-closed;**此规则限正常/恢复 boot——旁路 boot 刻意跳过 flag ensure gating,见 plan §3.2 真值表**)——绝不在部分播种状态下发布读者(那会重造 missing-row 路径)。

对 `STORE_MANAGED_FLAGS` 逐条(单事务,任何行变更 revision+1):

1. **无行 → seed**:raw = 当时 `process.env[envVar]` **原样保留一切在场值**(含显式默认值、空串、非法串——owning parser 怎么容错就怎么容错;缺席才 has_override=0。R1#4 修正早稿「非默认才收」),`last_effective` = codec 计算值,`value_last_changed = NULL`,changelog `seed`。纳管瞬间现值被原样收编 ⇒ absent-read 迁移兼容由 seed 保证,而非运行时回落 env(回落会重开 PRD 洞 1);
2. **有行 → 对账**:codec 重算 effective vs `last_effective`,漂移 ⇒ changelog `default_shift` + `value_last_changed = now`(**观测钟,PRD 要求点名**)。这接住 PRD 洞 4(registry default 经 PR 变更,实例 `740c90ee`):default 变更本随部署生效,boot 对账当场记账;
3. **行在但名字 ∉ 纳管集 ∪ ∈ RETIRED_FLAGS**:**启动失败并指明出路**(store 侧 tombstone 守卫,补 drift guard「只管代码不管 DB 值」缺口)。**退栈(un-enrollment)是显式 reviewed migration 步骤**,且现 DDL 不预铸退栈表示法(R2#7,YAGNI):未来退栈 PR 必须**先引入表示它所需的 schema/migration** 再删名单;绝不 boot 静默删(R1#9:否则未来退役 flag 不可部署)。

### 2.6 PRD §5.3 留给产出方的 6 个未答问题——逐条回答

PRD 说「解析边界记一条」在 FLY-1150 的多进程只读 reader 合同下不可实现,留了 6 条。本设计以「**只在唯一写者的写事务内记,读边界永不记**」的收窄让其中 5 条 by construction 消失:

| # | PRD 问题 | 本设计的回答 |
|---|---|---|
| 1 | 读边界 → 唯一写者的持久化通路 | **不存在这条通路**:读边界不记账;记账只发生在 Bridge apply 事务与 boot 对账(都在唯一写者进程内) |
| 2 | 前值 + authority/revision 身份 | `last_effective` 列 + CAS `revision`,同事务读改写 |
| 3 | 并发读者的幂等有序 compare-and-record | 读者不记账,问题不存在;写侧由 SQLite 单写事务串行化 |
| 4 | `when` = 源变更时刻 vs 首次观测时刻 | **两口钟都有、且点名**:apply 路径 = 源变更时刻(事务即变更);boot 对账 = 观测时刻(changelog `action` 字段区分 `set/clear` 与 `default_shift`,消费方可辨) |
| 5 | 初始种子 | seed 行,`value_last_changed = NULL`;NULL 语义 =「store 视界内未变过」。**如何消费 NULL 属扫描消费 follow-up 的契约条款**(本单只产出;R2#8 修正早稿「B3 读 NULL」的现在时表述) |
| 6 | 读 fail-open / 时钟 readiness fail-closed | **读不回落**(回落=第二权威,R1#3 裁定):错误按 StateStore 契约传播;唯一逃生口 `FLYWHEEL_FLAG_STORE=0` 期间 managed apply 冻结(409)且全部 managed flag 标 `no_clock`。时钟 readiness 显式化:FlagView `clockReadiness`("ready" / "no_clock:{bypass|unmanaged}"),未纳管 flag 一律「无时钟」 |

PRD 的四个洞:洞 1(legacy 回落层的变化记不到)——纳管后 legacy 层对该 flag 失效**且读路径无回落**(早稿的 fail-open 回落曾把这个洞重新打开,R1#3 修正),洞消失;仅存的 legacy 窗口 = `FLYWHEEL_FLAG_STORE=0` 应急旁路,旁路即 no_clock 显式化 + store 冻结,不假装有钟;洞 2/3(shadow epoch / per-flag epoch 权威)——无 epoch,洞消失;洞 4(registry default 变更)——boot 对账接住(§2.5)。

### 2.7 `value_last_changed` 的消费面

- **FlagView enrich 旁路**(FLY-1150 的 `enrichFlagViewsWithStore` 模式,`resolveFlag` 本体零改动):`FlagView` 加可选 `storeManaged` / `storeEffective` / `valueLastChanged` / `clockReadiness` 字段;
- **本单 = 产出契约,不改扫描判据**(Codex R1#7 实核:`computeFlagScan()`/`canonicalizeFlagSample()` 今天完全不读 `valueLastChanged`——把消费改造塞进本单是四件套之外的第五件)。扫描消费升级(用持久翻转钟替代 streak 推断、NULL 种子语义、no_clock 分类)开**显式 follow-up 单**,在 M0 复审报文与 PR body 点名;在那之前 FLY-1781 对纳管 flag 维持快照 diff 判据,不退化也不谎称已升级;
- console flag 页与手机报告(只读渲染「值上次变更」+ 钟就绪态);changelog 分页 GET 从 v1 砍除(表 + 内部查询方法足够,R1#10)。

## 3. 与既有治理设施的对齐清单

| 设施 | 撞点 | 解法 |
|---|---|---|
| FLY-1455 drift guard(reverse) | store 读点文件里无 envVar 字面量会红;且泛型 accessor 过不了 flag 级证据 | per-flag 具名 wrapper + readSites 换 `delegated` pattern;`feature-flags-drift.test.ts:249-267` 的 delegated 精确 roster 同步更新(非零改动,R1#2) |
| FLY-1455 drift guard(forward) | store 自身逃生口 env 是新读点 | `flag_store` 注册为 registry 行(kill_switch),不塞 exemption |
| `FlagSource` 联合类型 | 不加 `"db"` | 纳管 flag 仍是 env 源(store 是值的**存放处**不是新 source);FlagView 只加展示字段 |
| truth.ts tombstone(179 条) | DB 值可绕开代码面 tombstone 网 | boot ensure 第 3 步 + apply 准入双处 fail-loud |
| FLY-1779 红线 | `longTermKeep` 无创建时门(Annie 亲手砍) | 本单不触碰该字段;守护测试保持绿 |
| FLY-1806/1808 纪律 | 三格证据 / 具名集合守卫 / writer inventory | M0 manifest 逐条三格;纳管集合用具名集合守卫测试钉死;M0 含 writer 盘点(谁 set 这些 env) |
| FLY-1091 工程 PRD | 三表 epoch/cutover + 四层 precedence | **显式 supersede**(exploration §1.5):四件套边界(2026-08-15,后出)取代其批量迁移形态;CAS/tombstone-clear/changelog/trusted-actor 全继承 |

## 4. 量级复核(自检线)

| 件 | 估行数(功能码) |
|---|---:|
| StateStore migration + 读写方法(含 mutator 独立准入)+ boot ensure | ~350 |
| 旁路围栏 meta + 恢复单事务(`bypass_recovery` / recovery-seed) | ~90 |
| store-policy + per-flag codec(config 包,含 skill_framework_mode 控制层) | ~140 |
| 读原语 + per-flag 具名 wrapper + edge-worker 注入 seam(teamlead/run-infra) | ~150 |
| flag-routes managed 新 kind 分支 + 审计契约补课(仅 managed) | ~180 |
| CLI `--reason` + managed canonical 显示(flywheel-comm) | ~60 |
| 读点手术(A 桶,含隐藏读者)+ registry readSites + drift roster 更新 | ~150 |
| FlagView enrich + console/手机报告读模型(writable=false + 控件抑制)+ 旧写面 preflight | ~160 |
| `flag_store` 逃生 flag 注册(readonly + bridge_boot)+ 双写面拒它的守卫 | ~40 |
| **合计** | **~1,320(区间 1,100–1,300 的上沿,四舍五入)** |

低于 2k 自检线(测试行数不计分母;R1#10 砍去 frozen 读点手术 / changelog GET / dashboard 写面;R2/R3 补入围栏恢复 / 读模型 / 两层 mode)。**最终定规模在 M0 复审之后。**四件套之外零机器:无 epoch、无 mirror、无 sweep、无跨进程 reader、无新 UI 面、无 manifest JSON 入仓。

## 5. 残余风险与诚实边界

1. **v1 纳管人口小(5 条)是设计选择不是缺陷**:能力(store + 钟 + 免 git 链)以真实 flag 证明;扩员 = store-policy 加一行 + 读点手术一处,每次跟随该 flag 自身的治理节奏。FLY-1150 为「预支批量迁移」付了 19,833 行学费,本单不重付。
2. **value 类(E 桶 11 条)与跨进程读者(B/D 桶)明确不在 v1**:`value_last_changed` 契约只对纳管 flag 成立。**本单产出钟、不改扫描判据**(消费升级 = 显式 follow-up,R1#7);B3 扫描全体维持快照 diff 判据(FLY-1781 已上线),不退化。
3. **conversational/readonly bool 类(4 条)机制可进但 v1 不进**:没有翻转入口消费它们,进了也不会产生钟;避免「为覆盖率纳管」的假动作。
4. **M0 是硬门**:上表 A–F 分桶是设计时点的预判;M0 以 `readEnvValueFromContent` 调用点 + 逐读点开文件核对 + writer 盘点重新核定,若与预判实质偏离(读点比 registry 元数据更乱),重估规模并上报 Tadashi 复审后再动 M1(guardrail 1 原文要求)。
5. **重启依赖**:boot ensure 只在 Bridge 启动跑;新增纳管 flag(改 store-policy)随部署重启自然触发 seed,无需额外机制。default_shift 的记账粒度 = 部署粒度,与 default 变更的实际生效粒度一致(default 变更本来就随部署生效)。
