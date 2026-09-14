# FLY-2549 预检工作区构建 — 探索
Issue: FLY-2549 (https://linear.app/geoforge3d/issue/FLY-2549/病根-班车-restart-预检在-pnpm-build-之前用-tsx-跑源码工作区包新导出flywheel-config)
日期: 2026-09-14
基于: 无

## 问题与边界
summary_registry_activation_preflight 在 pull 后执行，tsx 的 TeamLead 校验器从 ProjectConfig.ts 导入 flywheel-config 新导出，但包入口指向旧 dist。已有 build_project 在 stop_bridge 后执行，无法帮助此前预检。
范围仅 scripts/restart-services.sh、脚本测试和本任务流程文档。禁止生产 src、updater 调度、R4 权限或运行中服务变更。
