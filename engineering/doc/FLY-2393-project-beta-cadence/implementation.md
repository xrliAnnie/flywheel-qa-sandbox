# FLY-2393 项目 beta 分频 — 实现记录
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: plan.md

## 实现基线

实现接入 HEAD f3dbcb5c683eb400ccc8dc7f57ba9f709efdd2ab，TURN implement epoch=2。
实时 check 9c9dff1e-394c-4874-8096-b0a9e1aedc68 确认 R2 effective reviewVerdict=APPROVED。
plan.md 字节保持不变。

Lead 对 question bedfb3f4-ab23-42bf-bbb5-ac06f8b68df0 裁定：允许仅给 payload-promote / payload-promote-commit / payload-activation 三个 workflow 的 concurrency 增 queue:max，其余行不动；须 YAML 校验，PR 描述单列三处 diff。待 C3/C5 执行。

## C1 配置（进行中）

新增共享 beta_release parser 与 ConfigLoader/type/export 集成。缺块保持 undefined；显式块默认 24h；1–168 安全整数；workflow basename/token env/未知字段拒绝且不回显输入值。
Bridge canonical-root reader 每次重读配置，独立隔离解析失败；缺文件=unconfigured；拒绝跨 root symlink、非法仓库、缺少/共用凭据；不读取频率 env override，不回退 GH_TOKEN。
GitHub numeric repository/workflow 身份核验与持久绑定仍待 C2/C3；调度和 UI 尚未接入。

TDD：首次 vitest 缺失是环境错误，不算红灯；锁文件安装后缺模块红灯→默认行为绿灯；非法配置断言红灯→校验绿灯；ConfigLoader 默认不一致红灯→共享 parser 绿灯；Bridge source 缺模块及凭据/缺文件行为红灯→绿灯。

已验证：
- pnpm --filter flywheel-config test:run：51 files / 791 tests PASS。
- pnpm --filter flywheel-config build：PASS。
- pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/beta-release-config-source.test.ts：3 tests PASS。

尚未执行全仓 lint/build/test、code review、PR、handoff。以上不是调度器完成或真实双项目发布证据。
