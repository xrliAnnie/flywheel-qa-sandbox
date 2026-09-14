# FLY-2538 报告托管账号轮换 — 实施计划
Issue: FLY-2538 (https://linear.app/geoforge3d/issue/FLY-2538/报告托管-vercel-账号轮换做成一条命令migratereport-hosting-retarget-凭据热切换-报告用量削减-水位告警)
日期: 2026-09-13
基于: research.md

**Version**: v1.57.0 · **Plan revision**: v5(Codex R1–R4 后;R4 四条已并入,见 review.md)· **Status**: draft

## 0. 范围与顺序

Lead 裁定(exploration §2)ops 为首要嫌疑,所以实现顺序是「先止血再换轮胎」:

| Chunk | 内容 | 依赖 | 直接对应 QA |
|---|---|---|---|
| C0 | registry 跨进程锁(复用 `withMkdirLock`)+ hosting 绑定栅栏 + CAS 式标记写入 | — | A/B 并发用例 |
| C1 | Epic 固定页 digest 不变不重传(24 h 保活;绑定 hostingKey) | C0 | D |
| C2 | Blob sweep 每小时→每日;`deleteReports` 去 per-token list | — | — |
| C3 | gzip:网关双格式 + `--deploy-gateway-only`(含探针)+ Bridge 按 registry 数据门写 gzip | C0 | C |
| C4 | 凭据 call-time 单快照(`BLOB_READ_WRITE_TOKEN` / `REPORT_HOSTING_VERCEL_TOKEN` / `VERCEL_TOKEN`)+ store 绑定守卫 | C0 | B |
| C5 | `--retarget` 命令(整次命令锁 + 绑定式 journal + 两阶段凭据交接 + CAS 标记 + 有界收敛循环) | C0、C3、C4 | A |
| C6 | 水位小时级检查 + 通知 + `--usage-check` | C4、C5(`storeId`) | E |
| C7 | 文档:运行手册、数据门、boundary | 全部 | — |

**已删除**:v1 的「保留期内同内容去重」——复用旧 token 违反 FLY-2283「每条链接从本次创建起完整可访问 14 天」,且 529 loopback host 重启后旧 token 直接 404。若 Lead 仍要去重需另开 issue;issue 第 3③ 条据此收窄,DONE 报告明示。

**新增一个 env 键**:`REPORT_HOSTING_VERCEL_TOKEN`(报告网关/store 管理专用 Vercel account token)。`VERCEL_TOKEN` 同时被 `/api/publish-html` 用于部署旧账号上的 `triage-<project>` 项目,不能热切到新账号。两者之间**不回退**;新键缺失时相关功能按「未配置」跳过并各 warn 一次。

## 1. 合同(先写死,再写码)

### 1.1 CLI

```
pnpm migrate:report-hosting                              # 原首次迁移路径,字节不变
pnpm migrate:report-hosting --retarget \
    --vercel-token-env <ENV_NAME> --project-name fw-reports-<6hex> \
    [--blob-token-env <ENV_NAME>] [--store-name <name>] [--store-id <id>] [--abandon-store-intent] [--region <vercel-region>] [--reports-dir <dir>]
pnpm migrate:report-hosting --deploy-gateway-only --vercel-token-env <ENV_NAME> --blob-token-env <ENV_NAME>
pnpm migrate:report-hosting --usage-check --vercel-token-env <ENV_NAME> [--store-id <id>] [--token <32hex> --blob-token-env <ENV_NAME>]
```

- 三个子模式互斥;无子模式 = 旧行为。
- `--*-token-env` 只接受**环境变量名**(`^[A-Za-z_][A-Za-z0-9_]*$`);值从 `process.env` 取;缺失或空 ⇒ 退出 2。
- `--project-name` 必须匹配 `^fw-reports-[0-9a-f]{6}$`。registry 有项目名但无 hosting 标记 ⇒ 退出 2(先跑无参 migrate)。等于 registry 当前项目名时:`hosting.storeId` 已有 ⇒ 允许(补传/复核路径);缺失 ⇒ 退出 2,提示 `--usage-check --store-id` 补录。
- `--store-name` 默认 `<project-name>-blob`。`--store-id`(仅 `--retarget`):恢复路径,跳过创建,store 仍走 §C5 步 2 的同一套 GET 校验,并把 GET 返回的实际 `name` 记进 journal、清除 intent。`--abandon-store-intent`(仅 `--retarget`,必须与 `--store-name <新名>` 或 `--store-id` 同用):把当前 intent 归档到 journal `abandonedIntents[]` 后继续;不带它时 intent 未决即退出 2。
- 不提供团队作用域参数;API 403 时提示「token 需为该 Hobby team 的 Full Account token」。
- stdout:每步一行 `[retarget] step=<name> status=done|skipped|failed pass=<n> detail=<非敏感>`;最后一行 JSON:
  `{"project","projectId","storeId","blobHost","gatewayDeploymentId","manifestDigest","contentDigest","passes":n,"uploaded":N,"reuploaded":M,"skipped":K,"verified":[token8…],"secretsFile":"<path>|null","envHint":["REPORT_HOSTING_VERCEL_TOKEN ← $<NAME>","BLOB_READ_WRITE_TOKEN ← <secretsFile 里的行 | $<NAME>>"]}`。
- 退出码:0 成功/no-op;1 远端步骤失败(可重跑);2 参数/前置失败/另一个 retarget 正在运行/需要 `--store-id` 恢复;3 等待凭据交接。

### 1.2 秘密处理

- 进程内 `SecretRedactor`:`add(value)` 登记每个已知 secret 原串(两个 token env 的值、解密得到的 Blob token);`redact(text)` 先对全部原串**精确替换**为 `<redacted:name>`,再叠加通用规则(`vercel_blob_rw_[A-Za-z0-9_]+`、`Bearer\s+\S+`、`"value"\s*:\s*"[^"]*"`)。所有 stdout/stderr/`Error.message`/`VercelApiError.bodySnippet` 出口必经 `redact`。
- `decryptProjectEnv` 响应只取 `.value` 进内存并立即 `add`;失败错误只带 `status` 与 `envId`。
- `deployFilesToVercel` 抛出的 body snippet 在包装层 `redact` 后再抛(`vercel-deploy.ts` 不动)。
- 测试:任意格式 fake account token、fake Blob token、含 `"value":"…"` 的 JSON 响应,每条 failed-step 输出与最终 JSON `not.toContain` 原串。

### 1.3 registry(锁、绑定、CAS)

```ts
interface ReportHostingState {
  provider: "vercel-blob";
  migratedAt: string;              // 首次切到该 store 的 cutoverAt;补传/复核不变
  gatewayDeploymentId: string;     // 最新一次通过验证的部署
  storeId?: string;                // 规范形(无 store_ 前缀,小写比较)
  blobHost?: string;
  gatewayFormat?: "gzip-v1";       // 探针通过后写;Bridge 只有看到它才写 gzip
  manifestDigest?: string;         // sha256(排序 token:createdAt)
  contentDigest?: string;          // sha256(排序 token:createdAt:bytes:sha256)
  retargetedFrom?: { vercelProjectName: string; migratedAt: string };  // 首次写入后不变
}
interface HostingBinding { vercelProjectName?: string; storeId?: string; gatewayFormat?: "gzip-v1"; migratedAt?: string; hostingKey: string /* `${vercelProjectName ?? "-"}/${storeId ?? "-"}` */ }
```

- **锁**:`ReportRegistry.withLock(fn)` = `withMkdirLock(join(baseDir, "registry.lock.d"), fn, { timeoutMs: 5_000, retryMs: 50 })`(`flywheel-config`,PID+启动时间识别、不按年龄偷活锁、异步退避;短锁,每次读-改-写)。另有 **hosting 变更锁** `join(baseDir, "hosting-mutation.lock.d")`(同一实现的长锁,覆盖整次 `--retarget` / `--deploy-gateway-only` / 无参 legacy migrate 命令;不分目标项目,任意两条 hosting 变更命令互斥)。超时抛 `ReportRegistryLockBusy` ⇒ 路由 503 `report registry busy`、Epic `transient: publish_failed:registry`。CLI 与 Bridge 同一实现。**因此 `StagedPublish.commit()` 变为 `Promise<void>`**,两个调用方(`reports-route.ts` L368、`epic-page-publisher.ts` L130)`await`。
- `hostingBinding(): HostingBinding`:一次 `load()` 产出。**stage 不再自己取 binding**:`stagePublish(projectName, html, title, binding)` / `stageEpicPageRepublish(projectName, html, token, title, binding)` 由调用方传入已用于凭据校验的那份 `binding`;stage 内 `load()` 后若 `hostingKey` 已 ≠ `binding.hostingKey` ⇒ 抛 `ReportHostingBindingConflict`(put 之前,零上传)。`StagedPublish.binding` 即传入值。空 registry(529 hostOverride 首发)时 `binding.vercelProjectName` 为 undefined,stage 仍按今天的方式生成 `fw-reports-<6hex>` 候选名放进 `staged.vercelProjectName`,commit 时 fresh 若仍无项目名则持久化候选名;`hostingKey` 比较把 undefined 视为 `-`。
- `commit()`:锁内 `fresh = load()`;`fresh` 的 hostingKey ≠ `staged.binding.hostingKey` ⇒ **不写**,抛 `ReportHostingBindingConflict{expected, actual}`;一致 ⇒ `reports` 对 `fresh.reports` 应用「同 token 替换 → age prune → 追加」,`vercelProjectName/hosting` 取 `fresh`,`saveAtomic`。
- 调用方对 `ReportHostingBindingConflict`:`/publish` 用**本次操作的凭据快照**删本次 `r/<token>/index.html`(token 唯一,是真 orphan)后 503 `{error:"report hosting changed during publish"}`;Epic **HTML 与本次 audit 都不删**:稳定页已被本次 put 覆盖并引用本次 audit,二者都是旧 store 上仍在使用的对象(保留利于回滚),删 audit 会让稳定页断链;交给正常 14 天 sweep 回收。conflict 时零 `del`、零 `list`,直接返回 `transient: publish_failed:credentials`。
- `commitRetarget({ expectedSourceHostingKey, expectedManifestDigest, expectedContentDigest, hosting: Omit<ReportHostingState,"migratedAt">, vercelProjectName, now }): { cutoverAt: string; written: boolean }`:锁内 `fresh = load()`;`fresh.hostingKey` 既 ≠ `expectedSourceHostingKey` 又 ≠ 目标 key ⇒ 抛 `ReportHostingBindingConflict`(另一条 retarget 抢先改了来源);按 `fresh.reports` 保留集重算两个 digest,任一 ≠ expected ⇒ 抛 `ReportRetargetManifestStale`;通过后:若 fresh 已等于目标(项目名、storeId、digests、deploymentId、gatewayFormat 全同)⇒ `written:false` 不写不备份,返回 fresh 的 `migratedAt`;否则 **在锁内取 `cutoverAt = now()`**(此刻 fresh 全部 entry 的 `createdAt ≤ cutoverAt` 必然成立),`hosting.migratedAt = 已存在同 store 的 fresh.migratedAt ?? cutoverAt`,`retargetedFrom` = 调用方传入(来源 binding 的 project+migratedAt,来源与目标相同时省略),备份到 `registry.json.bak-<ISO 毫秒去符号>-<pid>-<6hex>`,`saveAtomic`。
- `markGatewayFormat({ expectedHostingKey, gatewayDeploymentId })`、`recordHostingStoreId({ expectedProjectName, storeId, blobHost })`、`markHostingMigrated(hosting, { expectedHostingKey })`:锁内 CAS,不匹配抛 conflict 不写。legacy `migrateReportHosting` 传入它在开头读到的 binding key,并整体在 hosting 变更锁内运行。
- `ensureVercelProjectName()` 迁入短锁内,行为不变。

### 1.4 journal(C5)

`<reportsDir>/retarget.<project-name>.json`,tmp+rename,只在 §C5 整次命令锁内读写:

```json
{ "schema": 2, "projectName": "fw-reports-abc123", "projectId": "prj_…",
  "storeCreateIntent": { "name": "fw-reports-abc123-blob", "at": "…" }, "abandonedIntents": [],
  "storeId": "abc…", "storeName": "fw-reports-abc123-blob", "blobHost": "abc….private.blob.vercel-storage.com",
  "connected": true,
  "cutoverAt": "…", "retargetedFrom": { "vercelProjectName": "fw-reports-624a39", "migratedAt": "…" },
  "uploaded": { "<token>": { "createdAt": "…", "bytes": 12345, "sha256": "<hardened HTML sha256>" } },
  "manifestDigest": "…", "contentDigest": "…", "gatewayDeploymentId": "dpl_…",
  "verified": { "manifestDigest": "…", "contentDigest": "…", "deploymentId": "dpl_…", "tokens": ["…"], "at": "…" },
  "updatedAt": "…" }
```

- `storeCreateIntent` 在 `POST store` **之前**写;POST 成功后立即写 `storeId` 并清 intent。POST 返回**确定未创建**的 4xx(400/402/403/409 且不含 store id)⇒ 自动清 intent 后失败退出 1;断网/超时/进程死亡 ⇒ intent 保留。重跑时 intent 存在而 `storeId` 缺失 ⇒ 不自动再建,退出 2:「上次 store 创建结果不明:到 Vercel dashboard 查名为 `<name>` 的 store;存在 ⇒ `--store-id <id>` 重跑(清 intent、记实际 name);不存在 ⇒ `--abandon-store-intent --store-name <新名>` 重跑(intent 归档到 `abandonedIntents[]`)」。
- `cutoverAt` 由 `commitRetarget` CAS 成功时在锁内确定并返回,命令随后才写进 journal;之前各 pass 不写 cutover。`retargetedFrom` 取自命令开头的来源 binding(含其 `migratedAt`),首次写入后不变。
- `uploaded[token]` 记录上传时 entry 的 `createdAt/bytes` 与 hardened HTML sha256;重跑任一不同 ⇒ 重传并更新。
- `manifestDigest`(retention)与 `contentDigest`(content set)分离;`verified` 同时绑定二者与 `deploymentId`,并列出本次实际 GET 验证过的 token。

### 1.5 StateStore(C1/C4)

- 迁移:`addColumnIfMissing("epic_page_publication", "last_content_digest", "TEXT")`、`addColumnIfMissing("epic_page_publication", "last_hosting_key", "TEXT")`;NULL ⇒ 永不跳过。
- `commitEpicPagePublication(input & { contentDigest: string; hostingKey: string })`;`getEpicPagePublication` 返回增加两列。
- `EPIC_PAGE_REFRESH_OUTCOMES` 增加 `"ok_unpublished:<version>:unchanged_digest"` 与 `"transient: publish_failed:credentials"`;`parseEpicPageRefreshOutcome` 正则加 `unchanged_digest`,常量集合加 credentials 项;StateStore ledger 测试覆盖两项接受、`bogus` 拒。
- 回滚:列保留,无 down migration。

### 1.6 网关响应(C3)

| 存储对象 | `Accept-Encoding` 解析 | 响应 |
|---|---|---|
| gzip(`1f 8b`) | 接受 gzip(q>0) | 原 gzip 字节 + `Content-Encoding: gzip` + `Vary: Accept-Encoding` + 既有安全头 |
| gzip | 不接受(缺省 / `gzip;q=0` / 只列其他编码;`*` 按其 q) | gunzip 明文 + `Vary` |
| 明文 | 任意 | 明文 + `Vary` |

- 解析:按 `,` 分项,`token;q=v`,大小写不敏感,q 缺省 1,`q=0`/`q=0.0` 拒绝;`identity` 不参与。
- CSP 头来自解压后 HTML(共用 scanner);gunzip `maxOutputLength: 1_048_576`;超限/损坏 ⇒ 502。
- audit JSON 明文不变。
- `reportGatewayNodeHandler`:`accept-encoding` 为数组时以 `, ` join 后带进 Web `Request`。

### 1.7 通知正文(C6)

```
📦 报告托管 Blob 水位 <pct>%(<sizeMB> MB / 1000 MB,<count> 个对象)· store <storeId 前 8 位> · 项目 <vercelProjectName>
<仅在 usageQuotaExceeded 或 status ≠ available 时:「⚠️ store status=<status> usageQuotaExceeded=<bool>」>
下一步:在 Flywheel checkout 用一个新 Vercel 账号的 token 跑
pnpm migrate:report-hosting --retarget --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN_NEXT --project-name fw-reports-<新 6hex>
完成后按命令输出改 ~/.flywheel/.env 两行(BLOB_READ_WRITE_TOKEN / REPORT_HOSTING_VERCEL_TOKEN),不用重启 Bridge。
```

## 2. 逐 chunk 实施

### C0 registry 锁 + 绑定栅栏 + CAS

文件:`report-registry.ts`(§1.3),调用方 `reports-route.ts`、`epic-page-publisher.ts` 改 `await staged.commit()` 并处理 conflict。

测试(`report-registry.test.ts`、`reports-route.test.ts`、`epic-page-publisher.test.ts`):
- `stage(old) → 另一实例 commitRetarget → commit()` ⇒ 抛 `ReportHostingBindingConflict`,registry 无该 entry,hosting 是新的;路由返回 503 且用**原快照 token** 调了 `deleteReports`;Epic 返回 `transient: publish_failed:credentials`。
- put 完成前发生 retarget(stage 在旧 binding,put 用旧 token)与 put 完成后发生,两种时序都不留错误 entry、不返回新域名 URL。
- 两个实例交错 commit(同 binding)⇒ 并集。
- 锁:活着但暂停 > staleMs 的 holder 不被偷(`readProcessStartTime` seam);死 PID 立即可恢复;marker 缺失/畸形按年龄;等待走 `sleep` seam 不阻塞 event loop;超时抛 `ReportRegistryLockBusy` ⇒ 503。
- `commitRetarget` 在 fresh 集合多一条 entry 时抛 `ReportRetargetManifestStale` 不写;一致时写且 `.bak` 内容等于写前落盘内容。
- `markGatewayFormat` expectedHostingKey 不符不写。
- 守卫通过后、stage 内 `load()` 前发生 retarget ⇒ stage 抛 conflict,零 put、无 entry、无 URL(报告与 Epic 两条路径)。
- 并发 A→B 与 A→C:一个成功、一个因 `expectedSourceHostingKey` 不符抛 conflict(在备份之前),registry 只有一个目标、**恰好一份**备份。顺序 A→B 再 B→C(第二次以 B 为 source)⇒ 两份备份且文件名不同。legacy migrate 与 retarget 交错 ⇒ `markHostingMigrated` CAS 拒。
- fake clock:pass 1 读保留集后并发 commit X(createdAt 早于 pass 1 读取)⇒ CAS stale;pass 2 成功;`hosting.migratedAt` = pass 2 锁内时刻 ≥ X.createdAt;随后 `deployReportGatewayOnly` 的 manifest 含 X 的原始 `createdAt`。
- Epic put 后、commit 前发生 retarget ⇒ 旧 store 稳定 HTML 与其 audit 均保留,`del` 0 次、`list` 0 次,outcome `transient: publish_failed:credentials`。

### C1 Epic digest 不变不重传

文件:`epic-page/model.ts`、`bridge/epic-page-publisher.ts`、`bridge/epic-page-refresher.ts`、`StateStore.ts`。

1. `model.ts` 新增 `hostedContentDigest(page)`:`stripTimestamps(page)` 后删顶层 `freshness`,再递归删除键名精确为 `version` 的叶子,`canonicalSubmissionDigest`。
2. `publishHosted`:hostOverride/未配置早退不变;render 后算 `digest`;进入临界区后 **先** `binding = registry.hostingBinding()`,`pub = store.getEpicPagePublication(projectName)`;
   `skip = pub?.published && pub.last_content_digest === digest && pub.last_hosting_key === binding.hostingKey && now - Date.parse(pub.last_published_at) < 24h`;
   skip ⇒ 不 stage、不取凭据、不 put,返回 `ok_unpublished:${version}:unchanged_digest`。
3. 非 skip:C4 守卫(用 `binding.storeId`)→ `stageEpicPageRepublish` → put(绑定快照)→ `await commit()`(栅栏用 `staged.binding`)→ `commitEpicPagePublication({..., contentDigest: digest, hostingKey: binding.hostingKey})`。
4. 类型/parser 见 §1.5。
5. retarget 后 hostingKey 变 ⇒ 下一次 event/scan 重传(audit sidecar 到新 store)。CLI 末尾打印该说明。

测试:同 digest+同 key+1 h ⇒ skip,`putEpicPage` 0 次、`hostingBinding` 1 次、凭据快照 0 次;25 h ⇒ put;digest 变 ⇒ put 且两列更新;key 变 ⇒ put;NULL ⇒ put;`hostedContentDigest` 三条稳定性用例(research §4)。

### C2 sweep 与删除去 list

文件:`plugin.ts` L6383-6399、`report-blob-store.ts` `deleteReports`。

1. 导出 `REPORT_BLOB_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000`;启动即一次不变。
2. `deleteReports(tokens)` 只 `del` `r/<token>/index.html`;audit 子对象由每日 sweep 按 `uploadedAt` 14 天回收(注释:最多晚 14 天)。
3. `putEpicPage` 清理 list 保留。

测试:`deleteReports` 只 `del` 一次、`list` 0 次;常量断言。

### C3 gzip(网关双格式、数据门)

文件:`report-gateway-runtime.ts`、`report-blob-store.ts`、`report-hosting-migration.ts`、`scripts/migrate-report-hosting.ts`。

网关:缓冲字节 → magic 判 gzip → gunzip(上限)→ CSP → 按 §1.6 出参;`parseAcceptEncoding` 纯函数;Node handler join 数组头。

`--deploy-gateway-only`:
1. `deployReportGatewayOnly({registry, blobSnapshot, vercelToken, sources})`:manifest = registry 中 `createdAt ≤ hosting.migratedAt` 的 entry(不重新冻结新对象)→ `assertGatewayBlobEnvironment` → `deployFilesToVercel` → 探针 → `markGatewayFormat({expectedHostingKey: 部署前读取的 binding.hostingKey, gatewayDeploymentId})`。
2. 探针(共用函数 `probeGatewayFormats({bound, projectName})`,C5 步 8 复用):两个随机 32hex probe token;`bound.putRawObject(r/<p1>/index.html, gzip(最小合法 HTML 含 CSP meta))`、`bound.putRawObject(r/<p2>/index.html, 1f 8b + 垃圾)`(**raw-byte seam,不经 gzip 包装**);GET ① `Accept-Encoding: gzip` ⇒ 200 + `Content-Encoding: gzip` + CSP 头;② 无头 ⇒ 200 明文含 `<html`;③ `gzip;q=0` ⇒ 200 明文无 `Content-Encoding`;④ p2 ⇒ 502;`finally` 用**同一 bound 快照** `del` 两个 probe。任一失败 ⇒ 不写 `gatewayFormat`,退出 1。

Bridge:
3. `VercelBlobReportStore.bind(snapshot): BoundReportBlobStore`(见 C4);HTML 路径 put 当 `binding.gatewayFormat === "gzip-v1"` 时 `gzipSync(level 9)`(调用方从 `staged.binding` 传入 `gzip: boolean`,不再由 store 自己读 registry)。audit JSON 不压。
4. `putEpicPage` 回读旧页按 magic 解压再取 `data-previous-audit`。
5. `headReportSize(token)`(`head().size`);`ReportBlobClient` 加可选 `head`。CLI `--usage-check --token <t> --blob-token-env` 打印 `{token8, sizeBytes}`。

**数据门**:Bridge 任何时刻重启都安全(`gatewayFormat` 未写就明文);网关任何时刻部署都安全(双格式)。

测试:网关三格式 × 头矩阵、`q=0`、`*`、大小写、数组头 join;上限 502;`gzip=false/true` 字节形态;回读 gzip 旧页;探针任一失败不写门、全过才写、`finally` 清理走同一快照、损坏对象经 raw seam 未被再压;`deployReportGatewayOnly` 不改 manifest 冻结语义。

### C4 凭据单快照 + store 绑定守卫

文件:新 `bridge/report-hosting-credentials.ts`、`report-blob-store.ts`、`reports-route.ts`、`publish-html-route.ts`、`epic-page-publisher.ts`、`plugin.ts`。

```ts
export interface CredentialSnapshot { key: CredentialKey; value: string | undefined; source: "file" | "process" | "absent"; generation: number }
export interface ReportHostingCredentials { snapshot(key: CredentialKey): CredentialSnapshot }
export function blobStoreIdFromToken(token: string): string | undefined   // token.split("_")[3] 小写
export interface BoundReportBlobStore { putReport; putEpicPage; putMigratedReport; deleteReports; sweepExpiredReports; headReportSize; putRawObject; readonly storeId: string }
class VercelBlobReportStore { bind(snapshot: CredentialSnapshot): BoundReportBlobStore /* value 缺失抛 ReportBlobCredentialMissing */ }
```

- 解析:`${FLYWHEEL_STATE_DIR?.trim() || ~/.flywheel}/.env`;`stat` 的 `mtimeMs+size` 变化才重读(`generation++`);`readEnvValueFromContent` + 剥成对引号 + `trim`;文件不可读 ⇒ 回落 `process.env`(`source="process"`),状态翻转 warn 一次;键缺 ⇒ 回落;空 ⇒ `absent`。
- **一次 publish 只有一个快照**:`/publish` 在临界区内 `snap = credentials.snapshot("BLOB_READ_WRITE_TOKEN")` → 缺失 501 → `binding = registry.hostingBinding()` → 守卫:`binding.storeId` 存在且 ≠ `blobStoreIdFromToken(snap.value)` ⇒ 503 `{error:"report hosting credentials do not match registry store", expectedStoreId8, actualStoreId8}`,不 stage;`bound = blobStore.bind(snap)` → `stagePublish(…, binding)`(stage 内 key 已变 ⇒ conflict,零 put)→ `bound.putReport(gzip = binding.gatewayFormat === "gzip-v1")` → `await commit()`(栅栏用 `staged.binding`);commit 抛 conflict/其他 ⇒ `bound.deleteReports([token])`(同一 bound)→ 503/502;响应 URL 用 `staged.binding.vercelProjectName`(或 staged 候选名),不再读 registry。Epic publisher 同型(守卫失败 ⇒ `transient: publish_failed:credentials`;conflict 补偿见 §1.3)。sweep/usage tick 各在 tick 入口取一次快照。
- 守卫只在生产 Blob 分支;hostOverride 分支不读 Blob 凭据、不守卫。`binding.storeId` 缺失(老 registry 未补录)⇒ 不守卫,warn 一次。
- 上传后既有 URL 主机校验保留,并比较主机首段 === `bound.storeId`。
- `/api/publish-html`:`createPublishHtmlRouter(() => credentials.snapshot("VERCEL_TOKEN").value)`。
- `plugin.ts`:L6291-6303 改为构造 `credentials` 与 `reportBlobStore`(恒构造);**sweep 与 usage 两个定时器无条件安装**,tick 内按各自凭据快照 skip(启动后热添加 token 即生效);启动日志「Report publishing configured (private Vercel Blob, credentials=<source>)」。
- 成功日志:`[reports] publish succeeded credentialTier=… project=… store=<storeId8> credentialSource=file|process generation=N`。

测试:新 `report-hosting-credentials.test.ts`(文件优先 / 缺键回落 / mtime 变更 generation++ / 不可读回落且 warn 一次 / 引号剥离 / 空 absent);`reports-route.test.ts`:守卫通过后、`putReport` 前把 resolver 换成 B ⇒ put 仍用 A;put 成功后、commit 失败、cleanup 前换成 C ⇒ `deleteReports` 仍用 A;registry storeId=A、token 指 B ⇒ 503 且 put 0 次;`report-blob-store.test.ts`:`bind` 后 `putEpicPage` 内 get/put/list/del 全用同一 token;分页 sweep 同理;timers:无凭据启动 → 写入 `.env` → 下一 tick 生效。

### C5 `--retarget`

文件:新 `bridge/vercel-hosting-api.ts`、`report-hosting-migration.ts`(`retargetReportHosting`)、`report-registry.ts`、`scripts/migrate-report-hosting.ts`。

`vercel-hosting-api.ts`(每函数 `{token, fetchImpl?, redactor}`;非 2xx 抛 `VercelApiError{status, endpoint, bodySnippet}`):
- `getProject(name)` → `GET /v9/projects/{name}` → `{id,name}|null`
- `createProject(name)` → `POST /v11/projects {name, framework:null}`
- `createPrivateBlobStore({name, region?})` → `POST /v1/storage/stores/blob {name, region?, access:"private"}`;响应 `store.access !== "private"` ⇒ `deleteBlobStore(id)` 后抛 `StoreNotPrivate`
- `deleteBlobStore(id)` → `DELETE /v1/storage/stores/blob/{id}`
- `connectStore({storeId, projectId})` → `POST /v1/storage/stores/{storeId}/connections {projectId, envVarEnvironments:["production","preview","development"], type:"integration"}`
- `findProjectBlobEnv(projectId)` → `GET /v10/projects/{id}/env` → `{envId, type, storeId?: contentHint.storeId}`(key=`BLOB_READ_WRITE_TOKEN` 且 target 含 production)
- `decryptProjectEnv(projectId, envId)` → `GET /v9/projects/{id}/env/{envId}?decrypt=true` → 只返回 `value`;`decrypted===false`/`type==="sensitive"` ⇒ `EnvNotDecryptable`
- `getStore(storeId)` → `GET /v1/storage/stores/{id}` → `{id, name, access, size, count, status, usageQuotaExceeded, projectsMetadata[].projectId}`;`id/name/access/size/count/status/usageQuotaExceeded/projectsMetadata` 缺或类型不符(`count`/`size` 必须有限非负整数)⇒ shape error(`access/name/count/size` 在 Vercel CLI `StoreDetails` 与 create 响应中均存在;`projectsMetadata/status/usageQuotaExceeded` 为文档必填项)。
- storeId 规范化去 `store_`,比较小写。

**整次命令锁**:`withMkdirLock(<reportsDir>/hosting-mutation.lock.d, run, {timeoutMs: 2_000, retryMs: 100})`(与 `--deploy-gateway-only`、legacy migrate 共用,不分目标),超时 ⇒ 退出 2「另一个托管变更命令正在运行」;`withMkdirLock` 破陈旧锁后会在同一次调用内重试,2 s 足够完成一次 stale-break+重占。journal 只在锁内读写。

`retargetReportHosting(options)`(每步 `log`;成功即写 journal):

| # | 步 | 做什么 | 幂等/重验 |
|---|---|---|---|
| 0 | 前置 | dist 三件 + `@vercel/blob` 版本;registry 可读;`--project-name` 规则;`binding0 = registry.hostingBinding()` | — |
| 1 | 项目 | `getProject` 有 ⇒ 取 id;无 ⇒ `createProject` | 每次 GET |
| 2 | store | 顺序:`--store-id` 给定 ⇒ 用(清 intent);否则 `findProjectBlobEnv(projectId).storeId` ⇒ 用;否则 journal.storeId ⇒ 用;否则 intent 存在且无 `--abandon-store-intent` ⇒ 退出 2(§1.4);否则(必要时归档 intent)写 intent → `createPrivateBlobStore` → 写 storeId 清 intent。**无论来源**,随后 `getStore(storeId)` 同一套校验:`access==="private"`、`status==="available"`、`usageQuotaExceeded===false`、`count` 为有限非负整数;`name`:create/journal/env 路径要求 `=== storeName`,`--store-id` 路径接受并把实际 name 写回 journal.storeName;不符 ⇒ 退出 1 | 每次 GET + 同一 shape 测试 |
| 3 | 连接 | 连接判据(每次都验,与来源无关):`findProjectBlobEnv(projectId).storeId === storeId` **且** 步 2 `getStore().projectsMetadata` 含 `projectId`;两者皆真 ⇒ skip;否则 `connectStore` 后重新 GET 两者确认 | 每次 GET |
| 4 | token | `--blob-token-env` ⇒ 用;否则 `decryptProjectEnv`;校验前缀 `vercel_blob_rw_` 且 `blobStoreIdFromToken === storeId`;`bound = store.bind(snapshot)` | — |
| 4b | 交接 | token 来自解密 ⇒ 写 `<reportsDir>/retarget.<project>.secrets.env`,写入合同:父目录必须是 reportsDir 本身、`lstat` 非 symlink、属当前 uid、`mode & 0o022 === 0`(group/world 不可写),否则退出 1;目标路径 `lstat`:不存在 ⇒ 写;symlink 或非普通文件 ⇒ 退出 1;存在且普通文件 ⇒ 必须属当前 uid、mode 恰为 0600、内容严格为一行 `BLOB_READ_WRITE_TOKEN=<合法 token>`(值先 `redactor.add`)且 `blobStoreIdFromToken` 等于本次 storeId ⇒ no-op,任一不满足 ⇒ 退出 1「已有不合规或另一 store 的 secrets 文件,确认后删除再跑」(输出只含路径);写法 = 同目录 `open(tmp, "wx", 0o600)` 唯一临时名 → 写一行 → `fsync` → close → `rename` → 再 `lstat` 终验 owner=uid、mode 0600、普通文件,不符退出 1;stdout 只打印路径。`--blob-token-env` 给定 ⇒ 不写 | 内容绑定同 store ⇒ no-op |
| 5 | 网关 env | `assertGatewayBlobEnvironment` | 每次 |
| 6 | 搬报告 | 锁内 `retained = registry.list()` 保留集;对每个 entry:journal 无或 `{createdAt,bytes,sha256}` 任一不同 ⇒ `bound.putMigratedReport`(gzip);首次上传校验 URL 主机首段 === storeId;每 25 个 flush;计算 `manifestDigest`/`contentDigest` | 三元组相同 ⇒ skip |
| 7 | 网关 | journal `gatewayDeploymentId` 缺、或 `manifestDigest` ≠ journal ⇒ `deployFilesToVercel`(manifest = 本次 retained 全部 `createdAt`);否则 skip | 绑 manifestDigest |
| 8 | 探针+验证 | `verified` 三元组(manifest/content/deployment)与当前一致 ⇒ skip;否则 `probeGatewayFormats(bound)` 四例 + 对「本 pass 重传的 token(≤10 个,超出取最新 10 个并记 count)∪ 当前 retained 最新 3 个」逐个 `GET`(`Accept-Encoding: gzip`)要求 200 + CSP + `text/html` + `Content-Encoding: gzip`;`r/00…0/` 404;写 `verified` | 绑三元组 |
| 9 | 标记 | `registry.commitRetarget({expectedSourceHostingKey: binding0.hostingKey, expectedManifestDigest, expectedContentDigest, vercelProjectName, hosting:{provider, gatewayDeploymentId, storeId, blobHost, gatewayFormat:"gzip-v1", manifestDigest, contentDigest, retargetedFrom: retargetedFromOf(binding0, 目标项目名)}, now})`;`retargetedFromOf(src, target)`:`src.vercelProjectName` 存在且 ≠ target 且 `src.migratedAt` 存在 ⇒ `{vercelProjectName: src.vercelProjectName, migratedAt: src.migratedAt}`;`src.vercelProjectName` 存在且 ≠ target 但 `migratedAt` 缺失(有项目名、无 hosting 标记的合法来源)⇒ **前置失败退出 2**「来源 registry 无 hosting 标记,请先用无参 migrate 完成首次迁移」(要求留下 provenance);来源等于目标或来源无项目名 ⇒ `undefined` → 返回 `{cutoverAt, written}` → 写 journal `cutoverAt`。抛 `ReportRetargetManifestStale` ⇒ **回到步 6**(pass+1,最多 3 pass;第 3 次仍 stale ⇒ 退出 1「registry 持续变化,稍后重跑」);抛 `ReportHostingBindingConflict` ⇒ 退出 1「来源 hosting 已被另一次变更改写」 | CAS |
| 10 | 输出 | JSON + envHint + 「Epic audit 下一次刷新补齐」+ 「粘贴后删除 secretsFile」 | — |

- 步 9 CAS 成功即意味着标记覆盖了锁内读到的全部保留集;此后任何仍在飞的旧 binding publish 由 C0 栅栏拒绝(503),不会留下错误 entry。**第一次 exit 0 即正确**;手册里的「再跑一次」只是复核(no-op),不承担正确性。
- 步 9 之后、operator 改 `.env` 之前,Bridge `/publish` 被 C4 守卫 503(有意窗口,≤ 60 s 内 `.env` 改好即恢复)。
- 同 target 重跑:步 1–3 GET 重验,步 4 重取 token,步 6 三元组全同 ⇒ 0 put,步 7/8 skip,步 9 因 fresh digest 与 journal 一致且 hosting 字节相同 ⇒ 写入等价(`saveAtomic` 同内容;`.bak` 仍生成一份——可接受,或比较相等则跳过写;实现选「相等则 skip 并不生成 .bak」)。
- 退出 3:`EnvNotDecryptable` ⇒ journal 保留,提示「在 Vercel dashboard 复制该项目 production 的 BLOB_READ_WRITE_TOKEN,`export BLOB_READ_WRITE_TOKEN_NEXT=<值>` 后以 `--blob-token-env BLOB_READ_WRITE_TOKEN_NEXT` 重跑」。

负向守卫:store 创建 402/429/`usage_threshold_limits_reached` ⇒ 退出 1;步 6 遇 `BlobStoreSuspendedError`/`BlobAccessError` ⇒ 立即停;伪 token 404 与探针 502 必需;全程不读不改 `.env`;不删旧账号资源(除本命令刚建错的 public store)。

测试(`report-hosting-migration.test.ts` + 新 `vercel-hosting-api.test.ts`,fake fetch/Blob client/时钟/锁 seam):
- 空账号一跑到底:调用序列/body 精确断言(`access:"private"`、connections body、`getStore` 校验);registry 全字段;`.bak`;`secrets.env` 0600 一行。
- 重跑 no-op:GET 重验 + 0 put + 0 deploy + 标记字节不变 + `retargetedFrom` 不变;退出 0。
- 步 6 后 registry 多一条 entry(模拟并发 publish 已 commit)⇒ 步 9 stale ⇒ pass 2 补传+重部署+重验+CAS 成功;连续 3 次 stale ⇒ 退出 1 不写标记。
- `bytes` 变而 `createdAt` 不变 ⇒ 重传该 token,`contentDigest` 变 ⇒ 重验该 token(manifest 不变 ⇒ 不重部署)。
- 断点:POST store 成功但返回前崩(intent 在、storeId 缺)⇒ 重跑退出 2 且**不再 POST**;`--store-id` 恢复 ⇒ GET 校验、清 intent、记实际 name 后续跑;`--abandon-store-intent --store-name 新名` ⇒ intent 归档后新建;确定性 4xx ⇒ intent 自动清;上传中崩 ⇒ 只补未记录 token;死 PID 遗留的 `hosting-mutation.lock.d` 在同一次运行内被破除并继续。
- secrets 文件:目标是 symlink ⇒ 退出 1;已有另一 store 的文件 ⇒ 退出 1 且输出不含两个 token;已有同 store 但 0644 / 属其他 uid(seam)/ 多一行 ⇒ 退出 1;父目录 group/world 可写 ⇒ 退出 1;rename 前崩 ⇒ 只剩临时文件、目标不存在、重跑成功;最终 owner=uid、mode 0600、单行。
- public store ⇒ DELETE 且退出 1;`getStore` 返回 `access:"public"`/`status` 非 available ⇒ 退出 1;`sensitive` ⇒ 退出 3;token storeId 不符 ⇒ 退出 1。
- 探针任一失败 / 伪 token 非 404 ⇒ 不写标记。
- 第二个 CLI 同 target 并发 ⇒ 退出 2。
- 来源有项目名、无 hosting 标记 ⇒ 退出 2,零远端调用。
- 秘密不泄漏(§1.2)。

### C6 水位检查(小时级触发、按日去重)

文件:新 `bridge/report-hosting-usage.ts`、`notify-receipts.ts`、`plugin.ts`、`scripts/migrate-report-hosting.ts`。

```ts
export const REPORT_HOSTING_HOBBY_STORAGE_BYTES = 1_000_000_000;
export const REPORT_HOSTING_USAGE_ALERT_RATIO = 0.8;
export const REPORT_HOSTING_USAGE_TICK_MS = 60 * 60 * 1000;
export function evaluateReportHostingUsage(store: {size; count; usageQuotaExceeded; status}): { pct; alert; reasons[] }
export async function runReportHostingUsageTick(deps): Promise<UsageTickResult>
```

- 独立 `setInterval(...).unref()`,无条件安装,启动即一次。
- 回执 `notify-receipts.json.report_hosting_usage = { date, storeId, phase: "attempting"|"sent"|"checked"|"failed", attemptedAt, attempts, pct?, sizeBytes?, count?, status?, messageId?, error? }`。
- 每 tick(`today` 按 `resolveFounderTimezone()`):`binding.storeId` 缺 / `REPORT_HOSTING_VERCEL_TOKEN` 快照缺 / `FLYWHEEL_NOTIFY_CHANNEL` 缺 ⇒ `skipped:<reason>`(每种每进程 warn 一次);回执 `date===today && storeId===当前 && phase∈{sent,checked}` ⇒ skip;`attempting` < 30 min ⇒ skip;`failed` < 60 min 或当日 `attempts ≥ 6` ⇒ skip;否则写 `attempting` → `getStore` → 判定 → 需通知则 `postDiscordMessageToChannel(channel, text, infraSenderTokenOr(globalBotToken), {origin:"automation"})` → `sent`;不需要 ⇒ `checked`;异常 ⇒ `failed`(`attempts+1`,error 经 redact)。跨日/storeId 变 ⇒ 重新开始。
- `--usage-check`:打印 `{storeId8, sizeBytes, count, pct, status, usageQuotaExceeded, wouldAlert, secretsFileAgeHours?}`,不发不写回执;`--store-id` 给定且 registry 缺 ⇒ `recordHostingStoreId({expectedProjectName})`;`--token` 见 C3。

测试:80.0% 发、79.9% `checked`、`usageQuotaExceeded` 1% 也发、同日再 tick 不调 `getStore`、`attempting` 10/40 min、`failed` 30/70 min、第 7 次不试、跨日重来、storeId 变重来、正文含 `--retarget` 与 `count` 且不含 token、`no_store_id` 不调 API、无凭据启动后热添加即生效。

### C7 文档

- `doc/reference/remote-report-pipeline.md`:「账号轮换运行手册」(§3)、「gzip 数据门」、「水位通知」、env 表加 `REPORT_HOSTING_VERCEL_TOKEN`,`VERCEL_TOKEN` 行改「仅 `/api/publish-html`,call-time 读」。
- 本文件夹 `implementation-notes.md` 由 implement 写实测数字。

## 3. 上线与运行手册(operator 视角)

**一次性上线(合入后)**
1. updater 正常窗口部署 Bridge。registry 无 `gatewayFormat` ⇒ 仍明文;Epic digest 跳过、sweep 每日、凭据热读、定时器已装;守卫因 `storeId` 缺失 warn 一次不拦。
2. operator:`.env` 加 `REPORT_HOSTING_VERCEL_TOKEN=<当前报告账号 token>`;`pnpm -r build && pnpm migrate:report-hosting --usage-check --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN --store-id <当前 store id>` 补录 storeId(守卫从此生效;水位检查从下一 tick 生效)。
3. `pnpm migrate:report-hosting --deploy-gateway-only --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN --blob-token-env BLOB_READ_WRITE_TOKEN`:双格式网关 + 探针 + 写门。下一次 publish 起 gzip。步 2/3 可颠倒;任何时刻重启 Bridge 都安全。

**轮换日**
4. 新账号建 Full Account token → `export REPORT_HOSTING_VERCEL_TOKEN_NEXT=…` → `pnpm migrate:report-hosting --retarget --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN_NEXT --project-name fw-reports-<新 6hex>`。
5. 退出 0:按 envHint 改 `~/.flywheel/.env` 两行(Blob token 从 secretsFile 粘贴),`rm` secretsFile。步 4 结束到这一步之间 publish 返 503(有意)。退出 2(intent 不明)⇒ 按提示 `--store-id`/`--store-name`;退出 3 ⇒ dashboard 复制后 `--blob-token-env` 重跑。
6. 验证:`publish-report --publish-only` 成功,日志 `store=<新 storeId8>`;可选复核:再跑一次步 4(应全 skipped)。
7. 不重启 Bridge/Lead。

**回滚**
- 凭据:改回 `.env` 两行(旧账号未被停时)。registry:在 `registry.lock.d` 不存在且确认无并发 publish 时手工用 `.bak-<epoch>` 拷回;本单不提供命令。
- gzip:回退 Bridge 即明文;网关不动。其余:回退 Bridge;新列/回执键留着无害。

## 4. QA 判据 → 证据

| QA | 证据 | 谁产出 |
|---|---|---|
| A | 空账号 `--retarget` stdout JSON(`passes`、`verified`);重跑全 skipped 且 exit 0、registry 字节不变;3 个 token `curl -sI -H 'Accept-Encoding: gzip'` 200 + `Content-Encoding: gzip`,`curl --compressed` 正文 grep `<script nonce=`(交互报告)或 CSP 头;伪 token 404;`secrets.env` 0600 | QA(自备 Vercel 账号 token) |
| B | 改 `.env` 两行不重启;`publish-report --publish-only` 返回 URL;日志 `store=<新 storeId8> credentialSource=file`;改回旧 token ⇒ 503 mismatch(负对照) | QA |
| C | 同一 HTML:`--usage-check --token <t>` 前后 `sizeBytes`(前=明文对象,后=gzip)≥60% 降;`curl -sI -H 'Accept-Encoding: gzip'` 见 `Content-Encoding: gzip`;浏览器正常。本机 5 份实报 gzip -9 为 62.6%–77.8% | QA |
| D | 两次 scan 内容不变:第二次账本 `ok_unpublished:vN:unchanged_digest`;`--usage-check` 的 `count`/`sizeBytes` 不变 | QA |
| E | vitest(80/79/同日/backoff/suspended)+ 生产 `--usage-check` dry-run | implement + QA |

单测运行:`pnpm install --offline && pnpm -r --filter "flywheel-teamlead^..." build && pnpm --filter flywheel-teamlead vitest run --exclude '**/tmux-viewer.macos.test.ts'`。

## 5. 不做什么(诚实边界)

- 不观测 Blob 传输/操作用量(API 不给);水位只按存储 1 GB 与 `status/usageQuotaExceeded`。
- 不做保留期内同内容去重(与 FLY-2283 冲突,已删)。
- 不自动改 `.env`、不自动重启、不自动轮换;不支持 team-scoped token;不按 name 查 store(API 无此面,用 intent + `--store-id` 恢复)。
- 不迁 Epic audit sidecar;靠 hostingKey 变化让下一次刷新补齐。
- 不迁 14 天外历史;旧域名不再服务;不删旧账号资源。
- 不改 `/api/publish-html` 部署形态;它继续用旧账号 `VERCEL_TOKEN`(call-time 读)。
- 不提供 registry `.bak` 自动恢复命令。
- 不承诺「月账单 ≤ 1/3」作为 QA 硬门。

## 6. 风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| CLI 与 Bridge 同时写 registry | 覆盖/错登记 | `withMkdirLock` + hostingKey 栅栏 + manifest/content CAS |
| 标记切了、`.env` 未切 | 报告发进旧 store | C4 守卫 503(有意窗口) |
| 步 6–9 之间新 publish | 标记漏对象 | CAS stale ⇒ 有界收敛;在飞旧 binding 由栅栏拒 |
| store 建了没记账 | 重名 409 | intent + `--store-id` 恢复,不自动再建 |
| gzip 顺序 | 502 | 数据门,顺序无关 |
| `.env` 热读 | 文件读失败 | 回落进程 env;单快照 |
| Epic 跳过 freshness 落后 | 最多 24 h | 保活;hostingKey 变即重传 |
| secrets 文件遗留 | 密钥落盘 | 0600 + 手册 rm + `--usage-check` 提醒 |
| redaction 漏形态 | 泄漏 | 精确原串替换优先 |
| 1 GB 十进制 | 提前 7% 告警 | 保守 |

## 7. Lead 裁定记录

| 时间(2026-09-13) | 渠道 | 裁定 |
|---|---|---|
| ask 6dc334e9 | flywheel-comm ask | 红线分项不可见,存储不是;优先级 Epic digest → sweep 每日 → gzip;不带 teamId;store 必须 private;env 解密可用;项目名必须全新 |
| ask 3088b6b9 | flywheel-comm ask | 允许 R4 一轮只验 R3 七条;R4 仍非 APPROVED ⇒ leadAcceptance 收口,R4 条目逐字归档,只修阻断级,不开 R5,直接走 design 完成交接 |

## 8. 修订轨迹

| 版本 | 触发 | 主要变化 |
|---|---|---|
| v1 | 初稿 | 七个 chunk(含去重、`--team-slug`、自制锁、每日 usage tick) |
| v2 | Codex R1(12 条) | 删去重;新增 `REPORT_HOSTING_VERCEL_TOKEN`;删 `--team-slug`;跨进程锁 + commit 重读;store 绑定守卫;绑定式 journal;gzip 数据门;凭据快照;hostingKey;小时级 usage;q 值解析;secrets 文件交接 |
| v3 | Codex R2(9 条) | 锁改用 `withMkdirLock`;stage 捕获 binding、commit 栅栏;marker CAS;manifest/content 双 digest;有界收敛循环;单快照贯穿守卫/IO/补偿;intent;probe raw seam;timers 无条件安装;`count` |
| v4 | Codex R3(7 条) | binding 由调用方显式传入 stage;registry 级 hosting 变更锁 + `expectedSourceHostingKey`;cutoverAt 由 CAS 在锁内定;intent 恢复/放弃;Epic 补偿不删 HTML;secrets 写入合同;getStore 必填字段与连接谓词 |
| v5 | Codex R4(4 条,无 blocker,leadAcceptance) | Epic conflict 零删除;secrets 父目录/既有文件/终验合同;C0 双目标测试拆分;`retargetedFromOf` 判定与无 hosting 标记来源前置失败 |
