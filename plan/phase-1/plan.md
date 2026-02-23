# Phase 1a — Hotkey Input MVP (闭环：检测 → 播报 → 快捷键选择 → 回写)

> **Related overview sections**: [Section 5 (核心流程)](../overview.md#5-核心流程), [Section 6.2 (send-keys)](../overview.md#62-回写选择send-keys), [Section 7.2 (命令词表)](../overview.md#72-命令词表), [Section 9 (安全)](../overview.md#9-安全与误操作防护)

## Context

Phase 0 完成了 detect → TTS 的单向流程。Phase 1 原计划用 `hs.speech.listener` 做语音输入，但该 API 在 macOS Sonoma+ 上完全不可用。用户决定 A+B 分步：

- **Phase 1a (本次)**: Hotkey 输入 — 用键盘快捷键代替语音，闭环 MVP
- **Phase 1b (后续)**: Whisper.cpp 本地 ASR — 真正的语音输入

Phase 1a 的目标是**闭环**：prompt 检测 → TTS 播报 → 用户按快捷键 → 验证 pane → 回写 tmux。

## 设计

### 架构变化

Phase 0 的 `init.lua:tick()` 直接做 poll → parse → announce。Phase 1a 引入 **dispatcher** 管理状态机，把 tick 逻辑委托给它。

```
Phase 0:  tick() → capture → parse → announce (单向)
Phase 1a: tick() → dispatcher:tick() → 状态机驱动完整循环
```

### 新模块

| 模块 | 文件 | 职责 |
|------|------|------|
| Dispatcher | `dispatcher.lua` | 状态机：idle → announcing → waiting_input → confirming → writing → idle |
| Writer | `writer.lua` | `tmux send-keys` 封装 + pane 验证 + 指纹重验 |
| Input | `input.lua` | Hotkey 管理：创建/启用/禁用快捷键，回调 dispatcher |

### 不需要单独的 router.lua

Phase 1a 的 hotkey 输入已经是结构化的（Ctrl+1 = choice "1"），不需要额外的命令词解析。路由逻辑直接在 dispatcher 中处理。Phase 1b 引入 Whisper 后，自然语言需要 router.lua 做命令词解析。

### 状态机 (dispatcher)

```
idle ──→ announcing ──→ waiting_input ──→ writing ──→ idle
                            │    ↑            │
                            │    └── repeat ──┘
                            │
                            ├──→ confirming ──→ writing ──→ idle
                            │        ↑   │
                            │        └───┘ (cancel → idle)
                            │
                            └──→ timeout → replay (max 3次) → idle (expired)
```

状态说明：
- **idle**: 每次 tick 轮询所有 pane 找新 prompt
- **announcing**: TTS 正在播报，等待完成回调
- **waiting_input**: 快捷键已激活，等待用户按键（超时 `listen_timeout` 秒，默认 15s）
- **confirming**: 高风险操作二次确认中（TTS 播 "Confirm approve?"，等 Y/N）。超时同样为 `listen_timeout` 秒，超时后回到 idle（不重播确认）
- **writing**: 异步 send-keys 进行中

**超时与重播计数规则**（Codex Round 1 #4）：
- 首次播报不计入 `remind_count`
- `waiting_input` 超时后 `remind_count++`，若 < `max_remind_count`（默认 3）则重播，否则 expired
- `confirming` 超时后直接回到 idle（取消本次操作），不增加 `remind_count`——用户可能在犹豫，下次 idle 检测会重新捡起

### 已知限制 (Phase 1a)

**单事件串行处理**（Codex Round 1 #6）：在 `announcing` / `waiting_input` / `confirming` / `writing` 状态期间，不轮询新 prompt。其他 pane 的短生命周期提示可能被错过。这是 Phase 1a MVP 的已知 tradeoff——Phase 2 引入 Event Queue 后解决（持续后台轮询 + 入队）。

### 快捷键设计

使用 `hs.hotkey.new()` 创建，仅在 `waiting_input` / `confirming` 状态时 enable。

| 快捷键 | 动作 | 状态 |
|--------|------|------|
| Ctrl+1 ~ Ctrl+9 | 选择对应编号 | waiting_input |
| Ctrl+0 | 选择编号 10 | waiting_input |
| Ctrl+Y | Yes / Approve | waiting_input, confirming |
| Ctrl+N | No / Reject | waiting_input |
| Ctrl+R | 重播当前 prompt | waiting_input |
| Ctrl+X | 取消/跳过 | waiting_input, confirming |

快捷键 modifier 可通过 config 配置（默认 `{"ctrl"}`）。

**超范围选项处理**（Codex Round 1 #5）：当 parser 检测到 >10 个选项时，TTS 播报 "Too many options, please handle manually"，不进入 waiting_input 状态，事件标记 expired。

### 高风险确认流程

1. 检测到 yes/no 或 approve/reject prompt
2. TTS: "backend asks: approve or reject?"
3. 用户按 Ctrl+Y
4. TTS: "Confirm approve?"（进入 confirming 状态）
5. 用户再按 Ctrl+Y → 执行回写
6. 或按 Ctrl+X → 取消，回到 idle

数字选择如果选项文本包含 `confirm_keywords`（delete, remove, force...），同样触发确认。

### Writer 回写流程

```lua
function writer.send(target, pane_id, key, dedupe_key, callback)
    -- 1. 验证 pane 存在 + pane_id 匹配（sync）
    -- 2. 重新 capture-pane → parse → dedupe_key(parsed.raw_match) 比对指纹（sync）
    -- 3. send-keys（async via hs.task）
    -- 4. callback(ok, error_reason)
end
```

**指纹重验流程**（Codex Round 1 #1）：writer 必须执行完整的 `capture → parse → dedupe_key(parsed.raw_match)` 流程来重验指纹，确保和检测时口径一致。如果 `parse()` 返回 nil（prompt 已消失），直接判定 `done_stale`。

**pane_id 校验**（Codex Round 1 #2）：事件入队时额外记录 `pane_id`（通过 `tmux display-message -p -t <target> '#{pane_id}'`）。回写前同时校验 target 存在 + pane_id 匹配；不一致则 `done_stale`（pane 已被复用）。

失败处理：
- pane 不存在 → 通知用户 "pane closed"，事件 expired
- pane_id 不匹配 → 通知用户 "pane changed"，事件 done_stale
- 指纹不匹配 → 通知用户 "prompt changed"，事件 done_stale
- parse 返回 nil → 通知用户 "prompt gone"，事件 done_stale
- send-keys 失败 → 重试 1 次

### init.lua 变化

- 创建 dispatcher，把状态管理委托过去
- `tick()` 简化为 `dispatcher:tick()`
- start/stop/pause/resume 操作透传给 dispatcher
- 现有的 `seen{}` dedupe 逻辑移入 dispatcher

### pause/resume 在非 idle 状态的行为

（Codex Round 2 #1）

`pause()` 可能在任意状态被调用。规则：
- **disable 所有 hotkeys**（通过 `input:disableAll()`）
- **取消活跃超时 timer**
- **停止 TTS**（调用 `tts:stop()`，触发 `on_finish("stopped")`）
- **dispatcher 状态 → `paused`**（独立于状态机，保留当前事件信息）
- **不执行任何 writeback**——即使 `writing` 状态的异步 send-keys 已发出，callback 返回时检测到 paused 则丢弃结果

`resume()` 恢复时：
- 如果有保留的当前事件 → 重新进入 `announcing`（重新播报）
- 如果无当前事件 → 回到 `idle`

### Dedupe 保留规则

（Codex Round 2 #2）

所有终态结果（`expired`、`done_stale`、`done`、"too many options"）都保留该 pane 的最后 dedupe key 不变。只有当下一次 poll 的 `parser.dedupe_key()` 产生不同值时，才视为新 prompt 并重新触发。这和 Phase 0 的行为一致（`init.lua:46` 不清除 `seen[pane]`）。

### TTS 改动

`tts.lua:announce()` 当前没有完成回调。Dispatcher 需要知道 TTS 何时播完，以便切换到 waiting_input 状态。

**回调设计**（Codex Round 1 #3）：`on_finish` callback 接受 reason 参数（`"completed"` / `"stopped"` / `"failed"`）。`stop()` 方法必须清理 `_on_finish` 且不触发 "completed" 回调路径。

```lua
function M:announce(alias, prompt, on_finish)
    ...
    self._on_finish = on_finish
end

function M:_finish()
    local cb = self._on_finish
    self._on_finish = nil
    -- ... existing cleanup ...
    self._speaking = false
    if cb then cb("completed") end
end

function M:stop()
    local cb = self._on_finish
    self._on_finish = nil   -- clear BEFORE calling to prevent re-entry
    -- ... existing stop cleanup ...
    self._speaking = false
    if cb then cb("stopped") end
end
```

失败路径（say task 返回非零 exitCode、sound 加载失败等）同样调用 `cb("failed")`。

### 视觉反馈

- 检测到 prompt 时：`hs.alert.show()` 短暂显示可用快捷键
- waiting_input 状态：可选 menubar indicator（Phase 1a 不做，仅 alert）

## Config 新增项

```lua
-- Phase 1a additions
hotkey_modifier = {"ctrl"},      -- hotkey modifier keys
listen_timeout = 15,             -- seconds to wait for input after TTS
max_remind_count = 3,            -- max replays before expiring (first announce doesn't count)
confirm_high_risk = true,        -- require confirmation for yes/no, approve/reject
confirm_keywords = {"delete", "remove", "force", "reset", "drop", "destroy"},
max_choices = 10,                -- max number of hotkey-selectable choices (beyond this → manual)
```

## 依赖注入与测试策略

（Codex Round 1 #7）

### Mock 策略

dispatcher / writer / input 都依赖 Hammerspoon API（`hs.timer`、`hs.hotkey`、`hs.task`、`hs.execute`、`hs.alert`）。为了支持纯 Lua 单元测试（不依赖 Hammerspoon 运行时），采用**构造函数注入**：

```lua
-- dispatcher.lua
function M.new(deps)
    -- deps.monitor, deps.parser, deps.tts, deps.writer, deps.input, deps.logger, deps.clock
    -- clock 提供 now() 和 delayed_call(seconds, fn) 替代 hs.timer
end

-- writer.lua
function M.new(deps)
    -- deps.monitor (for capture + pane_exists), deps.parser (for fingerprint re-verify)
    -- deps.tmux_send(args, callback) 替代 hs.task.new
end

-- input.lua
function M.new(deps)
    -- deps.hotkey_new(mods, key, fn) 替代 hs.hotkey.new
    -- deps.alert_show(text) 替代 hs.alert.show
end
```

测试中提供 mock 实现；生产环境在 `init.lua` 中注入真实 Hammerspoon API。

### 测试运行

- 单元测试：`lua test/test_dispatcher.lua`、`lua test/test_writer.lua`（纯 Lua 5.4，和 test_parser.lua 同一 harness）
- E2E 测试：通过 dispatcher 的公开 API（`dispatcher:handle_input("1")`）模拟用户按键，避免需要真实 hotkey 触发

## Tasks

0. **更新 `plan/phase-1/progress.md`** — 同步 Phase 1a 任务列表（Codex Round 1 #8）。**前置条件**：不得开始编码直到 progress.md 与本计划的任务列表完全一致（Codex Round 2 #3）
1. **创建 `writer.lua`** — send-keys + pane 验证（target + pane_id）+ 指纹重验（capture → parse → dedupe_key）
2. **创建 `input.lua`** — Hotkey 管理（new/enable/disable），支持 Ctrl+1~9, 0, Y/N/R/X
3. **创建 `dispatcher.lua`** — 状态机 + tick 逻辑 + 超时（waiting_input + confirming）+ 高风险确认 + 超范围选项处理
4. **重构 `init.lua`** — 委托给 dispatcher，保持 start/stop/pause/resume 接口，注入真实 hs 依赖
5. **更新 `config.lua`** — 新增 Phase 1a 配置项（hotkey modifier, listen_timeout, confirm_high_risk, max_choices 等）
6. **修改 `tts.lua`** — 增加 on_finish callback（带 reason 参数），`stop()` 清理回调
7. **单元测试** — writer 的 pane + pane_id 验证、指纹重验逻辑；dispatcher 状态转换 + 超时；input 命令映射。使用 DI + mock。
8. **E2E 测试** — echo prompt → 检测 → TTS → dispatcher API 驱动输入 → 验证 pane 收到输入
9. **更新 plan docs** — 更新 progress.md 最终状态

## 关键文件

| 文件 | 操作 |
|------|------|
| `writer.lua` | 新建 |
| `input.lua` | 新建 |
| `dispatcher.lua` | 新建 |
| `init.lua` | 重构 — 委托给 dispatcher |
| `config.lua` | 编辑 — 新增配置项 |
| `tts.lua` | 编辑 — 增加 on_finish callback（带 reason） |
| `monitor.lua` | 不变 |
| `parser.lua` | 不变 |
| `logger.lua` | 不变 |
| `test/test_dispatcher.lua` | 新建 |
| `test/test_writer.lua` | 新建 |

## 验收标准

- 用户按 Ctrl+1 后 < 1 秒，对应 pane 收到 `1\n`
- yes/no 和 approve/reject 触发二次确认（再按 Ctrl+Y 才执行）
- `waiting_input` 超时 15s 后自动重播 TTS；`confirming` 超时后回到 idle
- 首次播报不计入 remind_count；重播 3 次后事件过期，TTS 通知用户
- 回写前 pane 校验（target + pane_id）+ 指纹重验（capture → parse → dedupe_key）正常工作
- >10 选项时播报 "please handle manually"，不进入 waiting_input
- TTS `stop()` 不触发 "completed" 回调
- `pause()` 在 `waiting_input` 时：hotkeys disabled、timer cancelled、TTS stopped，无 writeback 副作用
- `resume()` 后当前事件重新播报
- 终态后 dedupe key 保留，同一 prompt 不重复播报
- 单元测试通过（纯 Lua，无 hs 依赖）

## Verification

1. 启动 voiceLoop，在测试 pane echo 模拟 prompt
2. 确认 TTS 播报 + hs.alert 显示快捷键提示
3. 按 Ctrl+1，验证 pane 收到 `1\n`
4. Echo yes/no prompt，按 Ctrl+Y，验证触发二次确认
5. 确认后验证 pane 收到 `y\n`
6. 不按任何键，验证 15s 后 TTS 重播
7. 关闭测试 pane 后触发 prompt，验证 pane 验证失败处理
8. Echo 12 选项 prompt，验证 TTS 播报 "too many options" 且不激活 hotkeys
