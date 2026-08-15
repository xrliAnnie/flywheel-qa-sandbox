# Design Review — FLY-1716 plan.md (Round 1)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向可行：在 launcher 的既有 resume/fresh 分叉前做 gate，并复用 FLY-1751 的 clear-time adopt，是当前架构里最短的结构性修复。不过本版还不能兑现“重启出来一定不满”：probe 的 fail-open 语义、无 fencing 的 `/clear` 回写，以及缺少 action-time 身份校验的自动注入，都会让生产 Lead 回到 zombie 会话或把 `/clear` 打进错误/正在工作的会话。建议先收紧 Wave 1 的安全契约与 receipt，再让 Wave 3 获得自动执行权限。

## What's Good (Keep)

- 边界选择正确：不改 mailbox delivery loop、`loop_owner` 或投递状态机，清压动作放在 launcher/Bridge rider；这符合 FLY-1708 红线，也把核心投递链的 blast radius 控住了。
- 现有代码确实提供了所需骨架：`claude-lead.sh:3090-3115` 有清晰的 resume/fresh 分叉，fresh 会写新 session-id 并发 bootstrap；`session-start-adopt-inflight.sh` 已是 matcher=`clear` 的 fail-open SessionStart hook；`restart-services.sh` 的 Lead 路径最终会重新经过 launcher。
- Wave 1 优先于运行时自动化、park 留档而非删除、probe 有扫描预算、写文件采用 tmp+mv、Wave 3 有 escape hatch 与结构化审计，这些都是合适的可回滚设计。
- 复用 GatePoller rider 而不新增 timer 是对的；保留 `/compact` 一级、只在明确失败后升级 `/clear`，也比直接周期性清会话更符合 Founder 的简化与风险约束。
- 测试方向覆盖了 launcher、hook、classifier、真实 tmux 和负向路径；V1-V3 把最重要的 restart/clear 行为单列出来是正确的验收排序。

## Issues & Recommendations

1. **BLOCKER — resume gate 的 fail-open 契约与“重启出来一定不满”互相矛盾。** 读取器只取“最后一条真实 assistant usage”，但本次取证本身显示该回复之后仍有约 55MB 尾部内容；因此最后一次 usage `<70`、尾部全 synthetic、扫描预算耗尽、路径推导错误或文件缺失，都不能证明当前 session 可安全 resume。计划却让所有 `pct:null` 继续 `--resume`，所以 V1/B 仍可原样重现。另一个具体错位是：实际 model 在 `_launch_claude` 内 `claude-lead.sh:1646-1727` 才通过 canonical resolver 决定，而 gate 位于 3090；transcript 内的 `claude-opus-5` 也未必带 argv 的 `[1m]` 后缀，按计划会被误算成 200k window。修正为明确三态 `safe_resume | unsafe | unknown`：要保留硬保证，只有有界且可信的 `safe_resume` 才允许 resume，`unsafe/unknown` 都 park 后 fresh；若坚持 unknown fail-open，就必须把 B/V1 降级为 best-effort，不能再写“一定”。同时把 canonical model/window resolution 提前并与 launch 共用同一个 decision，精确支持 `CLAUDE_CONFIG_DIR` 和真实 Claude project-slug 规则（仓库里没有可直接复用的该路径转换 helper），补空格/Unicode/symlink/错误 window/跨 4MB 块/128MB exhaustion 测试。gate receipt 也应另建 launch-time receipt；现有 `lead-body-receipt.sh` 是 Claude 退出后才在 `claude-lead.sh:3141-3146` 写入，会覆盖同一文件，不能承载启动时 gate 证据。

