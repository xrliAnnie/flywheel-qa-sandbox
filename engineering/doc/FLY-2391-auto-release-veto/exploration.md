# FLY-2391 默认发布与否决 — 探索
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-14
基于: 无

## 目标与边界

按 PRD `product/doc/FLY-1098-release-cicd/prd.md` §5、§6.2，客户正式发布到期且客观健康时，Annie 无需点头；她只在不放心时按一次「别发」。本节点只交付设计与评审，不实现、不启用。

release 是面向客户的 manifest 指针切换；ship 是 PR 合入 main。两者授权和账本独立，B4 绝不写 founder PR-head approval、也不改变 FLY-2309/FLY-2398 自动合并影子行为。

## 已确定的不变量

1. 只消费 B3 的 `green | hold | unknown`，不重算另一套健康分数。unknown 包括通知、Bridge、scheduler 故障。
2. cycle 开始冻结 beta 身份；从同 sourceCommit 在窗口前预构建 clean artifact，immutable staging 上传并回读验 hash。窗口绑定最终 releasePayloadSha256。
3. 一周期最多一个窗口。新 beta 不替换候选；当前候选出现负面或缺失信号取消本周期，即使恢复也不再开窗。
4. durable delivery receipt 先成立，沉默才能被解释为允许。投递尝试、队列入队与消息文本均不足。
5. founder 动作必须验证身份、耐久写入、幂等且绑定完整候选。手动 go 只覆盖 readiness，不覆盖 CI/hash/immutable/CAS/version。
6. manifest 是唯一发布提交点。跨远端提交失败或回包丢失需要精确重查，不重新构建、不替换 hash。
7. B4 默认关；B0 → B1+B2 联合 E2E → B3 → B5 install/update/rollback/quarantine → B4 shadow → 真手动 E2E → founder 授权最后灰度。B6 不进入此依赖链。

## 方案比较

| 方案 | 结论 | 理由 |
|---|---|---|
| release 专用持久 cycle + B1 prepare/commit + B3 read | 采用，待代码审计细化 | 单一候选、单窗口、独立授权，有明确崩溃恢复点 |
| 复用 PR ship approval 并把超时标 approved | 拒绝 | 污染合并权限，不符合 §2.3 |
| cron 到时直接执行 payload-promote | 拒绝 | 不保证通知送达、候选不变和否决竞态 |
| 窗口后重新构建 clean 包 | 拒绝 | 沉默对应的 hash 与实际发布物不同 |
| 恢复 green 后自动重开窗口 | 拒绝 | 违反每周期一次，故障可能变成反复催促 |

## 研究任务

- 审计 B0/B1 prepare/commit/withdraw 的真实接口、授权字段与持久化位置。
- 审计 B3 subject、读接口、freshness 与负面证据传播；区分代码合入与生产已激活。
- 审计 Bridge 的 scheduler、可信 founder 动作入口、发送确认、事务/投影样式。
- 明确远端提交与本地 veto 的序列化边界、故障期窗口处理、三本账幂等恢复。
- 形成逐转移测试矩阵、迁移与回退边界、灰度证据门槛。

## 尚待外部信息

PRD §13 未锁定具体发布日/窗口钟点，已向 Lead 非阻塞询问。设计将其做成启用前必填并留出 timezone、最长投递延迟和最短否决时长约束；不自行启用生产默认值。
