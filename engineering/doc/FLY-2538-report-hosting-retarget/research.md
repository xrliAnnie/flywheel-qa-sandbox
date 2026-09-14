# FLY-2538 报告托管账号轮换 — 调研
Issue: FLY-2538 (https://linear.app/geoforge3d/issue/FLY-2538/报告托管-vercel-账号轮换做成一条命令migratereport-hosting-retarget-凭据热切换-报告用量削减-水位告警)
日期: 2026-09-13
基于: exploration.md

## 1. 代码地图(要改与要读的每一处)

| 文件 | 现状(行号为 2026-09-13 main `26ebc4931`) | 本单动作 |
|---|---|---|
| `scripts/migrate-report-hosting.ts` | 73 行;只读 `VERCEL_TOKEN`/`BLOB_READ_WRITE_TOKEN` 进程 env;构造 registry+store 后调 `migrateReportHosting`;`main().catch` 吞错只打一行 | 加子模式 `--retarget` / `--deploy-gateway-only` / `--usage-check`;无参路径字节不变;错误打印原因(不含 token) |
| `packages/teamlead/src/bridge/report-hosting-migration.ts` | `migrateReportHosting` L165-226:标记已是 `vercel-blob` 即 return;`assertGatewayBlobEnvironment` L27-56 查项目 env 键名+production target;`buildReportGatewayFiles` L58-119 组网关 7 个文件并断言本地 import 可解析 | 新增 `retargetReportHosting()` 与 `deployReportGatewayOnly()`,复用三个导出;不改 `migrateReportHosting` |
| 新 `packages/teamlead/src/bridge/vercel-hosting-api.ts` | 不存在 | 薄 API client:`ensureProject`、`ensureBlobStore`、`connectStore`、`readBlobTokenFromProjectEnv`、`getStore`、`deleteBlobStore`(仅错建回收);全部接 `fetch` seam 与可选 `slug` |
| 新 `packages/teamlead/src/bridge/report-hosting-credentials.ts` | 不存在 | call-time 凭据解析:读 `${FLYWHEEL_STATE_DIR:-~/.flywheel}/.env` 两个键,mtime+size 缓存,回落 `process.env` |
| `packages/teamlead/src/bridge/report-blob-store.ts` | 构造 `token: string` 冻结;`putObject` L279-311 校验返回 URL 为 `*.private.blob.vercel-storage.com`;`deleteReports` L206-217 每个 token `auditPaths()` list 一次;`putEpicPage` L108-170 get 回读旧页 + put audit + 探针 + put html + list 清理 | 构造改接 token resolver;`putReport/putEpicPage/putMigratedReport` gzip;`deleteReports` 去掉 per-token list;`putEpicPage` 回读时识别 gzip;新增 `headReportSize(token)`(QA C 证据) |
| `packages/teamlead/src/bridge/report-gateway-runtime.ts` | `deps.get` 读流 → `text()` 提 CSP → 200;Node handler L176-198 只把 URL 塞进 `Request`,丢了请求头 | 缓冲字节;`1f 8b` 判 gzip → gunzip(`maxOutputLength` 上限)提 CSP;按 `Accept-Encoding` 透传 gzip 或回明文;Node handler 透传 headers |
| `packages/teamlead/src/bridge/report-registry.ts` | `ReportHostingState` L253-257 三字段;`ReportEntry` L245-251;`stageReport` L390-490;`markHostingMigrated` L344-353 要求已有项目名 | `ReportHostingState` 追加可选 `storeId`、`retargetedFrom`;`ReportEntry` 追加可选 `sourceSha256`;新增 `findRetainedBySourceSha256(sha, maxAgeMs)`、`commitRetarget({vercelProjectName, hosting})`(原子改名+标记) |
| `packages/teamlead/src/bridge/reports-route.ts` | `/publish` L252-419;成功日志 L402-404;响应 `{url, reportId}` | store 绑定守卫(503);成功日志追加 `store=<host 首段>`;`blobStore` 与 `vercelToken` 改凭据快照(R1:去重已删) |
| `packages/teamlead/src/bridge/publish-html-route.ts` | `createPublishHtmlRouter(vercelToken: string | undefined)` | 改接 `() => string | undefined`,调用点 `plugin.ts` L4824 同步 |
| `packages/teamlead/src/bridge/plugin.ts` | L6291-6303 启动读两键、建 store;L6383-6399 每小时 sweep;L4841-4850 reports router;L7971 传 `vercelToken` | 两键改 resolver;sweep 改 24 h 且 tick 内挂水位日检;`opts.vercelToken` 类型改 resolver |
| `packages/teamlead/src/bridge/epic-page-publisher.ts` | `publishHosted` L52-146:reserve → render → stage → put → commit → publication | render 后算 `hostedContentDigest`;与 `publication.last_content_digest` 相等且 `last_published_at` < 24 h ⇒ 返回 `ok_unpublished:vN:unchanged_digest`;commit 时写 digest |
| `packages/teamlead/src/epic-page/model.ts` | `stripTimestamps` L1382-1399 去三键;`contentDigest` L1401 含 `freshness` | 新增 `hostedContentDigest(page)` |
| `packages/teamlead/src/StateStore.ts` | `epic_page_publication` L7369-7379 五列;`commitEpicPagePublication` L11971-12002;`getEpicPagePublication` L12004-12023;`addColumnIfMissing` L4147-4154 | 迁移加 `last_content_digest TEXT`;commit 入参加 `contentDigest`;read 返回 `last_content_digest` |
| `packages/teamlead/src/bridge/epic-page-refresher.ts` | outcome 联合类型 L130-146 | 加 `ok_unpublished:${n}:unchanged_digest` 分支(账本行照写) |
| `packages/teamlead/src/bridge/notify-receipts.ts` | 只有 `token_report` 键 | 加 `report_hosting_usage` 键与 `writeReportHostingUsageReceipt` |
| 新 `packages/teamlead/src/bridge/report-hosting-usage.ts` | 不存在 | 日检:读 store → 判阈值 → 发通知 → 回执;纯函数 + 注入 seams |
| `doc/reference/remote-report-pipeline.md` | 运行手册只有首次迁移 | 加「账号轮换运行手册」「gzip 上线顺序」「水位通知」 |

只读消费者(确认不受影响):`report-url.ts`(只看 `provider`)、`epic-page-route.ts` L164-178(`reportUrlForToken`)、`strength-two-evidence-route.ts` L280-282(项目名函数)、`epic-page-publisher.ts` L58(`provider`)。hosting 标记只追加字段,四处 `hosting()?.provider === "vercel-blob"` 判定不变。

## 2. Vercel 侧合同(已核对文档/CLI 源码/Lead 实测)

| 步骤 | 调用 | 幂等判据 | 失败形态 |
|---|---|---|---|
| 项目 | `GET /v9/projects/{name}` → 404 则 `POST /v11/projects {name, framework:null}` | 200 即存在 | 重名 409(别名全局,必须新 6hex);403 = token 作用域错 |
| store | `POST /v1/storage/stores/blob {name, region, access:"private"}` → `store.id` | journal 有 `storeId` 或项目 env 已有 `BLOB_READ_WRITE_TOKEN`(`contentHint.storeId`)⇒ 跳过 | 409 重名(API 无 list,只能换 `--store-name`);`usage_threshold_limits_reached` = 账号本身打满,命令直接失败并提示换账号;响应 `access !== "private"` ⇒ `DELETE /v1/storage/stores/blob/{id}` 后失败(不静默用 public) |
| 连接 | `POST /v1/storage/stores/{storeId}/connections {projectId, envVarEnvironments:["production","preview","development"], type:"integration"}` | 项目 env 已有该键且 `contentHint.storeId === storeId` ⇒ 跳过 | 非 2xx 直接失败,journal 保留 storeId |
| 取 token | `--blob-token-env` 有值优先;否则 `GET /v10/projects/{id}/env` 找 key 且 target 含 production → `GET /v9/projects/{id}/env/{envId}?decrypt=true` 取 `.value` | 值前缀 `vercel_blob_rw_` 且 SDK 上传返回的 URL 主机首段 = store 主机 | `type=sensitive`/`decrypted=false` ⇒ 报「请从 dashboard 复制到环境变量 `<NAME>` 后重跑」 |
| 网关 env 校验 | 现有 `assertGatewayBlobEnvironment` | — | 现有语义 |
| 搬报告 | `putMigratedReport`(allowOverwrite)逐 token | journal `uploaded[]` 含 token ⇒ 跳过 | 单个失败即停,journal 已记成功者;重跑续传 |
| 网关 | 现有 `buildReportGatewayFiles` + `deployFilesToVercel`(5 min 轮询) | registry `hosting.gatewayDeploymentId` 且 `vercelProjectName` 已是目标 ⇒ 跳过 | READY 以外失败,不写标记 |
| 验证 | `GET https://<name>.vercel.app/r/<token>/` ×3 → 200 + `Content-Security-Policy` 头;伪 token → 404 | — | 不过则不写标记 |
| 标记 | `registry.commitRetarget()`:先写 `registry.json.bak-<epoch>`,再原子 rename | 已是目标 + 已有 `storeId` ⇒ no-op | — |

团队作用域:R1 后不提供 scope 参数;所有调用走 token 默认作用域(Lead 实测即新 Hobby team)。`GET /v1/storage/stores/{id}` 返回 `size`(bytes)、`count`、`usageQuotaExceeded`、`status`;文档 `GET /storage/stores/{id}` 未标版本号,Lead 实测与 CLI 源码均走 `/v1/` 前缀,client 统一用 `/v1/`。

## 3. gzip 形态核对

- `@vercel/blob@2.8.0` `put(pathname, body: PutBody, options)`:`PutBody` 接受 `Buffer`;选项无 `contentEncoding`。因此以**字节内容**表达压缩,pathname/contentType 不变,靠 magic bytes 识别。
- 网关侧 `deps.get` 返回 `stream` + `blob.size`;Vercel Node 函数运行时是 Node 20+,`node:zlib` 的 `gunzipSync(buf, {maxOutputLength})` 可用;网关文件是 dist 的单文件 JS,`buildReportGatewayFiles` 的 import 断言只查 `./` 相对导入,`node:zlib` 属内建不受影响。
- Vercel CDN 不自动压缩 `text/html`(白名单无 html),所以网关必须自己按 `Accept-Encoding` 出 `Content-Encoding: gzip`;`reportGatewayNodeHandler` 现在丢请求头,要把 `accept-encoding` 带进 Web `Request`。
- 兼容:迁移期两种对象并存(旧明文 / 新 gzip),网关按 magic 分流;`putEpicPage` 回读旧页取 `data-previous-audit` 也按 magic 分流。
- 预期压缩率:本机对 registry 里 5 份代表性 HTML 用 `gzip -9` 抽样(implement 阶段在 QA 报告落实数):文本 HTML 通常 70–85%;QA C 阈值 60% 有余量。
- 回滚顺序:网关先支持双格式再让 Bridge 压缩;回滚只回退 Bridge(重新明文 put),网关不用动。

## 4. Epic 页 digest 分析

| 候选 | 为什么不行 / 行 |
|---|---|
| `epic_page.source_digest`(`receipt.sources` digest) | `sources[i].observed_at` 每 scan 变 |
| `contentDigest(page)` = `stripTimestamps(page)` | 去了 `observed_at/source_updated_at/generated_at`,但 `page.freshness.*.value.version`、`next_scan`、`current` 每版都变 |
| 渲染后 HTML sha256 | 含 `v927 · scan` 与相对时间文本 |
| **`hostedContentDigest(page)`(选)** | `stripTimestamps(page)` 后删除顶层 `freshness`,再递归删除键名为 `version` 的叶子;剩下 header/items/attention/lead_note/signals/stuck_items 全是内容 |

钉住的测试:同一 mock Linear 快照 + 同 StateStore 事实,`now` 与 `version` 不同,两次 `materialize` 的 `hostedContentDigest` 相等;改一个子单 state 或加一条 lead note,digest 变;`freshness` 任意变化不影响 digest。

跳过规则:`publication.last_content_digest === digest` **且** `now - last_published_at < 24 h` ⇒ 跳过。保活 24 h 来自 FLY-2143 G4「保留期从最后一次成功刷新起算」,托管页 TTL 14 天,24 h 留 13 天余量;同时保证页面上 `freshness` 显示至多落后一天。

账本:跳过时仍写 `epic_page_refresh` 一行 `ok_unpublished:vN:unchanged_digest`(`refresher.ts` outcome 联合类型加一支);`epic_page` 版本照常插入(status 的 `last_generated` 前进,`last_published` 不前进 —— 这是既有语义,status 路由不用改)。

## 5. 去重(③)细节 —— R1 修订:已从本单删除(违反 FLY-2283 14 天合同;529 loopback 重启后 404)。以下保留作历史。

- digest 对象 = `/publish` 请求体 `html` 原文(hardening 前),`sha256` hex,存 `ReportEntry.sourceSha256`。
- 命中条件:同 `projectName`、`sourceSha256` 相等、`createdAt` ≤ 7 天、entry 仍在 registry(即未过期)。
- 命中返回既有 `token` 的 URL,`reportId` = 既有 token,`deduplicated: true`;不 stage、不 put、不改 registry。
- 去重发生在 critical section 内(与 stage 同一段),避免两个相同 HTML 并发都 miss。
- 不命中:正常路径,commit 时把 `sourceSha256` 写进 entry。旧 entry 无该字段,自然不参与。
- Epic 页(`stageEpicPageRepublish`)不走去重(它有自己的 digest 规则)。

## 6. 水位日检细节

- 触发:挂在 `plugin.ts` sweep 定时器(改为 24 h 一次,启动时立即一次)。每次 tick:`resolveFounderTimezone()` 算今天 `YYYY-MM-DD`;回执 `report_hosting_usage.date === today && phase === "sent"|"checked"` ⇒ 跳过;`phase === "attempting"` 且 `attemptedAt` 距今 < 30 min ⇒ 跳过。
- 数据:`hosting.storeId` 缺失 ⇒ 记一次警告日志后跳过(不猜 id);`VERCEL_TOKEN`(call-time)缺失 ⇒ 同样跳过;`GET /v1/storage/stores/{storeId}` 非 200 ⇒ 记警告,回执写 `checked` + `error`(当天不再打 API)。
- 判定:`pct = size / 1_000_000_000`;`alert = pct ≥ 0.8 || usageQuotaExceeded || status.startsWith("limits-exceeded")`。1 GB 取十进制常量,偏保守。
- 发送:`postDiscordMessageToChannel(FLYWHEEL_NOTIFY_CHANNEL, text, infraSenderTokenOr(globalBotToken), {origin:"automation"})`;正文固定模板(见 plan);写回执顺序 `attempting → 发送 → sent`。
- 不发:写 `checked`(含 pct),同日不再查。
- 不改任何 alert kind 白名单;不新增 env(`FLYWHEEL_NOTIFY_CHANNEL` 已存在,缺失时跳过并警告一次)。

## 7. 热读凭据细节

- 路径:`${process.env.FLYWHEEL_STATE_DIR?.trim() || ~/.flywheel}/.env`(与 `bridge-exit-marker.ts` L60 同一解析)。
- 解析:`readEnvValueFromContent(content, key)`(取最后一次赋值,支持 `export` 前缀),再剥一层成对的 `"`/`'`。
- 缓存:`statSync` 的 `mtimeMs + size` 变了才重读;失败(ENOENT/EACCES)⇒ `unavailable`,回落 `process.env[key]`,并只在状态从 readable→unavailable 变化时 warn 一次。
- 值语义:`trim()` 后空 ⇒ `undefined`(与现在 501 语义一致)。
- 529 slot:`FLYWHEEL_STATE_DIR` 指向 slot 根,slot `.env` 无这两键 ⇒ 回落进程 env(契约里 `VERCEL_TOKEN` 是 clear)⇒ 行为不变。
- 观测:publish 成功日志加 `store=<upload URL 主机首段>`、`credentialSource=file|process`。

## 8. 现有测试面(要扩展的文件与当前用例数)

| 文件 | 现 `it(` 数 | 新增覆盖 |
|---|---|---|
| `report-hosting-migration.test.ts` | 18 | retarget 全流程 / 每步幂等 / journal 续传 / public store 拒收并删 / sensitive env 拒 / 验证 404 不写标记 / no-op 重跑零远端调用 |
| `report-blob-store.test.ts` | 8 | gzip 字节与 magic / 回读 gzip 旧页 / `deleteReports` 不再 list / resolver 换 token 生效 |
| `report-gateway-runtime.test.ts` | 13 | gzip 对象按 Accept-Encoding 透传或解压 / 明文对象照旧 / 解压上限 502 / headers 透传 |
| `report-registry.test.ts` | 74 | `sourceSha256` 写入与查找 / `commitRetarget` 原子与备份 / 标记追加字段不破坏 `hosting()` |
| `reports-route.test.ts` | 50 | store 绑定守卫 503 / 一致 200 / 凭据快照切换生效 |
| `epic-page-publisher.test.ts` | — | digest 相等 24 h 内跳过 / 24 h 后保活重传 / digest 变化重传并写新 digest / NULL digest 永不跳过 |
| 新 `report-hosting-credentials.test.ts` | — | 文件优先 / 缺键回落 / mtime 变更重读 / 不可读回落且 warn 一次 |
| 新 `report-hosting-usage.test.ts` | — | 80% 发 / 79% 不发 / 同日不重复 / attempting 30 min 内不重试 / status suspended 立发 / storeId 缺失跳过 |
| 新 `vercel-hosting-api.test.ts` | — | 每个端点的路径、body、slug 透传、错误映射 |
| `StateStore` 测试 | — | `last_content_digest` 迁移幂等 + commit/read 往返 |

运行约束(FLY-2538 worktree):`pnpm install --offline` + `pnpm -r --filter "flywheel-teamlead^..." build` 后再 `vitest`;排除 `**/tmux-viewer.macos.test.ts`。

## 9. 数量级(供 plan 的验收阈值)

- 当前:Epic ≈ 60 次/天 × (put audit + put html + list + get 回读 ≤ 0.5 MB) ;报告 ≈ 37 次/天 × 87 KB;sweep 24 list/天。
- 之后:Epic ≤ 内容变化次数(数次/天)+ 每日 1 次保活;sweep 1 list/天;报告 put 数不变但字节 −60% 以上。
- QA 判据用可测量的局部量:C(单份字节 −60%)、D(两次 scan 第二次 put 数为 0)、E(阈值行为);「月用量 1/3」作为设计目标写在 plan 目标段,不作为 QA 硬门。

## 10. 修订记录

- R1:补充事实——`@vercel/blob` 内部 `parseStoreIdFromReadWriteToken(token) = token.split("_")[3]`,`normalizeStoreId` 去 `store_` 前缀;`StateStore.parseEpicPageRefreshOutcome` L2225 用正则白名单,新增 outcome 必须同步;`redactSecrets`(`apply-child-evidence.ts`)只覆盖少数形态,不能作为「输出不含 token」的唯一防线;`/api/publish-html` 用同一 `VERCEL_TOKEN` 部署 `triage-<project>`。对应设计变更见 exploration §7 与 plan v2。