2. **BLOCKER — `/clear` session-id 回写只有原子性，没有 authority/CAS，旧 hook 可以覆盖新一代会话。** 当前 hook 只校验 `source`、`agent_type` 和 Lead env（`session-start-adopt-inflight.sh:9-28`）；计划的 tmp+mv 只能保证文件不半写，不能阻止 delayed clear hook 在 kickstart/fresh launch 之后把旧 body 产生的新 UUID 写回。把 launcher 当前 session-id、lease key/generation 和 session-id 文件路径作为受控 env 传进 child；hook 在 per-Lead lock 内验证新 `session_id` 格式，并做 CAS：文件仍等于 expected old id 且 generation 仍属当前 body 才能 history+写新 id；已等于 new id 视为幂等，其他值一律 fenced、只留审计。用 new session-id 建 durable clear receipt，使 adopt-inflight 对同一 rebirth 至多完成一次，并记录 `writeback/adopt/bootstrap` 各步骤结果。现 hook 在 comm 缺失或 adopt 失败时会提前退出（26-47），必须拆成互不短路的步骤；安装器 timeout 现在是 10s（`claude-lead.sh:1250-1253`），而 `post-compact-bootstrap.sh` 的 curl 单独可等 15s，不能直接串入而不调整时限/执行方式。测试至少增加：旧 hook 晚于新 fresh launch、两个 clear hook 乱序、重复同一 clear、缺失/畸形 session_id、history/write/adopt/bootstrap 各自失败；这些都不得 clobber 当前 session 或重复 adoption。

3. **BLOCKER — Wave 3 的 idle 判定和 send-keys 原语不足以安全地给生产 Lead 输入命令。** 计划建议复用的 `IDLE_READY_MARKERS` 是 `pane-blocked-classifier.ts` 的私有常量，而且其中 `ctx N%` 和 permissions status bar 是工作中也持续显示的锚点，不是 idle 证明；按它判定会把 `/compact` 打进正在输出/使用工具的会话。现有 `runner-recovery-nudge.ts:269-320` 展示了应遵守的安全级别（live fingerprint、真实 input box、action 前复验、audit-before-keystroke），但它是 Runner 语义，不能直接放宽给 Lead。请定义一个窄的 Lead terminal-action primitive：只接受 canonical `LeadWindowRef`，在私有 socket 上重新 locate/probe Claude body，校验 project/Lead/session/generation，fresh capture 后要求真实空 input box（或对 `context_limit` 使用专门的“墙面可输入”形态），发送前再次 capture 并比对 fingerprint；active spinner、`compacting conversation`、resume menu 和人工输入变化必须优先 veto。所有 Lead 注入器共享 per-Lead single-flight/mutex 或同一 action ledger，避免与 rescue、kickstart、人工 `/clear` 竞态；audit 落盘失败要 fail-closed，不发按键。

4. **BLOCKER — 两级泄压 episode 没有绑定会话代际，升级/冷却/成功判据也未闭合。** `{stage,ts,pct}` 会跨 manual clear、restart 或 Lead replacement 留存，10 分钟后可能对一个全新的健康 session 发送 `/clear`。另外 Bridge 实际 `pollIntervalMs` 是 3 秒（`plugin.ts:7420-7422`），GatePoller 自己也注明 20 tick 约 60 秒（`gate-poller.ts:1096`），并非计划所写的约 20 分钟；若 30 分钟 cooldown 从 `compact_sent` 开始，还可能反过来挡住 10 分钟升级。把状态机钉死为 `compact_sent -> resolved_by_compact | clear_requested -> cleared_confirmed`，另有 `abandoned/fenced`；episode 至少绑定 project、Lead、session_id、lease generation、pane fingerprint/action id，并对每次 transition 做 CAS。cadence 用 `nextScanAt`/wall clock 表达，不依赖 tick 猜测；cooldown 只限制 terminal episode 之后的新 episode，绝不能限制本 episode 的 compact→clear 推进。timeout 升级必须由同一 session/generation 的 fresh capture 同时证明 ctx 仍高、当前可安全输入且不在 compacting；stale/unknown 只能等待。`send-keys` 成功不等于 `/clear` 被 Claude 接受，只有 Wave 1 SessionStart clear receipt 同时确认新 session-id、adopt 结果和 bootstrap 结果后才能记 `cleared_confirmed`。补 Bridge 重启、手工 clear、generation replacement、stale sidecar、send 成功但命令未接受、cooldown 不挡升级等负向测试。

