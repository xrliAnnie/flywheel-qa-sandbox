# Exploration: Lead daemon MCP scope — FLY-143

**Issue**: FLY-143 (Lead daemon MCP scope)
**Date**: 2026-05-06
**Status**: Draft v4 (post Codex r3 — env-gate parser correctness + chrome rollout gate + atomic write + Runner scope clarity)
**Linear**: https://linear.app/geoforge3d/issue/FLY-143

## Annie 反馈（v2 → v3 触发）

> "bambu-h2d / xiaohongshu-mcp / claude-in-chrome 这些 MCP Lead 和 Runner 都是需要的"

v2 only-`["linear-api"]` 太窄。Annie 的 trust model：Lead/Runner 是她 alter ego in Claude Code session，已有 git push / shell / Discord post。**只有真正私人 OAuth account 和 listening history 才需要排除**。

**注意（Codex r3 修正）**：alter-ego 不等于零风险 — MCP 是更结构化、更低摩擦的外部系统操作面（Bambu 实际控印机、xhs 真发布、Chrome 真实会话）。所以决策仍是 trust + explicit boundaries，不是无脑 inherit all。

## TL;DR (v4)

- **症状**：Lead daemon 没法 read Linear，Annie 让 Peter verify FLY-142 失败
- **根因（确认）**：`~/.flywheel/.env` 缺 `LINEAR_API_KEY` → linear-api MCP server `Bearer ${LINEAR_API_KEY}` 字段无法 expand → Claude Code 把它 mark 为 server-level 配置错误（**注意 Codex r3 修正**：source 显示 `parseMcpConfig` 把缺 env 记为 warning 但仍 return 其他 server，**并不一定** cascade 整张 config 掉。需 `/mcp` ground truth 验证）
- **根因（核心）**：`claude-lead.sh:760-851` 硬编码 only 3 个 server，未 inherit user-scope MCP — Annie's `linear-api` / `bambu-h2d` / `xhs` / `pencil` 没出现在 Lead `.mcp.json`
- **方案 (v4)**：
  - **Hybrid B+C**：default 透传 `~/.claude.json.mcpServers` 顶层 + class-based blacklist (`audible`, future personal media/account) + **per-server env gate（JSON-aware）**
  - **`--chrome` flag** for claude-in-chrome — **gated by `FLYWHEEL_LEAD_CHROME_ENABLED=true` env，default OFF**（codex r3 hard requirement: `--chrome + bypassPermissions = skip_all_permission_checks` 的 security 边界）
  - **Atomic write** `.mcp.json` (mktemp + chmod 600 + mv)
  - **Same-name collision warning** before merge
  - **Runner scope**：Annie 决定（详见 §7）— 同 PR 还是 follow-up

## 1. 现 builder（line by line）

不变 — 见 `claude-lead.sh:760-851`。3 个硬编码 server (terminal-mcp / inbox-mcp / gbrain) + jq merge 到 `<workspace>/.mcp.json`。问题：
- 未 inherit user-scope MCP
- `.mcp.json` mode 0644 + 含 `TEAMLEAD_API_TOKEN` 明文（顺手 fix）

## 2. Annie's MCP 全 inventory（重新 categorize for v4）

### 2.1 `~/.claude.json.mcpServers`（user-scope，**FLY-143 v4 default 全 inherit**）

| Server | Type | Cmd / URL | Required env | Annie 想 Lead 有? | v4 default | 备注 |
|--------|------|----------|--------------|-------------------|------------|------|
| `linear-api` | http | mcp.linear.app | `LINEAR_API_KEY` | ✅ 是（核心诉求） | ✅ inherit (env gate) | 缺 env → skip 该 server，不影响其他 |
| `pencil` | stdio | Pencil.app | 无 | ✅ 是 | ✅ inherit | 设计任务（Peter UX work） |
| `bambu-h2d` | stdio | bambu-mcp | MQTT pwd 在 cfg 字面 | ✅ 是 | ✅ inherit | Annie 接受 risk；Oliver ops 控印机 |
| `xiaohongshu-mcp` | http | localhost:18060 | 无 | ✅ 是 | ✅ inherit | 内容发布；本地端口 |
| `audible` | stdio | audible-mcp | Annie 个人订阅 | ❓ **需 Annie 明确** | ⚠️ default skip | listening history 私人 — class-based deny |

### 2.2 `~/.claude.json.projects[*].mcpServers`（local-scope，**v4 仍不读**）

