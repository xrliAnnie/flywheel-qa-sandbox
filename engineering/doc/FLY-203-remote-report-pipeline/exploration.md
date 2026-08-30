# FLY-203 远程报告管线 — 探索
Issue: FLY-203 (https://linear.app/geoforge3d/issue/FLY-203/remote-report-pipeline-html-报告自动发布托管-discord-截图链接送达)
日期: 2026-08-30
基于: 无

## 目标与锁定范围

Annie 已拍板产品方向：HTML 托管是完整报告骨干，截图只作 Discord 预览；一条消息同时包含关键区截图和完整报告链接。本地生成与 `open` 流程保持不变，远程送达通过可关闭的增量命令叠加。实现必须满足不可猜 URL、项目频道解析、截图失败降级、敏感接口鉴权和真 Discord 手机视角验收。

本次运行不重新讨论产品方向。实现细节沿用已归档并经过四轮 Codex 设计评审的 FLY-203 方案，再以当前 worktree 为权威做差异审计。

## 现成件审计

### GEO-294：Vercel HTML 发布

- `packages/teamlead/src/bridge/publish-html-route.ts` 提供 512 KiB HTML 发布端点。
- `packages/teamlead/src/bridge/vercel-deploy.ts` 已包含 Vercel production deploy 和 READY 轮询。
- 固定 production alias 会覆盖旧文件，不满足多份报告长期共存；现有 `/api/publish-html` 还必须保持 byte-compatible。

### FLY-27：Bridge static

- Bridge 的静态能力是本机服务的窄端点，手机远程访问需要额外隧道和 Mac 常驻。
- 它适合作本地模板或回退，不适合作本 issue 的公网托管骨干。

### FLY-188 / GEO-151：visual capture

- `flywheel-comm visual-capture` 已提供 ProofShot 锁、端口选择和截图产物发现。
- 报告截图应针对已发布 URL，确保预览与手机打开的内容一致。
- 截图是增强路径；失败必须继续发送链接。

## 当前 worktree 差异审计

当前 `b5a175a7` 基线已包含归档计划中定义的完整实现：

- `packages/flywheel-comm/src/commands/publish-report.ts`：publish → ProofShot → deliver 的 CLI 编排、单行 JSON envelope、两级截图降级和双侧 kill switch 客户端部分。
- `packages/teamlead/src/bridge/report-registry.ts`：128-bit token、随机 Vercel 项目名、累积重部署、7 天/100 份/10 MiB retention、noindex 与 CSP、stage/deploy/commit 事务。
- `packages/teamlead/src/bridge/reports-route.ts`：发布与 Discord 投递、项目频道 fallback、受限 preview root、fd-pinned PNG 校验。
- `packages/teamlead/src/bridge/discord-post-file.ts`：Discord multipart 单消息附件。
- `packages/teamlead/src/bridge/plugin.ts`：`/api/reports` 的 fail-closed token mount 和服务端 kill switch。
- 对应 registry、route、mount、Vercel reverse-compat、multipart 和 CLI 测试均已存在。

这说明当前任务不是从零实现。继续复制同一机制会制造重复接口和状态源。正确做法是按原始 acceptance criteria 逐项运行证据审计，先找真实缺口，再做最小 TDD 修复；若功能没有缺口，只提交本次 DAG 所需的过程/里程碑证据并把真 Discord 手机验收交给 QA 节点。

## 方案比较与选择

| 方案 | 隐私/可达性 | 多报告共存 | 运维面 | 结论 |
|---|---|---|---|---|
| 单 Vercel 项目 + 随机 token 路径 + 累积重部署 | 128-bit 不可猜，公网 HTTPS | registry 保留全量文件 | 复用现有 token 与部署 helper | 采用 |
| Bridge static + 隧道 | token 可做不可猜，但依赖 Mac/隧道 | 本地文件自然共存 | 增加公网暴露与常驻故障面 | 不采用 |
| 纯截图 | Discord 可见 | 无完整 HTML | 长报告手机不可读、不可交互 | Annie 已否决 |

## 验证边界

Implement 节点负责：聚焦测试、全仓 gate、markup/截图命令契约、代码评审、PR。独立 QA 节点负责：使用真 Vercel/Discord 凭据发布，确认一条消息、手机视角点击可达、错误 token 404、前一份链接在下一次发布后仍存活。Implement 节点不使用生产凭据模拟 QA，也不自行 dispatch QA。

