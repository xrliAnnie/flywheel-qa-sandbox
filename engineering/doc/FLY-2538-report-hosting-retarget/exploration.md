# FLY-2538 报告托管账号轮换 — 探索
Issue: FLY-2538 (https://linear.app/geoforge3d/issue/FLY-2538/报告托管-vercel-账号轮换做成一条命令migratereport-hosting-retarget-凭据热切换-报告用量削减-水位告警)
日期: 2026-09-13
基于: 无

## 0. 一句话

把 2026-09-13 Lead 手工做的 8 步账号切换固化成一条幂等命令,让 Bridge 不重启就能换 Vercel/Blob 凭据,把每月 Blob 用量压到当前 1/3 以下,并在 Blob 存储水位到 80% 时提前一天在 #flywheel-notification 说一声。

## 1. 现场事实(2026-09-13 只读核实)

| 事实 | 来源 |
|---|---|
| registry 现为 `fw-reports-624a39`,`hosting.provider=vercel-blob`,`migratedAt=2026-09-13T21:25:07Z`,deployment `dpl_6Zv8g4CeWZLfF9JgZxebs1aNFpc1` | `~/.flywheel/reports/registry.json` |
| 523 份保留期报告,原文合计 45,607,578 B(≈45.6 MB),最大 474 KB,最小 351 B;513 份属 `flywheel` | 同上 |
| 备份 `registry.json.bak-1786552268`:旧项目 `fw-reports-a53de2`,无 hosting 标记,100 条 —— 手工切换是「删标记 → 改项目名 → 重跑 migrate」 | 同上 |
| Bridge 日志里故障期间只有 22 行 `[reports] blob upload failed`,不含凭据,不含 Vercel 错误码 | `/tmp/flywheel-bridge.log.{1,2,3}` |
| Epic 固定页(`flywheel`,token `839a6338…`,v927)每天 29–85 次成功重发;9-13 有 34 次 `transient: publish_failed` | `teamlead.db` 只读副本 `epic_page_refresh` |
| 每次 Epic 重发 = `get`(读旧页,simple op)+ `put` audit + `put` html + `list`(清理旧 audit)= 3 次 advanced op;每小时 sweep 再 `list` 一次 | `report-blob-store.ts` `putEpicPage` / `plugin.ts` L6383-6399 |
| 普通报告 publish = 1 次 `put`;每份都是独立 private 对象 `r/<token>/index.html`,`cacheControlMaxAge: 60` | `report-blob-store.ts` |
| Bridge 进程 env 在 launchd wrapper 里 `set -a; source ~/.flywheel/.env` 一次性注入,进程内无 reload | `scripts/flywheel-bridge-wrapper.sh` L32-48 |
| `VERCEL_TOKEN` / `BLOB_READ_WRITE_TOKEN` 在 `plugin.ts` L6291/L6295 启动时读一次;`VercelBlobReportStore` 构造时冻结 token | `plugin.ts` |
| Hobby Blob 免费额度:存储 1 GB、传输 10 GB/月、操作 100 万/月;超限后 Blob 不可用,等 30 天;新建 store 也会被 `usage_threshold_limits_reached` 拒 | Vercel 文档 `vercel-blob/usage-and-pricing`、`plans/hobby`、社区帖 |
| Vercel CDN 自动压缩白名单里**没有 `text/html`**;函数响应要自己压 | `docs/how-vercel-cdn-works/compression` |
| `@vercel/blob@2.8.0` 的 `put` 选项没有 `contentEncoding`(只有 contentType / cacheControlMaxAge / addRandomSuffix / allowOverwrite / access / multipart);`get` 返回 `{statusCode, stream, headers, blob:{size, uploadedAt, etag}}`;`list` 每条带 `size` | `node_modules/.pnpm/@vercel+blob@2.8.0/…/index.d.ts` |
| Store API:`POST /v1/storage/stores/blob {name, region?, access, projectId?}`;`GET /v1/storage/stores/{id}` 返回 `size / count / usageQuotaExceeded / status(available|limits-exceeded-suspended|…)`;连接项目 `POST /v1/storage/stores/{storeId}/connections {projectId, envVarEnvironments, type:"integration"}`(Vercel CLI 源码);项目创建 `POST /v11/projects {name}`,重名 409;项目 env `GET /v10/projects/{idOrName}/env?decrypt=true`,`sensitive` 类型拿不到值 | Vercel REST 文档 + `vercel/vercel` CLI 源码 |
| 现有 `pnpm migrate:report-hosting` 遇到 `hosting.provider === vercel-blob` 直接 return;没有「换项目重迁」入口,FLY-2484 当时靠一段临时 node 脚本重部署网关 | `report-hosting-migration.ts` L167、`FLY-2484/gateway-deploy.md` |
| 通知频道 `FLYWHEEL_NOTIFY_CHANNEL` 已在 `.env`;quota 切换确认类告警走 `lead-alert.sh --plain-message` + `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 覆盖到该频道;token 日报走 `/api/reports/deliver` 直发 + `notify-receipts.json` 按日回执 | `quota-monitor-alert.ts`、`notify-receipts.ts` |
| 新增一个 alert kind 要改 7 处(`LeadAlertNotifier` 联合类型 + `INFORMATIONAL_KINDS`、`kind-contract`、`alert-kind-copy` ×2、`infra-event-router`、`lead-alert.sh` ×2) | grep `flag_scan_failed` |

## 2. 用量到底红在哪一行(未决,已问 Lead)

Issue 用「519 份/14 天 ≈ 44MB 原文」推算,隐含红线是存储或传输。但从代码看三条表都可能:

- **存储**:45 MB ≪ 1 GB,除非计费口径是「月均 GB-月」之外还有别的,存储不该先红。
- **操作**:Epic 页每天最多 85×3 ≈ 255 次 advanced op + 24 次 sweep list,加报告 put ≈ 40/天,月度 ≈ 9–10K,远低于 100 万。
- **传输**:每次网关读 = 全量下载(`useCache: false`,MISS),Epic 页每次重发还要 `get` 回读旧页(≤512 KB);Discord 每条报告链接会被 unfurl 抓取;这些都记 Blob Data Transfer。10 GB/月 ≈ 每天 330 MB,是三条里最容易被「读」打穿的。

**设计立场**:不赌某一行。gzip 同时降存储与传输;Epic 页 digest 不变不重发同时降 put 与回读传输;去重降 put。水位告警只能读到 API 给的 `size / usageQuotaExceeded / status`,传输与操作计数 API 不暴露 —— 这是诚实边界,写进 plan §「不做什么」。

**Lead 裁定(2026-09-13,回答 ask 6dc334e9)**:
- 红线哪一行 dashboard 未看;API 只返回 `status=limits-exceeded-suspended` + `usageQuotaExceeded=true`,无分项。存储确定不是(519 份 / 44 MB)。**按 ops 为首要嫌疑、传输其次排优先级**:① Epic 固定页只在 digest 变化时重发;② 每小时 sweep list 改每日;③ gzip。
- 新账号 = personal Hobby team(`flywheel3`),手工全程**不带 teamId**,Full Account token 默认落到该 team。`--team-slug` 保持可选、默认不带。
- RW token 走 env 解密可行:`POST /v1/storage/stores/{store}/connections {projectId, envVarEnvironments:[production,preview,development]}` 后 `GET /v9/projects/{projectId}/env/{envId}?decrypt=true` 返回 `.value`;`makeEnvVarsSensitive` 未设。解密优先、`--blob-token-env` 回退。
- 两个坑必须写进命令:store 创建体必须 `{name, region, access:"private"}`(默认 public,`report-blob-store` 会拒非 private 上传 URL;建错用 `DELETE /v1/storage/stores/blob/{id}` 删);项目名必须是全新的 `fw-reports-<6hex>`(`.vercel.app` 别名全局唯一)。

## 3. 目标与非目标

**目标**
1. `pnpm migrate:report-hosting --retarget …` 一条命令、可重跑、每步幂等、失败从断点续,不改 `.env`,只打印要改的两个键名。
2. Bridge 改 `.env` 两行后 ≤ 60 s 内下一次 publish 就用新 store,不重启。
3. 月用量 ≤ 当前 1/3:gzip(HTML 60–80% 压缩)+ Epic 页内容不变不重传。(R1 修订:同内容去重已删除,见 §4.3 ③)
4. 每天读一次 store 水位,存储 ≥ 80% 或 `usageQuotaExceeded/status=limits-exceeded-*` 时,#flywheel-notification 发一条含「跑 retarget」指令的消息,同日不重复。

**非目标(founder 已拍板或本单不碰)**
- 不保留旧域名;不做双写/回源到旧账号;不迁 14 天以外的历史。
- 不改 `/api/reports/publish` / `deliver` 合同,不改 `publish-report` CLI 的 envelope。
- 不改 Simba 走的旧 `/api/publish-html` 部署形态(只把它的 `VERCEL_TOKEN` 读取改成 call-time)。
- 不把 Hobby 换 Pro;不做多账号自动轮换(founder 说「两个账号按月轮换」是人工节律,命令只负责一次切换)。
- 不新增 launchd 单元。env 键只新增一个 `REPORT_HOSTING_VERCEL_TOKEN`(R1 修订:`VERCEL_TOKEN` 与 Simba 的 `/api/publish-html` 共用,不能热切到新账号)。

## 4. 四条工作项的方案与取舍

### 4.1 `--retarget` 一条命令

**选项 A(选)**:在 `report-hosting-migration.ts` 旁新增 `retargetReportHosting()`,复用 `buildReportGatewayFiles` / `assertGatewayBlobEnvironment` / `deployFilesToVercel` / `putMigratedReport`,新增一层薄 Vercel API client(项目、store、连接、env 解密、store 水位)。CLI `scripts/migrate-report-hosting.ts` 加 `--retarget` 子模式,原无参路径字节不变。
**选项 B(拒)**:让 operator 手删 hosting 标记再跑旧命令 —— 这正是 9-13 手工路径,靠人记顺序,且旧命令不会建项目/store/连接/取 token,只覆盖 8 步里的 3 步。
**选项 C(拒)**:用 Vercel CLI(`vercel blob store add` / `vercel link`)串 shell —— 依赖交互式登录态和 `.vercel/` link 目录,与「不改 .env、幂等重跑」冲突。

**幂等与断点**:每一步先查再做(项目 GET→404 才 POST;store 用项目 env 里 `BLOB_READ_WRITE_TOKEN.contentHint.storeId` 判「已连接」;上传用本地 journal 记录已传 token;网关用 registry 标记里的 `gatewayDeploymentId`+项目名判「已部署」)。store 创建成功但连接失败的窗口用 write-ahead journal `~/.flywheel/reports/retarget.<project>.json` 兜住,重跑不会再 POST 一个重名 store 吃 409。

**凭据**:命令只接受**环境变量名**(`--vercel-token-env`、`--blob-token-env`),不接受值;不打印任何 token;完成时只打印「把 `.env` 里 `VERCEL_TOKEN` / `BLOB_READ_WRITE_TOKEN` 改成 `$<NAME>` 的值」两行提示。RW token 优先从 `--blob-token-env` 读;未给时尝试项目 env 解密;`sensitive` 拿不到就明确报错让 operator 从 dashboard 复制到该环境变量后重跑。

**团队作用域**:R1 修订后**不提供** `--team-slug`。既有 `assertGatewayBlobEnvironment`、`deployFilesToVercel` 都没有 scope 参数,半生效的选项比没有更糟;Lead 实测默认作用域就是新 Hobby team。

**切换窗口**:命令跑完到 operator 改 `.env` 之间,新报告仍发到旧 store。运行手册规定「跑 retarget → 改 .env → 再跑一次 retarget」,第二次只补传 journal 里没有的新 token(journal + registry diff),其余全 no-op。这也是 QA A「重跑一次 no-op」的形状。

### 4.2 凭据热切换

**选项 A(选)**:call-time 读 `${FLYWHEEL_STATE_DIR:-~/.flywheel}/.env` 里这两个键(复用 `packages/config/src/env-file.ts` 的 `readEnvValueFromContent`),按文件 mtime+size 缓存,文件里没有该键时回落 `process.env`(529 slot、单测、CI 都走回落)。`VercelBlobReportStore` 构造改为接 `() => string | undefined` 的 token resolver;sweep、publish、Epic publisher、水位检查、`/api/publish-html` 的 `VERCEL_TOKEN` 全部经 resolver。
**选项 B(拒)**:SIGHUP 重读 —— launchd `KeepAlive` 下信号语义要和 wrapper、restart-services 的 kill ledger 对齐,多一条运维路径。
**选项 C(拒)**:`POST /api/admin/reload-credentials` —— 端点要鉴权、要审计、要写 runbook,而 operator 反正要改 `.env`,读文件是最少的新面。

风险:Bridge 进程从此有一条「读 `.env` 文件」的路径。范围只限这两个键、只在 publish/sweep/水位检查时读、文件不可读时回落进程 env 并保持旧行为(不抛)。日志只记「凭据来源=file|process」和 store 主机名首段,不记值。

### 4.3 用量削减

**① gzip**:Bridge `put` 前 `zlib.gzipSync(html, {level: 9})`,pathname 不变仍是 `r/<token>/index.html`,contentType 不变;网关读回后看 magic bytes `1f 8b` 判压缩(旧对象仍是明文,两种同时可服务),gunzip 提 CSP,浏览器 `Accept-Encoding` 含 gzip 时原样透传 gzip 字节 + `Content-Encoding: gzip` + `Vary: Accept-Encoding`,否则回明文。不依赖 SDK 的 contentEncoding(2.8.0 没有)。选 gzip 不选 brotli:curl/QA 工具链和 `verify-report` 现成支持,压缩率差异对 60% 目标无关键影响。**上线顺序硬约束**:先部署新网关(旧网关看到二进制会 CSP 提取失败 502),再让 Bridge 开始 gzip put。为此 CLI 加 `--deploy-gateway-only`,顺手替掉 FLY-2484 那段临时脚本。

**② Epic 页 digest 不变不重发**:现有 `epic_page.source_digest` 是 `receipt.sources` 的 digest,里面每格都带 `observed_at`,每次 scan 都变,不能用。`model.ts` 的 `contentDigest(page)` 去掉了三个时间戳键,但 `page.freshness` 段含 version/next_scan,每版也变。新定义 `hostedContentDigest(page)` = `stripTimestamps(page)` 再剔除 `freshness` 段与所有 `version` 叶子后的 canonical digest;单测用「同一 Linear 快照、不同 now、不同 version 两次生成 digest 相等;改一个子单状态 digest 变」钉住。存到 `epic_page_publication.last_content_digest`(新 nullable 列)。相等 ⇒ 不 put,不 list,不 get,账本记 `ok_unpublished:vN:unchanged_digest`,publication 三个字段不前进。**但**托管页 TTL 从最后一次成功重传起算(FLY-2143 G4),所以加一条保活规则:`last_published_at` 距今 ≥ 24 h 时即使 digest 相等也重传一次。这样最坏每天 1 次而不是 85 次。

**③ 保留期内去重(R1 修订:已从本单删除)**:Codex R1 指出复用旧 token 违反 FLY-2283「每条链接从本次创建起完整可访问 14 天」,且 529 loopback host 重启后旧 token 直接 404。以下为原方案,保留作历史:`publish` 时对**输入 HTML**(hardening 与 nonce 之前)算 sha256,registry entry 新增 `sourceSha256`;命中保留期内、且创建 ≤ 7 天的同 digest entry ⇒ 直接返回既有 `{url, reportId}`,零远端调用。7 天上限是为了不让「复用旧 token」把有效期缩到不足一周。响应加 `deduplicated: true` 字段(新增字段,不破坏旧读者)。

**预估**:Epic 页从 ~60 次/天降到 ≤ 数次/天(只在内容变时),按字节算 Epic 是每天 60×(0.5 MB 写 + 0.5 MB 回读)≈ 60 MB → ≤ 数 MB;普通报告 45 MB/14 天 gzip 后 ≈ 12–15 MB;网关传输随 gzip 同比降。三项叠加落到 1/3 以下有余量,但**传输侧真实值依赖 Lead 回答的红线与浏览端阅读量**,plan 里以 QA C/D 的字节与 put 计数为验收,不以「月账单」为验收。

### 4.4 水位告警

**选项 A(选;R1 修订为小时级 tick + 按日回执去重 + failed 退避,见 plan C6)**:Bridge 内每日一次(挂在现有每小时 sweep tick 上,按 founder 时区日期判「今天查过没」),`GET /v1/storage/stores/{storeId}`(用 call-time `VERCEL_TOKEN`),`size ≥ 0.8 × 1e9` 或 `usageQuotaExceeded` 或 `status` 以 `limits-exceeded` 开头 ⇒ 用 infra 发件身份直发 `FLYWHEEL_NOTIFY_CHANNEL` 一条,正文带 `pnpm migrate:report-hosting --retarget …` 指令;回执写 `notify-receipts.json` 新键 `report_hosting_usage`(`{date, phase: attempting|sent, sizeBytes, pct, status, messageId?}`),先写 `attempting` 再发再写 `sent`;同日已 `sent` 不再发,`attempting` 且 30 分钟内不重试。这和 token 日报的 receipt 形状一致,不新增 alert kind、不改 7 处白名单。
**选项 B(拒)**:新增 alert kind `report_hosting_usage_high` 走 `lead-alert.sh` —— 要改 7 处,且 `--plain-message` 只放行 quota 家族,得再开口子;这是通知不是工单。
**选项 C(拒)**:新 launchd 单元跑 shell —— 违反「不新增 launchd 单元」,还要 census/converge 登记。

`storeId` 来源:retarget 时从 store API 响应记进 `hosting.storeId`;当前已切好的 registry 没有这个字段,给 CLI 加 `--usage-check [--store-id <id>]` 一次性补录并打印当前水位(也是 QA E 的 dry-run 面)。

## 5. 稳定身份与标签

| 身份 | 值 | 说明 |
|---|---|---|
| Vercel 项目名 | `fw-reports-<6hex>`(operator 传入) | registry `vercelProjectName`,同时是域名 |
| Blob store 名 | 默认 `<projectName>-blob` | 可 `--store-name` 覆盖;API 不给 list,重名 409 直接报错 |
| hosting 标记 | `{provider, migratedAt, gatewayDeploymentId, storeId?, retargetedFrom?: {vercelProjectName, migratedAt}}` | 只追加字段;所有 `hosting()?.provider === "vercel-blob"` 读者不变 |
| retarget journal | `~/.flywheel/reports/retarget.<projectName>.json` | write-ahead;成功写 registry 标记后保留(重跑判 no-op 用) |
| 通知回执键 | `notify-receipts.json` → `report_hosting_usage` | 与 `token_report` 并列 |
| Epic 发布 digest | `epic_page_publication.last_content_digest` | nullable,NULL ⇒ 永不跳过 |
| 报告去重键 | (已删除) | R1 修订 |

## 6. 已知风险与对策

- **Epic audit sidecar 不在 registry**:retarget 只搬 HTML,新 store 上 audit JSON 要等下一次 Epic 重发才有;期间 Epic 页脚注的 audit 链接 404。对策:retarget 结束后打印提示;下一次 event/scan(小时级)自然补齐。不在命令里调 Bridge。
- **gzip 上线顺序**:先网关后 Bridge,写进 plan 的 rollout 段与 QA 步骤;网关同时支持明文/gzip,回滚只需 Bridge 回退。
- **热读 `.env` 的失败形态**:文件不可读/键缺失 ⇒ 回落进程 env,行为与今天一致;文件里值为空串 ⇒ 视为未配置(501),与今天 `trim()` 语义一致。
- **去重语义**:R1 修订后不做;原因见 §4.3 ③。
- **水位只覆盖存储**:传输/操作不可观测,写进「不做什么」。
- **Lead 三问未回**:§2 已说明设计不押注红线。

## 7. 修订记录

- R1(Codex 2026-09-13,12 条):删去重;新增 `REPORT_HOSTING_VERCEL_TOKEN`;删 `--team-slug`;registry 加跨进程锁与 commit 重读合并;Bridge 加「token store id ≠ registry storeId ⇒ 503」守卫(RW token 第 4 段即 store id,SDK `parseStoreIdFromReadWriteToken` 同源);journal 改绑定式(token→createdAt/bytes/sha256 + manifestDigest);gzip 上线改数据门 `hosting.gatewayFormat`;凭据快照按顶层操作取一次;Epic 跳过绑定 hostingKey;水位小时级 tick;Accept-Encoding 解析 q 值;秘密交接改 0600 文件。细节全部以 plan.md v2 为准。
