#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILDER="$REPO_ROOT/.claude/skills/meeting-notes/scripts/build_report.py"
SKILL="$REPO_ROOT/.claude/skills/meeting-notes/SKILL.md"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "not ok - $1"; }

cat > "$TMP_ROOT/input.json" <<'JSON'
{
  "issueIdentifier": "FLY-3000",
  "meetingId": "11111111-1111-4111-8111-111111111111",
  "title": "设计复盘 <script>alert(1)</script>",
  "meta": "2026-08-28 · flywheel-eng-lead & Annie",
  "summary": ["讨论 <b>可信边界</b>", "决定继续验证"],
  "actionItems": [
    {"id": "AI-1", "text": "验证 founder 闭环 & 回执", "source": "2026-08-28T18:00:00Z"},
    {"id": "AI-2", "text": "记录后续", "source": "event:42"}
  ]
}
JSON

python3 "$BUILDER" --input "$TMP_ROOT/input.json" --output "$TMP_ROOT/card.html"
if grep -q '&lt;script&gt;alert(1)&lt;/script&gt;' "$TMP_ROOT/card.html" \
  && ! grep -q '<script>alert(1)</script>' "$TMP_ROOT/card.html" \
  && grep -q '【页面意见汇总】FLY-3000' "$TMP_ROOT/card.html" \
  && [ "$(grep -o 'data-action-id=' "$TMP_ROOT/card.html" | wc -l | tr -d ' ')" = "2" ]; then
  ok "renders escaped summary and stable action items"
else
  bad "renders escaped summary and stable action items"
fi

if [ "$(grep -o '__CSP_NONCE__' "$TMP_ROOT/card.html" | wc -l | tr -d ' ')" = "1" ] \
  && ! grep -Eqi "<script[^>]+src=|http-equiv=['\"]Content-Security-Policy" "$TMP_ROOT/card.html" \
  && grep -q 'data-decision="要做"' "$TMP_ROOT/card.html" \
  && grep -q 'data-decision="不做"' "$TMP_ROOT/card.html" \
  && grep -q 'data-decision="有意见"' "$TMP_ROOT/card.html"; then
  ok "preserves publish-only CSP and interactive-card contract"
else
  bad "preserves publish-only CSP and interactive-card contract"
fi

if grep -q 'transcript.disclosures' "$SKILL" \
  && grep -q '逐项写入 notes.md 和互动卡' "$SKILL"; then
  ok "requires every transcript exclusion disclosure in notes and the card"
else
  bad "transcript exclusions can be dropped by the note-taker"
fi

if grep -q 'doc/meetings/YYYY-MM-DD-<lead>-<meeting-id 前 8 位>/meeting-notes.html' "$SKILL" \
  && grep -q 'publish-report --html.*--project flywheel.*--publish-only' "$SKILL" \
  && grep -q 'gate founder_review.*--hosted-url.*--artifact' "$SKILL" \
  && grep -q '提交.*meeting-notes.html' "$SKILL" \
  && ! grep -q -- '--output /tmp/meeting-card.html' "$SKILL" \
  && ! grep -q '不要提交生成的 HTML' "$SKILL"; then
  ok "commits the final HTML and binds its hosted URL to founder_review"
else
  bad "note-taker cannot produce a committed HTML founder-review artifact"
fi

if grep -q 'lead_id.*不是 Raya 专属过滤条件' "$SKILL" \
  && grep -q 'meta.*实际.*lead_id' "$SKILL" \
  && ! grep -q '"meta": "2026-01-01 · Raya' "$SKILL"; then
  ok "keeps selected-Lead identity parameterized in the note card"
else
  bad "note card still hard-codes Raya as the selected Lead"
fi

if grep -q '\[FLY-<issue number>\].*thread' "$SKILL" \
  && grep -q 'founder_review gate.*自动投递' "$SKILL" \
  && grep -Eq '不得直接调用.*(/api/reports/deliver|/api/chat-threads/send)' "$SKILL"; then
  ok "uses the existing founder-review card to deliver into the issue thread"
else
  bad "Discord delivery contract is missing or bypasses the existing card"
fi

python3 - <<'PY' "$TMP_ROOT/input.json"
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
data["actionItems"].append(dict(data["actionItems"][0]))
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
PY
if ! python3 "$BUILDER" --input "$TMP_ROOT/input.json" --output "$TMP_ROOT/duplicate.html" 2> "$TMP_ROOT/error" \
  && grep -q 'duplicate action item id' "$TMP_ROOT/error"; then
  ok "fails closed on duplicate action identities"
else
  bad "fails closed on duplicate action identities"
fi

python3 - <<'PY' "$TMP_ROOT/input.json"
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
data["actionItems"].pop()
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
PY
ln -s "$TMP_ROOT/elsewhere" "$TMP_ROOT/symlink.html"
if ! python3 "$BUILDER" --input "$TMP_ROOT/input.json" --output "$TMP_ROOT/symlink.html" 2> "$TMP_ROOT/symlink-error" \
  && grep -q 'output must not be a symlink' "$TMP_ROOT/symlink-error"; then
  ok "refuses a symlink output"
else
  bad "refuses a symlink output"
fi

echo "FLY-2033 meeting notes card: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