| Path | Server | Why skip |
|------|--------|----------|
| `/Users/xiaorongli/Dev` | `chrome-devtools` | 用 `claude-in-chrome` 替代 |
| `/Users/xiaorongli` | `slack` | **`SLACK_BOT_TOKEN` 内嵌** — Annie 个人 Slack |
| `/Users/xiaorongli/Dev/flywheel` | `loop-bridge-1` | Loop CLI runtime — Lead 不通过 Loop 通讯 |

### 2.3 Plugin-bundled MCP（自动 load via 已 install 的 plugin）

实测 `~/.claude/plugins/cache/`：

| Plugin | MCP server | 当前 Lead 有? | v4 应该 |
|--------|-----------|--------------|---------|
| `claude-plugins-official/discord` | `discord` | ✅（via `--channels`） | 保持 |
| `claude-plugins-official/figma` | `figma` | ❓（待 `/mcp` 验证） | Annie 决定 |
| `claude-plugins-official/playwright` | `playwright` | ❓ | Annie 决定 |
| `claude-plugins-official/serena` | `serena` | ❓ | Annie 决定 |
| `claude-plugins-official/context7` | `context7` | ❓ | Annie 决定 |

**Codex r3 修正**：v3 假设 LINEAR_API_KEY 缺失 cascade 掉 plugin MCP — 不准确。`config.ts:1330-1375` 显示 `parseMcpConfig` 把缺 env 记为 warning 但仍 return 其他 server。Plugin MCP 与 user MCP 走独立 load path (`config.ts:1114-1238`)，不会 cascade。**v4 不再把 cascade 当确认根因，需 `/mcp` 实测验证**。

### 2.4 真私人（Class-based deny）

| Class | Examples | 永不 inherit |
|-------|----------|--------------|
| Personal OAuth/connectors | `claude_ai_Gmail`, `claude_ai_Calendar`, `claude_ai_Drive`, `claude_ai_HuggingFace` | ✅ 不在 user-scope mcpServers，自然 access 不到 |
| Listening/media history | `audible` | ✅ blacklist |
| Personal messaging/email/calendar/drive | (future) | ✅ class-based deny |
| Desktop-control unless approved | (future) | ✅ class-based deny |

> v4 blacklist 写成"current explicit + class deny by future addition"，不是"v1 只有 audible 所以未来记得加"。

## 3. v4 设计：Hybrid + Codex r3 修正

### 3.1 Builder pseudocode (v4)

