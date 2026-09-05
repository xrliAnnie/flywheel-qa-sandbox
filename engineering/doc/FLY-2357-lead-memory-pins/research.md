# FLY-2357 常驻 Lead 记忆开关 — 调研
Issue: FLY-2357 (https://linear.app/geoforge3d/issue/FLY-2357/2355a-配置半三个常驻-lead-家开-codex-记忆features-memoriestrue-memories-dedicated)
日期: 2026-09-05
基于: exploration.md

## 权威需求

上游 `flywheel-FLY-2119:engineering/doc/FLY-2119-codex-identity-memory/prd.md` 的本单相关结论是：

- §4.2：总开关 `memories = true` 属于 `[features]`；写进 `[memories]` 不报错但无效。
- §4.3 / §5.6：`dedicated_tools = true` 属于 `[memories]`，用于开启主动 list/read/search/add note 工具。
- §5.1：三个常驻 Lead 全开，包含 Mufasa；配置由 launcher 管理，必须先非生产验证、备份、逐 Lead 推进、失败回滚。
- §5.6.3：`max_rollouts_per_startup`、`min_rollout_idle_hours`、`max_rollout_age_days`、`min_rate_limit_remaining_percent` 先量再调，本单一律不动。
- `disable_on_external_context` 保持原值；打开它会让使用外部上下文的会话不生成记忆。
- §10 与本单边界：不改公共 `~/.codex`，不处理任务级 home、清理或 IC 回流。

本 issue 进一步锁定：不直接手改三个生产 `config.toml` 当交付；改动必须落到 `packages/teamlead/scripts/codex-lead-tui-home.sh` 的模板/写入逻辑，且本单不自行重启任何 Lead。

design review R1 对照仓内 owner 后发现上游把 FLY-1911 voice-avatar 的 `~/.codex-honeylemon` 误写成常驻 Codex Lead home。Lead 于 2026-09-05 裁定目标集按真实 launcher owner 修正为 Raya、Infra Bot、Mufasa；Epic FLY-2355 的 issue 更正评论由 Lead 写。本单必须同时证明 `~/.codex-honeylemon` 与公共 `~/.codex` 零字节改动。

## 启动链路

### Shell 组装器

`packages/teamlead/scripts/codex-lead-tui-home.sh`：

- `CONFIG="$HOME_DIR/config.toml"` 是唯一目标文件。
- `ensure_home` 先验证 auth 与 standalone，然后按 profile 进入两条路径。
- full-access 调 `write_full_access_config` 原子重写配置，再调 `append_full_access_lead_actions_mcp`，最后加 notice pin；当前 renderer 只从旧配置保留 trusted projects。因此若只对临时输出补两个 pin，后续 FLY-2355·D 设置的节流值会被下一次 ensure 丢弃。
- companion/read-only 对已有配置用 `tomllib` 验证根级 sandbox/approval pin，缺配置时写最小模板，再追加 trusted project 与 notice。
- 现有 notice pin 已采用可复用的 fail-closed 模式：缺表时追加；已有正确值时不动；已有表缺键、错误类型或显式漂移时给出带文件路径的人工修复提示。

### Runtime 二道门

`packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts` 在启动 full-access daemon 前读取 `config.toml`，调用：

- `assertFullAccessLeadActionsConfigGate`：要求 `[mcp_servers]` 只含精确的 `lead_actions` server，并逐字段匹配。
- `assertFullAccessSandboxConfig`：要求根级 `workspace-write`/`never`、network on、且 writable roots 精确等于已验证项目根。

`mcp-config.ts` 的实现只对 `[mcp_servers]` 子树与指定根级 sandbox 字段做精确约束，并不禁止其他顶层表。因此 `[features]` / `[memories]` 可以共存；最终仍需由既有 shell→runtime 交叉测试实证。

## 真实 owner 与现网只读结构

仓内三条生产启动器分别硬绑定以下 home key，且全部设置 `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`：

| Lead | Launcher | Home | 当前结构 |
|---|---|---|---|
| Raya | `run-codex-lead-raya-tui-fullaccess.sh` | `~/.codex-raya` | home 尚未落盘；launcher、recovery mapping 与 home-rule test 均已绑定 `raya` |
| Infra Bot | `run-codex-infra-bot-tui.sh` | `~/.codex-infra-bot` | `workspace-write`；两张 memory 表均缺席 |
| Mufasa | `run-codex-lead-mufasa-tui-fullaccess.sh` | `~/.codex-mufasa` | `workspace-write`；两张 memory 表均缺席 |

`~/.codex-honeylemon/config.toml` 首行标注其为 FLY-1911 voice clone 专属 CODEX_HOME；Honey Lemon 本人是 Claude Lead，仓内没有以该 home 为目标的常驻 Codex Lead launcher。该文件的只读基线为 SHA-256 `933370ad175154e89b90920c827d1d0715b69f86f8567910352eec915bd4e88a`、mtime `1787532569`、637 bytes。公共 `~/.codex/config.toml` 的基线为 SHA-256 `cd60cf74566ee5763d472df84499b784a095e831d6485d597c83f3220ea01333`、mtime `1788588324`、37030 bytes。

## 基线与测试载体

在未改代码的 `641734888` 基线上运行：

```text
TMPDIR=/tmp /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
Results: 45 passed, 0 failed
```

该套件已经提供：临时 home、假 auth、home-scoped standalone stub、真实 UNIX socket、read-only/full-access 两条 launcher 路径，以及 full-access shell→runtime gate 交叉验证。它是本单最窄的 launcher 回归载体，但有两处证据缺口：

- 当 `packages/teamlead/dist/...` 缺席时，shell→runtime xcheck 被 `[ -f "$GATE_JS" ]` 静默跳过；必须改成 fail-loud，并在聚焦测试前先 build teamlead。
- suite 只 unset profile/bin，父进程携带的 cross-dept/roundtable 环境会污染默认用例；必须在顶部清空相关 ambient 变量，再由每个用例显式注入。

同日用这组 ambient 变量实跑当前 suite，精确复现 `43 passed, 2 failed`：`no resolvable parent` 与 `chat id as only cross-dept entry` 都被父环境误判为 marker present。同时 gate dist 不存在，但 suite 没有任何 shell→runtime 输出且仍继续执行；两处缺口都已有修改前 RED 证据。

`codex 0.153.2` 的真实 `features list` 探针还确认：正确的 `[features].memories=true` 才把 feature 显示为 true；把 `memories=true` 放进 `[memories]` 不报错但 feature 仍为 false；`[memories].dedicated_tools=true` 能被 parser 接受。它将用于临时非生产 home 证据，hermetic daemon stub 不冒充 vendor parser 或真实账号 daemon。

## 需要新增的行为证据

1. 新 home 跑 read-only 与 full-access `ensure-home` 后，`features.memories is True` 且 `memories.dedicated_tools is True`；生产验收以三条 full-access 路径为主。
2. full-access 重写前先检查原配置的 memory 漂移；重写时逐字保留已经验证的 `[features]` / `[memories]` 平面表及未知键，避免 Raya/Mufasa/Infra 下一次启动抹掉后续节流配置。
3. full-access 配置含正确 pin 与五项非默认哨兵值时，两个原始表块在 ensure 前后字节相同；测试同时证明产品代码没有设置或规范化这些值。
4. `[features].memories = false`、`[memories].dedicated_tools = false`、`[memories].memories=true` 或 `[features].dedicated_tools=true` 均在生产 full-access 路径 fail-close，给出 `Fix <config> manually`，且原文件不变。
5. 缺失的 dist 使聚焦 suite 失败；完成 teamlead build 后 shell→runtime 交叉测试必须真正执行，并在新增顶层表存在时继续通过。
6. 临时非生产 home 先备份，再用真实 Codex binary 做正确/错段 parser 探针；另用 hermetic launcher/daemon harness 证明 home/daemon 流程无 `ERROR`、`Fix ... manually` 或 gate failure。记录不声称真实账号已产生记忆，也不声称三个生产 daemon 已重启。

## 上线与观测边界

代码合入后，配置只有在每个 Lead daemon 重启后才被重新读取。生产执行者必须在 R4 的 00:00/12:00 窗口或 founder 重启票内，一次只处理一个 Lead，并在每一步保留 pre-image；任何 `Fix $CONFIG manually`、launcher `ERROR` 或 runtime §10 gate failure 都触发该 Lead 回滚并停止队列。

一周后由 FLY-2355·D 读取：

```sh
find ~ -maxdepth 2 -type d -name memories -path '*/.codex*'
```

它才是“是否真实生成记忆”的后续观测。本单验收只能证明配置持久、段位正确、启动门兼容；不能把配置存在等同于功能已产出。
