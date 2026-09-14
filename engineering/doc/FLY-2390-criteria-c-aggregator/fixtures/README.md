# FLY-2390 回放夹具
Issue: FLY-2390 (https://linear.app/geoforge3d/issue/FLY-2390)
日期: 2026-09-10
基于: ../plan.md

这些是按 FLY-942 原始告警观测字段构造的确定性回放数据，不是生产抓取或主机演练证据。SHA、消息 ID、founder ID 均为夹具值。

- events.json：旧部署 episode 的 severe，同一事件两次 occurrence，窗口内按最高级别去重。
- anchors.json：旧 episode、同 SHA 再部署后的 72 小时 episode、20 天 episode。
- publications.json / founder-verdicts.json：三天日报，依次 down、up、无反应；成功扫描时间固定。
- bugs.json：带版本 tag 的已落定 bug。
- outbox/ 与 bug-source-health.json：无版本 preflight 意图、损坏 JSON、待落定 publication 和标签查询失败。
- replay.ts：每分钟 heartbeat；unknown 注入末尾两小时缺失及无版本 severe，并验证 14 天窗口截断。

运行 `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/release-readiness-replay.test.ts` 验证 green / hold / unknown。report-sample.html 为 hold 场景渲染产物。
