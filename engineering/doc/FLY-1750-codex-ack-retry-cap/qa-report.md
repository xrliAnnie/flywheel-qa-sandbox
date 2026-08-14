# FLY-1750 unavailable 类投递有界化 + Codex ack 腿 — QA 报告

Issue: FLY-1750 (https://linear.app/geoforge3d/issue/FLY-1750/bug-codex-lead-ack-batch-生产路径未打通fly-1573-未验腿-租约重投-131-次不进-dead-无-cap)
日期: 2026-08-14
基于: plan.md（§5 验收）

**结论:PASS**（两条硬门均满足；一条门的字面判据与生产实际不符，已按实质等价方式验证并在下方「诚实边界」逐条声明）

被测 head:`032ed84a406d53ba3171125d76106487d7dc4ebf`（`qa-result` 提交前复核，与开跑时一致，工作区 `git status` 干净）
对照 head（before 基线):`f3a27971e615c74ee5a0f17cfc5117a13ba145ce` = 生产 Bridge 当前 `buildSha`（`/health` 实测），即真正在跑的旧字节。

---

## 1. 一句话

用**真编译产物 + 真 sqlite comm.db + 真死 unix socket + 真 Discord POST** 跑了正/负两组对照：旧字节（生产在跑的 f3a2797）在同一 harness 下 9 次 tick 投 9 次、永不进 DEAD、无任何终态告警 —— 这就是 issue 里 131/48 次重投的本体；新字节到 cap 时**先把 severe 告警真发进 Discord**、告警落地后才整批转 `DEAD/transport_unavailable_exhausted` 并永久停投；告警发不出去时行**保持 LEASED 不静默判死**。Codex `ack_batch` 腿用 mufasa 真实 MCP 二进制在隔离库里跑通了全链（史上第一条 `ack_batch` 行 → 原行 ACKED）。

---

## 2. 硬门一：负对照（plan §5.2）—— **PASS**

独立 harness：`scripts`(scratchpad) `qa-fly-1750-b2.mjs`，同一份脚本分别喂**分支 dist** 与**生产 dist**。
真实性来源：`CodexLeadDeliveryAdapter` 指向一个**真不存在的 unix socket**，报错是真 `connect ENOENT .../lead-inbox.sock`（与生产 mufasa 三条卡死行的 `last_error` 逐字同形），不是 mock throw。

> 隔离陷阱记录：首跑 sandbox 落在会话 `TMPDIR`（超长路径），macOS `sun_path` 104 字节上限把「socket 不存在」变成了 `EINVAL`，测的就不是该测的错误形态。改锚到短路径 `/tmp` 后才是真 ENOENT。

| 判据 | after（分支 032ed84a） | before（生产 f3a2797） |
| -- | -- | -- |
| env `FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX=3` 进 config | ✅ 3 | ❌ `undefined`（无此 knob） |
| 真 ENOENT socket 失败 | ✅ | ✅ |
| attempt 1..2 保持 LEASED + 有 next_retry_at | ✅ | ✅ |
| 到 cap 触发终态告警恰一次（整批 2 行） | ✅ attempt=3, n=2 | ❌ 0 次 |
| **顺序**：告警发生时行仍 LEASED（未先判死） | ✅ `["LEASED","LEASED"]` | — |
| 到 cap → `DEAD` / `transport_unavailable_exhausted` / `next_retry_at=NULL` | ✅ | ❌ 仍 `LEASED`，retry 继续涨 |
| 再跑 6 tick 行**逐字节不变** | ✅ | ❌ 变 |
| adapter 投递次数定格在 cap | ✅ `attempts=3` | ❌ `attempts=9`（无上限） |
| 告警 sink 挂掉 → 行保持 LEASED、无 dead_reason（跨多 tick） | ✅ | n/a（无该分支） |
| 告警恢复 → 收敛 DEAD | ✅ | ❌ 永不 DEAD |
| queue ON 同样 cap + 死信闸 `listUncoveredLeadDeadLetters` 收录 | ✅ | ❌ 不 DEAD、死信闸看不到 |
| 字节兼容：普通（非 unavailable）失败仍 5 次 → `delivery_attempts_exhausted` | ✅ | ✅ |

计数：**after 17/17 通过；before 7/17 通过**。before 里通过的 7 条包含「普通失败仍 5 次判死」这条 —— 它两边都绿，证明这把尺子不是「对旧代码一律报红」，而是精确指到被改的那条腿。

### 2.1 默认 55 次 ≈ 8.01h 的换算（独立复核）

`nextRetryAt` = `min(600000ms, 5000ms × 2^n)`。第 55 次 attempt 前累计 delay = n=0..53 之和 = (5+10+20+40+80+160+320)s + 47×600s = 635 + 28200 = **28,835 s = 8.0097 h**。与实现方确定性测试钉的 `28_835_000 ms` 一致，也与 plan 的「≈8.0h」一致（不是「48×10min」那种近似）。

### 2.2 knob 边界（独立复核，每例独立进程避开 warn-once 去重）

`0` / `100001` / `abc` / `-5` 全部回落默认 55 且各自 warn 一次；同进程内重复调用不再 warn（warn-once 生效）；`1` 与 `100000` 原值通过。

