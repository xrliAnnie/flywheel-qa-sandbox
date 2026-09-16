# FLY-2602 Lead effort 操作说明
Issue: FLY-2602 (https://linear.app/geoforge3d/issue/FLY-2602)
日期: 2026-09-16
基于: research.md

## 主机一句话步骤（由 Lead 在 founder 放行窗口执行）
持 `projects.json.cfglock`，备份配置并确认唯一 `{projectName:raya, agentId:raya}`（key `raya-raya`）的旧值为 `xhigh`，仅将该行 `effort` 改为 `high`，运行下述 source `verify-activation`，成功后按现行正常 Lead 重启流程让 Raya 重载，检查新启动日志/TUI 为 high，并保留下班班车预检结果；不使用 kickstart。

## 为什么不刷新收据
当前 `verifySummaryRegistryActivation` 比较的是 summary assignment digest，并非 `postImageSha256`。真实 restart source preflight 的隔离实验已证明：effort-only 字节改动、receipt 完全不变仍通过；改变 Lead 身份则被 projection_mismatch 拒绝。该结论适用于本次已核验代码；执行前须使用待部署版本再次核验，不要把历史 postImageSha256 当成持续同步的配置校验和。

## 验证命令
从已部署仓库根执行（`FLYWHEEL_DIR` 指向该仓库）：

```bash
TSX_TSCONFIG_PATH="$FLYWHEEL_DIR/scripts/tsconfig.restart-preflight.json" \
pnpm --dir "$FLYWHEEL_DIR" exec tsx \
  "$FLYWHEEL_DIR/packages/flywheel-comm/src/bin/summary-registry.ts" verify-activation \
  --projects-file "$HOME/.flywheel/projects.json" \
  --receipt-file "$HOME/.flywheel/state/summary-registry/migration-receipt.json"
```

修改前后都必须 `ok:true`；修改后语义差异必须仅有 Raya effort，其他 Lead、身份、模型、summary 字段和 receipt 字节不变。修改失败或验证不通过时，在同一配置锁内恢复本次备份并重验，不重启；不要覆盖他人随后写入的配置。备份只包含普通配置文件，不涉及复制运行中的数据库。

## 模板发布验收
部署前两个 founder-owned 发布版本是 tpl_code@13、tpl_simple_code@5，implement 均为 Astra medium。批准的定点迁移应产生新 revision，只把 implement 改为 gpt-5.6-sol/xhigh；其他节点和 graph 保留。通过 `GET /api/workflow/templates/tpl_code` 与 `.../tpl_simple_code` 核对 `current_revision.manifest`，并确认 eng_heavy 保持原版；不是只检查 seed YAML。

## 证据边界
本文是待执行 runbook，不是生产操作回执。Runner 只在隔离文件/数据库副本上验证；Raya 实际配置修改、正常重启、启动日志/TUI high、下一班班车通过及生产模板发布均需 Lead 保存独立证据。不要把构建、CI 或隔离 API 测试报告成已完成主机切换。

## 既有 fleet 路径为何不适用
只读生产配置确认上述 project/lead 双键，backend=codex-app-server，model=gpt-6-astra，effort=xhigh。`flywheel-fleet.sh apply --lead raya-raya --effort high --yes` 不能用于本次变更：`classify_lead` 对 Codex 先返回 `UNAPPLIED codex-desired(FLY-250-manual-path)`，尚未比较 effort。不能扩展或绕过这个保护。Lead 的正常 Codex 载体重建还需核对 manifest/plist 的 effort 字段并同步派生载体；配置验证通过不代表载体一致，未同步时明确报告未完成主机验收。
