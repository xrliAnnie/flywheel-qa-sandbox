# FLY-1949 评审并发 — 探索
Issue: FLY-1949 (https://linear.app/geoforge3d/issue/FLY-1949/评审并发-review-全局并发写死-2-提高并做成可配置founder-直令)
日期: 2026-09-10
基于: 无

原始需求：默认并发从 2 提高到如 8，沿 models.json 路径热配置，并考虑账号额度保护。

当前基线 bece7de15 已包含 5a8fe51bf（FLY-2037，PR #944）：移除 coordinator 全局 semaphore，保留 per-execution chain。FLY-2037 plan 明确要求无全局上限且不添加容量配置。因此本单不能直接按旧症状实施；新增默认 8 将改变已经落地的无限跨 execution 并发行为。

已向 Lead 注册 scope question 47a5e0ee-7167-4710-810d-aaca4a5a3206，等待确认新增可配置限额及默认值，或本单由 FLY-2037 替代。未修改产品代码。
