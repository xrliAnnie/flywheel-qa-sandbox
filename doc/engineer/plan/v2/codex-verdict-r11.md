CHANGES REQUESTED

# Flywheel v2 设计稿 v11 复审 R11

- 评审对象：`/tmp/design/design-v11.md`
- v11 SHA-256：`478f206f88fef1ea815ec80b8f66bbf7f7e9a887597ba81843f6650a1da198a7`
- R10 基线：`/tmp/design/codex-verdict-r10.md`（SHA-256 `f640e8240aeb046627b9aeec407a107f5c279feb55698108a3e447c4a5f897c3`）
- 仓库锚点：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main@37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交，工作树无改动。
- 评审边界：只逐项核对 R10 第 162-165 行的 R11 最小修改集及其新矛盾；R6-R10 已闭合项未重开。四条 SELECT 由 v11 第 2、4 行原样继承 v10，本轮未重新评判 SQL。

## 结论

R11 的三项修改中，两项闭合，一项仍有状态谓词矛盾：

1. SLA 已闭合。`A=1+S×(K+1)` 后 deliver、`T_max`、switch 均按全部 attempt 槽计；默认值严格算得 585 分钟，451/455 分钟反例均不超过新上界（`design-v11.md:7-12`）。
2. restart 的 pending recovery、`count>=6` replay predicate、threshold claim 与 episode key 原子持久化、稳定 spool，以及可部署的 `fcntl.flock` fail-closed 后端均已写明；但 `resumed` 分支无法再次执行唯一的 threshold claim，N43 仍不可满足（`:17-26`、`:36`）。
3. suppression 方案 A 已闭合。被抑制 command 留在既有 `pending` 枚举，dispatcher predicate 阻止 claim；parent-clear 在同事务插入/放行最新 tier、取消旧 tier、推进 enqueue 进度并清债，无 commands schema 缺口（`:30-34`）。

因此 R11 仍不能批准。

## 阻断项

### HIGH-1：`resumed` 的评估分支与唯一 threshold claim 谓词互斥

`design-v11.md:22` 规定，`resumed` 在尚未满足 30 分钟惰性转移时“按 active 的评估流程处理”，但状态仍是 `resumed`。`:23` 唯一写出的 threshold claim 谓词却是：

```text
count(窗口内事件) >= 6 AND state = active
```

所以以下时间线不会产生文档声称的新 episode：

1. 授权 resume 写入 `{state=resumed,resumed_at=t0}`；
2. `t0+1m ... t0+6m` 连续启动六次，每次都在 30 分钟内，不能执行 `resumed→active`；
3. 每次虽 append ledger event 并进入“active 的评估流程”，但 `state=active` 恒为假；
4. 第六次仍会 exec child，不会 claim `held_alert_pending`。

这直接推翻 `:24` 的“resume 后再 crash-loop 可再次触发 threshold”和 `:26/:36` 的 resumed/N43 验收。并且，只要 resume 后出现过 ledger event，`:22` 的“now−resumed_at≥30min 且该区间无事件”按当前文字也不会在以后自动恢复为真；`resumed` 可永久成为不受风暴阈值约束的吸收态。

最小修订二选一：

1. 让 `resumed` 立即具有 active 的 threshold 权限：append 后以 `count(只含 resumed_at 后事件)>=6 AND state IN (active,resumed)` 评估，并对实际当前状态执行 CAS 到 `held_alert_pending`；episode key/window_start 随 claim 原子落盘。
2. 或在 `resumed` 每次启动评估前先以同一 `<child_key>.lock` 原子转成 `active`，同时保留 `resumed_at` 作为新 episode 的计数下界；不得等到 30 分钟才允许重新 hold。

若仍保留“健康 30 分钟后归档旧 episode”的语义，应把安静条件写成明确可再次成立的区间（例如当前启动之前连续 30 分钟无 ledger event），而不是从固定 `resumed_at` 起永远要求零事件。N43 必须真实执行六次 post-resume 启动并断言第六次不 exec、状态为 held、episode key 属于新窗口。

