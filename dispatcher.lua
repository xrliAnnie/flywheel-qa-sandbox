--- Dispatcher: state machine driving the detect → announce → input → write cycle.
-- States: idle → announcing → waiting_input → confirming → writing
-- Plus: paused (overlay state, preserves current event)

local M = {}
M.__index = M

--- Create a new Dispatcher.
--- @param deps table Injected dependencies:
---   deps.monitor   - { capture(target, lines), pane_exists(target) }
---   deps.parser    - { parse(text), dedupe_key(pane_target, raw_text) }
---   deps.tts       - { announce(alias, prompt, on_finish), stop(), isSpeaking() }
---   deps.writer    - { send(target, pane_id, key, dedupe_key, callback), get_pane_id(target) }
---   deps.input     - { create(), enableAll(), disableAll(), destroy(), set_callback(fn), showHint() }
---   deps.logger    - { event(type, data) }
---   deps.clock     - { now() → number, delayed_call(seconds, fn) → timer_handle with :stop() }
---   deps.alert     - function(text, duration) (optional)
---   deps.config    - merged config table
function M.new(deps)
    local self = setmetatable({}, M)
    self._monitor = deps.monitor
    self._parser = deps.parser
    self._tts = deps.tts
    self._writer = deps.writer
    self._input = deps.input
    self._logger = deps.logger
    self._clock = deps.clock
    self._alert = deps.alert or function() end
    self._cfg = deps.config

    -- State
    self._state = "idle"
    self._event = nil       -- current event being processed
    self._timeout_timer = nil
    self._remind_count = 0
    self._seen = {}         -- pane_target → last dedupe_key

    -- Wire input callback
    self._input:set_callback(function(command, value)
        self:handle_input(command, value)
    end)

    return self
end

--- Get current state (for testing/debugging).
--- @return string
function M:state()
    return self._state
end

--- Get current event (for testing).
--- @return table|nil
function M:current_event()
    return self._event
end

--- Get seen table (for testing).
--- @return table
function M:seen()
    return self._seen
end

-- =========================================================================
-- State transitions
-- =========================================================================

--- Transition to a new state with logging.
function M:_transition(new_state)
    local old = self._state
    self._state = new_state
    if self._logger then
        self._logger:event("state_change", { from = old, to = new_state })
    end
end

--- Cancel any active timeout timer.
function M:_cancel_timeout()
    if self._timeout_timer then
        self._timeout_timer:stop()
        self._timeout_timer = nil
    end
end

--- Start a timeout timer for the current state.
--- @param seconds number
--- @param on_timeout function
function M:_start_timeout(seconds, on_timeout)
    self:_cancel_timeout()
    self._timeout_timer = self._clock.delayed_call(seconds, on_timeout)
end

-- =========================================================================
-- Polling (idle state)
-- =========================================================================

--- Main tick: called periodically by the timer.
function M:tick()
    -- Polling fallback: if TTS finished but didFinish callback didn't fire
    -- (macOS audio bug), force cleanup which triggers the on_finish callback.
    -- Always check, not just in announcing state, since fire-and-forget
    -- announcements (e.g., "No response, skipping") can leave _speaking=true.
    if self._tts.checkFinished then self._tts:checkFinished() end

    if self._state == "announcing" then return end
    if self._state ~= "idle" then return end

    for _, pane in ipairs(self._cfg.monitored_panes) do
        local text = self._monitor.capture(pane.target, self._cfg.capture_lines)
        if text and #text > 0 then
            local prompt = self._parser.parse(text)
            if prompt then
                local key = self._parser.dedupe_key(pane.target, prompt.raw_match)
                if self._seen[pane.target] ~= key then
                    self._seen[pane.target] = key

                    -- Check >10 options
                    if prompt.choices and #prompt.choices > self._cfg.max_choices then
                        self._tts:announce(pane.alias,
                            "Too many options, please handle manually.", nil)
                        if self._logger then
                            self._logger:event("too_many_options", {
                                pane = pane.target,
                                count = #prompt.choices,
                            })
                        end
                        -- Don't enter waiting_input; stay idle
                        return
                    end

                    -- Record pane_id at detection time
                    local pane_id = self._writer:get_pane_id(pane.target)

                    -- Build event
                    self._event = {
                        pane = pane,
                        prompt = prompt,
                        dedupe_key = key,
                        pane_id = pane_id,
                    }
                    self._remind_count = 0

                    if self._logger then
                        self._logger:event("detected", {
                            pane = pane.target,
                            alias = pane.alias,
                            format = prompt.format,
                            choices = prompt.choices and #prompt.choices or 0,
                        })
                    end

                    self:_start_announcing()
                    return  -- process one event at a time
                end
            end
        end
    end
