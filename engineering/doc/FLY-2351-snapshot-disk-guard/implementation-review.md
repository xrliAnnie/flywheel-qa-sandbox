# FLY-2351 快照磁盘防线 — 实现审查
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: plan.md

## R1 非阻塞后续项

以下 LOW findings 不属于本轮阻塞修复范围，保留为后续工作：

- `hook-payload-partial-disk-fields`：容量快照只含一个磁盘字段时，应只降级磁盘单元格，而不是丢弃整段容量信息。
- `retention-apply-counters`：apply 维护日志应分别汇总实际删除数与逐文件删除失败数。
- `partial-wal-shm-cleanup`：失败快照的 `.partial` 工作目录可能遗留 SQLite `-wal` / `-shm` 辅助文件，应在后续清理中覆盖。
- `repair-root-created-without-mode`：`patrol-repairs` 根目录应显式创建为 `0700` 并校验权限。
- `release-lock-throw-in-finally-masks-result`：锁释放漂移不应覆盖已经完成的结果或原始异常。
