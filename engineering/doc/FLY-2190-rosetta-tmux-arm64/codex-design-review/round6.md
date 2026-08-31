# Design Review — FLY-2190 plan.md (Round 6)

Date: 2026-08-30
Author: Codex
Status: CHANGES REQUESTED

## Summary

R6 resolves the R5 issues in the written design: the wrapper-internal gate closes the generic KeepAlive birth path, A0/A4b are coherent, the receipt contract and array discovery are concrete, and P1–P7 still completely describe the parked S3 blocker classes. I still cannot approve implementation because the plan's five-wrapper inventory is false for the live 16-Lead fleet, leaving two production Codex carriers outside both S0 and S1, and the new fail-closed gate is absent from the repository's packaged runtime closure.

## What's Good (Keep)

- Reusing the wrapper-internal fail-closed pattern is the right shape for ordinary launchd/KeepAlive births. Capturing the gate status in an errexit-exempt `|| rc=$?` list preserves the existing wrapper/launchd contract.
- The four mount classes now cover updater pre-fast-forward, the restart transaction, manual restart, and direct wrapper birth. A0 correctly makes proof that S0 is live a prerequisite to merging S1.
- A4b now uses the correct pathname primitive: direct canonicalization followed by `tmux -V` and `file`, with no misuse of the PID-only `extract_tmux_image` helper.
- The named gate script, state-root-aware receipt path, fail-closed expiry/binding checks, safe file-write contract, and named tests are sufficient to begin implementation without inventing a second evidence format.
- S2 now discovers new `qa-result`-shaped dual-prefix arrays rather than protecting only the one registered instance. The shared cross-format enumerator and positive control remain sound.
- The three R5 upstream-document contradictions are corrected in place. The measured compatibility claim is again limited to handshake/`list-sessions`, the cutover script is called a primitives toolbox, and CI is the only claimed S2 mount.
- P1–P7 remain complete at this design level. The findings below are S0/S1 deployment-closure defects, not a missing P8 for S3.

## Issues & Recommendations

1. **BLOCKER — the planned “five wrappers” do not match the live 16-Lead fleet, so two production Leads would receive neither S0 nor S1.** A read-only census of `~/Library/LaunchAgents/com.flywheel.lead.*.plist` finds 16 jobs: 14 select `~/.flywheel/bin/flywheel-lead-wrapper-v2.sh`, but `growth-mufasa-lead` selects `flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh` and `flywheel-codex-infra-bot-lead` selects `flywheel-codex-lead-wrapper-codex-infra-bot.sh`. Both installed files still contain Intel-first PATH. Neither wrapper exists as a source file under `packages/` or `scripts/`; the plan instead edits `packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh`, which is not the wrapper selected by the live Mufasa plist. Consequently §1.1's production count, §1.6's five-wrapper mount list, S2's registry, and A0/A1 cannot truthfully cover the fleet. **Fix:** bring both actual Codex wrapper shapes under source control and a tested converge/install authority, or migrate both plists to a source-controlled generic carrier. Add both live classes to S0, S1, S2, the consumer sweep, and A0. Make A0 perform a fail-closed launchd-plist census: every production Lead wrapper pathname must map to registered source and deployed bytes containing the S0 mount; an unknown or drifted installed wrapper is RED. Update/install those bytes atomically before any affected job is allowed to restart.

2. **HIGH — the new fail-closed gate is not included in the packaged runtime closure.** `package-onboard.sh` explicitly whitelists `flywheel-bridge-wrapper.sh`, `flywheel-lead-wrapper-v2.sh`, and `restart-storm-gate.py`, but R6 does not add `host-tmux-selection-gate.sh`. The package file itself requires every runtime entry to have a row in `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md`, and `packaged-seams.test.sh` verifies the existing gate closure. If packaged Bridge/Lead wrappers gain the new fail-closed call while the payload omits its target, those carriers cannot start. **Fix:** pin the default gate lookup path, add the script to `PO_SCRIPT_FILES`, add the required packaged-path-audit disposition, and extend the assembled-payload/packaged-seams tests. If any wrapper resolves the gate from `~/.flywheel/bin`, also add it to `converge-flywheel-bin.sh`'s copy closure and its drift/mode tests. A0 must cover both monorepo and `.flywheel-prebuilt` execution shapes.

3. **HIGH — S0 is a point-in-time observation, not continuous protection against the host drift the risk table says it blocks.** A wrapper can validate 3.5a at birth, then a later link mutation changes resolution for bare `tmux` calls made by the already-running Bridge and by the Lead server's `pane-exited` hook; neither path re-enters the wrapper. Plan §6 currently says the deployment gate prevents the long-term mixed state solely because a link present at deployment is rejected. **Fix:** state the actual joint invariant: S0 proves selection only at each checked boundary, while the post-check interval is protected by **DO NOT LINK**, the restart guard on managed execution paths, and founder authorization for any host mutation. Make that prohibition an explicit A0/A4b operational precondition through the start of S3/P4/P5. If the plan wants to claim technical protection from arbitrary post-birth drift, it must instead pin the validated tmux client (or gate every client resolution); the present receipt cannot provide that guarantee.

4. **Implementation notes — not independently blocking once the deployment closure is fixed.** Add `carrier`/`mountPoint` (or an equivalent observation identifier) to the receipt and define `targetSha`/`boundTransaction` for a standalone KeepAlive birth; otherwise concurrent wrappers overwrite one shared receipt without preserving which mount produced the evidence. Restrict `FLYWHEEL_HOST_TMUX_GATE_BIN` to hermetic tests or validate its production target so a value sourced from `.env` cannot silently replace the fail-closed gate. Phrase the wrapper placement as “before the first tmux selection or service exec” rather than literally copying the restart-storm location: the Lead and Codex wrappers do not currently contain that brake, and the Bridge brake intentionally runs after its single-instance preflights. The still-withdrawn rolling sentence in `exploration.md:21` may also be removed in place to reduce reliance on the banner, but the banner already makes this editorial rather than blocking.

## Verdict

CHANGES REQUESTED — address items above