---

## 3. 硬门一的 Discord 腿（真机、隔离房）—— **PASS 6/6**

harness `qa-fly-1750-discord-leg.mjs`：真 loop 到 cap → **plugin.ts `exhausted` sink 逐字转录体** → 真 `LeadAlertNotifier` → 真 Discord REST POST → 隔离 `#test-flywheel-alerts`（FLY-529 房，channel `1519421055805165842`）→ **再用 Discord REST 回读频道**在终点取证。

- 告警真到达：messageId `1537685852598177873`，作者 `flywheel-test-1`，正文含「🚨 **Codex Lead mailbox transport retries exhausted** (… / delivery_dead_letter)」。
- 顺序正确：告警发出时两行仍 LEASED，之后才 `DEAD/transport_unavailable_exhausted`。
- 隔离：`~/.flywheel/alert-queue` 与 `~/.flywheel/alert-deadletter` 前后文件集合逐字未变；生产频道零触碰；slot-local queue/deadletter/claims。

**过程中撞到的真事故形态（保留为证据）**：首跑继承了 ambient `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`，该 bot 对隔离频道无权限 → Discord 403 Missing Access → 告警 dead-letter → **两行如约保持 LEASED、未静默判死**。这是一次非计划的、用**真投递失败**触发的 fail-close 验证，比打桩更硬。scrub 掉该 env 后 6/6 全绿。

---

## 4. 硬门二：正对照（plan §5.1 / §2.1）—— **PASS（实质等价，判据已更正）**

### 4.1 先说结论性的事实更正

plan §2.1 的字面判据是「行 LEASED 且 `delivered_at` 非空 + 出现 `type='ack_batch'` protocol 行」。**这两个物件在当前生产配置下不可能出现**：

- 生产 Bridge 进程 env 实测 `FLYWHEEL_MAILBOX_QUEUE=0`（`ps eww 81583` 直读）。
- 代码事实（`lead-inbox-loop.ts:495-513`）：`queueConfig.enabled` 为真才走 `recordLeadBatchDelivered`（这是**唯一**写 `delivered_at` 的位点）并等 agent ACK；为假时拿到 transport receipt 就直接 `ackBatch`，**`ack_batch` 根本不在路径上**。

所以「生产史上 `ack_batch` 行数 = 0」不是腿坏了，是 flag 关着时它本就不该有。这是 plan 判据与生产实际的错配，不是实现缺陷。按「改验收判据必须拿真数据跑一次」的规矩，我把门拆成两半分别取证：

### 4.2 生产腿（真机，只读观测）

Lead 按跨部门规矩代发了一条真实测试消息（我不直写他部生产库）。growth `comm.db` 实测：

| 行 | state | retry_count | created_at | acked_at | last_error |
| -- | -- | -- | -- | -- | -- |
| `4974bbee-…`（本次测试） | ACKED | **0** | 04:47:02.925Z | **04:47:14.374Z（11.4 s）** | 无 |
| `swap-broadcast:2026-08-13 21:12:04` | ACKED | 16 | — | 23:39:34Z | — |
| `swap-broadcast:2026-08-13 09:15:52` | ACKED | **48** | — | 16:32:11Z | `connect ENOENT …/mufasa-lead/lead-inbox.sock` |
| `swap-broadcast:2026-08-12 19:05:05` | ACKED | **131** | — | 16:32:11Z | 同上 |

即：mufasa 的 Codex 投递腿**现在是通的**（socket 于 08-13 16:37 重新出现，PID 92133 在监听 —— `lsof -U` 实测），一次投递 11.4 秒签收、零重试、零错误；而 issue 里 131/48 那两行的 `last_error` 正是同一个 ENOENT socket —— 与我负对照里人工制造的失败形态**逐字同形**。这直接坐实了「重投风暴打在 Codex 腿上」的归因，也坐实了修复针对的是真实故障。

### 4.3 ack 腿（隔离环境跑通全链）

harness `qa-fly-1750-ack-leg.mjs`，`FLYWHEEL_MAILBOX_QUEUE=1`，隔离 comm.db + 隔离 stateDir + **非真实 Discord sentinel token**（`discord_send` 全程未调用）：

1. queue ON 投递后行为 `LEASED` 且 `delivered_at` 有值（生产 OFF 下拿不到的那半）；
2. 起**真 `lead-actions-main.js`**（mufasa `config.toml` 指向的同一支二进制）走真 stdio JSON-RPC：`tools/list` → `["discord_send","ack_batch"]`；
3. `tools/call ack_batch` 用**批次头里那个 batch id**（Lead 真正看得见的那个）→ 落下真 `type='ack_batch'` / `msg_class='protocol'` / `to_agent='bridge'` 行；
4. 真 `ProtocolIngress.handle` → `batch_ack_applied` → 原 model 行 **ACKED**。

**6/6 通过。**

