--- Input: Hotkey management for Phase 1a.
-- Creates hotkeys (Ctrl+1-9, 0, Y, N, R, X), enables/disables them as a group.
-- All keys route to a single on_input(command, value) callback.

local M = {}
M.__index = M

--- Command mapping: key char → { command, value }
local KEY_MAP = {
    ["1"] = { command = "choose", value = "1" },
    ["2"] = { command = "choose", value = "2" },
    ["3"] = { command = "choose", value = "3" },
    ["4"] = { command = "choose", value = "4" },
    ["5"] = { command = "choose", value = "5" },
    ["6"] = { command = "choose", value = "6" },
    ["7"] = { command = "choose", value = "7" },
    ["8"] = { command = "choose", value = "8" },
    ["9"] = { command = "choose", value = "9" },
    ["0"] = { command = "choose", value = "10" },
    ["y"] = { command = "yes" },
    ["n"] = { command = "no" },
    ["r"] = { command = "replay" },
    ["x"] = { command = "cancel" },
}

--- Create a new Input manager.
--- @param deps table Injected dependencies:
---   deps.hotkey_new(mods, key, fn) → hotkey object with :enable() / :disable() / :delete()
---   deps.alert_show(text, duration) — optional visual feedback
---   deps.modifier table Hotkey modifier keys (e.g., {"ctrl"})
function M.new(deps)
    local self = setmetatable({}, M)
    self._hotkey_new = deps.hotkey_new
    self._alert_show = deps.alert_show or function() end
    self._modifier = deps.modifier or {"ctrl"}
    self._hotkeys = {}     -- list of hotkey objects
    self._on_input = nil   -- callback(command, value)
    self._enabled = false
    return self
end

--- Set the input callback. Called when user presses a hotkey.
--- @param fn function(command, value) where command is "choose"/"yes"/"no"/"replay"/"cancel"
function M:set_callback(fn)
    self._on_input = fn
end

--- Create all hotkey objects (initially disabled).
function M:create()
    self:destroy() -- clean up any existing hotkeys
    for key_char, mapping in pairs(KEY_MAP) do
        local hk = self._hotkey_new(self._modifier, key_char, function()
            if self._on_input then
                self._on_input(mapping.command, mapping.value)
            end
        end)
        table.insert(self._hotkeys, hk)
    end
end

--- Enable all hotkeys (user can now press keys).
function M:enableAll()
    for _, hk in ipairs(self._hotkeys) do
        hk:enable()
    end
    self._enabled = true
end

--- Disable all hotkeys.
function M:disableAll()
    for _, hk in ipairs(self._hotkeys) do
        hk:disable()
    end
    self._enabled = false
end

--- Check if hotkeys are currently enabled.
--- @return boolean
function M:isEnabled()
    return self._enabled
end

--- Delete all hotkey objects and clean up.
function M:destroy()
    for _, hk in ipairs(self._hotkeys) do
        if hk.delete then hk:delete() end
    end
    self._hotkeys = {}
    self._enabled = false
    self._on_input = nil
end

--- Show available hotkeys as an alert.
--- @param choices table|nil List of {key, text} from parsed prompt
--- @param format string|nil Prompt format (yesno, approve_reject, etc.)
function M:showHint(choices, format)
    local lines = {}
    if format == "yesno" or format == "approve_reject" then
        table.insert(lines, "Ctrl+Y: Yes/Approve")
        table.insert(lines, "Ctrl+N: No/Reject")
    elseif choices then
        for _, c in ipairs(choices) do
            local mod_key = c.key
            if mod_key == "10" then mod_key = "0" end
            table.insert(lines, "Ctrl+" .. mod_key .. ": " .. c.text)
        end
    end
    table.insert(lines, "Ctrl+R: Replay | Ctrl+X: Cancel")
    self._alert_show(table.concat(lines, "\n"), 5)
end

return M
