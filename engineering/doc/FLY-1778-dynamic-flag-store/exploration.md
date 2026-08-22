# FLY-1778 动态 flag store 重做 — 探索

Issue: FLY-1778 (https://linear.app/geoforge3d/issue/FLY-1778/flag治理地基第3批-动态-flag-store-重做-值存-sqlite-read-on-use-产出-value-last)
日期: 2026-08-21
基于: 无

---

## 0. 一句话

给 flag 的**值**一个带时钟的家:值存进 Bridge 现有 SQLite、读点 read-on-use 现读、翻转免重启且留审计,并产出 `value_last_changed`(「这个开关的值上次什么时候变的」)作为对外契约——替代被关闭的 FLY-1150(PR #698,19,833 行未合),吸收 FLY-1405(免重启动态 apply)的范围。

边界线(Tadashi 定):**「一个 flag 从注册 → 翻转 → 生效,全链路不碰 git」——够用即停。**

## 1. 现状审计(2026-08-21 重新盘点,推翻 issue 里的旧数字)

issue 文本里的规模数字全部过时,开工前重盘的结果彻底改变了本单的体量:

### 1.1 registry census:124 → **46 条**

issue 写「今天 registry 是 124 个」(2026-08-14 口径)。此后第 1、2 批已 **merge 落地**(CLAUDE.md 里程碑表滞后):

- FLY-1456(#695 系)删 13 条 dead flag;
- FLY-1806(#859)删 31 条零行为变化 flag;
- FLY-1809(#856)搬 2 条 config 值出表;
- FLY-1808(#871)拆 10 条真开关 + 2 条搬 invocation seam;
- FLY-1455(#862)drift guard 闭网;FLY-1779(#855)落 `longTermKeep` 字段;FLY-1781(#863)每周退役扫描已上线。

当前 `packages/config/src/feature-flags/registry.ts` 实数 **46 条**:

| 维度 | 分布 |
|---|---|
| category | feature 27 · kill_switch 14 · governance_gate 5 |
| source | env 35 · project_config 11 |
| toggleable | readonly 21 · conversational 17 · **direct 8** |
| readSites timing(59 个读点) | **call_time 41** · cli_invocation 9 · object_construction 3 · dotenv_live 3 · bridge_boot 2 · mixed 1 |

关键推论:**restart-frozen 的读点只剩 ~6 个**(object_construction 3 + bridge_boot 2 + mixed 1)。原 FLY-1405 设想的「138 个开关逐读点迁移」在今天的现实里是一个小尾巴,不是主体工程。

### 1.2 FLY-1405 承接的「45 条幸存者」→ **现存 10 条**

FLY-1456 的 `execution-ledger.md`(`1405_candidate = yes` 列)标了 45 条。逐条对当前 registry 核对:**35 条已被后续批次删除**(含 5 条 keep 里的 4 条),仍在 registry 的只有 10 条:

`liveness_activity_window_ms` · `voice_qa_presence_override` · `design_html_gate` · `issue_gate_supersede_mode` · `ship_ci_guard` · `workflow_rework_reentry` · `ghost_guard_wait_ms` · `lead_lease_bypass` · `skill_framework_split_participation` · `skill_framework_mode`

承接方式:不照抄清单,M0 读点 manifest 时把这 10 条纳入盘点(其中 `design_html_gate` / `lead_lease_bypass` 是 governance_gate,`ship_ci_guard` / `workflow_rework_reentry` 是 kill_switch——多数会落进「不迁」桶)。registry 代码里没有任何 FLY-1405/FLY-1778 锚点字段,继承只存在文档层——本单在 M0 manifest 里一次性收口,不给 registry 加新字段。

### 1.3 已有的免重启翻转链(FLY-709 P2 + FLY-1356)——比想象中完整

`packages/teamlead/src/bridge/flag-toggle.ts` + `flag-routes.ts` 已经存在一条完整的、**不碰 git 的**翻转链:

- **stage → confirmToken → apply** 两段式(镜像 FLY-247 fleet 模式);⚠️ 后经 Codex R1#5 实核修正:console 走 `/api/fleet/changes/*` + management writer,CLI 走 `/api/fleet/flag/*`,**是两条路不是一条**——v1 翻转入口取 CLI 路由(见 plan §0);
- apply 事务:`.env` **persist-first**(原子写 + 文件锁)→ 在进程内改 `process.env` → call_time 读点立即观察到新值,**无需重启**;
- 审计:`fleet_admin_audit` 表(`~/.flywheel/audit.db`,better-sqlite3,staged / apply-requested / apply-result / denied);⚠️ R1#6 实核修正:fail-closed 在 ManagementChangeCoordinator 侧,`flag-routes.ts` 现状忽略 staged 返回值、无 apply-requested——本单只在 managed 分支补齐;
- 安全admission:`isDirectToggleMetadata` ——仅 env 源、bridge_global、bool/enum、非 governance_gate、全读点 call_time/dotenv_live 的 flag 可走(今天恰 8 条 direct)。

**所以 FLY-872「翻个 flag 不要开 PR 过 CI」对这 8 条 direct flag 已经成立。** 本单真正补的是两件事(早稿列过第三件「frozen 读点迁 call-time」,经 Codex R1#10 裁定拆出本单——那 6 处属 readonly/conversational flag,无翻转入口消费,手术对用户不可见,归 FLY-1405 残余 follow-up):
1. 值的**耐久真相源**从 `.env` 文本行换成 SQLite 表(带 `value_last_changed` 时钟与结构化历史);
2. `value_last_changed` 对外契约(`.env` 给不了——文件 mtime 不分 flag,git 历史已被 PRD 证伪)。

### 1.4 FLY-1781 每周扫描已 merge——前置关系已如 issue 预告的翻转

`flag-retirement-scan.ts` 已上线,走**快照法**:每次运行取 `FlagView[]` 快照 + `flag_provenance` 表(记 flag 的**出生**:incarnation commit / author / PR,不记值变更)。所以:

- 本单**不再是** B3 扫描的前置(issue 文末已预告此变化);
- 但扫描今天判「值最近变没变过」只能靠快照间 diff(周粒度、无因果),`value_last_changed` 给被纳管 flag 提供**精确到笔的翻转时钟**——是扫描判据的升级,不是它的必要条件。诚实边界:未纳管 flag(留 `.env` 的安全集等)没有翻转时钟,和今天一样。

### 1.5 上游契约的真实状态(两处必须点名)

- **OQ-9 在 PRD 里没拍,在本 issue 里拍了。** FLY-1412 PRD 原文把甲/乙并列「待 Lead + Tadashi 拍」;本 issue 文本写死「OQ-9 取甲案:由本单作为产出契约提供」——即裁决发生在 issue 层(Honey Lemon 提出、Annie 圈选拍板)。本单按甲案执行,并在 research 里逐条回答 PRD §5.3 留给产出方的 6 个未答问题(单写者设计让其中 5 条 by construction 消失,见 research §3)。
- **FLY-1091 有一份工程 PRD**(`engineering/doc/FLY-1091-dynamic-feature-flags/prd.md`,266 行,即 PR #533 那份):三张表(含 `feature_flag_cutover` epoch/mirror 权威表)+ 四层 precedence(project DB > global DB > legacy > default)。**本单有意偏离它的 epoch/cutover/project-override 形态**——那正是 FLY-1150 膨胀的骨架,且被 2026-08-15 的四件套边界(后出的裁决)取代。可继承的部分(CAS revision、CLEAR=tombstone 不删行、changelog 形状、trusted-server actor、复用 stage/apply 鉴权外壳)全部继承。偏离点在 research 里逐条列表说明。

## 2. FLY-1150 死因解剖(考古 origin/flywheel-FLY-1150 @ d3b70a66)

19,833 行的真实构成,和直觉相反:

| 构成 | 行数 | 判决 |
|---|---:|---|
| checked-in 的 `flag-manifest.json` + 文档 | **11,484**(其中 manifest 一个文件 10,010) | 砍——manifest 是 M0 的**过程产物**,进 doc 文件夹做人读表格,不做 10k JSON 入仓 |
| 测试 | 2,967 | 合理开销 |
| cutover epoch 状态机(shadow → global-compatible → project-capable,4 种 transition) | ~500+ | 砍——为「批量迁移」造的编排机,而批量迁移本来就是 non-goal |
| `.env` 双向 mirror reconciler(+文件锁重写) | ~360+ | 砍——双权威才需要 mirror;单权威不需要 |
| value clock sweep(60s 定时器 + 覆盖度状态机) | ~180+ | 砍——见 §3.4,单写者设计让时钟在写事务内一步到位 |
| store / routes / reader / policy 本体 | ~2,000 | **可近乎原样借鉴** |
| UI 大盘 | 40 | 从来不是元凶(复用 fleet console) |

三块值得直接抄的:

1. **`flag-reader.ts` 的 read-on-use 模式**:一条 warm readonly `better-sqlite3` 连接(`fileMustExist`, `timeout:10`, `busy_timeout=10`——踩坑后的经验值),每次调用执行 prepared point lookup,**永不 boot 快照值**。⚠️ 只抄这半——它的另一半「降级不抛 + failPolicy 回落 legacy thunk」在本单被 Codex R1#3 推翻(回落 = 第二权威,钟失真),本单读路径无回落(见 plan §3.2)。
2. **`store-policy.ts` 的结构性排除**:governance_gate 全拒 + `PROTECTED_LEGACY_FLAG_NAMES` 安全集拒 + 显式 allowlist(缺席即拒)。附带最重要的教训:**安全集以代码事实核定,registry timing 标注只作线索**——`codex_hard_gate_killswitch` registry 标 call_time,代码实际 live 读 `.env`。
3. **`feature_flag_changelog` 的审计形状**:同事务落 who/when/old→new + `reason` NOT NULL,CAS `revision` 乐观锁。

死因一句话:**为 2 个显示类 pilot flag 造了一整套「批量迁移基础设施」**(epoch 机 + mirror + sweep + 10k manifest)。本单的解法不是「做小一点的同款」,而是**用单权威假设消掉这三台机器存在的理由**(§3)。

## 3. 设计空间与选型

### 3.1 值存哪 → StateStore(teamlead.db),不新开库

- StateStore 自 FLY-663 起底层已是 native `better-sqlite3`(sql.js 兼容 shim),WAL、幂等 `CREATE TABLE IF NOT EXISTS` migration 模式成熟(近例:FLY-1781 的 `flag_provenance` 系表);
- `audit.db` 是审计账本(fleet_admin_audit / founder_consent_audit),放**活值**语义不合;
- 新开 `flags.db` = 多一个文件、多一套连接管理,没有换来任何东西。
- FLY-1150 也是放 StateStore,这一点它没选错。

### 3.2 谁是权威 → **单权威、静态划分,消灭 epoch/mirror/sweep**

FLY-1150 的三台机器全部源于一个假设:「一个 flag 可以同时有 `.env` 和 DB 两个权威,且成员关系在运行时演进(epoch)」。本单反过来:

- **每个 flag 的权威是静态的、代码里声明的**:要么 store-managed(DB 行是唯一真相源),要么 legacy(`.env`/config,行为与今天逐字节相同)。划分表是一份 code 内的显式 allowlist(store-policy 形状),改成员 = 改代码过 PR——成员关系本来就该走治理,值才需要免 PR。
- store-managed flag 的 `.env` 行**被读路径忽略**(hand-edit 无效果,console 显示「env 行存在但已被 store 接管」的 divergence 提示);legacy 写路径(`flag-toggle.ts`)对 store-managed flag 返回 409 指路 store 路由(FLY-1150 已有此形状)。
- 于是:没有双权威 → 不需要 mirror;没有运行时成员演进 → 不需要 epoch 机;store 是 managed flag 值的唯一写入口 → `value_last_changed` 在写事务内一步到位,不需要 sweep。

### 3.3 read-on-use 形态 → Bridge 进程内 point lookup;v1 不做跨进程 DB reader

46 条里 env×bridge_global 有 35 条,其读点几乎全在 Bridge 进程内(cli_invocation 9 个读点属于 CLI 进程,dotenv_live 3 个属于别的进程)。v1 的纳管人口**只收「全部读点都在 Bridge 进程内」的 flag**:

- 读 = StateStore 上的 prepared point lookup(同进程,µs 级),每次使用现读,无 cache 无 TTL 无失效协议;per-flag 具名 wrapper(drift 证据要求,见 §3.7);
- absent-read 兼容由**纳管时 seed** 保证(见 §3.4),读路径无 env 回落——boot ensure 成功是就绪门,就绪后行缺失是 invariant violation(Codex R1#3:运行时回落 = 第二权威,会让钟失真;失败契约详见 research §2.3);
- cli_invocation / dotenv_live / shell 读点的 flag **不进 v1 纳管人口**(跨进程 reader 是 FLY-1150 的 544 行 `flag-reader.ts`,v1 不需要;将来要做时那份代码就是蓝本)。

### 3.4 `value_last_changed` 语义 → 值表内一列,写事务内比较 effective 值

- `flag_values` 表直接带 `value_last_changed` 列(旧 FLY-1150 DDL 没有这一列,拆成了 transitions 账本 + sweep;单权威下不再需要);
- 每次 apply 在同一事务内:比较 old/new **effective** 值(不是 raw——raw 的 canonical 写法差异不算值变),**不同才 bump** `value_last_changed`;同值重写只 bump `updated_at`(issue 验收测试 #1 点名的边界:同值重写不得误触);
- 不从 changelog / git 历史回放(PRD §5.3 四个洞 + 实例 `740c90ee` 已证伪);不做 backfill——store 出生前从未翻过的 flag,`value_last_changed` 为 NULL,诚实表示「store 视界内未变过」;
- **纳管 = 播种(seed)**:一个 flag 进入纳管名单时,Bridge boot 的幂等 ensure 为它建行,并把**当时的 env 现值原样收进 raw**(一切在场值都收,含显式默认/空串/非法串——owning parser 怎么容错就怎么容错;Codex R1#4 修正)——此后 `.env` 对它彻底失效,单权威成立;seed 本身不算值变(`value_last_changed` 不动,changelog 记 `seed` 行留痕)。absent-read 兼容由 seed 保证(现值被原样收编),读路径**无 env 回落**(回落会重新打开 PRD 洞 1;失败契约与逃生口见 research §2.3,Codex R1#3 裁定);
- **PRD 洞 4(registry default 变更是真实值变但无 changelog 事件,实例 `740c90ee`)**:行里存 `last_effective`,Bridge boot 时对每个纳管 flag 比较 stored vs 当前计算值,漂移即记一条 transition(`when` = 观测时刻,**显式标注为观测钟而非源变更钟**——PRD 要求两口钟必须点名)。这是一次 boot 单趟对账,不是周期 sweep。

### 3.5 安全关键集 → 结构性排除(即「留 legacy」),以代码事实核定

Tadashi guardrail 2 说「留 legacy 或 dual-write」。选**留 legacy(结构性排除)**,不选 dual-write:

- dual-write 意味着两个权威 → 重新召回 mirror/一致性问题,正是 §3.2 消灭的东西;
- 排除集:governance_gate 全部(5 条)+ kill_switch 中 live re-arm 契约的(`codex_hard_gate_killswitch`、`merge_approval_gate_killswitch`、`qa_done_gate_killswitch`、`mailbox_queue` 等 dotenv_live/verify-approval 族)——名单在 M0 以**代码事实**核定,真源 = `readEnvValueFromContent` 的全部调用点,**不抄 registry timing**。两个已知的登记陷阱证明这条纪律不可省:`codex_hard_gate_killswitch` 的 live `.env` 读点(`verify-approval.ts:292`)被**故意不登记进 readSites**(registry.ts:390–397 明写,为了让 `isDirectToggleable` 放行);`founder_attribution_gate` 声明 `cli_invocation` 但实际 live 读 `.env`;
- 排除的 flag 一切照旧:`.env` + 现有 direct-toggle 链(如果 direct)或重启(如果 frozen)。安全 re-arm 契约零触碰;
- `.env` 文件本身永不退役:它同时承载 `TEAMLEAD_API_TOKEN` / `DISCORD_OWNER_USER_ID` 等非 flag 内容,且 default-on 门依赖「key 缺失 = ON」的 re-arm 语义。

### 3.6 翻转入口与审计 → 复用既有 stage/apply 链,不造新面

- 复用 stage → confirmToken → apply 模式;⚠️ R1#5 实核:console 与 CLI 不共路由——v1 只扩 **CLI 路由**(`/api/fleet/flag/*`)的 managed 分支(新 canonical kind,legacy 字节不变),apply 从「写 .env + 改 process.env」换成「写 store 行(CAS revision)+ 同事务 changelog」;
- 审计双层:`fleet_admin_audit`(既有,入口层 staged/apply-result/denied)保持;值层新增 `flag_value_changelog`(who/when/old→new/reason,同事务)——满足验收测试 #5「每次操作留审计行」;
- Tadashi「CLI 或 dashboard 二选一即可」:**取 CLI**。Codex R1#5 实核推翻了「两入口共路由」的早稿假设——dashboard 走的是 `/api/fleet/changes/stage|apply` + `management-existing-writers.ts`,与 CLI 的 `/api/fleet/flag/stage|apply` 是两条路;v1 只扩 CLI 路由,dashboard 对 managed flag 只读(渲染 store 值 + 拒因),写面支持开 follow-up。

### 3.7 与 drift guard(FLY-1455)的三处硬撞——设计内解决

1. **reverse 扫描 fallthrough**:store-managed 读点文件里没有 envVar 字面量会当场红 → readSite 用 `delegated` pattern 指向**per-flag 具名 wrapper**(泛型 accessor 过不了 flag 级证据——`delegatedEvidence()` 只验 import+调用不验 flag 名实参;drift 测试的 delegated 精确 roster 需同步更新。Codex R1#2);
2. **`FlagSource` 联合类型**不加 `"db"`——v1 纳管的仍是 env 源 flag(store 是**值的存放处**,不是新的 source 类别);`FlagView` 加可选 `storeManaged` / `storeEffective` 展示字段即可(FLY-1150 的 enrich 旁路模式,`resolveFlag` 函数体不动);
3. **store 自身的开关**(如逃生口 env)注册成 registry 行,不塞 exemption——治理 flag 的机制自己必须受治理。

另加一条 FLY-1150 没有的守卫:**store 侧 tombstone 检查**——写入/读取时对 `RETIRED_FLAGS`(truth.ts,179 条)fail-loud,防止 DB 值源绕开第 1、2 批焊死的退役网。

## 4. 四件套映射(交付物 = 且仅 = 这四件)

| # | 四件套 | 落点 |
|---|---|---|
| 1 | 单一 source of truth 一张表 | StateStore `flag_values`(含 `value_last_changed`)+ `flag_value_changelog` |
| 2 | 运行时读取接进现有 resolve 层 | Bridge 进程内 read-on-use accessor + FlagView enrich 旁路;`resolveFlag` 本体不动 |
| 3 | 一个带审计的翻转入口 | 复用 stage/confirmToken/apply 链,apply 加 managed 分支;审计 = fleet_admin_audit + 值层 changelog |
| 4 | 安全白名单保持 .env | 结构性排除(= 留 legacy),M0 以代码事实核定名单 |

## 5. 明确不做(执行体越界即停,开新单进 backlog)

- 分环境 / 灰度 / 百分比 rollout;flag 依赖图;历史回滚(changelog 只读可查,无回滚按钮);UI 大盘/可视化平台(console 只做既有面的最小扩展);
- cutover epoch 状态机、`.env`↔DB mirror reconciler、value clock sweep(§3 已消掉存在理由);
- 跨进程 DB reader(cli_invocation / dotenv_live 读点的 flag 不纳管);
- project_config flag 纳管(11 条,值在各项目 config.yaml,已是 call_time;免 PR 翻它们是另一形态的问题);
- 10k 行 manifest JSON 入仓(M0 产物 = doc 文件夹里的人读表格);
- 不碰 `main`、不碰 founder-gate、不做 HTML 页内留言回传(FLY-298)。
- 红线(FLY-1455 继承):不做「创建时必须声明退役条件」门,`longTermKeep` 无创建时 CI 断言(Annie 亲手砍过,守护测试必须保持绿)。

## 6. 开放问题(已全部在 research / plan 落定——本节保留作决策记录,以 research/plan 为准)

1. M0 manifest 形态 → plan §1(46 条逐条 + 导入常量追踪 + 调用图;早稿「预估 15~25 条纳管」被证伪,A 桶候选实为 5 条且只可缩);
2. restart-frozen 6 读点 → research §1.3(逐名列出;手术拆 follow-up,本单只立据——R1#10);
3. DDL → research §2.1(单列 PK,差异表逐条说明理由;+ `flag_store_meta` 旁路围栏);
4. apply 事务编排 → research §2.4 + plan §2.3(legacy canonical 字节不变,managed 新 kind;审计契约仅 managed 补齐);console 显示 → plan §4.2(读模型改 `writable=false`,非仅 preflight);
5. 逃生口/失败契约 → plan §3.2 真值表(**无 legacy 回落**——R1#3 推翻回落;唯一逃生 = `FLYWHEEL_FLAG_STORE=0` + durable 围栏 + `bypass_recovery` 保守推进钟);
6. 量级 → research §4(现估 **~1,320 功能行**,M0 复审后复核;自检线取 2k 硬停,严于 Tadashi 的 5k 原线)。
