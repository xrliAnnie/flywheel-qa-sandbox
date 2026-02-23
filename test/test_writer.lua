--- Unit tests for writer.lua
--- Run: lua test/test_writer.lua  (from repo root)
--- No Hammerspoon dependencies required.

package.path = package.path .. ";./?.lua"

local writer_mod = require("writer")

-- ---------------------------------------------------------------------------
-- Test harness (same as test_parser.lua)
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

-- ---------------------------------------------------------------------------
-- Mock helpers
-- ---------------------------------------------------------------------------

--- Create a mock monitor that returns configurable capture text and pane_id.
local function mock_monitor(opts)
    opts = opts or {}
    return {
        capture = function(_, _)
            return opts.capture_text
        end,
        pane_exists = function(_)
            return opts.pane_exists ~= false
        end,
    }
end

--- Create a mock parser with configurable parse result and dedupe_key.
local function mock_parser(opts)
    opts = opts or {}
    return {
        parse = function(text)
            if opts.parse_result == nil and opts.parse_fn then
                return opts.parse_fn(text)
            end
            return opts.parse_result
        end,
        dedupe_key = function(target, raw)
            if opts.dedupe_key_fn then
                return opts.dedupe_key_fn(target, raw)
            end
            return opts.dedupe_key_value or (target .. "|abc123")
        end,
    }
end

--- Create a mock execute that returns configurable pane_id.
local function mock_execute(pane_id)
    return function(_)
        if pane_id then
            return pane_id .. "\n", true
        else
            return nil, false
        end
    end
end

--- Create a mock task_run that calls callback with configurable exit code.
local function mock_task_run(exit_code)
    return function(_, _, callback)
        callback(exit_code or 0)
        return {} -- dummy task handle
    end
end

--- Create a mock logger.
local function mock_logger()
    local events = {}
    return {
        event = function(_, event_type, data)
            table.insert(events, { type = event_type, data = data })
        end,
        events = events,
    }
end

-- ===========================================================================
print("\n=== Writer: pane validation ===")
-- ===========================================================================

