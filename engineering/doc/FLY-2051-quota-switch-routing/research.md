# FLY-2051 Claude 切号通知按 kind 改道 — 调研
Issue: FLY-2051 (https://linear.app/geoforge3d/issue/FLY-2051/quota-monitor路由-claude-切号通知改发-flywheel-notification切号家族-per-kind)
日期: 2026-08-25
基于: exploration.md

## 结论

Happy-path 改道只需 `quota-monitor-alert.ts`，但完整路由还必须保住三条边：daemon 启动配置、shell
transient queue 的目标 channel、Bridge drain 的安全重投。实现仍以 per-kind 为边界：只为三个
switch-family kind 产生 target override/queue metadata，其余 kind 沿用现状。

## 调用链审计

| 层 | 当前事实 | 必要修改 |
| --- | --- | --- |
| `quota-monitor.ts` | account switched/degraded 直接 `await deps.alert`，不进 outbox | daemon 启动前必须保证 notify 配置有效，不能等事件发生后静默报 config_error |
| `quota-confirmation.ts` | confirmation intent 进 64 项 durable outbox | 任何永久 misroute 会卡队头，必须先验证 sender/target，并保住 transient target |
| `quota-monitor-alert.ts` | typed per-kind mention/severe；primary 继承 unified；severe 可二投 | 增加 notify primary policy；target secondary 禁止回 unified |
| `lead-alert.sh` | transient 写 queue JSON，当前不含 channel；4xx permanent 会 dead-letter + meta-alert | target family queue record增加 `deliveryChannelId`；degraded ticket rendering 不改 |
| `LeadAlertNotifier.drainQueue` | unified mode 无条件向 Bridge unified channel 重投 | 若 record 带合法 target，向该 target 重投；字段非法 fail-close |
| quota wrapper | source shared `.env`，再 exec daemon | notify 缺失/blank 时立即 quota_monitor_down fail-loud 并拒绝 exec |
| `qa-fly-1256-quota-daemon-e2e.sh` | hermetic env 未声明 notify，真实 daemon 依赖 alert sink | 显式 export scratch notify channel，消除 ambient env 依赖 |

## Sender 权限取证

第一轮评审指出 notification 的既有生产者都使用其他 bot，不能据此推断 alert dispatcher 有权限。
因此对当前 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 选中的 bot 做了独立只读核验：

1. `GET /users/@me` 取得 bot identity；
2. `GET /channels/{notify}` 证明可见目标 channel，并取得 guild 与 overwrites；
3. `GET /guilds/{guild}/members/{bot}` + `/roles` 计算 base permissions；
4. 按 Discord everyone → combined roles → member overwrite 顺序计算 effective permissions。

结果（2026-08-25T21:05:05Z）：bot=`1524831623164596265`、guild=`1485787271192907816`、
channel=`1521630422918758472`、effective permissions=`2248473465835073`，
`View Channel=true`、`Send Messages=true`。可重跑计算在 `permission-probe.mjs`；命令未打印 token，
也未产生 Discord 消息。此证据证明当前配置可投，但权限仍可能漂移；真实 POST 的 401/403/404 会
继续走既有 permanent dead-letter + meta-alert，不静默吞掉。

## Config missing 失败语义

直接 kind 没有 durable outbox，因此不能用“config_error 后稍后重试”论证安全。修订为 startup
invariant：wrapper source `.env` 后检查 trimmed `FLYWHEEL_NOTIFY_CHANNEL`。缺失时：

- 调既有 `fail_loud`，kind=`quota_monitor_down`、落点仍是 unified alerts；
- 非零退出，绝不启动一个会切号却丢 founder notification 的 daemon；
- launchd 后续可重试，配置修复并随重启读取后恢复。

这是显式故障而非 fallback：丢的是 daemon readiness，不是切号通知。生产 env 当前已满足，不改变
健康启动路径。早退发生在 RUN_MARKER 前，故不计 crash-streak/restart-storm；有意接受 launchd
`ThrottleInterval=30` 的 30 秒重试节奏。daily alert signature 令 Discord/claims 只保留一个故障事件，
与 wrapper 现有 missing-dist 非零早退同类，不形成热循环或消息 storm。

## Transient queue target

只在 `account_switched`、`account_switch_degraded`、`quota_switch_confirmation` 的 shell queue record
写 `deliveryChannelId`。Bridge 读取规则：

- key 缺失：继续使用 `this.unifiedAlert.channelId`，所有旧记录/非 target 行为不变；
- key 是 17–20 位 snowflake：用它作为 drain channel，仍走同一个 sender chain/rate limiter；
- key 存在但非法：dead-letter `invalid-delivery-channel`，不允许本地 queue 文件把消息导向任意 URL。

成功 drain 回传给 Hub 的 `channelId` 也使用实际 target。`account_switch_degraded` 仍是 severe manual
ticket，Hub 在 notification 继续处理它的 thread/ARC；另外两个 kind 的既有 informational 语义不变。

## Severe secondary

notify family 的 severe secondary 要同时避开两个 channel：

- `severe === primary(notification)`：重复投递，跳过；
- `severe === unified(alerts)`：违反 founder 原话，跳过。

若 future severe 配成第三个非-unified channel，仍保留既有双投升级。非 target kind 的比较与投递
算法不变。

## Truth registry 与共享变量

`FLYWHEEL_NOTIFY_CHANNEL` 已在 truth registry，但描述只写 restart notification。更新描述为 restart
notifications + FLY-2051 quota switch-family notices，避免未来配置维护者不知道两个消费者共享同一
channel。变量和值均不新增。

## TDD seams

1. `sendQuotaMonitorAlert` child-process boundary：args/env、family/negative、missing config、severe guards。
2. `lead-alert.sh` process boundary：fake Discord transient 后读取 queue JSON，验证 target metadata 只在
   family 出现；degraded 既有 ticket rendering 不改。
3. `LeadAlertNotifier.drainQueue` public method：fake fetch 观察实际 channel URL；非法 target 不 POST。
4. wrapper process boundary：fake monitor + fake alert，验证 missing fail-loud/no exec 与 configured exec。
5. real daemon harness：真实 build/runtime + scratch alert sink，覆盖 switched/confirmation。

## 真实落点与部署时点

实现与 build 完成后，用本地 exact bytes + production env 受控发两条带 FLY-2051 QA 标识的消息。
保留真 channel/token，但 claims DB、queue、dead-letter、state 与 TMPDIR 全部钉到一次性 scratch；
task 明列的 account_switched mention 验收只授权这一条 QA mention：

- `account_switched` → notification；回读 content/mentions，核 from→to 与四个 5h/7d 字段；
- `quota_blocked_recovered` → alerts；作为无告警语义的非-family 阴性对照，避免制造假的
  `quota_no_target` 严重事故。

merge 不触发即时部署。生产行为在下一次 00:00/12:00 班车部署并重启 quota-monitor 后生效；班车
后再做一次真实 family 落点确认是 rollout 证据，不由 implement node 私自投 restart ticket。