> harness 自纠一次：第一版用了 adapter 收到的 transport batch id（`<uuid>#r0`），`ackBatchByRecipient` 是精确等值匹配、不剥 `#rN`，于是拿到 `batch_ack_late_noop`。查代码确认 Lead 看到的头（`lead-inbox-loop.ts:435`）用的是**不带 `#rN` 的基础 id**，改成从 `modelPayload` 头里按模型的读法解析后即通。记下这条：**ack 的正确 id 是头里的那个，`#rN` 只在 transport 层**。

---

## 5. 单元/构建门

| 门 | 结果 |
| -- | -- |
| `packages/teamlead` 三个相关测试文件 | 46/46 通过 |
| `packages/flywheel-comm` `mailbox-queue.test.ts` | 20/20 通过 |
| `packages/config` `mailbox-queue-flag.test.ts` | 3/3 通过（六→七 knob） |
| `pnpm lint`（全仓 2432 文件） | 0 error / 7 既有 warning |
| `pnpm -r build`（全 workspace） | 通过 |

未跑全仓 `pnpm test:packages:run`：生产 Bridge 与 15 个 Lead 都在这台机器上，全量 vitest 会把 load 顶穿并压死 Bridge（既有教训）。改为跑受影响面 + 全仓 lint/build，全仓结论以 CI 为准 —— 这条如实记在下面的边界里。

## 6. 代码侧独立核对（非测试，读码结论）

- `transport_unavailable_exhausted` **不在** `QUARANTINE_DEAD_REASONS`（`mailbox-queue.ts:79-82` 实读）→ quarantine 恢复通道不会复活它，与 plan §1.3 反断言一致。
- 全仓 `dead_reason` 的等值读者只有一处（`mailbox-queue.ts:725` 的测试辅助谓词），没有把 `dead_reason` 当封闭枚举 switch 的读者 → 新 reason 不会击穿旧解析。
- `delivery_dead_letter` 是既有已注册 eventType（`LeadAlertNotifier.ts:310` 白名单、`kind-contract.ts:102` owner=founder_direct、`ticket-owner-map.ts:77`），不是新造的路由。
- Discord 路线的 `quarantineDiscord` 同样是**先 await 告警、告警抛错就退避保 LEASED**，与 Codex 路线同一套可见性合同（`lead-inbox-loop.ts:636-706` 实读）。

---

## 7. 诚实边界（未测/未覆盖，按风险排序）

1. **默认 55 次没跑真时长。** 8.01 h 是按 backoff 序列算出来 + 实现方确定性测试钉的；负对照用的是 cap=2/3 + 压缩 backoff。真跑 8 小时不在本轮预算内。风险：低（换算已双人独立复核）。
2. **plugin.ts 的 `exhausted` sink 是逐字转录进 harness 的，不是 import 的**（plugin.ts 不能独立加载）。loop → runtime → plugin sink 的接线由实现方 `lead-inbox-runtime.test.ts` 覆盖 + 我读码确认，但「生产 Bridge 进程里这条线真的接上了」只有部署后才能观测。风险：中低。建议部署后做一次真实观察（见 §8）。
3. **全仓 `pnpm test:packages:run` 未在本机跑**（理由见 §5）。以 PR CI 为最终无沙箱证据。
4. **plan §5 的三条 post-deploy 遥测（第 3/4/5 项）未做** —— 它们本就不是门，且需要部署后 ~8h 观察窗。
5. **`codex-infra-bot-lead` 未验**：它 08-08 被故意停掉（Codex `auth.json` 缺失），复活/退役是 founder 决策项，plan §2.3 明确不作为验收依赖。它当前 mailbox 无 delivered-未 ack 在途批。
6. **一个分类学观察（非阻塞）**：若一条 `discord_chat` 行的收件 Codex socket 死了（错误 scope 是 `lead`），因为 `discord && unavailableExhausted` 分支优先，终态会走 `onDiscordUndeliverable`（"Discord mailbox delivery stalled/undeliverable" 措辞）而不是新的 Codex 终态告警。行为上仍然**有界、先告警后判死、dead_reason 一致**，只是告警文案归类到 Discord 那一栏。不影响本单的收敛与可见性合同。
7. **本轮是 pre-ship QA，不含生产部署后的行为观测。** 部署后「重投真的停了没」按规矩应由独立观察确认，不由部署者自报。

---

## 8. 部署后建议观察（不是门）

- 生产 Bridge 换代后，确认 `codex_model_transport_exhausted` 这条 severe 在 `#flywheel-alerts` 里能真正出现一次（§7.2 那条线的终点取证）。
- `claude-infra-bot-lead` 的 58 QUEUED / 4 LEASED **不要**靠本单收敛：它是 Claude 腿、`retry_count=0`，属 FLY-1749/1751 的病，本单一条都不治。恢复顺序的硬约束（先有 1751 对账腿再重启）不变。

---

## 9. 证据文件

- `qa-fly-1750-b2-after-branch.json` / `qa-fly-1750-b2-before-origin-main.json`（同一脚本双 head 对照全量断言）
- `qa-fly-1750-discord-leg.json`（含 Discord messageId `1537685852598177873`）
- `qa-fly-1750-ack-leg.json`（含真 `ack_batch` protocol 行原文）

（均在本 session scratchpad；关键数字已逐条抄进本报告，报告可独立阅读。）
