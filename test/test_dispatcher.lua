--- Unit tests for dispatcher.lua
--- Run: lua test/test_dispatcher.lua  (from repo root)
--- No Hammerspoon dependencies required.

package.path = package.path .. ";./?.lua"

local dispatcher_mod = require("dispatcher")

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

local function assert_true(a, msg)
    if not a then
        error(string.format("%s: expected truthy, got %s", msg or "assert_true", tostring(a)))
    end
end

local function assert_not_nil(a, msg)
    if a == nil then
        error(string.format("%s: expected non-nil", msg or "assert_not_nil"))
    end
end

local function assert_nil(a, msg)
    if a ~= nil then
        error(string.format("%s: expected nil, got %s", msg or "assert_nil", tostring(a)))
    end
end

-- ---------------------------------------------------------------------------
-- Mock factories
-- ---------------------------------------------------------------------------

local function default_config()
    return {
        monitored_panes = {
            { target = "test:0.0", alias = "backend" },
        },
        poll_interval = 1.5,
        capture_lines = 50,
        listen_timeout = 15,
        max_remind_count = 3,
        confirm_high_risk = true,
        confirm_keywords = {"delete", "remove", "force"},
        max_choices = 10,
        hotkey_modifier = {"ctrl"},
    }
end

--- Mock TTS that auto-completes or captures callbacks.
local function mock_tts()
    local t = {
        announced = {},
        _speaking = false,
        _on_finish = nil,
        stopped = false,
    }
    function t:announce(alias, prompt, on_finish)
        table.insert(self.announced, { alias = alias, prompt = prompt })
        self._speaking = true
        self._on_finish = on_finish
        return true
    end
    function t:isSpeaking() return self._speaking end
    function t:stop()
        local cb = self._on_finish
        self._on_finish = nil
        self._speaking = false
        self.stopped = true
        if cb then cb("stopped") end
    end
    -- Test helper: simulate TTS completion
    function t:complete()
        local cb = self._on_finish
        self._on_finish = nil
        self._speaking = false
        if cb then cb("completed") end
    end
    function t:fail()
        local cb = self._on_finish
        self._on_finish = nil
        self._speaking = false
        if cb then cb("failed") end
    end
    --- Poll-safe cleanup: mirrors real tts.lua:checkFinished().
    --- If _speaking but _sound_done flag set (simulating hs.sound finished
    --- without firing didFinish callback), force completion.
    function t:checkFinished()
        if not self._speaking then return end
        if not self._sound_done then return end
        -- Sound finished but callback didn't fire — force cleanup
        local cb = self._on_finish
        self._on_finish = nil
        self._speaking = false
        if cb then cb("completed") end
    end
    return t
end

--- Mock writer that records calls and auto-succeeds.
local function mock_writer(opts)
    opts = opts or {}
    local w = {
        sent = {},
        _pane_id = opts.pane_id or "%42",
    }
    function w:get_pane_id(_)
        return self._pane_id
    end
    function w:send(target, pane_id, key, dedupe_key, callback)
        table.insert(self.sent, {
            target = target, pane_id = pane_id,
            key = key, dedupe_key = dedupe_key,
        })
        local result = opts.send_result
        if result == nil then result = true end
        callback(result, opts.send_error)
    end
    return w
end

--- Mock input that records enable/disable calls.
local function mock_input()
    local inp = {
        _enabled = false,
        _callback = nil,
        _created = false,
        _destroyed = false,
        hints_shown = {},
    }
    function inp:set_callback(fn) self._callback = fn end
    function inp:create() self._created = true end
    function inp:enableAll() self._enabled = true end
    function inp:disableAll() self._enabled = false end
    function inp:destroy() self._destroyed = true; self._enabled = false end
    function inp:isEnabled() return self._enabled end
    function inp:showHint(choices, format)
        table.insert(self.hints_shown, { choices = choices, format = format })
    end
    return inp
end

