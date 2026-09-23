# FLY-2701 语音按需启动 — 调研
Issue: FLY-2701 (https://linear.app/geoforge3d/issue/FLY-2701/语音按需启动-语音进程平时不常驻开耳机模式-会议到点时才由系统启动空闲后自行退出founder-2026-09-17)
日期: 2026-09-17
基于: plan.md

R1 gate 7edeef52-f88f-4488-8f30-a28e045a38db，request 94c7d167-cb8c-4c69-9ce5-716c9b719c7f，有效CHANGES_REQUESTED。原始结构化结果保留review-r1.json。没有采用overrule。

| findingKey | 处置与最终位置 |
|---|---|
| restart-storm-gate-brakes-on-demand-launches | 接受；§6撤除voice按需路径上的旧常驻boot计数，保留其它service及显式停用；同需求有限失败预算，§10要求6次正常启动及3次失败对照 |
| launchd-throttle-interval-unaddressed | 接受；§6显式ThrottleInterval=1和installer断言；§10测短命退出后多个间隔的真实spawn延迟，不用accepted代替spawn |
| drain-fence-lease-cannot-survive-bridge-stop | 接受；§8 stop前commit持久fence，无自动expiry；跨Bridge停机/新启动/voice刷新持续封门，崩溃需要有证据接管 |
| prewarm-budget-collides-with-60s-ready-alert | 接受；§2预约在T未ready告迟到，明确故障即时告警、正常持续准备不按60秒错报 |
| manifest-setup-policy-has-no-byte-drift-check | 接受；§8新增voice专用contract check共用于setup/census/installer/waker |
| startup-refusal-alerts-on-benign-exit-race | 接受；§6健康旧owner锁冲突留证，2693统一故障源；meta-alert只作源不可用fallback |
| verification-command-list-omits-impacted-suites | 接受；§9完整补converge、host-tmux、storm、新restart-voice suite及CI枚举 |
| no-human-reason-whitelist-not-named | 接受；§7点名allowed-map、ended白名单、live额外reason限制和VoiceEnd |

修订后需新gate/request-review；本处“接受”只是作者处置，不是评审批准。

## R2：有效APPROVED，非阻塞Follow-ups

Gate `72ea5043-232e-4070-9ef8-ce8dbb8de89b`，request `2d36d872-a509-46a3-a1cc-962c5ca9433e`，reviewVerdict与reviewerVerdict均APPROVED；原始结果见review-r2.json。没有HIGH阻塞项。以下保留为Lead可安排的施工细化/后续事项，不能标成已经修复；本轮不重新开设计评审。

| findingKey | 后续事项 |
|---|---|
| verification-command-list-omits-impacted-suites | 将CI已枚举的qa-fly1501-brake-missing-alert.test.sh纳入受影响套件；voice专用断言随按需合同调整，其余服务保持 |
| brake-removal-not-gated-on-verified-on-demand-contract | 将撤除旧storm gate与已验证loaded按需plist绑定，明确新wrapper+旧plist迁移混合窗口的保护与回归 |
| spawn-budget-only-counts-observed-boots | 明确无startup观测时的accepted kickstart次数上限，防止预算只计已证实失败而漏算早期exit0 |
| prewarm-lead-ms-hardcoded-120s-in-schema-and-api | 字段/API公式统一引用冻结prewarmLeadMs；presence=T+120秒仍为独立常量 |
| lock-conflict-owner-evidence-unspecified | 明确健康owner证据来源；当前ProcessLifetimeFileLock conflict不返回owner元数据，不能假定已有此能力 |

已按runner合同将上述建议报给Lead；由Lead选择合入实施范围或后继安排。设计通过与剩余建议同留，不删除评审历史。

## 代码评审 R1（Codex，legacy 通道，effort=xhigh）：CHANGES REQUESTED → 9/9 已修

Review `5285486483` on PR #1282，评审头 `81fea8f00`，thread `01a0cb8b-320c-7090-8984-03fded7c5256`。
逐条对照代码与已批准 plan 后，**9 条全部成立**，无一反驳，全部修复：

| findingKey | 严重度 | 处置 |
|---|---|---|
| 双入口去重缺失 | HIGH | plan §5「同一会议双入口去重」明文要求未实现。`createVoiceSchedule` 增查非终态 `voice_sessions`；新增 `voiceScheduleGuardTx` 供 `reserveVoiceSession` / `reserveVoiceSessionIntent` 同事务复用；两个即时入口与 POST 路由都返回 `voice_schedule_binding_conflict` 并带上已有行。两个到达顺序各有测试。 |
| reserve/link 非原子 | HIGH | 新增 `reserveVoiceScheduleSession`，schedule 重读 + reserve + link 单事务提交；revision 中途变动时零写入。崩溃窗口孤儿 session 的阴性对照已加。 |
| presence/live TOCTOU | HIGH | `markLive()` 在开媒体前重查当前 presence，窗口内离场即 `ended/she-left`。两条阴性对照（她留下 / 即时会话）同时守住不回归。 |
| launchctl 超时算已证实失败 | MEDIUM | `wake` catch 复用 `probeTimedOut`，超时映射 `unknown`，不消耗预算。 |
| 正常 no_human 持久化成 failed | MEDIUM | plan §7 明文禁止。allowed-map 加 `warming→ended`，ended reason 白名单加 `no_human`，并限定只能由 `warming` 使用（已 live 不得声称无人）；daemon 改发 `ended/no_human`；`VoiceEnd` 类型同步。 |
| 启动串行 | MEDIUM | plan §7 / 切片 D。共享 AbortController 并行启动，120 秒总 deadline，先失败 fence 另一支并在其迟到落地时 stop；deadline 之后仍观察 settlement。 |
| 调度 lane 被单次 provision 冻结 | MEDIUM | tick 先原子认领全部 due，再按 session 独立 bounded single-flight provision；lane 不等外网。 |
| 收据重放晚于时变校验 | MEDIUM | key+digest 改由调用方原始请求规范化得出，重放查询前置于 horizon 校验与 `resolveBinding`；POST/PATCH 均改。T 之后重试、registry 不可用时都能拿回原收据。 |
| legacy plist 只核四字段 | MEDIUM | 改为与唯一存在过的常驻契约做完整规范化字典比对（含 wrapper 路径），要求自有非 symlink 普通文件，并在 bootout 前用 `launchctl print` 证明 loaded job 身份。三类 legacy-shaped drift 各有阴性对照。 |

本节记录作者处置，不代表评审通过；R2 结果另记。

## 代码评审 R2（Codex，同一 thread）：CHANGES REQUESTED → 5/5 已修

Review `5285790862`，评审头 `c4b07f31f`。R1 的 9 条经复核确认落地；R2 新开 5 条（2 HIGH + 3 MEDIUM），
全部成立，全部修复。R2 同时确认该头**精确头 CI 16/16 全绿**。

| findingKey | 严重度 | 处置 |
|---|---|---|
| 并行启动清理依赖双分支 settle | HIGH | 反例成立：room 已落地、frontend 永不 settle 时 `Promise.all` 永不 resolve，已进房的 bot 永久遗留。改为**按分支独立清理**——任一分支落入已放弃的启动就立刻自还，不等另一支。真实分支也接上 signal：`DiscordVoiceRoom` 在既有 `checkActive` 各检查点（含 `join()` 之后那个）响应 abort；`RealtimeFrontend` abort 时直接判连接失败，不再干等自身 30 秒超时。plan §7 的 120s 含 preflight，故 `cli.ts` 在身份预检**之前**起算并把绝对截止时刻传下去。 |
| presence 快照回滚更新事件 | HIGH | room 先订阅 presence 再读频道，故其间到达的事件严格新于快照；并行化把这个窗口拉长到另一分支的全部耗时。新增 `presenceObserved`，仅在无更新事件时才应用快照。leave / join 两个方向各有测试。 |
| `warming→ended/no_human` 未等绝对 deadline | MEDIUM | StateStore 增加 `input.now >= presenceDeadlineAt` 边界；deadline 前拒绝、到点接受各有断言。持 lease 的旧 daemon 不能提前宣告无人。 |
| `schedule_bound` 被当成 409 | MEDIUM | plan §5 要求同绑定返回已有 `scheduleId/sessionId/state`，只有绑定不一致才 409。HTTP 路由改 200 + 身份；Lead capability 改 `succeeded` + data 带上预约标识，冲突时也带 scheduleId。两条入口各两个测试。 |
| reaper 与正常缺席终结竞态 | MEDIUM | deadline 之后仍在续租的 session 说明有健康 daemon 正要给出真实结论，reaper 不再抢先写 `failed/presence_deadline_passed`；确需 reap 时在同一事务 `stopVoiceSessionTx` 撤销启动意图。健康 / 租约失效两条路径各有测试。 |

## 代码评审 R3（Codex，同一 thread）：CHANGES REQUESTED → 4/4 已修

Review `5285956994`，评审头 `e0232b524`。R3 确认 `abandon` 的原子顺序与 deadline gate 无洞，
另开 4 条（1 HIGH + 3 MEDIUM），全部成立、全部修复。⚠️ 其中 HIGH 那条是**本分支 R2 自己引入的回归**。

| findingKey | 严重度 | 处置 |
|---|---|---|
| 去重后的 start 到不了真实 Lead | HIGH（R2 引入的回归） | R2 把 Lead 侧 `schedule_bound` 改成 `succeeded`，但只在 router 单测里成立：生产 `bridge-voice.ts` 强制要求恰好一个 `voice-session:` resourceRef 并按旧 start schema 解析，真实 Lead 拿到的是 scope denial。现已把 schedule 结果做成端到端合同 —— catalog result union、replySchema、`voice-schedule:` resourceRef、handler 分支；测试**穿过生产 `createBridgeVoiceHandlers`**，不再绕过它。另外同一 guard 命中时在写 `voice_intents` 之前就返回，导致 receipt 路由只能答 unknown，且首答丢失后在预约终态时重试会真的开第二个 session（违反 plan §5「已终态预约不得被旧请求复活」）。现在 guard 命中会在**同一事务**写下带 `schedule_id` 的 intent 收据，永远重放同一答案；receipt 路由也据此作答。 |
| Discord 启动直到调用返回才看 abort | MEDIUM | join 内部最多等 Ready 15 秒，期间另一分支失败时已登录的 client 与 VAD 一直挂着。改为 abort 立刻拆除已存在的一切；并且**首个 failure 直接结束调用方的等待**（各分支落地时已能自还，无需再等对方）。 |
| `start()` 返回被事件超越的旧快照 | MEDIUM | 内部值保住了较新事件，返回值没有；而即时路径正是用返回值向 Bridge 提交 live —— 会为一个没人的通话写下 durable live 状态，进程在该窗口崩溃则永久。改为返回当前值。 |
| reaper 等待无上限 | MEDIUM | R2 让 reaper 等待仍在续租的 daemon，但 lease 只证明 owner 活着、不证明有进展（renew 走独立 timer）。现加有界 reporting window（deadline 后 300 秒），超出即便 lease 仍活也收敛并撤销 session。 |

## 代码评审 R4（Codex，同一 thread）：CHANGES REQUESTED → 3/3 已修

Review `5286164141`，评审头 `8ad1acad4`。3 条，Codex 全部标为 landing blocker（非 follow-up）。
Lead 裁定（question `4c9045bb`）：A、B 都修，然后放行一轮**只核这三处**的 R5（fresh thread，high）。

| findingKey | 严重度 | 处置 |
|---|---|---|
| fail-fast 泄漏 unhandled rejection | LOW（但 fail build） | **本轮自己引入**：fail-fast 让 `start()` 在测试挂 handler 前就 reject，Node 报 unhandled、vitest exit 1，本地与精确头 `Unit (light)` 同红。修法：fail-fast 闸门改成 **resolve** 而非 reject（错误仍只从 `failure` 抛一次），并让该测试在创建 promise 的同刻挂上 `rejects` 断言。⚠️ 漏检原因：此前只 grep 测试计数、未看 exit code —— 检查方法已改正。 |
| 冲突的 scheduleId 端到端被丢 | MEDIUM | R3 只贯通了成功的 `schedule_bound`。handler 拒绝分支只回 status/errorCode，broker 又把未识别错误码归一成 `provider_rejected` + 空 resourceRefs。现改为：**身份走 resourceRef**（`data` 在 broker 拒绝路径上不存活），broker 仅对**受信命名错误码**保留 rejection 的 ref 并按同一规则校验。测试**穿过真实 `LeadCapabilityBroker`**。 |
| join 内部 partial connection 收不回 | MEDIUM | `joinVoiceChannel()` 先建连接、再等最多 15 秒 `entersState()`；任何非成功路径都不返回 handle，上游无从回收，room 的 abort 清理也够不到（连接尚未赋给 room）。现把 join body 抽成可测 seam `joinVoiceConnection`：任何失败都 `destroy()` 已建连接，已 abort 则根本不建；signal 由 room 经 `BotRegistry.join` 传入。四条测试含「建连后 entersState 拒绝」这条真实反例与正常成功对照。 |
