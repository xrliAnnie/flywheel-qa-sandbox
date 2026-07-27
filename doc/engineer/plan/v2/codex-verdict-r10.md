CHANGES REQUESTED

# Flywheel v2 设计稿 v10 复审 R10

- 评审对象：`/tmp/design/design-v10.md`
- v10 SHA-256：`e84f3d6a90a67a1b12b6f585866f213bd7baf724d3c37a5b7245422111969710`
- R9 基线：`/tmp/design/codex-verdict-r9.md`（SHA-256 `81ddd7b8230a614e41939081b877f6b183e98e7310b4f3c3ae4f8cd3a39be45c`）
- 仓库锚点：本地 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；本地 `origin/main@37bcb8e2d4d12869cd5afbc52700d37a5902ed1f`，checkout 落后 1 个提交，工作树无改动。
- 评审边界：只逐项复核 R9 第 190-193 行指定的四项 R10 最小修改，并检查这些修改引入的新矛盾；R6-R9 已闭合项没有重开。

## 结论

R10 有一项完全闭合、三项仍未闭合：

1. 四条 founder/non-founder × immediate/scheduled SELECT 已写全；SQLite 3.51.0 原样执行均返回正确候选，四条 `EXPLAIN QUERY PLAN` 分别命中对应 `_f/_nf` partial index（`design-v10.md:21-43`）。
2. SLA 已统一为一个公式，`T_deliver_tot` 也已改成总 deadline；但公式算术、倍率和可达反例仍不成立（`:13-20`）。
3. restart 增加了 durable hold 状态名和写盘协议，外部告警也诚实降为 at-least-once/debounce；但启动顺序没有 pending recovery 分支，阈值 CAS 与 `resumed` 生命周期仍有 crash window（`:49-55`）。
4. claim-first 胜负已明确定义，三个 tier 也已分名；但 command 的 `suppressed/held` 状态没有 schema 迁移，`suppressed_tier` 在 parent-clear 时如何清债也未定义（`:10`、`:58-65`）。

因此 R10 仍不能批准。

## 阻断项

### HIGH-1：统一 SLA 公式仍低估逐 attempt 的 switch，且文内默认值算错

`design-v10.md:16-18` 定义：

```text
S=(q−1)×5+R
T(q,R) ≤ T_tick + (1+S×(K+1))×T_max
         + S×(T_deliver_tot+T_switch)
         + R×T_due_cap
```

代入文档自己的默认值 `q=1,R=5,K=4,T_tick=1,T_max=10,T_deliver_tot=5,T_switch=5,T_due_cap=15`：

```text
S = 5
A = 1 + S×(K+1) = 26 个可能 attempt 槽
T = 1 + 26×10 + 5×(5+5) + 5×15
  = 386 分钟
  = 6 小时 26 分
```

所以 `:18` 的“≈4.6h”不是该公式的结果，少报 110 分钟。

更重要的是，这不是单纯展示数字错。`A=26` 已把“当前在途 1 次 + 5 轮中每轮 K 个 founder 和 1 个目标 attempt”计入 `T_max`，但 `T_switch`/`T_deliver_tot` 只乘了 `S=5`。这与 `:15` 的“任一 attempt 超时后换代 ≤T_switch”和 `:20` 的“每次前 K founder、每次 timeout+switch”验收直接矛盾。

以下时间线不使用 deliver 延迟，已经超过公式：

```text
初始 tick                                             1 分钟
当前在途 attempt timeout + switch                    15 分钟
5 轮 × (4 founder + 1 target) × (T_max+T_switch)    375 分钟
目标前 4 次失败后的 due cap                          60 分钟
合计                                                451 分钟
```

若每次 retry 到点还各等一个 tick，则是 455 分钟。两者都大于公式的 386 分钟；因此 `:17` 不是 ready→terminal 硬上界，`:20` 的 N37 按当前公式会假绿。

最小修订：

1. 先定义全部可能 attempt 槽 `A=1+S×(K+1)`；凡可逐 attempt 发生的 `T_switch`（以及若确实在 `T_max` 之外的 `T_deliver_tot`）必须按 `A` 计，而不是按 `S` 计。
2. 明确 `T_deliver_tot` 与“started_at→terminal 的 `T_max`”是包含关系还是串联阶段；若 deliver 已包含在 `T_max`，公式不得一边重复相加、一边又漏掉 founder/current-in-flight 的相同成本。
3. retry due 后的调度 tick 要么逐次计入，要么明确包含在 `T_due_cap`；目标第 5 次失败直接 dead 时通常只有 `R−1` 次 retry due，按真实状态机写清。
4. 用 `:20` 指定的 5×(K founder+target) timeout/switch 时间线计算一个数值上界，并让 `:18` 的默认数字与同一公式严格一致。

