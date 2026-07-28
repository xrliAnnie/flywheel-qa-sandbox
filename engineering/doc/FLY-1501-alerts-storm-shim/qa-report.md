# FLY-1501 耳朵与守护 — QA 报告

Issue: FLY-1501
日期: 2026-07-28
基于: mapping-v2final.md、plan.md、PR #719

## 0. 结论

**FAIL —— 不给 PASS，退回 implement 修。**

理由不是"我验不动了"，是发现了**本 PR 会让打包/安装形态下所有受管服务起不来**的部署闭合缺陷
（§3.5 F1，Codex R12 实证复现），外加一条要 Lead 裁的 M1。CI 同时全仓停摆（疑账号额度，
只有 Annie 能查），任何端到端验证现在都拿不到绿。

功能本身我验过是对的（§2 全部实证仍然成立）；卡住 ship 的是部署闭合 + 一条设计裁定。

本单交付的五个机制我都用真实行为验过，不是重跑实现者的套件：

- 重启刹车（restart brake）：47 条独立真机断言全绿，含真 fcntl 锁竞争、故障注入、
  状态文件损坏、ledger 半截尾恢复。
- 注入垫片：Claude 走的确实是 stock 适配器同一个写函数；Codex 的生产默认连接路径
  第一次被真正执行（此前所有测试都注入假 connect）。
- heartbeat 守护：新增 TS↔Python 跨语言集成测试，覆盖此前**完全没被测过**的接缝。
- QA 软窗（台账2）、CLI footgun（台账3）：均按合同生效，footgun 有零网络写的实证。
- 48G 内存水位（台账1）：v2 数字正确；v1 不改是 Tadashi 拍板的显式降范围。

## 1. Scope 说明（必读）

我拿到的 QA 任务书写的是**老 scope**（聚合告警四道闸 / 父抑制子 / 三 tier 计数）。
分支实到的是**收窄后的 scope**。收窄依据是 `mapping-v2final.md` §0/§2.1：founder 已批的
v2 终稿把 W1 obligations payload 迁移、W2 聚合告警病历卡族、父压子、三 tier 通知、
restart spool → obligation 投影、C4 `ownerLeadId` 整块作废。

我在 `comm.db` 里查不到映射引用的 `lead-instruction 3348b096-…`（库里只剩 3 条，已轮转），
因此不肯据此默认授权成立，先问了 Tadashi（question `f40dfd4d-…`）。

**Tadashi 已答复确认（2026-07-28）**：收窄是 founder 亲自批的；权威源是 founder 逐轮定稿的
v2 终稿本身，不是那条 instruction，所以 commdb 查不到不影响结论；仓内可核落点是
**过了评审（round 2 APPROVED）的 `mapping-v2final.md`**，它就是本单 scope 真相，
我拿到的任务书是它之前生成的、已过时。删除理由是 Annie 明确否掉那套告警设计
（"发给我这张卡我也啥都干不了"——founder 收到也无法处置的告警卡不该存在），
同族还有"不加任何新 feature flag"的直令。

据此本报告按新 scope 验收，PASS 成立。任务书未随 scope 收窄回写这件事，Tadashi 已单独
记进 v2 病例库（又一例"状态改了消费方看不见"）。

删除是**真删干净**的，不是留后门：`deletion-contract-v2.test.ts` 对 engine 核心源文件
逐条禁 `ownerLeadId` / `consumer_registry:` / `.hint(` / `.deliver(`；
`fence-registry.test.ts` 断言 registry 写入带 `ownerLeadId` 会抛 `FenceViolation`。
我全仓 grep 复核：v2 侧零残留（teamlead 里的 `ownerLeadId` 是 v1 遗留系统，不同东西）。

## 2. 我实际跑了什么

### 2.1 重启刹车 — 独立真机 E2E（47/47 PASS）

自建 harness 驱动真 `scripts/restart-storm-gate.py`（真 fcntl 锁、真 append-only
ledger、真原子 state 文件），两条告警腿用 stub 拦下不发真 Discord：

| 场景 | 断言 | 结果 |
|---|---|---|
| S1 | 10 分钟窗内第 6 次启动被 hold；state=`held_alert_attempted`；Lead 告警恰 1 条；episode_key 文法 `<child>__<YYYYMMDDTHHMMSSZ>__<seq>` | PASS |
| S2 | held 是粘的：再启动仍 exit 3、不重复告警、ledger 不增长 | PASS |
| S3 | `resume` 解除后刹车重新武装；新 episode key 与旧的不同 | PASS |
| S4 | resume 前的事件不再计数（seq 下界生效） | PASS |
| S5 | 窗口外的老事件自然过期，不会攒出误 hold | PASS |
| S6 | `record-failure --expected-seq` CAS：seq 匹配才记账；不匹配 → exit 0 + `recorded=false` + `reason=seq_changed`（幂等 no-op） | PASS |
| S7 | 真两进程锁竞争 → exit 2，**fail-closed 不 exec** | PASS |
| S8 | 故障注入（claim 后崩）→ `held_alert_pending`、零告警；下次启动补发并收敛到 `attempted` | PASS |
| S9 | 告警腿返回 `dead_lettered` / `duplicate` → 保持 pending 重试；`queued_transient` 才推进（at-least-once） | PASS |
| S10 | 已退役的 `FLYWHEEL_RESTART_STORM_GATE=0` 旁路**不再能开闸** | PASS |
| S11 | state 文件损坏 → exit 4 fail-closed + 发损坏告警（绝不静默放行） | PASS |
| S12 | ledger 半截尾 → 截断残尾后继续 append，重启后仍可读，零损坏行 | PASS |

