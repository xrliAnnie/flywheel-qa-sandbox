# FLY-2737 authority and exact provenance

Date: 2026-09-18
Sources: Lead replies to `89ec6c1b-b9d6-4527-aea9-7e5e2c5e57e5` and `1fa1704c-52e2-406f-b506-0d53d0f04127`; founder quote in injected task. No independent Discord fetch is claimed.

Founder policy replacement message:
- Parent channel `1516209714097291335` (#flywheel-engineer).
- Issue thread `1550442575066955787` (FLY-2673).
- Message `1550543841961050283`.
- Founder user `1138241636057481306`.
- Timestamp `2026-09-18T16:27:39.635Z`.
- Quote: “好吧，你这个东西是这样子的。那个旧闸应该完整的删掉，我们根本就不需要旧闸。那不管是Auto还是Dry run都用的是新闸才对。那现在谁要去修？你把它开始吧。”

These exact IDs are the policy provenance. No guild ID or Discord URL is guessed. This policy message was in the issue thread; it is distinct from the protected top-level open/stop control message and must not be submitted to that control endpoint as an opening command.

Lead confirms no new opening receipt required merely for deployment, no current-mode mutation (auto per Lead report), decision_source=three_point_auto, and overall=can AND all three dimensions=pass. Any cannot/recommend_reject/undetermined, absent or expired evaluation gives opinion only. Existing control ordering, current-head/founder rejection/revocation guards remain mandatory.

## Formal review governance

Lead reply to `6ceeebd3-cdd8-4220-b07d-bff16c91404d` confirms ruling `3574f190-78de-4fcc-96aa-fd9f9d3cb303`, disposition `overruled`, issue FLY-2737, source request `44d89b7c-b6d0-482a-be24-c5495b383a1d`, finding index 0 / `consent-scope-reuse-without-fresh-founder-opening`. Founder 16:27:39Z message authorizes the policy replacement. No fresh opening or deployment mode change; all negative guards remain. A new gate/request is still required; Lead prose is not an effective review verdict.

Every approval envelope must keep two distinct proofs: policy replacement provenance (exact founder message, trusted original-content digest and policy version), and execution mode control receipt (ordered original opening/stop). The old opening never purports to authorize the replacement policy. Trusted message validation failing disables new approval writes without changing the mode flag. Rate-limit/circuit-breaker proposal remains a follow-up, with no automatic mode change in this task.
