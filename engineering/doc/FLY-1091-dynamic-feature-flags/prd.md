# FLY-1091 动态 Feature Flag(方案 A)— PRD

Issue: FLY-1091 (https://linear.app/geoforge3d/issue/FLY-1091/feature-flag-该怎么定-怎么管-research-设计我们的-flow小团队不-over-engineering)
日期: 2026-07-10
基于: product/doc/FLY-1091-feature-flag-policy/{exploration.md, research.md, audit.md} + 5 轮 co-eval explainer(Annie 已圈定方案 A);Codex design review R1-R5 已并入

**Version**: v5(并入 Codex R1 7 项 + R2 6 项 + R3 5 项 + R4 5 项 + R5 2 项;Codex 5 轮 APPROVED;收 PRD 前仍需 Tadashi eng-reality-check)
**Status**: codex-approved (Codex design review 5 轮 APPROVED)
**Owner(产品)**: Annie + Honey Lemon · **Owner(工程)**: Tadashi

---

## 0. 一句话

把 Feature Flag 的「开/关值」从「散在 Bridge 全局 `.env`、进程启动读死、改了要重启」,改成「存在 Bridge 已有 SQLite 的**三张新表**里、进程通过一个**共享只读 reader**用到时现读、Dashboard 改完立即生效、不重启、每项目一份」。**方案 A 已由 Annie 在 co-eval 中选定;本 PRD 把它写到 Tadashi 照着能建。**

> ⚠️ Codex R1+R2 纠正的关键事实本版已全部改正:(a) 读方是 **Bridge/Lead/Runner 多个独立进程** → 跨进程 reader 契约(§5.6);(b) `resolve.ts` 只是展示解析器,不是生产决策点 → 迁移读侧先行(§7);(c) 数量 83 = **77 env + 6 project_config**、10 direct(§1);(d) per-project 与「无损回滚到任意旧 binary」不可兼得 → **cutover-epoch 模型**(§5.9);(e) CLEAR 用 **tombstone** 不删行(防 CAS ABA,§5.4);(f) changelog 用**结构化列**不用 sentinel 字符串(§5.2)。

---

## 1. Problem(病根,数字按实际 registry 校正)

来自 Annie 原话 + 代码审计 + Codex 实跑 `FEATURE_FLAGS` 校正:

1. **改一个 flag 要重启整个项目 —— 不可接受。**
   - 83 个 flag = **77 env-source + 6 project_config-source**;`toggleable` = **10 direct / 51 conversational / 22 readonly**。
   - read-site timing(读点计):`call_time=54, object_construction=15, bridge_boot=5, mixed=16, cli_invocation=3`。**45 个 flag 全部读点是 `call_time`,38 个 flag 含非-call_time 读点。**
   - 关键:**「非 direct」(73)≠「启动读死」。** 真正「必须改读点代码」的规模由 §7 的 M0 迁移 manifest 得出,不写死一个数。
2. **flag 值不分项目。** 77 个 env spec 当前**全部 `scope: "bridge_global"`**(`resolve.ts:143-160` 只返回单一 effective);想「某项目先开、别的先不开」今天做不到。
3. **值/意图不分。** registry **只记定义**(flag 是什么、valueKind、readSites);当前展示值由 `resolve.ts` 从 env/config 计算(`resolve.ts:121-196`)。二者都**不记「意图」** —— 分不清关着的 flag 是「故意关」还是「忘了开」。
4. **只增不减。** env flag 一周 40→77,**从未删过一个**。
5. **「代码合了 ≠ 功能活了」。** merge 与 enable 之间的空窗(FLY-929 睡 2 天、auto-QA 数周没触发)。

> 本 PRD 主攻 (1)(2)(3)。(4)(5) 的清理规范 + 83-flag 逐条 audit = **FLY-1136**;本 PRD 只落数据基础(intent 字段 + changelog),不实现清理/提醒/用量机制。

---

## 2. Users
- **唯一用户 = Annie(founder)。** Dashboard(FLY-1038)按项目自助开关、立即生效、不重启、不找工程。
- **读方 = 确有 flag 读点的进程**(Bridge / Runner;Lead 是否有真实读点由 M0 核实,**没有就不当 reader**,§5.6/§10)。它们是独立 OS 进程 —— 本设计核心约束。

## 3. Goals
- **G1** 改一个已迁移 flag **不重启**即生效,延迟 **即时~几秒**(不是「每小时」)。
- **G2** flag 值 **per-project**。
- **G3** Annie 在 Dashboard 自助开关、不走 PR;每次改留 changelog。
- **G4** 值和意图分开记:能查关着的 flag「为什么关 / 谁定的 / 到期日(仅记录)」。
- **G5** 不引入新服务、不上外部 flag SaaS;复用 Bridge 现有 SQLite + 现有鉴权控制面。

## 4. Non-Goals
- ❌ per-user A/B / 百分比放量;❌ 自托管 Unleash;❌ 权限分层。
- ❌ 83 个 flag 逐条 enable/disable 裁决 → **FLY-1136**。
- ❌ 本期不实现「用量命中统计 / 到期提醒 / 自动清理」——只留 nullable data 字段(§5.7)。
- ❌ 不迁运维紧急 kill switch / 治理门(默认留旧路径,逐个评估)。
- ❌ 不 ship、不碰 founder-gate、不改 main。

---

## 5. ⭐ 方案 A — 动态 flag store(核心设计)

### 5.1 store = Bridge 现有 SQLite 加三张新表
- Bridge 已跑 native SQLite:`StateStore`(better-sqlite3,FLY-663),库 `~/.flywheel/teamlead.db`(`config.ts:100-105`),已启用 **WAL + `synchronous=NORMAL` + `busy_timeout=5000`**,有同步事务包装(`StateStore.ts:115-120`),**当前 16 张表**。
- flag store = **`feature_flags`(第 17 张,current-value)+ `feature_flag_changelog`(第 18 张)+ `feature_flag_cutover`(第 19 张,epoch/mirror 的持久权威状态,§5.9)**。不新起 DB、不新起服务。

### 5.2 表结构(每项目一份 + tombstone CLEAR + 结构化 changelog)

```sql
-- 第 17 张:每行 = 一个 scope 对一个 flag 的 override(含 tombstone 行)
CREATE TABLE IF NOT EXISTS feature_flags (
  scope_kind   TEXT    NOT NULL,          -- 'project' | 'global'(显式列,不用魔法项目名,R1#4)
  project      TEXT    NOT NULL DEFAULT '',-- project 时非空;global 时必须 ''
  flag_name    TEXT    NOT NULL,
  has_override INTEGER NOT NULL,          -- 1=有 override;0=tombstone(= 无 override,回退 legacy)。CLEAR 不删行(R2#2)
  raw_value    TEXT,                      -- has_override=1 时非空;=0 时 NULL。读时按 registry.valueKind 解析
  intent       TEXT,                      -- nullable,data-only
  expires_at   INTEGER,                   -- nullable,data-only(本期不实现提醒,§5.7)
  revision     INTEGER NOT NULL,          -- 对 key 永久单调(CAS,§5.4);create/clear/set 每次 +1,绝不因删行重置
  updated_by   TEXT    NOT NULL,          -- server 可信上下文生成,不信浏览器
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, project, flag_name),
  CHECK (scope_kind IN ('project','global')),
  CHECK ((scope_kind='global' AND project='') OR (scope_kind='project' AND project<>'')),
  CHECK (has_override IN (0,1)),
  CHECK ((has_override=1 AND raw_value IS NOT NULL) OR (has_override=0 AND raw_value IS NULL)),
  CHECK (revision > 0)
);
CREATE INDEX IF NOT EXISTS idx_ff_flag ON feature_flags(flag_name);

-- 第 18 张:每改一次一行;结构化列区分 never-set / explicit / clear + metadata(R2#3 + R4#4)
CREATE TABLE IF NOT EXISTS feature_flag_changelog (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_kind   TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', flag_name TEXT NOT NULL,
  action       TEXT NOT NULL,            -- 'set' | 'clear' | 'metadata'(仅改 intent/expires)
  from_present INTEGER NOT NULL,         -- 0 = 此前无 override;1 = 此前显式值
  from_raw     TEXT,                     -- from_present=0 时 NULL
  to_present   INTEGER NOT NULL,         -- set→1;clear→0;metadata→与 from_present 相同
  to_raw       TEXT,                     -- to_present=0 时 NULL
  from_intent  TEXT, to_intent   TEXT,   -- G4:intent 前后(R4#4,可回看改了什么)
  from_expires INTEGER, to_expires INTEGER, -- G4:expires_at 前后
  changed_by   TEXT NOT NULL,            -- server 生成
  changed_at   INTEGER NOT NULL,
  reason       TEXT,
  CHECK (action IN ('set','clear','metadata')),
  CHECK (scope_kind IN ('project','global')),
  CHECK ((scope_kind='global' AND project='') OR (scope_kind='project' AND project<>'')),
  CHECK ((action='set' AND to_present=1) OR (action='clear' AND to_present=0) OR (action='metadata' AND to_present=from_present)),
  CHECK ((from_present=1 AND from_raw IS NOT NULL) OR (from_present=0 AND from_raw IS NULL)),
  CHECK ((to_present=1 AND to_raw IS NOT NULL) OR (to_present=0 AND to_raw IS NULL))
);

-- 第 19 张:每 flag 的 cutover epoch + mirror 的持久权威状态(R3#1 — epoch/pending 不能只在内存)
CREATE TABLE IF NOT EXISTS feature_flag_cutover (
  flag_name           TEXT    NOT NULL PRIMARY KEY,
  epoch               TEXT    NOT NULL,   -- 'shadow' | 'global-compatible' | 'project-capable'
  epoch_revision      INTEGER NOT NULL,   -- epoch 转移的 CAS 版本,单调 +1
  mirror_state        TEXT    NOT NULL,   -- 'in_sync' | 'pending'(仅 global-compatible 期有 pending)
  mirror_target_rev   INTEGER,            -- pending 时:要镜像到 .env 的目标 feature_flags.revision;非 pending 时 NULL
  last_mirror_error   TEXT,               -- 最近一次镜像失败原因(nullable)
  last_attempt_at     INTEGER,
  CHECK (epoch IN ('shadow','global-compatible','project-capable')),
  CHECK (mirror_state IN ('in_sync','pending')),
  CHECK (epoch_revision > 0),
  -- R4#3 固化 state machine 不变量:
  CHECK (mirror_state='in_sync' OR (mirror_state='pending' AND epoch='global-compatible' AND mirror_target_rev IS NOT NULL AND mirror_target_rev > 0)),
  CHECK (mirror_state='pending' OR mirror_target_rev IS NULL)
);
```
- **epoch 转移**:只允许合法单调边(`shadow → global-compatible → project-capable`),用 `epoch_revision` CAS;`→ project-capable` 前必须 `mirror_state='in_sync'`。epoch 转移写**现有 durable admin audit**(不塞进 value changelog —— R4#4)。
- **cutover row 缺失语义(R4#3,延续 §5.8 无行≠读失败)**:**未纳管/legacy** —— reader 返回 legacy、Dashboard mutation 拒绝;只有受控的 M0/M2 transition 能创建 shadow row。`missing-cutover-row` 与 `cutover-query-error` 分开测。
- **这张表是 epoch/mirror 的唯一持久权威**:reader 按 `epoch` 决定「返回 legacy 还是 DB」,writer 按 `epoch` 决定是否允许 project override,reconciler 按 `mirror_state='pending'` + `mirror_target_rev` fencing 恢复 `.env`(§5.9)。

**CLEAR = tombstone**:CLEAR 不删除行,而是把 `has_override` 置 0、`raw_value` 置 NULL、`revision+1`。reader 把 tombstone 当「无 override」→ 回退 legacy(project config / env / registry default)。**为什么不删行**:删行会让 revision 重置,配合 CAS 产生 ABA(R2#2)——create→clear 后又回到「无行」,stale token 可蒙混过关。tombstone 保证 revision 对 key 永久单调。

### 5.3 读机制:共享只读 reader + read-on-use
- 每个确有读点的长期 reader 进程,持一个 **`readonly` + `fileMustExist` 的 better-sqlite3 连接 + 预编译主键点查**(长期连接;**不每次判断重开库**;**不调 `StateStore.create()`**——那会跑 migration)。
- Dashboard 改 → Bridge 写行 → reader 下次判断该 flag 主键点查读到新值(WAL 下跨进程读见已提交写)。
- **性能(答 Annie §2 + Codex 收紧)**:warm 长连接 + 预编译主键点查 ≈ **1µs/次**(Codex 实测);但 open+query+close ≈ **0.21ms/次** → **长期进程**的连接生命周期是硬约束(不每次重开)。**短命 CLI reader** 可每 invocation open/close(~0.21ms,可接受)。reader 用 **readonly** 连接(WAL 正常 point read 不等 writer)。**busy_timeout 是每连接 pragma、不会从 writer 继承到 reader**:reader 用自己**短而有界**的 busy timeout,遇 `SQLITE_BUSY` 按 §5.8 fail policy 处理,绝不长时间同步阻塞 event loop。**明确不是「每小时」。**
- **读点查询与用量统计拆开**:本期**不在每次命中同步写 SQLite**;用量/命中信号若 FLY-1136 需要 → 进程内聚合 + 异步批量 flush,或整体归 FLY-1136。
- **可选 TTL cache**:仅极热读点;它把「下次判断即新值」变成 bounded-staleness(几秒),**必须给每 flag 定 SLA + invalidation**,默认不用。
- ⚠️ eng-reality-check(Tadashi):reader 连接生命周期、热读点、readonly 跨进程一致性,收 PRD 前过一眼。

### 5.4 写 / 自助契约(复用鉴权外壳 + monotonic-revision CAS)
现有 stage/apply(`plugin.ts:1278-1326`、`flag-routes.ts`、`flag-toggle.ts`)**只复用鉴权外壳**(loopback + same-origin + 单次 confirmToken + admin audit),**不复用 `.env` 事务**。新 DB 写契约:
1. **stage**:server 校验 canonical `{scope_kind, project, flag_name}` 合法、值合 `valueKind`/enum;confirmToken **绑定所有可变字段**:scope+project+action(set/clear)+target value+**`expires_at`**+reason/intent+expected `revision`(R3#5:expires_at 也进 canonical hash,否则 stage 后可被替换)。对从未出现的 key 绑定 `revision=0`;一旦 create/clear 过,revision 永久 >0。
2. **apply**:在**一个 SQLite 事务**内:按主键重读该行 revision(无行 = revision 0);若 ≠ token expected → **409 冲突**(monotonic-revision CAS,无 ABA);否则:`set` → UPSERT(`has_override=1, raw_value=…, revision+1`);`clear` → UPDATE 成 tombstone(`has_override=0, raw_value=NULL, revision+1`;无行则先插 tombstone row revision=1)。同事务 INSERT changelog(结构化列)。`updated_by/changed_by` 由**可信 server 上下文**生成。**global-compatible epoch 的 value 变更,必须在同一事务里同时把 `feature_flag_cutover.mirror_state='pending'` + `mirror_target_rev` 写上**(§5.9)。
3. **仅改 intent/expires_at(metadata-only)**:走 `action='metadata'`(`raw_value`/`has_override` 不变,只改 intent/expires),仍写一条 changelog(`from_intent/to_intent/from_expires/to_expires`,R3#5:保证「每次改都留 changelog」可验证);token 同样绑定新 intent/expires_at。
4. **typed value**:75 bool + 6 value + 2 enum,stage 按 valueKind 定型,**不套现有 boolean `{to}` API**。

### 5.5 数据流
```
Dashboard(选 scope+项目+flag,set/clear)
   │ stage(校验)→ apply(monotonic-CAS 事务:UPSERT/tombstone + 结构化 changelog
   │                        + global-compatible 期同事务写 cutover.mirror_state=pending)
   ▼
Bridge SQLite ── feature_flags(第17,current-value)
   │            ├ feature_flag_changelog(第18,审计)
   │            └ feature_flag_cutover(第19,epoch/mirror 权威)     ← Bridge 唯一 writer
   │  reconciler 按 cutover.pending + mirror_target_rev fencing 镜像 .env(§5.9)
   ▲  readonly 连接 + 预编译主键点查(reader 先读 cutover.epoch 决定 legacy vs DB,再读 feature_flags,~1µs)
确有读点的进程(Bridge / Runner;Lead 待 M0 核实)
```

### 5.6 ⭐ 跨进程 reader 契约(R1#1)
Bridge、每个 Lead、每个 Runner 是**独立 OS 进程**(部分在 tmux/worktree)。改 Bridge `process.env` 对它们无效。现有基建半条链已在:Runner 已拿到 Bridge 精确库路径 `FLYWHEEL_STATE_DB_PATH`(`edge-worker/src/Blueprint.ts:460-474,1708-1712`;`claude-runner/src/TmuxAdapter.ts:413-425`;`CodexTmuxAdapter.ts:994-1003`);`verify-approval` 已用 `readonly + fileMustExist` 打开该库(`verify-approval.ts:106-115,194-220`)。

补齐:
- **Bridge = 唯一 writer**;所有 reader 只读。
- 新建**共享 `FeatureFlagReader` client**(各包复用):readonly + fileMustExist + 预编译点查 + 长期连接;DB 路径统一来源 = `FLYWHEEL_STATE_DB_PATH`。
- **逐进程矩阵(M0 填满,实现前必须有)**:每个 reader 的真实读点代码位置 / project context 来源 / DB path 来源 / 访问方式 / 连接生命周期 / DB 不可读 fail policy。**Lead 是否有真实 flag 读点由 M0 先证明;有才注入 launcher path,没有就从数据流移除**(R2#4,不无条件写 Lead 注入)。
- 边界必须答:custom `TEAMLEAD_DB_PATH` / `:memory:`(测试)、worktree/tmux、sandbox 权限、连接关闭、库不可读。
- **必须真机多进程 E2E**:已运行 Bridge 写值后,已运行的 Claude Runner、Codex Runner/CLI(及确有读点的 Lead)在下一决策点看到新值。

### 5.7 意图 / 到期 = data-only(本期不实现机制)
`intent` + changelog 服务 G3/G4,保留。`expires_at` = nullable、data-only,**本期不实现**提醒/扫描/处置。提醒 + 用量命中 = **FLY-1136**。

### 5.8 失败语义(R1#6)
- **读失败分类**:「tombstone / 无行」= 回退 legacy(正常);「DB 不存在/被锁/损坏/查询报错」= **绝不静默当无行**(否则已写的 OFF 会被旧 env 的 ON 取代)。按 flag 类别定 fail policy;治理门 / 关键 kill switch 保持旧路径直到有明确 fail-closed。
- **`codex_hard_gate_killswitch` 反例(R1#2)**:已运行 Runner 的 `verify-approval` 为 live re-arm 会重读 `~/.flywheel/.env`(`verify-approval.ts:139-153`);DB-only write 破坏该安全契约 → 这类 flag 走 dual-write 或留旧路径。

### 5.9 ⭐ Cutover-epoch 模型 + 跨存储原子性(R2#1 — per-project 与回滚不可兼得的正解)
per-project 语义与「无损回滚到任意旧 binary」**不可兼得**:一旦 DB 里 `project A=ON, B=OFF`,不存在一个 Bridge-global `.env` 值能让旧 reader + 两个新 reader 同时一致。所以每个 flag 走一条**兼容 epoch**,单调前进:

| epoch | 语义 | 生效源 | dual-write | 回滚底线 |
|---|---|---|---|---|
| **shadow** | DB 只存 candidate、**不生效**;reader 同时算 candidate-effective 与 legacy-effective、记差异但返回 legacy(§7 M2) | legacy | 否(只镜像 candidate) | 任意 pre-reader binary |
| **global-compatible** | 只允许 **global** override;DB 与 `.env` **dual-write** | DB(与 .env 保持一致) | 是 | 任意旧 binary(仍是单一 global 值) |
| **project-capable** | 证明该 flag 的 legacy readers 已清零后,才允许 **per-project 分歧** | DB only | 否(env 无法表达 per-project) | **只能回滚到已含 FeatureFlagReader 的 binary**;若必须降更旧版本,先冻结写入、operator 明确选一个 collapse-to-global 值 |

epoch 的持久权威 = `feature_flag_cutover` 表(§5.2 第 19 张),**不是内存、不是文档、不是旧 binary 的代码**;转移用 `epoch_revision` CAS + 只走合法单调边。

- **跨存储 partial-failure 协议(global-compatible dual-write 期,R3#1)**:SQLite 事务无法原子包住 `.env` atomic rename + `process.env` mutation。定 **DB 为 authoritative**;**同一个 SQLite 事务**里写 value(feature_flags)+ `mirror_state='pending'`+`mirror_target_rev`(feature_flag_cutover)—— apply 成功 = 这个事务提交。
- **reconciler 必须用 `mirror_target_rev`(含 `epoch_revision`)做 fencing CAS(R4#1 — 否则并发 apply 会造永久分叉)**:reconciler 读 `(epoch, epoch_revision, mirror_target_rev, target raw)`;持 `.env` lock 写镜像;然后**条件更新**:
  ```sql
  UPDATE feature_flag_cutover SET mirror_state='in_sync', mirror_target_rev=NULL
  WHERE flag_name=? AND epoch='global-compatible' AND epoch_revision=? AND mirror_state='pending' AND mirror_target_rev=?;
  ```
  **0 rows changed = 目标已被更新的 apply 前移 → 绝不清 pending**,改为处理最新 revision。这样即使「reconciler 处理 rev1 的同时 apply 提交 rev2」,旧 reconciler 也无法把 stale rev1 标成 in_sync。
- **全量 compare 不只在 startup**:在**周期性 reconcile** 里跑,或作为 CAS 失败的兜底,覆盖「镜像完成但标 in_sync 前崩溃」的窗口。
- **apply response 区分** `applied`(in_sync)vs `applied_pending_mirror`(DB 已生效、.env 镜像待 reconcile)。
- **可验收 SLA(R4#5)**:正常 = 立即镜像;失败后 reconciler **首次重试 ≤5s**、Dashboard 显示 `pending`;crash-injection E2E 的收敛上限 **≤10s**。—— 让 G1 的「≤几秒」对 global-compatible legacy reader 有确定 pass/fail。
- **必测**:每个写点后注入 crash/fail(DB-commit 后 .env 前、.env 后标 in_sync 前)+ 「reconciler rev N 与 apply rev N+1 交错、后者镜像失败/崩溃」的确定性用例,验证 reconcile 幂等收敛到 DB。

- **⭐ supported downgrade 契约(R3#2 — 三个承诺不能同时成立)**:「DB 永远 authoritative」+「epoch 单调」+「任意旧 binary 可正常写」三者不可兼得。默认取前两个,降级契约收紧为:**降级到 pre-writer binary 前,先等 mirror `in_sync`,并在整个降级窗口冻结/禁用 flag mutation** —— 此时「任意旧 binary」只对**读取/运行**成立(旧 binary 不写,就不会产生 DB 不知道的 `.env` 新值)。若确需降级期间仍能切 flag,则要么把 rollback 底线提到 **writer-inclusive binary**,要么设计**显式 authority handoff**(降级前 DB→env 导出 + 记 env-authoritative generation;再升级时先 env→DB import/CAS 才恢复 DB authority)。**不保留「旧 Bridge 照常写 flag、再升级不丢」这个做不到的承诺。**

---

## 6. 与 registry 的关系(registry **会**小改,R1#4 + R2#4 锁定)
- registry 仍是**定义单一真相**。
- **本期必须小改(B0/B1/B2 前置,不延后)**:加 `runtimeScope`(`'global' | 'project'`)+ 逐 read-site 指明 **project identity 从哪来**;真正 global 用**显式 scope**,不用魔法项目名。—— M0 manifest、reader precedence、route project 校验、G2 全依赖它,**不能延到 FLY-1136**。
- **precedence(定死)**:`project DB override > allowed global DB override > legacy project config/env > registry default`;「tombstone/无行」与「读库失败」是完全不同两件事。
- FLY-1136 只接 owner / expiry / usage / lifecycle,不接 runtimeScope。

---

## 7. 迁移(读侧先行 + manifest + cutover-epoch 驱动,R1#2/#3 + R2#1/#5)
| 批次 | 内容 | 说明 |
|---|---|---|
| **M0 manifest** | 逐 flag 列 `currentSource / currentTiming / currentProcess / targetScope(runtimeScope) / projectContext / risk / failPolicy`;**证明每个读点归属哪个进程**(定 Lead 有没有读点) | 后续都依赖它 |
| **M1 建表 + parser** | 建**三张表**(feature_flags/changelog/cutover,含全部 CHECK)+ precedence/parser 纯函数 + epoch-transition CAS;**不接生产读点**;byte-compat | 只加能力 |
| **M2 共享 reader + shadow** | 实现并接入 `FeatureFlagReader`;pilot flag 进 **shadow epoch**:writer 把 legacy raw 镜像成 `has_override` candidate、reader 同算 candidate-effective 与 legacy-effective、**记差异但返回 legacy**;shadow parity 测试矩阵覆盖 **显式 ON / OFF|value / CLEAR / invalid raw / project·global precedence**(不只空表 fallback,R2#5) | 读侧先行,不生效 |
| **M3 global-compatible(dual-write)** | shadow parity 通过 → 进 global-compatible:DB 生效 + 与 `.env` dual-write(§5.9 partial-failure 协议) | 每 flag 独立 epoch |
| **M4 project-capable** | 证明该 flag legacy readers 清零 → 允许 per-project 分歧,回滚底线升到 reader-inclusive binary | manifest 驱动、逐类;治理门/kill switch 默认留旧 |
| **M5 Dashboard 接表** | FLY-1038 按项目列 flag + 开关 + 显示 intent/changelog | 与 FLY-1038 协同 |

**byte-compat + 可回滚**靠 cutover-epoch(§5.9)+ shadow parity + 四类 reverse-compat 测试(table-absent / empty / missing-row / read-error)+ dual-write partial-failure 测试,不是「表空回退」一句话。

---

## 8. Owner map + 前置 eng-reality-check
| 决定 | Owner |
|---|---|
| 选方案 A | ✅ Annie(已选) |
| 读法即时 vs 几秒 | Annie 方向 / Tadashi 实现 |
| **跨进程 reader 契约 / 表结构 / monotonic-CAS / cutover-epoch / partial-failure 协议 / manifest / fail policy** | **Tadashi(工程)** |
| 迁移清单(哪些迁、哪些留 env) | Tadashi + Annie(留哪些=产品判断) |
| 逐条 enable/disable + 清理/提醒/用量机制 | **FLY-1136** |

> **收 PRD 前硬前置**:§5.6 reader 契约 + §5.4 写契约 + §5.9 cutover-epoch + §7 manifest 拉 **Tadashi 过一眼**确认真实可行/性能,再定稿。

## 9. Success metrics
- ✅ Dashboard 改一个已进 global-compatible/project-capable 的 flag → **不重启**,reader 进程 **≤ 几秒**读到新值(真机多进程 E2E 证)。
- ✅ 同一 flag 两个项目取不同值(project-capable epoch)。
- ✅ 每次改产生结构化 changelog(区分 never-set / explicit / clear)。
- ✅ 四类 reverse-compat + shadow parity 矩阵 + dual-write partial-failure(crash 注入)测试全绿。
- ✅ 迁移后 env flag 数量开始下降。

## 10. Open questions(收 PRD 前定;runtimeScope 已不在此列 —— 已锁本期)
1. M0 manifest:哪些 flag 迁 global / project / 留 env(尤其 kill switch / 治理门)?— Tadashi + Annie。
2. reader 连接:哪些进程真需读 flag?哪些热到要 TTL cache?Lead 有没有读点?— Tadashi 测/核。
3. `scope_kind='global'` 显式模型 + project rename / stale-row 处理。— Tadashi。
4. Dashboard 侧 UI(FLY-1038)接法。— 与 FLY-1038 协同。

## 11. Build issues 拆分(交 Tadashi)
- **B0** M0 迁移 manifest + registry `runtimeScope`/project-identity metadata(前置)。
- **B1** 三张表(feature_flags / changelog / cutover,含全部 CHECK)+ precedence/parser 纯函数 + epoch-transition CAS(byte-compat)。
- **B2** `FeatureFlagReader` 共享 client(按 epoch 决定 legacy vs DB)+ (条件性)Lead launcher 注入 + pilot shadow epoch + parity 矩阵。
- **B3** 写契约(stage/apply monotonic-CAS 事务 + typed value + tombstone CLEAR + 结构化 changelog + expires_at 入 token + metadata-only 路径)接 fleet route。
- **B4** global-compatible dual-write(同事务写 value+mirror pending)+ §5.9 Bridge 启动/有界重试 reconciler + applied_pending_mirror + downgrade 冻结契约 + crash-注入测试 + 四类 reverse-compat。
- **B5** project-capable 扩散(manifest 驱动;治理门/kill switch 留旧)。
- **B6** Dashboard 接表(与 FLY-1038 协同)。
- **关联** 83-flag 逐条 audit + 清理/提醒/用量机制 = **FLY-1136**。

## 12. Appendix — co-eval 溯源
- 探索/调研/审计:`product/doc/FLY-1091-feature-flag-policy/{exploration.md, research.md, audit.md}`
- 5 轮 co-eval(Annie 逐轮圈定:默认不加 flag → 方案 A → 库=Bridge SQLite 加表 → read-on-use 即时 → 收 PRD)。
- 业界依据(research.md):Fowler/Hodgson toggle 四分类 + 配置进阶;Unleash 用量驱动清理;小团队不上外部 flag SaaS。
- Codex design review R1(7)+ R2(6)+ R3(5)+ R4(5)已并入本版(cutover-epoch / durable mirror + fencing CAS / tombstone CLEAR / 结构化 changelog / downgrade freeze 契约 皆源于此)。
