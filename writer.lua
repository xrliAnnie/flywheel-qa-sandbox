--- Writer: tmux send-keys with pane validation and fingerprint re-verification.
-- Ensures the target pane still exists, has the same pane_id, and the prompt
-- fingerprint hasn't changed before writing.

local M = {}
M.__index = M

--- Create a new Writer instance.
--- @param deps table Injected dependencies:
---   deps.monitor  - { capture(target, lines), pane_exists(target) }
---   deps.parser   - { parse(text), dedupe_key(pane_target, raw_text) }
---   deps.execute  - function(cmd) → output, ok  (sync shell, e.g., hs.execute)
---   deps.task_run - function(path, args, callback) → task  (async, e.g., hs.task wrapper)
---   deps.logger   - { event(type, data) } (optional)
---   deps.capture_lines - number (default 50)
---   deps.tmux_path - string (optional, default: auto-detect via `which tmux`)
function M.new(deps)
    local self = setmetatable({}, M)
    self._monitor = deps.monitor
    self._parser = deps.parser
    self._execute = deps.execute
    self._task_run = deps.task_run
    self._logger = deps.logger
    self._capture_lines = deps.capture_lines or 50
    -- Auto-detect tmux path if not provided
    if deps.tmux_path then
        self._tmux_path = deps.tmux_path
    else
        local f = io.popen("which tmux 2>/dev/null")
        local path = f and f:read("*l") or nil
        if f then f:close() end
        self._tmux_path = (path and #path > 0) and path or "/usr/local/bin/tmux"
    end
    return self
end

--- Shell-escape a string (POSIX single-quote escaping).
local function shell_escape(s)
    return "'" .. s:gsub("'", "'\\''") .. "'"
end

--- Get the pane_id for a tmux target.
--- @param target string tmux pane target
--- @return string|nil pane_id (e.g., "%42")
function M:get_pane_id(target)
    local cmd = string.format(
        "tmux display-message -p -t %s '#{pane_id}' 2>/dev/null",
        shell_escape(target)
    )
    local output, ok = self._execute(cmd)
    if ok and output then
        local id = output:match("^(.-)%s*$")
        if id and #id > 0 then return id end
    end
    return nil
end

--- Verify pane exists and pane_id matches.
--- @param target string tmux pane target
--- @param expected_pane_id string pane_id recorded at detection time
--- @return boolean ok, string|nil error_reason
function M:_verify_pane(target, expected_pane_id)
    local current_id = self:get_pane_id(target)
    if not current_id then
        return false, "pane_closed"
    end
    if current_id ~= expected_pane_id then
        return false, "pane_changed"
    end
    return true, nil
end

--- Re-verify that the prompt is still visible by re-capturing and re-parsing.
--- Compares format and choice keys (not full raw_match hash, which is fragile
--- because scrollback content shifts between captures).
--- @param target string tmux pane target
--- @param expected_event table The original event with prompt info
--- @return boolean ok, string|nil error_reason
function M:_verify_fingerprint(target, expected_event)
    local text = self._monitor.capture(target, self._capture_lines)
    if not text or #text == 0 then
        return false, "prompt_gone"
    end

    local prompt = self._parser.parse(text)
    if not prompt then
        return false, "prompt_gone"
    end

    -- Compare format
    local expected_prompt = expected_event.prompt
    if prompt.format ~= expected_prompt.format then
        return false, "prompt_changed"
    end

    -- Compare choice keys (order-sensitive)
    local expected_choices = expected_prompt.choices or {}
    local current_choices = prompt.choices or {}
    if #current_choices ~= #expected_choices then
        return false, "prompt_changed"
    end
    for i, ec in ipairs(expected_choices) do
        if current_choices[i].key ~= ec.key then
            return false, "prompt_changed"
        end
    end

    return true, nil
end

--- Send a key sequence to a tmux pane after validation.
--- @param target string tmux pane target (e.g., "main:0.1")
--- @param pane_id string pane_id recorded at detection time
--- @param key string Key to send (e.g., "1", "y")
--- @param event table Event with prompt info for fingerprint verification
--- @param callback function callback(ok, error_reason)
--- @param retry_count number|nil Internal: current retry count (default 0)
function M:send(target, pane_id, key, event, callback, retry_count)
    retry_count = retry_count or 0

    -- Step 1: Verify pane exists + pane_id matches
    local pane_ok, pane_err = self:_verify_pane(target, pane_id)
    if not pane_ok then
        if self._logger then
            self._logger:event("write_failed", { pane = target, reason = pane_err })
        end
        callback(false, pane_err)
        return
    end

    -- Step 2: Re-verify prompt is still visible (format + choices, not raw hash)
    local fp_ok, fp_err = self:_verify_fingerprint(target, event)
    if not fp_ok then
        if self._logger then
            self._logger:event("write_failed", { pane = target, reason = fp_err })
        end
        callback(false, fp_err)
        return
    end

    -- Step 3: send-keys (async)
    local send_args = { "send-keys", "-t", target, key, "Enter" }
    local task_handle = self._task_run(self._tmux_path, send_args, function(exit_code)
        if exit_code == 0 then
            if self._logger then
                self._logger:event("write_ok", { pane = target, key = key })
            end
            callback(true, nil)
        else
            -- Retry once on send-keys failure
            if retry_count < 1 then
                self:send(target, pane_id, key, event, callback, retry_count + 1)
            else
                if self._logger then
                    self._logger:event("write_failed", {
                        pane = target, key = key, reason = "send_keys_failed",
                    })
                end
                callback(false, "send_keys_failed")
            end
        end
    end)

    -- If task creation failed, callback will never fire — fail fast
    if not task_handle then
        if self._logger then
            self._logger:event("write_failed", {
                pane = target, key = key, reason = "send_keys_failed",
            })
        end
        callback(false, "send_keys_failed")
    end
end

return M
