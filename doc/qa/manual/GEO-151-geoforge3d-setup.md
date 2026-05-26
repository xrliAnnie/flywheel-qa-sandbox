# GEO-151 — GeoForge3D ProofShot Setup (Stage B opt-in)

**Issue**: GEO-151 — ProofShot integration
**Stage**: B (GeoForge3D 3D capture)
**Audience**: Annie (one-time per-project setup) + Runners (per-build call)
**Pre-req**: Stage A1–A7 merged to `main`. GEO-151 implementation deployed.

---

## What this enables

When the Runner finishes building a 3D output (`.glb`, `.stl`, `.3mf`,
`.gltf`, `.obj`) inside the GeoForge3D project and then advances to the
`test` pipeline stage, the Bridge automatically:

1. Spins up a local HTTP server serving the model file on loopback.
2. Asks ProofShot to open `${model_viewer_url}?model=http://127.0.0.1:<port>/<basename>`.
3. Takes one snapshot per configured angle (default 4 — front/side/iso/top).
4. Routes the screenshots through the Lead → Discord MCP so Annie sees
   them in the issue chat thread.

Annie does not need to type any command — the auto-trigger fires off the
existing `stage_changed=test` event. The only ongoing Runner cost is one
`flywheel-comm set-artifact` call per build.

---

## Step 1 — One-time project config

Edit `<GeoForge3D-repo>/.flywheel/config.yaml` and add the `skills.proofshot`
block. Existing fields (`project`, `linear`, `runners`, etc.) are
untouched.

```yaml
# ... existing config ...

skills:
  proofshot:
    enabled: true
    # UI mode dev server command (used when `last_artifact` is absent).
    # GeoForge3D rarely uses UI capture for product issues, but keep this
    # set so the field exists for non-product issues that happen to share
    # the project.
    dev_command: "pnpm dev"
    # Stages where the auto-trigger fires. Default is
    # [test, code_review, pr_created]; keep `test` so 3D capture runs
    # whenever the Runner advances to test.
    capture_stages:
      - test
      - code_review
    # Vision-self-check (V1) — Runner Reads selected PNGs after capture.
    vision_default: true
    vision_token_budget: 10000

    # 3D-specific. Required for 3D mode to work.
    model_viewer_url: "https://3dviewer.net"
    model_capture_angles:
      - front
      - side
      - iso
      - top
```

Commit + push the config change:

```bash
cd ~/Dev/GeoForge3D
git add .flywheel/config.yaml
git commit -m "feat(GEO-151): enable ProofShot 3D capture"
git push
```

Restart Bridge so the new config is picked up:

```bash
restart-services.sh bridge
```

**Verify config loaded**: tail the Bridge log when the next Runner starts
on this project — you should see no errors about `skills.proofshot.*`
field validation. `flywheel-comm` will validate every field; if any
type is wrong the Runner spawn will fail with a clear message.

---

## Step 2 — Per-build Runner call

Your Runner's build script should already produce a model file at a
known path (e.g. `~/Dev/GeoForge3D/output/<issue>/model.glb`). After
the build succeeds and BEFORE the Runner advances to `stage=test`, add:

```bash
flywheel-comm set-artifact --model-path "$(realpath output/$ISSUE/model.glb)"
```

The command:

- Validates the file exists, is a regular file, and has a supported
  extension (`.glb`, `.gltf`, `.stl`, `.3mf`, `.obj`).
- Resolves identity from `FLYWHEEL_EXEC_ID`, `FLYWHEEL_ISSUE_ID`,
  `FLYWHEEL_PROJECT_NAME` env (already set by Flywheel for every Runner).
- POSTs `last_artifact_set` to Bridge — Bridge persists into
  `session_params.last_artifact.model_path`.
- Exits 0 on success, exit 2 on POST failure (Runner can retry).

**Where to add the call**: at the end of your build agent script, right
before the test stage transition. Example:

```bash
#!/bin/bash
set -euo pipefail

pnpm build                                                  # produce output/model.glb
flywheel-comm set-artifact --model-path "$PWD/output/model.glb"
flywheel-comm stage set test                                # → triggers Bridge 3D capture
pnpm test                                                   # run real tests
```

The Bridge handler runs asynchronously — the Runner does NOT wait for
the screenshots to be delivered. Annie sees the screenshots in Discord
within ~30s of the `set-artifact` + `stage set test` sequence (varies
with 3D viewer cold-start).

---

## Step 3 — Verifying it works (one-time per release)

After deploying changes:

1. Pick a small GEO issue that should produce a 3D model.
2. Start a Runner via the usual Bridge command.
3. Watch the Runner's build complete + see `set-artifact` succeed in the
   tmux log.
4. Watch the Runner advance to `stage=test`.
5. Within ~30s, look at the Discord chat thread for the issue — you
   should see 4 attached PNGs (one per angle).

**Troubleshooting**:

- **No screenshots in Discord**: Tail Bridge log for `[proofshot-trigger]`.
  - Filter on `captureKind=3d` — if you see `captureKind=ui`, the
    `last_artifact_set` event didn't reach Bridge. Re-check Runner's
    `set-artifact` command exit code.
  - Filter on `[artifact-event]` — if you see "resolveLeadForIssue
    failed for GeoForge3D", project config isn't loaded. Re-check
    `.flywheel/config.yaml` syntax and restart Bridge.
- **Screenshots look wrong angle**: 3dviewer.net's URL param support
  for camera angles isn't documented as of writing. The wrapper takes
  N snapshots of whatever the viewer is showing — if all four look
  identical, file a follow-up issue to wire viewer-native angle
  control (`agent-browser` click sequence, or migrate to a viewer
  that honors `?camera=front`).

---

## Disabling

Set `skills.proofshot.enabled: false` in `.flywheel/config.yaml` and
restart Bridge. The auto-trigger immediately short-circuits — no other
cleanup needed. Already-captured PNGs in `~/.flywheel/screens/` are
preserved.