harness 见 `scripts/__tests__/qa-fly1501-restart-gate-e2e.sh`（本 PR 提交，47 条断言）。

**S2 这条断言我自己写错过一次**：原版在 held 重试**之后**才读 `SEQ_BEFORE`，再跟当前值比，
两边永远相等——Codex review 抓出来的 vacuous assertion。改成重试**之前**读，并做了变异验证：
故意让 held 分支也 append，S2 立刻转红（want 6 got 7），恢复后重新全绿。这条现在真的会咬。

### 2.2 heartbeat 守护 ↔ 刹车 的跨语言接缝（新增 5 条，此前零覆盖）

现有 scheduler 测试全部把 `RestartGatePort` 打成 `vi.fn()` mock，所以 TS 守护和
Python 账本**从未一起跑过**。新增
`packages/v2-scheduler/src/__tests__/scheduler-restart-gate-integration.test.ts`：

- 一次失败修复 = 真 ledger 恰 1 条事件（不是 mock 调用次数）；
- 连续失败到触顶 → 真 state 变 `held_alert_attempted`、真 Lead 告警恰 1 条、
  held 之后**不再调 launchctl**、ledger 不再增长；
- wrapper 抢先推进 ledger 的真竞态 → 一次物理重启只记一条，不双计；
- 内存压力 decline → 真 ledger 零写入、不消耗刹车额度、孤儿 attempt 保持 `running`；
- 修复确认成功 → 孤儿 `processing_attempts` 恰一次转 `crashed`，刹车零消耗。

### 2.3 注入垫片

- **Claude 侧属实**：shim 调的 `writeMailboxEntry` 与 `ClaudeCodeAdapter.write`
  （`ClaudeCodeAdapter.ts:127`）是同一个函数，所以"stock 兼容"是事实不是声明。
- **Codex 生产默认路径首次真跑**：此前每个测试都注入假 `connect`。我用真
  `connectDaemonTransport` 打一个不存在的 socket，得到
  `daemon WS connect failed … ENOENT`（不是 `ERR_MODULE_NOT_FOUND`）——证明 `ws`
  能跨 workspace 包边界从 `flywheel-claude-runner` 解析成功。这条已固化成回归测试。
- 新增 `injection-shims-failure-paths.test.ts`（5 条）：connect 失败传播且不建 client、
  client 构造失败仍 close 恰一次、`hint` 是纯 no-op 绝不连接、Claude 侧不同
  messageUid 各自落地 + 不可写 inbox 必须响亮报错（不许静默成功）。

### 2.4 Tadashi 点名要"测试里看得见"的两条合同

他明确说了不接受"代码里是这么写的"，所以两条都落成了可执行断言。

**(a) `deliver` 的完成态钉在 daemon 对注入输入的接受回复上，不是 vendor 任务完成**
（`injection-completion-semantics.test.ts`，4 条）：

- daemon 接受 `turn/start` 后**永不**报任何完成事件 → `deliver` 照样 resolve
  （断言 `postAcceptanceFrames === 0`，即"没有完成信号"是这条用例的前提而非巧合）；
- daemon 接受后**再报 `turn/failed`** → 投递不被回滚、不被重新裁决，临时连接也没有被
  重新打开去观察它；同形状再验一次 `turn/completed`。两条都断言那条通知**确实发出了**
  （`postAcceptanceFrames === 1`），避免空过绿测；
- 每条都断言完整 envelope 确实作为 `turn/start` 的 input 发了出去；
- 镜像面：daemon **拒绝**（busy/race）时必须 reject 成 retryable —— 否则"接受"和"拒绝"
  对引擎不可区分，前三条也就没有意义。

**这条证据的边界我说准**（Codex R2 要求收窄，我采纳）：用 fake transport 能钉住的是
"envelope 发出去了 + `deliver` 结算在 `turn/start` 的成功回复上、不等后续任何事件 +
拒绝仍可区分"。它**证明不了**输入已进 daemon 的持久 thread 记录——那需要真 daemon 侧的
persistence observable，任何 shim 层测试都没有。所以本报告不写"持久接受"。

