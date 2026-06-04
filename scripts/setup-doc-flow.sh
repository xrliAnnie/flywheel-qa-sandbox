#!/usr/bin/env bash
# FLY-205: setup-doc-flow.sh — the SINGLE mechanism entry point for enabling
# the department-first doc-flow baseline on a Flywheel project.
#
#   New-project onboarding, retrofit of an existing project, and the sub/joycon
#   acceptance runs ALL go through this one command — there is no second path.
#   Idempotent: re-running produces zero changes (two runs diff empty).
#
# Usage:
#   scripts/setup-doc-flow.sh <project-root> <department>
#
#   <project-root>  absolute or relative path to the project's git repo root
#   <department>    department directory name, ^[a-z0-9-]+$ (e.g. content, product)
#
# What it does:
#   1. Validates <department> charset and that <project-root> is a git repo ROOT.
#   2. Creates <dept>/doc/retro/ with a tracked .gitkeep.
#   3. Writes <dept>/doc/README.md (conventions self-description) — the heredoc
#      below is the ONE source of truth for the doc-flow conventions template.
#   4. If .flywheel/config.yaml exists and has no doc_flow block, appends a
#      commented doc_flow block (enabled: true). If .flywheel/ is absent,
#      runs in SKELETON-ONLY mode (deliberate, supported — e.g. joycon main):
#      directories + README are still created, and the config wiring guidance
#      is printed instead.
#
# After running, the operator still needs to (printed at the end too):
#   - ensure the matching Lead has `department: "<dept>"` in ~/.flywheel/projects.json
#   - run a Bridge build that includes FLY-205 (doc_flow injection)
set -euo pipefail

err() { echo "[setup-doc-flow] ERROR: $*" >&2; exit 1; }
log() { echo "[setup-doc-flow] $*"; }

