--- Unit tests for parser.lua
--- Run: lua test/test_parser.lua  (from repo root)
--- No Hammerspoon dependencies required.

-- Adjust package path to find parser.lua at repo root
package.path = package.path .. ";./?.lua"

local parser = require("parser")

-- ---------------------------------------------------------------------------
-- Test harness
-- ---------------------------------------------------------------------------
local TOTAL = 0
local FAILURES = 0

local function test(name, fn)
    local ok, err = pcall(fn)
    if ok then
        print("  PASS: " .. name)
    else
        print("  FAIL: " .. name .. " - " .. tostring(err))
        FAILURES = FAILURES + 1
    end
    TOTAL = TOTAL + 1
end

local function assert_eq(a, b, msg)
    if a ~= b then
        error(string.format("%s: expected %s, got %s", msg or "assert_eq", tostring(b), tostring(a)))
    end
end

local function assert_nil(a, msg)
    if a ~= nil then
        error(string.format("%s: expected nil, got %s", msg or "assert_nil", tostring(a)))
    end
end

local function assert_not_nil(a, msg)
    if a == nil then
        error(string.format("%s: expected non-nil, got nil", msg or "assert_not_nil"))
    end
end

local function assert_true(a, msg)
    if not a then
        error(string.format("%s: expected truthy, got %s", msg or "assert_true", tostring(a)))
    end
end

-- Helper to build a trailing-newline padded string (simulates capture-pane output)
local function with_blank_padding(text, pad_lines)
    pad_lines = pad_lines or 10
    local padding = string.rep("\n", pad_lines)
    return text .. padding
end

-- ===========================================================================
print("\n=== Numbered choices: paren format ===")
-- ===========================================================================

test("paren: two choices", function()
    local text = "Pick one:\n1) Apply changes\n2) Skip\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 2, "choice count")
    assert_eq(result.choices[1].key, "1", "key 1")
    assert_eq(result.choices[1].text, "Apply changes", "text 1")
    assert_eq(result.choices[2].key, "2", "key 2")
    assert_eq(result.choices[2].text, "Skip", "text 2")
end)

test("paren: three choices", function()
    local text = "Select action:\n1) Edit\n2) Delete\n3) Cancel\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[1].key, "1", "key 1")
    assert_eq(result.choices[2].key, "2", "key 2")
    assert_eq(result.choices[3].key, "3", "key 3")
    assert_eq(result.choices[3].text, "Cancel", "text 3")
end)

test("paren: trailing whitespace in choice text is stripped", function()
    local text = "Choose:\n1) Option A   \n2) Option B   \n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.choices[1].text, "Option A", "text 1 trimmed")
    assert_eq(result.choices[2].text, "Option B", "text 2 trimmed")
end)

test("paren: non-sequential numbering", function()
    local text = "Choose:\n1) Foo\n3) Bar\n5) Baz\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[2].key, "3", "key 3")
end)

-- ===========================================================================
print("\n=== Numbered choices: dot format ===")
-- ===========================================================================

