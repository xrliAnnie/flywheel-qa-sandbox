# FLY-2484 Epic 审计网关 — 部署步骤
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: capacity-ruling.md

本文件供 Lead 部署执行；implement 未部署。Lead 在 ffb7ac65-d355-44b7-b42a-e8e513197928 裁定顺序：PR 合入 → Lead 部署网关并探路由 → 12:00 PT updater 带入渲染器 → 发布器探针通过才替换固定页。网关未准备好时旧 HTML 保留。

## 当前事实与入口

本轮只读 `/Users/xiaorongli/.flywheel/reports/registry.json` 核实：项目 `fw-reports-a53de2`，provider `vercel-blob`，原迁移时间 `2026-09-04T07:32:46.168Z`，deployment `dpl_ARb5ets4sugAF6MTbjPrKQ6QiGtr`。实际部署时重新核 registry，不能依赖这个快照。

仓库已有 `pnpm migrate:report-hosting` → `scripts/migrate-report-hosting.ts`。它要求 `VERCEL_TOKEN`、`BLOB_READ_WRITE_TOKEN`，默认 reports 目录 `~/.flywheel/reports`，可用 `FLYWHEEL_REPORTS_DIR` 覆盖。Vercel 项目 production 环境必须绑定 `BLOB_READ_WRITE_TOKEN`；`assertGatewayBlobEnvironment` 查项目 env **键名/target**，不打印密钥。

该入口不是升级命令：`migrateReportHosting` 遇到 `hosting.provider === vercel-blob` 立即返回。本项目已迁移，直接重跑会 no-op。未找到现成“仅重部署已有网关”的 CLI。下面命令根据已有 `buildReportGatewayFiles` / `assertGatewayBlobEnvironment` / `deployFilesToVercel` 导出函数组装，已核对源码，**部署执行未验证**；不要为了复用迁移命令删除 hosting 标记或重新上传固定页。

## Lead 执行命令（未执行）

在已合入本 PR 的 Flywheel checkout 中运行，确保 shell 已安全注入上述环境变量。先构建（避免读取旧 dist）：

```sh
pnpm -r build
```

再通过已有部署 helper 更新同一个 production 项目。此命令只部署 gateway，不上传 HTML，不改 registry 的原迁移时间。迁移前旧报告的创建时间继续冻结；迁移后对象使用 Blob uploadedAt。固定页刷新后不应被重新冻结时间。

```sh
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildReportGatewayFiles, assertGatewayBlobEnvironment } from "./packages/teamlead/dist/bridge/report-hosting-migration.js";
import { deployFilesToVercel } from "./packages/teamlead/dist/bridge/vercel-deploy.js";
const reportsDir = process.env.FLYWHEEL_REPORTS_DIR || join(homedir(), ".flywheel/reports");
const registry = JSON.parse(readFileSync(join(reportsDir, "registry.json"), "utf8"));
const token = process.env.VERCEL_TOKEN;
if (!token || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Required deployment environment missing");
if (registry.hosting?.provider !== "vercel-blob") throw new Error("Use the original migration flow for an unmigrated registry");
const cutover = Date.parse(registry.hosting.migratedAt);
if (!Number.isFinite(cutover)) throw new Error("Invalid original migration timestamp");
const migrated = Object.fromEntries(registry.reports.filter(r => Date.parse(r.createdAt) <= cutover).map(r => [r.token, r.createdAt]));
const read = path => readFileSync(path, "utf8");
const version = JSON.parse(read("./packages/teamlead/package.json")).dependencies["@vercel/blob"];
const files = buildReportGatewayFiles(migrated,
  read("./packages/teamlead/dist/bridge/report-gateway-runtime.js"),
  read("./packages/flywheel-comm/dist/report-html.js"),
  read("./packages/teamlead/dist/bridge/report-retention.js"), version);
await assertGatewayBlobEnvironment(token, registry.vercelProjectName);
const result = await deployFilesToVercel(token, registry.vercelProjectName, files, 300000);
console.log(JSON.stringify({project:registry.vercelProjectName, ...result}));
JS
```

helper 内部走 Vercel deployments API，`target: production`，5 分钟部署超时。保留输出 deployment id 作为 Lead 部署回执。不要打印 token，不要为此重启 Bridge/Lead。

## 探测与回退

新 rewrite：`/r/:token/:audit/index.audit.json` → `/api/report?token=:token&audit=:audit`。token 必须 32 位小写 hex，audit 必须 64 位小写 hex；响应必须 200、`application/json`、`nosniff` 且正文 SHA-256 等于路径 hash。

部署后先检查非法 hash 为 404，再使用一次合法审计上传的 token/hash 探真实 JSON 路径。发布器会在 audit 上传后自行 GET 并验证正文 hash，失败不覆盖 HTML；不要仅用旧 HTML 路由的 200 作为新路由证明。记录 HTML 与 audit 的字节、hash、状态码与部署 id。没有 Vercel preview 的本分支记：**网关路由真机未验，Lead 部署后补验**，不伪造已验证回执。

若部署或探针失败，保留旧 HTML。若需要回滚网关，Lead 使用上次已验证 deployment 的 Vercel 回退机制；该回退命令未在仓库找到、未在本轮验证。审计上传失败、网关探测失败、HTML 上传失败均不得推进 publication version。刷新成功仅保留当前与上一审计版本，14 天报告清理覆盖 hash 子目录。
