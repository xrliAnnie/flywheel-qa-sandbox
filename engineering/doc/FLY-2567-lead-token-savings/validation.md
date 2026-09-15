# FLY-2567 Lead token 节省 — 调研
Issue: FLY-2567 (https://linear.app/geoforge3d/issue/FLY-2567/leadtoken-常驻-lead-一天烧-40-亿缓存读-token从lead-为什么这么耗的目标出发做设计找出并砍掉主要浪费源lead)
日期: 2026-09-14
基于: plan.md

## Design artifact validation

- Data replay: fixed prefix 87,544,743 bytes; SHA-256 `8c7120badabebe8c1a6a77e08f241b0bab27319d6d06d3e2ce0f46a682457de8`. Re-ran analyze-transcript.py into `/tmp/fly2567-replay`; `summary.json` and `requests.csv` cmp identical. 3,893 unique requests across three UTC days; usage conflicts 0. All source categories sum exactly to daily totals.
- HTML structural/controller checks passed with installed happy-dom 20.10.6. Ten sections, each with a comment input. Test covers pathname-scoped storage, blocked localStorage, >1,800-character feedback splitting, exact marker on all four generated chunks, clipboard absent and rejected fallbacks, and injection text remaining text.
- Verifier: `FLY2567_HAPPY_DOM_MODULE=<installed happy-dom module path> node engineering/doc/FLY-2567-lead-token-savings/verify-founder-html.mjs`. If installed in the checkout, omit the environment override; no new dependency was installed.
- `git diff --check` passed. No runtime source edits; production/runtime tests and exact-head implementation CI are not claimed.
- Mermaid CLI attempted each diagram twice with standard `-w 1000 -b white --svgId FLY-2567-d1|d2`. Both failed at Chromium `MachPortRendezvousServer Permission denied (1100)`. Saved final failure logs in evidence/. HTML explicitly marks both diagrams `DIAGRAM PENDING LOCAL RENDER`, includes Mermaid source, and uses no fake diagram or remote rendering. Browser visual QA not performed.
- Snapshot helper: checkout dist absent; main checkout helper returned snapshot_owner_unavailable. No live DB was copied. Bootstrap current-state supplement used a short readonly SQLite transaction and closed the handle; it is not historical state proof.
- Review and publication receipts will be recorded after the effective gate and hosted checks. No production reduction, founder-message delivery, or deployed parity claimed by these artifact checks.

## R1 revision validation

Accepted HIGH `autocompact-200k-below-context-floor`; recomputed all six post-compact first inputs, excluded synthetic zero-usage responses from model-request denominators, and removed unsafe 150k/200k rollout and savings assumptions. Native-window activation now requires measured matching baseline, at least double-floor plus200k working-headroom condition, real CLI argument probe, and isolated frequency/latency replay before any live projection. Updated HTML/controller checks pass. R1 MEDIUM/LOW findings are retained as explicit non-blocking implementation follow-ups; table-name and quote errata corrected.

## Effective design review

R2 question `aec71bb6-39e2-4700-89e0-d57c8a9f0c87`, request `171e01af-da77-480f-a4b5-6137a598bf68`: effective reviewVerdict=APPROVED, raw reviewerVerdict=APPROVED. One R1 HIGH resolved. Seven R2 advisories remain non-blocking and are retained verbatim in review-receipt.json for Lead follow-up. The reviewed implementation plan is frozen; no new design round is requested for closeout.

## Hosted publication verified

Silent publish URL: https://fw-reports-624a39.vercel.app/r/8afc0df84093dd6fd32ba9f82e9d7b12/

HTTP200, nonce replacement, script/CSP nonce match, expected feedback marker, no external dependencies or inline handlers all PASS. Served script exactly matches committed source. publishOnly=true/messageId=null/delivered=false is the intended no-channel-message delivery. Mandatory DESIGN-HTML ready report sent to flywheel-eng-lead with receipt question `e92a05f4-b588-43ff-9090-b4810679d009`. Actual browser visual QA and rendered diagrams remain unavailable as recorded above. Approved plan SHA checked unchanged.

## Handoff obligations

Design phase only. Implement/QA owns code, exact-head CI and real Discord probes; Lead tracks D1/D7 after actual updater deployment, writing measurement-after.md with raw plus deduplicated/synthetic-separated ledger. No claimed production savings yet.
