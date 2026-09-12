# FLY-2520 账号到期排序 — 实现与验证
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520)
日期: 2026-09-11
基于: plan.md

## 实现结果

可选 retiresAt 接受带显式时区的有效 ISO 日期时间。缺失保持旧行为；错误值只排除该候选，不拒绝整个 store。活跃账号错误值不能证明已到期，因此不强制切换。保留 auth/model/cooldown/headroom 规则，在既有组内按 min(reset, retirement) 排序；最终选择再次检查到期。

既有 quota monitor pass 在 usage/local-scan/backoff/credential 返回前读取单个可信 snapshot。首次到期复用 account_dead、reason=retirement；monitor-only 不执行切换；未决 authority 不触发退休切换。失败后沿 nextUsageDueAt 节流，保留首次 unavailable.markedAt。不伪造额度或 reset/cooldown；回执保留退休原因。既有及新建 quota/model revive 窗口不得超过来源账号到期。

最后一小时通过 quota_monitor_down warning 与稳定账号+到期签名复用发送收据；新 sender 进程无第二次 POST，不 mention founder，不新增 timer/state schema。容量及 panorama 透传规范时间，巡逻行显示 PT 月日，含 DST 测试。

## 验证

- TDD：候选排序与排除、最终边界、活跃到期、节流、回执、warning、revive、展示先 RED 再 GREEN。
- 8 个定向文件 389 passed：account-retirement、account-candidate-selector、account-store、quota-monitor、quota-monitor-alert、switch-executor、patrol-tick-render、bridge/capacity-snapshot。
- bash scripts/__tests__/lead-alert-strict-delivery.test.sh：29 passed，0 failed；隔离临时目录、fake HTTP，无真实消息。
- pnpm lint：exit 0，现有 warnings；未批量修复无关文件。
- pnpm -r build：exit 0。首次新增日期解析 strict indexing 类型错误已修正并完整重跑。
- 文件写入/观测/重读保留 retirement，移除字段恢复旧排序；无 DB migration。
- 按 Lead 3bc31ed8-9a55-4661-879e-5fe53dd4a441 指令，宿主不跑全量 package suite；全量等待 PR 精确 HEAD CI。本地 green 不等于 CI/QA PASS。

## QA / 生产边界

未改生产配置、未重启、未合并部署。Lead/QA 在授权 host 流程写 business.retiresAt=2026-09-14T00:00:00-07:00（默认裁定），重启后验收真实 panorama/capacity、到期候选消失及活动号正常 pass 60 秒内切走。具体退役时刻须在生产验收确认。

school 周一 09:00 PT reset、business 同日 00:00 PT 到期时顺序 business/school/shopping；school reset 更早时 school/business/shopping。容量行沿原顺序语义，不作为排名证明。headroom 和安全排除优先于 deadline。

误写时间后，仅修改时间不会撤销已持久化 unavailable；既有 flywheel-quota-guard unavailable-clear <name> --reason ... 提供带锁、审计的恢复入口，由 Lead/QA 操作。earliestReset/guard suggestion、setter、retired sweep 等保留既定 follow-up 范围。R4 MEDIUM/LOW 已报告 Lead，不扩展实现。

## Implement@2 Discord 排版返工（2026-09-12）

基线 8ff9e3302c56afe783de59ebf84030b41defada2 / PR #1166。按 rework:2193b90a4020e687c26c02ecece1c2aa085a5c109b89194d04a080d8e8ffaf62，只改展示：复用现有切号通知 quotaTable；每账号独立 name/email/到期标题与 fenced window/used/left/reset (PT) 表，观测时间另行。容量数据只额外透传经过验证的 identity email。未知 reset 显示 n/a，不伪造未开始或实时 usage。

最后一小时 warning 使用中文事件首行，沿现有收据 signature、频道、严重性与去重发送；按照最新返工要求首行 @Annie，并使用 plain message。shell 和队列接收器允许 quota_monitor_down 的 plain 展示；其他 monitor warning 不主动改变风格。原设计「不 mention」仅在本轮最新 founder 排版要求下被替代，无私信。无候选 panorama 保留逐行表格并逐行脱敏，避免 Cc 清洗压平换行。成功切号回执展示来源/目标配置的到期日。

候选排序、retiresAt 校验、到期切换触发、节流、CAS 和生产配置没有改动。09-14-2026 实际为 Mon，显示由 America/Los_Angeles 日期计算，未照抄示例中的 Sun。

