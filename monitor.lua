--- tmux Monitor: captures pane content via tmux capture-pane.

local M = {}

--- Shell-escape a string (POSIX single-quote escaping).
local function shell_escape(s)
    return "'" .. s:gsub("'", "'\\''") .. "'"
end

--- Capture the last N lines from a tmux pane.
--- @param target string tmux pane target (e.g., "main:0.1")
--- @param lines number Number of lines to capture (default 50)
--- @return string|nil Captured text, or nil on failure
function M.capture(target, lines)
    lines = lines or 50
    local cmd = string.format(
        "tmux capture-pane -t %s -p -S -%d 2>/dev/null",
        shell_escape(target), lines
    )
    local output, ok = hs.execute(cmd, true)
    if ok then return output end
    return nil
end

--- Check whether a tmux pane exists.
--- @param target string tmux pane target
--- @return boolean
function M.pane_exists(target)
    local cmd = string.format(
        "tmux display-message -p -t %s '#{pane_id}' 2>/dev/null",
        shell_escape(target)
    )
    local output, ok = hs.execute(cmd, true)
    return ok and output ~= nil and #(output:match("^(.-)%s*$") or "") > 0
end

return M
