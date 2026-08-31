# FLY-2139 Bridge 定期清理与索引审计 — 运维手册
Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-29
基于: plan.md

## 默认状态

`flywheel-log-janitor.sh --cycle` 每天执行，但 DB retention 默认是 inventory-only：

- cycle 的 dry-run 半程不生成 DB snapshot；apply 半程只 inventory 一次；
- 未激活时，成功 inventory 也写 weekly marker，七天内不重复；
- `~/.flywheel/maintenance/fly-2139/` 的 retention evidence 最多保留最近两份；
- janitor summary 与 founder HTML 会显示 DB 候选数、相邻 inventory 的铸信率代理、最近 apply 的排水率；只有连续两周期 `mint > drain` 才告警，460/300 仅是校准示例，不是固定阈值；
- 没有 activation receipt 时绝不删除 DB 行。

## 激活 DB retention

先检查最近 inventory 的 `manifest.json`、各 target 的 `candidateCount`、sealed snapshot 与 before 性能证据。只有得到明确的运维批准后，才运行：

```bash
node scripts/fly-1998-database-retention-sweep.mjs activation-receipt \
  --activation-receipt "$HOME/.flywheel/state/log-janitor/db-retention-activation.json" \
  --approved-by "<批准人或批准记录 ID>" \
  --approved-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

命令只在 canonical path 新建 `0600` receipt，不覆盖既有文件；receipt 会 pin 当前 standing policy、registry、engine digest 与 row caps。下一次 apply 会重新 inventory，再用该 receipt 执行 sealed、CAS-checked、bounded policy apply。policy/registry/engine 任何变化都会使旧 receipt 失效并 fail closed。

## 失败与证据

- janitor：`~/.flywheel/state/log-janitor/audit.jsonl` 与 `~/.flywheel/maintenance/fly-2139/<run>/`；
- restart-window maintenance：`~/.flywheel/maintenance/fly-2139/db-maintenance/`；每个 DB 最多保留两份带 terminal `run.json` 或 `failure.json` 的 sealed run；只有中间态 `checkpoint.json`、seal 摘要不匹配或未分类的历史目录一律保留并等待人工审计；
- `wal_checkpoint(TRUNCATE)` 返回 `busy=1` 但 `log==checkpointed` 时，证据状态为 `checkpointed_not_truncated`，继续尝试 VACUUM 且不升级为 deploy severe；只有 `checkpointed < log` 的未落盘页仍 fail closed；
- maintenance 非零退出会由 `restart-services.sh` 调用 `alert_severe database-maintenance-failed`，同时继续重启，避免把 fleet 留在离线状态；
- 所有 DB failure 都必须先有 `failure.json`/digest，再告警；没有 sealed evidence 不宣称成功。

文件归档的兼容尾巴也受同一窗口约束：`codex-gates-archive/<YYYYMMDD>/` 与 archive 根目录下历史遗留的安全命名 `*.json` 都保留 30 天；后者逐文件做 allowlist、mtime、lsof 与 re-stat 检查，非 JSON、近期文件和 symlink 一律不动。

## 回滚

停止 standing deletion：移走 activation receipt，并保留该文件作为审计证据。后续 cycle 自动回到 weekly inventory-only；不需要重启 Bridge，也不改变任何业务 status 或读路径语义。
