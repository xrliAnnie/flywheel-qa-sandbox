# FLY-1328 runner close 不清未答 ask — 探索

Issue: FLY-1328 (https://linear.app/geoforge3d/issue/FLY-1328/fix-生命周期收尾漏了一格runner-close-不清它名下的未答-ask-pending-队列长期堆尸信噪比归零fly-1185)
日期: 2026-07-16
基于: 无

## 1. 问题定义

Runner 被 close(teardown)之后,它名下未答的普通 ask(`checkpoint IS NULL` 的
question,含 `ask --report` 的 DONE report)永远留在 Lead 的 `flywheel-comm pending`
队列里。队列堆尸 → Lead poll pending 的信噪比归零 → 活 runner 的真 ask 被淹没
(2026-07-17 夜实测:一条 37 分钟未答的真 ask 差点淹死,靠 watchdog 升级捞回)。

### 生产量化(2026-07-16 夜,`~/.flywheel/comm/flywheel/comm.db` 只读查询)

| 指标 | 数值 |
|---|---|
| pending 总数(两个 Lead 合计) | **203** |
| 其中 checkpoint-less 普通 ask | 194 |
| 其中 `kind='report'`(DONE report) | 171 |
| **owner 的 CommDB session 行已消失(= 已 teardown,纯尸体)** | **181** |
| flywheel-eng-lead: pending / 尸体 | 186 / 164 |
| flywheel-product-lead: pending / 尸体 | 17 / 17(全部) |
| 最老尸体 | 2026-07-13(3 天前) |

issue 里 HL 观察到的 "7+ 条" 只是冰山一角——真实规模是 181 条,而且**只会单调增长**
(见 §2 事实 3:protection 模式下这些行连 72h TTL 都不会删)。

## 2. 机制审计(已核实的四个事实,全部读了实现)

ask 的完整生命周期:`flywheel-comm ask` → `insertQuestion(from_agent=execId,
checkpoint=NULL)`(ask.ts:35-41)→ GatePoller 每 tick(~3s)relay 成
`runner_question` 事件写入 StateStore `lead_events`(durable,gate-poller.ts:1723)
→ Lead 收 inbox 事件;`pending` CLI 是兜底面。回答(response child)是唯一
把它移出 pending 的正常路径。

**事实 1 — close 时的归零合同漏 ask(缺口本体)。**
所有 teardown 路径(FLY-1185 五条 entry A-E、close-runner 显式关、boot prune
`pruneDeadTerminalCommDbSessions`)最终全部汇聚到同一个原子事务
`CommDB.finalizeSession(executionId)`(db.ts:2093,FLY-1238)。它 retire 该
runner 未答的 **gate**(`checkpoint IS NOT NULL`,且豁免 `review_design`/
`review_code`),删 session 行——但 doc comment 明说 "**A checkpoint-less `ask`
is not a gate**",普通 ask 一条不碰。这就是 issue 说的"第 7 格"。

**事实 2 — 周期性 hygiene 同样把 ask 排除在外。**
唯一的周期性 pending 卫生通道 zombie-gate-hygiene(FLY-1099 §5,骑在 GatePoller
patrol cadence 上)在候选集入口就把 ask 筛掉两次:gate-poller.ts:3525
(`q.checkpoint != null`)+ zombie-gate-hygiene.ts:114(`if (q.checkpoint ==
null) continue`,注释引用 "FLY-161 boundary...survive session completion BY
DESIGN")。

**事实 3 — protection 模式让尸体连 TTL 都绕过(为什么会"长期"堆尸)。**
FLY-1279 CommDB protection(默认开)把 pending 过滤从 `expires_at > now` 换成
`relay_state != 'terminal_disposed'`(db.ts:1219-1221),且 `purgeExpiredWithRefs`
对"未答且非 terminal_disposed 的 question"有显式 carve-out(db.ts:551-561)——
过期也不删。设计意图是"防止 TTL/hygiene 弄丢未处理的问题",副作用是:没人
retire 的 ask = 永生。三个机制(1+2+3)合起来构成完整闭环:没有任何一格清账。

**事实 4 — FLY-161 的边界是 completion,不是 teardown(为什么这不是"改回去")。**
GatePoller 遍历 (project, lead) 而非 active sessions,注释明说这是为了让
runner_question **在 runner completed 之后仍能 relay**(gate-poller.ts:786-791)
——FLY-208 的 LEARN-12 事故就是 DONE report 丢失。所以"ask 比 runner 活得久"
在 **completion(状态翻转)** 语义下是对的;FLY-1328 的缺口在 **teardown
(物理拆除,CommDB session 行被删)** 语义下没有对应的收尾。修复必须保住
FLY-161 的保证:completed-but-alive(如 parked 的三段式 design 阶段 holder、
post-completion 还会发 DONE report 的 runner)的 ask 照常 relay、照常 pending。
锚点:**CommDB session 行只在真 teardown 时被删**(finalizeSession /
deleteSession / 证明窗口已死的 boot prune),所以"行没了"= teardown 的机器证据,
这正是 zombie hygiene Z1 已经在用的安全边界。

## 3. 根因一句话

生命周期语义里 **completion(还能沟通)** 和 **teardown(人没了)** 缺一个区分:
FLY-161 为前者正确地放宽了 ask 的存活;FLY-1185/1238 的归零合同为后者清了
7 格账(分支/worktree/runner/cmux/thread/Linear/MCP + gate),唯独 ask 两头
都没人管——同族根因即 Tadashi 确认的"生命周期结束时没清账,尸体挂在活人视野里"。

## 4. 方案选项

### 方案 A(推荐):close 级联 + 复用 zombie hygiene 骨架扩到 ask

**A1 · close 时级联 retire(根治格)** — `finalizeSession` 事务里加第二条
UPDATE:retire 本 runner 名下 `checkpoint IS NULL`、未答、且 `created_at`
早于 **grace window(15 分钟)** 的 ask,标 `resolved_via='owner_closed'`。
- 单点覆盖全部 close 入口(1185 五 entry + 显式 close + boot prune 全走这里);
- grace window 是硬要求:relay(每 tick ~3s)和 close 都由 Bridge 驱动,但
  "ask 落库 → 下一个 relay tick"之间存在秒级窗口,close 若抢先 retire,
  `getPendingQuestions` 就再也不返回它 → runner_question 事件永不发出 →
  **DONE report 丢失 = 重演 LEARN-12**。15 分钟 >> 3s tick,把竞态窗口打没;
  младше grace 的漏网交给 A2 兜底。
- 不动 gate 那条 UPDATE 一个字节(review gate 豁免、FLY-1238 语义原样)。

**A2 · zombie hygiene Z1 扩展到 ask(存量 + 兜底格)** — 把
zombie-gate-hygiene 的 ask 排除改成一条独立的 ask 分支,复用同一安全边界:
- 谓词:`checkpoint IS NULL` + 未答 + **owner 的 CommDB session 行已消失**
  (teardown 证据,事实 4)+ StateStore session 缺失或不可逆终态(Z1 同款
  双重证据)+ `from_agent` 为 UUID 形(exec-id;`"runner"` 字面量等非 UUID
  fail-closed 留下)+ **age guard(30 分钟)**;
- 动作:`retireQuestionGuarded`(现成原语,已带 from_agent 绑定 + 未答守卫,
  并发 answer 赢)+ 三相审计(intent → guarded mutation → re-read outcome,
  FLY-1099 原样骨架),标 `resolved_via='owner_closed_sweep'`;
- **存量清理 = 部署后第一轮 patrol pass 自动清掉现存 181 条中的 178 条**
  (生产只读模拟已验证;不需要一次性脚本,骨架、审计、安全边界与常态路径
  完全同一套)。剩 3 条:1 条非 UUID 的 QA 残留(fail-closed 留下)+ 2 条
  30 分钟内的新 ask(下轮再看);
- Z2 类比(owner 活着但 CommDB 行没了)不扩:ask 不承担 wake 路由关键性,
  留给 FLY-1049 族。

**审计与标记**:messages 表加 nullable `resolved_via TEXT` 列(照抄现有
ADD COLUMN 迁移模式);durable 审计走 StateStore session_events(A1 复用
close-runner 已有的 finalize outcome 事件,新增 retiredAskCount;A2 复用
zombie 三相事件,payload 带 disposition)。注意 retire 后行会在下一次
purge 被删(事实 3 的 carve-out 只保未 retire 的),`resolved_via` 是
小时级取证窗口,天级取证靠 StateStore 事件——两层都要。

**kill-switch**:新行为统一受 `FLYWHEEL_ASK_HYGIENE`(默认开,`=0` 回到
今天字节行为)。反向兼容 sentinel 测试两侧(项目惯例)。

### 方案 B:独立新建 orphan-ask boot sweep(不碰 zombie hygiene)

在 commdb-session-prune 里新写一个 orphan-ask 扫描,Bridge boot 时跑 + 自己
的审计事件形状。**缺点**:重复发明 FLY-1099 已经打磨过的安全边界(三相审计、
并发 answer 竞态、dangling-intent reconcile),两套 hygiene 并存;boot-only
意味着两次重启之间的漏网尸体一直挂着。仅当 A2 被认为侵入 zombie 模块风险
太高时退而求其次。

### 方案 C:读侧过滤(pending CLI 隐藏死 owner 的 ask,不写库)

**否决**:账没清,只是遮眼——bootstrap、founder-reply 候选集、`sessions`
等其它读面各自不一致;DB 永生长;违背 issue 钉死的设计原则"关人就关它的账"
(FLY-369 同款)。

## 5. 关键设计决策摘要

| 决策 | 取值 | 理由 |
|---|---|---|
| teardown 证据 | CommDB session 行消失(+ StateStore 双证) | 与 Z1 同边界;completed-alive 行还在 → FLY-161 保证不破 |
| cascade grace | 15 min(硬编码) | 杀 relay 竞态,防 DONE report 丢失(LEARN-12);1185 硬编码 3d 窗口同风格 |
| sweep age guard | 30 min(硬编码) | 尸体以天计,30 min 零成本;彻底盖住同 tick 微竞态 |
| from_agent 形状 | 仅 UUID 形可 sweep | fail-closed;`"runner"` 字面量所有权不可证 |
| `kind='report'` | 不特判 | report 就是 checkpoint-less ask;founder-binding 排除(FLY-1041)不受影响 |
| review gate 豁免 | 不变 | ask 分支只碰 `checkpoint IS NULL`,gate 语义零改动 |
| 存量清理 | = A2 首轮 pass | 同一骨架同一审计,无一次性脚本 |
| kill-switch | `FLYWHEEL_ASK_HYGIENE`(默认开) | 项目惯例;`=0` 字节回退 |

## 6. 明确不做(scope 边界)

- 不改 gate 的 retire 语义、不碰 review_design/review_code 豁免(FLY-1257);
- 不做 Z2-for-ask(活 runner 的 wake 路由修复归 FLY-1049 族);
- 不改 pending CLI 的过滤逻辑(读面不动,写面清账);
- 不处理跨库(FLY-1314 授权链归属已由 Cass 判定分开);
- `qa-fly1239-78754` 这类非 UUID 残留手动清或留着(1 条,不值得放宽安全边界)。
