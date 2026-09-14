# FLY-2533 快照阶段协议 — 代码评审
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: implementation.md

Effective review: APPROVED at ffc000392b933938f4538da2f7b7afa1257d8281. Request 35877707-9559-40e2-81f1-6206ec6b4bce (Bridge auto-requeued after c62c77846 moved). Question b62cf4aa-ab3b-44d4-8748-51a67e4bffd6. Reported advisories to Lead in 04131f13-7ef7-4607-814b-0bfe32f594ac; no non-blocking scope expansion.

- MEDIUM `phase-block-type-mismatch-rejects-cross-type-roles`: A node whose role file belongs to another node type now fails to start
- MEDIUM `prebuild-depends-on-engineering-doc`: Building teamlead now needs a design doc under engineering/doc
- MEDIUM `projection-version-skew-fail-closed`: Exact-block matching ties the project repo's copies to the Bridge's protocol version

This verdict does not cover later QA text-anchor/fixture corrections. Fresh review and CI are required for the next head. Local aggregate timeouts and actual slot B/C acceptance remain separate evidence.

## Second exact-head review and CI rework

Question `e4d9f435-86eb-4081-9be9-c929b6c4a06a`, request `3ccad0fa-4170-474e-9cf0-11d761e0f0e4`, round 3 returned effective APPROVED at `03b82adb8edb9f8cb2d809968929c0fff424e01b`. The same three MEDIUM advisories remained non-blocking; report receipt `4c4594b8-0b4e-45b3-a970-61de71bbaab0` relayed them. No review was pending when subsequent CI corrections began.

CI `34790408140` failed existing protocol command-shape, legacy-name, kill-path inventory and cross-type fixture checks. Subsequent changes need a fresh exact-head review and CI. Lead approved fixture-only alignment via response `0dbcf315-f17c-4d3d-85e2-f47c8f96a8ed` to that report and question `e36b31da-e035-4083-80c6-ec1ed947469c`, additionally requiring real production type/role coverage. That new test passes. Runtime strict projection validation and the pinned plan remain unchanged.
