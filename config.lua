--- Config loader: merges user config over defaults.
-- User config lives at ~/.claude/voice-loop/config.lua
-- This module provides the merged result.

local M = {}

local DEFAULTS = {
    monitored_panes = {},
    poll_interval = 1.5,
    capture_lines = 50,
    tts_voice = nil,
    tts_rate = 200,
    log_dir = os.getenv("HOME") .. "/.claude/voice-loop/logs",
    -- Phase 1a: hotkey input
    hotkey_modifier = {"ctrl", "shift"},
    listen_timeout = 15,
    max_remind_count = 3,
    confirm_high_risk = true,
    confirm_keywords = {"delete", "remove", "force", "reset", "drop", "destroy"},
    max_choices = 10,
}

--- Load config: defaults merged with user overrides.
--- @return table config
function M.load()
    local cfg = {}
    for k, v in pairs(DEFAULTS) do cfg[k] = v end

    local path = os.getenv("HOME") .. "/.claude/voice-loop/config.lua"
    local ok, user_cfg = pcall(dofile, path)
    if ok and type(user_cfg) == "table" then
        for k, v in pairs(user_cfg) do cfg[k] = v end
    end

    return cfg
end

return M
