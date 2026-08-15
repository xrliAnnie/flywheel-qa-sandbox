# FLY-1716 Lead context 墙泄压 — 调研

Issue: FLY-1716 (https://linear.app/geoforge3d/issue/FLY-1716/投递撞-context-墙无泄压-lead-会话满-context-时投递永远进不去队列冻死今晚-cass-47-条-25h)
日期: 2026-08-14
基于: exploration.md

本文汇编四条线的机制事实:①Claude Code 内部 auto-compact(binary 逆向)②Lead launcher 链 ③mailbox 投递链 ④告警链,附实证取证方法。所有「文件:行号」均指本仓库当前 HEAD;Claude Code 侧指本机生产二进制 `~/.local/share/claude/versions/2.1.233`。

## 1. 实证取证:Cass 僵尸会话(方法可复用为 B 项检测器)

取证方法:逐行扫 transcript JSONL,取 `type=="assistant"` 且 `message.model != "<synthetic>"` 的行,context 占用 = `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。

`~/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-cos-lead/ed851bfd-….jsonl`(364,574,370 bytes / 169,004 行):

- 首条 2026-06-16;最后一条**真实** assistant usage:`2026-08-06T02:05:33Z`,model=claude-opus-5,占用 **731,028**(in 2 + cache_read 87,982 + cache_create 643,044)= 1M window 的 73%。
- 之后 55,282,787 bytes 追加内容中**零真实回复**;281 条 `<synthetic>` assistant 行(全零 usage,即撞墙后 Claude Code 本地合成的错误占位)。
- 8-12 实录:`<local-command-stderr>Compaction failed · conversation could not be reduced below the context limit</local-command-stderr>`。
- 当前(8-14 15:28 重启后)Cass 进程 argv:`--resume ed851bfd-… --model claude-opus-5[1m]`;session-id 文件 mtime = Jun 16。workspace 另有 8-11/8-12/8-13 的新 jsonl(4–12MB,手工 /clear 后的活会话),证明 /clear 接力发生过多次但从不被 session-id 文件记录。

**尾读优化**:synthetic 行可能连续堆积数十 MB(Cass 尾部 30MB 无一条真实 usage),检测器不能只 tail 固定字节;需从文件尾向前分块扫直到命中真实 usage 行,或接受全扫(364MB 全扫实测约 20s,launcher 场景可接受但要设上限)。

## 2. Claude Code 2.1.233 内部 auto-compact 机制(binary 逆向)

### 2.1 变量仍被识别,语义 = 降低触发阈值

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 在 2.1.233 出现 7 处(env 注册表 + 逻辑消费点)。消费点(minified 摘录):

```js
function b_a(e,t,r){
  let n=process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
      o=process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE;
  return{ enabled:vI(), precomputeBufferFraction:L8b(e,t,r),
          testPctOverride:n?parseFloat(n):void 0,
          testBlockingOverride:o?Ag(o):void 0 }
}
```

字段名 `testPctOverride` —— 官方视其为测试用 override。telemetry schema(内嵌文档原文)确认语义:threshold = 「effective_window minus the summary buffer, **lowered further by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when set**」。

### 2.2 但 threshold-compact 可以整层不执行:`enforced` 概念

同一 schema 对 `enforced` 字段的原文:

> "Whether threshold-triggered compaction will actually fire at `threshold`. **False when the worker defers to the API's prompt-too-long (reactive mode) or context collapse owns headroom** — clients then show % of window used instead of a countdown to a compaction that won't happen."

即:存在两种模式让阈值压缩**不会发生**——reactive 模式(等 API 报 prompt-too-long 才反应)与 context-collapse 模式。路由到 reactive 是服务端实验开关:telemetry 事件 `tengu_auto_compact_routed_reactive`,主循环内代码:

```js
if(n!==void 0 && f!=="auto" && Fye()){
  w(`autocompact: routing through reactive (thresholdSource=${f})`);
  H("tengu_auto_compact_routed_reactive",{...});
  ... // 走 reactive compact 机械
}
```

且守门函数 `ulS` 里有 `if(Fye()&&!i4e(t,r))return!1` —— 该模式组合下阈值判定直接短路为「不需要 compact」。

### 2.3 即使触发,仍有三个失败/放弃层

主循环 `qCa` 摘录(均有对应 telemetry 事件名可供实测验证):

1. **失败断路器**:`if(o?.consecutiveFailures>=nFp) return{kind:"failure_breaker_open"}` —— 连续 compact 失败后不再尝试(`tengu_auto_compact_circuit_breaker`)。
2. **prefix overflow**:`autocompact: fixed prefix ~X > threshold — compaction cannot help`(`tengu_auto_compact_prefix_overflow`,`wouldHaveBlocked:!0`)—— 固定前缀(system prompt + rules bundle + MCP tools)超过阈值时直接判压缩无济于事。Lead 的 rules bundle 数万 token,是高危对象。
3. **rapid-refill 断路器**:压缩后短周期内再次填满则 trip(`tengu_auto_compact_rapid_refill_breaker`)—— Lead 场景(mailbox 批+告警持续涌入)容易命中。

reactive compact 自身也有失败事件(`tengu_reactive_compact_failed`),失败即落到「Context limit reached · /compact or /clear to continue」死墙,与 Cass 8-12 手动 /compact 失败实录同型。

### 2.4 相邻可用变量(设计不采用,记录备查)

env 注册表相邻项:`CLAUDE_CODE_AUTO_COMPACT_WINDOW`(直接指定压缩窗口)、`DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`。GEO-285 调研当年也列过前两个而未采用。这些同样是无文档契约的黑盒旋钮,随版本漂移,不作为本设计依赖。

### 2.5 结论(A 项失效层判定)

Tadashi 诊断的两个候选失效层的裁定:**「env 变量名在现版本失效」证伪**(变量在场且被消费);真实失效层 = Claude Code 内部「阈值压缩不保证执行、执行不保证成功、失败后有断路器」的多层黑盒,加上 1M 会话 compact 失败实录。**任何把安全性押在内部 auto-compact 上的方案都不成立**;它生效算增益,防线必须建在 Flywheel 侧。

## 3. Lead launcher 链(A/B 项落点)

### 3.1 启动链与 env 传播

```
launchd plist(KeepAlive)→ flywheel-lead-wrapper-v2.sh → env -i <白名单> tmux(私有 socket)
  → lead-body.sh <manifest> → source claude-lead.sh → env -i <child_env> claude <args>
```

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`:上游三层(plist / wrapper 白名单 / `~/.flywheel/.env`)都不带;`claude-lead.sh:1365` 默认 export 70,`:1861` 进 child_env 白名单 → **恒为 70 到达 claude 子进程**(与 Cass 活进程 env 实证一致)。传播链无洞。

### 3.2 session-id 生命周期(B 项病灶)

- 文件:`~/.flywheel/claude-sessions/<project>-<lead>.session-id`(`claude-lead.sh:250,531`)。
- 读:`:3092-3095`(`head -1`);写:**只在 fresh 分支**(`:3110-3113`,原子 tmp+mv);`/clear` 换代**不回写**。
- resume 形态:`:3099` `CLAUDE_ARGS + --resume <uuid>`,最终由 `_launch_claude`(`:1720-1740`)统一追加 `--model/--effort`。
- 走 fresh 的仅有三径:文件缺失/空;`lead-body-receipt.sh:34-42` 连续 3 次「resume 且 exit≠0 且 <60s」后删文件;测试 teardown。**没有「resume 后发现会话撞墙」的任何检测**。
- 人肉先例:`flywheel-flywheel-eng-lead.session-id.parked-1.42GB-20260803-183957` —— rename 泄压 → 下次 fresh 已是运维惯例,B 项方案与它同构。
- fresh 分支天然做 `send_bootstrap`(`:3103-3109`)+ `_adopt_inflight_before_launch`(`:3029-3043`,FLY-1708)→ **fresh 不掉批、有开机上下文**。resume 分支故意不发 bootstrap(`:1370-1371`)。
- `restart-services.sh:1908-1930`:claude-code backend 重启 = `launchctl kickstart -k`,**全文零处触碰 session-id** → 重启 ≡ resume 原会话。

### 3.3 /clear 接力现状(FLY-1751,已生产)

- hook 安装:per-Lead `${LEAD_WORKSPACE}/.claude/settings.local.json`,`SessionStart` matcher `clear` → `session-start-adopt-inflight.sh`(`claude-lead.sh:1165-1298` 幂等安装;companion/external 角色跳过)。
- hook 行为:三重身份锚后执行 `flywheel-comm adopt-inflight --recipient <lead> --kind lead`;adopted>0 时向新会话 stdout 注入一行交接说明;全路径 fail-open exit 0。
- `adopt-inflight` 语义(`mailbox-queue.ts:298-325`):该身份全部 `LEASED AND batch_id IS NOT NULL` 行翻回 QUEUED,`lease_retry_count+1`(幂等键换代,防 sidecar 吞投),`last_error='recipient_reborn'`。
- **缺口 1**:hook 拿得到新会话 `session_id`(SessionStart stdin JSON 自带)但不回写 session-id 文件 → 重启回僵尸。
- **缺口 2**:clear 腿无 bootstrap(PostCompact 腿的 `~/.flywheel/bin/post-compact-bootstrap.sh` 只挂 PostCompact,`claude-lead.sh:996-1056` 装到全局 `~/.claude/settings.json`)。
- 竞态纪律(FLY-1751 research 判定):**一次换代只 adopt 一次** —— launcher 腿覆盖进程换代,hook 腿只管 `source=="clear"`;新增泄压腿不得再叠加 adopt。

### 3.4 现成 context 读数

| 来源 | 口径 | 现状 |
|---|---|---|
| statusline stdin | `context_window.used_percentage`(Claude Code 官方口径,每帧推送)| `scripts/statusline-command.sh:15` 已解析,仅渲染 `ctx N%`,**不落盘** |
| transcript 末条真实 usage | 该轮实际喂给模型的 token 数(§1 方法)| 无消费者;`packages/token-usage/src/scanner.ts` 有解析先例但口径是累计计费 |
| pane 文本 scrape | `ctx N%` 正则(`pane-blocked-classifier.ts:59` 已有,当 TUI 存活锚)| 只用作 idle 判定,不当压力信号 |

statusline 落盘是运行时唯一官方口径;transcript 末条 usage 是**进程外/重启前**唯一口径。两者互补,分别服务 A(运行时巡逻)与 B(重启闸门)。

### 3.5 GEO-285 考古

引入 commit `d8a07ebad`(2026-03-29):override=70 只是四层防线之一(B3「早期 auto-compact」);当年调研明记该变量「默认 ~95%,只能调低」。四层中的**主力**「session rotation(定时+任务触发)」已被后续版本整段删除(`monitor_rotation` / `MAX_SESSION_AGE_SECONDS` 全仓零命中),只剩黑盒 env + 重启 —— 而重启 resume 回满会话。防线空心化是结构性事实,不是配置回归。

## 4. mailbox 投递链(感知盲区与红线)

- 状态机:`QUEUED → LEASED →(delivered_at)→ ACKED / DEAD`(`packages/flywheel-comm/src/mailbox-schema.ts:69-86`;队列机械 `mailbox-queue.ts`)。投递物理形态 = 写 `<CLAUDE_CONFIG_DIR>/teams/<lead>/inboxes/<lead>.json` + 幂等 sidecar,由 Claude Code stock inbox poller 注入会话(`lead-delivery-adapter.ts:56-90`、`ClaudeMailboxCodec.ts:268`)。**transport 成功 ≠ ack**;ack 需 agent 自己调 `flywheel_inbox_ack_batch`。
- 冻结机械(8-11 事故的机器解释):`inflightMaxBatches: 3` 准入闸(`mailbox-queue.ts:1058-1067`)→ 3 个 delivered-未 ack 批占满 → 47 条 QUEUED 冻结;租约 `ackLeaseMs` 30min 到期 → `lease_retry_count<3` 则 requeue 重投同一死会话(2.5h ≈ 5 个周期)→ 耗尽判 DEAD(`lease_expired_unacked`),死信通知按 30min 节流且对 Lead 永远渲染「探针实况:不可得」。
- 感知:**零**。`lead-inbox-loop.ts:247` `recipientState: () => "alive"` 硬编码;`mailbox-queue.ts:1478-1481` 对 lead 再硬编码。`pane-blocked-classifier.ts:6-22` 四种 kind 无 context;`model-cap.ts:15-16` + `model-cap.test.ts:31-37` **显式把「Context limit reached · /compact or /clear to continue」断言为 clear(无事发生)** —— FLY-1182 当年为排除误报所设,是本单要改写的反向断言。
- 红线(FLY-1708 plan):**不碰 `loop_owner` / Bridge 投递循环**。泄压腿必须在投递循环之外;解冻靠 adopt-inflight 清 `batch_id` → 在途槽位归零 → 队列自然排空(F7 对偶)。

## 5. 告警链(C 项基线)

- FLY-1764(#836,8-14 merge)后:`swap_pressure_high`(「OOM 预警」)走 Flow 2 —— `FleetSensors.maybePage → infra-event-router(ticket)→ enqueueInfraAlert(claw)` **只写 claude-infra-bot-lead 一行 mailbox**;全 Lead 广播腿(`broadcastLoadShed`)已物理删除并有反向哨兵测试。Honeylemon 连刷 4+ 条的通道已不存在。
- 门控:`FLYWHEEL_ALERT_ROUTING`(default-off,`truth.ts:296-297`);unset 则回旧 Discord 腿。生产 `.env` 据 FLY-1182 文档已设 `=1`,**需实机确认**。
- 残余缺口:①flapping —— 每个新 episode 生成新 eventId,穿透全部 5 层去重(episode 闩/shell 日签/claims 三级/Discord 20每分钟桶/mailbox deliveryId),无 per-(recipient,kind) 时间窗节流;②`collapse_key` 死列(`mailbox-schema.ts:85` 建列、`mailbox-queue.ts:392,462-468` 只写,全仓零读取)——同 kind 未投递行不塌缩;③queue 回放默认 `accept_delayed`,压力解除后仍补发过时告警(β `drop_stale` 已实现 default-off)。
- 接线脆弱点(顺手修候选):`lead-inbox-runtime.ts:407` owner 不在 projects 时 throw,而 `plugin.ts:9218-9228` ticketSink 无 try/catch → claw 未配置时每 tick 抛异常、告警永不投递。
- 量级判定:单条告警信体 ≈ 200–280 tokens,**context 税主要在每条信触发的被唤醒 turn**,不在字节 —— C 的减源价值按「减少唤醒轮次」定量。

## 6. 泄压执行通道(FLY-1706 吸收)

- 现成端点:`POST /api/sessions/:executionId/recovery-nudge`(`stuck-remanage-routes.ts:390`)+ 共享 primitive `runner-recovery-nudge.ts`(带 `runner_recovery_nudge` 审计事件),当前只会打 `continue`,面向 runner。
- FLY-1706(Backlog,零代码)已定的约束直接继承:①`/compact` `/clear` 属 harness 维护命令,不属「替答 gate」禁令;②注入前活性校验**必须 pane capture 直读**,禁用 `runner_terminal_list` MCP 探针(FLY-1681:v2 私有座位上对 runner 全报 alive=false);③compact 后需重发任务上下文(对 Lead = bootstrap)。
- Lead pane 的定位:v2 链私有 tmux socket,`tmux -S <socket>` + pane `%0`;既有 capture 先例见 `pane-blocked-classifier` 消费者(AlertChannelHub reconcile)。
- 保守约束需越过:`rescue.ts:43` 与 `pane-blocked-classifier.ts:86-89` 把 compact 形态当「in-flight 否决自动操作」信号 —— 泄压器注入 `/compact` 后必须等待/识别 `Compacting conversation` 完成,不与 rescue 自动 Enter 相互踩。

## 7. 可复用机制清单(plan 的地基)

| 机制 | 位置 | 复用方式 |
|---|---|---|
| fresh 分支(bootstrap + adopt-inflight) | `claude-lead.sh:3101-3113,3029-3043` | B 闸门超阈 rename session-id → 自然落 fresh |
| parked rename 惯例 | `.session-id.parked-*` 人肉先例 | B 闸门的 rename 形态(留档不删) |
| SessionStart(clear) hook | `session-start-adopt-inflight.sh` + 安装器 `claude-lead.sh:1165-1298` | 扩:回写新 session-id + 触发 bootstrap |
| PostCompact bootstrap | `post-compact-bootstrap.sh`(`claude-lead.sh:996-1056`) | clear 腿 bootstrap 复用同脚本形态 |
| statusline ctx% | `statusline-command.sh:15` | A 检测:落盘 `~/.flywheel/state/lead-ctx/<project>-<lead>.json` |
| transcript usage 解析 | `token-usage/src/scanner.ts:37-83` 先例 + §1 方法 | B 检测:末条真实 usage ÷ window |
| GatePoller rider 模式 | FLY-1560 后 riders(single-flight + 逐段 try/catch) | A 巡逻挂载,零新 timer |
| recovery-nudge 端点 | `stuck-remanage-routes.ts:390` + `runner-recovery-nudge.ts` | 扩 compact/clear action(FLY-1706 形态)+ 审计 |
| pane capture 直读 | `pane-blocked-classifier` 消费者先例 | 活性/完成校验;新增 `context_limit` kind 兜底识别 |
| adopt-inflight | `mailbox-queue.ts:298-325` + CLI | 不改;泄压后自动解冻队列 |
| 30min 分桶节流先例 | `plugin.ts:7755-7765`(死信腿) | C flapping 节流同构实现 |

## 8. 开放问题(进 plan 决策)

1. B 闸门阈值:70%(与 override 对齐)vs 更保守 60%?window 解析:model 字符串含 `[1m]` → 1M,否则按 200k;`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 未用可忽略。
2. A 巡逻阈值与两级泄压的升级判据(compact 后 ctx% 未降 / 出现 Compaction failed / 超时)。
3. 泄压动作频控:per-Lead 冷却(如 30min)+ 单 episode 只试一次 compact,失败直接 clear;clear 本身幂等安全(有 adopt-inflight)。
4. C 范围终裁:实机确认 `FLYWHEEL_ALERT_ROUTING` + collapse_key 塌缩最小实现 vs 删列;flapping 节流是否并入本单。
5. 撞墙兜底识别(`context_limit` kind)与 model-cap 反向断言的改写顺序(必须同 PR)。
