# FLY-2749 纯通知停止唤醒 — 评审后续项
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749)
日期: 2026-09-18
基于: plan.md

有效 reviewVerdict=APPROVED；requestId=c6c482ed-dade-453d-acc7-13825179194e，questionId=a89021c5-8393-4d3c-b180-b2a2b908616d。以下为非阻断建议，完整原文保留在 review-receipt.json；已向 Lead 报告，由 Lead 决定后续处置。未将建议冒充已完成修复，未重新定义批准方案。

| findingKey | 级别 | 后续项 | 处置 |
|---|---|---|---|
| audit-row-no-terminal-state | MEDIUM | audit 行停在 QUEUED 后没有终态,现有归档门无法满足 | Follow-up：已报告 Lead，尚未实施 |
| rollback-replays-audit-queue | MEDIUM | audit 行对旧二进制 fail-open,回滚代码会把历史静默内容整批投给 Lead | Follow-up：已报告 Lead，尚未实施 |
| relay-duplicates-disposition-receipt | MEDIUM | 新建 notification_relay_receipts 与现有 FLY-1282 thread 回执管线重复,不符合「不另起机制」 | Follow-up：已报告 Lead，尚未实施 |
| done-receipt-no-producer | MEDIUM | 结构化 DONE receipt 没有任何生产者,存储列和冲突语义也缺位 | Follow-up：已报告 Lead，尚未实施 |
| mailbox-log-event-check | MEDIUM | mailbox_log 的 event 有 CHECK 约束且只能追加,「写 mailbox_log 审计」不是增量 schema | Follow-up：已报告 Lead，尚未实施 |
| phase-duty-free-first | MEDIUM | 建议拆期:先上线无转报义务的类别 | Follow-up：已报告 Lead，尚未实施 |
| inv10-relay-exclusion | LOW | 类型表需要逐类绑定 relayKind,并写明 INV-10 排除项 | Follow-up：已报告 Lead，尚未实施 |
| review-audit-side-effects | LOW | REVIEW 静默的附带效应没有写明 | Follow-up：已报告 Lead，尚未实施 |
| runner-writable-disposition | LOW | claim 过滤信任一个 runner 侧也能写入的列 | Follow-up：已报告 Lead，尚未实施 |
| kill-switch-no-replay | LOW | 关开关不能挽回已被误静默的待办 | Follow-up：已报告 Lead，尚未实施 |
| plan-frontmatter | LOW | 计划缺少 CLAUDE.md 要求的 Version/Status 元数据 | Follow-up：已报告 Lead，尚未实施 |

元数据说明：本次动态 DOC-FLOW 明确要求 title、Issue、日期、基于；现有文件保留这一格式。plan-frontmatter 建议不覆盖动态合同。

交接注意：APPROVED 仅代表设计门禁通过；上述回滚、持久队列、既有机器转报复用、receipt 生产者等建议仍需实现者和 Lead 逐项明确处置，不能在实现验收里静默略过。

## Lead 最终处置
Lead response `0f01abd7-c1ce-4907-8c0e-9cdafb0df32d`：11 条 advisory 不挡交付，不单独开单；全部带入后续 PR 的 Follow-ups。实现体按本单范围处理 `relay-duplicates-disposition-receipt`：复用现有 `disposition-receipt`，不另起 relay。其余留记录。此处是 Lead 的后续实施指令，不把未实现项标成已修复。当前分支没有 PR，设计节点不新开 PR；实现者创建 PR 时转录本清单。

## 精确 HEAD 代码评审处置（2026-09-20）

`ceea9d20776fe99eae7b531c3dd848a012ed13d9` 的代码评审 `736d3dbf-7935-4f56-8b4e-906d77d25662` 得到有效 `reviewVerdict=APPROVED`，含 4 条 MEDIUM、4 条 LOW 非阻断 advisory。Lead 回执 `0f5111f4-648b-480a-9869-a9b000da7c8a` 要求本 PR 只修其中两条，并把其余六条保留在 Follow-ups；这次修订不把其他 advisory 顺手扩入范围。

| findingKey | 级别 | 处置 |
|---|---|---|
| review-owner-proof-vacuous | MEDIUM | 本 PR 已修：只有与同一 source event 绑定的真实 reviewer instruction 才提供 owner proof；缺 plan 校正、skip、裸 `code_review` 均保持 model。增加会变红的 producer-path 断言与 exact instruction 正/负例。 |
| audit-ack-fabricates-delivery | LOW | 本 PR 已修：audit-only question 可进入业务终态，但 compatibility projection 的 `read_at` / `delivered_at` 保持 NULL；projection 版本升级并覆盖 reopen migration。 |
| audit-report-rows-never-terminal | MEDIUM | Follow-up：不在本次窄修订实施。 |
| mailbox-index-rebuilt-every-open | MEDIUM | Follow-up：不在本次窄修订实施。 |
| flag-readsites-drift | MEDIUM | Follow-up：不在本次窄修订实施。 |
| inherited-action-resolved-by-liveness | LOW | Follow-up：不在本次窄修订实施。 |
| runner-stop-declaration-read-unguarded | LOW | Follow-up：不在本次窄修订实施。 |
| decision-route-guard-narrowed | LOW | Follow-up：不在本次窄修订实施。 |

## 第二轮代码评审处置（2026-09-20）

`1a20fdfac9b5064689c03f499bbcb5e75989508e` 的代码评审 `b7778e1c-5603-40f7-91c7-ab30619f5aa1` 再次得到有效 `reviewVerdict=APPROVED`。Lead 回执 `8c5cec74-f175-4800-b534-36f882d7a272` 指定本 PR 再修两条新 MEDIUM；新 LOW 与所有 carried follow-up 继续延期，并明确此后同类新 advisory 直接进入 Follow-ups、不再扩本单修订。

| findingKey | 级别 | 处置 |
|---|---|---|
| projection-version-bump-refires-backfill | MEDIUM | 本 PR 已修：一次性 legacy-push backfill 使用独立持久 marker；现存 v2 marker 视为已完成 receipt，未来 view shape 版本变化也不会重新武装 backfill。新增 v2→v3、live pre-notify claim 保持 NULL 的回归。 |
| review-owner-ref-statestore-throw-unguarded | MEDIUM | 本 PR 已修：StateStore manifest lookup 与 CommDB lookup 统一包在 fail-open 边界；任一读取抛错都返回无 proof，使事件如实走 model 并保留 Lead event。 |
| review-owner-ref-runs-when-flag-off | LOW | Follow-up：按 Lead 裁定不在本次最终修订实施。 |

Round 1 已列出的六条 carried follow-up 处置不变；没有把它们重新表述为已修复。
