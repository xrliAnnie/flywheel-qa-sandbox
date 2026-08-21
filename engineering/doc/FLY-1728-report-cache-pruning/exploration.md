# FLY-1728 报告缓存安全剪枝 — 探索
Issue: FLY-1728 (https://linear.app/geoforge3d/issue/FLY-1728/基础设施小-publish-report-本地报告缓存无自动剪枝-缓存超-vercel-10mb-body-cap-后全部发布-502)
日期: 2026-08-21
基于: 无

## 1. 问题边界

2026-08-12 的真实故障不是单份 HTML 超限，而是 `publish-report` 每次把全部保留报告放入 Vercel JSON body。当本地保留集达到 100 份、约 10.28 MB 时，每次新发布都被上游 body cap 拒绝，形成全局 502。

当前代码已有三维剪枝：7 天 TTL、100 份数量上限、10 MiB HTML 字节上限。因此 issue 标题里的“无自动剪枝”与当前 `main` 不完全相符；真正缺口是本地上限与上游上限紧贴，未给 JSON 封装留余量。

## 2. 目标与非目标

目标：

- 在发布前使保留 HTML 总量不超过 8.5 MiB，按 `createdAt` 最旧优先剪枝。
- 保留既有 7 天 TTL 与 100 份上限，三个条件任一命中都能剪枝。
- 用至少 20 份重报告的回归证明保留集不再长到危险区。

非目标：

- 不改 Vercel 的“全集重部署”托管模型。
- 不新增定时器、配置开关、依赖或缓存格式。
- 不改单报告 512 KiB 边界、Discord 投递或 proofshot 流程。

## 3. 决策梯子

| 选项 | 收益 | 代价 | 结论 |
|---|---|---|---|
| 保持现状 | 零改动 | 真实 502 会复发 | 不满足任务 |
| 把现有默认字节上限降到 8.5 MiB | 复用已有 `Buffer.byteLength` 和最旧优先剪枝，改动最小 | 仍是全集重部署 | **采用** |
| 按完整 JSON body 实时计算剪枝 | 更贴近上游协议 | registry 必须复制/依赖 deploy payload 形状，增加耦合 | 本故障不需要 |
| 改为增量上传 | 从根上去掉线性增长 | 现有 Vercel 部署“省略即下线”，需更换托管架构 | 超出小型修复范围 |

8.5 MiB = 8,912,896 bytes，即使按 10,000,000-byte 上游上限计算，也保留约 1.09 MB 给 JSON 字段、路径和转义。事故的 keyframe/base64 重报告形态下，这个余量覆盖已观测封装开销。

## 4. 实现前假设

1. Vercel 继续接收当前 `encoding: "utf-8"` 的 inline-file JSON 形状。
2. 8.5 MiB 是保守的本地 HTML 上限，不是对 Vercel 硬上限的重新定义。
3. 剪枝继续由 publish 动作惰性触发；没有发布时不为了提前下线而新增后台 timer。
4. 单份报告受 route 的 512 KiB 上限保护，因此“始终保留最新一份”不会突破 8.5 MiB。

## 5. 会过期的结论

| 结论 | as-of | 重核方法 |
|---|---|---|
| Vercel 部署是全集 JSON body，省略旧文件会使链接下线 | 2026-08-21 | 读 `packages/teamlead/src/bridge/vercel-deploy.ts` 和 FLY-203 spike 记录 |
| 默认本地字节上限为 10 MiB | 2026-08-21 | `rg "DEFAULT_RETENTION_BYTES" packages/teamlead/src/bridge/report-registry.ts` |
| 默认 TTL 为 7 天且在发布时剪枝 | 2026-08-21 | 读 `stagePublish()` 的 TTL pass 及对应测试 |
