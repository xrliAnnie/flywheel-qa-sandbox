# FLY-2104 周扫描改投通知频道 — 调研
Issue: FLY-2104 (https://linear.app/geoforge3d/issue/FLY-2104/flage扫描-周扫描裁决页改发-discordflywheel-notification不再建-linear-单)
日期: 2026-08-27
基于: exploration.md

## 结论

不需要重写周扫描。现有 durable run/leg、Sunday slot、HTML renderer、report registry 和 Discord delivery 都可复用；问题是接线顺序与两个旧产品决定仍被写死。实现应收敛而非扩张：

- route 用项目既有 late-bound holder 模式在 catch-all 前注册；
- 新 run 不再冻结 `linear`/独立 `report` 腿，只冻结一个 founder-visible `discord` 腿（另加既有 `lead_notify` debt 腿）；
- 有候选时该 visible 腿运行 canonical `flywheel-comm publish-report --channel --no-screenshot`，随后在 report 消息下建立 Engineering Lead handoff thread并等 mailbox ACK；零候选时发一行 marker 消息；
- 历史 `linear/report` 腿只本地结算 degraded，绝不再产生外部 Linear side effect；
- scan DTO 携带 scope-aware store clock；pure compute 对 ready clock用 stable-since，对 `NULL` 用首次登记，对 `no_clock` 保留两次扫描并用较晚的登记/观测起点；周快照不再覆盖可信 store clock。

## 1. 路由机制

### 当前调用顺序

1. `startBridge()` 在构造大部分运行时后调用 `createBridgeApp(...)`。
2. `createBridgeApp()` 注册全部静态路由、兜底 404、error handler并返回 app。
3. `startBridge()` 立即 `app.listen(...)`。
4. 更后面才构造 `flagRetirementScanner` 并 `app.post('/api/flag-scan/run', ...)`。

Express middleware 按 append 顺序运行，所以步骤 2 的无路径限制 catch-all 永远截住步骤 4。

### 已有正确先例

`BridgeAppOptions` 已有 `reviewCoordinator`、`reconnectHolder`、`rescueRoute` 等 late-bound holder：路由在 `createBridgeApp()` 内、listen 前挂载，handler 在请求时读取 `.current`；运行时在 `startBridge()` 后段填入 holder。flag scan 应复用同一形状，不移动整个全局 404/error handler，也不影响 standalone `createBridgeApp` tests。

### 手动语义差口

当前非 dry-run handler 调 `recoverPending()`：没有 pending 时返回 `not_due`，不会新建 run。验收要求“POST 200 + 真跑一轮”，因此 scanner 需要 `runNow()`：

- 有 pending：先恢复同一 pending（保持 single-pending invariant）；
- 无 pending且 flag enabled：直接 compute+commit，不检查 Sunday due；
- flag disabled：返回 `disabled`，手动入口不得绕过 kill switch；
- `scanIfDue()` 原样保留调度检查；
- `dryRun()` 仍零 store/外部写。

同一 scanner instance用共享 single-flight 包住 `runNow()`、`scanIfDue()` 与 recovery，防 manual/tick 在同进程竞态。跨进程/旧 generation仍由 StateStore single-pending CAS裁决；若落入 `lost_race`，HTTP 映射为 409，不把“没有新 run”伪装成验收所需的 200。

## 2. 输出腿与 rollout

### 当前新 run

`owedLegs()` 无条件返回 `linear`、`report`、`discord`（可能再加 `lead_notify`）。`discord` 的 claim 又硬依赖 Linear done + report done/degraded。生产 effect 会：

1. Linear create issue（含 `flag-governance` label）；
2. 只调用 `/api/reports/publish` 拿 URL；
3. 用 CoS bot 在 Flywheel Core 发 root、建 thread、@Engineering Lead，再等待 mailbox ACK。

这三个行为都不是本单终形。

### publish-report 的真实边界

`flywheel-comm publish-report` 是 canonical 三步客户端：

1. `/api/reports/publish`；
2. 可选本地 ProofShot；
3. `/api/reports/deliver` 向显式 channel 发一条标准 report message。

ProofShot 使用同步子进程 API，不能由 Bridge 的定时任务拥有其生命周期。生产扫描明确传 `--no-screenshot`：同一 canonical 命令仍执行 publish + deliver，但 child 不创建浏览器。Bridge 用异步 `execFile` 启一个短命 `node <comm-cli> publish-report` child，把 HTML 落到独立临时目录，显式传 loopback URL、master token、project、title、notification channel，并在 finally 清理。外层 timeout 小于 leg lease；因 argv强制无截图，timeout kill 不会遗留 Chrome session。真浏览器全页截图属于 QA evidence，独立于生产投递附件。

### durable leg 收敛

新候选 run 只需要 `discord` visible leg，但该腿的完成合同包括三步：publish-report拿到 notification root message；在该 message 下建立 thread并 @Engineering Lead；既有 mailbox handoff获得 ACK。evidence 延续 StateStore/production既有键名 `{rootMessageId, threadId, handoffMessageId, inboxDeliveryId, inboxRecipient, preflightAt, preflightFingerprint, preflightSucceeded}`，并可追加 `{reportUrl, reportId}`；不得另造 `messageId`/`inboxMessageId`。child 非零但 envelope 有 URL/delivered=false 视为 ambiguous，进入既有 5 分钟 visibility fence；`reconcileDiscord` 在 notification channel 按 title 内 run marker 找到标准 report message后收养，并幂等补齐 thread/handoff/ACK。页面 copy写明贴回“本报告消息下的 thread”，保留结构化裁决返回路径。

`discord` 是唯一 founder-visible leg，因此 effect 不允许返回 `degraded` 并算完成。publish/deliver/thread/handoff任一步失败都只能进入 ambiguous/retry；只有既有 cross-slot/24h stalled settlement在先 `alertFailure` 后才能将整 run结算并回滚本次 ask increment。正常 commit 仍按现有语义先增加 ask count，pending run阻止新 run；message可见并 ACK 后保留 increment，stalled且无 founder surface时沿用现有 rollback。每次成功 forced manual scan产生真实新卡，也真实计一次 ask。

零候选同样欠 `discord`，但 effect 只发 `本周 0 候选` + hidden automation marker；因此不为零候选发布空页面，也不建 thread。`lead_notify` 仍独立结算 no-clock/keep-unbound debt，不替代 founder 的零候选一行。

候选与零候选两条路径在每次 effect与 reconcile 调用时都从 `resolveInfraNotifyIdentity()` 取得 `CLAUDE_INFRA_BOT_TOKEN + FLYWHEEL_NOTIFY_CHANNEL`。这是一个原子 identity predicate；不使用 `config.discordBotToken` 或 legacy fallback，也不在 `startBridge()` snapshot。共享 resolver保持原有 non-empty语义，notification snowflake只在 flag-scan effect本地校验，避免改变 reports/standup/account-cap等消费者。缺失/本地非法时 scanner仍存在，effect抛错；scanner catch先把 visible leg转 ambiguous，再显式调用既有 `alertFailure`，后续调用可在 env修复后自愈。

候选 thread preflight保留现有三层证明并把 Core key重定位到 notification channel：(1) infra token `/users/@me` 得实际 sender id；(2) 每次调用都重新读取 Engineering Lead `access.json`，必须同时有 `groups[notifyChannelId]` 与 `allowBots.includes(senderId)`；(3) 用 infra token在该 channel真实 POST permission probe、create thread、send-in-thread，再 archive/delete清理。21天缓存只覆盖第(3)项 live probe，绝不缓存第(2)项 access assertions。只有三层都通过才可发布/settle；mailbox ACK只证明 handoff进队，不证明 Lead adapter加入 Discord channel。

当前生产 access仍以 Core/CoS sender为既有合同；迁移到 notification/Infra sender是显式 operator prerequisite。Tadashi或值班 operator须在 QA真实扫描前把 Engineering Lead加入 notification group并允许实际 infra sender bot；Runner通过 read-only preflight/真实 probe验收并回报，不直接改 live配置。

### 历史 pending

升级时可能存在旧 run：

- `linear pending/claimed/ambiguous`：不再 reconcile/create，拿 lease 后直接 degraded，evidence 记 `retired_by_FLY-2104`；
- `report pending/claimed`：同样 degraded；新 `discord` 腿会用 frozen items 重新跑 canonical publish-report；
- 旧 `discord ambiguous` 只在 notification channel reconcile；Core 中可能已有的旧消息不作为新落点完成证据。

StateStore 的 `FlagScanLeg`/DDL 先保留历史枚举，避免迁移破坏已存在行；新 commit 不再写这些腿。`discord` dependency 改为“若历史 `linear/report` 腿存在则须 settled；不存在则不要求”。

## 3. `value_last_changed` 与 scope

### 当前断点

`enrichFlagViewsWithStore()` 已把 managed row 的 `valueLastChanged`、`clockReadiness` 和 store effective 写进 `FlagView`。`canonicalizeFlagSample()` 只读 effective；`advanceState()` 则根据每周观测变化维护 `streakStartedAt`。所以 managed 值即使昨天真实翻转，只要两次周快照值恰好相同，也可能沿旧 scan streak 被误判稳定。

### stable-since 规则

定义每个 `(flag, scopeKey)` 的 clock：

```ts
interface FlagValueClock {
  scopeKey: string;              // '*' 或 projectName
  valueLastChanged: number | null;
  firstRegisteredAt: number;
  readiness: 'ready' | 'no_clock';
}
```

稳定起点：

1. `readiness=ready && valueLastChanged != null` → `max(valueLastChanged, firstRegisteredAt)`；
2. `readiness=ready && valueLastChanged=null` → `firstRegisteredAt`（seed 以后从未发生 effective 变化）；
3. `readiness=no_clock` 或没有 store clock row → 先执行 canonical `advanceState()`；若 `advanced.streakSamples < 2` 或 `advanced.streakStartedAt === null`，直接不候选；
4. 只有门槛通过后才计算 `stableSince = firstRegisteredAt有效 ? max(firstRegisteredAt, advanced.streakStartedAt) : advanced.streakStartedAt`。必须读取 POST-advance `advanced`，绝不读取翻转前的 `previous`，也不把 null交给 `Math.max`；
5. no-clock首轮只登记不候选，下一次同值观测且安全起点满阈值后才可候选，并在 diagnostic标 fallback；
6. 任一时间在未来、非整数、scope 重复/缺覆盖 → fail closed，不出候选。

对 bridge-global/dormant flag 读取 `*`。对 project flag：优先每个 `effectiveByProject.projectName` 的 exact scope；没有 exact 时可用显式 `*`；全部当前 project scope 必须可解析，候选 stable duration 取 `min(now - stableSince)`，即最晚翻转的 scope 决定整 flag 是否可退役。

### 当前 schema 与未来 A 单兼容

当前 `flag_values`/`flag_value_changelog` 没有 `scope`。StateStore reader 用 `PRAGMA table_info` 判能力：

- 无 `scope`：每个 `flag_values` row 投影为 `scopeKey='*'`，首次登记为该 flag changelog 最早 `changed_at`；
- 有 `scope`：按 `(flag_name, scope)` 返回；首次登记按同一 identity 的最早 changelog；
- schema 只改一半或重复 identity：reader fail loud，不把不完整迁移当成 clock。

这样本单不预先修改 A 单 schema，也不靠猜列；A 单一旦提供 scope rows，scanner 下一次 source load 自动精确消费。

### scan state 的职责

`flag_scan_state` 暂不改成 scope 主键。它继续保存每 flag 的 canonical、ask count、departure 和 legacy first-registration fallback；真正 eligibility 对 managed/scoped clock 取所有 scope 的最晚 stable-since。输出卡仍一 flag 一张，避免把“删 flag”误解成“只删某项目配置”。

## 4. 测试与证据

### RED → GREEN seams

1. route mount：给 `createBridgeApp` 注入 holder，当前先得到 404；修后 Bearer+loopback POST 200，并断言 `runNow`（不是 `recoverPending`）调用一次。
2. manual vs schedule：`runNow()` 在非 due 时仍 commit；`scanIfDue()` 同一时刻仍 `not_due`。
3. legs：新候选 run 恰有 `discord`（+可选 `lead_notify`），无 `linear/report`；零候选也有 `discord` 且 body 恰含“本周 0 候选”。
4. legacy pending：旧 linear/report 腿只 degraded，mock Linear create/reconcile 0 调用；discord 最终可 claim。
5. production delivery：两条路径 call-time解析 `resolveInfraNotifyIdentity()`；preflight断言 `groups[notify]` + `allowBots[sender]`并完成真实 root/thread/in-thread probe；child args 含 canonical `publish-report --channel <notify> --no-screenshot`，不含 Linear；成功后建 report thread、发 Lead handoff、等 ACK；非零/超时进入 ambiguous；reconcile 查 notification并补齐后续步骤。
6. clock pure logic：`valueLastChanged` 6d 不候选/7d 候选；ready NULL用 first registration；no_clock昨天翻转+300d seed仍不候选，须读取 advanced两采样且取较晚起点；advanced start=null时明确 fail closed；future/duplicate/missing fail closed。
7. scope：`*` fallback；两个项目一个 8d 一个 2d 不候选；两者都 ≥7d 候选且显示最短时长；exact scope 覆盖 `*`；future A schema reader fixture自动返回 exact rows。
8. renderer：候选页仍是 light theme，comment/select/copy/localStorage/nonce 与 fallback 文案都在；storage key是 pathname+flag card identity；文案要求贴回 report thread；零候选不生成页面。
9. runtime wiring：扩 `bridge/__tests__/flag-store-runtime.test.ts`，证明 ready scoped clocks完整进入 `FlagView`，bypass/degraded只产生 no-clock metadata。
10. race/kill switch：disabled manual不 compute；同 instance manual/tick共享 single-flight；cross-generation `lost_race`映射409；干净 fixture的 200必须同时断言新增 run row与外部 effect。
11. ask rollback：保留现有 commit increment；partial evidence使用 `rootMessageId + threadId`，所以 root/thread已可见但 ACK未到的24h settlement认定 founder surface已投递且不回滚；确无该 evidence才先告警再回滚；done+ACK自然保留 increment。

### 真浏览器与真实 Discord

实现节点只准备可重跑 fixture 与真实 POST。独立 QA 需要：

- 用真浏览器打开 published hosted URL，验证 light theme、select/textarea、reload persistence、clipboard success 与 denied fallback；截图写入 QA 报告；
- 在授权环境跑一次真实 manual scan，回读 `#flywheel-notification` message id/channel id，证明页面链接在目标频道；
- 另跑 zero-candidate fixture，证明只发一行；
- 查询 Linear/测试 double，证明该 run token 没有新 `flag 周扫描 · N 个候选` issue。

## 5. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Bridge child 卡住/阻塞 | async execFile + `--no-screenshot` + 小于 leg lease 的 timeout；kill路径无浏览器可泄漏，temp dir finally清理 |
| 配置缺失悄悄回 Core/静默休眠 | identity call-time解析；flag-scan本地校验 snowflake；effect catch显式 alert后 ambiguous，no fallback；修复 env后无需重启即可重试 |
| mailbox ACK掩盖 Lead未加入频道 | 每次重读 `groups[notify]` + `allowBots[sender]`；仅 notification真实 root/thread/in-thread probe可缓存 |
| publish succeeded/deliver response lost | visible-leg ambiguous fence + notification marker reconcile |
| 升级后旧 pending 建 Linear | legacy linear effect路径删除/settle test |
| scope migration半落地 | PRAGMA capability exact-check，半 schema fail loud |
| NULL 被误解为刚变化 | 仅 ready clock信任 first changelog seed；no-clock取 seed/scan streak较晚者并保留两采样 |
| 一个项目刚翻转仍推荐删全 flag | eligibility 取全部当前 scope 中最短稳定时长 |
| full suite 压宿主 | 先 targeted；全 repo gate按角色要求跑，但原始失败与单 worker复验分开记录 |

## 6. 不采用

- 把 catch-all 整体搬到 `startBridge()` 最末：route 太多且 standalone app 会失去稳定 404，回归面远大。
- 只把 raw Discord channel 改成 notification：仍不是 publish-report，也没有标准 hosted+deliver消息。
- 继续建 Linear但不发链接：仍违反“不再建 Linear 单”。
- 用 report `/publish` 直调冒充 publish-report：缺 deliver，不符合 canonical 能力合同。
- 在 Bridge 周任务内运行 ProofShot：浏览器 capture是同步且外层 kill无法可靠进入 CLI finally；生产用 `--no-screenshot`，QA再用真浏览器给截图证据。
- 把 `value_last_changed` 复制进 scan state：产生第二真相源，仍会漂移。
- 为 future A 预建 scope schema：越过 Batch 1 边界；capability reader 已足够自动承接。
