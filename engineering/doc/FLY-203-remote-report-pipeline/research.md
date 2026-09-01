# FLY-203 远程报告管线 — 调研
Issue: FLY-203 (https://linear.app/geoforge3d/issue/FLY-203/remote-report-pipeline-html-报告自动发布托管-discord-截图链接送达)
日期: 2026-08-30
基于: exploration.md

## 权威上游

- 原调研：`doc/engineer/research/archive/FLY-203-remote-report-pipeline.md`
- 四轮 Codex-approved 计划：`doc/engineer/plan/archive/v1.32.0-FLY-203-remote-report-pipeline.md`
- 使用说明：`doc/reference/remote-report-pipeline.md`
- 当前基线：`b5a175a7`

原调研已用真实 Vercel spike 证明：单项目的 production deploy 会替换文件集合；`r/<128-bit-token>/index.html` 可 inline 渲染，根路径和错误 token 返回 404，下一次部署必须重新携带仍在 retention 内的旧报告。因此 Vercel + 本地 registry + 累积重部署仍是已验证选择。

## 聚焦验证结果

依赖通过 `pnpm install --frozen-lockfile` 从锁文件安装。首次直接运行测试只暴露 fresh worktree 未构建内部 workspace package；`pnpm -r build` 后原命令不变地通过：

```text
packages/teamlead:
  report-registry.test.ts
  vercel-deploy.test.ts
  discord-post-file.test.ts
  reports-route.test.ts
  reports-route-mount.test.ts
  5 files / 89 tests PASS

packages/flywheel-comm:
  publish-report.test.ts
  1 file / 23 tests PASS
```

构建前失败属于可复现的 bootstrap 前置：`flywheel-config` package entry 和 `flywheel-comm/dist/index.js` 不存在。全仓 build 生成这些产物后全部 112 个聚焦测试通过，不需要修改产品代码或测试。

## Acceptance Criteria 证据矩阵

| AC | 当前证据 | 判定 |
|---|---|---|
| AC1 不可猜 | `report-registry.test.ts` 锁 16-byte token；`reports-route.test.ts` 锁随机域名与 32 hex 路径；原 Vercel spike 锁根/错 token 404 | code + spike 已证 |
| AC2 旧链接持久 | registry 第二次 stage 的 deployFiles 包含第一份报告 | unit 已证 |
| AC3 retention | count、bytes、7-day TTL、边界、abort 测试 | unit 已证 |
| AC4 一条 Discord 消息 | screenshot 路径只调用一次 multipart helper；消息含标题和链接，无 text fallback 第二条；`allowed_mentions.parse=[]` | unit/integration 已证 |
| AC5 截图降级 | ProofShot 两倍率失败后 deliver body 不带 screenshot，仍返回 delivered=true | CLI unit 已证 |
| AC6 双侧开关 | CLI 零网络 no-op；router/mount 返回 503 | unit/integration 已证 |
| AC7 缺配置 | Vercel/bot/channel/token 分别 501/501/400/503，坏 token 401 | integration 已证 |
| AC8 失败不伤旧报告 | stage 零写、deploy abort 零写、commit point 前失败保持旧 registry 和待 prune 文件 | real-fs unit 已证 |
| AC9 preview 安全 | absolute/relative/traversal/sibling/symlink/FIFO/fake PNG/oversize/root/missing 攻击矩阵；fd-pinned read | real-fs unit 已证 |
| AC10 byte-compat | `deployToVercel` reverse-compat sentinel；`/api/publish-html` 未改 | focused + later full gate |
| AC11 真 Discord 手机验收 | 需要真 Vercel token、Discord bot/channel、手机视角点击 | implement 不可宣称；QA 节点硬门 |

## 数据流与失败语义

1. CLI 读取完整 HTML，限制 512 KiB；kill switch 时不发网络请求。
2. Bridge 在内存 `stagePublish`：生成随机 token、注入 noindex/CSP、计算 retention、构造所有在保文件。
3. Vercel deploy 成功后才 commit 本地文件与 registry；deploy 失败 abort 零落盘。
4. CLI 用 ProofShot 对已发布 URL 做全页截图，2x 失败或超过 25 MiB时退 1x，再失败退纯链接。
5. Bridge 将专用 previews root 内经 fd-pinned 校验的 PNG 与链接作为一条 Discord multipart 消息发送；显式 channel 优先，否则项目 `generalChannel`，均缺失时拒绝猜测。
6. publish 成功但 deliver 失败时 CLI 以 exit 1 返回仍含 URL 的单行 JSON，允许人工转发，不静默丢失已发布产物。

## 当前差距

没有发现与 FLY-203 acceptance criteria 冲突的产品代码缺口。一个可验证的文档缺口是 `doc/reference/remote-report-pipeline.md` 的 Plan 链接仍指向已不存在的 `doc/engineer/plan/inprogress/...`，而实际计划已经归档到 `doc/engineer/plan/archive/...`。本次 implement 应只修复该链接、跑完整 gates 和代码评审；不要为制造代码 diff 重写已存在且测试完整的管线。

## QA 交接要求

独立 QA 必须使用受控测试凭据完成：

1. 真发布完整 HTML，确认 URL 为随机域名 + 32 hex token 路径且 200 inline。
2. 确认目标 Discord 仅出现一条带 PNG + 链接的消息，手机视角首次点击打开完整版。
3. 确认根路径与错误 token 404。
4. 再发布一份并确认第一份在 retention 内仍可达。
5. 关闭 `FLYWHEEL_REMOTE_REPORTS` 后分别验证 CLI no-op 与 Bridge 503。
