# FLY-1831 Flag 治理 A9 收尾 — 调研
Issue: FLY-1831 (https://linear.app/geoforge3d/issue/FLY-1831/flag治理a9收尾包-每周扫描运行合同-finalize-qa-脚本退役-flag-墓碑对齐并1881-8-个直读-env-残余逐条对账)
日期: 2026-08-21
基于: exploration.md

## 1. 当前实现证据

### 1.1 每周扫描

- `packages/config/src/feature-flags/scan.ts` 的 `FLAG_SCAN_INTERVAL_MS=7d` 同时被稳定值判据和 Bridge 调度使用。
- `flag-retirement-scan.ts::scanIfDue()` 用 `now-latest.committedAt < 7d` 判断 due，所以成功时间会永久漂移。
- `owedLegs()` 只有存在 candidate 时才欠 `linear/report/discord`；0 candidate 且无 clock debt 时整轮直接 published，founder 收不到固定周报。
- `renderFlagScanReport()` 已包含人话描述、当前值、稳定时长、留/清控件、localStorage、复制与失败 fallback，可直接复用。
- `flag-retirement-production.ts` 把 Discord 投递到 Flywheel `generalChannel`，当前 roster 的值就是 founder 指定的 `1516209289406971965`，但没有 exact-id 断言、thread 或 Lead handoff。
- `lead_notify` 目前只服务 `no_clock/keep_unbound`，不代表成功周报答疑交接。

### 1.2 恢复与幂等

现有 `flag_scan_run_legs` 把 Linear、report、Discord 和 Lead 通知分腿持久化；visible leg 的 ambiguous 状态通过 marker reconcile。Discord 根消息带 ``flywheel:flag-governance run=<token>``，可定位既有根消息。

thread 新增不能只放在 root POST 之后 best-effort：若根消息已成功、thread 失败，而 reconcile 只看到根消息就把 leg 标 done，会永久违反交互合同。正确边界是：Discord leg 的 done 证据必须同时证明 root、thread、thread handoff 三件事；reconcile 找到 root 后继续 ensure thread 与 handoff，再返回 found。

现有恢复还有一个更深的边界：`flag_scan_one_pending` 只允许一条 `committed` run；`scanIfDue()` 又永远先处理 pending。Linear/Discord 目前不能 degrade，故永久 403/缺权限会让这一轮无限 `ambiguous → pending`，后续每个 Sunday slot 全被挡住。A9 必须加固定的 24 小时 pending 上限（无旋钮）：先写 durable failure intent 并把责任消息投进 Lead mailbox，再把所有未结腿以原状态和原因 settle 为 `degraded`；若 Bridge 整周离线，则发现 slot 已跨周时同样立即执行。下一次 tick 在同一次入口继续计算当前槽。这样失败会被看见且不伪装成 delivered，同时不会让旧债杀死所有未来周期。

### 1.3 FLY-1881 漏口

`scripts/lib/qa-generalized.sh` 仍存在两套与墓碑冲突的合同：

- `qa_generalized_feature_env()` 输出五个 `...=1`。
- `qa_generalized_write_env_attestation()` 要求五个变量都为 `1` 并把它们写入 `.flags`。

`scripts/test-deploy.sh` 把它们注入 Bridge 与 Lead；`test-deploy-generalized.test.sh` 又断言“恰好五个”。FLY-1808 已在 `RETIRED_FLAGS` 写入完全相同的五个名字。QA 应验证 generalized room 的真实不变量（`pipeline.dag=true`、`pipeline.work_kind=true`、schema-v2 engine authority），不再靠退役 env 造旧世界。

环境 attestation 没有其它消费者；room info 只把路径作为诊断字段。最小净删除是移除 feature-env 生成器、注入、五变量断言和 attestation 文件/参数，而不是把 `.flags` 改成空对象继续保留无意义产物。

## 2. 日历槽算法

新增纯函数：

```ts
latestFlagScanSlotAtOrBefore(nowMs: number): number
flagScanIsDue(nowMs: number, latestCommittedAt?: number): boolean
```

合同：

- timezone 固定 `America/Los_Angeles`；weekday 固定 Sunday；hour 固定 08:00。
- 用 `Intl.DateTimeFormat(..., { timeZone })` 读取当地年月日/星期，再把“当地 Sunday 08:00”迭代换算为 epoch；不依赖宿主 `TZ`，跨 PST/PDT 正确。
- `latestCommittedAt >= latestSlot` 即本槽已经运行；否则 due。
- 空库立即 catch-up 到最近槽；pending run 先恢复，但超过固定 24 小时或已跨入下一槽就 fail-loud + settle degraded，不得永久挡槽。
- dry-run 与手工 `recoverPending` 不推进日历槽。

候选引擎继续使用 `FLAG_SCAN_INTERVAL_MS`，因此“固定周槽”和“值稳定至少 7 天”互不污染。

## 3. Discord 成功腿

生产 sender 不能沿用 `announcerBotToken ?? config.discordBotToken`。现网 Flywheel 没有 announcer token，host bot 在部门/核心频道权限并不可靠；A9 固定使用与 core channel 绑定的 `flywheel-cos-lead` bot。它是已登记 Lead，能被 FLY-282 纳入 Tadashi 的 `allowBots`，且 live roster/access 事实为：Cass bot id `1516205086890786917`、Tadashi bot id `1516207680836866219`、Tadashi core group `requireMention:true` 且 `allowBots` 已含 Cass。

每个 due slot 在 Discord leg 发真实 root 前做 fail-loud preflight；扫描、DB commit、Linear ledger 与 report publish 不依赖 Discord 可用性：

1. `/users/@me` 必须证明 sender token 对应 roster 中的 Cass bot id；不允许 host/announcer fallback。
2. 通过 `compileLeadIdentityRegistry` 的 FLY-1726 canonical projection 取得 Tadashi `discordStateDir`，读取其中 `access.json`，证明 core group 存在且 `allowBots` 含 Cass bot id；不硬编码 `~/.claude/channels/discord-<lead>`。
3. Discord leg 在需要主动权限复核时，用 Cass token 在 exact core channel 做 bounded round trip：单条 probe POST → 从消息建 public thread → thread 内 POST。三步失败都让该 leg 留在 ambiguous，并由 24 小时 stall breaker 兜底；probe cleanup 只 archive creator-owned thread + 删除 bot 自己的 seed，cleanup 失败仅告警、不否决真实交付，也不要求真实路径不需要的 `MANAGE_THREADS`。
4. 主动 probe 不是每周视觉噪声：仅在从无成功证据、最近一次成功 probe 已超过固定 21 天、或 sender/channel/intake fingerprint 改变时执行；时间与 fingerprint 写入 leg evidence，无 env 旋钮。其短暂出现在 founder core channel 是明确接受的三周一次上限，消息带自动化/探针标签且不 mention 任何人。

真实根消息也必须单条（`<=1900`），run marker 放第一行；不复用会拆分的 helper 来决定 thread anchor。

一次完整成功证据应为：

```json
{"rootMessageId":"...","threadId":"...","handoffMessageId":"...","inboxDeliveryId":"...","inboxRecipient":"flywheel-eng-lead","preflightAt":"...","preflightFingerprint":"..."}
```

流程：

1. 往 Flywheel 核心频道投根消息：`本周 N 条候选` + report URL；Linear URL 可作为次要台账链接。
2. 从根消息开 thread，名称含当周日期；候选数保留在 root 摘要。
3. 根消息、probe、thread 首条都通过 `markAutomatedDiscordText` 保留 `🤖 [自动]` 身份。Handoff 明确 Annie 在这里问/定、Tadashi 负责解释和落账；只用 `allowed_mentions.users=[Tadashi bot id]`，不双 mention Cass，也不开放 `@everyone/@here/role`。
4. 另用 Bridge 的 `LeadInboxRuntime.enqueueInfraAlert` 把 thread 指针投到 **Tadashi 自己的 mailbox lane**，而不是 `LeadAlertNotifier` 的 unified alert channel。`getLeadEventSettlement` 只有 `ACKED` 才证明 Lead intake；`QUEUED/LEASED` 且现有 Lead lease liveness 为 `alive` 时继续等待，只有 `DEAD` 或 liveness 明确非 `alive` 才向 Cass 自己的 mailbox 投 fallback。Fallback 也只有 `ACKED` 才算完成；不用 10 分钟墙钟，因为 2026-08-21 production 分布中健康 `lead_event` 超 10 分钟 ACK 约 16.5%。
5. reconcile 先按 run marker 找根消息，再验证/补建 thread、handoff，并检查 mailbox settlement。只有三项 Discord 证据和 primary/fallback 之一的 `ACKED` 都存在才 done。`LeadAlertNotifier` 的 `sent/queued_durable/deadlettered_durable` receipt 不参与 handoff 判定；运维 alert 若保留，也必须显式区分 outcome，`deadlettered_durable` 永不算交付。

报告发布 degraded 时根消息仍诚实写明失败并给 Linear 台账；thread 和负责人交接仍必须存在。

Stall breaker 还有两个账务细节：若 Discord 腿最终 degraded，StateStore 必须先解析其 evidence；仅在缺少 founder-facing `rootMessageId + threadId` 时，才对 `last_asked_run_id` 仍指向本 run 的 candidate 回滚 `ask_count`。根/thread 已到货但 mailbox 尚未 ACK 时不回滚，因为 Annie 已经被问。现有 run-level `published` 是 schema 的 legacy **settled** 标记，不代表所有腿 delivered；任何消费者必须看 leg `done/degraded`。

## 4. 8 个直读 env 的逐条证据

| env | 读点 | 当前真值账 | 最终判定 |
| --- | --- | --- | --- |
| `ALERT_ROUTING` | `infra-event-router.ts`、`tools.ts` | `NON_FLAG_ALLOWLIST` 称 rollout lever；生产 `=1` | 删除 env，Router/ticket-channel guard 固化 ON；保留依赖注入 seam 做单测 |
| `ALERT_TICKETS` | `LeadAlertNotifier.ts`、`infra-alert-wiring.ts`、`lead-alert.sh` | `NON_FLAG_ALLOWLIST`；生产 `=1` | 删除 env，ticket enrichment/header 固化 ON；TS 依赖注入 seam 保留 |
| `CHROME_REAPER_MIGRATE_UNATTRIBUTED` | `plugin.ts` → `chrome-session-reaper` | `NON_FLAG_ALLOWLIST`，但实际改变是否 kill | 从 non-flag 移到 `FLAG_EXEMPTIONS`，`persistentEnvAllowed:false`；只允许显式迁移调用，不允许常驻 `.env` |
| `DESIGN_HTML_GATE` | CLI + Bridge 四入口 | `FEATURE_FLAGS` | 原样保留并加 A9 disposition 测试 |
| `DETECTION_AI_CLASSIFY` | rescue + runner auth scan | `NON_FLAG_ALLOWLIST`；absent=ON | 删除 env，两个 classifier 均恒接 AI classifier |
| `INSTRUCTION_PATH_CHECK` | design review manifest/validation 五入口 | `FEATURE_FLAGS` | 原样保留并加 A9 disposition 测试 |
| `QUOTA_QA_INJECTION` | quota monitor 两个 fault-injection 参数 | `NON_FLAG_ALLOWLIST`，但实际改变行为 | 移到 `FLAG_EXEMPTIONS`，`persistentEnvAllowed:false` |
| `SYNC_BIN_ALLOW_TEMP_ROOT` | global-bin worktree 防线 | `NON_FLAG_ALLOWLIST`，但实际绕过安全 guard | 移到 `FLAG_EXEMPTIONS`，`persistentEnvAllowed:false` |

三条删除不引入新 flag；`DETECTION_AI_CLASSIFY` 的 absent 默认原本就是 ON。两个 `ALERT_*` 则是把**当前生产值**固化 ON，不是全调用方 byte-compatible：不继承 `~/.flywheel/.env` 的 QA room、sparse launchd caller、liveness probe 会从 OFF 变 ON。实现必须覆盖 FLY-529 alert mirror、Router/Notifier/shell 与 sparse-profile tests，并逐项接受/修正新行为。

`ALERT_ROUTING`/`ALERT_TICKETS` 墓碑落地时，生产 `.env` 仍有两行。merge 不触发部署；第一次 updater 部署前必须先按 runbook 原子删除这两行，再跑 `check-flag-truth` 和 `--live`，然后才进入后续部署窗口。implement Runner 不改 live `.env`、不重启。

消费者清扫还包括非 read-site 字节：`flywheel-claude-profile` 的 preserve allowlist、`qa-fly-1252-quota-state-e2e.sh`、`qa-fly-1082-fleet-alerts-e2e.mjs`，均删除旧名；`qa-fly-1707-incident-dispatcher.ts` 的四个 FLY-1808 墓碑注入也明确删除，不再保留条件判断。

## 5. 推广合同（本单冻结，后续 adapter 消费）

| 项 | 通用项目合同 |
| --- | --- |
| opt-in | 项目显式启用；缺配置默认不扫描 |
| registry | `<projectRoot>/.flywheel/feature-flags/registry.json`，schema versioned；路径不可由 env 任意改写，不跟随越界 symlink |
| value | adapter 负责输出“解析后生效值”，Bridge 不猜 `.env`/源码默认值 |
| channel | roster 的 project `generalChannel`，不回退其它项目或任一 Lead 私聊频道 |
| owner | 唯一 Engineering Lead；CoS 是失败/离线接力人 |
| cadence/model | Sunday 08:00 project-local declared timezone（v1 Flywheel 固定 PT）；扫描零 LLM |
| verdict | `<projectRoot>/engineering/doc/flag-governance-ledger/` 或项目声明的 department doc 根；仍走 frozen run token + preflight |

本 PR 不加入未消费的 `registry.json` loader 或 config 字段；那会超出“不是重做扫描器”，也无法在没有项目 adapter 的情况下诚实验证解析后有效值。

## 6. 会过期的结论

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| `qa-generalized` 的五变量残余另含 qa-fly-1707 四变量注入 | HEAD `aa9d05f5b` | `rg 'FLYWHEEL_WORKFLOW_(TEMPLATE_DISPATCH|GENERALIZED_TEMPLATES|CLAIMS_WRITE|CLAIMS_READ|GATE_CARRIER)' scripts/lib/qa-generalized* scripts/test-deploy.sh scripts/qa-fly-1707-incident-dispatcher.ts scripts/__tests__/test-deploy-generalized.test.sh` |
| 8 个 env 的 registry/truth 分布如表 | HEAD `aa9d05f5b` | `rg 'FLYWHEEL_(ALERT_ROUTING|ALERT_TICKETS|CHROME_REAPER_MIGRATE_UNATTRIBUTED|DESIGN_HTML_GATE|DETECTION_AI_CLASSIFY|INSTRUCTION_PATH_CHECK|QUOTA_QA_INJECTION|SYNC_BIN_ALLOW_TEMP_ROOT)' packages scripts` |
| Discord start-from-message 的 thread id 等于 root message id | Discord v10 / 现有 helper contract | 定向运行 `chat-thread-utils` 与新增 production effect 测试 |
| Cass sender/Tadashi intake preconditions 如 §3 | 2026-08-21 live roster/access | 每次 due slot 的静态 identity/access validation；主动 Discord probe 仅在无证据、21 天过期或 fingerprint 变化时 |
