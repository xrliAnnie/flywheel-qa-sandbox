# FLY-2118 Lead 巡检可见面收窄 — 探索

Issue: FLY-2118 (https://linear.app/geoforge3d/issue/FLY-2118/巡检制度-lead-巡检只应看见自己名下的-runner-现在是每个-lead-各扫全机)
日期: 2026-08-28
基于: 无

**Mode**: Technical / Deep(自主 design 节点;founder 方向已在 issue 内给定)
**Status**: Complete

---

## 1. 问题定义

Founder 2026-08-27 23:03 PT 直令(核心句):

> 「你压根就不应该看到他的那些 runner。……我希望你在看的时候只关注自己的 runner 就够了,
> 不要再去关注其他项目或其他人的 runner,不然没有那么多时间。」

这不是「跨界怎么上报」的问题(那只是症状),要解决的是**巡检的可见面本身就不该包含别人的
runner**。同时本单必须连 `runner-patrol-rules.md` §0 的范围合同一起改(它明文要求扫整机),
否则规则与实现打架 —— Honey Lemon 已明确:冲突解决前她只能按现行规则继续扫全机。

### 实测代价(本 worktree 内亲测,2026-08-28)

对照今天 19:38(HL)/ 19:48(Tadashi)两份真实巡检报告:

| Lead | 全机 canonical pane | owner=owned | owner=cross-boundary | 浪费的 capture |
|---|---|---|---|---|
| flywheel-product-lead (HL) | 19 | 3 | 16 | 16/19 (84%) |
| flywheel-eng-lead (Tadashi) | 19 | 16 | 3 | 3/19 |

同一个 pane 每轮被两个 Lead 各做一次**全 scrollback capture + SHA-256**;N 个 Lead 就是 N 遍。
且跨界 finding 只能上报不能处置 —— 纯注意力开销。另有重复记账实例:FLY-2113 / FLY-2114
(同一病根、两个 Lead 各开一张单,`class_key` 的 `STRUCTURAL_SHAPE` 是自由文本,措辞不同
→ key 不同 → 去重失效)。

## 2. 现状机制(代码事实)

### 2.1 数据层早已按 Lead 分好账 —— 全机扫描是规则+脚本层强加的

- **Bridge tick 铸造**(`packages/teamlead/src/bridge/patrol-tick.ts`):
  `getPatrolRosterSessions(project)` 取项目全部 non-terminal session,逐条经
  `resolveLeadForIssue(projects, project, labels)`(标签路由,兜底 `leads[0]`)分进
  `rosterByLead`,每个 Lead 的 `patrol_tick` event **只带自己名下的 roster**。
- **owner index**(`comm/<project>/comm.db` 的 `sessions` 表):每行有
  `tmux_window / execution_id / lead_id / status`;`lead_id` 由 Bridge 在 spawn 时经
  `registerSession(executionId, tmuxWindow, projectName, issueId, leadId, vendor)` 写入,
  是 dispatch 时刻的事实。
- **session 级无主兜底已存在**:`alertUnownedRoster`(patrol-tick.ts:136)—— roster session
  解析不到 patrol-capable Lead 时向 alert sink(`plugin.ts:8404`,即 #flywheel-alerts,
  FLY-2076 后默认主力 owner 是 Claw)发 `unowned_roster` severe 告警。

### 2.2 全机扫描的两个来源

1. **规则明文**(`packages/teamlead/lead-rules-base/runner-patrol-rules.md` §0 L38-44):
   「检测范围 = **整机**……tick 名册只是 Bridge 对『你名下』的**待核声明**,不是巡检边界」。
2. **快照脚本**(`scripts/lead-patrol-snapshot.sh`):
   - STEP 1(L262-295):`TMUX= tmux list-panes -a` 全机枚举 → `runner-*` session +
     Linear identifier window 过滤 → `RUNNER_PANES` = 整机集合。
   - STEP 2(L342-458):对 `RUNNER_PANES` **每一个** pane 先做 5s 有界全 scrollback
     capture + 双哈希,**然后才**查 owner index 判 `owned|cross-boundary|foreign-registry`。
     即 capture-then-classify,顺序反了。
   - 无主 pane 检测(L371-389):pane 有 canonical 形状但全部 index 无 match →
     `session_terminated`(首见)→ 连续 2 tick `ORPHANED`。连续性存于
     `patrol-continuity/<lead>/<project>.tsv` sidecar —— **每个 Lead 各存一份**,
     即无主检测目前是「所有 Lead 都兜」。
   - STEP 3/4 SQL(L475-576):按 `project_name` 过滤,**不按 lead** —— 同项目双 Lead
     (flywheel 正是)各自都会看到全项目的 TURN/投递 finding,这是 FLY-2113/2114
     重复记账的结构性入口。
   - STEP 5:整仓 PR + CI 快照(2 个 REST 调用,便宜)+ 名册最近 2 个 identifier 的
     Discord 线程。

### 2.3 两个 owner oracle 并存

- Bridge tick roster:`resolveLeadForIssue`(标签路由,现算)。
- 脚本 STEP 2:`comm.sessions.lead_id`(dispatch 时刻写死)。
两者可能不一致(改标签后)。收窄可见面必须先指定唯一权威,否则会出现「pane 谁都不认领」
或「两人都认领」的缝。

### 2.4 现实褶皱

- `tmux_window = 'runner-<project>:pending'` 的 session(尚未绑窗)不会 match 任何 pane。
- 个别 running session 的 `lead_id` 为空(实测 comm.db 有此形状,均为 pending 窗口行)。
- `sessions` 表在 comm.db 与 StateStore 各有一份语义不同的账;巡检规则「不采信 Bridge
  单方转述」的独立信源原则必须保留 —— 脚本直读 comm.db,而不是信 tick 消息正文。

## 3. 选项对比

### 决策点 A:可见面收窄的枚举方式

**A1(推荐)— index-first 反查**:脚本先从**自己项目的 comm.db** 取
`lead_id = $LEAD_ID AND status IN ('running','blocked')` 的 `tmux_window` 目标集,
再拿一次便宜的 `tmux list-panes -a`(纯元数据)做交集;交集外的 pane 在 capture 之前、
在报告写入之前就丢弃。我名下 index 有、tmux 无的目标 = finding(session_terminated /
missing pane)。
- 优点:capture 只发生在名下 pane;报告里根本不出现别人的 pane(满足验收 2);
  仍保留「index↔tmux 双向对账」的独立核验(方向从 pane→owner 翻转为 owner→pane)。
- 缺点:名下多出来的「幽灵 pane」(tmux 有、任何 index 都没有)对单个 Lead 不可见 →
  必须由决策点 B 的兜底接住。

**A2 — 保持全机枚举、只在报告层过滤**:capture 依旧全做,报告只写 owned。
- 否决:capture 成本一分没省(founder 的「没有那么多时间」正是成本轴),且「看见了但
  不写」与直令「压根就不应该看到」相悖。

**A3 — 逐目标 tmux 查询(不做 list-panes -a)**:对每个名下 target 单独
`tmux list-panes -t <target>`。
- 否决理由:N 次进程 spawn 反而比一次 `-a` 贵;`-a` 的输出只在脚本内部做交集、
  不落报告,不违反「不该看到」的实质(Lead 读的是报告)。

### 决策点 B:无主 pane 兜底的确定责任人

⛔ 前提:不许为了去重把兜底删掉;验收要求阴性对照(去掉兜底 → 无人报)。

**B1(推荐)— Bridge 侧 orphan-pane sweeper → #flywheel-alerts(owner: Claw)**:
在 Bridge 里加一个与 patrol-tick 同级的周期 pass:`tmux list-panes -a` + 全项目
comm.db owner index 联查(逻辑与今日脚本 L363-389 相同),canonical pane 连续
2 个 sweep 无主 → 经既有 `alertFailure`/alert sink 发 `orphan_pane` 告警。
连续性 sidecar 收敛为**一份**(Bridge 持有),不再每 Lead 一份。
- 优点:枚举+联表本来就是机器活,判断留给 alert owner;责任人确定(FLY-2076 后
  #flywheel-alerts 主力 owner = Claw);与既有 `unowned_roster` 告警同一管道、同一收口;
  Lead 注意力开销归零;阴性对照容易构造(停掉 sweeper pass)。
- 缺点:给 Bridge 加了 tmux 枚举职责(但 Bridge 本就有 tmux 依赖:
  `patrol-process-liveness.ts` 已做 pane 级 liveness 探针,不是新能力域)。
- 与「自动巡检引擎属 FLY-271/368」的边界:该句约束的是 *Lead 纪律文件* 的范围,
  不禁止 Bridge 新增检测器;本单为 sweeper 立独立代码与测试,不与 FLY-271/368 抢账。

**B2 — 指定一个 Lead 身份跑 `--scope machine` 模式**(CoS 或轮值):
- 否决:CoS(Aunt Cass)`canSpawnRunners=false`,今天根本收不到 patrol_tick,要为她
  单开触发链;轮值则把「确定责任人」又变成调度问题。两者都继续消耗 Lead 注意力,
  与直令方向相反。

**B3 — 保持所有 Lead 都兜(现状)**:
- 否决:founder 直令否定;且 N 份 continuity sidecar 各自计数,orphan 判定互不一致。

### 决策点 C:owner 权威的唯一化

**C1(推荐)— comm.sessions.lead_id 为巡检 scope 权威**;Bridge tick roster
(resolveLeadForIssue)作为「待核声明」保留,两者不一致 = finding(登记账 vs 路由账
漂移,值得暴露)。理由:lead_id 是 dispatch 时刻的事实、就在脚本已经在读的表里,
不引入新推导;标签事后变更不应悄悄把在飞 runner 划给另一个 Lead。
**C2 — resolveLeadForIssue 现算为权威**:否决 —— 脚本需要复刻 TS 路由逻辑到 bash
(标签大小写、first-match、fallback),两处实现必然漂移。

### 决策点 D:STEP 3/4(项目级账)的归属切分

**D1(推荐)— 按 finding 可归属的 execution/lead 过滤**:STEP 3/4 的每类 finding 都能
经 `execution_id → comm.sessions.lead_id` 或(DEAD_LETTER_PENDING)自带 `lead_id` 列
归属;SQL 加 lead 过滤,归属不出来的行(如 execution 为 NULL 的
NODE_SESSION_NOT_LIVE)按 `resolveLeadForIssue` 的持久化结果落给该 issue 的路由 Lead
—— 无法归属的极端形状走 UNAVAILABLE + alerts 兜底,不静默丢。
**D2 — STEP 3/4 保持项目全量**:否决 —— flywheel 双 Lead 结构下,这正是并发重复记账
的另一半入口;只修 class_key 不修可见面,重复的「注意力支出」仍在。

STEP 5 整仓 PR/CI 快照维持现状(2 个 REST 调用,项目级真相无 pane 属性;本单不动,
在 plan 中明确写为 non-goal,避免范围膨胀)。

### 决策点 E:class_key 去自由文本 + 并发唯一

**E1(推荐)— 键收敛为源码 token + Bridge find-or-create 收口**:
1. `ROOT_KEY = sha256(ERROR_CODE | GUARD_KEY)`,两者都必须是**逐字源码 token**
   (ERROR_CODE = 源码抛出的稳定错误码原文;GUARD_KEY = `<repo 相对路径>#<symbol>`),
   `STRUCTURAL_SHAPE` 从 key 中移除、降级为 issue body 里的人读描述(`形状:` 字段保留)。
2. 新增 Bridge 端点 `POST /api/patrol/class-issue`(token-authed):按 `class_key`
   find-or-create FLY-2072 的类别子 issue,进程内按 key 串行 + `teamlead.db` 新表
   `patrol_class_ledger(class_key → child identifier/uuid)` 做幂等账;并发第二个请求
   直接拿到同一张子 issue。规则里 250 条分页 + 逐张 fresh read 的查重舞步整段删除,
   换成一次 Bridge 调用。
- 优点:满足验收 4(并发只产生一张单,不是「产生两张再撤一张」);去掉人类措辞变量;
  规则文本净删。
- 缺点:新增一个 Bridge 路由 + 表(小而正交)。

**E2 — 只改 key 推导、创建仍走 Linear MCP + 事后 lowest-number-wins 和解**:
- 备选:不加 Bridge 面,但并发窗口内仍会真实创建两张(一张随后 cancel),
  Epic 列表留下 cancelled 噪音,验收 4 只算勉强满足。作为 E1 的降级路线写入 plan
  (若 E1 的 Bridge 路由被裁掉)。

### 决策点 F:规则文件 §0 改写(必做,无选项分叉)

- 「检测范围 = 整机」→「检测范围 = **你名下 Runner pane**(从 owner index 出发反查)
  + 当前项目主仓的外部真相;无主 pane 由 Bridge sweeper 兜底、alerts owner 处置」。
- 删除 Lead 对 cross-boundary pane 的 capture/记录义务与 round-table 跨界聚合上报段
  (L271-275)—— 收窄后 Lead 报告里不再出现跨界 pane,该段失去输入。
- `owner=` 取值域从 `owned|cross-boundary|foreign-registry|unknown` 收敛为
  `owned`(+index 缺口的 UNAVAILABLE);STEP 2 判据相应简化。
- 步骤 B 的查重舞步替换为 Bridge class-issue 调用(随 E1)。
- 完成门(FINDING-GATE)与六步骨架结构保留 —— 改的是集合,不是纪律。

## 4. 推荐组合

**A1 + B1 + C1 + D1 + E1 + F**:
- 每个 pane 每轮恰好被 capture 一次(它的 owner),无主 pane 被 Bridge sweeper 恰好
  发现一次并有确定 owner(Claw via #flywheel-alerts)→ 验收 1/2/3。
- class_key 全 token 化 + Bridge find-or-create → 验收 4。
- 规则与实现同步改 → 验收 5。

## 5. 已识别风险 / 开放问题

1. **lead_id 为空的 running session**(pending 窗口):归属不到任何 Lead 的名下集合 →
   会从所有 Lead 的可见面消失。处置:这类行本就 match 不到 pane;绑窗时 Bridge 会补
   lead_id。plan 需验证 spawn 路径确实总带 leadId;若存在不带 leadId 的注册路径,
   把它并进 sweeper 的告警面。
2. **测试环境**(529 房 / TEST slots)的 runner pane 是否会进 sweeper 告警面 —— plan
   阶段核对 canonical 口径对 test slot session 名的覆盖,避免制造告警噪音。
3. **`--scope` 兼容**:snapshot 脚本改默认行为会影响在飞 Lead 的既有 tick 流程;
   发布顺序 = 脚本+规则同 PR 原子换,converge-flywheel-bin 分发(既有机制)。
4. 巡检规则是 lead-rules-bundle 的一部分,改动后需要 bundle 重铸/分发的既有流程
   (plan 阶段确认分发链)。
