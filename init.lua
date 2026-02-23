--- Voice-in-the-Loop: voice control for Claude Code in tmux panes.
--- Phase 0: capture-pane → parse prompt → TTS announce

local config = require("voice-loop.config")
local monitor = require("voice-loop.monitor")
local parser = require("voice-loop.parser")
local tts = require("voice-loop.tts")
local logger = require("voice-loop.logger")

local M = {}

-- Internal state (not exposed)
local state = {
    timer = nil,
    cfg = nil,
    log = nil,
    speaker = nil,
    seen = {},      -- pane_target -> last dedupe_key
    running = false,
}

--- Main polling tick: capture each pane → parse → announce new prompts.
local function tick()
    if not state.running then return end
    if state.speaker:isSpeaking() then return end

    for _, pane in ipairs(state.cfg.monitored_panes) do
        -- Skip if TTS started during this tick (from earlier pane)
        if state.speaker:isSpeaking() then break end

        local text = monitor.capture(pane.target, state.cfg.capture_lines)
        if text and #text > 0 then
            local prompt = parser.parse(text)
            if prompt then
                local key = parser.dedupe_key(pane.target, prompt.raw_match)
                if state.seen[pane.target] ~= key then
                    state.seen[pane.target] = key
                    state.log:event("detected", {
                        pane = pane.target,
                        alias = pane.alias,
                        format = prompt.format,
                        choices = prompt.choices and #prompt.choices or 0,
                    })
                    state.speaker:announce(pane.alias, prompt)
                end
            -- Note: we do NOT clear seen[pane] when parse returns nil.
            -- The dedupe key persists so the same prompt won't re-announce.
            -- A new/different prompt will have a different dedupe key.
            end
        end
    end
end

--- Start voice loop monitoring.
function M:start()
    if state.running then
        hs.alert.show("Voice Loop: already running")
        return
    end

    state.cfg = config.load()
    if #state.cfg.monitored_panes == 0 then
        hs.alert.show("Voice Loop: no panes configured\nEdit ~/.claude/voice-loop/config.lua")
        return
    end

    state.log = logger.new(state.cfg.log_dir)
    state.speaker = tts.new(state.cfg)
    state.seen = {}
    state.running = true

    state.timer = hs.timer.new(state.cfg.poll_interval, tick)
    state.timer:start()

    state.log:event("started", { panes = #state.cfg.monitored_panes })
    hs.alert.show("Voice Loop: started (" .. #state.cfg.monitored_panes .. " panes)")
end

--- Stop voice loop and clear state.
function M:stop()
    state.running = false
    if state.timer then state.timer:stop(); state.timer = nil end
    if state.speaker then state.speaker:stop() end
    state.seen = {}
    if state.log then
        state.log:event("stopped", {})
        state.log:close()
        state.log = nil
    end
    hs.alert.show("Voice Loop: stopped")
end

--- Pause monitoring (keep state, stop polling).
function M:pause()
    state.running = false
    if state.timer then state.timer:stop() end
    if state.log then state.log:event("paused", {}) end
    hs.alert.show("Voice Loop: paused")
end

--- Resume monitoring.
function M:resume()
    if not state.timer then
        hs.alert.show("Voice Loop: not initialized, use :start()")
        return
    end
    state.running = true
    state.timer:start()
    if state.log then state.log:event("resumed", {}) end
    hs.alert.show("Voice Loop: resumed")
end

--- Toggle between running and paused.
function M:toggle()
    if state.running then
        self:pause()
    elseif state.timer then
        self:resume()
    else
        self:start()
    end
end

return M
