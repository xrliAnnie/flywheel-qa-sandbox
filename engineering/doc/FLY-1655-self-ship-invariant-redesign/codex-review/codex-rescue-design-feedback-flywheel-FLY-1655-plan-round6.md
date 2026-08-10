# FLY-1655 terminal-land 设计复审 R1 — CHANGES_REQUESTED

Issue: FLY-1655
日期: 2026-08-09
Plan commit: `1230a282`
Question: `e04fa75f-653a-4636-992d-13679b3e47b6`

## Blocking finding

- `land-on-claimless-graph-subject-conflict` (HIGH):四个非 code menu 只有 `founder_approved` claim；若直接切 land，evidence 仍是 `snapshot_digest`，而 land 要 `git_head`，gate transaction 会抛 `workflow_gate_subject_contract_conflict`。修正：claimless land 使用 completion head，但必须严格匹配唯一 current PR binding；不写新授权材料。

## 已折入的 advisory

- 枚举 schema-v2 land 的 validator/build/parser 全改面。
- land-aware ship bundle validator排除 engine land。
- founder transition删除字面量 `"land"`，改用 manifest terminal node。
- land snapshot图级降级上游 runner ship capabilities，registry/frozen snapshot不改。
- 写清 frozen runs、bundled/current revisions、custom templates三类 cutover。
- nested repo明确 out of scope与人工 hold/terminate路径。
- snapshot-less `qa_verdict` 时间戳只作审计，`permanent=1` 保证不过期。
- `unknown/source` 均不能推进 production deploy receipt；保留 unknown fail-close。
- founder批准只认 card reaction或可解析的直接短回复，删除现行 `SHIP-VERDICT:` 引导。
