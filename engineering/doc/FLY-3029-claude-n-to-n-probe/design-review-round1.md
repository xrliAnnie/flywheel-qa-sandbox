# FLY-3029 Claude N-to-N 探针 — 设计评审第 1 轮
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: plan.md

## 评审身份

- Gate question: `8077158a-1675-4217-8787-2577fcd9d903`
- Request: `072d4977-693e-467b-bd41-64bff7b1f876`
- Effective verdict: `CHANGES_REQUESTED`
- Reviewer verdict: `CHANGES_REQUESTED`

## Finding 处理

| Finding key | 严重度 | 处理 |
|---|---:|---|
| `inbox-hardcoded-design-exec-id` | HIGH | 两处 inbox 全改为运行时 `$FLYWHEEL_EXEC_ID`，并明确禁止消费其他 phase/body 的信箱。 |
| `resume-after-body-swap-treated-as-failure` | MEDIUM | 把“存在即失败”改为 main 冲突 / issue 分支可信续跑 / 来源不明三分支；probe commit 与 push 后各写 progress cursor。 |
| `head-commit-assertion-brittle-vs-progress-commits` | MEDIUM | 用精确 subject 恢复 probe SHA，验证它是 upstream 祖先；不再假设 HEAD 是 probe commit。 |
| `apply-patch-vendor-specific` | MEDIUM | 改成 runner 原生精确编辑工具：Codex `apply_patch`、Claude `Edit`，以 diff 结果为合同。 |
| `consumer-audit-list-incomplete` | MEDIUM | 重跑全仓搜索并审计当前 21 个可执行/配置 test/QA 匹配；计划不再固定数量，要求现场逐项记录。 |
| `lint-step-unaddressed` | LOW | 记录定向 Biome 检查的 `0 files` / ignored / exit 1，说明 Markdown 不适用，不跑无关全仓 lint。 |
| `no-final-newline-check` | LOW | 增加最后 byte 必须为 hex `0a` 的断言。 |

## 复核要点

- 未修改 `README.md`，仍停留在 design 范围。
- 变更保持单行 probe 的原始任务，不引入脚本、运行时代码或生产派发路径。
- 新 review 必须使用新的 gate question 与 request id；本轮 CHANGES verdict 不可复用为批准。
