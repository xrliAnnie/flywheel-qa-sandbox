# FLY-1574 Discord 收编 — 设计评审 R8

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md R7

Verdict: `CHANGES_REQUESTED`
Request: `92f3a255-5c21-4995-9b9a-cff9745cd9a6`

## Blocking findings 与处理

1. `socket-owner-lock-gates-legacy-flow`(HIGH):采纳。R8 将 lock acquire 分成 `acquired/conflict/unavailable`;conflict 先走认证 live-owner probe,两类失败都做 jitter capped retry 与周期告警。只有 infrastructure unavailable 时 OFF 可启动 legacy-only gateway 维持 Discord 逃生口;ON fail-stop,普通 mailbox last-mile 不伪装健康。
2. `claim-time-envelope-parser-wedge`(HIGH):采纳。claim 使用 total `discordBatchPartitionKey`:只对 Discord 行解析,catch 全部错误并返回按 delivery id 唯一的 invalid sentinel,让坏行形成 singleton batch;严格 parse/alert/quarantine 留在可到达的 delivery path,后续正常 model 行不被堵。

## Advisories 与处理

- `protocol-v2-hard-bump-reverse-skew`(MEDIUM):采纳。v2 additive:新 server 接 v1/v2,新 client 发 v2;v1 Discord wrapper 在新 server fail-close,普通 v1 batch 兼容;runbook 钉死 Lead consumer→Bridge 的升级顺序与先 OFF 的反向回滚顺序。
- `socket-capability-probe-unspecified`(MEDIUM):采纳。Phase 3 增认证、lead-bound、无 journal 副作用的 `capabilities` method,返回协议/feature/ownerEpoch,用于 live-owner 判定和 census。
