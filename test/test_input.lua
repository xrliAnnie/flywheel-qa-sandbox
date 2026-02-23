--- Unit tests for input.lua
--- Run: lua test/test_input.lua  (from repo root)
--- No Hammerspoon dependencies required.

package.path = package.path .. ";./?.lua"

local input_mod = require("input")

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

-- ---------------------------------------------------------------------------
-- Mock hotkey
-- ---------------------------------------------------------------------------
local function mock_hotkey_new()
    local hotkeys = {}
    local function factory(mods, key, fn)
        local hk = {
            mods = mods,
            key = key,
            fn = fn,
            enabled = false,
            deleted = false,
        }
        function hk:enable() self.enabled = true end
        function hk:disable() self.enabled = false end
        function hk:delete() self.deleted = true; self.enabled = false end
        table.insert(hotkeys, hk)
        return hk
    end
    return factory, hotkeys
end

-- ===========================================================================
print("\n=== Input: creation and lifecycle ===")
-- ===========================================================================

test("create registers all 14 hotkeys", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({
        hotkey_new = factory,
        modifier = {"ctrl"},
    })
    inp:create()
    assert_eq(#hotkeys, 14, "14 hotkeys (0-9, y, n, r, x)")
end)

test("hotkeys start disabled after create", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    for _, hk in ipairs(hotkeys) do
        assert_eq(hk.enabled, false, "hotkey " .. hk.key .. " should be disabled")
    end
end)

test("enableAll enables all hotkeys", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    inp:enableAll()
    assert_true(inp:isEnabled(), "isEnabled")
    for _, hk in ipairs(hotkeys) do
        assert_true(hk.enabled, "hotkey " .. hk.key .. " should be enabled")
    end
end)

test("disableAll disables all hotkeys", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    inp:enableAll()
    inp:disableAll()
    assert_eq(inp:isEnabled(), false, "isEnabled")
    for _, hk in ipairs(hotkeys) do
        assert_eq(hk.enabled, false, "hotkey " .. hk.key .. " should be disabled")
    end
end)

test("destroy deletes all hotkeys", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    inp:destroy()
    for _, hk in ipairs(hotkeys) do
        assert_true(hk.deleted, "hotkey " .. hk.key .. " should be deleted")
    end
end)

-- ===========================================================================
print("\n=== Input: command mapping ===")
-- ===========================================================================

test("Ctrl+1 triggers choose/1", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd, received_val
    inp:set_callback(function(cmd, val)
        received_cmd = cmd
        received_val = val
    end)

    -- Find the "1" hotkey and trigger it
    for _, hk in ipairs(hotkeys) do
        if hk.key == "1" then
            hk.fn()
            break
        end
    end
    assert_eq(received_cmd, "choose", "command")
    assert_eq(received_val, "1", "value")
end)

test("Ctrl+0 triggers choose/10", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd, received_val
    inp:set_callback(function(cmd, val)
        received_cmd = cmd
        received_val = val
    end)

    for _, hk in ipairs(hotkeys) do
        if hk.key == "0" then
            hk.fn()
            break
        end
    end
    assert_eq(received_cmd, "choose", "command")
    assert_eq(received_val, "10", "value")
end)

test("Ctrl+Y triggers yes", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd
    inp:set_callback(function(cmd) received_cmd = cmd end)

    for _, hk in ipairs(hotkeys) do
        if hk.key == "y" then hk.fn(); break end
    end
    assert_eq(received_cmd, "yes", "command")
end)

test("Ctrl+N triggers no", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd
    inp:set_callback(function(cmd) received_cmd = cmd end)

    for _, hk in ipairs(hotkeys) do
        if hk.key == "n" then hk.fn(); break end
    end
    assert_eq(received_cmd, "no", "command")
end)

test("Ctrl+R triggers replay", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd
    inp:set_callback(function(cmd) received_cmd = cmd end)

    for _, hk in ipairs(hotkeys) do
        if hk.key == "r" then hk.fn(); break end
    end
    assert_eq(received_cmd, "replay", "command")
end)

test("Ctrl+X triggers cancel", function()
    local factory, hotkeys = mock_hotkey_new()
    local inp = input_mod.new({ hotkey_new = factory })
    inp:create()
    local received_cmd
    inp:set_callback(function(cmd) received_cmd = cmd end)

    for _, hk in ipairs(hotkeys) do
        if hk.key == "x" then hk.fn(); break end
    end
    assert_eq(received_cmd, "cancel", "command")
end)

-- ===========================================================================
print("\n=== Input: showHint ===")
-- ===========================================================================

test("showHint called with choices", function()
    local alert_text
    local inp = input_mod.new({
        hotkey_new = function(_, _, _) return { enable = function() end, disable = function() end, delete = function() end } end,
        alert_show = function(text, _) alert_text = text end,
    })

    inp:showHint(
        {{ key = "1", text = "foo" }, { key = "2", text = "bar" }},
        "paren"
    )
    assert_true(alert_text:find("Ctrl%+1"), "contains Ctrl+1")
    assert_true(alert_text:find("Ctrl%+2"), "contains Ctrl+2")
end)

test("showHint for yesno format", function()
    local alert_text
    local inp = input_mod.new({
        hotkey_new = function(_, _, _) return { enable = function() end, disable = function() end, delete = function() end } end,
        alert_show = function(text, _) alert_text = text end,
    })

    inp:showHint(nil, "yesno")
    assert_true(alert_text:find("Ctrl%+Y"), "contains Ctrl+Y")
    assert_true(alert_text:find("Ctrl%+N"), "contains Ctrl+N")
end)

-- ===========================================================================
-- Summary
-- ===========================================================================
print(string.format("\n%d tests, %d failures", TOTAL, FAILURES))
if FAILURES > 0 then os.exit(1) end
