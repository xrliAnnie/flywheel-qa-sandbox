# Design Review — plan.md (Round 4)

Date: 2026-09-25
Author: Codex
Status: APPROVED

## Summary

v5 已完整关闭 Round 3 的全部反馈，且计划、实现与测试相互一致。分页现在以必填的字符串 `nextPageToken` 证明穷尽，损坏的 envelope/row 整号 `malformed`，跨页 message id 去重且字段冲突 fail closed；页面优先级、免费套餐的单一权威来源，以及 `receiptCount`/`amountCents` 的关系约束也已对齐。

我只读运行了 6 个相关测试文件，共 167 项，全部通过；未访问真实邮箱，测试后工作树保持干净。现有架构可以按该计划实现和验收，没有新的设计阻断项。

## What's Good (Keep)

- 每页完整性契约现在区分“真实邮件不匹配”与“gog 输出损坏”：不可读 Date 或非精确 Anthropic sender/subject 可以安全丢弃，而缺 token、非对象 row、缺/非法 message id 均不会冒充空邮箱。
- 跨页以 id 去重，重复且字段一致的消息只取一次正文；同 id 的 date/from/subject 冲突直接 `malformed`，避免重复金额、重复张数和错误消耗 6-body budget。
- 三页元数据上限仍保持明确：未穷尽时在读取正文前返回 `search_truncated`，因此未知后页中的补差收据、取消或恢复事件不会被忽略后再下确定结论。
- `free` 已彻底退出 charge store 和 observer；页面使用当前 account-detail tier，并明确优先于旧邮箱 reading。并行刷新不再能为旧套餐状态制造更新的时间戳。
- store validator 现在拒绝“张数未知但金额确定”的不可能组合，同时仍允许“张数已知、金额因收据缺字段而未知”。
- §6 将 `id/threadId/labels/from/subject/date/page token` 的瞬时 Bridge 内存范围写全，并把 Lead/founder 对该精确范围的确认列为部署前置条件；落盘和日志边界没有扩大。
- mailbox 绑定、取消与 resume 仲裁、48 小时 `lastGood`、Pacific 调度、single-flight、软/硬上限及刷新腿隔离等前几轮已确认的设计均被保留。

## Issues & Recommendations

1. **无阻断问题。** Round 3 的 BLOCKER、SHOULD 和两个 NIT 均已按约定关闭。执行阶段只需遵守计划已有的部署门槛：在启用真实邮箱读取前，取得 Lead/founder 对 §6 所列瞬时内存字段范围的明确确认，并按 §8 完成只读真邮箱验收记录。

## Verdict

**APPROVED**。v5 在当前 Bridge 架构和 `gog@a92bd63` 能力下可实现，身份绑定、分页完整性、金额/张数可信度、隐私边界、子进程上限及页面仲裁均已有明确的 fail-closed 契约与对应测试。可以进入实现收口与计划中的验收步骤。
