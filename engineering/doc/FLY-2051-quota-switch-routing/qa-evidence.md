# FLY-2051 切号通知按 kind 路由 — QA 证据
Issue: FLY-2051 (https://linear.app/geoforge3d/issue/FLY-2051/quota-monitor路由-claude-切号通知改发-flywheel-notification切号家族-per-kind)
日期: 2026-08-25
基于: plan.md

## Discord 权限探测

- 最终 narrow-width paragraph-free 实投前复核时间: `2026-08-26T01:20:13.823Z`
- sender bot: `1524831623164596265`
- 目标: `flywheel-notification` (`1521630422918758472`)
- `VIEW_CHANNEL=true`
- `SEND_MESSAGES=true`
- `EMBED_LINKS=true`
- `READ_MESSAGE_HISTORY=true`
- `CREATE_PUBLIC_THREADS=true`
- `SEND_MESSAGES_IN_THREADS=true`
- `MANAGE_THREADS=false`（不影响创建并操作自己创建的 thread）

## 真实 Discord 路由验收（首轮，已被 founder 文案反馈取代）

验收 marker: `FLY-2051-QA-1787694623502`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541927753182609408`
   - [查看消息](https://discord.com/channels/1485787271192907816/1521630422918758472/1541927753182609408)
   - 已读回确认 founder mention 存在。
   - 已读回确认机器字段齐全，但 founder 指出该 alert-box + raw field 形态不可读，因此这条只能证明首轮路由，不能作为最终文案验收。

2. `quota_blocked_recovered` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541927755736817744`
   - [查看消息](https://discord.com/channels/1485787271192907816/1518793447165661254/1541927755736817744)
   - 证明非切号 kind 未随新规则整体漂移到 notification。

两条 QA 消息保留作审计证据，未执行删除。

## 真实 Discord 路由验收（A 分行版，已被 founder 表格反馈取代）

验收 marker: `FLY-2051-QA-1787699345289`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541947557859827722`
   - [查看最终切号通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541947557859827722)
   - Discord API 回读确认 founder mention 存在。
   - Discord API 回读确认 founder 选定的 A 版人话正文完整：from/to 名称与 email、双方 5h/7d 用量和 founder 本地重置时间、双方 Fable quota、continue 指令的准确语义均存在。
   - 回读正文不含 `from5h=` / `to5h=` / `revived=` / `pending=` 等旧机器字段，也不含 alert-box 标题。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541947560309031022`
   - [查看最终阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541947560309031022)
   - Discord API 回读确认 kind 为 `quota_no_target`，证明非切号 kind 仍走统一 alerts 通道。

两条最终 QA 消息保留作审计证据。实投使用独立 scratch claims/queue/dead-letter/state；回读成功后仅删除该 scratch 目录，未触碰生产 durability state。

## 真实 Discord 路由验收（display-width 表格版，已被固定字符列宽取代）

验收 marker: `FLY-2051-QA-1787701190094`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541955297197948948`
   - [查看最终表格通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541955297197948948)
   - Discord API 回读确认 founder mention 存在，且原/新账号 email 逐字来自 live `shopping` / `school` identity anchors，不是 QA 假邮箱。
   - 回读确认双方各有一个 `text` code block；列为窗口 / 用量 / 剩余 / 下次重置，5h / 7d / Fable quota 三行均完整且等宽。
   - 回读确认 revive 仍逐字写“已发送继续指令”，未出现“已恢复”；旧机器字段和 alert-box framing 均不存在。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541955299278323753`
   - [查看最终表格轮阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541955299278323753)
   - 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

两条消息保留作审计证据；隔离 scratch durability 目录在终点回读后已删除。

## 真实 Discord 路由验收（固定原始字符列宽版，已被 ASCII-only 版取代）

验收 marker: `FLY-2051-QA-1787701754192`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541957660604371044`
   - [查看最终固定列宽通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541957660604371044)
   - Discord API 回读确认 founder mention、两个 live identity-anchor email、两个 `text` code block、全部 quota/reset 与真实 revive 文案。
   - 原始字符串中用量 / 剩余 / 下次重置三列固定从 index 12 / 22 / 32 开始；每列用空格 pad，不再按 CJK 估算显示宽度。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541957662730752113`
   - [查看最终固定列宽轮阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541957662730752113)
   - 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

两条消息保留作审计证据；本轮 scratch durability 目录已在终点回读后删除。

## 真实 Discord 路由验收（ASCII-only 版，已被 weekday-complete 版取代）

验收 marker: `FLY-2051-QA-1787703034555`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541963031049932800`
   - [查看最终 ASCII-only 通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541963031049932800)
   - Discord API 回读确认 founder mention、两个 live identity-anchor email、两个 `text` code block、全部 quota/reset 与真实 revive 文案。
   - 每个对齐 block 恰好四行且全部匹配 printable ASCII；used / left / reset 三列 raw index 与 ASCII wcwidth 均为 9 / 17 / 25。中文只存在于 code block 外。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541963032756887552`
   - [查看最终 ASCII-only 轮阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541963032756887552)
   - 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

截图能力审计：session 暴露了 Chrome DevTools capture tool，但打开 Discord 消息页被当前 `approval policy=never` 拒绝；按 Lead 指令把上面的真实渲染链接交回 Lead 截图复核，未用手工 mock 代替真渲染。
两条消息保留作审计证据；本轮 scratch durability 目录已在终点回读后删除。

## 真实 Discord 路由验收（weekday-complete ASCII 版，已被 paragraph-free 版取代）

验收 marker: `FLY-2051-QA-1787704741508`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541970190391316542`
   - [查看最终 weekday-complete 通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541970190391316542)
   - Discord API 回读确认 founder mention、两个 live identity-anchor email、两个 `text` code block、全部 quota/reset 与真实 revive 文案。
   - reset 同时包含绝对日期、真实三字符 ASCII 星期与 PT 时间；used / left / reset 三列 raw index 与 ASCII wcwidth 仍为 9 / 17 / 25。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541970192983269406`
   - [查看最终 weekday-complete 阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541970192983269406)
   - 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

两条消息保留作审计证据；本轮 scratch durability 目录已在终点回读后删除。真实渲染链接已交 Lead 做最终 zoom 截图复核。

## 真实 Discord 路由验收（paragraph-free 版，已被 narrow-width 版取代）

验收 marker: `FLY-2051-QA-1787706370938`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541977024451715095`
   - [查看最终 paragraph-free 通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541977024451715095)
   - Discord API 终点回读确认 founder mention、`shopping -> school` 切号事实、两个 live identity-anchor email，以及双方各一个 weekday-complete ASCII quota 表格。
   - 正文只包含切号事实、原账号表格和新账号表格；回读明确拒绝 `切号时` / `继续指令` / `仍在等待` / `已恢复`，也不含旧机器字段或 alert-box framing。
   - 两个表格各四行、全部 printable ASCII；used / left / reset 三列 raw index 与 ASCII wcwidth 均为 9 / 17 / 25。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541977026775351306`
   - [查看最终 paragraph-free 阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541977026775351306)
   - Discord API 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

两条消息保留作审计证据；本轮 scratch durability 目录已在终点回读后删除。真实渲染链接已交 Lead 做最终 zoom 截图复核。

## 真实 Discord 路由验收（最终 narrow-width paragraph-free 版）

验收 marker: `FLY-2051-QA-1787707221819`

1. `account_switched` 正向用例
   - 结果: `sent`
   - 落点: `flywheel-notification`
   - message id: `1541980593732976690`
   - [查看最终 narrow-width 通知](https://discord.com/channels/1485787271192907816/1521630422918758472/1541980593732976690)
   - Discord API 终点回读确认 founder mention、`shopping -> school` 切号事实、两个 live identity-anchor email，以及双方各一个 quota 表格。
   - reset 收窄为 `MM-DD Ddd HH:mm`（例如 `08-25 Tue 17:00`）；两个表格各四行、全部 printable ASCII，used / left / reset 的 raw index 与 ASCII wcwidth 均为 8 / 15 / 22。
   - 正文仍只包含切号事实、原账号表格和新账号表格；回读明确拒绝 `切号时` / `继续指令` / `仍在等待` / `已恢复`，也不含旧机器字段或 alert-box framing。

2. `quota_no_target` 阴性对照
   - 结果: `sent`
   - 落点: `flywheel-alerts`
   - message id: `1541980595507433542`
   - [查看最终 narrow-width 阴性对照](https://discord.com/channels/1485787271192907816/1518793447165661254/1541980595507433542)
   - Discord API 回读确认 kind 为 `quota_no_target`，非切号 kind 未漂移。

两条消息保留作审计证据；本轮 scratch durability 目录已在终点回读后删除。

Lead 最终窄宽 gate: **PASS**。本轮 Chrome extension 因运行中切号失去配对，Lead 明确披露改用逐字宽度审计：最长表格行从 44 收到 37 个 ASCII 字符，小于 430px 手机 code block 的约 40+ 字符预算；各行列位 8 / 15 / 22 一致、禁词零命中、900px 桌面宽度同样满足。Chrome 恢复后的截图仅作非阻塞补档，不影响本 gate verdict。

## Hermetic daemon E2E

- `bash scripts/qa-fly-1256-quota-daemon-e2e.sh account`: PASS；真实 daemon 完成 `shopping -> school`，正文包含两边 identity-anchor email、5h/7d/Fable 的用量+剩余+reset 表格，并以 `--plain-message` 指向 notification；pane revive 仍在正文发送前实际执行且 attempts 被约束在 1..3，但通知刻意不披露其状态。
- `bash scripts/qa-fly-1256-quota-daemon-e2e.sh model`: PASS；crash/restart 后 `quota_switch_confirmation` 以人话正文和 plain style 指向 notification。
- 两条 E2E 均使用 scratch Keychain/store/tmux/alert sink，未触达生产状态。

## 仓库验证

- `pnpm lint`: PASS（仅保留 8 条与本分支无关的既有 warning）。
- `pnpm -r build`: PASS。
- 当前 founder-copy focused regression: 216/216 PASS（TypeScript 六个 suite 210/210；quota-monitor wrapper 6/6）。
- `scripts/__tests__/lead-alert-strict-delivery.test.sh`: 26/26 PASS。
- `scripts/__tests__/quota-monitor-wrapper.test.sh`: 6/6 PASS。
- `pnpm test:packages:run`: 已执行完整门禁；原始环境仅 `@flywheel/core` 两条真实 Terminal integration 因 runner 无法连接 macOS `com.apple.hiservices-xpcservice` 失败。用测试既有 headless seam 重跑后 core 为 219 PASS / 3 SKIP。
- 全包 headless 重跑仅 `flywheel-comm` 一条 5 秒测试在并发负载下超时；该精确测试单 worker 隔离复跑 1/1 PASS（908ms）。
- `flywheel-teamlead` 全包限 4 workers 重跑：726/727 files PASS，9596 PASS / 6 SKIP；唯一失败同时伴随 Vitest worker RPC timeout，为 `terminal-thread-archive.test.ts` 的固定 5 秒并发超时。该文件单 worker 隔离复跑 22/22 PASS（目标测试 2386ms）。
- 本次改动测试在 teamlead focused run 中通过：`quota-monitor.test.ts` 65/65、`quota-confirmation.test.ts` 5/5、`quota-monitor-alert.test.ts` 33/33、`quota-monitor-alert-contract.test.ts` 15/15、`LeadAlertNotifier.test.ts` 64/64、`kind-contract.test.ts` 28/28。

## 生效时点

quota-monitor 是常驻进程。PR merge 本身不部署、不重启；代码与 `.env` 路由随下一班 `00:00/12:00` updater 重启后生效。未申请紧急 restart ticket。
