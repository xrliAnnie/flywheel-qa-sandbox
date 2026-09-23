# FLY-2654 (QA2 rework): the Raya-scoped identity projection of projects.json.
#
# The migration ledger freezes ONLY this projection, never the whole-file
# sha256, so an unrelated Lead's model/effort edit, a new Lead row, or a
# serialization-only difference (trailing newline, key order) cannot refuse a
# Raya deployment. Every field of the Raya project row and of the Raya lead
# row is identity except the runtime tuning that lead-identity's v1 digest
# already excludes (model, effort, modelContextWindow).
#
# packages/teamlead/src/bin/raya-registry-identity.ts implements the same
# projection; raya-registry-identity.test.ts proves both agree on fixtures.
[
  (if type == "array" then .[] else empty end)
  | select(type == "object" and .projectName == "raya")
  | .leads = [
      (if (.leads | type) == "array" then .leads[] else empty end)
      | select(type == "object" and .agentId == "raya")
      | del(.model, .effort, .modelContextWindow)
    ]
]