**(b) 配置校验失败只降级 scheduler，消费循环照跑**
（`packages/v2-engine/src/__tests__/scheduler-failure-domain.test.ts`，5 条）：
按**生产真实拓扑**验，不是同进程模拟——scheduler 本来就是 launchd 拉起的短命独立进程。

- 真跑 `packages/v2-scheduler/dist/cli.js` **子进程**，三种坏旋钮值（`0` / 非数字 /
  补零 `04`）各自：进程非零退出、stderr 点名 `FLYWHEEL_V2_RESTART_CONCURRENCY_MAX`、
  共享库里 `scheduler_runs` / `scheduler_leases` / `scheduler_repair_leases` **全空**、
  pending 消息原样不动；
- 同一个 kernel 库上跑**真 `EngineDriver` 消费循环**：先 drain 干净 → 中间插一次坏配置
  scheduler 子进程（非零退出）→ 再入新消息仍 drain 到 `applied`，注册没被停也没降级；
- **阳性对照**：旋钮合法时同一条 CLI 确实能摸到库并记下 `scheduler_runs = 1`。
  没有这条，上面的"零行"也可能只是"CLI 根本连不上库"。

CLI 未构建时这个文件**响亮报错而不是静默 skip**——被跳过的隔离证明和通过的隔离证明
长得一模一样。

### 2.5 台账三条

| 台账 | 验证方式 | 结果 |
|---|---|---|
| 1. 48G 内存水位重校 | 真跑 `deriveMemoryThresholds(48GiB, 16KiB)` → swapout floor **3072 页/tick（48MiB）**、free trigger 3.84GiB、clear 7.20GiB，与终稿逐字相符；16GiB/4KiB 仍保 2/4GiB 绝对地板 | PASS（范围见 §4） |
| 2. QA 提交软窗预约制 | heavy 系模板 qa 节点 = 180min，其余不声明 = 60min 字节兼容；admission / idempotent replay / delivery repair 三条路径同源计算；**绝对 deadline 结构性不刷新**——`StateStore.workflowCredentialRotationExpiryTx` 取全部已存行的**最早** deadline 为准，轮换只能收紧不能放宽 | PASS |
| 3. CLI footgun | 真起 HTTP 监听当 Bridge，6 种畸形调用（裸跑/缺 exec-id/缺 pr-head/短 sha/非 hex/空白 exec）全部 exit 1 + usage 到 stderr + **零 Bridge 请求**；带阳性对照证明监听器确实会记流量 | PASS |

台账2 的实证细节：我核过 `emitCodexReviewResult` 本身零 diff，所以
`await-codex-gate` 的程序化路径行为字节不变。

## 2.6 我自己这批 QA 代码也过了 Codex review（4 轮 APPROVED）

QA 写的测试不该免检。对 `d64dab8d~1..4e9971fe` 跑了 Codex code review（xhigh），
**4 轮、11 条 finding、全部是真问题、全部已修**，最后一轮零保留 APPROVED。

抓得最狠的三条：

1. **R1 MEDIUM — 我自己写了个空过绿测**：restart-gate harness 的 S2 在 held 重试
   **之后**才读 ledger seq，再跟当前值比，两边永远相等。改成重试前读，并做变异验证
   （让 held 分支也 append → S2 立刻转红 want 6 got 7 → 恢复后全绿）。
2. **R2 HIGH — 我的 harness 会写真实用户状态**：CLI footgun harness 拿真 `$HOME` 跑真 CLI，
   一旦 Bridge 投递失败，emitter 会往 `~/.flywheel/state/codex-review-result-failed/` 落
   fail-closed marker。改成 throwaway HOME + 断言没产生 marker。**这是潜在风险不是已发生的
   污染**——真目录里 7 个文件没有一个是本 harness 的 exec id，因为这几次跑请求都到了本地监听器，
   marker 分支从没走到。我不把没做过的清理说成做过。
3. **R2 MEDIUM — 阳性对照对不上**：harness 的 env 值和显式 flag 值当时是同一对，
   所以"CLI 只校验 flag 存在、payload 却用 env fallback"这种 bug 我照样测不出来。
   改成 env 用另一组合法值，并断言 payload 里是显式值、env 值一个字节都没漏进去。

还有两条是"报告写得比测试能证明的多"，两条来源不同、不要混为一谈：

- **R2** 判定"输入已进 vendor 持久 thread 记录"这个措辞越界——fake transport 证不了 daemon
  侧持久化。已按实测能力收窄（见 §2.4a），我没有为了让结论好看去伪造一个 persistence oracle。
- **R3** 判定报告声称"每条 case 都断言完整 envelope"当时并不成立（只有 silence 一条做到了）。
  我选择把话变成真的而不是把话改小：给其余三条 case 都补上了同一条断言。

