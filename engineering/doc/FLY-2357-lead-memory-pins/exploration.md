# FLY-2357 常驻 Lead 记忆开关 — 探索
Issue: FLY-2357 (https://linear.app/geoforge3d/issue/FLY-2357/2355a-配置半三个常驻-lead-家开-codex-记忆features-memoriestrue-memories-dedicated)
日期: 2026-09-05
基于: 无

## 目标与锁定边界

本单只交付 FLY-2355 的配置半：让启动器持续管理三个常驻 Lead home 的两个 Codex 记忆 pin：

```toml
[features]
memories = true

[memories]
dedicated_tools = true
```

design review R1 发现原始 issue/PRD 把 FLY-1911 voice-avatar 的 `~/.codex-honeylemon` 误认成常驻 Codex Lead home。Lead 于 2026-09-05 裁定，以仓内 launcher owner 为准修正目标：`~/.codex-raya`、`~/.codex-infra-bot`、`~/.codex-mufasa`。三者分别由 `run-codex-lead-raya-tui-fullaccess.sh`、`run-codex-infra-bot-tui.sh`、`run-codex-lead-mufasa-tui-fullaccess.sh` 管理；Mufasa 不排除。

Honey Lemon 本人是 Claude Lead，没有 Codex Lead launcher；`~/.codex-honeylemon/config.toml` 的首行明确标注 FLY-1911 语音分身专属 CODEX_HOME。因此 `~/.codex-honeylemon` 与公共家 `~/.codex` 都必须零字节改动。任务级 home、IC 节点记忆回流同样不在本单范围。

以下五项保持原值，本单不写、不改默认值：

- `max_rollouts_per_startup`
- `min_rollout_idle_hours`
- `max_rollout_age_days`
- `min_rate_limit_remaining_percent`
- `disable_on_external_context`

配置需要 Lead daemon 重启后才生效，但本实现节点不重启任何 Lead；上线只走 R4 的 00:00/12:00 窗口或 founder 明确批准的重启票。

## 当前实现形状

`packages/teamlead/scripts/codex-lead-tui-home.sh` 有两条配置组装路径：

1. companion/read-only 路径保留已有 `config.toml`，用 `tomllib` 检查安全 pin，再补 `[projects.*]` 与 `[notice]`；遇到漂移时 fail-close 并要求人工修复。
2. full-access 路径每次原子重写根级 sandbox 与 `[sandbox_workspace_write]`，目前只保留 trusted projects，再追加 `[mcp_servers.lead_actions]` 与 `[notice]`。三个目标 launcher 都走这条路径。

`codex-lead-tui-runtime.ts` 在 full-access daemon 启动前再读回 TOML，分别验证 lead-actions MCP 与 sandbox/writable roots。它只约束这些块，不应拒绝新的 `[features]` / `[memories]` 块；现有 shell→runtime gate 交叉测试可直接证明这一点。

2026-09-05 对 launcher owner 做结构化核对：Infra Bot 与 Mufasa 的现有配置均缺 `[features]` / `[memories]` 且 sandbox 为 `workspace-write`；Raya home 当前尚未落盘，但 launcher/home-key/recovery mapping 已在仓内三处绑定。首次激活会在 auth/standalone 预置后由同一组装器创建配置。后续启动必须验证 pin 仍为布尔值 `true`。

## 方案比较

### A. 把两段直接写进两个现有模板分支

在 read-only heredoc 和 full-access renderer 中分别复制两段。初次落盘简单，但同一合同有两个写点，后续很容易只修一边；read-only 已有配置的校验也会散落在主流程里。

### B. 共同的 fail-closed `ensure_memory_pins`（采用）

新增一个只负责记忆 pin 的函数。它用真实 TOML 解析器判断：

- 两张表均缺席时，逐字追加两个独立表；
- 某张表缺席时，只追加缺席的那张；
- 表与键已正确时保持字节不变；
- 键为 `false`、非布尔、出现在错误表、或已有表缺键而不能安全追加时，fail-close 并输出 `Fix $CONFIG manually`。

read-only 在安全/trust 组装后调用该函数。full-access 必须先在现有 `$CONFIG` 上调用它，使 operator 漂移真实可见；随后原子 renderer 除 trusted projects 外，还要逐字保留已验证的 `[features]` 与 `[memories]` 平面表，再重建安全与 MCP 块。这样既不会抹掉本 pin，也不会抹掉 FLY-2355·D 后续测量后设置的节流值。

### C. 由 TypeScript runtime 启动前动态改 TOML

runtime 可以在 §10 gate 前写配置，但这会把“配置组装”职责分裂到 shell 与 TypeScript 两处，并产生 gate 前写入、失败回滚和原子更新的新时序。该复杂度对两个静态 pin 没有收益。

### D. 调用 vendor writer `codex features enable memories`

Codex 0.153.x 提供该命令，可以写 `[features].memories`，但它覆盖不了 `[memories].dedicated_tools`，依赖每个 home 的真实 binary 在组装时可执行，也不提供本 launcher 需要的两键统一 fail-close/保留合同。因此它适合作为非生产真实 parser 探针，不作为生产写入器。

## 失败与回滚设计

生产上线必须遵守：备份目标 `config.toml` → 先临时/残留非生产 home → 一次只处理一个 Lead → 验证 launcher/daemon 日志无 `die` 或 gate failure → 再处理下一个。若启动器出现 `Fix $CONFIG manually` 或 runtime §10 gate 失败，立即恢复该 Lead 的备份，不继续下一个。

本 PR 只改变启动器与自动化验证，不执行生产重启。非生产先行证据会让 home-scoped Codex 0.153.x 真实 binary 在无真实 auth 的临时 home 上执行 `features list`，直接证明正确段开启、错段静默无效且 `[memories]` 额外键可被真实 parser 接受；hermetic daemon stub 只用于验证 launcher 生命周期，不冒充真实 parser/账号 daemon 证据。

## 验收设计

- TOML 解析断言两个键分别位于正确表且值为布尔 `true`。
- 负控证明 `memories = true` 被写到 `[memories]` 会被拒绝，而不是被误判为成功。
- full-access 既有正确 pin 与自定义节流值的 `[features]` / `[memories]` 表重跑后逐字保留，证明生产路径没有触碰五项禁改键。
- full-access shell→runtime 交叉测试继续通过，证明新增表不会触发 §10 漂移门。
- CI 明确构建 teamlead dist 后执行 shell→runtime 交叉测试；缺 dist 必须计失败，不能 silent skip。
- `~/.codex-honeylemon` 与 `~/.codex` 只做最终只读哈希/mtime 对照，不做写入。
- 一周后由 FLY-2355·D 执行 `find ~ -maxdepth 2 -type d -name memories -path '*/.codex*'` 并判断功能是否真实产出；本单不把“配置已写”冒充“记忆已生成”。
