# FLY-2912 QA 返工 — 验证记录
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-26
基于: plan.md, implementation-verification.md

## 返工依据与范围

QA attempt 1 在 `6ca5af36a77cff6d2ce400c305829f866d1f2e34` 报 FAIL，控制器 claimId/serverSeq 1610。返工 request `rework:11097af6f45e6becd46a3f62421be0d99c35c868e9b955daa9e56a720f9edb18`，实现 TURN epoch 9 / attempt 2。本轮只修查询审计证据和回放台架/报告，不改已批准设计或生产通知策略。

## 根因与修复

1. `fly2139-query-plans.test.ts:422` 可稳定复现文档哈希过期。真实查询集合的摘要为 `dd3d6bda6854964621df51d348e9ce40011136708772387c741e5dcfb557d327`；原文档仍为 `a94e31c8…aa462`。从测试输出重新生成证据块，保留 checker 和索引要求。红灯 1 failed / 1 passed，修复后 2 passed。
2. 原回放把全部事件积压到 04:01Z，再按 batch 上限排空。新回放按冻结源事件秒级时间推进：同秒输入同 tick，逐 tick 经实际 queue/Claude adapter 投递。明确采用“载体空闲、成功提交后模拟接收端即时 ACK”的台架假设，避免时间推进制造并不存在的 lease retry；这不是真实模型消费证据。每条 model 输入都断言投递时间与源时间相同；audit 原账不伪造 ACK。
3. 原回放给 stage payload 加入 `replay_unverified_projection`，使未知字段守卫必定触发。新回放逐条断言发送 payload 等于冻结 raw payload，不加字段。历史 obligation state 未导出，不能以空测试库伪造 action=none：在 producer proof 持久化边界明确替换为 action=unknown，再经过真实 policy 和持久化。这个台架替换点在结果 assumptions 中公开，不能用它宣称历史静默收益。合成 producer 正反例仍在独立单测，不混进 257 条真实分母。
4. 去掉未知 payload 后，发现原 C 世界也没有真的关闭开关：`initializeFlagStore` 的环境参数没有设置项目级 `lead_token_savings`。改用隔离 StateStore 的 `applyScopedFlagValueChange`，并通过生产 reader 断言 A/B=ON、C=OFF。旧比较中 OFF 的标签不成立。

## 真实时间序列口径

原 `99/121/121` 是旧台架排空份数，现作废，不能用作节省或开关回滚证据。完整 257 输入、7 个导出文件及哈希保持不变。新结果见 `evidence/replay-result.json` schemaVersion 2。

另按 `carrier-observation.json` 的真实时间及输入身份核对 99 次历史 consumed user inputs，其中 32 次没有窗口内 source join。12 次输入仅由 stage/startup 组成；其中 7 次具备时间相符的 workflow binding 结构。每一组的来源和保留理由写入 `observedInputAnalysis.cohorts`。

`99→92` 只是“7 组缺失的启动/owner/待办证明全部补齐，且原输入分组保持不变”的条件估计；`99→87` 是忽略全部 12 组权限缺口的乐观下限。两者都不包含旧 audit 变为 model 的新输入，也没有重建载体忙闲，因此不是净唤醒次数或实测节省。生产 afterObserved 保持 null。缺证样本仍保守 model，无法恢复的证明不靠默认值补造；延续 Lead question `aa046fc1-d883-44ff-8510-8eb27eedb337` 的既定裁定。

## 其他 QA 红项与验证边界

- Retention 两个超时用例在原 15s 阈值定向通过：批量提交/恢复约 1.05s，partial-apply/恢复约 0.98s。未改代码或放宽时间阈值；CI 原因仍未证明。
- `qa-fly-1986-load-probe.test.sh` 在当前受限环境无法读取 `ps` 进程身份，出现 `could not read identity for pid`，未完成通过。中断本次测试（exit 130），没有伪造身份或改变 guard。这个环境失败不能解释 CI 的 `incomplete_expected=3`；下一冻结头仍需 QA 在 full CI 核对。
- 只改测试和文档，没有 API/export/type 变更；消费者匹配与逐项排除理由见 `evidence/rework-consumer-audit.json`。没有新增 shell 测试，不跑本机全包套件。
- 本轮 lint、受影响包及依赖构建已通过。回放最终结果和交卷头的 review/CI 由下方最终验证补齐。
- 双载体真实模型消费、529 N-to-N 及冻结头 full CI 由 QA 重测。本轮不派 QA、不申请 full CI、不合并、不部署。

## 最终定向验证

- 查询审计：2/2 passed，包含丢索引反例。
- 修正回放：vitest related src/__tests__/fly2912-evening-replay.test.ts --run，2/2 passed；校验七份 hash-frozen exports、257 个原 ID/顺序、原始 stage payload、真实 scoped flag、逐源时间投递、业务副作用 ON/OFF 一致、基线 model 输入同 tick 保留及 99 个历史输入分组。
- A/B/C 的 model 候选为 169/257/257，实际 chronological adapter 提交为 158/224/224；三者最大入队延迟均为 0（确定性 tick）。141 条目标输入仍有历史证明缺口，B 中 88 条旧 audit 保守变 model，逐条列在结果中。这个缺证上界不是生产回退，也不是节省。99 个原观察输入在保守比较中全部保留。
- Retention：两条 QA 点名用例通过，另外 12 条未选中，不称为整文件通过。
- pnpm --filter "flywheel-teamlead..." build 通过；无 API/export 变更，不额外执行 dependent typecheck。
- 日志及哈希见 evidence/rework-verification.json。load-probe 环境失败单列，不称为绿色验证。后续 exact-head full CI/529/实际模型消费仍由 QA 验证。