**留在台面上的验证边界**：Codex 的沙箱禁 `listen 127.0.0.1`（EPERM），所以 CLI footgun
harness 的 26/26 是**我的测量、不是它的独立复核**；其余数字（build / 61/61 / 34/34 / 47/47）
都是它自己重跑的。

## 3. 发现与分类

**Lead 裁定（[lead-instruction 75292526-…]）**：每条必须标明是本 PR 引入的还是先前就存在的。
本 PR 引入的就地修，不许推给新单；先前存在的写进 gate 正文由 Annie 定。

**分类结果：三条全部是本 PR 引入的，没有一条先前存在。** 证据取自 merge-base `ad22b8e3`：

| # | 分类 | 证据 | 处置 |
|---|---|---|---|
| M1 | **本 PR 引入** | `packages/v2-scheduler` 整包在 merge-base 上不存在 | 修法待 Lead 裁（见下） |
| M2 | **本 PR 引入** | `injection/claude-shim.ts` 在 merge-base 上不存在 | **已就地修** |
| M3 | **本 PR 引入** | 五个 wrapper 在 merge-base 上都在，但 `restart-storm-gate` 引用数全为 0；HEAD 上各 1。本 PR 之前没有这次 gate 调用，该失败模式不存在 | **已就地修** |

> 取证留痕：第一次跑这组查询我用 zsh 写，`git show` 因 bad substitution 失败、`grep -c`
> 对空输入返回 0，差点把假 0 当证据。改用 `/bin/bash` 重跑才是上表的真数。


### M1 — AIMD 并发容量算了但从来没人用，env 旋钮结构性失效

`RestartCapacity` 在 `scheduler-once.ts:179` 被实例化，`observePressure` /
`observeHealthy` 也照喂，但 **`capacity.current` 全仓零读取方**（生产代码 grep 为空），
而且修复循环是严格串行的 `for…of await`。所以：

- 实际并发恒等于 1（**方向是安全的**，不是安全回归）；
- `FLYWHEEL_V2_RESTART_CONCURRENCY_MAX` 在 `truth.ts` 登记为"numeric tuning knob：
  v2 scheduler 并发上限"，但**调它不产生任何行为差异**；
- 映射 §4.3 第 1–5 条的 AIMD 合同只在单测里成立，没有接线。

**分类：本 PR 引入**（v2-scheduler 是新包）。按 Lead 标准要就地修，但**修法本身要 Lead 裁**，
我不自己挑：(a) 真接线——让修复循环按 capacity 收口，但今天的循环是本轮把所有 candidate
串行修完，接上 capacity=1 就变成每 tick 只修一个，是行为收紧、可能降恢复吞吐；
(b) 诚实降级——承认本单没接线，在 truth.ts 标预留。两条都改已批面，已发 ask 等裁定。
**PASS 因此压在 M1 裁定之后。**

### M2 — Claude 垫片绕过了 adapter 的 payload 大小上限

`ClaudeCodeAdapter.write` 在写之前会跑 `validatePayloadSize`（默认 1MB 上限）；
垫片直接调 `writeMailboxEntry`，**跳过了这道校验**。上游 `enqueue()` 也不限
`envelope.payload` 长度（我读过 `enqueue.ts:86-110`，只校验非空字段和 cutover epoch）。
结果：一条超大消息会被原样写进 stock inbox JSON，而 Claude 原生 poller 每秒整文件读。

注意 plan §W4 原文要求"经 transport 包公开 API（`ClaudeCodeAdapter.write`，
**非**内部 subpath `writeMailboxEntry`）"；实现改走了后者，mapping §2.3 记了导出面变更，
但没记这条 size guard 因此掉了。

**分类：本 PR 引入 → 已就地修。** 垫片补回同值同语义的 1MB 上限（`MailboxWriteError`，
与 `ClaudeCodeAdapter.validatePayloadSize` 一致）。这是回到已批设计要求的位置，不是新决定。
新增测试是**精确边界**（R9 判我原来那版"1,000,101 拒 / 1,124 收"不算边界）：从实测算出
envelope 开销，构造出编码后**恰好 1,000,000** 与**恰好 1,000,001** 两条消息，前者照常写入、
后者拒绝且**一个字节都没落盘**，并断言抛的是 `MailboxWriteError` 类型本身而不只是文案。

### M3 — gate 脚本缺失/丢执行位会静默让全部 5 个受管服务永不启动

五个 wrapper 都是 `if ! "$RESTART_STORM_GATE_BIN" gate <child>; then log …; exit 0; fi`。
缺文件（127）或没有执行位（126）都会落进 held 分支。我实测（带阳性对照）：

```
missing path         -> HELD (wrapper exits 0; service never launches)
present, not +x      -> HELD (wrapper exits 0; service never launches)
real gate (control)  -> LAUNCH
```

