# FLY-2737 design verification

Date: 2026-09-18
Scope: design artifacts, not implementation or live product acceptance.

- Source baseline: `11bfba423`; reviewed current scanner/runtime/delivery/render, opinions freshness/rate limits, StateStore source boundaries, CommDB contract/writer, protected control, projector/land and read-side audit consumers. Source counts/time claims in incident remain supplied issue evidence.
- Founder scope: 16:27Z ruling supersedes both old narrow-policy brief and FLY-2399 original dry-run-only boundary. Lead `89ec6c1b-b9d6-4527-aea9-7e5e2c5e57e5` confirms no fresh opening required at deploy, no live mode change, distinct `three_point_auto` provenance, missing/expired/non-pass evidence fails closed.
- Artifacts initially committed `0e6d9bc13`; branch push successful. Only issue docs/progress changed; no product code, stash, production data/flag mutation or package-wide test.
- Local command `node engineering/doc/FLY-2737-three-point-auto/verify-founder-html.mjs`: PASS. Covers 11 sections/comments, script nonce placeholder, no external resource/inline handler/unsafe innerHTML, pathname-scoped guarded storage, live aggregate, 1800-character Unicode chunks, success/rejected/absent clipboard and fallback failure, denied storage and clear/reload isolation.
- Both Mermaid sources attempted locally, then each retried with `-w 1000 -b white --svgId FLY-2737-d1|d2`. All fail at Chromium bootstrap_check_in MachPortRendezvousServer Permission denied (1100). Sources retained; two explicit DIAGRAM PENDING LOCAL RENDER placeholders. No remote rendering, simulated SVG or browser visual pass claimed.
- Explicit design review opened `f67abe33-c70d-4a21-9d93-2d415d8cc348`; registration accepted `44d89b7c-b6d0-482a-be24-c5495b383a1d`. Effective verdict pending at this entry.
- Hosted verification pending effective approval and publication. Publication alone will not count as HTTP/CSP/source verification.

Acceptance matrix A–V in plan is required downstream evidence, not a claim that tests or live QA have been performed here.

## Resume and R1 disposition

- Resumed execution `b3159b98-3a05-44f2-84dc-cb7a24b92b7c` confirmed design TURN epoch 3 and preserved `4f4ea7381`. Applied exact recovery stash `a7d23074e3b3fef04be97e12c3bf282a983e19b5` on Lead instruction `5a1e09a7-ac1b-4ea9-a1f6-ee9abf95038f`; no stash pop/drop or indexed stash selection.
- R1 effective CHANGES_REQUESTED: one HIGH, five MEDIUM, two LOW. Original response preserved in `review-r1.json`. Lead reports overruled governance ruling `3574f190-78de-4fcc-96aa-fd9f9d3cb303` for the HIGH; next registered review must confirm effective disposition.
- Recovered amendments clarify exact policy provenance separately from mode receipt; pass-to-pass evidence goes through visible dirty/candidate delivery; already-frozen legacy messages migrate into new retirement state with old tables read-only; machine approval read consumers use durable proof without changing founder_review; founder page explicitly says code changes can auto-approve. Path and rendering fan-out advisories addressed. Approval rate/circuit-breaker MEDIUM stays an explicit follow-up per Lead.
- Live source sweep additionally confirmed founder-only consumers in CommDB founder-review insertion and approval-signal routing; plan keeps both unchanged.

## R2 evidence review and R3 target

