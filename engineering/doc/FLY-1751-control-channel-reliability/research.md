# FLY-1751 控制指令不可靠修复 — 调研

Issue: FLY-1751 (https://linear.app/geoforge3d/issue/FLY-1751/控制指令不可靠founder停手指令无优先通道最坏延迟-8-小时9-条因租约超时判死-换代对账只是其中一腿)
日期: 2026-08-13
基于: exploration.md

本文是对两刀落点的逐行代码审计。全部结论以本 worktree(branch `flywheel-FLY-1751`,base = main `97dec19bd`)实读为准。

## 1. 攒批参数(Fix 1)审计

### 1.1 单一真相源

`packages/teamlead/src/bridge/mailbox-queue-config.ts:13-21`:

```ts
export const DEFAULT_MAILBOX_QUEUE_CONFIG: Readonly<MailboxQueueConfig> = {
	enabled: true,
	ackLeaseMs: 1_800_000,
	batchWindowMs: 60_000,   // ← 60s → 30_000
	batchMaxSize: 5,         // ← 5 → 10
	inflightMaxBatches: 3,
	leaseRetryMax: 3,
	deadLetterWindowMs: 1_800_000,
};
```

`resolveMailboxQueueConfig()`(同文件 :49)每个 lane tick 解析一次,env knob `FLYWHEEL_MAILBOX_BATCH_WINDOW_MS`(clamp 0..3_600_000)/ `FLYWHEEL_MAILBOX_BATCH_MAX`(clamp 1..50)可覆盖默认。**生产 `~/.flywheel/.env` 与 launchd plist 均无这两个 override(已实查)** —— 改默认值即改生产行为,不会被 env 遮蔽。10 与 30_000 都在 clamp 域内。

### 1.2 消费点(两条 lane 共用)

| 位置 | 用途 |
|---|---|
| `packages/teamlead/src/bridge/lead-inbox-runtime.ts:198,229,253` | 把 `resolveMailboxQueueConfig` 接线给 Lead lane 与 runner lane —— **生产唯一取值路径** |
| `packages/teamlead/src/bridge/lead-inbox-loop.ts:207-215` | `opts.queueConfig` 缺席时的 inline fallback 字面量(`enabled:false`,60_000/5/3)。fallback 只在测试装配缺 queueConfig 时生效,且 `enabled:false` 走 legacy `claimLeadBatch` 路径,batch 字面量实际不被消费 —— 但留着陈旧副本会误导读者 |
| `packages/teamlead/src/bridge/runner-mailbox-lane.ts:211-219` | 同形 fallback 字面量,同判定 |

**注意:默认值同时作用于 Lead lane 与 runner lane**(两 lane 共用 `resolveMailboxQueueConfig`)。founder 裁决说的是「for each batch」,未区分 lane;runner 唤醒攒批同样受益,无已知反向风险(runner 侧 `claimRunnerBatch` 对 `response` 类固定单条上限,`mailbox-queue.ts:1204-1206` 的 `effectiveLimit` 逻辑不受本改动影响)。

### 1.3 攒批语义实读(重要:与 founder 表述的差异)

`packages/flywheel-comm/src/mailbox-queue.ts:958-1173` `claimQueueBatch()`:

1. 若已有 frozen 在途批(LEASED 未送达)→ 优先重投旧批,**不开新箱**。
2. Lead 侧:`COUNT(DISTINCT batch_id)` 在途批 ≥ `inflightMaxBatches`(3)→ 本 tick 不开新箱(8-13 死锁正是卡死在这一步)。
3. 取 head = 最老的合格 QUEUED 消息;`windowEnd = head.created_at + batchWindowMs`;同 `from_agent`、同 `msg_class`、同 retry 代、`created_at ∈ [head, windowEnd]` 的消息并进一箱,数量上限 `batchMaxSize`,字节上限 `maxBatchBytes`,Discord partition key 处再切一刀。

**语义定性:`batchWindowMs` 是并箱横界(coalescing horizon),不是 hold-back 延迟。** claim 在 lane tick 时立即发生,不存在「憋满 60 秒才封箱」的等待;窗口只决定 head 之后多长时间内出生的同源消息可以搭同一箱。founder 心智模型「攒够 N 条或等满 T 秒,先到先封箱」在此实现里对应:**箱容量 = batchMaxSize,箱的时间跨度上限 = batchWindowMs**。因此参数改动的真实效果是:

- `batchMaxSize 5→10`:积压排空速度直接翻倍(在途批上限 3 不变,每箱装载翻倍)。8 小时排队证据的主放大器就是「箱太小 × 在途位有限」。
- `batchWindowMs 60s→30s`:一箱最多只并 head 后 30s 内的消息,旧 head 不再把整分钟的后续消息拖进同一箱、批与批的内容时间跨度减半。

改这两个默认值即完整实现 founder 的意图,**无需改 tick 调度**;但设计文档必须如实陈述此语义(不得宣称「现在每 30 秒才发一次批」)。

### 1.4 受影响的既有测试

- `packages/teamlead/src/bridge/__tests__/mailbox-queue-config.test.ts` —— 断言默认值(5/60_000),需随改。
- `packages/teamlead/src/bridge/__tests__/protocol-ingress.test.ts`、`packages/flywheel-comm/src/__tests__/mailbox-queue-capabilities.test.ts`、`discord-chat-ingest.test.ts`、`packages/config/src/__tests__/mailbox-queue-flag.test.ts` —— 出现 batch 参数字样,需逐个核对是显式传参(不受影响)还是断言默认(需随改)。实现节点以「改完默认值 → 全量跑受影响包测试 → 逐个失败点判定」收口,不允许为凑绿把显式传参测试改弱。

## 2. `/clear` 换代腿(Fix 2)审计

### 2.1 FLY-1708 现有机制

- CLI:`packages/flywheel-comm/src/commands/adopt-inflight.ts` —— `adopt-inflight --recipient <id> --kind lead|runner [--db|--project]`。DB 打不开/异常一律 stderr WARNING + **exit 0(fail-open)**。
- 核心:`packages/flywheel-comm/src/mailbox-queue.ts:298` `adoptInflightForRecipientOnConnection()` —— 单事务 `UPDATE mailbox SET state='QUEUED', lease_retry_count = lease_retry_count + 1, claimed_by/claim_expires_at/batch_id/delivered_at/next_retry_at = NULL, last_error='recipient_reborn' WHERE recipient_kind=? AND to_agent=? AND carrier='inbox' AND state='LEASED' AND batch_id IS NOT NULL`。
- **幂等性**:无在途批 → 0 行变更、零副作用。可任意次重跑。
- **重试预算语义**:每次 adoption 对被接管消息 `lease_retry_count + 1`;`reconcileExpiredLeases`(`lead-inbox-loop.ts:235`)按 `leaseRetryMax=3` 判死(`lease_expired_unacked`)。**FLY-1708 已选定此语义,本单不改**:正常节奏(换代→重投→ack)每条消息只消耗 1 次;只有病态的连续快速 `/clear`(同一批消息 4 次换代都没被 ack)才会推进 DEAD —— 这恰好是「认领后真失败仍按原语义重试/判死」阴性对照要保住的行为。
- 现有触发点:`packages/teamlead/scripts/claude-lead.sh:2878` `_adopt_inflight_before_launch()`,唯一调用位于 `:2983` —— v2 body 真 fork(`_launch_claude`)前一行;dry-run 与 HOLD 路径不触发(`scripts/__tests__/test-claude-lead-adopt-inflight.test.sh` 以「恰一处调用 + 紧贴 v2 fork + dry-run 不带」pin 死)。

### 2.2 盲区确认

`/clear` 在 Claude Code 里只重置对话,claude 进程与 `claude-lead.sh` body 都不退出 → launcher 不重跑 → adoption 不触发。8-13 事故(3 LEASED 占死 3 在途位)与 8-11 事故(舰队重启,77 条积压——该腿 1708 已覆盖)签名一致、触发腿不同。**结论:不是缺机制,是已建机制漏了一条触发腿。**

### 2.3 SessionStart hook 可行性

Claude Code `SessionStart` hook 在每次会话诞生时触发,`source ∈ {startup, resume, clear, compact}`;`/clear` 对应 `source=clear`。hook 进程继承 claude 进程 env,而 claude 由 body shell 直接 fork(`claude-lead.sh:1489` `_launch_claude` 前台 `wait`,FLY-1663 v2 载体)→ **env 继承链成立**,hook 内可见:

| 变量 | 出处 | 用途 |
|---|---|---|
| `LEAD_ID` | `claude-lead.sh:180` `export LEAD_ID=` | **判别锚 + recipient 值**(与 launcher 调用同源) |
| `FLYWHEEL_LEAD_ID` | `claude-lead.sh:1227` | 佐证(与 LEAD_ID 同值) |
| `FLYWHEEL_COMM_DB` | `claude-lead.sh:534`(`~/.flywheel/comm/${PROJECT_NAME}/comm.db`) | `resolveDbPath` 的 env 路径(`packages/flywheel-comm/src/resolve-db-path.ts`:优先级 --db > env > --project)。QA slot 换 HOME/env 自动跟走,与 launcher 调用天然同库 |
| `FLYWHEEL_COMM_CLI` | `claude-lead.sh:539` | node 入口路径 |

### 2.4 判别锚:为什么必须是裸 `LEAD_ID`,不能是 `FLYWHEEL_LEAD_ID`

hook 装在**全机共享**的 `~/.claude/settings.json`(`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`),对所有 Claude 会话触发。各类会话的 env 实况:

| 会话 | `LEAD_ID` | `FLYWHEEL_LEAD_ID` | 期望行为 |
|---|---|---|---|
| Lead 本体(工程/companion/external) | ✅ 本 Lead | ✅ 同值 | **触发 adoption** |
| Claude runner pane | **显式清空**(`packages/claude-runner/src/TmuxAdapter.ts:575` `-e "LEAD_ID="`,FLY-1726) | ✅ **= 所属 Lead**(`TmuxAdapter.ts:584`,runner 审批 gate 依赖它) | **必须 no-op** —— 若误触发,runner 每次开工都会把所属 Lead 的在途批抢回 QUEUED(`recipient_reborn` + retry+1),Lead 正在处理的批被凭空撤走,等于制造新事故 |
| founder 终端 / 普通 claude | ∅ | ∅ | no-op |
| Lead 私有 tmux server 上的旁路 shell 手起 claude | 继承 server-global env,可能非空 | 可能非空 | 视同 operator 坐进 Lead 席位调试 —— adoption 语义上属于该 Lead 席位,接受(边界记录,不另设防) |

先例警示:PostCompact hook(`post-compact-bootstrap.sh`)判别用的是 `FLYWHEEL_LEAD_ID` —— 对 bootstrap 语义无大碍,**对 adoption 是事故级错误**。判别必须:`[ -n "$LEAD_ID" ] && [ "$LEAD_ID" = "${FLYWHEEL_LEAD_ID:-}" ]`(第二个等式是廉价的嵌合 env 守卫)。

Codex/Antigravity/Kimi runner 跑各自 CLI、不加载 Claude Code hooks,天然不在半径内。

### 2.5 触发源(matcher)取舍

| source | 判定 |
|---|---|
| `clear` | **本单要害**,必须覆盖 |
| `startup` / `resume` | 进程重启腿,launcher 已在 fork 前 adoption。hook 会在几秒后再扫一次:届时行要么已被 launcher 翻回 QUEUED(0 行,无害),要么已被新现场重新 LEASED(此时 adoption 把它再翻回 QUEUED 重投,at-least-once,`[lead-instruction <id>]` 幂等纪律兜住)。**保留**:双保险,且 matcher 少一条分支 |
| `compact` | **排除**。compact 不换代——对话延续、现场没死;正在被模型处理、即将 ack 的 LEASED 批若被强行翻回 QUEUED,会造成撤箱/重投噪声。FLY-1708 的机制语义是「recipient reborn」,compact 不是 reborn |

matcher 写法:`"startup|resume|clear"`(hook matcher 为正则)。

### 2.6 安装模式先例

`claude-lead.sh` 已有三个 hook 安装函数,全走同一模式:源脚本 → copy 到稳定路径 `~/.flywheel/bin/`(避免 worktree 路径重复条目)→ jq 合并进 settings.json(按文件名后缀剔旧条目 → 按稳定路径去重添加 → 两道 `jq empty` 校验,坏 JSON/合并失败一律 skip 不写):

- `install_post_compact_hook`(:996,源 `packages/teamlead/scripts/post-compact-bootstrap.sh`)—— 调用于 :1195,companion/external 跳过安装
- `install_discord_reply_enforcer_hook`(:1062,源 `scripts/hooks/discord-reply-enforcer.py`)—— **每个角色都装**(:1206)
- `install_restart_guard_hook`(:1142,复用 `scripts/hooks/install-restart-guard.sh`)—— 每个角色都装(:1215)

新 hook 归属判定:launcher 的 `_adopt_inflight_before_launch` 对所有角色无条件跑(companion/external 同为 mailbox 收件人)→ 新 installer 按 Stop/PreToolUse 先例**每个角色都装**;external Lead pane 若无 `FLYWHEEL_COMM_CLI`,hook 自然 fail-open no-op。

### 2.7 SessionStart hook 输出纪律

SessionStart hook 的 stdout 会注入新会话 context。设计利用之:adoption > 0 时输出一行提示(如 `[adopt-inflight] N 个上一现场的在途批已翻回队列,稍后将重投本会话`),让新身体知道有旧账将至;0 行时保持静默(不污染 context)。stderr 仅用于诊断,全路径 exit 0(**绝不阻塞会话诞生**)。

## 3. 部署生效路径

| 改动 | 生效条件 |
|---|---|
| Fix 1(teamlead dist 默认值) | Bridge 重启加载新 build(常规 restart-services 批次车) |
| Fix 2(claude-lead.sh + hook 脚本) | 各 Lead body 下次出生时 installer 跑一次(全舰重启批次车覆盖);装好后 hook 对**运行中会话的下一次 /clear** 即生效 |

两者都搭常规部署批次车,无特殊时序;`~/.claude/settings.json` 为共享文件,任一 Lead 先装好即全机生效(去重保证不重复)。

## 4. 结论

两刀均为最小改动、有现成先例、落点唯一:

1. Fix 1 = 改 `DEFAULT_MAILBOX_QUEUE_CONFIG` 两个数字 + 两处 fallback 字面量收敛引用 + 随改断言默认值的测试。
2. Fix 2 = 新增一个 hook 脚本 + 一个 installer 函数 + 一处调用 + shell harness 测试。

## 5. R1 设计评审更正(以 plan.md 为准)

Codex design review R1 推翻/收紧了本文 §2.4-§2.6 的三个初版判断,新增事实全部亲核为真,**实现以 plan.md 修订版为唯一权威**:

1. **安装落点改为 per-Lead `${LEAD_WORKSPACE}/.claude/settings.local.json`**(非全机 `~/.claude/settings.json`):Lead child cwd = `LEAD_WORKSPACE`(`cd "$LEAD_WORKSPACE"`),该文件已有成熟 writer + mkdir 自旋锁(claude-lead.sh:2046-2107,MCP pre-seed);安装半径本身成为主身份边界。
2. **新增强身份锚 `agent_type`**:Lead 以 `claude --agent "$LEAD_ID"` 启动(:2110-2113);claude-code 源码 `hooks.ts:3876-3882` 确认 SessionStart stdin 携带 `source` 与 `agent_type`,matcher 按 source 匹配(:3887)。
3. **matcher 收窄为 `clear`-only**:§2.5 初版保留 startup/resume 的「双保险」判断作废 —— launcher requeue 后 Bridge 可能在 hook 前重新 claim/deliver,hook 二次 adoption 会撤走新现场刚收到的批并多烧一个 retry generation,是可完全避免的竞态。
4. **companion/external 实际不可覆盖**:§2.6 初版「每个角色都装,external 自然 no-op」作废 —— claude-lead.sh:1652-1665 对 companion/external 把 `FLYWHEEL_COMM_CLI`/`FLYWHEEL_COMM_DB` **显式清空**(FLY-231 Codex R2 HIGH-5 安全裁决),hook 必然 no-op;plan §2.5 改为显式 scope 排除 + 跳过安装 + log。
5. **超时**:hook 条目原生 `"timeout": 10`(秒)字段,不用 shell `timeout`(macOS 无 GNU timeout,「裸跑」违反不阻塞契约)。
6. **`adopted: N` 单位是 mailbox 消息行**(UPDATE changes),不是批 —— 提示文案计量词随之。