fail-closed 的方向本身符合设计。问题在于**这个失败没有告警腿**：其它每条 hold 路径
都会经 `lead-alert.sh` 通知 Lead，唯独"闸门本身不在"只写一行本地日志。而且它不像锁竞争
那样是瞬态的——一次部署漏文件就是永久性全站停摆。

**分类：本 PR 引入 → 已就地修。** Lead 点名这是今晚主线病的反面（什么都没启动，而没有人会知道）。
五个 wrapper 的 gate 守卫从"所有非零一律静默 held"改为区分退出码：**126/127（闸门缺失/丢执行位）
单独分支**，经 `meta-alert.sh`（不依赖 gate 自身）告警 + 响亮 log；**3（真 hold）保持安静**
（在这里告警会复刻 FLY-220 的刷屏）；2（锁竞争）瞬态不告警；4（状态损坏）gate 自己已告警。
**fail-closed 方向未改**——闸门坏了仍然不启动。

新增 `qa-fly1501-brake-missing-alert.test.sh`（55 条，已登记进 CI）：对五个 wrapper 各验四种
情形，且**守卫是从 wrapper 源码里逐字抽出来跑的**，不是照抄一份可能漂移的副本 ——
缺文件/丢执行位 → 不启动且各告警恰一条；真 hold → 不启动且零告警；
**阳性对照**：闸门健康时确实启动（没有这条，前面三条"不启动"可能只是脚本根本没跑到）。
写这个测试时阳性对照当场抓到我自己的 bug：`awk` 范围提取在**内层** `fi` 就截断，
产生不平衡的 shell，于是四种情形全都"不启动"——一个不加对照就会假绿的测试。

**我第一版 M3 修法是错的，Codex R9 抓住了**（记一笔，因为这正是我整晚在查别人的那个病）：
四个 wrapper 跑在 `set -euo pipefail` 下，我却用了裸调用 + `RC=$?` 捕获 —— errexit 会在
gate 调用那一行就杀掉 shell，`RC=$?` 根本到不了。后果不只是告警分支不可达：**真 hold（exit 3）
也会让 wrapper 带着非零码退出，launchd 把它当崩溃**，等于把刹车的 hold 变成了一次"崩溃"。
我等于亲手引入了一个比原缺陷更糟的回归。

**而我的测试当场给了假绿 40/40** —— 因为 harness 生成脚本时漏掉了生产的 `set -e`，
fixture 亲手关掉了被断言的那个条件。修法：捕获改成 errexit 豁免的 `cmd || RC=$?`；
harness 改成**从 wrapper 源码里 `grep '^set -'` 把它自己的 shell 选项抄进来**，不再自己编一套。

**变异验证**（保留抽取锚点、只把捕获改回不安全形式）：bridge 那三条告警断言立刻转红
（missing brake alerts / alert carries reason|title|body / non-executable brake alerts），
恢复后 50/50 全绿。第一次做这个变异我把锚点行也一起删了，红是红了但红的原因不对 ——
重做了一次才是干净的证据。

R9 另有一条 MEDIUM 和一条 LOW：告警调用先改成**分离执行**（`( … & )`），因为 meta-alert.sh
同步跑没有 deadline 的 osascript，卡住会把 wrapper 一直挂着、闸门修好后 launchd 也不再重试
（Python 侧对同一条腿是设了 15 秒 timeout 的，wrapper 直调没有）；stub 从只记 `$1` 改成
记 reason|title|body 三段并断言，锁住真实 meta-alert.sh 的参数合同。

**但"分离执行"这个修法本身又被 R10 判错了，我认**：`( … & )` 仍在 wrapper 的进程组里，
而 launchd 在 job 退出时会杀掉同进程组的残余进程（除非 plist 设 `AbandonProcessGroup`——
这五个都没设）。也就是说后台 notifier 可能在写下 marker 之前就被杀掉，**等于把我要修的
那个静默又还回去了**。改成**有界同步**：meta-alert.sh 的 durable marker 写在桌面腿之前，
所以同步等待能拿到投递，再加一个 watchdog 保证卡死的 osascript 绝不会把启动路径钉住。
测试同步跟进：断言**不再轮询**（轮询会放过一次退回分离执行的回归），并新增五条"卡死的
notifier 被限住"用例（用 `FLYWHEEL_META_ALERT_TIMEOUT_S=2` 覆盖，实测 2-3 秒返回）。

**R10/R11 又把这个修法推翻了两次，最后收敛成一个共享 helper**（这一段留档，因为它本身
就是一条教训：我在生产启动路径上连改三版，每版都被独立评审抓出新的失效面）：

- **R10**：`( … & )` 的"分离"不安全 —— 后台进程仍在 wrapper 的进程组里，launchd 在 job
  退出时会杀掉进程组残余（这五个 plist 都没设 `AbandonProcessGroup`），notifier 可能在写
  marker 前被杀，**等于把我要修的静默还回去了**。