end

-- =========================================================================
-- Announcing
-- =========================================================================

function M:_start_announcing()
    self:_transition("announcing")
    local ev = self._event
    local ok = self._tts:announce(ev.pane.alias, ev.prompt, function(reason)
        self:_on_tts_done(reason)
    end)
    if not ok then
        -- TTS busy or failed to start — fall back to idle
        if self._logger then
            self._logger:event("announce_failed", { pane = ev.pane.target })
        end
        self:_transition("idle")
    end
end

function M:_on_tts_done(reason)
    if self._state ~= "announcing" then return end  -- e.g., paused/stopped

    if reason == "completed" then
        self:_enter_waiting_input()
    else
        -- TTS failed or was stopped — go back to idle, event stays for retry
        self:_transition("idle")
    end
end

-- =========================================================================
-- Waiting for input
-- =========================================================================

function M:_enter_waiting_input()
    self:_transition("waiting_input")
    local ev = self._event

    -- Show hint and enable hotkeys
    self._input:enableAll()
    if ev.prompt then
        self._input:showHint(ev.prompt.choices, ev.prompt.format)
    end

    -- Start timeout
    self:_start_timeout(self._cfg.listen_timeout, function()
        self:_on_waiting_timeout()
    end)
end

function M:_on_waiting_timeout()
    if self._state ~= "waiting_input" then return end

    self._input:disableAll()
    self._remind_count = self._remind_count + 1

    if self._remind_count < self._cfg.max_remind_count then
        -- Replay
        if self._logger then
            self._logger:event("replay", {
                pane = self._event.pane.target,
                remind_count = self._remind_count,
            })
        end
        self:_start_announcing()
    else
        -- Expired
        if self._logger then
            self._logger:event("expired", {
                pane = self._event.pane.target,
                remind_count = self._remind_count,
            })
        end
        self._tts:announce(self._event.pane.alias,
            "No response, skipping.", nil)
        self._event = nil
        self:_transition("idle")
    end
end

-- =========================================================================
-- Input handling
-- =========================================================================

--- Handle user input from hotkeys (public for testing).
--- @param command string "choose"/"yes"/"no"/"replay"/"cancel"
--- @param value string|nil Choice value for "choose" command
function M:handle_input(command, value)
    if self._state == "waiting_input" then
        self:_handle_waiting_input(command, value)
    elseif self._state == "confirming" then
        self:_handle_confirming_input(command, value)
    end
    -- Ignore input in other states
end

function M:_handle_waiting_input(command, value)
    self:_cancel_timeout()
    self._input:disableAll()

    if command == "cancel" then
        if self._logger then
            self._logger:event("cancelled", { pane = self._event.pane.target })
        end
        self._event = nil
        self:_transition("idle")
        return
    end

    if command == "replay" then
        self:_start_announcing()
        return
    end

    -- Determine the key to send
    local send_key
    if command == "choose" then
        send_key = value
    elseif command == "yes" then
        send_key = "y"
    elseif command == "no" then
        send_key = "n"
    end

    if not send_key then return end

    -- Check if high-risk confirmation needed
    if self:_needs_confirmation(command, value) then
        self._event.pending_key = send_key
        self:_enter_confirming()
        return
    end

    self:_start_writing(send_key)
end

function M:_handle_confirming_input(command, _value)
    -- Only act on yes/cancel/no — ignore all other commands to avoid deadlock
    if command == "yes" then
        self:_cancel_timeout()
        self._input:disableAll()
        local key = self._event.pending_key
        self._event.pending_key = nil
        self:_start_writing(key)
    elseif command == "cancel" or command == "no" then
        self:_cancel_timeout()
        self._input:disableAll()
        if self._logger then
            self._logger:event("confirm_cancelled", { pane = self._event.pane.target })
        end
        self._event.pending_key = nil
        self._event = nil
        self:_transition("idle")
    end
    -- Other commands (choose, replay) are no-ops — timer and hotkeys stay active
