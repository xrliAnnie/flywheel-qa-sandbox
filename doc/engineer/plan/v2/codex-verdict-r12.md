CHANGES REQUESTED

# Flywheel v2 设计稿 v12 复审 R12

- 评审对象：`/tmp/design/design-v12.md`
- v12 SHA-256：`3550d9ba52b25b9594a210a4f32d4a25517ea009eb0e5c8927a5e25efa3834af`
- R11 基线：`/tmp/design/codex-verdict-r11.md`（SHA-256 `3f041afca936236f75585025230ea841f91b34189e55e8b3222593c596604d3e`）
- 仓库锚点：本地干净 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main@37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交。
- 评审边界：只核验 R11 第 23-45、71-75、90-92 行的唯一 resumed 阻断项及 v12 直接引入的矛盾；R6-R11 已闭合的 SLA、SELECT、suppression、pending recovery、spool/alert replay 与锁后端未重开。

## 结论

R11 的原始谓词互斥在正常串行路径上已经消除：wrapper 取锁后先把 `resumed→active`，保留 `last_resumed_at`，再执行 `count(... > last_resumed_at) >= 6 AND state=active`；第六次能够 claim，旧 episode 事件也被排除（`design-v12.md:7-10`，对照 `design-v11.md:22-24`）。

`last_resumed_at` 在后续状态转移中的保留也已明确写成全局规则（`design-v12.md:7`）。因此 `active→held_alert_pending→held_alert_attempted` 虽未在每个对象字面重复该字段，仍应按第 7 行携带；下一次真正的 `held_*→resumed` 则更新为新的成功 resume 时间。

但 v12 仍有两个可达的状态机矛盾和一个计数边界缺口，不能批准。

## 阻断项

### HIGH-1：N43 断言了正常第六次启动不可能留下的状态

`design-v12.md:9` 明确规定正常第六次启动完整执行：

```text
claim held_alert_pending → spool → alert → held_alert_attempted → exit
```

继承的恢复合同也一致：正常 threshold 分支最终 CAS 到 `held_alert_attempted`，只有 claim 后、spool 前崩溃时才会留下 `held_alert_pending`（`design-v11.md:21,23-24`）。

但 N43 却要求六次“真实执行”结束后断言 `state=held_alert_pending`（`design-v12.md:11`）。不注入 crash 时实现遵守第 9 行就会使 N43 失败；为满足 N43 而停在 pending，又会跳过已闭合的 spool/alert/attempted 合同。

最小修订：正常 N43 应断言第六次不 exec 且最终 `state=held_alert_attempted`。若还要检查 pending，只能另设 fault-injection 子例，在 claim rename 后立即 crash，先断言 pending，再由下一次启动按 `design-v11.md:21` 恢复到 attempted；N42 已覆盖的 crash-replay 语义无需重开。

### HIGH-2：授权 resume 写者没有被明确纳入同一把 `<child_key>.lock`

v12 只对“resumed 启动分支”明确写了取同一把锁后执行 `resumed→active`（`design-v12.md:8`）；继承文本则只说授权命令 `CAS held_*→resumed`（`design-v11.md:25`）。`temp+fsync+rename` 只保证一次替换原子可见，并不提供“比较仍为 held”这一原子条件；没有把 resume 的“重读状态+条件判断+rename”放进同一锁临界区，就无法实现文档所称的 CAS。

可达交错：

1. 两个并发 resume 命令都在锁外读到 `held_alert_attempted`；
2. resume A rename 为 `resumed(t1)`；
3. wrapper 持锁执行 `resumed→active`，甚至完成第六次 claim；
4. resume B 用先前的旧读结果 rename 为 `resumed(t2)`，覆盖 active/held。

这会重置计数下界，最坏还会解除刚建立的 hold。它正是“resume 命令与下一次启动之间再次 resume”的竞态，wrapper 自己持锁不能排除锁外写者。

最小修订：规定**所有**状态文件写者都先取得同一 `<child_key>.lock`；resume 必须在锁内重读，并只在实际状态仍为 `held_*` 时写 `{state=resumed,last_resumed_at=now,...保留字段}`。并发第二次 resume 在取得锁后看到 `resumed` 或 `active`，必须幂等 no-op/明确拒绝，且不得改写 `last_resumed_at`；取锁失败沿用 `design-v11.md:18` 的 fail-closed。N43 增加“两次 resume 与 wrapper 并发”交错，断言恰一 resume 成功、无 stale rename 覆盖 active/held。

## 直接相关缺口

### MEDIUM-1：`last_resumed_at` 在首次 resume 前无值，严格时间比较也未保证真实第一次启动一定被计数

v12 规定该字段“随 resume CAS”才写入（`design-v12.md:7`），但 threshold 谓词直接使用 `event_ts > last_resumed_at`（`:9`）。继承的初始 `active` 状态文件没有该字段（`design-v11.md:17,23`），所以 fresh child/旧状态文件在首次 resume 前如何评估未定义；若按 NULL 比较，原有 active crash-loop 会永不达阈值。

另外，“resume 后立即下一次启动”（`design-v12.md:8`）与严格 `>` 之间缺少时钟精度/回拨合同。若 resume 与第一条 event 使用同一离散时间戳，或 wall clock 回拨，第一条 post-resume event 会被排除，六次真实启动只计到 5，直接推翻 `design-v12.md:11`。

最小修订可二选一：

1. 明确 `last_resumed_at` 缺失时等价于无下界，并规定 ledger 时间戳具备跨该临界点的严格全序与回拨处理，补 same-tick 测试；
2. 更稳妥地在同一锁内记录 durable ledger cursor/sequence（例如 `last_resumed_seq`），以 `event_seq > last_resumed_seq` 计数，时间戳只负责 10 分钟滑窗。

无论采用哪种方式，字段都应在 `resumed→active→held_alert_pending→held_alert_attempted` 中保留；只有下一次成功的 `held_*→resumed` 才推进下界。v12 第 7 行已有后一半规则，缺的是首次值与可比较顺序。

## R13 最小修改集

1. 把正常 N43 的最终状态改为 `held_alert_attempted`；pending 只在显式 claim 后 crash 子例中断言。
2. 明确 resume 命令也持有同一 `<child_key>.lock`，锁内重读并条件写；第二次/并发 resume 不得刷新下界或覆盖 wrapper 的后继状态。
3. 定义 `last_resumed_at` 缺失语义以及 post-resume 事件的严格排序保证，或改用 durable ledger cursor；让 fresh active 与真实六次 post-resume 启动都可确定验收。

除此以外，R11 的原始 resumed/state 谓词互斥、30 分钟惰性吸收态和 `last_resumed_at` 后续保留均已闭合；不要求修改其他已闭合章节。
