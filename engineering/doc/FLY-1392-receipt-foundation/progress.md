---
issue: FLY-1392
phase: implement
phaseCursor: 3/3
updated: 2026-07-21T19:15:00Z
nextStep: commit and push founder-to-Lead single handled-marker revision;
  request code review and QA retest
chunks: []
pointers: {}
---

# FLY-1392 progress
**phase**: implement (3/3)
**next**: commit and push founder-to-Lead single handled-marker revision; request code review and QA retest

## 2026-07-21 单层办结最终口径

- 新增 `design-correction.md` 作为最终 authority:对外只有“Lead 办了没有”标记。
- `delivered_at` / `processed_at` 收敛为内部到达/办结时间戳;actor/epoch
  仅作防误写卫生,不再形成逐类型凭据合同叙事。
- 旧 exploration/research/plan/qa-report 已标注改型前历史状态,当前验收改为
  founder 原文只到 Lead、Lead relay 后才办结、未办重发/唤醒/升级。
- progress CLI 仍因服务端 session 状态为 `awaiting_review` 拒绝 active writer;
  本 cursor 随实现 commit 持久化。

## 2026-07-21 founder routing override

- Bridge 默认路径改为 founder 原文直达 Lead,不再运行 F-2/F-3/F-5 归因或直写 runner。
- founder root 的 handled 仅由 Lead relay/no-route UOW 写入,typed evidence actor_kind=`lead`。
- targeted tests: flywheel-comm 54/54 + TeamLead 80/80 PASS;cross-package F-5 ingress→Lead relay→wake PASS。
- 紧急回退边界:flag-off 时 startup + hourly `receipt_foundation_off` severe 告警;
  默认 flag-on 零噪音。告警/种类合同/路由/配置专项 68/68 PASS。
- `flywheel-comm progress` 因 session 仍标 `awaiting_review` 拒绝写入,故本 cursor 随实现 commit 持久化。
