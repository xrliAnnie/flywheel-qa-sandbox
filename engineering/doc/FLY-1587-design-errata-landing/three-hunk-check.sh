#!/bin/bash
# FLY-1587 §4 第 5 步 —— design.md 附录自核方法的实跑版
#
#   从 Linear 取 FLY-1569 正文,截「## 0. 背景与病因」到结尾
#   与 design.md「## 0. 背景与病因」到「## 附录」之前 做 diff
#   预期:恰好三个 hunk(<b> 标签 / **** 星号 / §10 导航指针)
#
# 用法: three-hunk-check.sh <git-rev>     e.g. origin/main
set -euo pipefail

REV="${1:?usage: three-hunk-check.sh <git-rev>}"
OUT="$(dirname "$0")"

# shellcheck disable=SC1090
set +u; source ~/.flywheel/.env; set -u
: "${LINEAR_API_KEY:?LINEAR_API_KEY not found in ~/.flywheel/.env}"

# 1) Linear 侧:取 FLY-1569 正文,截 §0 到结尾
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"query":"{ issue(id: \"FLY-1569\") { identifier description } }"}' \
  > "$OUT/fly1569.json"

jq -e -r '.data.issue.identifier' "$OUT/fly1569.json" >/dev/null   # fail-closed
jq -r '.data.issue.description' "$OUT/fly1569.json" > "$OUT/fly1569.body.md"
awk '/^## 0\. 背景与病因$/{f=1} f' "$OUT/fly1569.body.md" > "$OUT/side-linear.md"

# 2) git 侧:取指定 rev 的 design.md,截 §0 到「## 附录」之前
SAFE_REV=${REV//\//_}
DESIGN="$OUT/design.$SAFE_REV.md"
git show "$REV:doc/messaging-rework/design.md" > "$DESIGN"
awk '/^## 0\. 背景与病因$/{f=1} /^## 附录/{f=0} f' "$DESIGN" > "$OUT/side-git.md"

# 3) diff + hunk 计数
echo "rev            = $REV"
echo "linear 侧行数  = $(wc -l < "$OUT/side-linear.md")"
echo "git 侧行数     = $(wc -l < "$OUT/side-git.md")"
echo "--- diff (linear → git) ---"
diff -u "$OUT/side-linear.md" "$OUT/side-git.md" || true
HUNKS=$(diff -u "$OUT/side-linear.md" "$OUT/side-git.md" | grep -c '^@@' || true)
echo "=================================="
echo "HUNKS=$HUNKS  (预期 3)"
[ "$HUNKS" = "3" ]