```bash
# FLY-143 v4: Inherit user-scope MCP servers (default + blacklist + JSON-aware env gate + atomic write + collision warn)
LEAD_USER_MCP_BLACKLIST=("audible")     # class-based: personal media/listening history
RESERVED_NAMES=("flywheel-terminal" "flywheel-inbox" "gbrain")
USER_CLAUDE_JSON="${HOME}/.claude.json"
USER_MCP='{}'

# Helper: scan a server cfg for ${VAR} or ${VAR:-default}; return missing var name (or empty)
# Walks JSON string values recursively (Claude-compatible: scans command, args, url, env, headers).
# Skips literals like "$$VAR" (escaped).
_check_required_env() {
  local cfg_json="$1"
  # jq filter: extract all string leaves, then scan for ${VAR} or ${VAR:-default}
  echo "$cfg_json" | jq -r '
    [.. | strings] | .[]
    | scan("(?<!\\$)\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\\}")
    | select(.[1] == null) | .[0]
  ' 2>/dev/null | sort -u | while read var; do
    [ -z "$var" ] && continue
    if [ -z "${!var:-}" ]; then
      echo "$var"
      return
    fi
  done
}

# Step 1. Read user-scope mcpServers (top-level only — never .projects[...])
if [ -f "$USER_CLAUDE_JSON" ] \
   && jq -e '.mcpServers? | objects' "$USER_CLAUDE_JSON" >/dev/null 2>&1; then

  user_servers=$(jq -r '.mcpServers | keys[]' "$USER_CLAUDE_JSON" 2>/dev/null || true)

  for srv in $user_servers; do
    # 1a. Blacklist gate (class-based deny)
    skip=false
    for blocked in "${LEAD_USER_MCP_BLACKLIST[@]}"; do
      [ "$srv" = "$blocked" ] && skip=true && break
    done
    [ "$skip" = "true" ] && log "User MCP skipped (blacklist): $srv" && continue

    # 1b. Per-Lead exclude (env-driven) — Codex r3 suggestion
    if [ -n "${FLYWHEEL_LEAD_MCP_EXCLUDE:-}" ]; then
      IFS=',' read -ra exclude_arr <<< "$FLYWHEEL_LEAD_MCP_EXCLUDE"
      for ex in "${exclude_arr[@]}"; do
        [ "$srv" = "$ex" ] && skip=true && break
      done
      [ "$skip" = "true" ] && log "User MCP skipped (per-Lead exclude): $srv" && continue
    fi

    # 1c. Same-name collision warning (Flywheel infra wins, but flag it)
    for reserved in "${RESERVED_NAMES[@]}"; do
      if [ "$srv" = "$reserved" ]; then
        log "WARNING: User MCP '$srv' shadowed by Flywheel infra MCP — user config ignored"
        skip=true; break
      fi
    done
    [ "$skip" = "true" ] && continue

    cfg=$(jq -c --arg name "$srv" '.mcpServers[$name]' "$USER_CLAUDE_JSON" 2>/dev/null || echo "")
    [ -z "$cfg" ] || [ "$cfg" = "null" ] && continue

    # 1d. JSON-aware env gate (Claude-compatible: ${VAR} required, ${VAR:-default} OK)
    missing=$(_check_required_env "$cfg")
    if [ -n "$missing" ]; then
      log "WARNING: User MCP '$srv' requires env $missing (unset) — skip"
      continue
    fi

    USER_MCP=$(echo "$USER_MCP" | jq --arg name "$srv" --argjson cfg "$cfg" '. + {($name): $cfg}')
    log "User MCP inherited: $srv"
  done
else
  log "User MCP inheritance: skip (~/.claude.json missing or malformed)"
fi

# Step 2. Atomic write (mktemp + chmod 600 + mv) — Codex r3 must-fix
MCP_CONFIG_FILE="${LEAD_WORKSPACE}/.mcp.json"
_tmp="$(mktemp "${MCP_CONFIG_FILE}.tmp.XXXXXX")"
trap '[ -f "$_tmp" ] && rm -f "$_tmp"' EXIT
(
  umask 077
  jq -n --argjson user "$USER_MCP" --argjson terminal "$terminal_server" \
        --argjson inbox "$inbox_server" --argjson gbrain "$gbrain_server" \
        '{mcpServers: ($user + $terminal + $inbox + $gbrain)}' \
        > "$_tmp"
)
chmod 600 "$_tmp" 2>/dev/null || true
mv -f "$_tmp" "$MCP_CONFIG_FILE"
trap - EXIT
log "MCP config: ${MCP_CONFIG_FILE} (mode 0600, atomic)"
```

### 3.2 关键设计点 (v4 — incorporate codex r3)

1. **Default inherit** + **class-based blacklist** (current `audible`, doc cardinal "personal media/account default deny")
2. **Per-Lead exclude env** `FLYWHEEL_LEAD_MCP_EXCLUDE=bambu-h2d,xiaohongshu-mcp` — manifest 设置即可让 Simba (cos-lead) 不要 bambu/xhs (operationally never needs)
3. **JSON-aware env gate** — `jq` 走 string leaves，按 Claude expander 语义匹配 `${VAR}` 与 `${VAR:-default}`，未 set 且无 default 才 skip
4. **Atomic write** — mktemp 同目录 + chmod 600 + mv，避免 partial-read 与 inode mode 残留
5. **Same-name collision warning** — Annie 万一也叫 `gbrain`, `flywheel-inbox`, `flywheel-terminal`，**显式 log warning + skip user 版本**（infra 永远赢），不 silent
6. **永远不读 `.projects[...]`** — slack 等 local-scope 安全
7. **OAuth 连接器 access 不到** — `claude_ai_*` 不在 user-scope mcpServers，default 安全
8. **Launcher 不 abort** — 任何 jq 失败 / file 缺失 / blacklist hit 都 warn-and-continue
9. **不修复"plugin cascade"框架** — 改成"未验证假设，需 `/mcp` 实测"，不 oversell

### 3.3 `--chrome` flag — gated rollout (Codex r3 hard requirement)

```bash
# In claude-lead.sh CLAUDE_ARGS section (~line 929):
if [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-false}" = "true" ]; then
  CLAUDE_ARGS+=(--chrome)
  log "Claude in Chrome: ENABLED (--chrome flag set; bypassPermissions + chrome = skip_all_permission_checks)"
  log "WARNING: Lead has access to Annie's logged-in Chrome session and may operate in active tabs"
fi
```

