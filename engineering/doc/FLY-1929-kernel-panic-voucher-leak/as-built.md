# FLY-1929 as-built — 最终落地的形态

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: plan.md(设计阶段), verification-and-scope.md(复核与范围)

> **读这份,不要读 plan.md 的实现细节。**
> `plan.md` 记录的是**设计阶段**的推演(它本身经过 6 轮 design review),
> 但实现期又发生了两次方向变化,plan 里的组件名、度量、状态机描述**已经过期**。
> 本文件是最终真实落地的样子。plan.md 保留作为决策史,不再是实现的权威描述。

## 0. 两次方向变化,以及为什么

| 阶段 | 形态 | 为什么变 |
|---|---|---|
| plan 定稿 | `flywheel-voucher-guard.sh`,自带 outbox / 锁 / 状态机,判据 `bank_task + bank_account` | design review 通过的设计 |
| 实现后第一次变 | 更名 `voucher-watch`,判据改 `bank_task` | **遏制手段早已在生产**(Lead 转向令 + 我独立复核)。而且原判据在生产的健康周期里**每小时都会告警两次** —— 见 §2 |
| 实现后第二次变 | **砍掉全部跨 tick 状态**,1420 行 → 327 行 | code review 指出这是「在 `lead-alert.sh` 已有的持久投递之上又盖一层」,而一半 BLOCKER 就长在那层重复基建里。Lead 裁决:砍到骨头 |

## 1. 最终产物

| 文件 | 行数 | 作用 |
|---|---|---|
| `scripts/flywheel-voucher-watch.sh` | 398 | 唯一的生产脚本。**无跨 tick 状态** |
| `scripts/lib/voucher-panic-match.py` | 173 | 只做一件事:判断报告的 `panicString` 里有没有那个 marker |
| `scripts/__tests__/voucher-watch.test.sh` | 413 | 50 条契约用例 |
| `scripts/launchd/com.flywheel.voucher-watch.plist` | — | `StartInterval` 60,`RunAtLoad` true |
| 告警 kind `host_voucher_incident` 的 5 个面 | — | 见 §5 |

## 2. 核心设计决定:**判据用 `bank_task`,而且阈值必须高于生产守卫的触发点**

生产里那个 root 守卫(`com.annie.voucher-guard`)在 **`bank_task` > 200000** 时重启 `ecosystemanalyticsd`,
实测约**一小时一个周期**,峰值约 204k。

我原本的判据分子是 `bank_task + bank_account`。**这个选择会每小时刷屏两次**,原因是:
在高占用区 `bank_account` 与 `bank_task` **几乎相等**(实测差约 950),
所以每个健康周期的峰值,那个和都会到 **约 407k**,同时越过我原定的 warn(157286)与 severe(262144)。

⇒ 最终:

    判据 = bank_task(**故意跟生产守卫用同一个数**)
    warn   >= 260000   severe >= 350000
    含义   = 「守卫本该在 200000 动手,它没动」

这样一个健康的 204k 周期**永远不告警**(测试 A0 就是钉这条的)。

## 3. 无跨 tick 状态 —— 这是最重要的一条

**告警的 signature 就是状态,去重交给 `lead-alert.sh` 的 claims.db。**
它本来就有永久回执表、spill queue、死信和 drain —— 我先前那版把这些**又实现了一遍**。

signature 设计:

| 触发 | signature | 去重粒度 |
|---|---|---|
| panic 复发 | `panic:<报告文件名>` | **永久一次**(文件名唯一) |
| 守卫不见了 | `guard-absent:<YYYYMMDD>` | 一天一条 |
| 占用量高水位 | `bank-task-high:<level>:<YYYYMMDD>` | 每级每天一条 |

因此**不需要**:锁、状态文件、schema 校验、generation id、outbox、episode 序号、可续扫的分块解析器。
它们连同各自的失效模式一起消失了(那正是 code review 两个 BLOCKER 的所在)。

**代价(Lead 已知悉并批准)**:防抖从「每个 episode 一条」降级为「每天一条」。
对「守卫死没死」这种低频事件,这个分辨率够用。

## 3.1 无跨 tick 状态的两个例外(都是刻意的,且都只会「多发」不会「漏发」)

「无状态」是原则,不是教条。code review 打出两个必须处理的现实问题,各加了一个**极小**的机制。
两者的共同点是**失效方向安全**:弄丢它们只会导致多发一条告警,永远不会导致漏发一条。

**① 本地发送冷却(每个 signature 一小时)。**
claims.db 不可用时 `lead-alert.sh` 会 **fail-open 直接 POST**,于是一个每分钟跑一次的生产者
会在整个故障期间每 60 秒重发同一条告警。冷却把它压住。
关键实现细节:**戳只在投递被确认之后才写**(`sent` 或 `queued_transient`)。
如果在投递前就盖戳,一次失败的尝试就会把重试压制整整一小时 ——
那等于把一次瞬时故障变成一条被悄悄扣下的告警。
另外戳内容不是数字、读不出来、或时间倒流,一律**不压制**。

**② 扫描轮转的随机起点。**
每 tick 的匹配预算有限,所以要轮转。起点**不能**用时钟推导:
时钟推导的话每次触发前进 step×P,只要 step×P 是剩余集合大小的整数倍,窗口就**永远不动**,
那批报告被永久饿死 —— 而 P 不由我们决定,launchd 在上一次还没跑完时会直接跳过一次 StartInterval。
改成随机起点就锁不进这个共振。代价是保证从「硬上界」降级为**概率性**:
每 tick 覆盖 step/rest,k 个 tick 之后仍未被检查的概率是 (1 - step/rest)^k,
100 份报告时第 20 个 tick 已低于 2%。文档和代码都按这个诚实口径写。