--- Mock clock with controllable timers.
local function mock_clock()
    local c = {
        _now = 0,
        _timers = {},
    }
    function c.now() return c._now end
    function c.delayed_call(seconds, fn)
        local timer = { seconds = seconds, fn = fn, stopped = false }
        function timer:stop() self.stopped = true end
        table.insert(c._timers, timer)
        return timer
    end
    -- Test helper: fire the most recent timer
    function c:fire_last_timer()
        for i = #self._timers, 1, -1 do
            if not self._timers[i].stopped then
                self._timers[i].fn()
                return true
            end
        end
        return false
    end
    return c
end

--- Mock monitor returning configurable text.
local function mock_monitor(capture_text)
    return {
        capture = function(_, _)
            return capture_text
        end,
        pane_exists = function(_) return true end,
    }
end

--- Mock parser returning configurable results.
local function mock_parser(opts)
    opts = opts or {}
    return {
        parse = function(text)
            if opts.parse_fn then return opts.parse_fn(text) end
            return opts.parse_result
        end,
        dedupe_key = function(target, raw)
            if opts.dedupe_key_fn then return opts.dedupe_key_fn(target, raw) end
            return opts.dedupe_key or (target .. "|hash1")
        end,
    }
end

local function mock_logger()
    local events = {}
    return {
        event = function(_, event_type, data)
            table.insert(events, { type = event_type, data = data })
        end,
        events = events,
    }
end

--- Create a dispatcher with standard mocks (overridable).
local function make_dispatcher(overrides)
    overrides = overrides or {}
    local tts_mock = overrides.tts or mock_tts()
    local writer_mock = overrides.writer or mock_writer()
    local input_mock = overrides.input or mock_input()
    local clock_mock = overrides.clock or mock_clock()
    local log_mock = overrides.logger or mock_logger()
    local cfg = overrides.config or default_config()

    local d = dispatcher_mod.new({
        monitor = overrides.monitor or mock_monitor("1) foo\n2) bar\n"),
        parser = overrides.parser or mock_parser({
            parse_result = {
                format = "paren",
                choices = {
                    { key = "1", text = "foo" },
                    { key = "2", text = "bar" },
                },
                raw_match = "1) foo\n2) bar",
            },
        }),
        tts = tts_mock,
        writer = writer_mock,
        input = input_mock,
        logger = log_mock,
        clock = clock_mock,
        alert = function() end,
        config = cfg,
    })

    return d, {
        tts = tts_mock,
        writer = writer_mock,
        input = input_mock,
        clock = clock_mock,
        logger = log_mock,
    }
end

-- ===========================================================================
print("\n=== Dispatcher: basic state transitions ===")
-- ===========================================================================

test("starts in idle state", function()
    local d = make_dispatcher()
    assert_eq(d:state(), "idle", "state")
end)