- **R11**：改成内联 watchdog 后又抓出三条 —— 非法 `FLYWHEEL_META_ALERT_TIMEOUT_S` 会让
  `sleep` 失败、watchdog 提前退出而调用方仍卡在 `wait`（等于关掉了这道界）；只杀直接子进程
  会遗留孙进程（meta-alert.sh 的 osascript 正是孙进程）；以及测试里的同步判定仍依赖时序。
- **收敛**：不再在五个启动路径里各维护一份，改成一个可执行 helper
  `scripts/lib/bounded-run.sh`（**不是 source**，避免把 wrapper 耦合到它的 shell 状态与路径），
  wrapper 各只剩一行调用。非法时限在**一处**校验并回落默认 15 秒；用 `set -m` 让子进程独立
  成组，超时按**进程组**收割，孙进程一起走；watchdog 自身也被回收。
  新增 `qa-fly1501-bounded-run.test.sh`（16 条，已登记 CI）：快路径原样透传退出码且不等界、
  卡死命令按界切断并报 124（且断言它**真的启动过**，否则"被限住"可能只是没跑）、
  **孙进程实测被杀**（记录 pid 后 `kill -0` 验证）、五种非法时限都仍然终止、用法错 fail-closed、
  跑完**没有任何残留进程**。

**留给 Annie 的范围选择**（我不替她定）：另一条路是闸门缺失时 **fail-open**（照常启动、只告警），
一次部署漏文件就不会全站停摆，代价是有一个没有刹车的窗口。当前实现按已批设计取 fail-closed。

### M4 — 本单的测试**在 CI 里根本不跑**（我已在本 PR 修掉，留档）

这条是 QA 该抓的"测试存在 ≠ 测试会跑"。发现时 CI 是绿的，但绿得没有意义：

1. **整个 `v2-scheduler` 包被静默跳过**。CI 的 Unit (light) 跑
   `pnpm --filter './packages/*' … test:run`；该 filter **匹配得到** v2-scheduler
   （实测 `exec pwd` 列出它），但这个包是三个 v2 包里**唯一没有 `test:run` 脚本**的
   （v2-engine / v2-kernel 都有，内容与各自 `test` 逐字相同）。pnpm 对 filter 集合里
   缺脚本的包是**静默跳过**而不是报错，所以 34 条测试——heartbeat 守护、DB lease、
   generation 栅栏、内存水位、launchd 映射、system ports，以及我新加的 TS↔Python
   集成测试——**一条都没在 CI 里执行过**，Unit (light) 照样绿。
   前后铁证：
   - 修前 `pnpm --filter flywheel-v2-scheduler run test:run` →
     `None of the selected packages has a "test:run" script`
   - 修后 → `Test Files 9 passed (9) / Tests 34 passed (34)`
2. **三个新增 shell 契约套件没登记进 CI**。script-tests job 是**逐文件枚举**的，且没有任何
   守卫强制新套件登记（`ci-matrix-coverage.test.sh` 只管 pnpm 包矩阵，不管 shell）。
   于是 `restart-storm-gate.test.sh`(15 断言) / `restart-storm-wrapper-wiring.test.sh`(14) /
   `v2-scheduler-install.test.sh`(2) 全部只在有人手动跑时才通过。

合起来的后果，**准确说法**（Codex R7 判我原来那句"整个子系统零覆盖"过度概括，我采纳）：
**本单的 34 条 scheduler 测试 + 3 个 shell 套件共 65 条断言没有在 CI 执行过**，
也就是 brake / heartbeat 的核心行为合同缺持续覆盖。不是字面意义的"零覆盖"——
v2-engine 里的 scheduler failure-domain 测试本来就在 CI 跑（该包有 `test:run`），
已登记的 `packaged-seams.test.sh` 也覆盖到 scheduler 的 interval-plist seam。
即便如此，代码是对的（我逐条验过）但没有东西阻止下一个 PR 静默改坏核心合同——
我这次的验证结论**在修掉之前不具备持续性**。

**已在本 PR 修掉**（属于"让本单自己的测试真的跑起来"，QA 本职）：给 v2-scheduler 补
`test:run`（与其 `test` 及两个兄弟包逐字一致），并在 script-tests job 新增一个步骤把三个
shell 套件登记进去。改完 `ci-structure.test.sh` 与 `ci-matrix-coverage.test.sh` 两个 CI 守卫
仍绿（25/25 包覆盖、零重叠）。

**连带修的一个真 flake**：把 `restart-storm-gate.test.sh` 登记成必过门禁之后，它的锁竞争
fixture 就从"手跑偶尔红"变成"能挡合并"。Codex R7 实证了这个风险：给 lock holder 注入 10 秒
启动延迟，原 fixture 变 **14/15**，恰好挂在 contention 那条——因为它只轮询就绪 marker 约 1 秒
就往下走（不检查 marker 到底有没有出现），持有者又只 `sleep(5)` 固定租期。已改成
显式 readiness 断言 + release marker（与我自己 harness S7 同一套路），并复现验证：
同样注入 10 秒延迟，修后 **15/15**，修前 **14/15**。