test("send succeeds when pane exists, pane_id matches, fingerprint matches", function()
    local log = mock_logger()
    local w = writer_mod.new({
        monitor = mock_monitor({
            capture_text = "1) foo\n2) bar\n",
        }),
        parser = mock_parser({
            parse_result = { format = "paren", choices = {}, raw_match = "1) foo\n2) bar" },
            dedupe_key_value = "test:0.0|abc123",
        }),
        execute = mock_execute("%42"),
        task_run = mock_task_run(0),
        logger = log,
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_true(result_ok, "should succeed")
    assert_eq(result_err, nil, "no error")
end)

test("send fails when pane does not exist", function()
    local log = mock_logger()
    local w = writer_mod.new({
        monitor = mock_monitor(),
        parser = mock_parser(),
        execute = mock_execute(nil),  -- pane not found
        task_run = mock_task_run(0),
        logger = log,
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "pane_closed", "reason")
end)

test("send fails when pane_id changed", function()
    local log = mock_logger()
    local w = writer_mod.new({
        monitor = mock_monitor(),
        parser = mock_parser(),
        execute = mock_execute("%99"),  -- different pane_id
        task_run = mock_task_run(0),
        logger = log,
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "pane_changed", "reason")
end)

-- ===========================================================================
print("\n=== Writer: fingerprint re-verification ===")
-- ===========================================================================

test("send fails when capture returns empty", function()
    local w = writer_mod.new({
        monitor = mock_monitor({ capture_text = "" }),
        parser = mock_parser(),
        execute = mock_execute("%42"),
        task_run = mock_task_run(0),
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "prompt_gone", "reason")
end)

test("send fails when parser returns nil (prompt gone)", function()
    local w = writer_mod.new({
        monitor = mock_monitor({ capture_text = "some text" }),
        parser = mock_parser({ parse_result = nil }),
        execute = mock_execute("%42"),
        task_run = mock_task_run(0),
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "prompt_gone", "reason")
end)

test("send fails when dedupe_key doesn't match (prompt changed)", function()
    local w = writer_mod.new({
        monitor = mock_monitor({ capture_text = "1) new\n2) choices\n" }),
        parser = mock_parser({
            parse_result = { format = "paren", choices = {}, raw_match = "1) new\n2) choices" },
            dedupe_key_value = "test:0.0|DIFFERENT",
        }),
        execute = mock_execute("%42"),
        task_run = mock_task_run(0),
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "prompt_changed", "reason")
end)

-- ===========================================================================
print("\n=== Writer: send-keys retry ===")
-- ===========================================================================

test("send retries once on send-keys failure, then fails", function()
    local call_count = 0
    local w = writer_mod.new({
        monitor = mock_monitor({
            capture_text = "1) foo\n2) bar\n",
        }),
        parser = mock_parser({
            parse_result = { format = "paren", choices = {}, raw_match = "1) foo\n2) bar" },
            dedupe_key_value = "test:0.0|abc123",
        }),
        execute = mock_execute("%42"),
        task_run = function(_, _, callback)
            call_count = call_count + 1
            callback(1)  -- always fail
            return {}
        end,
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail after retry")
    assert_eq(result_err, "send_keys_failed", "reason")
    -- task_run called twice: initial + 1 retry
    -- But note: each send() call does pane verify + fingerprint verify + task_run
    -- So call_count for task_run specifically should be 2
    assert_eq(call_count, 2, "task_run called twice")
end)

test("send succeeds on retry after first failure", function()
    local call_count = 0
    local w = writer_mod.new({
        monitor = mock_monitor({
            capture_text = "1) foo\n2) bar\n",
        }),
        parser = mock_parser({
            parse_result = { format = "paren", choices = {}, raw_match = "1) foo\n2) bar" },
            dedupe_key_value = "test:0.0|abc123",
        }),
        execute = mock_execute("%42"),
        task_run = function(_, _, callback)
            call_count = call_count + 1
            if call_count == 1 then
                callback(1)  -- first call fails
            else
                callback(0)  -- retry succeeds
            end
            return {}
        end,
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_true(result_ok, "should succeed on retry")
    assert_eq(result_err, nil, "no error")
end)

-- ===========================================================================
print("\n=== Writer: get_pane_id ===")
-- ===========================================================================

test("get_pane_id returns trimmed pane id", function()
    local w = writer_mod.new({
        monitor = mock_monitor(),
        parser = mock_parser(),
        execute = function(_)
            return "%42\n", true
        end,
        task_run = mock_task_run(0),
    })

    assert_eq(w:get_pane_id("test:0.0"), "%42", "pane_id")
end)

test("get_pane_id returns nil on failure", function()
    local w = writer_mod.new({
        monitor = mock_monitor(),
        parser = mock_parser(),
        execute = function(_) return nil, false end,
        task_run = mock_task_run(0),
    })

    assert_eq(w:get_pane_id("test:0.0"), nil, "should be nil")
end)

-- ===========================================================================
print("\n=== Writer: task_run returning nil (Codex review fix) ===")
-- ===========================================================================

test("send fails fast when task_run returns nil", function()
    local w = writer_mod.new({
        monitor = mock_monitor({
            capture_text = "1) foo\n2) bar\n",
        }),
        parser = mock_parser({
            parse_result = { format = "paren", choices = {}, raw_match = "1) foo\n2) bar" },
            dedupe_key_value = "test:0.0|abc123",
        }),
        execute = mock_execute("%42"),
        task_run = function(_, _, _)
            return nil  -- task creation failed, callback never called
        end,
        logger = mock_logger(),
    })

    local result_ok, result_err
    w:send("test:0.0", "%42", "1", "test:0.0|abc123", function(ok, err)
        result_ok = ok
        result_err = err
    end)

    assert_eq(result_ok, false, "should fail")
    assert_eq(result_err, "send_keys_failed", "reason")
end)

-- ===========================================================================
-- Summary
-- ===========================================================================
print(string.format("\n%d tests, %d failures", TOTAL, FAILURES))
if FAILURES > 0 then os.exit(1) end
