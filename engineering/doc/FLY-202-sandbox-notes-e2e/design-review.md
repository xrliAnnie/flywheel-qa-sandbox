# FLY-202 QA 沙箱 fixture 笔记 — 设计评审记录
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: plan.md

---

## 结论

**APPROVED（Codex，2 轮，reviewer 模型 gpt-6-astra @ xhigh，Bridge 指定）。**
`await-codex-gate design` 已通过（Bridge 校验 requestId / plan 路径 / 已提交 plan blob / clean Git）。

| 字段 | 值 |
|---|---|
| exec | `814e38bd-26ac-400b-b208-f18015621d92` |
| Bridge manifest | revision 2，requestId `1f38c57f-b962-4b26-8004-d88321be2ec7` |
| 评审的 plan blob | `646f36123c3f25b25efa2516869abe4699dfffbd`（commit `e5b8067aa`） |
| Codex thread | `01a0dd83-5f4c-7c83-a0af-687037530f57`（已归档） |

## Round 1 — CHANGES REQUESTED（4 × P2，全部采纳）

1. **只数数量会放过事实错误**：`doc/qa/sandbox-notes.md` 第 2 段无条件宣称测试不碰
   生产告警队列，但 README（Alert Mirror 节）与 `scripts/test-deploy.sh`/`scripts/lead-alert.sh`
   表明只有 `--alerts` 才隔离 → 加入 V7 内容核对，并登记为已知红项（implement 必修）。
2. **同步/收尾顺序**：C1 改为四态同步；最终 ledger 先于 push；push 后三方 SHA 一致。
3. **空白检查时点**：拆成 V5a（提交前，比较工作区）与 V5b（提交后）。
4. **段落判定**：V1 从"数行"改为"按空行分块"，附两个自测样例。

另纳入两项合同补充：断言合同共用、实现独立；V2 排除表头并查描述非空；V8/V9；显式停止条件。

## Round 2 — APPROVED

唯一非阻塞注记（P3），**交给 implement 执行时遵守**（不改 plan，以免作废已批准的 blob）：

- V9 只看已提交结果，因此应在**最终 ledger 提交之后、push 之前**复跑 V5b、V9 和白名单检查；
- 把 `BASE` 的完整 SHA 与最终 HEAD 一起写进 PR #194 的核验记录，供独立 QA 进程使用
  （QA 不会继承 implement 的 shell 变量）。