**没动的部分**：`supervisor.test.sh` 同样没登记，但它在 main 上就已经是这个状态、不是本单引入的，
按 scope 纪律我没有顺手改；建议单独收。

### 3.5 F1（阻塞，Codex R12）— 打包/安装形态下闸门根本不存在，服务会全部起不来

wrapper 现在**无条件调用** `restart-storm-gate.py`，但：

- `scripts/flywheel-cmux-install.sh` 装的是 wrapper 的软链，**没装 gate、也没装
  `lib/bounded-run.sh`**；经软链跑时 `SELF_DIR` 是 `~/.flywheel/bin` 而不是仓库，
  两个文件都解析不到。Codex 按安装形态实测复现：exit 0、零 meta-alert marker、watcher 拒起。
- 打包载荷的显式清单（`package-onboard.sh` / `package-onboard-files.allow`）**装了 Bridge/Lead
  wrapper，却没装 `restart-storm-gate.py`、`meta-alert.sh`、`lib/bounded-run.sh`**。
  于是打包出来的 Bridge/Lead 会拿到 gate exit 127 → fail-closed → **拒绝启动，且连告警都发不出**。
  既有打包测试是手工把 gate 拷进去的，正好把这个装配闭合缺口盖住了。

**这条不是我引入的**（wrapper 的 gate 调用来自 implement 阶段），但被我的 helper 放大了一个文件。
它比 M3 本身严重：M3 是"闸门坏了没人知道"，F1 是"**正常部署路径上闸门压根不在，服务全部不启动**"。
修法涉及打包清单与 install 脚本的装配决定，属于 implement 的设计范围，我不在 QA 阶段替它定。

**我自己 helper 上还欠两条 MEDIUM（诚实记账，是我写的）**：
1. `bounded-run.sh` 的 TERM→KILL 升级有竞态——直接子进程被 TERM 收掉后，父进程立刻回收
   watchdog，可能把那记延迟 KILL 一起取消，抗 TERM 的孙进程就留了下来；而且因为 `set -m`
   把它们挪进了别的进程组，launchd 同组清理也救不回来。另外用 137/143 反推超时会把
   "命令自己以 137/143 退出"误判成 124，应显式记录超时来源。
2. 时限校验只认"全是数字"，但**过大的整数会被 macOS `sleep` 拒绝**，而 `sleep … && terminate_tree`
   的写法会让终止被跳过 → 又变成无限阻塞。要加上限解析并让计时器失败 fail-closed。

两条都在最佳努力的告警路径上，严重性低于 F1，但确实是我留下的，写在这里交接。

<!-- FLY-1501 QA report sections 3.6 / 3.7 — authored by the QA phase
     (exec 856786d6-5b58-4d3a-8601-ed5c1843c118).

     Insert verbatim into engineering/doc/FLY-1501-alerts-storm-shim/qa-report.md
     immediately BEFORE the line "## 4. 我明确没验 / 范围外".

     Handed over rather than committed because QA does not write into the shared
     worktree during another phase's turn. Related: FLY-1517. -->

### 3.6 verdict 绑错 head —— 共享 worktree 下"读"也会被别人的 HEAD 污染

**这条不是本单的产品缺陷，是流程/工具缺陷，Lead 已另立项。记在这里是因为它直接影响本份 QA 结论的可信边界。**

时间线（我独立核过，不是转述）：

```
06:24:39  ee875232  docs(qa): FLY-1501 QA verdict is FAIL          ← 我实际验的树
06:36:17  10cfbbd4  fix(scheduler): enforce adaptive restart capacity  ← implement 的 M1 接线
06:38:59  claim 69 落库，subject_digest = 10cfbbd4                  ← 绑到了 implement 两分钟前的提交
```

`10cfbbd4` 改的正是 `scheduler-once.ts` 与它的测试——**我全程声明"没碰没验"的那两个文件**。
所以：**本份 FAIL verdict 在库里挂着的那棵树，包含了我从未审查过的 M1 接线。**

机制：`qa-result` 的 `subject_digest` 是**提交那一刻现取 `git rev-parse HEAD`**，
**不认调用方声明的 head**。我和 implement 共用一个 worktree，它 06:36 提交，我 06:38 提交，
CLI 取到的是它的 head。

**为什么我做对了每一步仍然中招**：我查了 TURN（not-yours，全程没 push）、核了本地与远端 head
逐字一致、还主动把"commit 的树 ≠ 当前工作区"拆开报给 Lead。但——

> **TURN 保护的是"写"；为绑定而读 HEAD，同样是一次工作区依赖的操作。**
> **别人持带时，你读到的是别人的 head。守住了写，守不住读。**

