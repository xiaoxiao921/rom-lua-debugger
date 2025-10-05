local socket = require("socket")

local client = nil

local debug = _G._rom_open_debug()

local COMMANDS = {
    BP_ADD       = 1,
    BP_CLEAR_FILE     = 2,
    CONTINUE    = 3,
    STEP_IN      = 4,
    STEP_OUT     = 5,
    STEP_NEXT        = 6,
}

local RESPONSES = {
    STOP        = 100,
    CONTINUED   = 104,
}

local string_to_command_str = {
    [COMMANDS.BP_ADD] = "BP_ADD",
    [COMMANDS.BP_CLEAR_FILE] = "BP_CLEAR_FILE",
    [COMMANDS.CONTINUE] = "CONTINUE",
    [COMMANDS.STEP_IN] = "STEP_IN",
    [COMMANDS.STEP_OUT] = "STEP_OUT",
    [COMMANDS.STEP_NEXT] = "STEP_NEXT",
}

local SocketWrapper = {}
SocketWrapper.__index = SocketWrapper

function SocketWrapper.new(host, port)
    local self = setmetatable({}, SocketWrapper)
    self.server = assert(socket.bind(host, port))
    return self
end

function SocketWrapper:accept()
    return self.server:accept()
end

function SocketWrapper:settimeout(timeout)
    self.server:settimeout(timeout)
end

function SocketWrapper:close()
    if self.server then
        self.server:close()
        self.server = nil
    end
end

function SocketWrapper:__gc()
    self:close()
end

-- attach __gc to metatable
debug.setmetatable(SocketWrapper, { __gc = SocketWrapper.__gc })

local NetBuffer = {}
NetBuffer.__index = NetBuffer

-- constructor
function NetBuffer:new()
    return setmetatable({ data = {}, read_cursor = 1 }, self)
end

-- initialize NetBuffer from raw string data
function NetBuffer:from_str(str)
    local buf = NetBuffer:new()
    for i = 1, #str do
        buf.data[i] = str:byte(i)
    end
    return buf
end

function NetBuffer:write_byte(b)
    table.insert(self.data, bit32.band(b, 0xFF))
end

function NetBuffer:write_short(s)
    table.insert(self.data, bit32.band(bit32.rshift(s, 8), 0xFF))
    table.insert(self.data, bit32.band(s, 0xFF))
end

function NetBuffer:write_int(i)
    table.insert(self.data, bit32.band(bit32.rshift(i, 24), 0xFF))
    table.insert(self.data, bit32.band(bit32.rshift(i, 16), 0xFF))
    table.insert(self.data, bit32.band(bit32.rshift(i, 8), 0xFF))
    table.insert(self.data, bit32.band(i, 0xFF))
end