### HIGH-2：restart 状态机写出了状态名，但 crash replay 仍走不通

`design-v10.md:51` 的启动顺序规定：

```text
读到 held_* → 直接退出
active → append+fsync → “本次为第 6 次”
       → CAS held_alert_pending → spool → alert → held_alert_attempted
```

而 `:52` 又规定读到 `held_alert_pending` 时重发告警。两句无法同时执行：按 `:51`，pending 启动在步骤 ② 已直接退出，永远到不了 spool/alert recovery。一个具体 crash 点即可造成永久漏报：

1. 第 6 次启动完成 `active→held_alert_pending`；
2. 在写 spool 前崩溃；
3. 后继读到 `held_alert_pending`，按步骤 ② 直接退出；
4. child 确实被 hold，但 spool 和 meta-alert 永远没有产生。

另外还有三个未定义的线性化缺口：

- 在第 6 条 ledger event `fsync` 后、threshold CAS 前崩溃，后继会再 append 第 7 条；`:51` 只写“本次为第 6 次”，没有定义 `count>=6` 的 replay predicate，也没有规定已存在未 claim 阈值事件时不得再 exec。
- `:49` 的状态文件值只有枚举，没有持久化 `episode_key/window_start`；在 held CAS 后、spool 前崩溃时，`:52` 要求的“稳定 episode key”没有随 claim 一起落盘，窗口滑动后无法证明重发仍使用同一 key。
- `:53` 把 hold CAS 成 `resumed`，但 `:51` 的阈值 CAS 只有 `active→held_alert_pending`。若 resume 后未健康满 30 分钟又 crash-loop，`resumed` 如何再次被 hold 未定义；同时 `:54` 明确 wrapper 在 exec 后不驻留，文档也没有指出谁观察“连续健康 30min”并执行 `resumed→active`。

告警语义降级本身是正确方向：当前 `scripts/meta-alert.sh:33-53` 确实只有 marker debounce + best-effort 桌面通知，没有 effect receipt；`scripts/flywheel-bridge-wrapper.sh:211-220` 也确实最终 `exec`。但 at-least-once 需要 pending recovery 真正可达，不能只在说明文字中声明。

最小修订：

1. 把启动分支写成穷举状态机：`held_alert_pending` 必须在“不 exec child”的前提下执行 `ensure-spool → send(stable key) → CAS attempted → exit`；只有 `held_alert_attempted` 才直接退出。
2. threshold 使用可重放谓词（至少 `count>=6 AND state=active`），并覆盖 append-fsync 与 hold-CAS 之间的 crash；阈值 claim 要原子持久化 `{state,episode_key,window_start}`。
3. spool 使用稳定 episode 终址、create-once/幂等覆盖规则、文件与目录 fsync；`rename` 只证明原子可见，不单独证明 exactly-once/durable。
4. 定义 `resumed` 的启动/再次失败/健康确认转移及其观察者。若 wrapper 不驻留，应指定另一个 durable authority；否则删除无法执行的 30 分钟自动转移声明。
5. 当前生产主机是 Darwin，默认没有 `flock(1)`；仓库也明确记录 macOS 无该命令（`scripts/inject-linear-issue.sh:119-120`）。应指定可部署的锁后端（例如仓库已有的 Python `fcntl.flock` helper）及锁获取失败时的 fail-closed 行为。

### MEDIUM-1：suppression 的字段落了，但 command 状态与清债转换仍不可执行

claim-first 仲裁本身已经闭合：`design-v10.md:61-62` 把 parent-open 限定为处理 pending command，已 claim 的 command 明确允许完成；在继承的 SQLite `BEGIN IMMEDIATE` 写纪律与同事务 claim predicate 下，claim commit 与 parent-open commit 有确定先后，不再需要 send 前 TOCTOU 查询。

但 schema/state-machine 还有两个缺口：

