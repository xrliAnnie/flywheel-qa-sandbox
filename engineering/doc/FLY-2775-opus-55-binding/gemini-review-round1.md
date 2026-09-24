# Design Review — FLY-2775 plan.md (Gemini Round 1)

Date: 2026-09-22
Author: Gemini (gemini-cli, API-key channel)
Status: APPROVED

## Summary
The proposed implementation plan for FLY-2775 is exceptionally thorough, technically correct, and aligns perfectly with the established architectural conventions of the Flywheel monorepo. It adheres to the founder's directive for a minimal change while elegantly safeguarding backward compatibility for in-flight runs and historical pins.

By separating "identity" from "binding" (established in FLY-1467), the plan ensures a clean migration where `claude-opus-5` remains a recognized, dispatchable entity even when no longer bound to the default `opus` alias.

All code locations, constant names, registry mechanics, and deployment sequences outlined in the plan have been statically verified and are highly accurate.

## What's Good (Keep)
1. **Model Identity & Binding Separation (Section 2.1):** The design correctly avoids modifying any registry factory logic, changing only the default bindings and adding a new set of identity constants (`OPUS_55` and `OPUS_55_1M`). This preserves previous architectural guarantees.
2. **Dispatch Allowlist Safeguard (Section 2.2):** The critical discovery that `claude-opus-5` would drop out of the dispatch allowlist in `model-config.ts` once unbound is brilliantly addressed. Hardcoding `MODEL_IDS.OPUS_5` and `MODEL_IDS.OPUS_5_1M` in the legacy list is both correct and necessary to ensure that in-flight snapshots and historical pins remain dispatchable.
3. **Founder-Owned Template Re-Publishing (Section 5):** The deployment instructions rightly recognize that founder-owned templates (such as `tpl_code` and `tpl_simple_code`) will skip auto-seeding on Bridge startup to protect customizations. Specifying explicit `flywheel-comm workflow-template publish` commands is crucial to prevent these core pipelines from silently remaining pinned to `claude-opus-5`.
4. **Backward Compatibility & Rollback Strategy (Section 5):** The rollback path is highly robust. By maintaining `claude-opus-5`'s dispatch eligibility, the operator can safely roll back model selection entirely via host-level configurations (`models.json`) or database rollbacks without requiring a code revert.
5. **Rigorous Two-Part Testing (Section 2.8 & 3):** Splitting test changes into "default-binding" assertion updates and "historical-id/fixture" preservation is conceptually sound and ensures test suite coverage remains complete and precise.

## Issues & Recommendations

### 1. Pricing Cache Rate Table Mapping for `claude-opus-5-5[1m]`
* **Severity:** LOW
* **Issue:** In `packages/token-usage/src/pricing.ts`, while the plan correctly adds `"claude-opus-5-5"` to `MODEL_RATES`, it does not specify a rate for `"claude-opus-5-5[1m]"`.
* **Why it matters:** Standard Anthropic token-pricing is uniform across context window boundaries ($5 input / $25 output). If the 1M variant (`claude-opus-5-5[1m]`) is utilized in workflow templates, cost estimation for those runs will silently evaluate to $0 and emit console warnings since `MODEL_RATES` lacks this key. While this is consistent with historical unpriced behavior for legacy 1M variants, we should fix this going forward.
* **Suggested Fix:** Explicitly register both standard and 1M variants in `MODEL_RATES` in `pricing.ts`:
  ```ts
  "claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5-5[1m]": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  ```
  *(Optional: Also register `"claude-opus-5[1m]": ...` and `"claude-opus-4-8[1m]": ...` to close historical unpriced gaps).*

### 2. Standardize Comments / Documentation for Future Upgrades
* **Severity:** LOW
* **Issue:** In `model-config.ts` (L535), the hardcoded legacy dispatch list receives a comment explaining its purpose.
* **Why it matters:** As the Opus line upgrades in the future, developers must remember to add retired model IDs to both `OPUS_IDENTITIES` in `model-builtins.ts` and the hardcoded list in `model-config.ts`.
* **Suggested Fix:** Add a JSDoc or reference comment in `model-builtins.ts` pointing to `model-config.ts` to ensure these two files remain coupled during future model rollouts.

## Verdict
**APPROVED**
The plan is highly cohesive and complete. Implementing the recommended addition of `"claude-opus-5-5[1m]"` in `MODEL_RATES` will perfect the implementation.
