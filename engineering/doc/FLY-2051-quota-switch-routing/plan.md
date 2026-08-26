# FLY-2051 Claude 切号通知按 kind 改道 — 实施计划
Issue: FLY-2051 (https://linear.app/geoforge3d/issue/FLY-2051/quota-monitor路由-claude-切号通知改发-flywheel-notification切号家族-per-kind)
日期: 2026-08-25
基于: research.md

## Goal

让 quota-monitor 的 `account_switched`、`account_switch_degraded`、
`quota_switch_confirmation` 在首次投递与 transient 重投时都落
`FLYWHEEL_NOTIFY_CHANNEL`，绝不落 global unified alerts；其他 kind 保持现有路由。保留 account
switch 的 founder mention 与完整 body，代码不含生产 channel id。

## 非目标

- 不修改 live `.env`、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 或生产 bot token。
- 不改变非 switch-family kind 的 primary/severe/mention/ticket 行为。
- 不投 restart ticket，不运行 `restart-services.sh` / `setup-quota-monitor.sh`。
- 不把 `quota_switch_confirmation` 的既有 non-mention policy 扩成新产品行为；本单把“保留 mention”
  解释为保持各 kind 现状，若需 confirmation 也 ping 可独立改一个 policy boolean。

## 已过 preflight

2026-08-25T21:05:05Z 使用 alert dispatcher 当前 token identity 与 Discord 只读 API 计算目标
channel effective permissions：bot=`1524831623164596265`、guild=`1485787271192907816`、
channel=`1521630422918758472`、effective bitfield=`2248473465835073`，其中 View bit=`1024`、
Send bit=`2048`，结果均为 true。未发消息、未打印 token。可重跑命令：

```bash
bash -lc 'set -euo pipefail; set -a; source ~/.flywheel/.env; set +a; \
  token_name="${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:?missing sender token selector}"; \
  DISCORD_PROBE_TOKEN="${!token_name:?missing selected sender token}" \
  node engineering/doc/FLY-2051-quota-switch-routing/permission-probe.mjs'
```

实现后的真实 POST 仍作为 acceptance gate，避免把静态 permission 当作终点送达证明。

## 设计

### 0. Founder 文案反馈增补（2026-08-25）

首轮真实 Discord 验收证明了 per-kind 落点，但 founder 明确拒绝 alert box 与 raw `from5h=...` 字段串，并选定 A 分行版。增补要求：两边账号名下显示 email；5h/7d 均显示用量与 founder-local 准确 reset；从 usage payload 自描述 `limits[].scope.model.display_name === "Fable"` 读取 Fable quota。Founder 终裁进一步删除全部 pane revive 状态，正文只保留切号事实、原账号表和新账号表。

实现沿用可靠的 shell + durable queue 链路，增加仅限切号家族 primary 的 `--plain-message` / `deliveryStyle:"plain"`。plain replay 成功后不交给 `AlertChannelHub`，避免重新附加 alert thread；`account_switch_degraded` 的独立 severe secondary 仍保持原告警形态。其他 kind 不可使用 plain style。

### 1. Per-kind primary channel policy

`RoutingPolicy` 增加 `primaryChannel?: "notify"`，仅三个 target kind 设置。解析规则：

- default kind：primary env 仍是 `undefined`，child 原样继承 global unified；
- notify kind：trim `FLYWHEEL_NOTIFY_CHANNEL`，把它投影为 child 的
  `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`；
- notify 值异常缺失时返回 `{ primary: "config_error" }` 且不 spawn。该分支是防御；生产 daemon
  已由 wrapper startup invariant 阻止进入此状态。

title/body/signature/strict-delivery args 不变，mention 仍按
`FLYWHEEL_QUOTA_ALERT_MENTION_USER` → `FLYWHEEL_FOUNDER_USER_ID` 解析。

### 2. Daemon startup invariant + fail-loud

`flywheel-quota-monitor-wrapper.sh` source shared `.env` 并建立 `fail_loud` 后，检查 trimmed
`FLYWHEEL_NOTIFY_CHANNEL`。缺失/blank：

1. 用既有 shell emitter 发 `quota_monitor_down`，title 指明 notification route misconfigured；
2. signature 按日去重；
3. exit 1，不 exec monitor。

这样 direct switched/degraded kind 不依赖不存在的 outbox，也不会静默丢。正常配置只多一次字符串
检查，其他启动行为不变。该早退发生在 RUN_MARKER 前，不计 crash-streak/restart-storm；这是有意
接受的配置故障语义：launchd `ThrottleInterval=30` 每 30 秒重试，daily signature 令 Discord/claims
只记一条，不形成消息 storm。它与既有 missing-dist 非零早退同类；配置修复后下一轮自行恢复。

### 3. Transient target persistence

`lead-alert.sh` 增加 `is_quota_switch_kind` helper。`write_record` 仅对三个 target kind 写可选
`deliveryChannelId: CHANNEL_ID`；其他 kind 的 JSON shape 不变。

`LeadAlertNotifier.drainQueue` 把 parsed type 扩为可选 target：

- absent → 既有 unified drain；
- strict 17–20 digit snowflake → 作为 actual drain channel；
- present but invalid → `invalid-delivery-channel` dead-letter，不 POST。

发送仍走既有 `postAlertWithSendChain`，因此 sender gating/rate limiting/delivery receipt 不分叉。
drain result 的 `channelId` 写 actual target，供 Hub 获得真实落点。

### 4. Severe secondary never leaks to alerts

对 notify policy，secondary 在下列任一条件成立时跳过：

- severe channel 未设；
- severe channel 等于 actual primary notification；
- severe channel 等于 global unified alerts。

若 severe 是第三个独立 channel，保留既有 `-core` signature 双投。非 notify kind 保持原比较逻辑。

### 5. Preserve degraded severe secondary lifecycle

`account_switch_degraded` 的 notification primary 使用 founder 选定的普通消息；若配置了独立 severe
secondary，该 secondary 保持 severe + manual ticket，不加入 `INFORMATIONAL_KINDS`，也不改
`AlertChannelHub.QUOTA_MONITOR_MANUAL_TICKET_KINDS`。这样 founder 的日常切号流可读，现有第三通道治理不丢失。

### 6. Truth registry

只更新 `FLYWHEEL_NOTIFY_CHANNEL` 描述：同时服务 restart notifications 与 FLY-2051 quota
switch-family notices。变量名和值不变。

## TDD vertical slices

所有 test env 的 `beforeEach` / `afterEach` 显式删除 `FLYWHEEL_NOTIFY_CHANNEL`；每个 case 自己设值，
不继承 founder shell ambient env。

### Slice A — TS primary routing（RED → GREEN）

在 `quota-monitor-alert.test.ts` 先加 `account_switched` acceptance literal：

- unified=`alerts-channel`，notify=`notification-channel`，founder id 已设；
- body 固定含 `shopping->school`、`from5h=91`、`from7d=74`、`to5h=12`、`to7d=8`；
- 观察 child actual unified 是 notification；args 带 founder mention；body 逐字相等。

未改生产代码单跑并保留 RED。最小 GREEN 后，表驱动补齐 family，再加 `quota_no_target` 阴性对照
仍继承 alerts；notify missing 返回 config_error/no spawn。

### Slice B — Severe guards（RED → GREEN）

先写 degraded 的三格：

- primary notify + independent severe → 两次；
- severe=notify → 一次；
- severe=global alerts → 一次，禁止回 alerts。

再改最小条件分支。

### Slice C — Shell queue metadata（RED → GREEN）

在 shell alert harness 使用 fake curl 503：

- target family queue JSON 含 numeric `deliveryChannelId`；
- `quota_no_target` queue JSON 不含该 key；

先看 target metadata RED，再修改 `lead-alert.sh`。

### Slice D — Bridge drain target（RED → GREEN）

在 `LeadAlertNotifier.test.ts` 写 queue fixture：合法 target 观察 fetch URL 使用 notification channel；
invalid target 观察 0 POST + dead-letter。最小改 drain selection 与 validation。

### Slice E — Wrapper startup invariant（RED → GREEN）

扩 `scripts/__tests__/quota-monitor-wrapper.test.sh`：configured notify 继续 exec fake monitor；缺失 notify
发 strict `quota_monitor_down` 且 monitor log 不出现。再加 wrapper check。

### Slice F — Existing lifecycle / E2E

保留 kind-contract 与 degraded ticket assertions 不变；在 `qa-fly-1256-quota-daemon-e2e.sh` 显式
export scratch notify channel，跑 account + model modes，观察 `account_switched` /
`quota_switch_confirmation` 继续抵达 scratch sink。

## 文件修改

| 文件 | 变更 |
| --- | --- |
| `packages/teamlead/src/account-heal/quota-monitor-alert.ts` | target primary env + severe leak guards |
| `packages/teamlead/src/__tests__/quota-monitor-alert.test.ts` | acceptance、family、negative、missing、severe tests + env hygiene |
| `scripts/flywheel-quota-monitor-wrapper.sh` | notify startup invariant + fail-loud |
| `scripts/__tests__/quota-monitor-wrapper.test.sh` | configured/missing wrapper cases |
| `scripts/lead-alert.sh` | target queue channel metadata |
| 现有 shell alert test（就近选择） | transient target/non-target record shape |
| `packages/teamlead/src/LeadAlertNotifier.ts` | validated target drain；不改 informational/manual-ticket 集 |
| `packages/teamlead/src/__tests__/LeadAlertNotifier.test.ts` | target/invalid drain cases |
| `scripts/qa-fly-1256-quota-daemon-e2e.sh` | explicit scratch notify env |
| `packages/config/src/feature-flags/truth.ts` | shared channel description |
| `engineering/doc/FLY-2051-quota-switch-routing/permission-probe.mjs` | 可重跑只读 Discord 权限计算，不输出 token |
| `engineering/doc/FLY-2051-quota-switch-routing/*` | full docs、review corrections、progress、rollout evidence |
| `engineering/doc/milestones/FLY-2051.md` | PR last commit，写明班车生效 |

若实际代码已有更窄的就近 harness，可复用而不新增平行测试文件；不得跳过上述行为 seam。

## 验证

### Targeted RED/GREEN + related regression

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/quota-monitor-alert.test.ts \
  src/__tests__/quota-monitor-alert-contract.test.ts \
  src/__tests__/LeadAlertNotifier.test.ts \
  src/bridge/__tests__/kind-contract.test.ts
bash scripts/__tests__/quota-monitor-wrapper.test.sh
```

### Hermetic real-daemon acceptance

```bash
bash scripts/qa-fly-1256-quota-daemon-e2e.sh
bash scripts/qa-fly-1256-quota-daemon-e2e.sh model
```

两个 mode 都必须显式 scratch env、零生产路径污染。

### Full repo hard gates

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

保留 aggregate 原始结果。若宿主负载导致已知并发 timeout，逐个失败文件单 worker 复跑并如实披露，
不把局部绿改写成 aggregate 全绿。

### Real Discord acceptance（有意外部写入，属于 issue 验收）

从本地 build 调 `sendQuotaMonitorAlert` + real `lead-alert.sh`，使用 unique FLY-2051 QA signature/title。
task 验收已明确要求“注入/触发一条 account_switched 且带 mention”，这就是本次单条 @founder QA
写入的授权边界；不额外扩张为更多 mention。每次运行先 `mktemp -d`，并把下列 durability/meta 路径
显式钉到该 scratch root：

```bash
FLYWHEEL_CLAIMS_DB="$scratch/claims.db"
FLYWHEEL_ALERT_QUEUE_DIR="$scratch/queue"
FLYWHEEL_ALERT_DEADLETTER_DIR="$scratch/deadletter"
FLYWHEEL_STATE_DIR="$scratch/state"
TMPDIR="$scratch/tmp"
```

先用上面的 read-only probe 复核 View+Send；不绿则不 POST。绿后发：

1. `account_switched` 带 founder mention 与完整 from/to + 5h/7d body；
2. `quota_no_target` 作为非-family 阴性对照，确认仍落 alerts。

随后用只读 Discord API 分别回读 notification / alerts 最新消息，按 message id 验 channel、content、
mentions。不得用 stdout 的 `sent` 代替终点回读。Discord QA 消息留作落点证据；scratch ledger 在
记录结果后删除，不触碰生产 claims/queue/dead-letter/meta state。

### Founder 8/25 表格反馈修订

1. 通知 email 不再依赖当前生产中为空的 account-store `identity`；runtime 直接读取每个 pool
   profile 已有的严格 `identity-anchor.json`，并以 store identity 仅作兼容 fallback。读取继续复用
   regular-file / mode / uid / exact-schema / control-character 校验，不从 OAuth probe 临时学习身份。
2. 每个账号用 Discord `text` code block 渲染四列表；对齐块只允许 printable ASCII：header 为
   `window / used / left / reset (PT)`，row label 为 `5h / 7d / Fable`，reset 使用本地月日、
   三字符 ASCII 星期缩写和时间（例如 `08-25 Tue 17:00`），不显示年份以适配 founder 手机窄宽。
   所有中文留在 block 外；每列按收紧后的字符数 pad，测试同时钉原始 index 与 ASCII wcwidth；
   `left = 100 - used`，缺失值逐单元格写 `n/a`。
3. `account_switched` / `account_switch_degraded` 不渲染 revive / pending / login-expired 状态；daemon
   内部 revive 行为不变，后续 confirmation 语义也不扩张。
4. account daemon E2E 的 retry 允许范围显式钉为 1..3，wait 条件和终点断言一致，既不把合法 retry
   当失败，也不放过无界重复 continue。

## Review、PR 与 rollout

1. 修订 plan 重新 `review_design`，直到 `reviewVerdict=APPROVED`。
2. hard gates + real acceptance 后重新 `review_code`，blocking findings 修复后新开 gate。
3. 代码/docs commit；PR 最后 commit 新建 `engineering/doc/milestones/FLY-2051.md`。
4. PR body 明示：merge 不部署；下一次 00:00/12:00 班车部署并重启 quota-monitor 后生效。
5. 班车后 rollout 验证再触发一条真实 family notice 并回读 notification；失败走既有
   dead-letter/meta-alert，不回退 alerts。implement node 不为此私投 restart ticket。
6. open PR 后 `complete --route needs_review --pr <number>`；不请求 ship、不 merge。

## 完成证据矩阵

| 要求 | 权威证据 |
| --- | --- |
| 三个 family 首次投 notification | TS family tests + real `account_switched` 回读 |
| transient 仍投 notification | shell queue record test + Bridge target drain test |
| mention / 字段齐全 | real回读 + fixed-literal TS test |
| non-family 仍投 alerts | `quota_no_target` unit negative + real benign negative control |
| 不硬编码 snowflake | production source/tests 只读 env；docs 中 ids 仅为可审计 permission evidence |
| missing config 不静默丢 | wrapper no-config fail-loud/no-exec test |
| severe 不回 unified | severe=unified negative test |
| 其他 kind 不漂移 | queue key absent/default drain + related/full regression |
| sender 有权 | read-only permission proof + real endpoint POST/readback |
| 重启后生效说明 | PR body + milestone + rollout step |
