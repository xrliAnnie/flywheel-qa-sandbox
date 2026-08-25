# FLY-2034 verification helpers

The public seams were fixed by the approved implementation plan:

- project config loading;
- Belle's menu adoption and IC roster resolution;
- real `tpl_generic_menu` v2 snapshot materialization;
- exact raw `projects.json` cutover delta, including the joint invariant that
  the new Linear matcher keeps Belle's explicit department at `life`.

Run the full scaffold check against an isolated checkout and the read-only live
baseline:

```bash
pnpm exec tsx engineering/doc/FLY-2034-belle-lead-seat/qa/verify-belle-workspace.ts \
  <belle-workspace-checkout> <live-personal-assistant-root>
```

At cutover, do not scan the live repository's ignored/private paths. Use:

```bash
pnpm exec tsx engineering/doc/FLY-2034-belle-lead-seat/qa/verify-belle-workspace.ts \
  --runtime-only <connected-live-root>
```

Before replacing machine-local `projects.json`, validate the old and candidate
files through the built Bridge validator, then pin the exact semantic delta:

```bash
node packages/teamlead/dist/bin/validate-projects.js <candidate-projects.json>
pnpm exec tsx engineering/doc/FLY-2034-belle-lead-seat/qa/verify-belle-projects-cutover.ts \
  <before-projects.json> <candidate-projects.json>
```

Both helpers are fail-closed. The workspace verifier creates isolated temporary
copies for directory/symlink conflict, missing-roster, and missing-executor
negative controls; it never mutates the supplied repository. `--runtime-only`
deliberately avoids reading unrelated live personal files. The projects verifier
validates a clone but compares the raw JSON, so loader normalization cannot hide
an unapproved file-level delta.