**Default OFF** in production。开启需 manifest 加 `"chromeEnabled": true` 或 wrapper export `FLYWHEEL_LEAD_CHROME_ENABLED=true`。

**Security 边界（待 Annie 接受）**：
- `--chrome + bypassPermissions = CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks`（Codex r3 verified from `setup.ts:101-104`）
- 这意味着 Lead 操作 Chrome 时跳过所有 per-site 权限提示
- 等价于"Lead 是 Annie 完全无人值守的 alter ego，包括 logged-in browser session"
- 这不是 docs warning 能消除的真实 risk — Annie 必须明确接受

**建议 rollout**:
1. v4 主 PR 加 flag + default OFF
2. Annie 在 1 个 test slot manifest 开 `chromeEnabled: true`，实测看是否符合预期
3. 满意后 per-Lead 开（Peter 可能用 figma 驱动 — 需要；Simba 不需要）
4. ❌ 永不 default-on for production

### 3.4 Per-Lead exclude（v4 加进 main builder）

| Lead | 建议 exclude |
|------|-------------|
| Simba (cos-lead) | `bambu-h2d,xiaohongshu-mcp,pencil` (triage only) |
| Oliver (ops-lead) | `pencil,figma` (operations focus) |
| Peter (product-lead) | `bambu-h2d` (设计 product，不控印机) |
| flywheel-test-N | (default 全 inherit — test 框架需要) |

通过 manifest field `mcpExclude: "bambu-h2d,xiaohongshu-mcp"` → wrapper export `FLYWHEEL_LEAD_MCP_EXCLUDE` → builder 读取。

> v4 主 PR 加 builder logic + 1 个示范 manifest。Annie 实际的 per-Lead exclude list 后续可以单独 PR 调，不 block 主 PR。

## 4. 完整 inheritance matrix（**v4 — 给 Annie 逐个 confirm**）

| MCP server | 来源 | v4 default | Annie confirm? | Risk |
|-----------|------|-----------|----------------|------|
| `linear-api` | user-scope | ✅ inherit (env gate) | ✅ confirmed | Bearer 需 `LINEAR_API_KEY` |
| `pencil` | user-scope | ✅ inherit | ⏸️ default yes，待 confirm | 低 |
| `bambu-h2d` | user-scope | ✅ inherit | ✅ confirmed | MQTT pwd；Lead 控印机 |
| `xiaohongshu-mcp` | user-scope | ✅ inherit | ✅ confirmed | 内容发布；本地端口 |
| `audible` | user-scope | ❌ blacklist | ⏸️ default skip，待 confirm | 私人订阅 |
| `claude-in-chrome` | CLI flag | ❌ default OFF (env-gated) | ⏸️ default off，待 Annie 决定 per-Lead | 完全 access Annie's Chrome session + skip permission checks |
| `discord` (plugin) | plugin | ✅ 已有 (`--channels`) | n/a | comm bus |
| `figma` (plugin) | plugin | ?? | ⏸️ 待 `/mcp` 实测 | 设计 |
| `playwright` (plugin) | plugin | ?? | ⏸️ 待 `/mcp` 实测 | 浏览器自动化 |
| `serena` (plugin) | plugin | ?? | ⏸️ 待 `/mcp` 实测 | code intel |
| `context7` (plugin) | plugin | ?? | ⏸️ 待 `/mcp` 实测 | doc lookup |
| `slack` (Annie local) | local-scope | ❌ 不 inherit | n/a | 不读 .projects[] |
| `chrome-devtools` (Annie local) | local-scope | ❌ 不 inherit | n/a | 用 claude-in-chrome 替代 |
| `loop-bridge-1` (Annie local) | local-scope | ❌ 不 inherit | n/a | Loop CLI runtime |
| `claude_ai_Gmail` | OAuth connector | ❌ 不可 inherit | n/a | Annie 私邮箱 |
| `claude_ai_Google_Calendar` | OAuth connector | ❌ 不可 inherit | n/a | Annie 私日历 |
| `claude_ai_Google_Drive` | OAuth connector | ❌ 不可 inherit | n/a | Annie 私 Drive |
| `claude_ai_Hugging_Face` | OAuth connector | ❌ 不可 inherit | n/a | Annie 私 HF |

## 5. Risk re-assessment (v4)

