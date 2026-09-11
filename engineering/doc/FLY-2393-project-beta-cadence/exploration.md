# FLY-2393 项目 beta 分频 — 探索
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: 无

## 目标与授权范围

落实 PRD `product/doc/FLY-1098-release-cicd/prd.md` §3.2：现状全 6h；Bridge 支持独立调度后，每项目默认 24h，flywheel（PRD 展示名 Flavio）显式 6h，geoforge3d 24h。Beta 指内部测试版发布，不是机器拉取更新、Lead 巡逻，也不是客户每周 release。

B6 只阻塞这项目标态，不加入 B0–B5 激活依赖链，不更改判据聚合、客户发布授权或部署。排期由 Lead/founder 决定；本次收到的是 design 执行授权，不自行派后继或改变其他单排期。

## 已核实事实

- 审计起点 HEAD `d964e9fcada02a0006b54337b28382ce474dab3e`；工作树初始干净，design TURN epoch=1。
- PRD 的「现状全 6h」是产品基线。代码证据不同：`.github/workflows/payload-beta-release.yml` 才是已找到的每 6h 发布入口，Bridge `plugin.ts` 无 beta publisher/scheduler。不能把历史描述当已存在的可改函数。
- 发布脚本 `scripts/release/payload-release.mjs` 以 `beta-<sourceCommit>` 去重；传显式 `release-id` 会绕过同 commit 去重。定时调度身份不可塞进这个 force 输入。
- 稳定身份是 roster 的 `projectName`；当前投影确认 `flywheel → xrliAnnie/flywheel`，`geoforge3d → xrliAnnie/geoforge3d`。Flavio 是 PRD 展示名，不能用作新存储 key。
- 只读查看 GeoForge3D 工作流，未找到 beta 发布入口；`backend-deploy-services.yml` 明确 production-only，不能自动绑定来满足双项目验收。

## 选项

| 方案 | 收益 | 缺点 / 决策 |
|---|---|---|
| 各仓独立 cron | 改动少、可按仓分频 | 频率散落 YAML，Bridge 不拥有项目调度；不满足本单目标 |
| Bridge 到期账本 + 各仓 beta workflow | 一个项目配置真相；复用各仓构建和权限边界 | 需要持久化调度回执、接管旧 cron、明确第二项目 publisher；推荐 |
| Bridge 本机直接打包与发布 | 少一次网络 dispatch | 主循环承担构建、凭据、进程回收；重做已有发布线，拒绝 |

## 不确定性与 Lead 问题

已发非阻塞问题 `2ecaa2f2-3aa4-46f4-9e5e-ae3dd321585b`：确认 Bridge 历史入口与 GeoForge3D 的 beta workflow/验收环境；另补充 production-only 证据。2026-09-10 两个问题均收到 Lead 明确裁定：采用 Bridge dispatch；Geo 缺入口时不激活且页面明示，模拟测试不代表双项目上线。继续审计持久化、接管和回归。设计必须区分调度能力的自动化测试和真实双项目发布验收；后者不得用假 workflow 或生产部署顶替。

## 交付路径

设计节点只写 exploration/research/plan、Mermaid 源和 founder HTML，完成显式 request-review 并取得有效 APPROVED 后发布、报告，最后 phase_design_complete + park。按注入任务不另开 brainstorm / ship gate。通用 slash-command 的交互确认与旧 Codex companion 流程由本任务的非阻塞 Lead 问题和 request-review 合同替代。