test("dot: two choices", function()
    local text = "Select an option:\n1. Run tests\n2. Deploy\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "dot", "format")
    assert_eq(#result.choices, 2, "choice count")
    assert_eq(result.choices[1].key, "1", "key 1")
    assert_eq(result.choices[1].text, "Run tests", "text 1")
    assert_eq(result.choices[2].key, "2", "key 2")
    assert_eq(result.choices[2].text, "Deploy", "text 2")
end)

test("dot: three choices with leading whitespace", function()
    local text = "Options:\n  1. Alpha\n  2. Beta\n  3. Gamma\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "dot", "format")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[1].text, "Alpha", "text 1")
end)

test("dot: at start of text (no leading newline) - known limitation", function()
    -- Known limitation: Lua gmatch with ^ anchor yields 0 results in Lua 5.4,
    -- so the first "1. ..." line is not captured when there's no preceding newline.
    -- Only the second item "2. ..." is found (via the \n pattern), giving < 2 items.
    local text = "1. First option\n2. Second option\n"
    local result = parser.parse(text)
    assert_nil(result, "result (known limitation: gmatch + ^ in Lua 5.4)")
end)

test("dot: at start of text WITH leading newline works", function()
    local text = "\n1. First option\n2. Second option\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "dot", "format")
    assert_eq(#result.choices, 2, "choice count")
end)

-- ===========================================================================
print("\n=== Numbered choices: bracket format ===")
-- ===========================================================================

test("bracket: two choices", function()
    local text = "Choose:\n[1] Accept\n[2] Decline\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "bracket", "format")
    assert_eq(#result.choices, 2, "choice count")
    assert_eq(result.choices[1].key, "1", "key 1")
    assert_eq(result.choices[1].text, "Accept", "text 1")
    assert_eq(result.choices[2].key, "2", "key 2")
    assert_eq(result.choices[2].text, "Decline", "text 2")
end)

test("bracket: four choices", function()
    local text = "Pick:\n[1] A\n[2] B\n[3] C\n[4] D\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "bracket", "format")
    assert_eq(#result.choices, 4, "choice count")
    assert_eq(result.choices[4].key, "4", "key 4")
    assert_eq(result.choices[4].text, "D", "text 4")
end)

-- ===========================================================================
print("\n=== Yes/No detection ===")
-- ===========================================================================

test("yesno: Yes/No", function()
    local text = "Continue? Yes/No\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
    assert_eq(#result.choices, 2, "choice count")
    assert_eq(result.choices[1].key, "y", "key y")
    assert_eq(result.choices[1].text, "Yes", "text Yes")
    assert_eq(result.choices[2].key, "n", "key n")
    assert_eq(result.choices[2].text, "No", "text No")
end)

test("yesno: yes/no (lowercase)", function()
    local text = "Overwrite existing file? yes/no\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("yesno: (y/n)", function()
    local text = "Proceed with merge? (y/n)\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("yesno: (Y/N)", function()
    local text = "Delete all files? (Y/N)\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("yesno: (yes/no)", function()
    local text = "Are you sure? (yes/no)\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("yesno: Yes/No embedded in longer line", function()
    local text = "This will overwrite 3 files. Yes/No to continue.\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

-- ===========================================================================
print("\n=== Approve/Reject detection ===")
-- ===========================================================================

test("approve_reject: Approve and Reject in text", function()
    local text = "Review changes:\nApprove or Reject?\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
    assert_eq(#result.choices, 2, "choice count")
    assert_eq(result.choices[1].key, "y", "key y")
    assert_eq(result.choices[1].text, "Approve", "text Approve")
    assert_eq(result.choices[2].key, "n", "key n")
    assert_eq(result.choices[2].text, "Reject", "text Reject")
end)

test("approve_reject: lowercase approve/reject", function()
    local text = "Do you approve or reject this change?\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
end)

test("approve_reject: mixed case", function()
    local text = "Please Approve or reject the PR.\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
end)

test("approve_reject: on separate lines", function()
    local text = "Options:\n  - Approve the changes\n  - Reject the changes\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
end)

-- ===========================================================================
print("\n=== Negative cases (should return nil) ===")
-- ===========================================================================

test("negative: plain text with no prompt", function()
    local text = "Building project...\nCompilation successful.\nDone.\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: only one numbered item (not a choice)", function()
    local text = "Step:\n1) Initialize the database\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: only one dot-numbered item", function()
    local text = "1. Just one item here\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: only one bracket-numbered item", function()
    local text = "[1] Single item\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: empty string", function()
    local result = parser.parse("")
    assert_nil(result, "result")
end)

test("negative: nil input", function()
    local result = parser.parse(nil)
    assert_nil(result, "result")
end)

test("negative: whitespace only", function()
    local result = parser.parse("   \n  \n  \n")
    assert_nil(result, "result")
end)

test("negative: text that mentions 'yes' but not in yes/no pattern", function()
    local text = "Yesterday was great. No issues found.\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: only 'Approve' without 'Reject'", function()
    local text = "Please approve the changes.\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

test("negative: only 'Reject' without 'Approve'", function()
    local text = "You can reject the proposal.\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

-- ===========================================================================
print("\n=== Edge cases: trailing blank lines ===")
-- ===========================================================================

test("edge: paren choices with trailing blank padding", function()
    local text = with_blank_padding("Pick:\n1) Alpha\n2) Beta\n", 20)
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 2, "choice count")
end)

test("edge: yes/no with trailing blank padding", function()
    local text = with_blank_padding("Continue? (y/n)\n", 30)
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("edge: approve/reject with heavy padding", function()
    local text = with_blank_padding("Approve or Reject?\n", 50)
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
end)

test("edge: only blank lines", function()
    local text = "\n\n\n\n\n"
    local result = parser.parse(text)
    assert_nil(result, "result")
end)

-- ===========================================================================
print("\n=== Edge cases: choices beyond last 15 lines (should NOT match) ===")
-- ===========================================================================

test("edge: numbered choices in old output beyond 15-line window", function()
    -- Build text: choices at the top, then >15 lines of other content
    local lines = { "Old prompt:", "1) Stale choice A", "2) Stale choice B" }
    for i = 1, 20 do
        table.insert(lines, "Log line " .. i .. ": processing...")
    end
    table.insert(lines, "Current status: idle")
    table.insert(lines, "")  -- trailing newline
    local text = table.concat(lines, "\n")
    local result = parser.parse(text)
    assert_nil(result, "result should be nil (choices too old)")
end)

test("edge: yes/no in old output beyond 15-line window", function()
    local lines = { "Old question? (y/n)" }
    for i = 1, 20 do
        table.insert(lines, "Activity line " .. i)
    end
    table.insert(lines, "Done.")
    table.insert(lines, "")
    local text = table.concat(lines, "\n")
    local result = parser.parse(text)
    assert_nil(result, "result should be nil (yes/no too old)")
end)

test("edge: approve/reject in old output beyond 15-line window", function()
    local lines = { "Please Approve or Reject the PR." }
    for i = 1, 20 do
        table.insert(lines, "Build output line " .. i)
    end
    table.insert(lines, "Build complete.")
    table.insert(lines, "")
    local text = table.concat(lines, "\n")
    local result = parser.parse(text)
    assert_nil(result, "result should be nil (approve/reject too old)")
end)

test("edge: choices within the 15-line window DO match", function()
    local lines = {}
    for i = 1, 10 do
        table.insert(lines, "Log line " .. i)
    end
    table.insert(lines, "Choose:")
    table.insert(lines, "1) Keep")
    table.insert(lines, "2) Discard")
    table.insert(lines, "")
    local text = table.concat(lines, "\n")
    local result = parser.parse(text)
    assert_not_nil(result, "result should match (within 15-line window)")
    assert_eq(result.format, "paren", "format")
end)

-- ===========================================================================
print("\n=== Edge cases: duplicate choices (deduplication) ===")
-- ===========================================================================

test("edge: duplicate paren choices are deduped", function()
    -- Simulates echo/quote artifacts repeating choices
    local text = "prompt> 1) Apply\nprompt> 2) Skip\n1) Apply\n2) Skip\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 2, "should be 2 after dedup")
end)

test("edge: duplicate bracket choices are deduped", function()
    local text = "[1] Foo\n[2] Bar\n[1] Foo\n[2] Bar\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "bracket", "format")
    assert_eq(#result.choices, 2, "should be 2 after dedup")
end)

test("edge: duplicate dot choices are deduped", function()
    local text = "1. Run\n2. Stop\n1. Run\n2. Stop\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "dot", "format")
    assert_eq(#result.choices, 2, "should be 2 after dedup")
end)

test("edge: dedup keeps LAST occurrence of duplicate key", function()
    -- Key "1" appears twice with different text; last one should win
    local text = "1) Old text\n2) Other\n1) New text\n2) Other\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(#result.choices, 2, "should be 2 after dedup")
    assert_eq(result.choices[1].text, "New text", "last occurrence wins")
end)

-- ===========================================================================
print("\n=== Edge cases: mixed formats ===")
-- ===========================================================================

test("edge: paren takes priority over dot", function()
    -- Parser tries paren first; if both exist, paren wins
    local text = "1) Paren option A\n2) Paren option B\n1. Dot option A\n2. Dot option B\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "paren should win")
end)

test("edge: numbered takes priority over yesno", function()
    local text = "1) Continue\n2) Cancel\nProceed? (y/n)\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "numbered should win over yesno")
end)

test("edge: numbered takes priority over approve/reject", function()
    local text = "1) Approve\n2) Reject\nApprove or Reject?\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "numbered should win over approve_reject")
end)

test("edge: yesno takes priority over approve/reject", function()
    -- When no numbered choices, yesno is tried before approve_reject
    local text = "Approve or Reject? (y/n)\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "yesno should win over approve_reject")
end)

-- ===========================================================================
print("\n=== Edge cases: miscellaneous ===")
-- ===========================================================================

test("edge: text with no trailing newline", function()
    local text = "1) Foo\n2) Bar"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 2, "choice count")
end)

test("edge: choices with special characters in text", function()
    local text = "1) Install (recommended)\n2) Skip [not recommended]\n3) Custom: /usr/local/bin\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[1].text, "Install (recommended)", "text with parens")
end)

test("edge: large choice numbers", function()
    local text = "10) Tenth option\n11) Eleventh option\n12) Twelfth option\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[1].key, "10", "key 10")
end)

test("edge: raw_match field is present", function()
    local text = "Choose:\n1) A\n2) B\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_not_nil(result.raw_match, "raw_match should be set")
    assert_true(type(result.raw_match) == "string", "raw_match should be string")
    assert_true(#result.raw_match > 0, "raw_match should not be empty")
end)

test("edge: exactly 15 content lines, choices at the top", function()
    -- Build exactly 15 content lines with choices at lines 1-3
    local lines = { "Choose:", "1) Yes", "2) No" }
    for i = 1, 12 do
        table.insert(lines, "Filler line " .. i)
    end
    local text = table.concat(lines, "\n") .. "\n"
    local result = parser.parse(text)
    assert_not_nil(result, "result should match (exactly 15 lines, choices included)")
    assert_eq(result.format, "paren", "format")
end)

test("edge: 16 content lines, choices at line 1 (outside window)", function()
    -- 16 content lines; window is last 15, so line 1 is excluded
    local lines = { "1) Stale A" }
    for i = 1, 14 do
        table.insert(lines, "Filler line " .. i)
    end
    table.insert(lines, "Final line")
    local text = table.concat(lines, "\n") .. "\n"
    -- The single "1) Stale A" outside window; inside window only has fillers.
    -- Only 1 choice visible in window (if any from filler lines), so nil
    local result = parser.parse(text)
    assert_nil(result, "result should be nil (single choice line outside window)")
end)

-- ===========================================================================
print("\n=== dedupe_key ===")
-- ===========================================================================

test("dedupe_key: same input produces same key", function()
    local key1 = parser.dedupe_key("%0", "1) Foo\n2) Bar\n")
    local key2 = parser.dedupe_key("%0", "1) Foo\n2) Bar\n")
    assert_eq(key1, key2, "keys should match")
end)

test("dedupe_key: different pane targets produce different keys", function()
    local key1 = parser.dedupe_key("%0", "1) Foo\n2) Bar\n")
    local key2 = parser.dedupe_key("%1", "1) Foo\n2) Bar\n")
    assert_true(key1 ~= key2, "keys should differ for different panes")
end)

test("dedupe_key: different text produces different keys", function()
    local key1 = parser.dedupe_key("%0", "1) Foo\n2) Bar\n")
    local key2 = parser.dedupe_key("%0", "1) Baz\n2) Qux\n")
    assert_true(key1 ~= key2, "keys should differ for different text")
end)

test("dedupe_key: timestamps are normalized away", function()
    local key1 = parser.dedupe_key("%0", "12:34:56 Choose:\n1) A\n2) B\n")
    local key2 = parser.dedupe_key("%0", "00:00:00 Choose:\n1) A\n2) B\n")
    assert_eq(key1, key2, "keys should match after timestamp normalization")
end)

test("dedupe_key: whitespace differences are normalized", function()
    local key1 = parser.dedupe_key("%0", "Choose:  1) A   2) B")
    local key2 = parser.dedupe_key("%0", "Choose: 1) A 2) B")
    assert_eq(key1, key2, "keys should match after whitespace normalization")
end)

test("dedupe_key: returns string in expected format", function()
    local key = parser.dedupe_key("%0", "test input")
    assert_true(type(key) == "string", "key should be string")
    -- Format: pane_target|hash (hash is 8 hex chars)
    local pane, hash = key:match("^(.-)|(........)$")
    assert_eq(pane, "%0", "pane target")
    assert_not_nil(hash, "hash should be 8 chars")
    assert_true(hash:match("^%x+$") ~= nil, "hash should be hex")
end)

test("dedupe_key: uses djb2 fallback (no hs global)", function()
    -- Verify hs is not set (test env doesn't have Hammerspoon)
    assert_nil(hs, "hs should not be defined in test env")
    -- The key should still be computed via djb2 fallback
    local key = parser.dedupe_key("%0", "fallback test")
    assert_not_nil(key, "key should be computed")
    assert_true(#key > 3, "key should have meaningful length")
end)

-- ===========================================================================
print("\n=== Realistic capture-pane scenarios ===")
-- ===========================================================================

test("realistic: Claude Code tool approval prompt", function()
    local text = [[
I'll help you fix the bug in auth.lua.

Let me read the file first.

  Read file: auth.lua

Do you want to approve this action?

  Approve  or  Reject

]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "approve_reject", "format")
end)

test("realistic: npm init prompts", function()
    local text = [[
package name: (my-project)
version: (1.0.0)
description:

Is this OK? (yes/no)
]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "yesno", "format")
end)

test("realistic: git interactive choice (multiple per line)", function()
    -- When multiple "N) text" appear on the same line, the paren pattern captures
    -- greedily: "1) status     2) update..." becomes one match with key=1 and
    -- text="status     2) update     3) revert     4) add untracked".
    -- Only 2 matches result (one per line), not 8.
    local text = [[
*** Commands ***
  1) status     2) update     3) revert     4) add untracked
  5) patch      6) diff       7) quit       8) help
What now>
]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 2, "choice count (greedy per-line capture)")
    assert_eq(result.choices[1].key, "1", "first key")
    assert_eq(result.choices[2].key, "5", "second key")
end)

test("realistic: git interactive choice with one per line", function()
    -- When each choice is on its own line, all are captured correctly.
    local text = [[
*** Commands ***
  1) status
  2) update
  3) revert
  4) add untracked
  5) patch
  6) diff
  7) quit
  8) help