- R2 request `60c2654e-0122-4de0-b2d6-ea3f51aca432`, gate `18dceb49-ab88-444f-8997-6be65ce3bc5e`, effective CHANGES_REQUESTED; full receipt `review-r2.json`. Two HIGH findings confirmed directly in evidence-ledger.ts, evidence-authority.ts, production-collect.ts, qa-source.ts and evaluate.ts.
- `alignment-passes-on-unverified-design-blob`: §4.3 now requires actual approved-plan blob identity and candidate equality, supports exact approved manifest or reviewed-commit resolution, and denies unresolved/mismatched proof in both display and writer.
- `coverage-passes-without-any-qa-report`: §4.3 requires actual bound QA report bytes and digest, identical frozen model source, explicit semantic pass and deterministic prerequisites; claim-only or semantic-undetermined cannot produce overall can. New versioned live evidence prevents a cached v1 pass from authorizing.
- Four advisory dispositions: documented current budget/capacity precondition and acceptance V; removed misleading mode/human-only/time copy in both render branches; compatibility comments for retained flag key; distinct machine integration suite with existing founder suite preserved.
- Lead reply `7ee58407-08bb-4abf-883e-01cefc07f212` accepts these corrections and limits design to R3: same-two-finding refinements may converge, any new HIGH goes to Lead ruling, no R4. No deployment, new opening ceremony or rate breaker.
- Updated local HTML verification PASS (11 sections, storage/clipboard/fallback/security shape); only docs changed. Mermaid limitation remains as previously verified; no browser visual validation claimed.

## R3 and authorized limited R4

- R3 request `822ddd7f-6e04-4237-bf1e-3f7f098d2cb3`, gate `3b1c1961-e052-45db-86b4-9b04d908a518`: CHANGES_REQUESTED; full receipt `review-r3.json`. HIGH `reviewed-plan-proof-has-no-durable-binding` confirmed: design jobs normally lack frozen_head_sha; manifest request IDs and job IDs are distinct; existing validation is stateless. No claim that a current manifest establishes reviewed bytes.
- Lead `f09355cf-d0a8-4e34-a0ed-2d42f7a72025` accepts the finding and explicitly authorizes limited R4, superseding prior cap. Fix is §4.4 plus independent implementation task 0: persist captured/validated/approved proof with typed lane identities, wire producer/validation/sealing/recovery, deny historical proof absence, require is_current fallback mutation red, and disclose sparse auto approvals at rollout. Model availability MEDIUM remains a follow-up/limitation, with no implementation expansion.
- Revised HTML controller verification PASS; original Mermaid limitations remain. New source reads were read-only; no product/production change or shipping action.

## Effective approved verdict

R4 gate `56465d49-b977-4cf0-be3b-3f5e1bb1dce6`, request `7d354432-5b03-4159-885e-35d989ec1d55`: effective and raw APPROVED. Exact response preserved in `review-r4.json`; three non-blocking findings and earlier follow-ups preserved in `handoff.md` and reported to Lead (report `06be9e6b-c16e-401a-b9f3-9e5a8f0d3ae5`). Plan bytes remain identical to the submitted artifact; approval is a separate receipt, not a plan edit. Local controller verifier and git diff --check passed again.

## Final hosted delivery and completion audit

- Committed final artifact `9a957c2fb` silently published as report `09906038aefe5d726d0ab0ba12b7506f`; URL https://fw-reports-42fba7.vercel.app/r/09906038aefe5d726d0ab0ba12b7506f/ . `publishOnly=true`, `messageId=null`, `delivered=false` correctly means no channel post.
- `verify-report` passed HTTP 200, zero nonce placeholders, script CSP/nonce and expected issue checks. Independent fetch at `2026-09-18T17:48:25.836Z` verified one script, exact source script SHA-256 `498c6d661130c49cb287cde07e70cdecd4f85a1bd4f1f8e5f2c5f719501c2441`, normalized hosted body identical to committed source, 11 sections, zero external assets, and two explicit pending-render placeholders. These are HTTP/source/controller checks, not browser visual QA.
- Mandatory DESIGN-HTML ready report delivered through `ask --report`, ID `e3651c20-b2f3-4582-bb76-62f894916c54`; full publication/verification evidence in delivery-receipt.json.
- Completion audit: combined exploration/research/implementation plan satisfies doc tier none; exact founder/Lead authority recorded; effective review approved; final HTML/comment layer/Mermaid fallback retained; final artifacts committed/pushed before publication; hosted source verified and URL reported; scoped follow-ups preserved. Remaining action is exact `complete --route phase_design_complete` then `park`, with no further shared-worktree writes after TURN transfers. Product implementation/live acceptance remain downstream.
