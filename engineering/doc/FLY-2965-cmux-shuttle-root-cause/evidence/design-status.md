# FLY-2965 设计进度 — 实施计划
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: ../plan.md

- Design review question: f66d007c-7848-4749-bec6-dbe37dd8d892.
- Registration accepted: request b815ef28-95a7-40e8-8d45-57bcb2d40eea, skipped=false.
- R1 effective verdict CHANGES_REQUESTED. All 10 findings addressed in R2; no effective approval claimed.
- Lead response ebebee54-3be9-480e-baf1-207653825040 endorses full 17/17 shared sampling after deployed-sha / ordinary admission recovery. Requested lock and timing analysis added. R2 review registered after commit 676195a47.
- R2 question: 085a3334-afe9-4117-b0e4-dea38e35a256; accepted request: 742caa90-6a3b-46e1-9900-bbafe601263c, skipped=false. Effective verdict CHANGES_REQUESTED; Lead decision 6b8154c1-6b34-4c1c-a79d-7c2e3b667293 permits required pending-target convergence retries and retracts prior no-retry direction. R3 addresses all three findings in commit 05a467366.
- R3 question a0561884-9d84-48ce-a16a-0e4bc1ce8ec4; request c6796e5c-2655-4855-b5a2-832610b8563d accepted, skipped=false. Effective verdict APPROVED (reviewerVerdict also APPROVED), 2026-09-27 18:16:53 UTC. Evidence: review-round3.json; one LOW advisory reported as 2ad5c757-88b4-4a0c-a8c9-1f9b1e128022.
- R3 Lead completion report 0c5f3304-70a5-495d-8ca3-87af0e37cd67.
- Lead completion report: 56c22ef2-ebda-47a1-b390-5af31e35e704 (durable queue accepted; immediate doorbell timed out).
- Initial investigation evidence was narrowed by Lead question response 636563a8-8c87-4f98-a0c1-112fd7487174: incident PID 64360 was the Python wrapper. research.md records the original ps excerpt and provenance.
- Real tmux + private newline-server model reproduced the external stdout descriptor / EOF dependency; protocol-repro.json is the result. This is not a production cmux stack capture.
- No product source edited. No production restart, deployment, ship approval, PR merge, or successor dispatch.
- HTML syntax and Node VM DOM stand-in checks passed; not browser QA. Chrome DevTools new_page was refused: "MCP tool call requires approval, but approval policy is never".
- mmdc ran twice locally with required standard arguments and failed with MachPortRendezvousServer Permission denied (1100). Retained flow.mmd, failure log, and required DIAGRAM PENDING LOCAL RENDER placeholder. No remote render.
- Final HTML commit 863fbdf61 pushed and published: https://fw-reports-6da062.vercel.app/r/feb2a3171f3c67fca31d46494d64fcaf/
- Hosted HTTP 200, minted nonce/CSP match and source constraints verified in hosted-report-check.json. Lead URL receipt 0f71b003-9a7b-4e30-a71d-d3f426f9fba0. Remaining: exact phase_design_complete command then park.
- If CHANGES_REQUESTED, address blocking findings without implementing product code, then open/register a new review.

- LOW advisory resolved by Lead reply to 2ad5c757-88b4-4a0c-a8c9-1f9b1e128022: retain original confirmed-fail precedence over later unproven; add J regression; no reopened review. Recorded in review-result.md for Implement.