What now>
]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 8, "choice count")
    assert_eq(result.choices[1].text, "status", "first choice")
    assert_eq(result.choices[8].text, "help", "last choice")
end)

test("realistic: capture-pane with lots of blank padding", function()
    local content = "Building...\nDone.\n\nSelect environment:\n1) Production\n2) Staging\n3) Development\n"
    local text = content .. string.rep("                                        \n", 40)
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "paren", "format")
    assert_eq(#result.choices, 3, "choice count")
end)

test("realistic: bracket menu with parenthesized numbers in text (paren wins)", function()
    -- Text like "(#342)" contains "342)" which the paren pattern matches first.
    -- So paren format wins over bracket when text has "(#NNN)" style references.
    local text = [[
Search results:
[1] Fix login timeout issue (#342)
[2] Add retry logic for API calls (#289)
[3] Update dependencies to latest (#401)

Enter selection:
]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    -- Paren pattern matches "(#342)" -> key=342, "(#401)" -> key=401
    assert_eq(result.format, "paren", "paren wins due to (#NNN) in text")
end)

test("realistic: pure bracket menu (no parens in text)", function()
    local text = [[
Search results:
[1] Fix login timeout issue
[2] Add retry logic for API calls
[3] Update dependencies to latest

Enter selection:
]]
    local result = parser.parse(text)
    assert_not_nil(result, "result")
    assert_eq(result.format, "bracket", "format")
    assert_eq(#result.choices, 3, "choice count")
    assert_eq(result.choices[1].text, "Fix login timeout issue", "text 1")
end)

-- ===========================================================================
-- Summary
-- ===========================================================================

print(string.format("\n=== Results: %d/%d passed ===", TOTAL - FAILURES, TOTAL))
if FAILURES > 0 then
    print(string.format("FAILURES: %d", FAILURES))
    os.exit(1)
else
    print("All tests passed!")
    os.exit(0)
end
