# FLY-1750 unavailable 类投递失败有界化 + Codex ack 腿真机打通 — 实施计划

Issue: FLY-1750 (https://linear.app/geoforge3d/issue/FLY-1750/bug-codex-lead-ack-batch-生产路径未打通fly-1573-未验腿-租约重投-131-次不进-dead-无-cap)
日期: 2026-08-13
基于: research.md(exploration.md 取舍已定;Lead 裁决 ask `631446b1` 三条全部折入;Codex design review 4 轮 APPROVED:R1 6 项 + R2 3 项 + R3 1 项全折入,R4 LOW 措辞已对齐 —— 含砍掉 Fix C、Fix A 收窄到 typed unavailable 分支、验收 self-contained、可归档终态族的 72h 边界诚实化)

> founder 已拍方向:「Bridge 租约重投加 retry cap,超限进 DEAD,别无限转」。Lead 裁决:修复必须 **general**(任何 recipient 的 socket 死了都有界退避 + 终态,不按 Lead 名写死);codex-infra-bot-lead 复活/退役 = founder 决策项,验收不得硬依赖。

## 0. 一句话

把 `deliverModelBatch` 对 `LeadDeliveryUnavailableError` 的无限投递豁免换成有界 knob(默认 55 ≈ 8.01h),到 cap 时先送达 founder 可见终态告警,再转 DEAD `transport_unavailable_exhausted`;告警失败则保留 LEASED 退避。两态都生效,queue ON 另由死信闸补扫。最后用真机把 Codex Lead「投递 → ack_batch → ACKED」正对照与「死 socket → cap → 告警 → DEAD → 停投」负对照各走通一遍。

## 1. Fix A — unavailable 类投递失败的有界 cap(核心;零 schema、零新 flag、零新定时器)

### 1.1 knob

| knob | 默认 | 界 | 说明 |
| -- | -- | -- | -- |
| `FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX` | 55 | [1, 100000] | unavailable 类投递失败的 `retry_count` 上限。**容忍窗按真实 backoff 序列算**(`min(10min, 5s×2^n)` 前 7 次指数、之后每次 10min):第 55 次 attempt 落在首投后 **≈8.0h**(R1#5 修正:48 次只有 ≈6.84h,不是「48×10min」);实施带确定性 elapsed-time 计算测试钉死这个换算,策略不再拍脑袋。上界放宽即逃生口(有效等同旧行为),**不加新 flag** |

- 落点:`mailbox-queue-config.ts`(FLY-1573 六 knob 同款:界 + 越界回默认 warn-once + allowlist 登记),进 **`MailboxQueueConfig`** 快照(每 tick 取一次,杜绝 tick 中途混态;R1#4 更正类型名)。

### 1.2 代码变更(R1#4 修正后的完整文件清单)

1. **`lead-inbox-loop.ts` 只改 `:540-542` 这一处**(`deliverModelBatch` catch 的 `nonExhausting` 分支,由 `error instanceof LeadDeliveryUnavailableError` 选中)→ `queueConfig.unavailableRetryMax`,并传 `deadReason: "transport_unavailable_exhausted"`。
   - **general 合同**:cap 键在**错误类**(`LeadDeliveryUnavailableError`)上,不在 backend/leadId 上 —— 今天只有 Codex adapter 会造这个错,将来任何 backend 的连接级故障同样有界。不写任何 Lead 名。
   - **告警失败退避显式不设投递 cap**:`quarantineDiscord` 的 `onDiscordUndeliverable` 与新增 lead terminal alert 都遵守「告警送不出去之前不许把行判死」的可见性合同;这里只在告警 sink 挂掉期间保留 LEASED,告警恢复即收敛。它不是本单要消灭的 transport 自旋。
   - `LeadInboxLoop.tick()` 里 OFF 态 fallback 的 config 字面量补新字段(R1#4)。
2. **`mailbox-queue.ts` `recordLeadDeliveryFailure`** 增可选参 `deadReason?: string`(默认保持 `'delivery_attempts_exhausted'` 字节兼容);DEAD CASE 行的 `dead_reason` 用它。不动其余机械(cap 判定、frozen 保批、批级原子性全复用)。
3. **`mailbox-queue-config.ts`**:解析 + 界 + warn-once + 快照字段。
4. **`packages/config` 的 non-flag allowlist**(`NON_FLAG_ALLOWLIST` 所在文件,R1#4)登记 "config value" 一行。
5. **测试文件**:`mailbox-queue-flag.test.ts` 现断言**恰好六个** queue knob → 改七;**替换**既有「does not exhaust … Codex transport outage」测试(它钉的正是被本单修掉的旧语义);**保留**「unalertable Discord row」行为测试原样(证 `:602` 不受影响)。

### 1.3 语义钉死(测试合同)

| 断言 | 语义 |
| -- | -- |
| unavailable 失败到 cap → **终态告警先成功** → 整批 DEAD `transport_unavailable_exhausted` → 停投;告警失败则保持 LEASED、继续有界 backoff 直到可见。精确断言 DEAD 后跨多个 tick 的 `retry_count` 与 adapter attempt 定格 | 核心收敛 + 不静默丢失 |
| ON/OFF 真值表:**ON** → 终态直告 + `listUncoveredLeadDeadLetters` 补扫 → intent;**OFF(当前生产)** → 不建 intent,但终态直告不受 flag 控制,送达前不判 DEAD。Discord unavailable cap 走 `onDiscordUndeliverable`。对可归档终态族,72h 后可能出活表;开放 question 族受 terminal-family 保护继续留在活表。终态信号已在 DEAD 前完成,不再依赖归档后补扫或会停止的 stall 告警 | 两态均有 founder 可见终态证据 |
| `'transport_unavailable_exhausted'` **不在** `QUARANTINE_DEAD_REASONS`(反断言:quarantine 恢复通道不复活它) | research §5.1 |
| exhausting(真实)失败仍 5 次 cap,`dead_reason='delivery_attempts_exhausted'` 字节不变 | 兼容 |
| 单预算污染语义:unavailable 抬计数后一次真实失败 → 立即 DEAD —— 显式测试接受此现状(有界即可,不加第二列) | research §5.2 |
| queue OFF 下终态告警失败 → 行仍 LEASED;告警恢复 → DEAD;queue ON 同样 cap + 停投 | 代码评审 HIGH + LOW 回归锁 |
| Discord unavailable cap → `onDiscordUndeliverable` 先送达,再以 `transport_unavailable_exhausted` 判 DEAD | 代码评审 MEDIUM advisory |
| `CodexLeadInboxRejectedError`(auth 拒绝)不豁免:仍走 5 次普通 cap | 已有行为,防回归 |
| discord_chat 行的 `route_protocol_unavailable` 同 cap 收敛 | research §5.5 |
| `:602` 告警失败退避行为字节不变(「unalertable Discord row」测试原样通过) | R1#1 |
| 确定性 elapsed-time 换算测试:默认 55 次 ≈ 8.0h(backoff 序列真算,非 N×10min) | R1#5 |
| knob 界/越界回默认/快照单 tick 不混态;`mailbox-queue-flag.test.ts` 六→七 knob | FLY-1573 惯例 + R1#4 |
| runner lane 零变化(无 MAX_SAFE_INTEGER 位点,防引入) | 静态断言即可 |

### 1.4 ON/OFF 声明(Codex R1/R2 已裁定形态)

`deliverModelBatch` 的 catch 是 ON/OFF 共享的,**cap 两态一并生效**。生产当前 `FLYWHEEL_MAILBOX_QUEUE=0`,所以不能把安全性建立在 ON-only scanner 上:terminal alert 是 flag-independent 直送,送达失败时行保持 LEASED;送达成功才进入 DEAD。ON 态继续运行 FLY-1573 scanner 作为第二道补扫,并有专门回归测试锁定 frozen claim 路径不会复活 DEAD。

## 2. Fix B — Codex ack 腿真机打通与验证(FLY-1573 验收 10 的欠账)

### 2.1 B1 正对照(mufasa 健康腿;**不依赖 codex-infra-bot**)

真机步骤(QA 节点执行;全程只读生产 + 一条真实测试消息):

1. 前置核验:mufasa 载体活(launchd job + socket listener `lsof`)、config.toml `[mcp_servers.lead_actions]` 含 `ack_batch` 所需 env(现已在,research §2);
2. 经正门造一条发往 `mufasa-lead` 的 mailbox 消息(如 `flywheel-comm send`)→ 观测 growth comm.db:行 LEASED 且 **`delivered_at` 非空**(生产史上第一次)+ mufasa journal 收到批;
3. mufasa 真调 `lead_actions.ack_batch`(模型自发,或经 chat 明示引导一轮 —— 与 FLY-1573 验收 10 同口径)→ growth comm.db 出现 `type='ack_batch'` protocol 行(**史上第一条**)→ ProtocolIngress 消费 → 原行 **ACKED**;
4. 留四段证据:mailbox 行前后快照 / journal 行 / protocol 行 / ingress 后终态。

### 2.2 B2 负对照(受控死 socket;**不碰生产数据**;R1#3 口径)

隔离环境(529 QA 房 slot 或独立 comm.db + 假 stateDir;**QA env 全名 + 定态**(R2#2):`FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX=3`、短 backoff、intent 准入对照组显式 `FLYWHEEL_MAILBOX_QUEUE=1`,并 scrub/restore ambient env 防 QA 房继承 OFF):

1. 注册一个指向**不存在 socket** 的 codex 后端假 Lead,**投入固定的一组消息后静默输入**(quiesce:无新 enqueue,断言面才是 per-row 可判定的);
2. 断言(逐 mailbox id):`retry_count` 到 cap → terminal severe 送达 → 整批 DEAD `transport_unavailable_exhausted` → 多个 tick 后计数与 adapter attempt 定格、永不再 claim;另注入 terminal alert 失败,断言仍 LEASED,恢复后才 DEAD;ON 组再断言死信 intent 准入;
3. 对照生产残迹:issue 里 131/48/23 的行**只留证据不动**(Lead 裁决 3;人工 ACK 残迹不当验收对象,research §5.6)。

### 2.3 B3 codex-infra-bot-lead(founder 决策项,非验收依赖)

- 事实(Lead 补充):8-08 被**故意停掉** —— Codex `auth.json` 缺失(FLY-246 设计不复制凭据),起来即 crash-loop;「补哪个号」的 founder 决定至今未下。
- 本单交付:**决策卡片素材**写进 founder HTML(选项 A 复活:前置 = founder 拍 Codex 凭据 → 按 mufasa 现行形态重建 wrapper/config.toml(含 lead_actions)→ bootstrap → 跑一遍 B1 口径验证;选项 B 退役:registry 移除 + 存量 QUEUED/LEASED 行经正规通道判 DEAD)。**两选项都不阻塞本单验收**;其 mailbox 无 delivered-未 ack 在途批(`delivered_at` 全 NULL),将来复活无 FLY-1751 陷阱(research §5.4)。
- 在 founder 拍板前,该 Lead 的新增消息在 Fix A 下 **约 8h 先发终态 severe、再收敛 DEAD**;queue ON 时另有死信 intent 补扫,不再无限转或在 OFF 下静默死亡。

## 3. Fix C — 已砍(R1#2)

原方案(部署收尾对每个 registered codex Lead 做 socket 探活)被 Codex R1 证伪:谓词对现役舰队**已知为假** —— 被故意停掉的 `codex-infra-bot-lead` 会让**每次**部署都 degraded,直到一个与部署无关的 founder 凭据决定落地;且 shell 侧要正确推导 `createProductionAdapter` 同源的 stateDir + authSecret,复杂度远超「30-50 行」。**从本单移除**。发现时间的兜底:既有 30min severe(`codex_model_transport_unavailable`)+ Fix A 的约 8h 死信告警。若将来要做,需先有「预期在跑/生命周期」谓词(舰队编制单的事),不属本 bugfix。

## 4. 实施顺序(TDD)

| 步 | 内容 | 测试先行(关键断言) |
| -- | -- | -- |
| 1 | knob:`mailbox-queue-config.ts` 解析 + 界 + `packages/config` allowlist + `MailboxQueueConfig` 快照字段 + tick() OFF fallback 字面量 | 界/越界回默认 warn-once/快照单 tick/`mailbox-queue-flag.test.ts` 六→七 |
| 2 | `recordLeadDeliveryFailure` deadReason 可选参 | 默认字节兼容;新 reason 落库;QUARANTINE_DEAD_REASONS 反断言 |
| 3 | typed unavailable 分支换 knob;cap 边界先告警后 DEAD;Discord 走专用 undeliverable;告警失败保行 | §1.3 全表(含 queue OFF fail-close、queue ON、Discord、elapsed-time 换算) |
| 4 | 全仓门 | `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 相关 shell 测试(FLY-224/248 全 repo 教训) |

## 5. 验收(QA 节点真机;self-contained,R1#3)

**必过硬门(仅两条;精确边界 = 均不依赖 `codex-infra-bot-lead` 及其 founder 复活/退役决策,R2#3。B1 有意依赖 mufasa 活载体 —— 它就是「生产健康腿」正对照本身):**

1. **正对照**:B1 —— mufasa 真 ack 一批 → 行 ACKED(附 §2.1 四段证据)。
2. **负对照**:B2 —— 隔离环境、输入静默后,指定 mailbox id 在 cap 时先有 terminal severe,再进 DEAD;跨多个 tick 计数定格、永不再 claim;终态告警失败注入时不得先 DEAD;queue ON 组另验 intent 准入。

**非阻塞 post-deploy 观察(telemetry,不是验收门):**

3. `codex-infra-bot-lead` 现存 LEASED 行预期在部署后约 8h(8.01h + 调度抖动)收敛 DEAD + 死信告警 —— 该行可能在 QA 前被人工 ACK/founder 拍复活而消失,**不作为门**(R1#3);观察到即记录,观察不到不 FAIL。
4. 生产证据行(131/48/23)原样留存,QA 报告引用不修改。
5. 措辞纪律:「DEAD 计数不再增长」只对**静默输入的固定行集**成立;死 socket 收件人若持续进新消息,每条新消息各自走约 8h 收敛(有界但集合仍会长)。QA 报告按此口径写,不做收件人聚合断言。

## 6. 不做什么

FLY-1749(Claude 腿 retry=0 洪水/广播语义)、FLY-1751(rebirth 对账)、kickstart `claude-infra-bot-lead`、`lease_retry_count` 机制、mailbox schema、新 flag、新定时器、告警去噪、部署探活。告警 sink 自身失败时保留 LEASED 的退避属于可见性合同,不是 transport 重投 cap;不允许为了“数字归零”先静默判 DEAD。

## 7. 风险与缓解

| 风险 | 缓解 |
| -- | -- |
| 约 8h 窗内真实长故障消息进 DEAD | DEAD 前先直送 terminal severe;失败则保行;ON 态另有死信闸。knob 可调大 |
| OFF 持续超 72h → 可归档终态 DEAD 行出活表,回 ON 不再补 intent | 终态 severe 已在 DEAD 前送达;开放未回答 question 族继续留活表。审计归档仍可人工查 |
| 默认值与真实耗时脱钩 | R1#5:55 次 ≈ 8.0h 按 backoff 序列真算 + 确定性换算测试;不再用 N×10min 近似 |
| 单预算污染(unavailable 抬计数 → 恢复后首次真实失败立死) | 显式测试接受;有界优先于精确分账(简单性) |
| OFF 态语义偏离字节兼容 | §1.4 显式声明,交 Codex review 裁 |
| B1 依赖模型真调工具(行为不可强制) | 与 FLY-1573 验收 10 同口径:chat 明示引导一轮属合法验证形态 |
| codex-infra-bot 决策悬置期间继续积 DEAD | 每 30min stall severe + DEAD 前 terminal severe + ON 态死信闸 + 本单决策卡片 |
| 新 dead_reason 被未知读者按枚举解析 | 实施时 `rg dead_reason` 全仓复核读者(FLY-1573 同款纪律) |
| `:602` 无限退避残留 | 显式知情保留(R1#1):语义不同不硬套;独立小单跟进 |

## 8. 交付边界

本 design 节点交付:三份文档 + founder HTML(含 B3 决策卡片)。实施(Fix A 代码;Fix C 已砍,§3)、QA(§5 真机)、ship 归 DAG 后继节点。版本号 ship 时取空号。部署:随常规重启车生效(knob 属 env,读点在 Bridge tick 快照,无需特殊时序);回滚 = knob 调大(无 flag、无 schema、无迁移)。