end

-- =========================================================================
-- High-risk confirmation
-- =========================================================================

--- Check if an action needs two-step confirmation.
function M:_needs_confirmation(command, value)
    if not self._cfg.confirm_high_risk then return false end

    local ev = self._event
    local format = ev.prompt and ev.prompt.format

    -- yes/no and approve/reject always need confirmation
    if format == "yesno" or format == "approve_reject" then
        if command == "yes" then return true end
    end

    -- Numbered choice: check if option text contains confirm_keywords
    if command == "choose" and ev.prompt and ev.prompt.choices then
        for _, choice in ipairs(ev.prompt.choices) do
            if choice.key == value then
                local text_lower = (choice.text or ""):lower()
                for _, keyword in ipairs(self._cfg.confirm_keywords) do
                    if text_lower:find(keyword, 1, true) then
                        return true
                    end
                end
                break
            end
        end
    end

    return false
end

function M:_enter_confirming()
    self:_transition("confirming")
    local ev = self._event
    self._tts:announce(ev.pane.alias, "Confirm " .. ev.pending_key .. "?", function(reason)
        if self._state ~= "confirming" then return end
        if reason == "completed" then
            self._input:enableAll()
            self:_start_timeout(self._cfg.listen_timeout, function()
                self:_on_confirming_timeout()
            end)
        else
            -- TTS failed during confirm — cancel
            self._event.pending_key = nil
            self._event = nil
            self:_transition("idle")
        end
    end)
end

function M:_on_confirming_timeout()
    if self._state ~= "confirming" then return end

    self._input:disableAll()
    if self._logger then
        self._logger:event("confirm_timeout", { pane = self._event.pane.target })
    end
    -- Confirming timeout → back to idle (no replay, no remind_count increment)
    self._event.pending_key = nil
    self._event = nil
    self:_transition("idle")
end

-- =========================================================================
-- Writing
-- =========================================================================

function M:_start_writing(key)
    self:_transition("writing")
    local ev = self._event

    self._writer:send(
        ev.pane.target,
        ev.pane_id,
        key,
        ev,
        function(ok, err_reason)
            self:_on_write_done(ok, err_reason)
        end
    )
end

function M:_on_write_done(ok, err_reason)
    if self._state == "paused" then
        -- Paused while writing — discard result
        return
    end
    if self._state ~= "writing" then return end

    if ok then
        if self._logger then
            self._logger:event("write_ok", { pane = self._event.pane.target })
        end
    else
        if self._logger then
            self._logger:event("write_failed", {
                pane = self._event.pane.target,
                reason = err_reason,
            })
        end
        -- Notify user
        local msg
        if err_reason == "pane_closed" then
            msg = "Pane closed, skipping."
        elseif err_reason == "pane_changed" then
            msg = "Pane changed, skipping."
        elseif err_reason == "prompt_changed" then
            msg = "Prompt changed, skipping."
        elseif err_reason == "prompt_gone" then
            msg = "Prompt gone, skipping."
        else
            msg = "Write failed."
        end
        self._tts:announce(self._event.pane.alias, msg, nil)
    end

    self._event = nil
    self:_transition("idle")
end

-- =========================================================================
-- Pause / Resume
-- =========================================================================

--- Pause the dispatcher. Safe to call in any state.
function M:pause()
    self._input:disableAll()
    self:_cancel_timeout()
    -- Transition to paused BEFORE stopping TTS, so that TTS stop() callback
    -- sees state=paused and doesn't clear _event (fixes confirm-TTS race)
    self:_transition("paused")
    self._tts:stop()
end

--- Resume the dispatcher.
function M:resume()
    if self._state ~= "paused" then return end

    if self._event then
        -- Re-announce the current event
        self._remind_count = 0
        self:_start_announcing()
    else
        self:_transition("idle")
    end
end

--- Full stop — clear all state.
function M:stop()
    self._input:disableAll()
    self:_cancel_timeout()
    self._tts:stop()
    self._event = nil
    self._seen = {}
    self._remind_count = 0
    self:_transition("idle")
end

return M