1. `:61` 要把 pending command 置为“`suppressed/held` 状态”，而 `:10` 的迁移只给 obligations 增两列。继承的 command CHECK 是 `pending|claimed|accepted|executing|succeeded|failed`，v5 只再增加 `rejected|canceled`（`design-v2.md:18-21`、`design-v5.md:23`）；没有 `suppressed` 或 `held`，而 `:61` 甚至没有选定一个精确枚举。按现有 schema 无法执行该 UPDATE。
2. `suppressed_tier` 被定义为“债”，但 `:10`、`:58-63` 只定义 parent-open 时写入，没有定义 parent-clear 放行时何时原子清为 NULL。`N40` 在 `:65` 也只测 enqueue/parent-open/receipt，漏掉 R9 明确要求的 parent-clear 转换。旧 debt 会永久留在 obligation 上，reconcile 无法区分“仍被抑制”和“已转成 pending outbox command”。

最小修订：

1. 二选一并写死：要么 command 保持 `pending`，只靠 parent predicate 暂停 claim，删除“suppressed/held 状态”措辞；要么选一个精确新枚举，补 commands 重建迁移、CHECK、所有 claim/reconcile/terminal 转换与 replay 测试。
2. parent-clear 事务应明确：按最新 tier 放行/插入恰一 command、推进 `last_enqueued_tier`（若尚未 enqueue）、取消旧 tier，并在同一事务清除 `suppressed_tier`；effect receipt 只推进 `last_notified_tier`。
3. N40 增 parent-clear 前后 crash replay，断言三字段与 command 状态收敛，且清债后不会被 reconcile 重复释放。

## SQLite 原样实测

环境：SQLite `3.51.0`。建立 v9 已闭合的 mailbox 最小 schema 和七个显式 partial index，绑定：

```text
:agent = agent-a
:now   = 2026-07-26T12:00:00Z
```

将 `design-v10.md:25-41` 四条 SELECT 原样执行。测试数据包含普通/founder 的 immediate、已 due scheduled，以及一条未 due founder scheduled。

结果：

```text
2|founder-immediate|founder-i
4|founder-scheduled|founder-s
1|ordinary-immediate|ordinary-i
3|ordinary-scheduled|ordinary-s
```

`EXPLAIN QUERY PLAN`：

```text
F1 SEARCH mailbox USING INDEX mailbox_pending_immediate_f
     (to_agent=?)
F2 SEARCH mailbox USING INDEX mailbox_pending_scheduled_f
     (to_agent=? AND next_retry_at>? AND next_retry_at<?)
N1 SEARCH mailbox USING INDEX mailbox_pending_immediate_nf
     (to_agent=?)
N2 SEARCH mailbox USING INDEX mailbox_pending_scheduled_nf
     (to_agent=? AND next_retry_at>? AND next_retry_at<?)
```

四条均无 TEMP B-TREE，ORDER BY 由对应索引顺序满足；该项完全闭合。

## R10 四项逐项裁定

| 项 | R10 状态 | 核对结果 |
|---|---|---|
| 1 SLA 统一公式 | 未闭合 | 单一公式与 deliver 总 deadline 已落，但 q=1 默认值应为 6h26m 而非 4.6h；更关键是逐 attempt switch 只乘 S、不乘全部 26 个槽，可达 451m 时间线超过 386m 公式（`:13-20`）。 |
| 2 restart episode/hold | 未闭合 | durable 状态名、写盘顺序、告警语义方向正确；pending 分支却直接退出，append→CAS crash、stable key 持久化、resumed 再失败/30m observer 均未闭合（`:49-55`）。 |
| 3 四条 exact SELECT | 闭合 | 四条 SQL 完整可执行，结果正确，四个 EXPLAIN 分别命中 `_f/_nf` partial index（`:21-43`）。 |
| 4 suppressed/tier/claim | 部分闭合 | `suppressed_tier` 列、三字段分义、claim-first 仲裁已落；command `suppressed/held` 无 schema，parent-clear 未清 debt，N40 漏测该转换（`:10`、`:58-65`）。 |

## R11 最小修改集

1. 重写 SLA 成本倍率并重算 q=1 数字；让 N37 的真实 5×(K+1) timeout/switch 时间线不超过公式。
2. 写出 `active/held_pending/held_attempted/resumed` 的逐状态启动分支，持久化 episode key，补 append→CAS、pending→spool/alert、resume 后再失败三类 crash replay。
3. 保持四条 SELECT 不动。
4. 为 command suppression 选定可执行状态方案；在 parent-clear 事务清 `suppressed_tier` 并补 N40 的 clear/replay 验收。
