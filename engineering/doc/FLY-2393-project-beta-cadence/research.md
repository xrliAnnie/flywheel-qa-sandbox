# FLY-2393 项目 beta 分频 — 调研
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: exploration.md

## 代码与契约审计

| 消费者 / 证据 | 当前行为 | 设计约束 |
|---|---|---|
| PRD FLY-1098 §3.2 / §14 | 全 6h → 默认 24h、flywheel 6h、GeoForge3D 24h；B6 独立 | 两态必须可见，不改 B0–B5 依赖 |
| `packages/teamlead/src/ProjectConfig.ts:287` | `projectName/projectRoot/projectRepo`；严格项目身份验证 | 复用 roster 元组，禁止用 Lead 名或目录 basename 当 identity |
| `packages/config/src/ConfigLoader.ts:147` / `types.ts` | 项目 YAML loader、类型与验证 | 每仓 `.flywheel/config.yaml` 新增 `beta_release`，一个频率配置来源 |
| `packages/teamlead/src/bridge/feature-flag-config-source.ts` | `ProjectConfigCache` 是管理台缓存；在 plugin 的管理台条件分支内实例化 | 调度不能依赖管理台打开/启用；独立读取同一 YAML，用同源校验，不另存频率副本 |
| `packages/teamlead/src/StateStore.ts` | better-sqlite3、已有事务与 additive migration | 持久化项目游标与尝试记录；参数化 SQL；不复制生产 DB |
| `packages/teamlead/src/bridge/plugin.ts` | Bridge 启动/close、已有多个明确归属的 timer | 单个 60s beta tick；每项目异步故障隔离；close 清 timer、abort HTTP、等待有界退出 |
| `packages/teamlead/src/bridge/patrol-tick.ts` | 按 Lead 计算巡逻时间与邮箱交付 | 不复用其节奏或 mailbox identity；否则会把调度变成 Lead 自然语言任务 |
| `.github/workflows/payload-beta-release.yml` | 6h cron、main-only dispatch、FW_ENDPOINT 激活门、payload-release 串行组 | 保留 legacy 6h，显式交接后只接受 Bridge 定时输入；所有构建/发布仍受激活门 |
| `scripts/release/payload-release.mjs:94–130` | 自动 ID `beta-<SHA>`、同 sourceCommit 去重；显式 ID 是 force | schedule key 仅关联调度/回执，不传 `--release-id`；同 commit 不重复 mint |
| 同脚本 reserve / commit + `packages/release-contract` | CAS、单赢家、immutable payload、internal-beta 指针 | 不重做 B0 合同，不把 projectName 注入 flywheel manifest |
| `scripts/__tests__/release-workflows-structure.test.sh:62` | S3 锁死 cron 6h 与每步激活 guard；S2 共享 concurrency；S4 凭据隔离 | S3 增加 owner/dispatch 正反例，原 6h fallback、S2/S4 保持；不得只删旧断言 |
| `.github/workflows/ci.yml:1445` | 已执行发布工作流结构测试 | 新测试进入既有 CI 分类/执行入口 |
| GeoForge3D `.github/workflows`（只读） + GitHub Actions workflows API | 2026-09-10 API 返回 22 个工作流，无明确 beta 发布；production 和 PR preview 是不同用途 | 不推断任一个是 beta；真实入口及产物定义待 Lead 收口 |

## 外部原始文档核实

2026-09-10 读取 [GitHub workflow REST 文档](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)：当前 `2026-03-10` API 示例中 dispatch 返回 200 与 workflow run ID/URL；需 Actions write，ref 是分支或 tag，inputs 必须在 workflow 声明。设计固定该 API 版本、校验响应；不依赖旧版「204 就代表发好了」假设。

[GitHub concurrency 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)说明并发组按仓库约束，默认保留一个运行与一个等待任务，顺序不保证，新的等待任务可能替换旧的等待任务。结论：Bridge 必须持有本项目未结算尝试，不能每个 tick 盲目 dispatch；保留 flywheel 的 `payload-release` 锁，不改成每个 workflow 一个组，否则会绕过与客户发布共用的串行保护。

## 选择与限制

选择 Bridge 负责到期判断和回执，各仓工作流负责真正发布。默认 24h 只对已接管项目生效；未接管仍 6h。owner 的唯一运行时真相为目标仓库变量 `FW_BETA_SCHEDULER_OWNER`（缺省 legacy），YAML 只存频率/工作流绑定，不镜像 owner 开关。读取 owner 失败时该项目停止新 dispatch，不触碰客户发布。

不能承诺 GitHub 按秒开工；验收分别记录 dueAt、acceptedAt、startedAt、publishedAt。调度正常时 60s tick 内发出请求；队列等待是外部延迟，不伪报成精确发布时刻。

真实 GeoForge3D 入口未核实，所以设计完成不等于双项目上线。此缺口保留在计划的激活前置和证据清单；必须由实际项目 owner 给出内部 beta 目标并完成端到端验证。调度适配合同本身应能对任意两个已接入的项目运行，不能只硬编码 flywheel 与 geoforge3d。
