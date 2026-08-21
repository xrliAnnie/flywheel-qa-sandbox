# FLY-1728 报告缓存安全剪枝 — 实施计划
Issue: FLY-1728 (https://linear.app/geoforge3d/issue/FLY-1728/基础设施小-publish-report-本地报告缓存无自动剪枝-缓存超-vercel-10mb-body-cap-后全部发布-502)
日期: 2026-08-21
基于: research.md

## 1. 实现结论

只改现有 registry 的默认 HTML 总字节上限：

```typescript
export const DEFAULT_RETENTION_BYTES = 8.5 * 1024 * 1024;
```

保留现有 TTL → count/bytes 剪枝、stage → deploy → commit 事务、registry 结构和所有 API 完全不变。不新增依赖、helper、env 或抽象。

## 2. TDD 步骤

1. **RED：默认值合同**
   - 把既有“100 entries / 10MB”断言改为“100 entries / 8.5 MiB”。
   - 先运行 `report-registry.test.ts`，记录当前实现仍为 10 MiB 的预期失败。
2. **RED：高频重报告回归**
   - 一次性 seed 20 份每份精确 480 KiB 的保留报告，再 stage 第 21 份；避免 20 轮全集重读的 O(n²) I/O。
   - fixture 显式保证至少 5% 引号/换行/反斜杠等 JSON 转义密度，对齐 design review 复测的单份最坏膨胀比 1.0509。
   - 先断言剪枝前总量低于旧 10 MiB 上限、但生产同形 JSON body > 10,000,000 bytes，证明旧阈值会放行故障 fixture。
   - 再断言精确剪枝数、最旧报告移除、最新报告留存、staged HTML 总量 ≤ 8.5 MiB，且剪枝后生产同形 JSON body < 10,000,000 bytes。给用例显式 10s timeout，防宿主负载将固定 5s 误判为产品回归。
3. **GREEN：最小代码改动**
   - 只把 `DEFAULT_RETENTION_BYTES` 从 10 MiB 改为 8.5 MiB，同步附近注释。
4. **REFACTOR 检查**
   - 确认无新 helper、无重复算法、无可删死代码。
5. **运维口径**
   - 同步 `doc/reference/remote-report-pipeline.md` 的“100 份 / 10MB”为“100 份 / 8.5 MiB”，不留过期文档。

## 3. 验证门

按风险从小到大运行：

1. `pnpm --filter flywheel-teamlead test:run src/__tests__/report-registry.test.ts`
2. `pnpm lint`
3. `pnpm -r build`
4. `pnpm test:packages:run`

该改动不涉及渲染表面，不需要 proofshot 视觉验证。也不新增 `scripts/__tests__/*.test.sh`，无额外 shell harness。独立 QA 节点另用隔离 Bridge + 临时 `FLYWHEEL_REPORTS_DIR` + `publish-report --publish-only` 执行一次真 Vercel 冒烟，记录上游响应与公网 200；不读写生产 registry，不发 Discord。

## 4. 验收对应

| 要求 | 实现证据 | 验证证据 |
|---|---|---|
| 保留集有自动字节上限 | `DEFAULT_RETENTION_BYTES = 8.5 MiB`；复用现有最旧优先 while-prune | 默认值合同 + bytes-cap 单测 |
| 过期报告自动剪枝 | 保留现有 7 天 TTL pass | 既有 TTL 边界、abort、count 共存测试 |
| ≥20 份重报告不再因保留集 502 | 20 份精确 480 KiB + 第 21 份的事故同形状态在 deploy 前剪到 8.5 MiB 内 | 回归先证旧阈值 body > 10,000,000，再证新阈值 body < 10,000,000；QA 隔离真发布 |
| 旧链接按时间最旧先下线 | 保留 `all.shift()` 策略 | 回归断言首份被移除、最后一份留存 |
| 其他 publish-report 行为不变 | 无 route/deploy/schema/CLI 改动 | TeamLead 定向测试 + 全仓门 |

## 5. 失败边界

- deploy 失败时仍 `abort()`：缓存剪枝不落盘，旧链接不被本地提前删除。
- deploy 成功后 commit 仍按“写新报告 → registry rename → best-effort 删旧报告”；本修复不改事务语义。
- registry 损坏仍 fail-loud，不会为剪枝而静默重建。
- 本单不新增逐条 `bytes` 校验或容量剪枝日志：design review 已证当前生产 100 条 `bytes` 全部有效，且 count/bytes 早于 TTL 失效是既有合同。这两项是无现存故障证据的防御性扩张，按 Ponytail/YAGNI 留出本小修复。

## 6. 会过期的结论

| 结论 | as-of | 重核方法 |
|---|---|---|
| 全仓门仍为 `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` | 2026-08-21 | 对照最新 Engineer Executor 合同与根 `package.json` scripts |
| TeamLead 包名为 `flywheel-teamlead`，定向脚本为 `test:run` | 2026-08-21 | 读 `packages/teamlead/package.json`，并运行 `pnpm --filter flywheel-teamlead test:run src/__tests__/report-registry.test.ts` |
| 上游 body cap 可以用 10,000,000 bytes 作为回归的保守线 | 2026-08-21 | 若 Vercel 改协议/上限，用官方文档与真发布 spike 重核 |
