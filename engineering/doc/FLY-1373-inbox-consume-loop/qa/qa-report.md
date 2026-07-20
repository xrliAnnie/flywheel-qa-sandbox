# FLY-1373 消息系统消费循环照抄 — 独立 QA 报告

Issue: FLY-1373 (https://linear.app/geoforge3d/issue/FLY-1373/消息系统-照抄-claude-code-消费循环-lead-收件全链路根治1s轮询销账语义忙时挂起批量投递类型分流)
日期: 2026-07-19
基于: plan.md

**判定: PASS**

被验对象: PR #652, head `5d15abfae6e9d4f7dca2b925df28e0a9370a2487`
QA 节点: `a643fd05`(DAG `qa` 节点)

> head 说明: 本地 HEAD 在 QA 期间因我自己的 progress ledger commit 漂到 `91d81d54d`,
> 但 `git diff 5d15abfae..HEAD -- packages/` 为**空** —— 代码字节与被 review 的 head 完全一致。

---

## 1. 结论摘要

> ### ⚠️ 先读这个:本 PASS 的适用范围(2026-07-19 真机 E2E 后更新)
>
> **初版**只覆盖「消息进入 `lead_inbox` 之后」那一段,传输层是手写 stub。
> **现已补跑 529 房真机 E2E**(真 Bridge、真 Lead、真 kill -9),四个场景全部 PASS:
> 正常投递 / 并发顺序·优先级 / 崩溃后重投 / 忙时挂起恢复。详见
> `e2e-529-room-status.md` 与 `s2`/`s3`/`s4-evidence.txt`。
>
> **收件方向已打通到 Lead 进程为止(第 1-5 层)。**
> **第 6/7 层(Lead → Discord 回帖 → founder 看见)已于 2026-07-19 深夜真机验到**,
> 见 §7.5 与 `s5-evidence.txt`。
>
> ⚠️ **本节此前两版解释都是错的,现按实测更正(第三版):**
> - 初版写「Lead 判为重复噪音所以不回帖」—— 是**推断**,被实验推翻。
> - 二版写「测试 slot Lead 结构上没有 Discord 出站身份」,依据是 `~/.claude/channels/`
>   下 0 个 test/slot 目录 —— **也是错的**。测试 slot 的 Discord 接线根本不在那个路径,
>   而在 `/tmp/flywheel-test-slot-N/discord-state/`(由 `test-deploy.sh` 建、经
>   `DISCORD_STATE_DIR` 传入)。我把「我没在那里看到」当成了「它不存在」。
> - **实测结论**:出站路存在且可用。真机跑通 —— Annie 在 `#ops-lead-test` 发问,
>   Lead-B 27.2 秒后在同频道回帖,Discord API 核出作者 id = `1493075160025272452`
>   (= Lead-B 的 bot app id,非显示名)。
>
> **仍未验的那一段(不要被上面盖过)**:第 6/7 层是由 **Discord 插件直投**驱动的,
> **不是**由 `lead_inbox` 事件驱动的 —— Discord 聊天消息按设计绕开 `lead_inbox`。
> 因此「`lead_inbox` 事件 → Lead → Discord 出站」作为**一条连续链路**没有被完整驱动过。
> 逐层边界见 **§7 覆盖边界**。

六条照抄件 + 六项验收 + 四个真机 E2E 场景,在**上述范围内**独立复验通过。
**该范围内未发现可归因于本 PR 的缺陷。**

我没有复用仓库自带测试作为通过依据 —— 另起三个 harness 直接打「编译产物 + 真 SQLite comm.db + 真子进程 SIGKILL」,
并对每个 harness 做**突变验证**证明它能变红。

> 下表「验收原文」是 issue 的措辞。①② 的原文在真链路语境下本应含 Discord 那一段;
> 我按**队列层**理解判的 PASS,这一层含义见 §7,别只看这张表。

| 验收(issue 原文) | 判定 | 证据 |
|---|---|---|
| ① kill -9 中途 → 重启零丢全重投 | ✅ PASS | 真 SIGKILL 13/13;零丢 + 15.1s 自愈重投 |
| ② 50 条并发 → 按优先级批量一条不沉 | ✅ PASS | harness T1 10/10;单批 50 条、P0 优先、真 FIFO |
| ③ watchdog OFF 无假警报无漏消费 | ⚠️ 代码级 PASS,**24h soak 未做** | 双向 sentinel 两条巷齐全;soak 需生产窗口 |
| ④ founder gate Lead-ack → API 拒 | ✅ PASS | 39/39,含 8 个对抗变体全部被拦 |
| ⑤ 空闲退避真生效 | ✅ PASS | 30s/1s/门铃三态实测 + 突变验证 |
| ⑥ pilot:本单在 DAG 上跑 | ✅ PASS | 三节点 design→implement→qa 均带 workflow_node_id |

---

## 2. 独立 harness(不复用仓库测试)

产物在本目录,可重跑:

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `qa-fly-1373-harness.mjs` | 验收②⑤ + 照抄件⑤ + owner fence | **36 PASS / 0 FAIL** |
| `qa-fly-1373-sigkill.mjs` | 验收① 字面版(真 kill -9) | **13 PASS / 0 FAIL** |
| `qa-fly-1373-gate-ack.mjs` | 验收④ + 对抗探测 | **39 PASS / 0 FAIL** |

### 2.1 突变验证 —— 证明尺子没坏

绿测本身不算证据。三处刻意破坏编译产物,确认 harness 变红后还原:

| 突变 | 预期变红项 | 实际 |
|---|---|---|
| `ORDER BY priority, seq` → `ORDER BY seq` | 优先级断言 | ✅ 变红 `[0,2,0,2,...]` |
| `markConsumed` 挪到 `deliverBatch` **之前** | 零丢「灵魂断言」 | ✅ 8 项连锁变红 |
| `IDLE_LEAD_INBOX_INTERVAL_MS` 30s → 1s | 退避断言 | ✅ 变红 |

还原后回到 36/36 绿,`git status` 干净(dist 已 gitignore)。

---

## 3. 逐项证据

### ① 崩溃零丢(真 SIGKILL)
子进程在「消息已交出、回执未回」的崩溃窗口被 `kill -9`,父进程重开同一 comm.db:
- SIGKILL 后 pending 仍为 12 —— **零销账**
- fencing 生效:死 owner 租约未过期时新 epoch 被拒,期间零投递零销账(防双消费)
- 重启 loop 轮询自愈,**15.1s** 后完整重投 12 条,id 集合逐一致,优先级顺序跨崩溃保持

> ### 🔷 已知特性(NOT a bug):硬崩溃后重投延迟 ~15s
>
> **结论**:Bridge 硬崩溃后,在途批次不是瞬时重投,而是约 **15s** 后才重新交付。
> 这是**设计上买来的**——用一段延迟换「绝不双投」,不是缺陷,**不要当 bug 去查**。
>
> **数值来源(两个闸门,取较大者)**:
>
> | 闸门 | 默认值 | 代码位置 | 作用 |
> |---|---|---|---|
> | owner lease TTL | `10_000ms` | `lead-inbox-loop.ts` `leaseTtlMs` 默认 | 死 owner 的租约到期前,新 epoch 不得接管(防两个 Bridge 同时消费) |
> | row claim TTL | `15_000ms` | `lead-inbox-loop.ts` `claimTtlMs` 默认 | 被死进程 claim 的行到期前不可被重新 claim |
>
> 实际恢复时间 ≈ `max(leaseTtlMs, claimTtlMs)` = **15s**。
> **实测值 15.1s**,由 `qa-fly-1373-sigkill.mjs` §4b 用真实时钟轮询测出(非估算、非时间注入)。
>
> **运维含义**:Bridge 崩溃 → 在途 Lead 消息最多延迟约 15s 送达,期间零丢、自愈、无需人工干预。
> 若将来要缩短,只能调这两个 TTL,而代价是缩小防双投的安全窗口 —— 属行为变更,须单独评估。

### ② 优先级批量
50 条 4 优先级打乱入队 → 单次 tick 一批交付(= 单 turn),批内 priority 升序、同级 seq FIFO。
额外断言「P0 交付顺序 == P0 入队顺序」,避免只验到 seq 单调这种弱条件。全部销账,50 个 id 无重无漏。

### ③ watchdog 反向 flag
- flag 真接线:约 20 处调用点(LeadWatchdog / RunnerIdleWatchdog / HeartbeatService / gate-poller / plugin.ts),非纸面 flag
- 生产默认 OFF **已验证**:四个组件构造点(9594/9388/5533/7008)全部显式传 `legacyDeliveryWatchdogsOn`,
  不依赖组件级 `!== false` 默认值
- **双向 sentinel 两条巷齐全**:
  - `runner-idle-watchdog-quota-scan.test.ts` —— 圈外 `scan` 仍调用 ✓ / 圈内 stuck+idle 不发 ✓
  - `LeadWatchdog.test.ts` —— 冻结巷不报 ✓ / `onPollComplete` 仍跑 4 次 ✓ / blocked(rate_limit) 告警仍发 ✓
- LeadWatchdog 抑制是 **kind 白名单**(只压 `pane_hash_stuck`/`pane_error_stalled`),圈外巷靠结构而非靠测试保住

**未覆盖**: 24h 生产 soak(需真实时间窗口,不可能在单次 QA session 内完成)。这是 ③ 唯一的缺口。

### ④ gate 拒 Lead-ack
- guard 位置符合 plan:在 bridge 路由**和** `FLYWHEEL_COMM_BYPASS_BRIDGE=1` 应急旁路**之前**
- 18 种批准表达全被拦(含 `{"approved":true}` / lgtm / 批准 / 同意上线 / 可以 merge)
- 13 种 Lead 评论 / changes_requested 全放行,**未误伤**
- 8 个对抗变体(`Approved!` / `lgtm!` / `LGTM 👍` / `{ "approved" : true }` 等)全部仍被拦
- 分类器锚定行首,句中提及(`I think this is approved`)判 neutral —— **不是漏洞**:
  `verify-approval` 独立要求 founder 归属(`response_not_founder_attributed`),该 403 是纵深防御第二层

### ⑤ 空闲退避
零 session + 空队列 → 30_000ms;有 live session → 1_000ms;零 session 但 pending>0 → 回 1_000ms;
挂载即首拉;门铃 `nudge()` 立即触发拉取不等 30s。

### ⑥ DAG pilot
`teamlead.db` sessions 表:
```
d06b06b5 | design    | node=design    | completed
4413a5cb | implement | node=implement | completed
a643fd05 | qa        | node=qa        | running
```
三节点均带 `workflow_node_id` —— 本单确实跑在 DAG 引擎上。

---

## 4. 测试套件结果与失败归因

### FLY-1373 自身新增测试
11 个新测试文件隔离重跑: **36/36 全绿**
(lead-inbox-loop / lead-inbox-runtime / lead-delivery-adapter / question-admission / protocol-ingress /
legacy-ack-drain / legacy-lead-event-reconciler / inbox-loop-health-checker / lead-event-queue /
lead-ack-retirement.fly1373 / lead-event-ack-policy.fly1373)

### 本机全量失败的归因(逐个交代,不含糊)

**CI 在 PR head 全绿** —— 9 个 job 含 teamlead 三分片(`--shard=1/3..3/3`,vitest 原生分片无排除 → 并集覆盖全套)。

本机 macOS 全量跑有 24 个失败。我建了 **main 分支对照 worktree** 逐一比对:

| 失败组 | 归因 | 铁证 |
|---|---|---|
| 7 文件 / 16 失败(event-route × 4、complete-marker-reconciler × 2、external-merge-reconcile) | **main 上既存**,非本 PR 引入 | main 对照跑出**逐字相同**签名: 7 files / 16 failed / 153 passed |
| 4 文件 / 1 失败 + 1 error(tmux-lookup.real-tmux 等) | **main 上既存** | main 与 PR 分支同为 1 failed / 11 passed / 1 error |
| `flywheel-comm` commands.test.ts「tmux window not available」 | **环境性**(真 tmux + 本机 68 session + load 28) | 超时提到 60s 后 22/22 绿,该用例实耗 28.8s;capture/tmux 路径本 PR 字节未动 |
| `lead-delivery-adapter.test.ts` EINVAL | **环境性**(TMPDIR 落在 `~/.flywheel` 下,unix socket 路径 134 字节 > macOS 上限 104) | 换短 TMPDIR 后 3/3 绿 |

**结论:零个失败可归因于 FLY-1373。**

---

## 5. 观察项 — Lead 裁定结果

> Tadashi 已逐条拍板(2026-07-19)。此处记录**裁定**,不是待办建议。

1. **崩溃恢复延迟 ~15s** —— **裁定:不修,进文档。** 它是 lease TTL + claim TTL 买来的防双投代价,
   不是缺陷。已在 **§3① 的「🔷 已知特性」块**写明结论、两个闸门的默认值与代码位置、以及实测来源,
   随本 PR 进仓,避免以后有人当 bug 追查。
2. **组件级默认极性与 issue 直令「默认 DISABLE」相反** —— **裁定:单独立单修,不塞进 FLY-1373。**
   理由是改默认极性属行为变更,须走自己的 review;塞进来会让本 PR 的 review 结论失效。
   **明确记账,这不是悄悄降范围**:现状 = `RunnerIdleWatchdog`/`LeadWatchdog` 用 `!== false`、
   `HeartbeatService` 用 `= true`,省略参数时 legacy 巷是 **ON**;生产靠四个构造点显式传值兜住,
   **将来新增构造点漏传 → 静默恢复旧巷**。这正属于本轮在治的「静默失败」类。
3. **本机既存红测 17 项** —— **裁定:单独开单**,不计入本 PR。
4. **24h soak 未做** —— **裁定:不粉饰。** 对 founder 的口径是「六项过、soak 未做」,不写成「全过」。
5. `flywheel-comm stage set` 不接受 `qa`/`code_review_qa`,而 `QA_STAGES` 里有这两个值 ——
   QA 节点无法把 stage 设成自己的相位,导致 `progress --phase qa` 被拒。小口径不一致,本 PR 无关,
   未提交给 Lead 裁定(工具链口径问题,非 FLY-1373 范围)。

---

## 6. 可重跑命令

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-1373
pnpm --filter flywheel-comm --filter flywheel-teamlead build
TMPDIR=/tmp/q13 node engineering/doc/FLY-1373-inbox-consume-loop/qa/qa-fly-1373-harness.mjs
TMPDIR=/tmp/q13 node engineering/doc/FLY-1373-inbox-consume-loop/qa/qa-fly-1373-sigkill.mjs
node engineering/doc/FLY-1373-inbox-consume-loop/qa/qa-fly-1373-gate-ack.mjs
```

> 跑 teamlead 套件必须 `env -u FLYWHEEL_RUNNER_BACKEND` 且 `TMPDIR` 用短路径,
> 否则会踩本机两个已知环境坑(vendor 默认污染 / unix socket 104 字节上限)。

---

## 7. 覆盖边界 — verified / stubbed / 未触达

**这一节存在的理由**:Annie 问「他做的是 e2e discord 的 test 吗」。答案是**没有**。
本节把 PASS 的适用范围钉死,免得下一个人把它读成全链路通过。

### 7.1 逐层交代

以 issue 标题「Lead 收件全链路」为准,链路分七层:

| # | 层 | 状态 | 说明 |
|---|---|---|---|
| 1 | producer:runner `ask`/`gate` → comm.db `messages` | 🟢 **真机 verified** | E2E 场景① 用真 `flywheel-comm ask` + 真 exec-id;②③④ 用真 `POST /events` |
| 2 | admission:→ `lead_inbox` 行 | 🟢 **真机 verified** | 真事件确实物化成行。**带阴性对照**:假 exec-id 跨 2 个 tick ~50s 始终不物化(`question-admission.ts:169` fail-closed),真 exec-id ≤1s 物化 |
| 3 | nudge:CLI/HTTP → `loop.nudge()` | 🟢 **verified(时序反证)** | idle 退避实测 30.00s,而投递在 ≤1s 完成 → 只能是 nudge 把它叫醒。**属间接推断,非直接观测该路由**,但排他性强(30s vs 1s 差两个数量级) |
| 4 | 消费循环:claim → 分流 → 批量 → 销账 | 🟢 **verified** | 88 项断言 + 突变验证 + 真机 85/85 销账 0 pending |
| 5 | transport:adapter → Claude 邮箱 → Lead 进程 | 🟢 **真机 verified** | 真 Lead session 逐条收到。铁证取自 Lead transcript 原始消息(非它的转述):场景③ #43-57、场景④ #76-85 各 1 次 |
| 6 | Lead 渲染 → Discord 回帖 | 🟢 **真机 verified** | 真双-Lead 房。Lead-B 回帖 msg `1528649149329965127`,**Discord API 核出 author.id=`1493075160025272452`**(= Lead-B bot app id,不看显示名)。见 §7.5.2 / `s5-evidence.txt` |
| 7 | founder 真的看见 | 🟢 **真机 verified** | Annie 本人 Discord 账号发问 msg `1528649035353690266` → 27.2s 后在同频道看到回帖(截图 + API 双证) |
| — | **6/7 是被 Discord 插件直投驱动的,不是被 `lead_inbox` 驱动的** | 🟡 **该连续链未驱动** | Discord 聊天消息按设计绕开 `lead_inbox`;要驱动需一个绑在 Lead-B 上的真 runner 产生真 Bridge 事件。严格说不在 1373 合同内,但**没驱动就是没驱动** |

### 7.2 支撑证据(不是自述,是可复核的)

```bash
# 三个 harness 里有没有碰真 HTTP / Discord / socket / tmux —— 全 0(此条现在仍可复核)
grep -icE "fetch|http|discord|axios|socket|spawn.*claude|tmux" \
  engineering/doc/FLY-1373-inbox-consume-loop/qa/qa-fly-1373-*.mjs
# → qa-fly-1373-gate-ack.mjs:0  qa-fly-1373-sigkill.mjs:0  qa-fly-1373-harness.mjs:0
```

所有 `deliverBatch` 实现都是本目录 `.mjs` 里我手写的 stub,可直接读源确认。

> 缺口最初是 Tadashi 用 `grep -icE "discord|529|真机|端到端" qa-report.md` → **0 命中**发现的。
> 那条命令**现在不再返回 0** —— 因为本节把这些词写进来了。留个记录免得误会:
> 归零的是**当时**的报告,不是现在这份。判断覆盖请看 §7.1 的表,别再跑那条 grep。

### 7.3 一句话

**验了**:消息**进得来**、进了 `lead_inbox` 之后不丢、不重、按优先级、崩溃能恢复、
Lead 忙时不掉、而且**真 Lead 进程逐条收到了**。
**没验**:Lead 收到之后**往 Discord 回帖**那一段,以及 founder 侧确认。

### 7.4 真机 E2E 结果(2026-07-19 补跑)

529 房 slot 2,真 Bridge 跑 PR #652 代码,真 Lead `flywheel-test-2`。

| 场景 | 结果 | 决定性证据 |
|---|---|---|
| ① 正常投递 | ✅ PASS | 真/假 exec-id 单变量对照 |
| ② 并发顺序·优先级 | ✅ PASS | **对抗性构造**:先入 10 条 p3、后入 10 条 p1,Lead 实收顺序仍 p1 在前 → FIFO 解释不了 |
| ③ 崩溃后重投 | ✅ PASS | 真 kill -9 命中 claimed-but-unconsumed 窗口;15/15 不丢,重复恰好 1 条(= at-least-once 契约,非缺陷) |
| ④ 忙时挂起恢复 | ✅ PASS | 确认忙态期间投 10 条,队列 10/10、Lead 实收 10/10 |

**崩溃恢复分两层看,别读成只测了一半**:
进程+DB 层由 §3① 真 SIGKILL harness 验(15.1s 自愈,88 断言);
跨 Discord 链路层由本轮场景③ 验。**两层都覆盖。**

全程零丢:`lead_inbox` 85 total / 85 consumed / **0 pending**。
生产零触碰:delivery-secret md5 与开工基线逐字一致(含 2 次 Bridge 击杀)。

### 7.5 layers 6/7 —— 已验到,附两条自我更正

> **⚠️ 本节下方 7.5.1 是历史记录(两个已被推翻的解释),结论看 7.5.2。**

#### 7.5.2 最终实测结果(2026-07-19 23:2x,真机)

**6/7 层 verified。** 搭了真双-Lead 房(收编 idle 的 slot-3 身份作 Lead-B),
Annie 本人的 Discord 账号在 `#ops-lead-test` 发一个真问题,Lead-B 在同频道回帖:

| 项 | 值 |
|---|---|
| 入站 msg | `1528649035353690266` · author `xrliannie_96634` (人类) · `06:25:30.954Z` |
| 出站 msg | `1528649149329965127` · author **`flywheel-test-3` id=`1493075160025272452`** (bot) · `06:25:58.128Z` |
| 往返 | **27.2 秒** |

作者身份是拿 Discord API 核的 **author.id**,不是看显示名 —— UI 上显示的是服务器昵称
「Tadashi-QA」,靠昵称判会判错。

**双 Lead 队列隔离**:两 Lead 同房、同一 project comm.db 期间,
`lead_inbox` 中 `flywheel-test-2` = 94 行、`flywheel-test-3` = **0 行**,无串道。
`loop_owner` 是 per-DB 单例(无 lead 列)—— 读源码确认:`commDbPathForProject` 按
**project** 分库,`for (const lead of project.leads)` **每 Lead 一个 LeadInboxLoop**
共用该 queue,共享 Bridge 进程的单个 `ownerEpoch`。所以单例是**给第二个 Bridge 进程做
fencing 用的,不是给 Lead 之间仲裁用的**;Lead 间隔离靠 claim 的 `to_lead` 谓词。
**按设计如此,不是缺陷。**(这条是查代码得到的,不是从"有个单例表"推断的。)

**这一段没验到的边界(必须一起读)**:上面这条 6/7 是 **Discord 插件直投**驱动的。
Discord 聊天消息按设计**绕开 `lead_inbox`**(Lead-B 启动横幅原话:messages from
`plugin:discord@claude-plugins-official` inject directly in this session)。
`lead_inbox` 走的是 Bridge **事件**(`session_started`/`stage_changed`/`runner_question`/
`gate_question`/`auto_qa_stuck`)。因此:

- 1-5 层(inbox 消费循环)= verified
- 6-7 层(Lead→Discord→founder)= verified
- **「`lead_inbox` 事件 → Lead → Discord 出站」作为一条连续链路 = 未驱动**
  (要驱动它需要一个绑在 Lead-B 上的真 runner 产生真事件;本次没有)

严格说,后者也不在 1373 的合同里 —— 1373 管的是"消息可靠送达并被消费",
送达之后 Lead 决定回不回帖是 Lead 判断,不是循环的职责。但我不替它把这句话说圆:
**没驱动就是没驱动。**

#### 7.5.1 历史:两个被推翻的解释(留档)

Annie 要求合并前补出站验证,Tadashi 派了 N-to-N 出站场景。跑完的结论是**跑不起来**,
但根因和初版报告写的**不一样**,这里如实更正。

**初版(错)**:「合成事件被真 Lead 判为重复噪音后选择静默不回帖,故出站段未被驱动」。
那是我当时的**合理推断**,不是量到的事实。

**二次实验推翻了它。** 按 Tadashi 的要求不灌合成噪音,走真实 `flywheel-comm ask` 路径
给 slot-2 Lead 一个确实需要 founder 拍板的政策冲突问题。它的实际反应(pane 原话):

> 「这条和之前 40 多条模板化重复不同——内容是新的、指向一个真实的政策决策点……
>  我不会自己替 founder 拍板,把这个决定转给你」

**它没判成噪音,也没静默,它试图升级了。** 但它伸手去调的是 `AskUserQuestion`,不是
Discord —— 然后卡在「等 team lead 批准」上(测试 Lead 没有人去批)。

**真根因(三条实测证据)**:

1. ~~`~/.claude/channels/` 下 **20 个** discord 接线目录,**匹配 test 或 slot 的 = 0 个**~~
   ❌ **这条证据本身是错的(2026-07-19 深夜推翻)**:测试 slot 的 Discord 接线不在
   `~/.claude/channels/`,而在 `/tmp/flywheel-test-slot-N/discord-state/`
   (`test-deploy.sh:554/778/815` 建,`:1053` 经 `DISCORD_STATE_DIR` 传入)。
   我在错的目录下找,没找到,就当成"不存在"。
2. slot-2 Lead 整个 session 的 Discord 工具调用 = **0 次**(扫 transcript 的 tool_use)
3. 上述决定性实验:真问题 → 正确识别 → 决定升级 → **只有 AskUserQuestion 一条路可走**

→ ~~**测试 slot Lead 结构上没有 Discord 出站身份。**~~ ❌ **已推翻**,见 7.5.2。
出站路一直存在;证据 2「Discord 工具调用 0 次」是真的,但那反映的是**当时那个 Lead 那一轮
选择了 AskUserQuestion**,不能推出「没有路」。**"我没看到"≠"它不存在"** —— 这是我今晚
在同一层上犯的第三次同类错误。

**这两版错误都不是 1373 的缺陷**,但也不构成 1373 的通过证据 —— 真正的 6/7 证据在 7.5.2。

### 7.6 仍然开着的口

| 项 | 状态 |
|---|---|
| 第 6/7 层(Lead 出站 → Discord → founder) | ✅ **已验**(7.5.2:27.2s 往返,author id 核过) |
| 真 N-to-N(≥2 Lead 同房) | ✅ **已验**(收编 idle slot-3 身份作 Lead-B;队列 94/0 无串道) |
| `lead_inbox` 事件 → Lead → Discord 出站(**一条连续链**) | ❌ **未驱动** —— 需要一个绑在 Lead-B 上的真 runner 产生真 Bridge 事件;本次没有。严格说也不在 1373 合同内(见 7.5.2 末段),但**没驱动就是没驱动** |
| 我自己造成的一条生产脏行 | `messages` 表 `35721e28-94df-41e3-97b2-580a8f9404df`(`runner`→`flywheel-test-3`,内容 "test")。我误以为在探参数,实际执行了写入;指向一个生产不存在的 lead,无人消费=惰性。**未自行删除**(再写一次生产去掩盖第一次更糟),交 Tadashi 定夺 |