## 585 分钟独立验算

按 `design-v11.md:8-11`：

```text
S = (q−1)×5+R = (1−1)×5+5 = 5
A = 1+S×(K+1) = 1+5×(4+1) = 26

T = T_tick
    + A×(T_deliver_tot+T_max+T_switch)
    + (R−1)×(T_due_cap+T_tick)
  = 1 + 26×(5+10+5) + 4×(15+1)
  = 1 + 520 + 64
  = 585 分钟
  = 9 小时 45 分
```

R10 的不含 deliver 反例是 451 分钟；若四次 retry due 后各再计一个 tick，则为 455 分钟。新公式分别留有 134/130 分钟余量，均未超过 585。多出的 130 分钟正是 26 个槽各 5 分钟 deliver，总公式另为四次 due 各补 1 分钟 tick；算术与倍率严格一致。

## restart 其余逐项核对

| 要求 | R11 结果 | 证据 |
|---|---|---|
| pending 恢复分支 | 闭合 | `held_alert_pending` 明确不 exec，按稳定终址补 spool、发 stable-key alert、再转 attempted（`:20-21`）。 |
| 可重放谓词 `count>=6` | active 闭合，resumed 未闭合 | append→claim 崩溃后 active 重放成立（`:23-24`）；但 resumed 被 `state=active` 排除。 |
| episode key 原子落盘 | 闭合 | threshold claim 同一次 rename 持久化 state、episode_key、window_start，并有文件/目录 fsync（`:17`、`:23`）。 |
| resumed 惰性转移 | 未闭合 | 观察者已改为下一次启动，但 post-resume crash-loop 无法 claim，且固定起点的“区间无事件”可永久不成立（`:22-24`）。 |
| `fcntl` 锁 fail-closed | 闭合 | v11 明确 macOS 后端与失败不 exec（`:18`）；仓库现有 helper 使用 `LOCK_EX|LOCK_NB`、超时退出 75，并把 fd 继承给 exec 后命令（`scripts/lib/tmux-server-rescue.sh:1590-1618`）。 |
| claim/spool/alert crash replay | active 闭合 | claim 前重算，claim 后由 pending 分支补发，alert 后未 CAS 则稳定 key 重发（`:21`、`:23-25`）。 |

当前仓库事实仍与设计假设一致：macOS 缺少 `flock(1)`（`scripts/inject-linear-issue.sh:119-123`）；现有 `meta-alert.sh` 是 marker debounce + best-effort file/desktop sink（`scripts/meta-alert.sh:29-53`）；Bridge wrapper 最终 `exec` child（`scripts/flywheel-bridge-wrapper.sh:211-220`）。R11 对这三点的修订方向正确，剩余阻断仅是 `resumed` 转移/claim 合同。

## suppression 方案 A 核对

`design-v11.md:31-34` 已覆盖 R10 的两个缺口：

- command 在受抑制期间保持现有 `pending`，没有新增 `suppressed/held` 枚举，故不需要 commands 重建迁移；
- parent 已 open 时只更新 `suppressed_tier`；若 command 已存在，它留在 pending 并被 claim predicate 拦住；若最新 debt 尚未 enqueue，parent-clear 以 `suppressed_tier>last_enqueued_tier` 插入恰一最新 tier command；
- parent-clear 的插入/推进、旧 tier cancel、`suppressed_tier←NULL` 在同一事务，effect key 唯一性与清债共同保证 crash replay/reconcile 幂等；
- `last_notified_tier` 仍只由 effect receipt 推进，没有把 enqueue 或解抑误报为已送达。

该修改没有 schema 缺口，也没有发现新的 parent-open/parent-clear crash window。

## R11 最小修改集

只需修正 `resumed`：让 post-resume 启动既按 `resumed_at` 后的新窗口计数，也能从实际 `resumed` 状态原子 claim 新 hold；同时把“健康 30 分钟”的安静区间定义成会在最后一次 restart 后重新成立的窗口，并让 N43 覆盖这条真实转移。SLA、四条 SELECT、suppression 不需要再改。