| 风险 | 严重度 | v4 缓解 |
|------|-------|--------|
| Annie 私人 token 泄露 | 🟡 中 | Class-based blacklist + 不读 `.projects[]` |
| 私人 OAuth 数据 (Gmail/Drive) | 🟢 低 | OAuth connector 非交互拿不到 token |
| 缺 env 污染整张 config | 🟢 低 | JSON-aware per-server env gate（Claude-compatible 语义）|
| 同名 server 撞 infra | 🟢 低 | Explicit warning + infra 永远赢 |
| `~/.claude.json` malformed | 🟢 低 | jq guard，warn-and-continue |
| `.mcp.json` 0644 暴露 token | 🟢 低 | Atomic write (mktemp + chmod 600 + mv) |
| bambu MQTT pwd 泄露 | 🟡 中 | Annie 接受；后续可改 token rotation |
| `--chrome` 影响 Annie 浏览 | 🔴 **高（Codex r3 强调）** | **Default OFF + env/manifest gate**；开启等于"Lead 完全无人值守 alter ego including chrome session" |
| 本地端口 server (xhs) 离线 | 🟡 低 | 单 server load 失败不影响其他；E2E 测试 cover |
| Per-Lead 误用 MCP | 🟡 低 | `FLYWHEEL_LEAD_MCP_EXCLUDE` 提供 manifest exclude |

## 6. 6 个 Lead 共享 — Per-Lead 区分（v4 加进设计）

v3 KISS-defer，**v4 改为 same-PR**（codex r3 推荐）：加 `FLYWHEEL_LEAD_MCP_EXCLUDE` env，wrapper 从 manifest 读 `mcpExclude` 字段（可空）export 给 launcher。

manifest schema 扩展：

```json
{
  "leadId": "cos-lead",
  "projectDir": "...",
  "projectName": "geoforge3d",
  "subdir": "cos",
  "workspace": "...",
  "botTokenEnv": "SIMBA_BOT_TOKEN",
  "mcpExclude": "bambu-h2d,xiaohongshu-mcp,pencil",   // NEW (optional)
  "chromeEnabled": false,                              // NEW (optional, default false)
  "pid": 17798
}
```

## 7. Runner scope (Codex r3 must-fix)

Annie 明确"Lead **和** Runner 都需要"。v3 vague defer 不行。v4 三选一：

### Option α — Same PR (Lead + Runner)
- Pro: 一次 ship，capability 不分裂
- Con: PR 大、风险高，Runner 走的是 `Runner.ts` (TypeScript)，不是 shell；需要 TS 等价实现
- ETA: +2-3h

### Option β — Lead-only with FLY-143b filed before merge
- Pro: 主 PR 小、风险可控
- Con: Annie 需明确接受 Lead-only interim + FLY-143b deadline
- ETA: 主 PR 不变；FLY-143b 单独 1-2 天

### Option γ — 抽 shared helper (jq script + TS wrapper)
- Pro: Lead/Runner 复用同一份 inheritance logic
- Con: ETA +3-4h（TS wrapper 需要 type + tests）

**v4 建议 Option β** — Lead-only main PR，FLY-143b 同时 file（先 audit Runner 的 MCP 启动路径，决定是否需要 Lead 同样的 builder）。**Annie 需明确 OK 这个**。

## 8. Codex review log

| Round | 结果 | 关键修正 |
|-------|------|---------|
| r1 (v1 only `linear-api`) | CHANGES_REQUIRED | 5 must-fix（env gate / jq guard / chmod / 措辞 / Bearer 框架） |
| r2 (v2 含 r1 修正) | APPROVED | 2 个 nits 已 fix |
| r3 (v3 default-inherit) | CHANGES_REQUIRED | 6 must-fix（env-gate parser / cascade theory / chrome rollout gate / Runner scope / atomic write / collision warning） |
| **r4 (v4 含 r3 修正)** | **APPROVED** | 4 个 implementation nits 加进 §10 test plan |

### r4 implementation nits（已并入实施 plan）

1. `FLYWHEEL_LEAD_MCP_EXCLUDE` 分隔符 trim 空格（"bambu-h2d, xhs" 也能工作）
2. Test cases 显式 cover：`$${VAR}` 字面 escape、`$VAR` (no braces) 不匹配、单 string 多个 `${...}`、JSON string 含换行
3. `_check_required_env` 避免 pipeline subshell early-return 语义陷阱 — 用 `while ... done < <(...)` 或 jq → array 循环
4. Doc 明确 env expansion 是 one-pass（`FOO='${BAR}'` + cfg `${FOO}` → builder 不递归 require `BAR`）

