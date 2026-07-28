# FLY-1498 门与图 — 代码评审 R7
Issue: FLY-1498
日期: 2026-07-28
基于: `qa/qa-report.md`@fa4c0273066f346389ef6a83b3511635ab966670

## Verdict 与精确绑定

PR #717 的 request-driven cross-family code review round 7 返回
`APPROVED`，且 reviewer 原始 verdict 同为 `APPROVED`：

| 字段 | 权威记录 |
| --- | --- |
| gate question | `9e4ef3e0-dee2-4794-a936-6c5609769e55` |
| request | `dd617d42-08c2-45e8-bfca-c012f2714a25` |
| reviewed head | `fa4c0273066f346389ef6a83b3511635ab966670` |
| author family | `codex` |
| reviewer family | `claude` |
| structured verdict | `APPROVED` |
| reviewer verdict | `APPROVED` |
| approved at | `2026-07-28 11:36:28` |

`codex_review_job` 保存 request、question、round、冻结 head 与双 verdict；
`codex_review_record` 对同一 request/head 保存
`author_family=codex`、`reviewer_family=claude`。两族不同，因此本轮是可审计的
cross-family review，不是同族记录。

本轮没有 HIGH finding。结构化策略
`medium_low_findings_are_non_blocking_v1` 将下列 MEDIUM/LOW 保留为 advisory，
不改变 `APPROVED` 的有效 verdict。

## PR #717 code-review 轮次索引

下表来自同一 execution 的 `codex_review_job`。R2–R7 的 approved record 均在
`codex_review_record` 中保存 `author_family=codex`、
`reviewer_family=claude`；R1 为 `CHANGES_REQUESTED`，不能冒充 approved record。

| Round | request | question | reviewed head | verdict |
| --- | --- | --- | --- | --- |
| R1 | `15b9e238-9ad9-404d-8d04-e98fb4be0b0b` | `af0421fe-8b9e-4072-aa63-913546c89957` | `5c6a755e30a68b6d0cc44789d81d577ac3fddfb9` | `CHANGES_REQUESTED` |
| R2 | `e335d77f-3c53-45bd-969d-76975ed5ba3c` | `94cc9715-3048-4018-96a0-46505baa1108` | `c777ccae0d92fa9d7c1815aa4169b369735b1416` | `APPROVED` |
| R3 | `d323b56b-d64b-4cb3-8f2a-78e36f63745f` | `91215628-0d42-465a-afc3-6fa57a1b3b26` | `04bf333507acac12ee6f9cf2bb8a9734ef263619` | `APPROVED` |
| R4 | `635432e7-6f7a-4b39-bf15-9608601f4250` | `c689a5b5-0de3-4668-8f28-e6576d2f34e1` | `6b242067a3b49f03fed02a1a163e05296071b301` | `APPROVED` |
| R5 | `ba55a738-2306-4eab-85fc-74705dc103a6` | `7d9e7ab9-3a21-4c3e-ac91-dd9000714b0b` | `92e7cbf61175701a7ad677060b43e102781767a4` | `APPROVED` |
| R6 | `92ea6518-abd1-4f99-ad99-4ec7a4b1a78e` | `90c02c26-b577-4728-b9e8-ea7098b8e6a1` | `317c1afbc944c00f3296d4a638a936117f780f36` | `APPROVED` |
| R7 | `dd617d42-08c2-45e8-bfca-c012f2714a25` | `9e4ef3e0-dee2-4794-a936-6c5609769e55` | `fa4c0273066f346389ef6a83b3511635ab966670` | `APPROVED` |

## Finding 索引与处置

以下保留每轮结构化 finding key，避免 verdict 只存在于消费方访问不到的库里：

- R1 HIGH：`span-anchor-base-case`、
  `ci-axis-removal-assumes-branch-protection`。两项均在 R2 前修订；完整 R1
  finding 与处置见 `code-review-pr717-r1.md`。
- R1 其余：`gate-tip-source-undefined`、
  `gates-thread-bindings-migration-gap`、
  `founder-html-stale-vs-approved-design`、
  `attempt1-capability-not-pr-bound`、`span-tip-nonancestor-rebase`、
  `default-action-agent-id-repo-controlled`、
  `approval-provenance-no-artifact`、`writer-chain-key-scope-ambiguous`。
- R2 新增/遗留：`required-checks-scope-vs-v1-probe`、
  `activation-probe-credential-and-endpoint-unspecified`、
  `gate-refresh-head-observation-unspecified`、
  `ci-probe-drift-after-bootstrap`、`final-lost-open-span-tip-wording`、
  `adoption-attribution-family-for-preexisting-commits`。
- R3 新增：`author-set-exhaustion-deadlock`、
  `selftest-misses-new-m1-checks`、
  `old-vocab-negation-heuristic-too-broad`、
  `qa-report-check-count-stale`、`dead-loop-in-consistency-checker`。
- R4 新增：`same-family-routing-defect-not-tracked`、
  `review-round-records-incomplete`。
- R5 新增：`checker-locale-dependent-cjk-splitting`。
- R6 无新的 finding key；R3 的 author-set exhaustion、M-1 阴性对照与旧词
  匹配，以及 R5 的 locale 依赖均已在 R6 head 前按 Lead 裁定关闭。
- R7 新增：`qa-pass-head-binding-lags-current-head`。Lead 随后从权威库核验
  QA credential 51：`consumed_at=2026-07-28T11:22:27.800Z`、
  `expected_subject_digest=fa4c0273066f346389ef6a83b3511635ab966670`、
  `revoked=0`，因此 QA PASS 的当前权威绑定就是本轮 reviewed head。

R7 仍携带的 advisories 为：

- MEDIUM：`same-family-routing-defect-not-tracked`、
  `review-round-records-incomplete`、
  `gate-refresh-head-observation-unspecified`、
  `required-checks-scope-vs-v1-probe`、
  `activation-probe-credential-and-endpoint-unspecified`、
  `ci-probe-drift-after-bootstrap`。
- LOW：`qa-pass-head-binding-lags-current-head`、
  `dead-loop-in-consistency-checker`、
  `author-set-exhaustion-deadlock`、
  `final-lost-open-span-tip-wording`、
  `adoption-attribution-family-for-preexisting-commits`。

本归档只做三件事：保存 R7 的 exact-head/cross-family 证据、补齐 R1–R7
verdict/finding 索引、记录 QA 的权威绑定。它不把仍列出的 advisory 宣称为已修，
也不修改设计正文、QA harness、checker 或任何产品产物。