function NetBuffer:write_string(s)
    self:write_short(#s)
    for i = 1, #s do
        self:write_byte(s:byte(i))
    end
end

-- read functions (numeric bytes)
function NetBuffer:read_byte()
    local byte = self.data[self.read_cursor]
    self.read_cursor = self.read_cursor + 1
    return byte
end

function NetBuffer:read_short()
    local b1 = self:read_byte()
    local b2 = self:read_byte()
    return bit32.bor(bit32.lshift(b1, 8), b2)
end

function NetBuffer:read_int()
    local b1 = self:read_byte()
    local b2 = self:read_byte()
    local b3 = self:read_byte()
    local b4 = self:read_byte()
    return bit32.bor(
        bit32.lshift(b1, 24),
        bit32.lshift(b2, 16),
        bit32.lshift(b3, 8),
        b4
    )
end

function NetBuffer:read_string()
    local length = self:read_short()
    local chars = {}
    for i = 1, length do
        chars[i] = string.char(self:read_byte())
    end
    return table.concat(chars)
end

local function pack_u32_be(n)
    -- n: unsigned 32-bit int
    local b1 = bit32.band(bit32.rshift(n, 24), 0xFF)
    local b2 = bit32.band(bit32.rshift(n, 16), 0xFF)
    local b3 = bit32.band(bit32.rshift(n, 8), 0xFF)
    local b4 = bit32.band(n, 0xFF)
    return string.char(b1, b2, b3, b4)
end

local function unpack_u32_be(s)
    local b1, b2, b3, b4 = s:byte(1, 4)
    return bit32.lshift(b1, 24)
         + bit32.lshift(b2, 16)
         + bit32.lshift(b3, 8)
         + b4
end

function NetBuffer:send(sock)
    if not sock then return end
    local payload = {}
    for i = 1, #self.data do
        payload[i] = string.char(self.data[i])
    end
    local data = table.concat(payload)
    print("packet length:",#data)
    local header = pack_u32_be(#data)
    print("sending the data to vscode")
    sock:send(header .. data)
    print("sent the data to vscode")
end

-- debug helper: hex dump of NetBuffer
function NetBuffer:hex_dump()
    local parts = {}
    for i = 1, #self.data do
        parts[i] = string.format("%02X", self.data[i])
    end
    return table.concat(parts, " ")
end

local function get_locals_and_globals(info)
    local debug_locals = {}
    local debug_locals_size = 0
    local i = 1
    while true do
        local k, v = debug.getlocal(4, i)
        if not k then break end
        debug_locals[i] = {k, tostring(v)}
        i = i + 1
        debug_locals_size = debug_locals_size + 1
    end

    local debug_globals = {}
    local debug_globals_size = 0
    i = 1
    for k, v in pairs(_G) do
        debug_globals[i] = {k, tostring(v)}
        debug_globals_size = debug_globals_size + 1
        i = i + 1
    end

    return debug_locals, debug_locals_size, debug_globals, debug_globals_size
end

local host, port = "127.0.0.1", 4712
local server = SocketWrapper.new("127.0.0.1", 4712)
local err = nil

print("Lua debugger listening on " .. host .. ":" .. port)
server:settimeout(0)  -- non-blocking

local breakpoints = {}  -- map[file][line] = true

-- execution state
g_paused = false
g_stepMode = nil   -- "in", "out", "next"

local function net_receive()
    -- Save the original timeout so we can restore it later
    local orig_timeout = client:gettimeout()
    
    if g_paused then
        client:settimeout(nil)  -- blocking
    else
        client:settimeout(0)    -- non-blocking
    end

    local hdr = ""
    while #hdr < 4 do
        local s, err, extra = client:receive(4 - #hdr)
        hdr = hdr .. (s or extra or "")
        if err and err ~= "timeout" then
            client:settimeout(orig_timeout)
            error(err)
        elseif not g_paused and err == "timeout" then
            client:settimeout(orig_timeout)
            return nil  -- return nil immediately if non-blocking and no data yet
        end
    end

    local b1,b2,b3,b4 = hdr:byte(1,4)
    local len = bit32.lshift(b1,24) + bit32.lshift(b2,16) + bit32.lshift(b3,8) + b4

    local data = ""
    while #data < len do
        local s, err, extra = client:receive(len - #data)
        data = data .. (s or extra or "")
        if err and err ~= "timeout" then
            client:settimeout(orig_timeout)
            error(err)
        elseif not g_paused and err == "timeout" then
            client:settimeout(orig_timeout)
            return nil  -- return nil immediately if non-blocking and data not complete
        end
    end

    -- Restore original timeout
    client:settimeout(orig_timeout)

    return NetBuffer:from_str(data)
end

local function test_debug_locals(a, b)
    -- Basic math
    local sum = a + b
    local diff = a - b
    local prod = a * b
    local div = b ~= 0 and a / b or nil
    local mod = b ~= 0 and a % b or nil
    local pow = a ^ 2

    -- More math
    local sqrt_a = math.sqrt(a)
    local sqrt_b = math.sqrt(b)
    local max_val = math.max(a, b)
    local min_val = math.min(a, b)

    -- Basic string manipulation
    local str_a = tostring(a)
    local str_b = tostring(b)
    local combined = str_a .. " + " .. str_b
    local upper_combined = string.upper(combined)
    local len_combined = #combined

    -- Boolean check
    local is_a_greater = a > b
    local is_equal = a == b

    -- Table example
    local results = {sum, diff, prod, div, mod, pow, sqrt_a, sqrt_b}

    -- Return something so function does not appear trivial
    return results, combined, upper_combined, len_combined, is_a_greater, is_equal
end

local function process_commands()
    local r = test_debug_locals(12, 5)

    if client then
        local buf = net_receive(paused)
        if buf then
            local packet_id = buf:read_byte()

            print("Processing packet id:", string_to_command_str[packet_id] or ("UNKNOWN(" .. tostring(packet_id) .. ")"))

            if packet_id == COMMANDS.BP_ADD then
                local file, bpLine = buf:read_string(), buf:read_int()
                breakpoints[file] = breakpoints[file] or {}
                breakpoints[file][bpLine] = true

                print("[BP] Adding ", file, bpLine)

            elseif packet_id == COMMANDS.BP_CLEAR_FILE then
                local file = buf:read_string()
                breakpoints[file] = {}

            elseif packet_id == COMMANDS.CONTINUE then
                g_paused = false
                g_stepMode = nil
            elseif packet_id == COMMANDS.STEP_IN then
                g_paused = false
                g_stepMode = "in"
            elseif packet_id == COMMANDS.STEP_NEXT then
                g_paused = false
                g_stepMode = "next"
            elseif packet_id == COMMANDS.STEP_OUT then
                g_paused = false
                g_stepMode = "out"
            end
        end
    end
end

local function debugger_stop_handler(file, line, func_name, info)
    local debug_locals, debug_locals_size, debug_globals, debug_globals_size = get_locals_and_globals(info)
    print("[BP] Stop at", file, line, debug_locals_size, debug_globals_size)

    local buf = NetBuffer:new()
    buf:write_byte(RESPONSES.STOP)
    buf:write_string(file)
    buf:write_int(line)
    buf:write_string(func_name)
    buf:write_int(debug_locals_size)
    for index, pair in ipairs(debug_locals) do
        buf:write_string(pair[1])
        buf:write_string(pair[2])
    end
    buf:write_int(debug_globals_size)
    for index, pair in pairs(debug_globals) do
        buf:write_string(pair[1])
        buf:write_string(pair[2])
    end
    buf:send(client)

    print("[BP] Entering paused loop")

    g_paused = true

    while g_paused do
        client:settimeout(0.05)

        print("[BP] g_paused:", g_paused, " g_stepMode:", g_stepMode)

        process_commands()
    end

    print("[BP] Resuming execution")

    client:settimeout(0)
end

local function hook(event, line)
    if not client then return end

    local info = debug.getinfo(2, "nSl")
    if not info then return end
    local file = info.source:gsub("^@", "")
    -- lower first char cause vscode do the same too.
    file = file:sub(1, 1):lower() .. file:sub(2)
    local func_name = info.name or "<anonymous>"

    -- Breakpoint handler
    if not g_paused then
        local found = false

        for bpFile, bpLines in pairs(breakpoints) do
            if bpFile == file and bpLines[line] then
                found = true
                break
            end
        end

        if found then
            g_stepMode = nil
            debugger_stop_handler(file, line, func_name, info)
            return
        end
    end

    -- Step handler
    if g_stepMode ~= nil and file ~= "=[C]" then
        if g_stepMode == "in" and event == "line" then
            g_stepMode = nil
            debugger_stop_handler(file, line, func_name, info)

        elseif g_stepMode == "next" and event == "line" then
            g_stepMode = nil
            debugger_stop_handler(file, line, func_name, info)

        elseif g_stepMode == "out" and event == "return" then
            g_stepMode = nil
            debugger_stop_handler(file, line, func_name, info)
        end
    end
end


debug.sethook(hook, "lr")  -- line, return

local debugger_iteration = function()
    if not client then
        client, err = server:accept()
        if client then
            print("Client connected")
            client:settimeout(0)  -- non-blocking
        end
    end

    process_commands()
end

-- Developer loop, comment this out on release
while true do
    debugger_iteration()
end

rom.gui.add_always_draw_imgui(debugger_iteration)