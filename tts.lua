--- TTS Engine: uses macOS `say` command for voice announcements.
--- Runs `say` via background shell process to avoid blocking Hammerspoon.

local M = {}
M.__index = M

--- Shell-escape a string for safe use in commands.
local function shell_escape(s)
    return "'" .. s:gsub("'", "'\\''") .. "'"
end

--- Create a new TTS engine.
--- @param config table Config with tts_voice and tts_rate fields
--- @return table TTS instance
function M.new(config)
    local self = setmetatable({}, M)
    self.voice = config.tts_voice  -- e.g., "Alex", "Samantha", "Ting-Ting"
    self.rate = config.tts_rate or 200
    self._speaking = false
    return self
end

--- Check if TTS is currently speaking.
--- @return boolean
function M:isSpeaking()
    return self._speaking
end

--- Format the announcement text from a parsed prompt.
--- @param alias string Pane alias
--- @param prompt table Parsed prompt
--- @return string text to speak
function M:_formatText(alias, prompt)
    if prompt.format == "yesno" then
        return alias .. " asks: yes or no?"
    elseif prompt.format == "approve_reject" then
        return alias .. " asks: approve or reject?"
    elseif prompt.choices and #prompt.choices > 0 then
        local parts = {}
        for _, choice in ipairs(prompt.choices) do
            table.insert(parts, choice.key .. ", " .. choice.text)
        end
        return alias .. " needs a choice. " .. table.concat(parts, ". ") .. ". Which one?"
    else
        return alias .. " needs your attention."
    end
end

--- Announce a detected prompt via TTS.
--- @param alias string Pane alias (e.g., "backend")
--- @param prompt table Parsed prompt from parser
--- @return boolean Whether announcement started
function M:announce(alias, prompt)
    if self._speaking then return false end

    local text = self:_formatText(alias, prompt)

    -- Build say command
    local cmd = "/usr/bin/say"
    if self.voice then
        cmd = cmd .. " -v " .. shell_escape(self.voice)
    end
    cmd = cmd .. " -r " .. tostring(self.rate)
    cmd = cmd .. " " .. shell_escape(text)

    -- Run in background via shell, with a done-marker file
    local marker = "/tmp/voice-loop-tts-done"
    os.remove(marker)
    hs.execute("(" .. cmd .. "; touch " .. marker .. ") &", true)

    self._speaking = true

    -- Poll for completion (check every 0.5s)
    local check
    check = hs.timer.doEvery(0.5, function()
        local f = io.open(marker, "r")
        if f then
            f:close()
            os.remove(marker)
            self._speaking = false
            check:stop()
        end
    end)

    return true
end

--- Stop any current speech.
function M:stop()
    -- Kill any running say process
    hs.execute("pkill -f '/usr/bin/say.*voice-loop' 2>/dev/null || true", true)
    os.remove("/tmp/voice-loop-tts-done")
    self._speaking = false
end

return M
