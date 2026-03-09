export const template = `---
name: flywheel-land
description: Automated PR landing — monitors CI, handles reviews, and merges.
allowed-tools: Bash Read Write
metadata:
    skill-author: flywheel
    skill-version: 0.1.0
---

# flywheel-land — Automated PR Landing

## Trigger
After creating a PR, follow this skill to automatically land it.

## Steps
0. Write pending marker immediately. The system prompt provides the exact landing signal path. Create the directory and write the pending marker:
   \`\`\`
   mkdir -p <dir-of-signal-path>
   echo '{"status":"pending"}' > <signal-path>
   \`\`\`
   (Use the landing signal path from the system prompt.)
   This marker tells Blueprint that landing was attempted. If session crashes before writing a terminal status, Blueprint routes to \\\`blocked\\\`.

1. Get PR info including base branch:
   \\\`gh pr view --json number,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeStateStatus,mergeable,state\\\`

2. Poll every 30s until CI + review ready:
   - \\\`gh pr view <PR_NUMBER> --json statusCheckRollup,reviewDecision,mergeable,state,mergedAt\\\`
   - If CI fails: analyze failure, fix code, push, continue polling (max 2 fix attempts)
   - If CI times out (30min no progress): write land-status.json (failed, ci_timeout), escalate, stop
   - If review has change requests: read comments, address feedback, push, continue polling
   - If mergeable is CONFLICTING:
     1. Verify single-author: \\\`git log --format='%ae' origin/<baseRefName>..HEAD | sort -u | wc -l\\\` — if > 1, write land-status.json (failed, merge_conflict), escalate, stop (do NOT force push multi-author PRs)
     2. If single-author: \\\`git fetch origin <baseRefName> && git rebase origin/<baseRefName> && git push -f\\\`
   - If mergeable is UNKNOWN: wait 30s, re-poll

3. When all checks pass + review approved (or no required reviews) + mergeable:
   - \\\`gh pr merge <PR_NUMBER> --squash\\\` (immediate merge, NOT --auto)
   - Verify: \\\`gh pr view <PR_NUMBER> --json state,mergedAt\\\` — confirm mergedAt exists
   - If not merged after 30s retry: likely merge queue repo. Write land-status.json (failed, merge_queue_unsupported), escalate, stop

4. Post-merge cleanup (best-effort, BEFORE writing terminal signal):
   - Delete remote branch: \\\`git push origin --delete <branch>\\\` — if this fails (branch already deleted by GitHub auto-delete or ref not found), treat as success and continue

5. Write terminal signal (LAST step before session exit — write regardless of cleanup outcome):
   - On success: write \\\`{"status":"merged","prNumber":<N>,"mergedAt":"<ts>"}\\\` to the signal path
   - On failure: write \\\`{"status":"failed","prNumber":<N>,"failureReason":"<reason>"}\\\` to the signal path
   - (Use the same landing signal path from the system prompt as in step 0)
   - CRITICAL: Write signal AFTER cleanup attempt. TmuxRunner sentinel triggers Blueprint immediately on terminal signal — any pending operations will be interrupted.

6. Session exits normally — Blueprint handles notifications

## Failure Modes
- CI fix attempts exhausted (2x): write land-status.json (failed, ci_fix_exhausted), escalate, stop
- CI timeout (30min no progress): write land-status.json (failed, ci_timeout), escalate, stop
- Review wait timeout (30min): write land-status.json (failed, review_timeout), escalate, stop
- Merge conflict after 2 rebase attempts: write land-status.json (failed, merge_conflict), escalate, stop
- gh pr merge fails: write land-status.json (failed, merge_failed), escalate, stop
- Merge queue repo detected: write land-status.json (failed, merge_queue_unsupported), escalate, stop

## CRITICAL: Always write land-status.json
Whether landing succeeds or fails, you MUST write the landing signal file (path provided in system prompt) before stopping.
This file is the machine-readable signal that Blueprint uses to determine session outcome.
Branch cleanup failures must NOT prevent signal writing — always write the signal regardless of cleanup outcome.

## Do NOT
- Use \\\`gh pr merge --auto\\\` (this only enables auto-merge, doesn't actually merge)
- Force push on PRs with other authors' commits
- Send session_completed events yourself — Blueprint handles this
- Keep retrying indefinitely — max 2 CI fix attempts, 30min wait timeouts
- Update Linear issue status — handled by a separate mechanism (out of scope for this skill)
`;