5. **HIGH — Wave 2 的“消费者自动获得新 kind”与实际代码不符，且当前没有生产 producer。** `classifyLeadAlertPane` 目前只被 `AlertChannelHub` 用来 reconcile/关闭已有 thread（`AlertChannelHub.ts:789-800,979-980`）；搜索不到会调用它并创建 Lead-pane 告警的生产扫描器，因此只加 keyword 不会让撞墙状态产生告警。即使只为 Wave 3 分类，`AlertEventType` 来源数组、exhaustive `KIND_CONTRACTS`、`LEAD_KINDS`、ticket routing decision 和 copy 都需要显式注册，绝非自动接入。请二选一并写清：Wave 2 仅导出 classifier 给 Wave 3 使用，不宣称独立告警；或由 Wave 3 rider 在发现 wall 时通过现有 notifier 产生带 durable eventId 的 `context_limit` 事件，并完整注册 union/contract/owner+ARC/`LEAD_KINDS`/route/copy/echo guards。`model-cap.test.ts:32-39` 的 `parseModelCap(context-limit) == clear` 仍是正确的“不是模型额度封顶”负向契约，应该保留；另加 classifier 断言，不要用后者替换前者。继续保留真 429/usage cap/529 throttle/echo/`compacting conversation` 的优先级与防遮蔽测试。

6. **HIGH — statusline sidecar 是可删的复杂度，当前 key 推导还存在跨项目误操作风险。** `statusline-command.sh` 是每帧热路径，文件内已记录当前渲染比旧基线慢约 11%；每帧再 mkdir/tmp+mv 会为所有 Lead 增加持续 IO。更关键的是 workspace 路径只天然给出 lead id，计划的 project manifest 反查和“查不到只用 lead id”会让不同项目同名 Lead 共用文件；而 action-time 又没有 session/generation 绑定。最简单方案是删掉 4.1：rider 按实际 cadence 直接复用现有 private-socket capture 和已有 `ctx N%` 解析，一套证据同时服务阈值、idle 与 action-time fencing。若实测证明 sidecar 必须保留，必须使用 child 已有的 `FLYWHEEL_PROJECT_NAME`/`FLYWHEEL_LEAD_ID` canonical env（`claude-lead.sh:1823-1840`），禁止 cwd 猜测/fallback key；只在 pct/session 变化或有界间隔写一次，并在动作前要求 sidecar session_id 与 fresh pane/lease generation 一致。先提供 capture-only 的成本数据，再决定是否值得增加 producer。

7. **MEDIUM — Wave 4 应从核心安全交付拆出，且当前降级语义会吞告警。** `fleet-sensors.ts:307-347` 的 `maybePage` 当前只服务 `swap_pressure_high` 的 sustained/hold_failure 两个 eventId 家族；为 FLY-1716 增加新的 per-kind durable cooldown 不是“小项”，还会增加另一套状态。若 timestamp 在 delivery 未 durable handled 前写入，失败的第一条会把后续 30 分钟全部静默。`infra-event-router.ts:159-183` 的注释承诺路由失败回退 raw sink，但 `ticketSink.alert` 实际没有 catch；修复应在这里把原始 alert fail-safe 投递到 raw sink，并用非递归的既有 meta-alert/logger 做有界严重告警，而不是 catch 后只写日志并假装成功。建议本单 Wave 4 只保留生产 `FLYWHEEL_ALERT_ROUTING=1` 的有证据核验，把 flapping/catch 加固拆成后续单；若坚持并入，cooldown 只能在 `isDurablyHandled` 后提交、必须明确 exempt hold_failure，并验证 Bridge restart 后行为。合入顺序也改为：先独立完成并验收 Wave 1 CAS/receipt，再上 classifier+rider；Wave 2 若宣称可独立合入，就不能引用尚不存在的自动 remediation。V5 应断言 clear receipt、session write-back、恰好一次 adopt 以及 QUEUED 恢复流动，而不只看 send-keys 实录。

## Verdict

CHANGES REQUESTED — address items above
