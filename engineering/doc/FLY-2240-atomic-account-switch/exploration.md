# FLY-2240 原子切号与通用轮换 — 探索
Issue: FLY-2240 (https://linear.app/geoforge3d/issue/FLY-2240/切号器-统一-atomic-切号-flow手动自动同路必发通知-轮换改-generic可用号中选-reset-最早)
日期: 2026-09-01
基于: 无

## 1. Founder 直令与不可缩水的验收边界

本单把同一组件的两条 founder 直令合为一次收敛：

1. 切号成功与通知必须成为一个执行单元。daemon 阈值、Lead 手动、founder 手动只负责提供触发原因；不得各自实现切号或成功通知。
2. 每次需要自动选择下一账号时，从当刻全部候选中只保留「freshness 已验证且两个 quota window 均未耗尽」的账号，再按**本轮实测的 weekly reset 时间最早**选择；不得写死 `personal1 → business → personal` 等顺序。
3. stale、quota exhausted、无法验证的账号不能被选中。部分候选坏掉时，成功通知要带一行跳过摘要；全部候选坏掉时必须发既有 `quota_no_target` 告警，不能静默。
4. 不新增 daemon，不另建告警系统；复用 `account-heal`、现有 accounts lock、现有 `lead-alert.sh`/`sendQuotaMonitorAlert` 投递链。

## 2. 当前事实

### 2.1 手动与自动确实是两套执行路径

- 自动路径：`quota-monitor.ts::pollOnce` 先跑 `verifyAndRankCandidates`，再调用 `switch-executor.ts::switchAccount`；成功后由 `pollOnce` 自己组 `account_switched`/`account_switch_degraded` 并调用 `deps.alert`。
- 手动路径：`packages/claude-runner/bin/flywheel-claude-profile use <name>` 自己拿 accounts lock，执行 freshness/quota/identity guard、写 Keychain、改 `.active`、同步 store；它不调用 `switchAccount`，也不调用通知层。
- Bridge repair 路径又在 `account-switch-repair.ts` 里把成功变成 `notifySuccess`，由 `bridge/plugin.ts` 上层另发 digest。也就是说「切号成功」和「通知成功」当前在不止一个 caller 中拼装。

这正好解释 2026-09-01 12:47 PT 的现象：手工 `use personal1` 可以真实切号，但通知链没有任何机会被调用。

### 2.2 当前“排序”仍受固定配置与非 reset 规则影响

- `verifyAndRankCandidates` 只遍历 `quota-monitor.json.order`，所以 pool/store 里存在但未列入固定数组的账号根本不是候选。
- 候选分 `tier0`/`tier1`；低 5h headroom 的账号即使 weekly reset 更早，也会排在健康 tier 后面。现有测试明确锁了这一行为，与 founder 新直令冲突。
- weekly window 未打开时 `resetsAt=null` 被排序为 `-Infinity`，即排在所有已知 reset 之前。新直令强调 reset 时间比较且要求对旧/未知读数保守，因此无可比较时间不应胜过本轮已知的 reset。
- `selectNextAccount` 的 legacy fallback 会读 store 中的 `weeklyResetAt`；即使 `lastObservedAt` 已很旧，也可能据此排序。store 事实适合展示/兜底防护，不足以证明「准备切号当刻」的最佳候选。

### 2.3 已有安全边界必须保留

- `switchAccount` 已有 CAS（active + generation）、同一 accounts lock、lease heartbeat/fence、transition journal、Keychain read-back/rollback、freshness candidate loop、identity guard。
- bash `use` 是 Keychain 原语；自动 executor 通过 delegated lock 调它，避免父子拿同一锁死锁。
- `quota-monitor-state` 已有 durable alert outbox，但只覆盖 model-cap incident；普通账号切换和手动 `use` 没有同样的 durable 成功通知事实。
- `switchCooldownUntil` 是既有 hysteresis。Lead 已确认相关独立修复为 **FLY-2229**（cooldown 排除唯一可切目标 + no_target 静默停摆，backlog 未开工）。本单不改变 cooldown 的资格语义；selector 只须把 `cooldown` 与 `auth/quota/unverifiable` 排除原因结构化区分，保证 FLY-2229 可直接增加回退分支而无需重构。

## 3. 关键假设

1. “atomic”不能解释为 Discord 网络请求与 macOS Keychain 的跨系统 ACID 事务；两者没有共同事务管理器。可交付的严格语义是：**同一次 store 原子提交同时记录新 active/generation 与待投递成功通知**。因此任何已提交切号都必有 durable notification intent；即时投递失败或进程崩溃只会留下可重放 intent，不会丢通知。
2. `use <name>` 是显式选择，仍只验证该目标；“reset 最早”适用于需要系统选择“下一个”的入口（daemon、`next`、无显式目标的 repair）。显式 founder 指定不能被排序器改成别的账号。
3. 选号的 quota 资格必须来自同一轮 live usage API 结果。`lastObservedAt`/ledger 只用于展示与防止更晚事实被旧轮覆盖，不能让没有本轮成功观测的账号进入 verified ranking。
4. freshness helper 返回 stale、usage API 失败或 reset 缺失时均保守排除；不能以 degraded store fallback 绕过 founder 新定义的“能用”。

## 4. 三种方案

### 方案 A：只在 bash 手动路径补一条通知

在 `flywheel-claude-profile use` 成功后调用 `lead-alert.sh`。

- 优点：改动最少。
- 缺点：保留两套切号和两套通知；bash 与 daemon 文案/失败语义继续漂移；进程在 Keychain commit 后、通知前崩溃仍永久丢通知。直接违反 founder 的原子与同路要求。

结论：否决。

### 方案 B：caller 统一调用一个 wrapper，但成功后再直接发通知

新增 `executeAccountSwitch()`，里面先 `switchAccount()`，成功后 `sendQuotaMonitorAlert()`；daemon、manual、repair 都改用 wrapper。

- 优点：入口代码统一，容易测试；不改 store schema。
- 缺点：切号 commit 与通知之间仍有 crash gap；网络失败返回时账号已经切了，成功通知没有 durable 事实，仍不满足“只要切号成功就必发”。

结论：比现状好，但原子性不足。

### 方案 C（推荐）：同一 store commit 写入切号结果与 durable notification intent

把统一执行单元放在 `account-heal`：

1. `switchAccount` 的成功 commit 同时 append 一个有界、带 generation 签名的 `pendingSwitchNotifications` intent。
2. 新的统一 facade `executeAccountSwitch` 是所有业务入口唯一调用面：调用 mechanical switch，随后用既有 `sendQuotaMonitorAlert` 尝试 drain；确认 `sent`/`queued_transient` 后在 accounts lock 下 ack intent。失败则保留，由同一 quota monitor tick 的既有循环重试。
3. bash 公开 `use/next` 在非 delegated 模式转交新的 teamlead switch CLI；executor 内部再用受认证的 delegated env 调 bash `use` 原语，避免递归。
4. daemon/repair 删除自己的成功通知发送，改由 facade 负责；它们仍各自保留触发检测、状态恢复、pane revive 等 trigger-specific 后处理。
5. 抽出一个 live candidate verifier/ranker；候选集合取 pool ∩ store，排序只看本轮有效 weekly reset（最早优先，未知最后，名字仅作同 reset 的稳定 tie-break），不再按固定数组或 5h headroom 分 tier。

- 优点：切号与“必有通知”形成单文件原子 durable commit；所有入口同执行单元；复用现有 daemon/投递；可用纯函数和 crash/replay 测试证明。
- 代价：需要小幅 store schema 扩展、CLI 递归 guard、多个旧 caller 迁移；必须给 outbox 设上限并在满时于任何 credential mutation 前 fail closed。

结论：采用。

## 5. 锁定的范围与非目标

- 做：Claude machine account；手动 `use/next`、quota daemon、Bridge account-switch repair 同一执行 facade；普通账号和 model-cap 的成功通知不得漏。
- 做：live freshness + live quota 的 generic rank；stale/exhausted/unknown 排除；部分跳过摘要、全灭告警。
- 保留：accounts lock、journal、Keychain rollback、identity/freshness/quota guard、generation CAS、现有通知频道和 alert transport。
- 不做：Codex per-runner auth rotation；新 daemon；新 Discord bot/channel；FLY-2229 的 cooldown 唯一候选回退/静默告警修复；自动重登 stale 账号；修改 `CLAUDE.md`。

## 6. 探索结论

本单不是“给手动命令补通知”，而是把业务切号的提交点变成唯一事实源：任何 trigger 最终都只能得到同一种 committed switch，其中 notification intent 与 generation 一起落盘。generic 选号也必须从同一轮 live 事实出发，旧 store/ledger 只做保守防护，不再决定谁“最早 reset”。
