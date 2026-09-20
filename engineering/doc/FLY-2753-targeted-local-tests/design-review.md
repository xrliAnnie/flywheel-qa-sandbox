# FLY-2753 本机定向测试守则 — 设计评审结论
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md有效 verdict: **APPROVED**；reviewer verdict: APPROVED；round: 2。

- Gate: `92378e0f-a721-4723-a6f8-6065de1ded82`
- Request: `47cf7e4c-7caf-4cdf-a731-36cc8ec00ab5`
- Plan revision: `c76bfd366`；获批后不改变 plan.md 内容。
- Policy: `medium_low_findings_are_non_blocking_v1`。

## 非阻断建议

### MEDIUM — sync-script-name-collides-upstream

New synchronizer reuses the exact upstream path `scripts/sync-phase-protocols.mjs` for a tool with unrelated semantics

The plan creates `scripts/sync-phase-protocols.mjs` in this sandbox. That exact path already exists upstream as the 9-projection canonical phase-protocol synchronizer (verified present at /Users/xiaorongli/Dev/flywheel-FLY-2753/scripts/sync-phase-protocols.mjs, `--check` printing 'phase protocols: 9 projections checked'). The new program is semantically unrelated: it projects one markdown paragraph into three agent-prompt files and touches no phase protocol at all. The plan is itself aware of the mismatch and has to defend against it twice — line 26 '不假装存在九个现代 phase projections' and line 163 '不要把 `3 projections` 说成现代的 `9 projections`' — which is the signal that the name is wrong rather than that the caveats are sufficient. Failure scenario: this sandbox is later rebased onto or merged with a main that carries the upstream file; git reports a same-path conflict between two incompatible programs, and whichever side wins silently becomes the target of `packages/teamlead`'s new `prebuild`, so the build either hard-fails or checks the wrong invariant while still printing a success line. Rename to something that describes the behavior (e.g. `scripts/sync-local-verification.mjs`) and update the prebuild command and §3/§4 references with it.

### MEDIUM — prebuild-gate-placed-in-unrelated-package

Repo-root agent-prompt drift gate is hidden inside `packages/teamlead`'s build lifecycle rather than an explicit CI step

§1 wires the drift check as `packages/teamlead` `prebuild`. I confirmed the mechanism does fire — pnpm 10.13.1 has pre/post scripts enabled (no `.npmrc`, `pnpm config get enable-pre-post-scripts` is undefined, and a probe workspace showed both `pnpm build` and `pnpm --filter "pkg-a..." build` running `prebuild`) — so this is not an inert-gate defect. The concern is placement: `packages/teamlead` has no relationship to `.flywheel/agents/*`, so any contributor running `pnpm --filter flywheel-teamlead build` can now get a build failure about agent-prompt drift, and the repo's only cross-cutting prompt gate becomes invisible in `.github/workflows/ci.yml`. The established convention here for exactly this kind of role-.md contract guard is a named CI step — `scripts/__tests__/test-pm-executor-contract.sh` at ci.yml:233-234 (FLY-880). The coupling is also partly redundant: the new vitest contract test already covers source-vs-projection drift (§3 table rows 真实合同 / 精确同步 / 检查漂移), so the prebuild is a second gate bought with the coupling. Plan line 31's '不改 CI 工作流' constraint is what forces this; state that tradeoff explicitly, or add the check as a CI step instead.

### LOW — script-fails-repo-lint-as-written

The §3 script as written does not pass the repo's own `pnpm lint`, which §4 runs first

I ran the repo's biome (2.1.4, via `pnpm exec biome check`) over the §3 script verbatim. It reports three problems: `lint/style/useTemplate` on `const expected = begin + "\n" + raw.replace(/\n+$/, "") + "\n" + end;` (line 117 of the plan), `assist/source/organizeImports` on the import block, and a formatter diff throughout because the snippet uses 2-space indentation while the repo is tab-indented. `pnpm lint` is both the first command in §4's acceptance block (line 168) and a CI step (.github/workflows/ci.yml:62), so this self-detects on the implementer's first run and is fixed by `pnpm format` — but the plan presents the block as the '完整算法' to write, so reformatting it now avoids a spurious red on the first acceptance pass.

### LOW — role-action-adjacency-unasserted

Adjacency between the shared block and the role-action sentence is required in prose but not asserted

Line 49 states '角色动作必须与共同块紧邻，测试按完整连续句断言'. The assertion actually specified (lines 83-85) is a position-independent `expect(text, role).toContain(<full sentence>)`. The full-sentence match is a real improvement over R1's greedy regex, but it does not encode adjacency: a later edit could relocate 'Fix every red current-HEAD CI job before claiming verification complete.' to an unrelated section of engineer-executor.md, leaving the shared block with no visible red-CI disposition, and the contract test would still pass. If adjacency is genuinely part of the contract, assert it (e.g. that the text immediately following the END marker line is the role sentence); if it is only a style preference, drop the word 必须 from line 49 so the plan and its test agree.

### LOW — agentdispatcher-consumer-justification-overstated

§4 justifies the edge-worker test as directly covering the changed files, but no existing test reads those file bodies

Line 176 says `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` '直接覆盖当前三角色配置路径'. Verified: that file contains no `readFileSync`/`readFile`/`existsSync` at all — it asserts on `agent_file` path strings and inline synthetic agent configs. I also checked the other two packages that `git grep -lF general-executor` surfaces, which the plan's own discovery rule (line 180) would hit: `packages/config/src/__tests__/ConfigLoader.test.ts` drives a mocked `readFile` over synthetic YAML, and `packages/flywheel-cli/src/__tests__/migrate-agents-path.test.ts` writes its own `"# generic\n"` fixtures. `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts` does load the real `.flywheel/config.yaml`, but the plan does not change that file. So the accurate statement is: no existing test reads the bodies of the three handbooks, and the new `local-verification-policy.test.ts` is the only content guard. Running AgentDispatcher.test.ts is harmless and cheap, but the stated reason is wrong, and the implementer is required by line 180 to record exclusion reasoning in implementation.md — starting from an incorrect premise will propagate into that record.

全部建议已通过 ask --report 转报 Lead。它们未被伪装成已修复、被推翻或治理裁决；实现者应保留可审查的处置，不自动扩大范围。R1 的 HIGH 已由 R2 有效 verdict 解除。