### 验证

- RED：monitor/alert 新展示断言 3 失败；capacity 新布局断言失败；sender plain guard 失败；notifier plain 接收断言失败；切号到期标签断言失败，均为预期缺失行为。
- GREEN：11 个定向文件共 486 tests passed（包含原排序/到期/切换守卫回归）。
- bash scripts/__tests__/lead-alert-strict-delivery.test.sh：29 passed，包括新 plain retirement warning 的跨进程去重。
- pnpm lint exit 0（既有 15 warnings）；pnpm -r build exit 0。全量 package suite 按 Lead brief 交精确 HEAD CI。

### 529 真实 Discord 证据

TEST_BOT_TOKEN_1 经实际 lead-alert.sh + sendQuotaMonitorAlert 投递 warning；capacity 使用实际 formatPatrolTick 输出投递。固定 example.com 与模拟数值，未读取/写入生产账号；真实 POST 成功且 REST GET 回读一致。原始回读分别保存在 discord-proof/retirement-warning.json、discord-proof/capacity.json。

- warning: https://discord.com/channels/1485787271192907816/1519421055805165842/1548391597866221699
- capacity: https://discord.com/channels/1485787271192907816/1519421055805165842/1548391600860827730
- 原切号消息 REST GET 已保存 discord-proof/reference.json：https://discord.com/channels/1485787271192907816/1521630422918758472/1547847757983912067 。表头、列宽、PT reset 日期与原 renderer 相同；每账号独立 fenced block。

截图路径：尚无本地截图。浏览器只显示 Discord 登录页。Lead 明确裁定 5e7a08a2-5cdb-4818-81ca-1c1123ae6973：不给 founder CDP 登录态；由 Lead 在登录态拍照贴入 FLY-2520 thread，QA 自行重截，实现体发消息链接后继续 review/needs_review，不等截图。已通过 DONE report ca61e9a9-f7ff-4bc9-9354-11ce02c6bd1e 交付两条链接。此为真实投递/原文证据，不宣称实现体完成像素验收。

## Implement@2 R2（最终合同，2026-09-12）

R1 CHANGES_REQUESTED 完整证据：code-review-rework-r1.json。MEDIUM/LOW 按 Lead 要求归档于 plan-followups.md，不修改 pinned plan、不实现、不另开单。

Lead 裁定 e6cb5fb3-552c-4a76-b699-c8ad2de8e3d5 覆盖上节的邮箱投影实现：capacity snapshot 与 /api/capacity 继续使用原始脱敏合同，capacity-snapshot.ts 及其测试恢复基线；capacity-route.test.ts 的私有邮箱禁出断言保持不变。patrol 容量块仅账号名/到期/额度/观测时间，不读取邮箱、也不显示缺失邮箱占位。邮箱只在直接从 account store 读取的到期告警中显示。新回归证明意外注入的 email 也不被 capacity renderer 消费。R1 CI 唯一失败为该旧隐私断言，现已修复根因而非放宽断言。

修正容量消息已真发并 REST 回读：discord-proof/capacity-sanitized.json，https://discord.com/channels/1485787271192907816/1519421055805165842/1548396100317347921 。原 capacity.json 是 R1 历史样例，已被本条替代。Lead 对 R1 两条截图已贴在 FLY-2520 thread message 1548392061089091675；已报告修正后的容量链接供 Lead/QA 重截。

Lead 授权 09149c69-b056-44d7-9301-b7330d0e8fba 允许仅修两条基线已存在的 HIGH：retirement-monitoronly-hot-spin、retirement-skips-lastpollat-health-gate。到期分支入口刷新 lastPollAt，覆盖三个提前返回；monitor-only usage deadline 到时推进 nextUsageDueAt，保留现有间隔与配置错误告警 signature。未重构轮询结构，不改变排序、切换、退休语义。六个新增/加强断言先 RED，随后 monitor/CLI/state 143 tests GREEN，涵盖成功切走、失败/无候选节流、monitor-only 持久化重读与延迟非零。

R2 提交前验证：14 个定向文件 533 tests passed，包含未改的 capacity route 合同；pnpm lint exit 0（既有 warnings），pnpm -r build exit 0。sender shell 路径相对 R1 无修改，沿用同字节 29/29 通过证据。精确新头 CI 与 R2 verdict 尚待登记。
