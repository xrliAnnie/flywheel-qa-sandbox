# FLY-1728 报告缓存安全剪枝 — 调研
Issue: FLY-1728 (https://linear.app/geoforge3d/issue/FLY-1728/基础设施小-publish-report-本地报告缓存无自动剪枝-缓存超-vercel-10mb-body-cap-后全部发布-502)
日期: 2026-08-21
基于: exploration.md

## 1. 现行路径审计

| 环节 | 权威代码 | 现行行为 |
|---|---|---|
| 入口边界 | `packages/teamlead/src/bridge/reports-route.ts` | 单份 HTML 不得超过 512 KiB；串行执行 stage → deploy → commit |
| 保留集 | `packages/teamlead/src/bridge/report-registry.ts` | 记录 hardened HTML 的 `bytes`，TTL 剪枝后再按 count/bytes 从最旧项剪枝 |
| 上游 body | `packages/teamlead/src/bridge/vercel-deploy.ts` | 把 `robots.txt` 与所有在保 HTML 包成一个 `JSON.stringify(...)` POST body |
| 生产配置 | `packages/teamlead/src/bridge/plugin.ts` | 只可覆盖 TTL；count/bytes 使用 registry 默认值 |

关键常量：

- `DEFAULT_RETENTION_MAX = 100`
- `DEFAULT_RETENTION_BYTES = 10 * 1024 * 1024`
- `DEFAULT_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`

## 2. 故障机制

registry 限制的是 hardened HTML 原始 UTF-8 字节和，Vercel 限制的是完整 HTTP JSON body。后者除 HTML 外还包含：

- deployment name、`target`、`projectSettings`；
- 每个文件的 path、`encoding` 与 JSON 结构；
- HTML 里必须由 JSON 转义的引号、反斜杠和控制字符。

所以“本地总量刚好低于 10 MiB”不能推出“上游 body 低于 10 MB”。事故中的 10.28 MB 保留集未达本地 10 MiB (10,485,760 bytes) 剪枝线，但加上 JSON 封装后被 Vercel 拒绝，恰好符合代码路径。

### 2.1 证据强度与对照

- Issue 事故记录明确携带 FLY-1710 设计报告里的诊断文本：保留集 100 文件 / 10,280,000 bytes，全集 JSON body 超过 Vercel 10 MB 限制。这是本单的事故交接证据。
- 对照操作是手工剪掉 22 份旧报告，把缓存降到约 8.5 MB 后发布立即恢复；它支持“容量是必要变量”，并与单日部署额度超限的另一种 502 形状区分开。
- 当前 worktree 和本机日志中未保存当时 `Vercel deploy failed (<status>): <body>` 原始行，因此本文不把 Bridge 统一转译的 502 本身当成上游状态码证据。真上游闭环由独立 QA 的隔离发布冒烟补证。
- Design review R1 对生产 registry 100 份报告重新量测：整体 JSON 膨胀比 1.0284，单份最坏 1.0509，最大单份 413,921 bytes（as-of 2026-08-21）。这组数字用于校准回归 fixture，不当成 Vercel 硬限的代替证据。

## 3. 最小修法评估

现有 `stagePublish()` 已完成任务需要的算法：

```text
TTL 过期项先移除
→ 计算在保 bytes
→ 当 count 或 bytes 超限时不断 shift 最旧项
→ deploy 成功后原子更新 registry，再 best-effort 删本地旧文件
```

因此不需要新 helper、新 schema 或新调度器。把默认字节上限改为 `8.5 * 1024 * 1024`，便可让所有现有路径自动获得余量。

8.5 MiB 相对上游上限的余量：

| 上游口径 | 上限 | 原始 HTML 上限 | 最小余量 |
|---|---:|---:|---:|
| decimal 10 MB | 10,000,000 | 8,912,896 | 1,087,104 bytes |
| binary 10 MiB | 10,485,760 | 8,912,896 | 1,572,864 bytes |

## 4. 回归形状

在 registry 真文件测试中一次性 seed 20 份每份精确 480 KiB 的保留报告，再 stage 第 21 份。seed 避免用 20 次全集重读造成 O(n²) I/O，但保留故障时的权威状态：下一次 publish 面对一个已接近 cap 的保留集。

fixture 内容显式包含 5% 的引号/换行/反斜杠等 JSON 转义字符，不用纯 `x.repeat()` 空过：

1. 断言剪枝前原始 HTML 总量低于旧 10 MiB 本地上限，但生产同形 JSON body 大于 10,000,000 bytes，先证明旧阈值会放行故障形状。
2. 断言新阈值下确实剪掉精确数量的最旧报告，最新报告保留，不是空过绿。
3. 断言 staged HTML 总字节不超过 8.5 MiB。
4. 用生产同形的 `JSON.stringify` 包装剪枝后 `deployFiles`，断言 body 小于 10,000,000 bytes。

这同时覆盖 issue 的“≥20 份重报告”验收与实际 502 机制。

## 5. 风险与边界

- 这不是对任意恶意 HTML 的 JSON 最坏情况数学证明；它是针对生产报告形状与已观测事故留出约 11% 以上余量的运维上限。
- 若 Vercel 后续改变 cap 或 deploy payload 协议，需重新校准常量；本修复不把上游协议复制进 registry。
- 剪枝依然是惰性的；只要有下一次 publish，即在发 Vercel 前缩小 staged set。
- `load()` 的逐条 `bytes` 校验与“容量剪枝提前下线”日志属防御性加固；设计复审已证生产 100 条 `bytes` 全部合法，且现有合同已明确 count/bytes 可早于 TTL 生效。按 Ponytail/YAGNI，本小型事故修复不新增这两条机制；若出现真正的畸形 registry 或可观测性缺口，再单独治理。

## 6. 会过期的结论

| 结论 | as-of | 重核方法 |
|---|---|---|
| Vercel API 请求体仍由 `JSON.stringify` 一次包入全部 inline files | 2026-08-21 | 读 `deployFilesToVercel()` 的 fetch body |
| 报告路由仍限制单份 HTML ≤ 512 KiB | 2026-08-21 | 读 `reports-route.ts` 的 `MAX_HTML_SIZE` 检查 |
| registry 剪枝顺序仍是 TTL 先行、再 count/bytes 最旧优先 | 2026-08-21 | 读 `ReportRegistry.stagePublish()` 并运行 `report-registry.test.ts` |
| 生产报告 JSON 膨胀比整体 1.0284、单份最坏 1.0509 | 2026-08-21 | 从当时生产 `registry.json` + `files/*.html` 重算；不沿用旧采样替代新数据 |
