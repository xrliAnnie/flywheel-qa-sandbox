# FLY-2103 project config flag 退役 — QA 报告
Issue: FLY-2103 (https://linear.app/geoforge3d/issue/FLY-2103/flagcconfigyaml-退役-9-个-project-config-flag-处置checkpointsenabled)
日期: 2026-08-28
基于: plan.md

## 结论

通过。真实 Bridge 六项目对照证明迁移前后 7 个项目级 flag 的 effective behavior 完全一致；候选 SQLite 只包含迁移 manifest 允许的 7 行。ConfigLoader 对 9 类旧 key fail-loud，生产读点不再读取这些 YAML flag。

## 真实 Bridge 六项目对照

验证脚本：`qa-bridge-parity.mjs`。它分别启动真实 baseline/candidate Bridge，使用隔离的 HOME、项目配置、端口和 SQLite；候选行通过真实 `/api/fleet/flag/stage` + `/apply` 写入，再从真实 `/api/fleet/snapshot` 读取 effective state。

- baseline：`d4e08f4a55aee01ef261e7f90c40a541e03d0863`
- candidate：`9ecbf9906745d1dc5e9bcc124def2689f0a0a3d8`
- 结果：`parity: true`

| flag | flywheel | geoforge3d | growth | joycon-typeless | personal-assistant | tidal-echo |
| --- | --- | --- | --- | --- | --- | --- |
| `doc_flow` | ON | OFF | OFF | ON | ON | ON |
| `pipeline_dag` | ON | ON | ON | ON | ON | ON |
| `pipeline_work_kind` | ON | OFF | OFF | OFF | OFF | OFF |
| `proofshot` | OFF | OFF | OFF | OFF | OFF | OFF |
| `xiaohongshu_learning` | OFF | OFF | OFF | OFF | OFF | OFF |
| `ponytail` | OFF | OFF | OFF | OFF | OFF | OFF |
| `skill_framework_split_participation` | ON | ON | ON | ON | ON | ON |

候选库 exact rows：

```text
doc_flow/flywheel=1
doc_flow/joycon-typeless=1
doc_flow/personal-assistant=1
doc_flow/tidal-echo=1
pipeline_dag/flywheel=1
pipeline_work_kind/flywheel=1
ponytail/*=0
```

没有为 registry default 已等价的项目写冗余行。`ponytail/*=0` 显式保存 Annie exception；其余 rowless flag 按 registry default 解析。

## 迁移与边界

- `scripts/migrate-fly2103-project-flags.ts` 默认 dry-run，支持 `pre-cutover`、`post-cutover` 两阶段，重复执行跳过同值行。
- pre-cutover 对现网六份 YAML 的严格审计得到 6 个计划写入，未产生写操作、额外行或冲突。
- post-cutover 要求绑定 manifest、配置 digest、DB realpath、Bridge target、exact rows 的 G1 receipt；旧 key 未清干净或 DB 行不精确时拒绝继续。
- ConfigLoader 测试覆盖旧 checkpoint `enabled`、`doc_flow.enabled`、`pipeline.*`、`skills.proofshot.enabled`、`xiaohongshu_learning.enabled`、`ponytail.enabled`、`skill_framework.split` 和 collection `auto_create` 残留。

## 读点清理

生产源码 focused syntax sweep：

```text
(config|loaded|cfg|projectConfig|this.config).(doc_flow|pipeline|skills|ponytail|skill_framework|xiaohongshu_learning).(enabled|dag|work_kind|split)
.auto_create
checkpoints.<name>.enabled
```

排除测试与一次性 migration 的读取后，唯一命中是 `ConfigLoader` 对 `collections[].auto_create` 的拒绝逻辑；无运行时 YAML flag reader。宽泛文本搜索剩余命中均属于 registry 元数据、ConfigLoader fail-loud 字符串、迁移审计、历史 provenance 文案或非 flag 字段 `plan.autoCreate`。

## 测试证据

- FLY-2103 focused Vitest：681 passed；generalized QA helper：4 passed；真实 Bridge parity：passed。
- 最后发现的旧契约四文件复验：111/111 passed。
- `pnpm lint`：exit 0；14 条 warning 在 baseline 同样存在，本分支无新增 diagnostic。
- `pnpm -r build`：22/23 workspace projects built，exit 0。
- package headless matrix：core 219/219、edge-worker 1286 passed / 14 skipped、voice-core 321 passed / 4 skipped、voice-bridge 673 passed。
- Teamlead 全套：9635 passed / 6 skipped；8 个失败均为高并发时限或动态 mock 污染。同一批失败文件用 `--no-file-parallelism` 隔离复验为 32/32 passed；先前 retention timeout 文件隔离复验也为 11/11 passed。
- Claude runner 并发矩阵中两个 tmux socket contention 失败，相关两个文件隔离复验 160/160 passed。
- 精确 `pnpm test:packages:run` 在 core 的两个真实 macOS Terminal 测试受当前 `osascript` service unavailable 限制；baseline 同命令复现。排除该环境依赖测试后 core 219/219 passed。

## 外部项目配置 PR

- GeoForge3D #283
- joycon-typeless #49
- personal-assistant（belle-workspace）#3
- growth #25
- tidal-echo #28

flywheel 本仓配置随主 PR 交付。五个外部 PR 均只删除本单退役 key，不包含运行时代码或部署动作。
