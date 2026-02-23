--- Voice-in-the-Loop: voice control for Claude Code in tmux panes.
--- Phase 1a: capture-pane → parse prompt → TTS announce → hotkey input → tmux write-back

local config = require("voice-loop.config")
local monitor = require("voice-loop.monitor")
local parser = require("voice-loop.parser")
local tts = require("voice-loop.tts")
local logger = require("voice-loop.logger")
local writer_mod = require("voice-loop.writer")
local input_mod = require("voice-loop.input")
local dispatcher_mod = require("voice-loop.dispatcher")

local M = {}

-- Internal state (not exposed)
local state = {
    timer = nil,
    cfg = nil,
    log = nil,
    dispatcher = nil,
    input = nil,
    running = false,
}

--- Main polling tick: delegates to dispatcher.
local function tick()
    if not state.running then return end
    if state.dispatcher then
        state.dispatcher:tick()
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
    local speaker = tts.new(state.cfg)

    -- Create writer with real hs dependencies
    local w = writer_mod.new({
        monitor = monitor,
        parser = parser,
        execute = function(cmd) return hs.execute(cmd, true) end,
        task_run = function(path, args, callback)
            local t = hs.task.new(path, function(exitCode)
                callback(exitCode)
            end, args)
            if t then t:start() end
            return t
        end,
        logger = state.log,
        capture_lines = state.cfg.capture_lines,
    })

    -- Create input with real hs dependencies
    state.input = input_mod.new({
        hotkey_new = function(mods, key, fn)
            return hs.hotkey.new(mods, key, fn)
        end,
        alert_show = function(text, duration)
            hs.alert.show(text, duration)
        end,
        modifier = state.cfg.hotkey_modifier,
    })
    state.input:create()

    -- Create dispatcher with all dependencies
    state.dispatcher = dispatcher_mod.new({
        monitor = monitor,
        parser = parser,
        tts = speaker,
        writer = w,
        input = state.input,
        logger = state.log,
        clock = {
            now = function() return hs.timer.secondsSinceEpoch() end,
            delayed_call = function(seconds, fn)
                return hs.timer.doAfter(seconds, fn)
            end,
        },
        alert = function(text, duration)
            hs.alert.show(text, duration)
        end,
        config = state.cfg,
    })

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
    if state.dispatcher then state.dispatcher:stop() end
    if state.input then state.input:destroy(); state.input = nil end
    state.dispatcher = nil
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
    if state.dispatcher then state.dispatcher:pause() end
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
    if state.dispatcher then state.dispatcher:resume() end
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
