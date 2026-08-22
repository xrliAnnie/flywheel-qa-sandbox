# FLY-1778 动态 flag store 重做 — 实施计划

Issue: FLY-1778 (https://linear.app/geoforge3d/issue/FLY-1778/flag治理地基第3批-动态-flag-store-重做-值存-sqlite-read-on-use-产出-value-last)
日期: 2026-08-21
基于: research.md(v2:并入 Codex design review R1 十项裁定)

---

## 0. 交付边界(执行体越界即停)

**只做四件套**:① StateStore 两张值/账表(`flag_values` 含 `value_last_changed` + `flag_value_changelog`)+ 一张就绪围栏表(`flag_store_meta`,单行);② Bridge 进程内 read-on-use(per-flag 具名 wrapper)+ FlagView enrich 旁路;③ **一个**带审计的翻转入口 = 既有 CLI stage/apply 路由(`/api/fleet/flag/stage|apply`)加 managed 分支——**dashboard v1 只读**(R1#5:两面不共路由,「二选一」取 CLI);④ 安全集结构性排除(= 留 legacy)。

**明确不做(v1)**:epoch/cutover、`.env`↔DB mirror、周期 sweep、跨进程 DB reader、project_config 纳管、value 类纳管、灰度/依赖图/回滚/UI 大盘、manifest JSON 入仓、**dashboard 写面**(follow-up)、**changelog 分页 GET**(表+内部查询方法足够,R1#10)、**6 处 restart-frozen 读点的 call-time 手术**(R1#10:独立于四件套的行为手术,拆成 FLY-1405 残余 follow-up 单——此为对 issue 原文范围 3 的一次显式收窄,在 M0 复审时报 Tadashi 确认)、**FLY-1781 扫描消费改造**(本单只产出契约,消费升级开显式 follow-up;M0 复审时一并报备,R1#7)。

**量级自检线**:功能码估 **~1,320 行**(分项见 research §4;M0 复审后复核);2k 硬停线未动。**最终定规模在 M0 复审之后**——M0 是硬门,门前零 schema、零实现代码(R1#1:原「表结构可先行」例外删除)。

**红线**:不碰 `main`、不碰 founder-gate;`longTermKeep` 无创建时门守护测试保持绿;`.env` 文件永不退役;B 桶(安全保护)flag 的既有 stage/apply 路径**逐字节不变**。

## 1. M0 — 读点 manifest(硬门;门前不写任何 M1+ 代码)

**产出**:`m0-manifest.md`(人读表格,严禁 JSON 入仓)。46 条逐条:flag / envVar / 读点全集 / 真实进程归属 / live `.env` 读与否 / writer 盘点 / 分桶判词。**A 桶候选每条附机器可核的调用图**:package、进程、raw 来源、timing、注入 seam(R1#1)。

**方法(R1#1 修订——字面量 sweep 不够)**:
1. `readEnvValueFromContent` 全调用点(live `.env` 读真源);
2. envVar **字面量** sweep(多形态)**加** **导入常量追踪**:凡 registry envVar 有导出常量(如 `SKILL_FRAMEWORK_MODE_ENV`),追它的全部 import 点再逐个核对——已实锤的隐藏读者:`skill_framework_mode` 在 `packages/edge-worker/src/Blueprint.ts:1190`、`packages/teamlead/src/bridge/runs-route.ts:1220`、`run-dispatcher.ts:663` 经常量直读;`workflow_resume` 在 `workflow-engine-dispatcher.ts:1755/:1860`(registry 只登记了 runs-route);
3. 凡经 owning resolver(如 `resolveSkillFrameworkMode`)间接读的,把 resolver 的调用图也画全;
4. FLY-1405 承接 10 条现存幸存者逐条终审;restart-frozen 6 读点逐处记录现状(为 follow-up 单立据,本单不动它们)。

**门**:manifest 提交 → `flywheel-comm ask` Tadashi 复审,内容含:A 桶终审名单(**只可缩不可扩**;某候选注入 seam 代价不成比例即缩)、重估行数、两处显式收窄报备(frozen 读点手术拆单、B3 消费拆单)。复审通过才动 M1;等待期做的只能是文档/测试设计草稿,不落 src。

## 2. M1 — store 表 + 写路径(TDD)

### 2.1 StateStore(`packages/teamlead/src/StateStore.ts`)

- `migrateFlagValueStore()`:research §2.1 DDL(照抄 `migrateFlagRetirementScan()` 幂等形态)挂 `migrate()` 尾部;
- 方法(全 prepared statement,写全部走 better-sqlite3 单事务):
  - `getFlagValueRow(name)` → `{hasOverride, raw, lastEffective, valueLastChanged, revision} | undefined`(**返回 raw 在场性,不返回预算好的 effective**——R1#4:解析交给 owning resolver);
  - `applyFlagValueChange({name, rawTo, expectedRevision, actor, reason})` — 事务内:**独立准入**(name ∉ STORE_MANAGED_FLAGS 或 ∈ RETIRED_FLAGS → typed reject,R1#8:防未来进程内调用方绕过路由写 rogue 行)→ CAS revision → 用该 flag 的 codec 算 old/new effective → 写行(**每次写 revision+1,含同值重写与 default_shift**,R1 好评项)→ 同值不动 `value_last_changed` → **changelog 插入在同一事务内**(R1#6:变更与账不可分离);
  - `ensureFlagValueRows(...)` — §2.4;
- **RED 先行** `flag-value-store.test.ts`:migrate 幂等 ×2;CAS 冲突;同值重写不拨钟但 revision+1;raw canonical 差异不算值变;clear 保行;seed `value_last_changed=NULL`;default_shift 观测钟 action 可辨;**mutator 独立拒 B 桶/退役名**(R1#8);changelog 与值同事务(注入 changelog 失败断言整个事务回滚)。

### 2.2 store-policy + per-flag codec(`packages/config/src/feature-flags/store-policy.ts`,新)

- `STORE_MANAGED_FLAGS`(M0 终审 A 桶)+ `PROTECTED_LEGACY_FLAG_NAMES`(B 桶)+ `getStoreEligibility(spec)`(缺席即拒);
- **per-managed-flag codec**(R1#4 + R2#2):`{parse(raw|absent) → effective, canonicalEffective}`,seed / boot 对账 / stage 展示 / 事务比较四处共用;bool 类复用现行两 idiom;`skill_framework_mode` **两层显式拆开**(R2#2:`split` 是 env-only 元值不是 SkillFrameworkMode,`resolveSkillFrameworkMode` 需要 issueIdentifier 做 per-issue arm 解析,store 无此上下文)——**codec 只 canonical 全局控制值**(`superpowers|matt|bare|bare-ponytail|split`,absent/空/非法按现行控制语义映射)用于钟比较;**运行时集成把 store 的 raw 在场性/值喂给既有 owning resolver 于真实调用点**(issue 上下文与 `via` 归属全保留,StateStore 绝不预解析 `split`);迁移/热翻测试覆盖 absent/显式默认/空/非法/各强制 arm/`split`×至少两个 issueIdentifier;
- **seed 保留一切在场 raw**(含显式默认值、空串、非法串——owning parser 怎么容错就怎么容错;修正 exploration 早稿「非默认才收」的错误口径,R1#4);
- 具名集合守卫:A 桶逐名断言;B 桶断言 governance 全拒 + 已知隐藏读点 flag 必在保护集;`flag_store` 逃生 flag 注册 registry 且**永不纳管自身**。

### 2.3 翻转入口:CLI stage/apply 路由 managed 分支(`flag-routes.ts`)

- **canonical 判别**(R1#8 + R2#4:不污染 legacy 字节):**legacy `FlagCanonical` 形状与行为逐字节不变**(`kind:"flag"`,无新字段);managed 走**新判别形状**(如 `kind:"flag_store"`,含 `revision/rawFrom/actor/reason`);进路由先按 store-policy 分支,B 桶 direct flag 走 legacy 分支**照常成功且字节不变**(不是 400);
- **审计契约(仅 managed 分支,R2#4)**:managed stage 时 `audit.record("staged")` 返回值**必须检查**,失败拒发 token;managed apply 前补 `apply-requested`,失败拒入事务;`apply-result` 事后写失败降级 warning + 既有对账兜底(**如实文档化:事后账无法回溯 fail-closed**);**legacy 分支的审计行为一字不动**;
- **actor + reason(仅 managed)**:CLI 加 `--reason`(非空校验);actor 诚实化(R2#5:`/api/fleet/flag/*` 挂载在 Bearer 中间件之前,loopback + same-origin,server **无法**区分 CLI 与其他本机同源调用方)——记录**稳定的 server 侧本机操作面主体**(如 `bridge-local-operator`,文档写明这是「本机操作面归属」而非调用者身份;更强的调用者认证 = follow-up),**调用方自报的 actor 字段一律忽略(有测试)**;actor + reason 进 managed canonical 与 confirmToken 哈希;
- apply(managed):调 `StateStore.applyFlagValueChange`;**不写 `.env`、不改 `process.env`**;`flag-toggle.ts` 对 managed flag 409 指路;
- CLI 消费端 `packages/flywheel-comm/src/commands/feature-flags.ts` 同步 `--reason` 与 managed canonical 显示;
- **RED 先行**:legacy/managed 分流;B 桶经 legacy 照常成功 + 无法取得 managed canonical/token(R1#8 四点负测的 a/b);staged 审计注入失败 → 无 token;apply-requested 注入失败 → 无变更;reason 空 → 400;stale revision token → 409。

## 3. M2 — 读路径(per-flag wrapper + 注入 seam,逐 flag 一 commit)

### 3.1 读原语与 wrapper(R1#2:泛型 accessor 不构成 flag 级 drift 证据)

- teamlead 内私有原语 `readFlagValueRow(store, name)`;对每条 A 桶 flag 导出**具名 wrapper**(名字静态绑定 flag,如 `storeWorkflowResumeEnabled(store)`);bool/enum 简单 flag 的 wrapper 返回 codec 解析的 effective;`skill_framework_mode` 的 wrapper 返回 **raw 控制值在场性**(R2#2),由调用点喂给 owning resolver;
- registry `readSites` 逐条改指 `delegated` pattern——**并同步更新 `feature-flags-drift.test.ts:249-267` 的 delegated 精确 roster**(R1#2);
- **跨包读者不反向 import + drift 证据落点**(R1#2 + R2#3):`delegatedEvidence()` 要求登记文件真 import + 调用 wrapper,而 Blueprint 拿到的是注入闭包不会 import——所以 **registry 的 canonical delegated 读点登记在 teamlead 组合点 `run-infra.ts`**(它真 import + 调用 wrapper 并注入),Blueprint 在 M0 manifest 里记为「下游注入消费者」;加聚焦回归:注入的控制值同时驱动 Blueprint 的 split-participation 检查与 resolver 输入。若 M0 判此证据形态不够(或 seam 代价不成比例)→ `skill_framework_mode` 缩出 A 桶,**不在本单扩 drift scanner**。

### 3.2 失败契约与旁路生命周期(R1#3 + R2#1 + R3#1/2:真值表钉死,**boot-only 旁路**)

- **删除 legacy thunk 回落**。managed 读与 StateStore 其余读写同一契约:错误**向上传播**,不吞不落;
- **旁路是 boot 级状态,不是运行时开关**(R3#1):`flag_store` 逃生 flag 注册为 **readonly + `bridge_boot` timing**——Bridge 启动时在 flag ensure 之前快照一次,wrapper 查询的是这份 boot 态,**绝不逐次重读 `process.env`**;进/出旁路 = 改 `.env` + 重启。若它可 direct 翻转,legacy 路由一写 `process.env`,下一次 wrapper 读就切权威而绕过 boot 围栏——正是钟洞本身。**守卫测试:该 flag 过不了 `isDirectToggleable`,两个写面(flag 路由 + management writer)都拒它**;
- **真值表**:
  - **正常 boot(旁路 OFF)**:migrate → ensure(失败 = 启动失败)→ 就绪 → readers 上线;就绪后行缺失 = invariant throw;
  - **旁路 boot(`FLYWHEEL_FLAG_STORE=0`)**:**跳过 flag ensure 的 gating**;wrapper 走各 flag 迁移前 env 语义;managed apply 一律 409(值不漂);FlagView 全部 managed flag `clockReadiness = "no_clock:bypass"`;**best-effort 写 durable 旁路围栏**(`flag_store_meta.bypass_seen=1`;store 完全不可写时写不进——见如实边界)。**范围如实**(R3#1):`StateStore.create()` 的 migrate 在 ensure 之前同步跑,Bridge 对 StateStore 的其余依赖不受此旁路豁免——旁路兜的是 **flag store 自身的 ensure/读权威故障**,不是 StateStore 打不开;
  - **恢复 boot(旁路 OFF 且 `bypass_seen=1`)**:**单一 SQLite 事务**(R3#2)——校验 policy/tombstone → 每条 managed flag:有行则推进、**无行则 recovery-seed**(首次部署即旁路的分支:按当时 env raw 在场性建行,`bypass_recovery` 语义、钟**非 NULL**)→ 统一用同一个事务级 `now` 置 `value_last_changed`、每行 revision+1、**当前 codec 结果刷进 `last_effective` 与 changelog `to_effective`**(R4#3:旁路期 default 可能变过,不刷会让下一正常 boot 多报一次 `default_shift`)、插 `bypass_recovery` changelog(system actor + reason)→ **同事务内清 `bypass_seen`**。任何错误整体回滚、围栏保持、不发布 `ready`——围栏绝不能在部分时钟推进后先清(crash 会让下一次 boot 谎报 ready);
- **如实边界**:store 整库不可写导致围栏写不进的旁路窗口,恢复依赖修复它的那个 reviewed PR 显式带钟失效步骤(修复纪律写进 store-policy 注释与本计划;不造更重的机器去覆盖这个双重故障角);扫描侧 `no_clock` 是 **FlagView/UI 契约**——现役 `canonicalizeFlagSample()` 不读新字段,扫描消费属 follow-up;
- RED:写后下一读即新值(绝不 boot 快照 managed 值);就绪前构造 reader → 拒;就绪后删行读 → throw;旁路期间 apply → 409;旁路中改 env → 恢复 boot 后 `bypass_recovery` 落账 + 钟推进(E2E);**旁路中改 registry default → 恢复后 `last_effective` 已刷新、下一正常 boot 不重复 `default_shift`**(R4#3);**首次部署即旁路 → 恢复 boot recovery-seed**;**恢复事务中途注入失败 → 全回滚 + 围栏在 + 重试幂等(保守可重 bump)**;恢复后 stale revision token 失效(R3#2)。

### 3.3 boot ensure 时序(R1#9)

- 位置:`plugin.ts` `StateStore.create()`(migrate 完成)之后、**任何 managed reader / dispatcher / 路由 / console 快照 / 扫描器构造之前**;
- ensure 单事务逐 flag:无行 → seed(raw = 当时 env 原样,含空串;`value_last_changed=NULL`;changelog `seed`);有行 → codec 重算 vs `last_effective`,漂移 → `default_shift`(观测钟)+ revision+1;**ensure 失败 → Bridge 启动失败**(与既有 migrate 失败同契约,fail-closed;**仅正常 boot——旁路 boot 刻意跳过此 gating**,见 §3.2 真值表);
- 行在但名字 ∉ 纳管集 ∪ ∈ RETIRED_FLAGS:**启动失败前置检查报错并指明出路**——退栈(un-enrollment)是**显式 reviewed migration 步骤**,且 R2#7 裁定:现 DDL 的 changelog action CHECK 不含退栈形态,**本单不预铸 `unenroll` 表示法(YAGNI)**;计划只规定「未来退栈 PR 必须先引入表示它所需的 schema/migration,再删名单」,绝不 boot 静默删;
- RED:seed / default_shift / 退役行 fail-loud / ensure 失败阻断启动 / 时序(先 ensure 后 reader)守卫。

## 4. M3 — 消费面 + E2E + 收尾

1. **FlagView enrich**:`storeManaged` / `storeEffective` / `valueLastChanged` / `clockReadiness`("ready" | "no_clock:{bypass|degraded|unmanaged}")可选字段(R1#7:就绪态显式化);`resolveFlag` 本体零 diff(守卫);
2. **dashboard/手机报告 v1 只读**(R1#5 + R2#6:光 preflight 拒不够——`flagManagedValue()` 的 `writeCapability.writable` 与手机报告的 `isFlagViewDirectToggleable` 仍会把 managed flag 渲染成可写,点了才失败):**读模型一并改**——managed flag 投影 `writable=false` + CLI 拒因,手机报告抑制其控件;writer preflight 拒 managed 保留作纵深;两层都有测试(渲染 disabled 态 + coordinator 拒);
3. **免重启 E2E**:真 Bridge → CLI stage/apply 翻 `workflow_turn_divergence_alerts` → 不重启断言下一读新值 → 全链路零 git 操作断言;
4. **安全反向**(R1#8 负测 c/d):StateStore mutator 拒 B 桶名;手工注入 B 桶行 → wrapper 不消费 + boot 前置检查报错;`codex_hard_gate_killswitch` 的 `verify-approval` live `.env` 读行为逐字节不变(真 `.env` fixture);B 桶 direct flag 经 legacy stage/apply 全流程照常成功;
5. **follow-up 立单**(在 PR body 与 M0 复审报文点名):① FLY-1781 扫描消费 `value_last_changed`(含 NULL 种子语义 / no_clock 分类);② 6 处 frozen 读点 call-time 手术(FLY-1405 残余);③ dashboard 写面 managed 支持;
6. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + drift 守卫(含更新后的 delegated roster)+ `longTermKeep` 红线绿。

## 5. 验收测试矩阵(issue 六条)

| issue 验收 | 落点 |
|---|---|
| 1. store 写读/`value_last_changed` 正确落账,同值重写不误触 | M1 §2.1(事务内结构性成立 + 显式边界用例) |
| 2. 迁移回归:逐读点前后行为一致 + absent-read 对照 | M2 §3.1 每 flag commit 内置(seed 收编现值;absent = 行无 override → codec default,与迁移前 env-absent 行为逐条对照实测) |
| 3. 免重启 E2E + 全链路不碰 git | M3 §4.3 |
| 4. 安全白名单反向 | M3 §4.4 |
| 5. 审计:每次操作 who/when/old→new,缺审计即 FAIL | M1 §2.3(staged/apply-requested fail-closed + changelog 同事务 + reason NOT NULL;apply-result 事后账的对账兜底如实标注) |
| 6. CI 全绿 + 真 Bridge 路径验证 | M3 §4.6 + QA 节点真 Bridge 复验 |

## 6. 风险与回退

| 风险 | 处置 |
|---|---|
| M0 发现更多隐藏读者(已实锤 2 例) | 硬门 + 导入常量追踪法;A 桶只缩不扩 |
| store 运行时故障 | 与 StateStore 同故障域(同进程同库):错误传播不吞;应急 = `FLYWHEEL_FLAG_STORE=0`(apply 冻结 + no_clock 显式化) |
| 部署回退(revert PR) | 表与行留库无害(读点回 env);无破坏性 schema 变更 |
| 误纳管安全 flag | store-policy 拒绝顺序 + mutator 独立准入 + 具名集合守卫 + M3 反向用例四层 |
| 钟被降级窗口污染 | 旁路即 no_clock、apply 冻结;就绪态在 FlagView 显式字段,消费方可辨 |

## 7. 分支与 ship

分支 `flywheel-FLY-1778`,PR base `main`,文档随分支;里程碑 + doc 归档为 PR 最后一环;merge founder-gated(`verify-approval`),本设计节点不请求 ship。
