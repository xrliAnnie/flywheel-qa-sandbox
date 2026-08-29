# Design Review — prd.md (Round 5)

Status: CHANGES REQUESTED (verbal — run interrupted mid-write, no file persisted)

3 items, all folded in commit 30e5c6a1:
1. workflow_node_outputs lacked an implementable producer/write/replay contract → added §5.6 contract (independent write channel, write-before-complete, output-present fail-closed, issue-level persistence decoupled from marker, upsert idempotency) + S15/S16.
2. §5.2 residual repo-wide "no frontmatter parser" overclaim → narrowed to Runner dispatch path.
3. §11 said 5 surfaces → corrected to 8 (§2.3b).

R6 (confirm) = APPROVED.
