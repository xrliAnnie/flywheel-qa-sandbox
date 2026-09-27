# FLY-2912 纯通知只记账 — 合并返工验证
Issue: FLY-2912
日期: 2026-09-26
基于: plan.md, retry-fix.md

本轮依据 Lead `[lead-instruction edaddad8-ec2a-4c24-96fe-10ec99eac111]`，只解决 PR #1355 与 main 的冲突。实现 TURN epoch 25 / attempt 5；原头 `f858696e717d0f3fa0ba0f14a466a51e597c5660`，合入 main `b0da16c38b75beb8634dac7d24c52914c9f1e19f`。不改开关、通知分类、持久化合同或已接受的产品范围。

## 合并结果

- `lead-inbox-loop.ts`：保留 main FLY-2883 中断信件的绑定校验、拒绝/挂起/ACK 与 custom/mail 投递路径；只有决定继续发送时才执行本分支原有摘要冻结与附加，然后在匹配投递收据的事务中接受摘要。摘要准备仍在传输重试计数的 try/catch 之外，原批次/成员/ACK header 与 fresh-batch 重试规则不变。
- `lead-inbox-runtime.ts`：使用 main 创建的同一个 adapter，同时保留 interrupt hooks 和 `prepareAuditSummary` wiring。
- 新增四个交叉回归：dead/hold 不生成或发送摘要，mail/custom 都携带摘要、推进提供游标、保留成员 ID、记录 notified_at 并保持 LEASED/未 ACK。其余源码只接收 main 的原有改动。

## 验证过程

先安装锁定依赖并构建 teamlead 依赖。临时只保留 main 冲突侧作为负对照：四个交叉回归中 2 过、2 因缺少摘要失败。恢复两边逻辑后，发现新测试错误地要求 Lead 行的 delivered_at 非空；按原有 `lead-interrupt-delivery.test.ts` 的队列合同修正为 notified_at，并断言 LEASED/acked_at=null。完整摘要文件随后 16/16 通过。负对照和初次断言错误日志均保留。

测试选择在执行前用 `git grep -lF` 检索改动文件全路径、文件名、父目录与调用符号。21 个具体文件逐一执行；24 个目录级引用排除项逐项记录在 `evidence/conflict-rework-selection.json`。TypeScript related 使用同一发现集的 16 个 teamlead 候选文件限制收集范围，不运行本地全包或全仓测试。自动合并的 feature flag 和 query-plan guard 保留。

完整验证：21 个具体文件 / 464 passed；有界 related 实际 12 文件 / 256 passed（与前者重叠）；lint exit 0（25 warnings）、`pnpm --filter "flywheel-teamlead..." build` 及 `pnpm --filter "...flywheel-teamlead" typecheck` 均通过。首次 lint 仅因新测试格式失败，定向 format 后重跑通过。完整命令、退出码、源码 blob 和 32 份日志见 `evidence/conflict-rework-verification.json` 及同名压缩日志。代码评审、新头 full CI 和 QA 仍待验证。

## 验收边界

Founder 2026-09-26 19:38 PDT 选 A：9/25 前后唤醒验收转为上线后真实测量，不再阻挡 QA。99→92（约 7%，乐观 87）仅估算，845/1855 UNKNOWN；不把 runtime turns 当物理唤醒。自动回滚可能使在飞摘要批次冲突、普通任务 DEAD / founder 消息 quarantine；手动降级仍需先 OFF、排空在飞批次。以上披露保持在 PR 正文。

推送最终头并获取 merge delta 有效代码评审后，按本轮 Lead 指令冻结该头并请求 exact-head full CI，再使用 needs_review 交卷。不得将 CI Scope OK 当完整 CI，不合并或部署。
