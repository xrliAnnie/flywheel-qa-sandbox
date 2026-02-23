--- Prompt Parser: detects choice prompts in captured pane text.
-- Uses pattern matching + "waiting for input" heuristic to reduce false positives.

local M = {}

--- Check if text appears to end with a prompt waiting for input (Condition A).
--- Heuristic: trailing blank lines or the text ends after the choices.
--- @param text string Full captured text
--- @return boolean
local function is_waiting_for_input(text)
    -- Trailing whitespace/newlines suggest cursor is on a new empty line
    if text:match("\n%s*\n%s*$") then return true end
    -- Single trailing newline after content
    if text:match("[^\n]\n$") then return true end
    -- Text ends with a question mark line followed by newline
    if text:match("%?\n%s*$") then return true end
    return false
end

--- Extract numbered choices from text, deduplicating by key.
--- Supports: "1) text", "1. text", "[1] text"
--- @param text string
--- @return table|nil choices, string|nil format
local function extract_numbered(text)
    -- Helper: deduplicate choices by key (keep last occurrence)
    local function dedup(raw_choices)
        local seen_keys = {}
        local result = {}
        -- Iterate in reverse so we keep the LAST (most recent) occurrence
        for i = #raw_choices, 1, -1 do
            if not seen_keys[raw_choices[i].key] then
                seen_keys[raw_choices[i].key] = true
                table.insert(result, 1, raw_choices[i])
            end
        end
        return result
    end

    -- "N) text"
    local choices = {}
    for key, ctext in text:gmatch("(%d+)%)%s*([^\n]+)") do
        table.insert(choices, { key = key, text = ctext:match("^(.-)%s*$") })
    end
    choices = dedup(choices)
    if #choices >= 2 then return choices, "paren" end

    -- "N. text"
    choices = {}
    for key, ctext in text:gmatch("\n%s*(%d+)%.%s+([^\n]+)") do
        table.insert(choices, { key = key, text = ctext:match("^(.-)%s*$") })
    end
    for key, ctext in text:gmatch("^%s*(%d+)%.%s+([^\n]+)") do
        table.insert(choices, { key = key, text = ctext:match("^(.-)%s*$") })
    end
    choices = dedup(choices)
    if #choices >= 2 then return choices, "dot" end

    -- "[N] text"
    choices = {}
    for key, ctext in text:gmatch("%[(%d+)%]%s+([^\n]+)") do
        table.insert(choices, { key = key, text = ctext:match("^(.-)%s*$") })
    end
    choices = dedup(choices)
    if #choices >= 2 then return choices, "bracket" end

    return nil, nil
end

--- Detect yes/no prompts.
--- @param text string
--- @return table|nil choices, string|nil format
local function detect_yesno(text)
    if text:match("[Yy]es/[Nn]o")
        or text:match("%(y/n%)")
        or text:match("%(Y/N%)")
        or text:match("%(yes/no%)") then
        return {
            { key = "y", text = "Yes" },
            { key = "n", text = "No" },
        }, "yesno"
    end
    return nil, nil
end

--- Detect approve/reject prompts.
--- @param text string
--- @return table|nil choices, string|nil format
local function detect_approve_reject(text)
    if text:match("[Aa]pprove") and text:match("[Rr]eject") then
        return {
            { key = "y", text = "Approve" },
            { key = "n", text = "Reject" },
        }, "approve_reject"
    end
    return nil, nil
end

--- Parse captured pane text for choice prompts.
--- Matches prompts in the last 15 lines. The "waiting for input" heuristic
--- boosts confidence but is not a hard gate — dedupe handles repeat prevention.
--- @param text string Raw capture-pane output
--- @return table|nil Parsed prompt: { format, choices, raw_match }
function M.parse(text)
    if not text or #text == 0 then return nil end

    -- Split into lines and strip trailing empty lines (capture-pane pads with blanks)
    local lines = {}
    for line in (text .. "\n"):gmatch("(.-)\n") do
        table.insert(lines, line)
    end
    while #lines > 0 and lines[#lines]:match("^%s*$") do
        table.remove(lines)
    end
    if #lines == 0 then return nil end

    -- Only look at last 15 content lines to avoid matching stale output
    local start = math.max(1, #lines - 14)
    local recent = table.concat(lines, "\n", start)

    -- Try each pattern type
    local choices, format

    choices, format = extract_numbered(recent)
    if choices then
        return { format = format, choices = choices, raw_match = recent }
    end

    choices, format = detect_yesno(recent)
    if choices then
        return { format = format, choices = choices, raw_match = recent }
    end

    choices, format = detect_approve_reject(recent)
    if choices then
        return { format = format, choices = choices, raw_match = recent }
    end

    return nil
end

--- Compute a deduplication key for a prompt.
--- @param pane_target string tmux pane target
--- @param raw_text string The raw matched text
--- @return string dedupe_key
function M.dedupe_key(pane_target, raw_text)
    -- Normalize: strip timestamps and collapse whitespace
    local normalized = raw_text:gsub("%d+:%d+:%d+", ""):gsub("%s+", " ")

    local hash
    if hs and hs.hash and hs.hash.SHA256 then
        hash = hs.hash.SHA256(normalized):sub(1, 8)
    else
        -- djb2 hash fallback
        local h = 5381
        for i = 1, math.min(#normalized, 200) do
            h = ((h * 33) + normalized:byte(i)) % 0xFFFFFFFF
        end
        hash = string.format("%08x", h)
    end
    return pane_target .. "|" .. hash
end

return M
