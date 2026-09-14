# FLY-2549 预检工作区构建 — 调研
Issue: FLY-2549 (https://linear.app/geoforge3d/issue/FLY-2549/病根-班车-restart-预检在-pnpm-build-之前用-tsx-跑源码工作区包新导出flywheel-config)
日期: 2026-09-14
基于: exploration.md

## 当前代码证据
- scripts/restart-services.sh:202 定义 source verifier，1862 调用；deploy_and_verify 在 stop_bridge 之后才 build_project。
- packages/flywheel-comm/src/commands/summary-registry.ts 启动独立 tsx TeamLead 校验器。
- packages/teamlead/src/ProjectConfig.ts 运行时导入 flywheel-config、flywheel-core 和 flywheel-comm/lead-identity；其余为相对源码。
- packages/flywheel-comm/package.json 声明 config、agent-team-transport、token-usage 工作区依赖，pnpm 的递归 filter 可拓扑构建闭包。
- fly2030-summary-registry-activation.test.sh 要求 gate 早于 default_lead_agent_env_converge。
## 选择（设计评审 R1 后修订）
原地预构建被 HIGH finding prebuild-mutates-live-dist-before-stop 拒绝：运行中 Lead 继续启动 comm CLI，且新 dist 可能在停机备份前触发库迁移。接受 finding，删除预构建方案。
采用题目建议 ②：scripts 内新增小型 tsconfig paths 映射 flywheel-config、flywheel-core、flywheel-comm/lead-identity 至对应 src；在现有 pnpm exec tsx 命令上设置 TSX_TSCONFIG_PATH，子进程 validator 继承同一环境。源验证不写 dist 或 node_modules，原 full build、stop、rollback、dry-run 顺序均保持。
只映射实际被读到的工作区依赖。真实当前源码入口回归使用隔离旧 dist，对当前 import 图失配会直接失败；不新增静态 import 图扫描器。
