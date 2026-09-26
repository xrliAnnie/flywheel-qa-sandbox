# FLY-2869 Codex 额度读数停更与切号通知 — 调研
Issue: FLY-2869 (https://linear.app/geoforge3d/issue/FLY-2869/codex-额度切号-额度读数停更-6-小时-号已重置却不自动切手动切号不发-notifications-通知founder-2026-09)
日期: 2026-09-24
基于: exploration.md

## 1. 范围裁定（Lead，2026-09-25）

- 做 A–D（见 exploration §4）。A 只刷 Codex；推翻 FLY-2688「不加定时器」由 Lead 负责。
- readiness `authority_unavailable` 的 6 个卡点**不进本 PR**；「readiness 正常时 A 打满 → 自动切 + 通知」用 fixture（availability 自动）证明，报告写明生产 readiness 恒为 `authority_unavailable`、自动切号在生产从未生效。
- 不建单、不清理宿主残留（test-slot 符号链接、归档目录、keep_alive 残留都不动）；不在生产真切号；不碰 business 号。

## 2. 代码接缝

| 关注点 | 位置 | 现状 | 本单改动 |
|---|---|---|---|
| Codex 读数写入 | `bridge/account-quota-refresh.ts` `createAccountQuotaRefresh` | Codex 与 Claude 两支同一个 single-flight，只被路由调用 | 拆出 `createCodexAccountQuotaRefresh`（Codex 支独立 single-flight）；全量刷新复用它，定时器也复用它，二者不会并发跑两轮 Codex 读 |
| 定时刷新 | 无 | — | 新 `codex-quota/reading-scheduler.ts`：纯逻辑 + 注入时钟；挂在 GatePoller `onLandOperationTick`（每 3 秒一次、fire-and-forget）里，未到期时零 I/O |
| 读数新鲜度 | 无 | capacity 借用 Claude 120 分钟阈值，只加标记 | `claude-runner/bin/codex-account-core.mjs` 新增纯函数 `codexReadingFreshness` + `CODEX_READING_STALE_AFTER_MS=30min`；teamlead 与 `codex-profile` 共用（codex-guard 安装器本来就拷这个文件） |
| capacity 投影 | `bridge/capacity-snapshot.ts` `projectCodexAccount` | stale 照样给百分比、照样判打满/恢复时刻 | 非新鲜时：百分比置空、过去的 reset 置空、`exhausted=false`、`recoveryAt=null`、tokenState 改成「读数过期」/「已过重置待探」；新增 `freshness` 字段；Codex `staleAfterMinutes=30` |
| tick 文本 | `bridge/account-quota-view.ts` `tickQuotaBlock` | 头部只有「· 打满」 | 非新鲜的 Codex 号头部追加「· 读数过期」/「· 已过重置待探」，数值列经既有 `missingCell` 渲染成 `n/a` |
| `codex-profile list` | `claude-runner/bin/flywheel-codex-profile.mjs` `tokenStatus` | 不看观测时间 | 用同一个 freshness 函数；非新鲜不判「打满」 |
| 候选选择 | `codex-quota/candidate-selector.ts` | 任何 `resetsAt<=now` 的窗口 → 观测无效 → 既不选也不判耗尽 | 「100% 且所有 100% 窗口都已过重置」= `reset_elapsed`：不算 limited、可作候选（排在已知有额度的号之后、scope 未知的号之前）；非 100% 窗口的过去 reset 仍视为无效（不放宽） |
| 真探 | `codex-quota/runtime.ts` `rotate` → `probe.ts` `probeCodexCandidate` | 安装前在隔离 `CODEX_HOME` 跑 `codex exec --json --sandbox read-only … "Reply exactly ok."` | 不改真探本身；`reset_elapsed` 候选的通知快照 `to.windows=[]`（真实用量未知，渲染 n/a，不把过时的 100% 写进「新账号」） |
| 手动切号检测 | `codex-quota/runtime.ts` `credential()` → `bridge/codex-quota-store.ts` `reconcileExternalRoot` | 只插 `codex_quota_external_generation` + 改 root | 同一事务 enqueue `switch_notification`（`incident_id=NULL`、eventId `codex:<root>:<gen>:manual_switch`、payload `reason=manual_switch`+快照） |
| 通知渲染 | `codex-quota/switch-notification.ts`、`codex-quota/outbox.ts` | 只认自动切号；快照必须对得上 install material | 格式器加 `trigger`：自动「（quota:weekly）」、手动「（手动）」；outbox 为手动行单独分支，快照对 `codex_quota_external_generation` 行核验 |
| 停更告警 | `codex-quota/outbox.ts` + `LeadAlertNotifier` | 无 | 新 outbox kind `reading_stale` → 新 informational、plain 告警类型 `codex_quota_reading_stale`（登记点见 §4） |

## 3. 关键事实与约束

1. **coordinator 不读 `codex-accounts.json`**，每轮现场读、60 秒内才算新鲜（`candidate-selector.ts` `fresh()`）。所以「读数过期」只影响人（Lead/founder）看的面；自动路径上对应的是「现场读数 100% 但 reset 已过」。回归按这个映射构造。
2. 容量守卫（`hasCurrentCapacityGuard`）也调用同一个 selector 回放已存证据。现有测试（`StateStore.codex-quota.test.ts` 「binds capacity facts…」`now+55_000` 与「…after its reset window elapsed」）期望 reset 已过即解除守卫；新语义下结果相同（从 `observation_unavailable` 变成 `selected`，`kind !== "pool_exhausted"` 不变）。
3. `recordPoolExhausted` 在写入前断言 selector 判 `pool_exhausted`；它只在所有 reset 都在未来时被调用，不受影响。
4. 手动切号的 profile 可能不是池内 slot（`isCodexIdentityLabel` 而非 `isCodexSlotName`），手动快照的 `to` 需按 identity label 校验。
5. `reconcileExternalRoot` 在「identity 未变」时早退、在有 `installing` incident 时抛错；只有真正落了新 generation 才 enqueue，天然 exactly-once（同事务 + 主键 eventId + `INSERT OR IGNORE`）。
6. 自动切号自己的安装走 `commitGeneration` 先改 root，所以 `credential()` 不会把自动切号误判成手动。
7. 定时读与 coordinator/`codex-profile use` 共享 per-account lease：读的瞬间撞上时，coordinator 该号本轮记为不可读（既有「lease owned by another reader」路径），60 秒后重试；`use` 撞上会报 lease 忙，重试即可。这是既有语义，本单不改。
8. 读数失败的 slot 保留上一次读数（`carried`）且 `observedAt` 不变 —— 新鲜度判定天然会把它标成过期，不需要额外处理。
9. 生产现在 `codex_quota_auto_switch=true` 所以 runtime 存在。现状下 observer 的在用判定和手动切号检测都挂在 runtime 上，旗标关则 runtime 不构造、A 与 D 同时失效（Codex 设计评审 R1 #1 指出）。plan §1.5 把两者的只读部分抽出，使 A、D 不依赖旗标、readiness 与 apiToken。
10. readiness 与定时读互不依赖：readiness 恒 manual 的今天，定时读照样工作（15:48 那轮就是在同样的 readiness 下读成功的）。

## 4. 新告警类型的登记点

`codex_quota_automation_disabled` 当初落点即模板：

- `LeadAlertNotifier.ts`：`ALERT_EVENT_TYPES`、`INFORMATIONAL_KINDS`、`PLAIN_DELIVERY_KINDS`
- `bridge/kind-contract.ts`：`KIND_CONTRACTS`（owner `claude`、`human_by_design`，与同族一致）
- `bridge/alert-kind-copy.ts`：标题、说明两处 switch
- `bridge/summary-activity-probe.ts`：同族列表
- `scripts/lead-alert.sh`：`INFORMATIONAL_KINDS` 镜像（只做镜像，不新增 shell 发送口）
- 测试：`kind-contract.test.ts` 的 informational 清单

## 5. 测试接缝（先红后绿）

| 切片 | 测试文件 | 断言 |
|---|---|---|
| freshness 纯函数 | 新 `packages/claude-runner/test/codex-reading-freshness.test.ts` + 共享向量 `scripts/__tests__/fixtures/codex-reading-freshness-vectors.json` | 四态判定、边界（恰好 30 分钟、reset 恰好等于 now）、非法时间 |
| capacity/tick | `capacity-snapshot.test.ts`、`account-quota-view.test.ts` | 35 分钟前的 100% → 不打满、百分比 n/a、「读数过期」；reset 已过 → 「已过重置待探」；10 分钟前 → 行为不变 |
| `codex-profile list` | `packages/claude-runner/test/codex-shim.test.ts` | 同上三态；既有用例改为相对 `Date.now()` 的时间 |
| selector | `codex-quota-candidates.test.ts` | 唯一可用的是 reset 已过号 → selected；已知有额度的号优先；非 100% 窗口的过去 reset 仍无效；全部 100% 且未来 reset → 仍 `pool_exhausted` |
| rotate 快照 | `codex-quota/__tests__/runtime.test.ts` | reset 已过候选的 `to.windows=[]` |
| 手动切号 | `StateStore.codex-quota.test.ts`、`runtime.test.ts`（真 `flywheel-codex-profile.mjs use`）、`codex-quota-outbox.test.ts`、`switch-notification.test.ts` | 恰好一行 outbox、同形正文且抬头「（手动）」、重复 `credential()` 不重复、身份未变不发 |
| 定时器 | 新 `codex-quota/__tests__/reading-scheduler.test.ts` | 首 tick 立即刷、15 分钟节奏、reset 后 1 分钟补刷、single-flight、失败记录、停更 >30 分钟只告警一次、恢复后新一段再告一次 |
| 刷新拆分 | `account-quota-refresh.test.ts` | 定时与按需并发只跑一轮 Codex 读；订阅失败仍只是 warning |
| 停更告警投递 | `codex-quota-outbox.test.ts`、`kind-contract.test.ts` | 正文、plain、informational；失败原因只放白名单 code |
| 整链回归 | `codex-quota-bench.test.ts` + `scripts/fixtures/codex-quota/protocol-cli.cjs` 新场景 `reset_elapsed` | business 打满、school 现场读数 100% 但 reset 已过、personal 100% 未来 reset → 真 `exec` 探 school → canonical 变 school → outbox 投递「Codex 已切号：**business → school**（quota:weekly）」；阴性对照在 plan 里写明怎么做 |

## 6. 风险

- 定时读每 15 分钟对非在用号各起一次隔离 app-server（≤45 秒/轮）。token 只在过期时轮换，与按需刷新同一路径，风险等同于每 15 分钟有人点一次账号页。节奏是常量，可调。
- 修改 selector 属于安全路径：放宽仅限「100% 且所有 100% 窗口都已过 reset」这一种形状，且安装前仍必须真 `exec` 探活成功；探活失败走既有 `probe_failed`。
- 手动切号通知的读数来自定时读缓存：30 分钟内的才用，否则整格 n/a，不编造。

## 7. 范围扩大后的补充调研（readiness，2026-09-25）

founder 2026-09-24 23:20 PDT 直令把原 FLY-2872（readiness 卡点）并入本单同一个 PR（Lead 指令 35fc4a10）。设计期只读核实的事实：

1. `phase_keep_alive=1` 表示「有常驻 Codex phase-hold 消费者」；CommDB 自己判活消费者要求 `status='running' AND phase_keep_alive=1`（`runnerDoorbellConsumerIsLive`）。parked 持有者的 CommDB 行可能已是终态，`activateSessionForWake` 会原地复活成 running 且**不重写** keep_alive —— 所以「进入终态即清零」会打断 parked 体的唤醒（Lead Q2 裁定源头不改）。
2. 生产 `flywheel` 分片 vendor 为空的 5 行 + `fly-1328-wiring` 1 行，`tmux_window` 全是 `…:pending`（预登记占位，runner 从未自登记）。
3. 当前 `status=running` 的 Codex 行：FLY-2519/2608/2619（9-15/16 起）、FLY-2766（9-23）、FLY-2873（当前在跑，进程带 `FLYWHEEL_EXEC_ID` 且 `agents/flywheel/implement/.flywheel-leases` 里有它的 lease）。
4. `ps eww` 整行正则的误判来源（只看变量名）：`XDG_CACHE_HOME`、`FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD`、`SCRUBCMD`、`QA_SLOT` 等环境变量值，以及 Claude/node 参数里的 `codex` 词。
5. macOS `ps -o ucomm=` 是内核 `p_comm`（取自被 exec 的文件名，≤16 字符）：Claude runner 为 `2.1.282`，`exec -a <ChatGPT codex 路径> sleep` 仍为 `sleep`；全机一次 26ms。`ps -o comm=` 是 argv0 口径，不可用于身份判定。
6. 桌面版：`/Applications/ChatGPT.app/Contents/Resources/codex`，`codesign -dv` → `Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)`；`codesign --verify` 2.3s；`lsof -a -p <pid> -d txt -Fn` 取内核可执行路径 44ms。
7. 529 slot-1 的 `auth.json` 是指向生产 `~/.codex/auth.json` 的符号链接（会跟随切号）；slot 的 Codex 进程 `CODEX_HOME` 在 `/tmp/flywheel-test-slot-*/…`（realpath `/private/tmp/…`）。
8. FLY-2729（切号后目标 home 的 daemon 不重载 token）状态 Backlog；FLY-2523 提交 236d7eb85 把生产 activation 挂在「已部署的 FLY-2729 恢复证据」上。但运行时代码里**没有**独立的 activation 闸（`activation.authorized=false` 只在 `scripts/codex-quota-readiness-check.mjs` 的证据输出里），`codex_quota_auto_switch` 是 kill_switch、default_on —— 修通 readiness 即等于启用。