## 9. 待 Annie 拍板（Codex r3 提的 + v4 新增）

| Q# | 问题 | 默认建议 |
|----|------|---------|
| Q1 | `audible` blacklist 对吗？ | Default skip（私人；Lead 不需要） |
| Q2 | `pencil` inherit 对吗？还是 only Peter？ | v1 全 inherit + per-Lead exclude config，Simba/Oliver 默认 exclude |
| Q3 | Plugin MCP (figma/playwright/serena/context7) 是否已自动 load？ | `/mcp` 实测后告知 |
| Q4 | **Runner scope**：α/β/γ 选哪个？（同 PR / Lead-only + FLY-143b / shared helper） | **β** — Lead-only main PR，FLY-143b 立即 file |
| Q5 | **`--chrome` rollout**：default OFF + 1 test slot 开起来试，还是直接 Peter 开？ | **default OFF + test slot 先**；Annie 满意后 Peter 开 |
| Q6 | bambu/xhs 是 all-Lead 还是只 Oliver/Peter？ | v1 全 Lead + per-Lead exclude；Simba 默认 exclude bambu/xhs |
| Q7 | Linear PAT — 用 Annie 通用还是 Lead-dedicated read-only？ | Lead-dedicated read-only PAT (least privilege) |
| Q8 | LINEAR_API_KEY 放 `.env` (chmod 600) 还是 1Password keychain？ | v1 `.env`，后续 secrets 多了上 1Password CLI |

## 10. 实施 plan (v4 — Annie OK 后)

| Phase | 内容 | 改动文件 |
|-------|------|---------|
| 1 | Patch `claude-lead.sh` MCP builder + `--chrome` env-gated flag + atomic write | `packages/teamlead/scripts/claude-lead.sh` |
| 2 | 抽 builder 成 `packages/teamlead/scripts/lib/mcp-inherit.sh` (testable) | new |
| 3 | Update `flywheel-lead-wrapper.sh` 读 manifest `mcpExclude` + `chromeEnabled` | `~/.flywheel/bin/flywheel-lead-wrapper.sh` |
| 4 | 写 unit test (`mcp-inherit.test.sh`)：env present/missing, malformed json, blacklist, per-lead exclude, collision warn, ${VAR:-default} | `packages/teamlead/test/` |
| 5 | Annie 手动加 `LINEAR_API_KEY` 到 `~/.flywheel/.env` + `chmod 600 ~/.flywheel/.env` | manual |
| 6 | Codex r4 design review → r5 code review (PR) | — |
| 7 | Roll-out: test-slot-1 → cos-lead → product-lead → ops-lead | manual restart |
| 8 | File **FLY-143b**: Runner inheritance (after Annie OK β) | new Linear issue |

### Test scenarios (Codex r3 raised)

- ✅ All env present + valid `~/.claude.json` → 4-5 server inherit
- ✅ LINEAR_API_KEY unset → 4 server (no linear-api)，其他 OK，launcher 不 abort
- ✅ `~/.claude.json` malformed → 3 infra server only，launcher 不 abort
- ✅ `~/.claude.json` missing → 3 infra server only，launcher 不 abort
- ✅ Blacklist (`audible`) hit → log skip
- ✅ Per-Lead exclude (`bambu-h2d,xhs`) → log skip 2 个
- ✅ Same-name collision (Annie 加 `gbrain` user-scope) → log warning + infra 赢
- ✅ `${VAR:-default}` → 不 skip
- ✅ `xiaohongshu-mcp` localhost down → server load 失败但 `.mcp.json` 仍含它，Lead `/mcp` 显示 failed
- ✅ `--chrome` env unset → no `--chrome` flag
- ✅ `--chrome` env set → flag added + warning logged
- ✅ Output file mode == 0600 + content valid JSON

## 11. 不做的事 (scope discipline)

- ❌ 不 patch Claude Code 本体
- ❌ 不动 `~/.flywheel/runtime/` 任何运行时文件
- ❌ 不引入 `--mcp-config` flag（auto-discover 工作良好）
- ❌ 不 patch Lead rules（`common-rules.md`）— 等观察是否需要
- ❌ 不直接 restart production Lead — 等 Annie 决定 ship
- ❌ **v4 主 PR 不改 Runner**（β 选项 — FLY-143b follow-up）unless Annie 选 α
- ❌ 不 default-on `--chrome`（Codex r3 hard line）