这次是 FAIL，后果有限。**倒过来看才是真正的洞：同一条路径会把一个 PASS 挂到 QA 从没看过的
代码上。** 这正是本单（以及今晚全场）在防的那个形状，而它在我们眼皮底下真实发生了一次。

**处置（Lead 裁定）**：不重提交、不碰 claim、不试图修正绑定——重提会造重复记录，而
`idempotentReplay=true` 已证明落库恰一次。复验转 PASS 那一轮，由 Lead 先解决绑定对齐再让我提交。

### 3.7 过期 marker：回执写错对象（保留为证据，勿删）

`~/.flywheel/state/qa-result-failed/qa-engine.json`（13:20:16Z）是成功那次第 1 尝试留下的：
服务端返回 **HTTP 200 但 acknowledgement body 畸形**，CLI 落 marker 后重试，第 2 次才拿到
正常 ack 且 `idempotentReplay=true`——即**第 1 次其实已经落库，只是回执读不出来**。

**这个 marker 的 `execution_id` 字段是 `qa-engine`，不是我的 exec id——回执写错了对象。**
按 Lead 指示**保留不动**，它是"回执写错对象"这一族的活证据。

与之同族的还有本次凭据事故：`FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` 写成了不存在的变量名，
**零报错**、静默回退到继承的旧凭据 62，于是两次错误码（`credential_expired` / `credential_revoked`）
**都精确地在描述 62，而我以为它们在描述 74**——一个看起来完全合理的失败信息，指的是另一个对象。

## 4. 我明确没验 / 范围外

- **台账1 的生产病灶没被本单修**：真正在过度触发的是 v1 `machine-watermark.ts`，
  本单只交付 v2 规格。这是 plan §W6 里 Tadashi 拍板的显式降范围
  （"批次4 整删，真卡派发时他单独 env override"），不是实现者私自缩范围。
  也就是说：**48G 机现在仍会被旧噪声线白挂**，直到批次4。
- **scheduler 从未在真 launchd 上跑过**：`launchctl kickstart` 在我的测试里是注入的
  port。真机安装契约由 `scripts/__tests__/v2-scheduler-install.test.sh` 覆盖（2 条 PASS，
  含真 launchd timer 注册 + 触发自证），但"守护真的把一个卡死的 Lead 拉起来了"
  这件事需要批次3 接线后在真生产验。
- **分支带着 FLY-1499 的产物**（v2-engine 全包 + kernel 迁移 0005/0006）。
  mapping §7 记录了这是有意集成。若 1499 的 PR #718 先合，需要机械 rebase。
  GitHub 当前报 MERGEABLE / CLEAN。

## 5. 门禁实证

| 门 | 结果 |
|---|---|
| `pnpm -r build` | PASS（exit 0） |
| 源码 lint（`biome check packages scripts`，2383 文件） | PASS，15 条既有 warning，**零 error** |
| `pnpm lint`（全仓） | 报 645 error，但**全部落在 `.pnpm-store/`(18 文件) 与 `.flywheel/runs/`(2 文件)** 这类本地运行产物上；源码零命中。这是本机 worktree 环境噪声，不是 PR 回归 |
| v2-kernel | 112/112 PASS |
| v2-engine | 62/62 PASS |
| v2-scheduler | 34/34 PASS（原 29 + 本次新增 5） |
| teamlead 受影响 7 个文件 | 278/278 PASS |
| shell 契约（gate / wrapper-wiring / scheduler-install / supervisor / packaged-seams） | 54/54 PASS |
| 独立 QA harness（刹车 E2E / CLI footgun / 缺闸门告警 / bounded-run） | 47/47 + 26/26 + 55/55 + 16/16 PASS |
| QA 自身代码的 Codex code review（xhigh） | 12 轮、~25 findings（见 §2.6 与 §3.5） |

### 顺手修掉的真 flake

`v2-engine/src/__tests__/api-surface.test.ts` 的 "allows only the package root"
同步 fork 5 个 node 子进程，却用 vitest 默认 5s 预算。我三连跑复现了 1/3 失败
（冷缓存 5104ms 超时），修复后同一条用例实测 5930ms 通过。这在 CI 上是会真红的。
同因的还有我新增的集成用例（每 tick fork 数个 python），已给整个 describe 一个
显式预算。

## 6. 与老 scope 的对照（供 Tadashi 核）

任务书里点名的这些，本分支**没有实现**，因为已被终稿作废：聚合告警四道闸、
subject/recipient 分离 + 三 tier 计数、父抑制子（claim predicate / notification debt /
parent-clear 原子清债）、restart spool → obligation 投影。
终稿给出的替代覆盖在 mapping §6.2：heartbeat 停 + 有 pending 由 scheduler 修，
retry/dead/毒消息归 FLY-1499，非 launchd runner 冷启动归 FLY-1510，
"heartbeat 新鲜但 backlog 变老"是 founder 明确接受的噪音取舍，不再发卡。