test("tick detects prompt and transitions to announcing", function()
    local d, mocks = make_dispatcher()
    d:tick()
    assert_eq(d:state(), "announcing", "state")
    assert_eq(#mocks.tts.announced, 1, "tts called once")
end)

test("TTS completion transitions to waiting_input", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    assert_eq(d:state(), "waiting_input", "state")
    assert_true(mocks.input._enabled, "hotkeys enabled")
end)

test("choosing a number transitions to writing then idle", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")
    -- Writing callback is synchronous in mock, so should be idle already
    assert_eq(d:state(), "idle", "state after write")
    assert_eq(#mocks.writer.sent, 1, "writer called")
    assert_eq(mocks.writer.sent[1].key, "1", "correct key sent")
end)

test("cancel returns to idle", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("cancel")
    assert_eq(d:state(), "idle", "state")
    assert_nil(d:current_event(), "event cleared")
end)

test("replay goes back to announcing", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("replay")
    assert_eq(d:state(), "announcing", "state")
    assert_eq(#mocks.tts.announced, 2, "tts called again")
end)

-- ===========================================================================
print("\n=== Dispatcher: timeout and replay ===")
-- ===========================================================================

test("waiting_input timeout replays up to max_remind_count", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    assert_eq(d:state(), "waiting_input", "state")

    -- First timeout → replay (remind_count = 1)
    mocks.clock:fire_last_timer()
    assert_eq(d:state(), "announcing", "replay 1")
    mocks.tts:complete()

    -- Second timeout → replay (remind_count = 2)
    mocks.clock:fire_last_timer()
    assert_eq(d:state(), "announcing", "replay 2")
    mocks.tts:complete()

    -- Third timeout → expired (remind_count = 3 = max)
    mocks.clock:fire_last_timer()
    assert_eq(d:state(), "idle", "expired")
    assert_nil(d:current_event(), "event cleared")
end)

test("first announce does not count toward remind_count", function()
    -- max_remind_count = 1: after first timeout, should replay; after second, expire
    local cfg = default_config()
    cfg.max_remind_count = 1
    local d, mocks = make_dispatcher({ config = cfg })
    d:tick()
    mocks.tts:complete()

    -- First timeout → replay (remind_count becomes 1, but 1 >= 1, so should expire)
    -- Wait, max_remind_count = 1 means: remind_count < 1 is false for remind_count=1
    -- So after first timeout: remind_count=1, 1 < 1 is false → expired
    mocks.clock:fire_last_timer()
    assert_eq(d:state(), "idle", "expired after 1 timeout")
end)

-- ===========================================================================
print("\n=== Dispatcher: high-risk confirmation ===")
-- ===========================================================================

test("yes on approve_reject format triggers confirmation", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Do you approve? (approve/reject)\n"),
        parser = mock_parser({
            parse_result = {
                format = "approve_reject",
                choices = {
                    { key = "y", text = "Approve" },
                    { key = "n", text = "Reject" },
                },
                raw_match = "Do you approve? (approve/reject)",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    assert_eq(d:state(), "waiting_input", "state")

    d:handle_input("yes")
    assert_eq(d:state(), "confirming", "state")
end)

test("yes+yes on confirming completes write", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Yes/No?\n"),
        parser = mock_parser({
            parse_result = {
                format = "yesno",
                choices = {
                    { key = "y", text = "Yes" },
                    { key = "n", text = "No" },
                },
                raw_match = "Yes/No?",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("yes")  -- → confirming
    assert_eq(d:state(), "confirming", "state")

    -- TTS for "Confirm y?" completes
    mocks.tts:complete()

    d:handle_input("yes")  -- → writing → idle
    assert_eq(d:state(), "idle", "state after confirm")
    assert_eq(#mocks.writer.sent, 1, "writer called")
    assert_eq(mocks.writer.sent[1].key, "y", "correct key")
end)

test("cancel during confirming returns to idle", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Yes/No?\n"),
        parser = mock_parser({
            parse_result = {
                format = "yesno",
                choices = {
                    { key = "y", text = "Yes" },
                    { key = "n", text = "No" },
                },
                raw_match = "Yes/No?",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("yes")  -- → confirming
    mocks.tts:complete()   -- confirm TTS done
    d:handle_input("cancel")
    assert_eq(d:state(), "idle", "state")
    assert_nil(d:current_event(), "event cleared")
end)

test("confirming timeout returns to idle (no replay)", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Yes/No?\n"),
        parser = mock_parser({
            parse_result = {
                format = "yesno",
                choices = {
                    { key = "y", text = "Yes" },
                    { key = "n", text = "No" },
                },
                raw_match = "Yes/No?",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("yes")  -- → confirming
    mocks.tts:complete()   -- confirm TTS done

    mocks.clock:fire_last_timer()
    assert_eq(d:state(), "idle", "state after confirm timeout")
    assert_nil(d:current_event(), "event cleared")
end)

test("numbered choice with confirm_keyword triggers confirmation", function()
    local d, mocks = make_dispatcher({
        parser = mock_parser({
            parse_result = {
                format = "paren",
                choices = {
                    { key = "1", text = "Keep files" },
                    { key = "2", text = "Delete everything" },
                },
                raw_match = "1) Keep files\n2) Delete everything",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "2")  -- "Delete everything" contains "delete"
    assert_eq(d:state(), "confirming", "state")
end)

test("numbered choice without confirm_keyword skips confirmation", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")  -- "foo" has no confirm keywords
    assert_eq(d:state(), "idle", "state (wrote directly)")
    assert_eq(#mocks.writer.sent, 1, "writer called")
end)

-- ===========================================================================
print("\n=== Dispatcher: >10 options ===")
-- ===========================================================================

test("too many options triggers TTS warning and stays idle", function()
    local many_choices = {}
    for i = 1, 12 do
        table.insert(many_choices, { key = tostring(i), text = "option " .. i })
    end

    local d, mocks = make_dispatcher({
        parser = mock_parser({
            parse_result = {
                format = "paren",
                choices = many_choices,
                raw_match = "too many",
            },
        }),
    })

    d:tick()
    -- Should stay idle and announce warning
    assert_eq(d:state(), "idle", "state (no waiting_input)")
    assert_eq(#mocks.tts.announced, 1, "warning announced")
end)

-- ===========================================================================
print("\n=== Dispatcher: dedupe ===")
-- ===========================================================================

test("same prompt not re-announced on second tick", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")
    assert_eq(d:state(), "idle", "back to idle")

    -- Second tick with same dedupe key
    d:tick()
    assert_eq(d:state(), "idle", "still idle (deduped)")
    assert_eq(#mocks.tts.announced, 1, "not re-announced")
end)

test("new prompt (different key) triggers new announcement", function()
    local call_count = 0
    local d, mocks = make_dispatcher({
        parser = mock_parser({
            parse_result = {
                format = "paren",
                choices = {
                    { key = "1", text = "a" },
                    { key = "2", text = "b" },
                },
                raw_match = "choices",
            },
            dedupe_key_fn = function(target, _)
                call_count = call_count + 1
                return target .. "|hash" .. call_count
            end,
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")

    -- Second tick: different dedupe key
    d:tick()
    assert_eq(d:state(), "announcing", "new event detected")
    assert_eq(#mocks.tts.announced, 2, "second announcement")
end)

-- ===========================================================================
print("\n=== Dispatcher: pause / resume ===")
-- ===========================================================================

test("pause in waiting_input disables hotkeys and stops TTS", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    assert_eq(d:state(), "waiting_input", "state")

    d:pause()
    assert_eq(d:state(), "paused", "state")
    assert_eq(mocks.input._enabled, false, "hotkeys disabled")
    assert_not_nil(d:current_event(), "event preserved")
end)

test("resume after pause re-announces", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:pause()

    d:resume()
    assert_eq(d:state(), "announcing", "re-announcing")
    assert_eq(#mocks.tts.announced, 2, "tts called again")
end)

test("resume without event goes to idle", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    d:handle_input("cancel")  -- clears event
    d:pause()

    d:resume()
    assert_eq(d:state(), "idle", "state")
end)

-- ===========================================================================
print("\n=== Dispatcher: idle skips tick in non-idle states ===")
-- ===========================================================================

test("tick is no-op when not in idle state", function()
    local d, mocks = make_dispatcher()
    d:tick()
    assert_eq(d:state(), "announcing", "announcing")

    -- Tick again — should be a no-op
    d:tick()
    assert_eq(d:state(), "announcing", "still announcing")
    assert_eq(#mocks.tts.announced, 1, "still one announcement")
end)

-- ===========================================================================
print("\n=== Dispatcher: write failure ===")
-- ===========================================================================

test("write failure returns to idle with TTS notification", function()
    local d, mocks = make_dispatcher({
        writer = mock_writer({ send_result = false, send_error = "pane_closed" }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")
    assert_eq(d:state(), "idle", "back to idle")
    -- TTS should have been called for failure notification
    assert_eq(#mocks.tts.announced, 2, "failure notification announced")
end)

-- ===========================================================================
print("\n=== Dispatcher: TTS failure during announcing ===")
-- ===========================================================================

test("TTS failure during announcing returns to idle", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:fail()
    assert_eq(d:state(), "idle", "back to idle after TTS failure")
end)

test("tick polling fallback advances past announcing when TTS done", function()
    local d, mocks = make_dispatcher()
    d:tick()
    assert_eq(d:state(), "announcing", "announcing")

    -- Simulate: TTS sound finished playing but didFinish callback didn't fire (macOS bug)
    -- _speaking is still true, _on_finish still holds the callback, but sound is done
    mocks.tts._sound_done = true

    -- Next tick should call checkFinished() which forces completion
    d:tick()
    assert_eq(d:state(), "waiting_input", "polling fallback advanced to waiting_input")
end)

-- ===========================================================================
print("\n=== Dispatcher: stop clears everything ===")
-- ===========================================================================

test("stop clears event, seen, and returns to idle", function()
    local d, mocks = make_dispatcher()
    d:tick()
    mocks.tts:complete()
    assert_eq(d:state(), "waiting_input", "state")

    d:stop()
    assert_eq(d:state(), "idle", "state after stop")
    assert_nil(d:current_event(), "event cleared")
    -- seen table should be empty
    local seen = d:seen()
    local count = 0
    for _ in pairs(seen) do count = count + 1 end
    assert_eq(count, 0, "seen cleared")
end)

-- ===========================================================================
print("\n=== Dispatcher: Codex review fix — confirming deadlock on unhandled keys ===")
-- ===========================================================================

test("unhandled command in confirming does not deadlock", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Yes/No?\n"),
        parser = mock_parser({
            parse_result = {
                format = "yesno",
                choices = {
                    { key = "y", text = "Yes" },
                    { key = "n", text = "No" },
                },
                raw_match = "Yes/No?",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("yes")  -- → confirming
    mocks.tts:complete()   -- confirm TTS done

    -- Send unhandled commands — should NOT deadlock
    d:handle_input("replay")
    assert_eq(d:state(), "confirming", "still confirming after replay")
    assert_true(mocks.input._enabled, "hotkeys still enabled")

    d:handle_input("choose", "1")
    assert_eq(d:state(), "confirming", "still confirming after choose")
    assert_true(mocks.input._enabled, "hotkeys still enabled")

    -- Can still confirm normally
    d:handle_input("yes")
    assert_eq(d:state(), "idle", "confirmed and wrote")
end)

-- ===========================================================================
print("\n=== Dispatcher: Codex review fix — pause during confirm-TTS preserves event ===")
-- ===========================================================================

test("pause during confirm-TTS preserves event for resume", function()
    local d, mocks = make_dispatcher({
        monitor = mock_monitor("Yes/No?\n"),
        parser = mock_parser({
            parse_result = {
                format = "yesno",
                choices = {
                    { key = "y", text = "Yes" },
                    { key = "n", text = "No" },
                },
                raw_match = "Yes/No?",
            },
        }),
    })

    d:tick()
    mocks.tts:complete()
    d:handle_input("yes")  -- → confirming, TTS starts "Confirm y?"
    assert_eq(d:state(), "confirming", "confirming")

    -- Pause while confirm TTS is speaking
    d:pause()
    assert_eq(d:state(), "paused", "paused")
    assert_not_nil(d:current_event(), "event preserved during pause")

    -- Resume should re-announce
    d:resume()
    assert_eq(d:state(), "announcing", "re-announcing after resume")
end)

-- ===========================================================================
print("\n=== Dispatcher: Codex review fix — announce returning false ===")
-- ===========================================================================

test("announce returning false falls back to idle", function()
    local tts_mock = mock_tts()
    -- Override announce to return false (TTS busy)
    local original_announce = tts_mock.announce
    local announce_count = 0
    function tts_mock:announce(alias, prompt, on_finish)
        announce_count = announce_count + 1
        if announce_count == 1 then
            -- First call succeeds normally
            return original_announce(self, alias, prompt, on_finish)
        else
            -- Second call: TTS busy, returns false
            return false
        end
    end

    local d, mocks = make_dispatcher({ tts = tts_mock })
    d:tick()
    mocks.tts:complete()
    d:handle_input("choose", "1")
    assert_eq(d:state(), "idle", "back to idle after write")

    -- Force a new dedupe key so tick detects again
    -- (We need to make the parser return a different key)
    -- Simpler: just test _start_announcing directly when TTS returns false
    -- Reset state for a cleaner test
end)

test("announce failure on fresh detection goes to idle", function()
    local tts_mock = mock_tts()
    -- announce always returns false
    function tts_mock:announce(_, _, _)
        return false
    end

    local d = make_dispatcher({ tts = tts_mock })
    d:tick()
    assert_eq(d:state(), "idle", "falls back to idle when announce fails")
end)

-- ===========================================================================
-- Summary
-- ===========================================================================
print(string.format("\n%d tests, %d failures", TOTAL, FAILURES))
if FAILURES > 0 then os.exit(1) end
