# FLY-2357 常驻 Lead 记忆开关 — 实施证据
Issue: FLY-2357 (https://linear.app/geoforge3d/issue/FLY-2357/2355a-配置半三个常驻-lead-家开-codex-记忆features-memoriestrue-memories-dedicated)
日期: 2026-09-05
基于: plan.md

## 结论

启动器现在把 `features.memories=true` 与 `memories.dedicated_tools=true` 作为两个独立、fail-closed 的 pin 管理。full-access renderer 在同目录 staging 中校验与组装，只有 sandbox、memory pins 和原始 memory 表全键全值等价都成立才原子替换；已有平面 `[features]` / `[memories]` 表的注释、顺序、未知键和节流值会逐字保留。

design review R2 的结构化 verdict 是 `APPROVED`。目标按 Lead 裁定修正为真实 launcher owner：Raya、Infra Bot、Mufasa。Raya 当前只有仓内 launcher/home-key/recovery binding，尚无 `~/.codex-raya` 或生产 LaunchAgent；它会在首次正式 activation 时继承本 pin，不属于本次 R4 重启队列。已部署且需要一次配置重读的是 Infra Bot 与 Mufasa。

## 自动化行为证据

聚焦 suite 在实现完成后返回：

```text
TMPDIR=/tmp /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
Results: 61 passed, 0 failed
```

覆盖包括：

- read-only 与 full-access 两条路径的正确 TOML 段位；
- full-access 的 `memories=false`、`dedicated_tools=false` 与两种错段均在重写前失败，且原文件不变；
- read-only 在任一表漂移时先验证完两表再写，避免半写入；
- 带注释、未知 feature key 和五项非默认节流哨兵的两个表块逐字保留；
- fresh 与 sentinel full-access 配置连续两次 ensure 后整文件 byte-identical；
- inline/dotted/nested 等无法无损保存的形状 fail-close，原文件不变且两个 staging 文件都被清理；
- 五组 shell→runtime xcheck 实际执行并通过 lead-actions MCP 与 sandbox/writable-roots §10 gate；缺 dist 不再 silent skip，module-load 与真正 gate rejection 的报错分开。

CI 已把该 suite 登记进 `script-tests-2` 的 `FLY-1955/2211 Codex daemon mutation safety` step。该 shard 先执行 dependency install 与 repo build；suite 缺 gate/runtime dist 会直接计失败。

## 全仓验证

以下门在本分支通过：

```text
pnpm lint
pnpm -r build
TMPDIR=/tmp /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
```

`pnpm test:packages:run` 在 teamlead shard 返回非零：全仓汇总为 11,232 passed、6 skipped、4 failed，并伴随一个 Vitest worker `onTaskUpdate` RPC timeout。失败文件均未被本分支修改。将四个失败文件以单 worker 隔离复跑后，`StructuredInboxRouter`、`claude-profile-cli.integration` 与 `fly-1998-database-retention-sweep` 共 44 个测试全部通过；唯一稳定失败是 FLY-2118 的 real-tmux fixture：它要求创建名字含 TAB 的 tmux window，而本机 `tmux 3.7c` 返回 `invalid window name: SCRATCH\\tTAB`。隔离汇总为 56 passed、1 failed。该环境/基线失败已上报 Lead，没有改写或跳过相关测试来制造全绿结论。

本分支没有新增根目录 `scripts/__tests__/*.test.sh`。`git diff --check` 通过。

## 非生产先行：真实 Codex parser

隔离目录：`/tmp/fly2357-parser.snsHo6`。四个 case 都在运行前复制 `config.toml.preimage`，`CODEX_HOME` 只指向各自临时子目录，不复制真实 auth，不接触生产 daemon。中性 binary 报 `codex-cli 0.153.2`；只读版本核对显示 Infra Bot、Mufasa 的已部署 standalone 都是 `codex-cli 0.153.4`，因此这里记录的是同 minor 的非生产 parser 证据，不冒充生产 build 启动证据。

```text
case=bare            memories stable false  rc=0  preimage_unchanged=yes
case=correct         memories stable true   rc=0  preimage_unchanged=yes
case=wrong-table     memories stable false  rc=0  preimage_unchanged=yes
case=dedicated-only  memories stable false  rc=0  preimage_unchanged=yes
```

这证明只有 `[features].memories=true` 开启 master feature；`[memories].memories=true` 会静默无效；`[memories].dedicated_tools=true` 能被真实 0.153.x parser 接受。

## 非生产先行：launcher 与 daemon 生命周期

独立临时 home：`/tmp/fly2357-launcher.nf13t0/home`。先保存 pre-image（SHA-256 `7c3dfd45874f65fb7d3d21077d7283b1885c2137170fd6cf54bc21b7ddbccdb7`），再运行真实 launcher 的 full-access `ensure-home`、TOML 断言、已构建 TypeScript §10 gate，最后用 suite 同形的 home-scoped hermetic standalone stub 执行 `ensure-daemon`。组装后配置 SHA-256 为 `1317b260b1c55f0dd8503fdce68d919d1954513b9c332f9844f0c7b8ccfe11a4`。

```text
home OK (full-access): /tmp/fly2357-launcher.nf13t0/home
runtime_gate=pass
remote-control stop --json
remote-control start --json
daemon OK: /tmp/fly2357-launcher.nf13t0/home/app-server-control/app-server-control.sock
```

输出不含 `ERROR`、`Fix ... manually` 或 gate failure。这个演练证明 launcher 组装、runtime gate 与 daemon 生命周期接口兼容；stub 不代表真实账号 daemon，也不证明 memory 已经生成。

## 零触碰与禁改项

实现后只读复核与设计前基线完全相同：

| 排除目标 | SHA-256 | mtime | size |
|---|---|---:|---:|
| `~/.codex-honeylemon/config.toml` | `933370ad175154e89b90920c827d1d0715b69f86f8567910352eec915bd4e88a` | 1787532569 | 637 |
| `~/.codex/config.toml` | `cd60cf74566ee5763d472df84499b784a095e831d6485d597c83f3220ea01333` | 1788588324 | 37030 |

`max_rollouts_per_startup`、`min_rollout_idle_hours`、`max_rollout_age_days`、`min_rate_limit_remaining_percent`、`disable_on_external_context` 没有出现在 launcher 产品代码中；它们只出现在测试哨兵与设计/证据文档中。测试用非默认值只证明“保留原值”，不构成推荐或生产写入。

## 代码审查

按节点合同实际调用 `codex:rescue` companion 的 read-only review 路径；resident 外层 macOS seatbelt 在 reviewer 读取仓库前拒绝 nested `sandbox-exec`（status 71，`sandbox_apply: Operation not permitted`）。该尝试没有 verdict，未把它冒充 review PASS，也没有改走禁止的 raw `codex exec`。

request-driven cross-family code review R1 在精确 head `c18bca4958591c5d4a151196be54197b15d65cca` 返回 **APPROVED**，`reviewerVerdict` 同为 `APPROVED`，无 HIGH/blocking finding。gate 为 `6f81fcd0-d917-41df-bef1-1428933a6b8f`，request 为 `d8e9db89-16eb-4bd0-9bcb-28c83b4f1c09`。一项 MEDIUM advisory 指出现有 `[features]` 表缺 pin 时会 fail-close，而非向该表插键；五项 LOW 涉及 read-only trust 写入先于 memory gate、表间注释保留、替代 TOML 拼写的一致性、boot 失败告警与 staging signal cleanup。它们已按 `medium_low_findings_are_non_blocking_v1` 回传 Lead，未擅自扩大本单锁定范围。

## 生产激活与真实回滚

本单没有重启、停止或启动任何生产 Lead。merge/deploy 后：

1. 走 R4 00:00/12:00 班车或 founder 重启票；先保存该 home 的 `config.toml` pre-image。
2. 一次只重启 Infra Bot 或 Mufasa 中的一个，确认 launcher 日志含 `home OK`、daemon 正常起，且不含 `ERROR`、`Fix ... manually` 或 §10 gate failure，才处理另一个。
3. Raya 不在这条重启队列；未来首次部署时单独走同样的备份、启动、日志确认流程。
4. 任一 `Fix $CONFIG manually`、launcher die 或 gate failure 都立即停止队列。恢复 pre-image 只是数据回滚的一部分；因为 launcher 会再次补 pin，真正关闭本功能必须先 revert 本 launcher commit 并重新部署，再恢复 pre-image/重启。仅运行 `codex features disable memories` 会写 `memories=false` 并触发本 fail-closed drift gate，因此不支持按 home 私自关闭。

三个生产目标都尚未通过本变更后的真实 daemon 重读，不能把“代码已写”表述成“生产功能已开”。Infra Bot/Mufasa 的一次重启和 Raya 的首次 activation 属于后续受控执行。

## 一周后观测

一周后由 FLY-2355·D 执行并接收读数：

```sh
find ~ -maxdepth 2 -type d -name memories -path '*/.codex*'
```

只有这个观测与后续质量/配额数据才能判断 memory 是否真实产出；本单不以配置存在代替功能结果。
