--- TTS Engine: synthesize speech to AIFF with `say -o`, then play via hs.sound.
--- This avoids silent subprocess speech output issues on some macOS 15.x setups.

local M = {}
M.__index = M

local TMP_PREFIX = "/tmp/voice-loop-tts-"

local function now_ms()
    return math.floor(hs.timer.secondsSinceEpoch() * 1000)
end

local function make_tmp_aiff()
    return string.format("%s%d-%d.aiff", TMP_PREFIX, now_ms(), math.random(100000, 999999))
end

local function safe_remove(path)
    if path then os.remove(path) end
end

--- Create a new TTS engine.
--- @param config table Config with tts_voice and tts_rate fields
--- @return table TTS instance
function M.new(config)
    local self = setmetatable({}, M)
    self.voice = config.tts_voice  -- e.g., "Alex", "Samantha", "Ting-Ting"
    self.rate = config.tts_rate or 200
    self._speaking = false
    self._synth_task = nil
    self._sound = nil
    self._tmp_file = nil
    math.randomseed(now_ms())
    return self
end

--- Check if TTS is currently speaking.
--- @return boolean
function M:isSpeaking()
    return self._speaking
end

--- Reset runtime state and cleanup any temporary output file.
function M:_finish()
    if self._sound then
        self._sound:setCallback(nil)
        self._sound = nil
    end
    self._synth_task = nil
    safe_remove(self._tmp_file)
    self._tmp_file = nil
    self._speaking = false
end

--- Play the synthesized AIFF file via hs.sound.
function M:_playSynthesizedFile()
    local path = self._tmp_file
    if not path then
        self:_finish()
        return
    end

    local sound = hs.sound.getByFile(path)
    if not sound then
        hs.printf("[voice-loop] failed to load synthesized audio: %s", path)
        self:_finish()
        return
    end

    self._sound = sound
    sound:setCallback(function(_, message)
        if message == "didFinish" or message == "didStop" then
            self:_finish()
        end
    end)

    if not sound:play() then
        hs.printf("[voice-loop] failed to play synthesized audio: %s", path)
        self:_finish()
    end
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
    self._speaking = true
    self._tmp_file = make_tmp_aiff()

    local args = {
        "-r", tostring(self.rate),
        "-o", self._tmp_file,
        text,
    }
    if self.voice and #self.voice > 0 then
        table.insert(args, 1, self.voice)
        table.insert(args, 1, "-v")
    end

    self._synth_task = hs.task.new("/usr/bin/say", function(exitCode, _, stdErr)
        self._synth_task = nil
        if exitCode ~= 0 then
            hs.printf("[voice-loop] say synthesis failed (exit=%d): %s", exitCode, tostring(stdErr))
            self:_finish()
            return
        end
        self:_playSynthesizedFile()
    end, args)

    if not self._synth_task then
        hs.printf("[voice-loop] failed to create say task")
        self:_finish()
        return false
    end

    if not self._synth_task:start() then
        hs.printf("[voice-loop] failed to start say task")
        self:_finish()
        return false
    end

    return true
end

--- Stop any current speech.
function M:stop()
    if self._synth_task then
        self._synth_task:terminate()
        self._synth_task = nil
    end
    if self._sound then
        self._sound:setCallback(nil)
        self._sound:stop()
        self._sound = nil
    end
    safe_remove(self._tmp_file)
    self._tmp_file = nil
    self._speaking = false
end

return M
