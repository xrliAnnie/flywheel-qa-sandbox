--- Logger: JSONL event log to ~/.claude/voice-loop/logs/events.jsonl
-- MVP: single file append, no rotation. Rotation added in Phase 3.

local M = {}
M.__index = M

--- Create a new logger.
--- @param log_dir string Directory for log files
--- @return table Logger instance
function M.new(log_dir)
    local self = setmetatable({}, M)
    os.execute("mkdir -p '" .. log_dir .. "'")
    self.log_path = log_dir .. "/events.jsonl"
    self.file = io.open(self.log_path, "a")
    return self
end

--- Log an event.
--- @param event_type string Event type (e.g., "detected", "started")
--- @param data table|nil Additional key-value pairs
function M:event(event_type, data)
    if not self.file then return end

    local entry = { ts = os.date("!%Y-%m-%dT%H:%M:%SZ"), type = event_type }
    if data then
        for k, v in pairs(data) do entry[k] = v end
    end

    -- Use hs.json if available, otherwise simple serialization
    local line
    if hs and hs.json and hs.json.encode then
        line = hs.json.encode(entry)
    else
        local parts = {}
        for k, v in pairs(entry) do
            if type(v) == "string" then
                table.insert(parts, string.format('"%s":"%s"', k, v:gsub('"', '\\"')))
            elseif type(v) == "number" or type(v) == "boolean" then
                table.insert(parts, string.format('"%s":%s', k, tostring(v)))
            end
        end
        line = "{" .. table.concat(parts, ",") .. "}"
    end

    self.file:write(line .. "\n")
    self.file:flush()
end

--- Close the log file.
function M:close()
    if self.file then self.file:close(); self.file = nil end
end

return M
