export const template = `---
name: flywheel-land
description: Automated PR landing — monitors CI and reports readiness.
allowed-tools: Bash Read Write
metadata:
    skill-author: flywheel
    skill-version: 0.2.0
---

# flywheel-land — Automated PR Landing

## Trigger
After creating a PR, follow this skill to monitor CI and report readiness.

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

2. Poll every 30s until CI ready:
   - \\\`gh pr view <PR_NUMBER> --json statusCheckRollup,reviewDecision,mergeable,state,mergedAt\\\`
   - If CI fails: analyze failure, fix code, push, continue polling (max 2 fix attempts)
   - If CI times out (30min no progress): write land-status.json (failed, ci_timeout), escalate, stop
   - If review has change requests: read comments, address feedback, push, continue polling
   - If mergeable is CONFLICTING:
     1. Verify single-author: \\\`git log --format='%ae' origin/<baseRefName>..HEAD | sort -u | wc -l\\\` — if > 1, write land-status.json (failed, merge_conflict), escalate, stop (do NOT force push multi-author PRs)
     2. If single-author: \\\`git fetch origin <baseRefName> && git rebase origin/<baseRefName> && git push -f\\\`
   - If mergeable is UNKNOWN: wait 30s, re-poll

3. When all checks pass + mergeable:
   - Write \\\`{"status":"ready_to_merge","prNumber":<N>}\\\` to the signal path
   - Do NOT merge the PR — CEO approval is required before merging

4. Exit the session normally — Blueprint handles notifications and CEO approval flow

## Failure Modes
- CI fix attempts exhausted (2x): write land-status.json (failed, ci_fix_exhausted), escalate, stop
- CI timeout (30min no progress): write land-status.json (failed, ci_timeout), escalate, stop
- Review wait timeout (30min): write land-status.json (failed, review_timeout), escalate, stop
- Merge conflict after 2 rebase attempts: write land-status.json (failed, merge_conflict), escalate, stop
- Merge queue repo detected: write land-status.json (failed, merge_queue_unsupported), escalate, stop

## CRITICAL: Always write land-status.json
Whether CI passes or fails, you MUST write the landing signal file (path provided in system prompt) before stopping.
This file is the machine-readable signal that Blueprint uses to determine session outcome.

## Do NOT
- Merge the PR — CEO approval is required. Write ready_to_merge and exit.
- Use \\\`gh pr merge\\\` in any form
- Force push on PRs with other authors' commits
- Send session_completed events yourself — Blueprint handles this
- Keep retrying indefinitely — max 2 CI fix attempts, 30min wait timeouts
- Update Linear issue status — handled by a separate mechanism (out of scope for this skill)
`;