## 3.2 panic 判定的那条格式假设(Lead 收敛条件,写在这里以免被后人当成通用逻辑)

matcher 只有在**完整读到一个顶层 `panicString`** 且不含 marker 时才返回 NO_MATCH,否则返回 UNKNOWN。

**这条为什么安全,依据是格式而不是通用 JSON 推理**:Apple 的 panic 报告把 `panicString`
放在 body 对象的开头(真件 4,984,601 字节,它在第 442 字节),而且**只有一个顶层的**。
所以一旦完整读到一个,就不存在「后面还有一个没读到」的可能。决策变量已被完整观察,
被截断的是与判定无关的剩余部分。

**假设被违反时不给否定结论**:
- 文档里出现**多于一个**完整的顶层 `panicString` ⇒ 返回 UNKNOWN(测试 C21)
- 截断且**没有**读到任何完整的顶层键 ⇒ 返回 UNKNOWN(测试 C22)

两种情况都会浮出面包屑,而不是安静地把报告判为「不是复发」。

**为什么不干脆让截断一律 UNKNOWN**(Codex 的建议,Lead 裁定不采纳):
那样每一份**大的、正常的**非 voucher panic 报告都会永久处于「无法判定」,每 tick 刷一条面包屑 ——
等于造一个天天喊狼的仪表,把一个正确性风险换成一个必然发生的噪音问题。

## 4. 三件它会告警的事

1. **panic 复发** —— 扫 `/Library/DiagnosticReports`,读每份报告的前 256KB(**深度追踪的流式扫描**,不是整体解码 ——
   真实报告 4.98MB,panicString 在第 442 字节但外层对象几 MB 后才闭合,整体解码在真件上必然失败),
   **在解析出来的 `panicString` 值内部**匹配 marker(不是在原始字节里 grep ——
   否则一份只是引用了这句话的报告会误报,测试 C3 专门钉这条)。
   已处理过的 2026-08-20 那份是唯一被静音的。
2. **遏制守卫不见了** —— launchd 域里查不到、且 plist 也不在。
3. **`bank_task` 高水位** —— 见 §2。

**这三条路径互相独立**:`zprint` 坏掉时 panic 扫描照常进行(测试 C7),
因为传感器故障绝不该让我们错过一次复发。

## 5. 告警 kind 的 5 个生产面

`host_voucher_incident`,`owner: claude`,`arc: human_by_design`(**没有**可执行的自动补救,
写 `auto` 会让 kind 表说谎)。必须同步的 5 处:

1. `scripts/lead-alert.sh` 的 `--kind` 校验分支
2. `packages/teamlead/src/LeadAlertNotifier.ts` 的 `ALERT_EVENT_TYPES`
3. `packages/teamlead/src/bridge/kind-contract.ts` 的 `KIND_CONTRACTS`
4. / 5. `packages/teamlead/src/bridge/alert-kind-copy.ts` 的 `titleFor()` 与 `bodyFor()`

第 4、5 是**没有 `default` 分支的穷尽 switch**,漏了 TypeScript 直接编译不过。

⚠️ **给下一个加 kind 的人**:通用漂移守卫**只**断言 shell → TS union 这一个方向。
我实测把 kind 从 shell 允许列表里删掉,`kind-contract.test.ts` 依然 27/27 全绿 ——
也就是说「union 里有、shell 里没有」能编译、能过测、然后在运行时被
`lead-alert.sh` 以 `unknown --kind` 拒掉。所以本单按既有惯例补了一条逐族断言,
并做了 RED→GREEN 验证。**别指望通用守卫。**

## 6. 验证

- 50 条契约用例在 **`/bin/bash` 3.2.57(macOS 自带)与 bash 5 下都全绿**,每条新增回归都做过变异验证。
- **在 launchd 同款环境下真跑过**:`env -i` + launchd 默认 PATH + 隔离 HOME + 不 source `.env`,
  tick 退出 0 并写出合法遥测行。顺带确认 `python3` 走的是 `/usr/bin/python3`(3.9.6)——
  matcher 在 3.9 上实测可用,不依赖 homebrew 那个 3.14。
- `shellcheck -S error` 干净;`py_compile` 干净;全仓 `pnpm lint` 0 error;`pnpm -r build` 绿;
  launchd manifest / CI 枚举 / CI structure 三道守卫绿;`plutil` **与** `plistlib` 都绿
  (两者不等价:XML 注释里出现 `--` 时 `plutil` 放行、`plistlib` 拒收,我踩过)。
- **零新增受治理的 `FLYWHEEL_*` 环境变量**(注入点一律 `VOUCHER_WATCH_*`;
  flag registry 只管 `FLYWHEEL_` 前缀)。

## 7. plist 里两个刻意的决定

- **不 source `.env`。**`lead-alert.sh` 的 system 身份分支自己会在隔离子 shell 里读
  `~/.flywheel/.env`,而且只取频道 id 和发信 token 选择器两个值。
  在 plist 里整份 source 会把**所有**无关密钥推进这个 watcher 及其全部子进程,毫无收益。
- **只设 `PATH`,不设别的。**已实测所有依赖在 launchd 默认 PATH 下都能解析。

## 8. 明确没做的

- **不做任何自动补救**(遏制已在生产,见 runbook §3)。
- **不动 `flywheel-cmux-sync --watch`**(D②)。理由与实测数字见 `verification-and-scope.md` §3:
  它占 fork 的 22.8%,但砍一半只降总 churn 约 11%,**不改变会不会 panic**,
  而代价是动一个 9800 行、近期连出四次事故文件的核心循环。Lead 已同意单独立单。
- **不合并 FLY-1887**(冻死,机理不同)。
- **不上报 Apple**(需要更多归因数据;本单产出的时间序列是将来的材料)。
