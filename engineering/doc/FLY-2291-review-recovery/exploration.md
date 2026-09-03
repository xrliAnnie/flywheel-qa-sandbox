# FLY-2291 审查输出修复与会话恢复 — 探索
Issue: FLY-2291 (https://linear.app/geoforge3d/issue/FLY-2291/审查no-verdict-续写审查员会话连续输出缺尾括号的-json-parser-判-no-verdict且坏会话被新一轮继承粘住2269)
日期: 2026-09-03
基于: 无

## 问题边界

FLY-2269 的同一 Claude 审查员会话在 R2–R4 连续返回几乎完整的 verdict JSON：内容从 `{"verdict"` 开始，结尾只缺一个收尾 `}`。现有平衡对象扫描找不到候选，因此把可恢复的真实判决记成 `no_verdict`。新 review job 又继承最近一次 reviewer session UUID，使同一坏输出形状跨 requestId 延续。

本任务只修两条现有路径：

1. 在现有 verdict 提取器中对只差 `}` 或 `]}` 的尾部做有界补全，并留下可审计标记。
2. 同 execution + review type 连续两轮 `no_verdict` 后，下一轮不再继承坏会话；新会话 prompt 携带近期 findings 摘要，并让既有 alert 给出与该失败形状一致的恢复说明。

## 锁定约束

- 不重新诊断已由 issue 与 Lead 指令确认的根因。
- 不新增告警层，不增加配置开关；恢复阈值与补全边界写死并 fail-closed。
- 补全只允许追加 `}` 或 `]}`，不能把真正截断的半截内容误判成 verdict。
- 补全后仍走既有 verdict 枚举、findings 与 SHA 校验。
- 修复不能静默：job 的审计字段必须记录 `repaired_trailing_brace=true`。
- 会话切换不能丢失审查上下文；prompt 必须包含前几轮 findings 摘要。

## 验收表面

| 表面 | 必须证明的行为 |
| --- | --- |
| parser | 完整 JSON 正常解析且不打 repair 标记 |
| parser | 缺 `}` 与缺 `]}` 均解析成功并打 repair 标记 |
| parser | 缺失大段内容仍返回 `no_verdict` |
| 真机夹具 | `~/.flywheel/artifacts/fly2269-r{2,3,4}-raw.txt` 原文均可重放 |
| coordinator/state | 连续两轮 `no_verdict` 后第三轮 job 使用新 reviewer session UUID |
| prompt | 新会话收到前几轮 findings 摘要 |
| alert | `no_verdict` 连败说明已自动换会话，不再建议同 requestId 重试 |

## 明示假设

- “连续”按同 execution + review type 的持久化 job 时间顺序计算；任意非 `no_verdict` 结果会打断连败。
- parser 的公共测试缝是 `parseClaudeReviewOutput`；会话恢复的公共测试缝是 coordinator 接受 review request 后可观察的 job/runner/alert 行为，不直接测试私有 helper。
- 既有数据库迁移机制负责兼容已有 state DB；新增审计字段必须有迁移与读写覆盖。
