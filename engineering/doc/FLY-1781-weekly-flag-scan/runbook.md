# FLY-1781 每周 flag 裁决落账 — Runbook

Issue: FLY-1781 (https://linear.app/geoforge3d/issue/FLY-1781/flag治理b3第4批-每周扫描-摆出候选问-annie留清-退役出口主体永不自动删)
日期: 2026-08-16
基于: plan.md

## 边界

扫描只摆出候选，永不自动删除 flag，也不自动创建清理执行单。HTML 留言保存在浏览器本地；Annie 点「复制全部」后仍需贴回 Discord，由 Engineering Lead 汇整。

## 裁决落账

1. 把每条回复写入 `engineering/doc/flag-governance-ledger/<run-date>-verdicts.json`，字段为 `flag`、`verdict`、`runToken`、`decidedAt`、`canonicalDigest`；`keep` 另需 `reason`，`clear` 另需 `execIssue`。
2. `clear` 先按动作性质开执行单：机械清理可批量，破坏性变化逐 flag 独立开单。不要复用周批量裁决单作为执行单。
3. 在 Bridge 机器上先跑只读生产绑定核验，并把 `EVIDENCE` 输出贴进实现 PR：

   ```bash
   node scripts/verify-flag-verdicts.mjs --preflight \
     --db "$FLYWHEEL_STATE_DB" \
     --verdicts engineering/doc/flag-governance-ledger/<run-date>-verdicts.json
   ```

4. 人工编辑 `registry.ts`：

   - `keep`：写 `longTermKeep: true` 与 `keepReason: "<decidedAt> [flag-scan:<runToken>]: <reason>"`。
   - `clear`：写 `retiring: "<execIssue>"`；若原来有 keep 字段，必须在同一 commit 删除。

5. CI / 提交前运行只读源码核验：

   ```bash
   node scripts/verify-flag-verdicts.mjs \
     --verdicts engineering/doc/flag-governance-ledger/<run-date>-verdicts.json
   ```

6. verdict 文件、preflight evidence、registry 修改随同一 PR 审查。合入后在周批量单贴逐条回执并关闭；未回答的 flag 不改 registry，下周会再次出现。