[ $# -eq 2 ] || err "usage: setup-doc-flow.sh <project-root> <department>"

PROJECT_ROOT="$1"
DEPT="$2"

# ── 1. Validation ──────────────────────────────────────────────────────────
# Department: lowercase dir-name-safe only (no slashes/dots/spaces/uppercase).
if ! printf '%s' "$DEPT" | grep -Eq '^[a-z0-9-]+$'; then
  err "department \"$DEPT\" must match ^[a-z0-9-]+\$ (lowercase letters, digits, hyphens)"
fi

[ -d "$PROJECT_ROOT" ] || err "project root \"$PROJECT_ROOT\" is not a directory"

# Must be a git repo ROOT (not a subdirectory of one, not a non-repo) — this
# guards against scaffolding into the wrong directory.
GIT_TOPLEVEL="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null)" \
  || err "\"$PROJECT_ROOT\" is not inside a git repository"
PROJECT_ROOT_ABS="$(cd "$PROJECT_ROOT" && pwd -P)"
GIT_TOPLEVEL_ABS="$(cd "$GIT_TOPLEVEL" && pwd -P)"
if [ "$PROJECT_ROOT_ABS" != "$GIT_TOPLEVEL_ABS" ]; then
  err "\"$PROJECT_ROOT\" is not the git repo ROOT (toplevel is \"$GIT_TOPLEVEL_ABS\")"
fi

DOC_DIR="${PROJECT_ROOT_ABS}/${DEPT}/doc"
RETRO_DIR="${DOC_DIR}/retro"
README_PATH="${DOC_DIR}/README.md"
CONFIG_PATH="${PROJECT_ROOT_ABS}/.flywheel/config.yaml"

# ── 2. Directories + tracked retro placeholder ─────────────────────────────
mkdir -p "$RETRO_DIR"
# Empty dirs don't enter git — .gitkeep makes the skeleton-only PR face
# complete (Codex design R2 #3). Create-if-missing keeps re-runs no-op.
if [ ! -f "${RETRO_DIR}/.gitkeep" ]; then
  touch "${RETRO_DIR}/.gitkeep"
  log "Created ${RETRO_DIR}/.gitkeep"
else
  log "retro/.gitkeep already present — skipping"
fi

# ── 3. Conventions README (single source of truth template) ────────────────
if [ -f "$README_PATH" ]; then
  log "README already present — skipping (idempotent)"
else
  cat > "$README_PATH" << 'README_EOF'
# 本部门的 issue 过程文档（doc-flow baseline）

本目录由 Flywheel doc-flow baseline 管理（FLY-205）。约定如下，Runner 会自动遵守，
人手写文档时也请照做。

## 放法：一个 issue 一个文件夹

```
doc/
├── <ISSUE-号>-<短slug>/        ← 例: LEARN-21-deep-sleep-pack/
│   ├── exploration.md          ← brainstorm 聊出来的结论
│   ├── research.md             ← 调研记录
│   └── plan.md                 ← 实施计划(过 Codex 设计审查)
└── retro/                      ← 本部门复盘
```

- **issue 号是唯一主键**；slug 只为可读性（2-4 个小写单词，连字符相接）
- **没有状态子目录**（不建 draft/new/inprogress/archive）——进度唯一看 Linear
- 做完的 issue 文件夹**原地不动**（不挪 archive）
- 文档跟 feature branch 走，随 PR 合进 main

## 文档抬头：标题 + 3 行

```
# LEARN-21 深度睡眠包 — 实施计划

Issue: LEARN-21 (https://linear.app/.../LEARN-21)
日期: 2026-06-10
基于: 同文件夹的 research.md
```

不写版本号前缀、不写 Status 行、不写审查轮次（状态看 Linear，审查记录在 PR）。

## 三档难度（Lead 判定）

- **复杂** → exploration + research + plan 三份齐全
- **中等** → 只写 plan（Lead 会在 Discord 知会 founder）
- **简单** → 零文档直接实现（Lead 会在 Discord 知会 founder，可随时否决）

档位只控制文档产出——brainstorm/approve 等确认环节任何档位都照常执行。
README_EOF
  log "Wrote ${README_PATH}"
fi

# ── 4. Config wiring (or skeleton-only guidance) ───────────────────────────
NEXT_STEPS_CONFIG_DONE=false
if [ -f "$CONFIG_PATH" ]; then
  # Anchored grep — a bare `grep doc_flow` would be fooled by comments or
  # strings mentioning doc_flow (Codex design R1 #7).
  if grep -Eq '^[[:space:]]*doc_flow:' "$CONFIG_PATH"; then
    log "doc_flow block already present in .flywheel/config.yaml — skipping (idempotent)"
    NEXT_STEPS_CONFIG_DONE=true
  else
    # Ensure trailing newline before appending YAML (otherwise the appended
    # block glues onto the last line and corrupts the mapping).
    if [ -s "$CONFIG_PATH" ] && [ "$(tail -c 1 "$CONFIG_PATH" | wc -l | tr -d ' ')" -eq 0 ]; then
      printf '\n' >> "$CONFIG_PATH"
    fi
    cat >> "$CONFIG_PATH" << CONFIG_EOF

# FLY-205: department-first doc-flow baseline.
# enabled: true → Runners get the DOC-FLOW prompt block (tiered process docs
# under ${DEPT}/doc/<ISSUE>-<slug>/). Set to false to switch the feature off
# (spawn prompts return to byte-identical pre-doc-flow form).
doc_flow:
  enabled: true
  default_department: ${DEPT}
CONFIG_EOF
    log "Appended doc_flow block to ${CONFIG_PATH}"
    NEXT_STEPS_CONFIG_DONE=true
  fi
else
  # SKELETON-ONLY mode: no .flywheel/ in this checkout (e.g. joycon main).
  # Directories + README above are still valid and committable; the config
  # wiring happens wherever the project's .flywheel/config.yaml actually
  # lives (possibly another branch). Deliberate, supported mode.
  log "No .flywheel/config.yaml found — SKELETON-ONLY mode."
  log "Doc skeleton created. To activate doc-flow, add to the project's .flywheel/config.yaml (wherever it lives):"
  log ""
  log "    doc_flow:"
  log "      enabled: true"
  log "      default_department: ${DEPT}"
fi

# ── 5. Next steps ──────────────────────────────────────────────────────────
log ""
log "Done. Next steps:"
if [ "$NEXT_STEPS_CONFIG_DONE" = true ]; then
  log "  1. Commit the new files (and config change) via your normal PR flow."
else
  log "  1. Commit the new files via your normal PR flow; wire config per the block above."
fi
log "  2. Ensure the project's Lead entry in ~/.flywheel/projects.json carries"
log "     department: \"${DEPT}\" (alignment between config and Lead routing)."
log "  3. The running Bridge must include FLY-205 (doc_flow prompt injection)"
log "     for the Runner-side behavior to activate."
log "  4. ⚠️  RESTART THE BRIDGE after this config lands in the project checkout"
log "     the Bridge reads — per-project config.yaml is loaded at Bridge BOOT"
log "     only (run-infra), so doc_flow stays inert until the next restart."
log "     (FLY-205 ship-window lesson: the first acceptance run missed the"
log "     block because the Bridge had booted 2 minutes before the retrofit"
log "     merge.)"
