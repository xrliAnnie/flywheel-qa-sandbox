# Remote Report Pipeline — `flywheel-comm publish-report` (FLY-203)

**Issue**: FLY-203
**Since**: v1.32.0
**Plan**: `doc/engineer/plan/inprogress/v1.32.0-FLY-203-remote-report-pipeline.md`

## 这是什么

Agent 生成的 HTML 报告（ship-review / triage / 改动清单等）本地 `open` 之外的**远程送达通道**：一条命令把报告发布到不可猜 URL，并向项目 Discord 频道发一条「关键区截图 + 完整报告链接」消息。Annie 在手机上一点即看完整版。

**本地流程零改动** —— 照旧生成 HTML + `open`，远程管线是增量叠加的一条命令。

## 用法

```bash
flywheel-comm publish-report \
  --html /tmp/fly-ship-review.html \
  --project flywheel \
  --title "Ship Review 06-03" \
  [--channel <discord-channel-id>] \
  [--no-screenshot]
```

| Flag | 说明 |
|------|------|
| `--html` | 本地报告文件（必须是带 `<head>` 的完整 HTML 文档，≤512KB；fragment 会被 400 拒绝） |
| `--project` | projects.json 里的 projectName（频道解析用） |
| `--title` | 消息标题（≤200 字符，默认 "Report"） |
| `--channel` | 显式 Discord 频道 id；缺省用该项目的 `generalChannel`，两者都没有则报错（不猜） |
| `--no-screenshot` | 跳过截图，纯链接送达 |

**stdout 永远是一行 JSON envelope**（agent-facing）：

```json
{"url":"https://fw-reports-xxxxxx.vercel.app/r/<32hex>/","reportId":"<32hex>","messageId":"...","screenshot":"...","delivered":true}
```

- publish 成功但 deliver 失败：envelope 仍带 `url`（exit 1）——报告已发布，可手动转发链接
- 截图失败自动降级为纯链接消息（exit 0，`screenshot: null`）
- 人读诊断信息全在 stderr

## 环境变量

| 变量 | 说明 |
|------|------|
| `FLYWHEEL_BRIDGE_URL` / `BRIDGE_URL` | Bridge 地址（必需） |
| `TEAMLEAD_API_TOKEN` | Bridge bearer token（`/api/reports/*` 必须有 token 才会服务） |
| `FLYWHEEL_REPORTS_DIR` | registry/previews 根目录（默认 `~/.flywheel/reports`） |
| `FLYWHEEL_REPORT_SHOT_WIDTH` | 截图 viewport 宽度 px（默认 860 ≈ 报告内容宽；320-3840）。截图 = **全页 @ 2x**（Annie 拍板形态:图扫结构+链接细读）;2x 失败或 >25MB 自动降 1x 重试,再失败降纯链接 |
| `BLOB_READ_WRITE_TOKEN` | 私有 Blob 凭据，每次操作读取并固定到上传、补偿和清理。未配 → publish 501，与 registry store 不符 → 503。 |
| `REPORT_HOSTING_VERCEL_TOKEN` | 报告账号专用 Full Account token；水位检查按调用读取，不回落到 `VERCEL_TOKEN`。新 CLI 模式使用显式指定的环境变量。 |
| `VERCEL_TOKEN` | 旧 `/api/publish-html` 按调用读取；无参数首次迁移保留该历史接口。529 slot 独立随机凭据仍用于 loopback host 鉴权。 |
| `FLYWHEEL_REPORT_HOST_OVERRIDE_URL` | **仅 529 台架内部**：严格的 `http://127.0.0.1:<port>` 托管 seam；由 slot wrapper 在 exec Bridge 时注入。生产不要设置；远端、别名、路径或 query 形状会拒绝启动 |

报告链接固定保留 14 天。稳定网关直接使用 Blob `get()` 结果自带的 `blob.uploadedAt`；迁移对象则
使用随网关部署的原始 `createdAt` manifest。读路径无法取得有效时间时记录固定、无凭据错误并
fail-closed 502，绝不静默延长。Bridge 每日按 registry 中的原始 `createdAt` 回收已到期对象；
registry 时间无效时，删除器只回落到同次 list 返回的 Blob `uploadedAt`，回落值也已满 14 天才删，
两者都不可得或 Blob 仍年轻则保留。正常发布也会顺手清理本地 registry 中刚到期的对象。没有数量
上限、总字节上限或环境变量旁路。

## 工作原理（一图）

```mermaid
sequenceDiagram
    participant A as Agent
    participant CLI as flywheel-comm publish-report
    participant B as Bridge
    participant G as 固定 Vercel 网关
    participant O as 私有 Vercel Blob
    participant Q as 529 loopback report host
    participant D as Discord

    A->>CLI: --html report.html --project flywheel
    CLI->>B: POST /api/reports/publish
    alt 生产
        B->>O: PUT 单份私有 HTML 对象
    else 529 override
        B->>Q: 部署 slot 内完整在保文件集
    end
    B-->>CLI: {url, reportId}
    CLI->>CLI: proofshot 全页 2x 截图（失败/超 25MB → 1x → 纯链接逐级降）
    CLI->>B: POST /api/reports/deliver
    B->>D: 一条消息：截图附件 + 链接
    alt 生产
        D->>G: GET 原有 /r/&lt;token&gt;/ 链接
        G->>O: 鉴权读取单份对象
        G-->>D: HTML + CSP 响应头（未满 14 天）
    else 529 override
        D->>Q: GET slot-local /r/&lt;token&gt;/ 链接
        Q-->>D: HTML（仅当前 Bridge cycle）
    end
```

## 隐私模型（Annie 拍板）

- "Anyone with link"：URL 路径含 128-bit 随机 token，不可猜（等价 signed URL 强度）；域名带随机后缀
- 根路径/错误 token 404，无目录列表；`robots.txt` Disallow all + `noindex` meta 注入
- CSP meta 注入（`default-src 'none'; style-src 'unsafe-inline'; img-src data:`）—— 防报告内意外 `<script>`/外链跑起来
- Blob 对象为 private，浏览器拿不到 Blob 直链/凭证；固定网关按 token 代取，并与发布器共用同一 HTML scanner，把报告内的 CSP（含 nonce）同步为 HTTP 响应头
- Retention：**每份链接从创建起完整可访问 14 天，精确到期后 404**；没有会提前挤掉报告的 count/bytes 上限

## 注意

- **生产每次发布 = 一个 Blob PUT，零 Vercel deployment**；发布吞吐和 Vercel deployment 速率/配额解耦
- 从旧的全量部署模型切换时，严格执行下面的生产切换运行手册；不要颠倒 Bridge restart、migration 与 marker 的顺序
- `~/.flywheel/reports/registry.json` 损坏时管线仍拒绝发布；按错误提示修复，不能静默重建稳定域名和迁移状态
- 生产 Bridge 不设置 override：Vercel 请求、公开 URL 与旧 `/api/publish-html` 行为保持不变
- 529 override 生效时，`FLYWHEEL_REPORTS_DIR` 固定到 `${SLOT_DIR}/state/reports`，发布目标固定到 slot 的 loopback host；它用完整在保文件集替换 slot-local site，不访问 private Blob、生产 Vercel 或生产 `~/.flywheel/reports/{registry.json,previews}`
- Simba triage 仍走老的 `/api/publish-html`（固定 URL，byte-compat 未动）；迁移是后续 issue

## 生产切换运行手册

1. 在重启前确认 registry 中的稳定 `fw-reports-*` 项目名，并把同一个 private Blob store 的
   `BLOB_READ_WRITE_TOKEN` 配给 Bridge 与该 Vercel project 的 production target；不要打印 token 值。
2. 构建并重启含本改动的 Bridge。**从这次重启开始，到 migration 成功写入 durable cutover marker
   为止，所有新的 `publish-report` 都会 fail-closed 503；这是有意、可观测的发布停机窗口。**旧链接
   此时仍由旧 production alias 服务。
3. 运行 `pnpm migrate:report-hosting`。命令先迁移仍在 14 天内的旧报告，再发布一次固定网关，并最长
   5 分钟轮询到 Vercel 明确返回 READY/ERROR，最后才原子写 marker。若 reports 目录为空，首次运行会
   只持久化稳定项目名并在 production env preflight 停止；按该名称创建 project、接入 token 后重跑。
4. 只有看到 deployment READY 且 registry marker 已写入，发布停机窗口才结束。上传/部署/marker
   任一步失败都保持 publish 503；修复后重跑同一幂等命令。production alias 已切换但 marker 写入失败
   时也必须重跑，不能手工跳过 marker。
5. 用一个迁移前旧 token 和一个新发布 token 分别验证：14 天内返回 200 + CSP response header，
   精确到期返回 404；确认后再宣布切换完成。

## 529 override 下的 `/api/publish-html` 生命周期

`/api/publish-html` 的旧实现返回固定 Vercel URL，无法表达 529 loopback host
生成的可访问地址。因此 override 生效期间它会 fail-loud：无论
`VERCEL_TOKEN` 是否存在都返回 HTTP `503`，错误正文要求改走
`flywheel-comm publish-report`；不会调用旧 deploy，也不会假装成功。

关闭条件只来自 Bridge 的启动环境，没有运行时开关。生产 Bridge 从不设置
`FLYWHEEL_REPORT_HOST_OVERRIDE_URL`，所以旧路由不受影响；529 房内若要解除，
必须 teardown 后在没有 override 的环境重启 Bridge。slot 内正确的报告通路始终
是 `/api/reports/publish` + `/api/reports/deliver`。

slot wrapper 与 Bridge 共用进程身份：wrapper 先起 host、确认 bearer
self-check 成功，再 `exec` Bridge；host 持续校验父 PID，Bridge 停止后自退。
Bridge cycle 会分配新端口，旧 Discord loopback 链接失效，需在新 host 上重新
publish；teardown 不维护独立 report-host pid/stop 逻辑。

## 账号轮换运行手册

Bridge 从 `${FLYWHEEL_STATE_DIR || ~/.flywheel}/.env` 按 mtime/size 变化热读凭据。文件不可读或键缺失时回落进程环境，显式空值表示未配置。CLI 只读取显式指定的进程环境变量，不读取或修改该文件。

首次升级：

1. updater 正常窗口部署 Bridge。registry 没有 `gatewayFormat` 时继续写明文。
2. operator 配置并在 shell 导出当前报告账号的 `REPORT_HOSTING_VERCEL_TOKEN`。运行 `pnpm migrate:report-hosting --usage-check --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN --store-id <当前-store-id>`，确认 store 与当前网关相连后补录缺失的身份。
3. 运行 `pnpm migrate:report-hosting --deploy-gateway-only --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN --blob-token-env BLOB_READ_WRITE_TOKEN`。双格式网关部署及四项探针通过后才写 gzip-v1 数据门；后续 HTML 使用 gzip level 9，audit JSON 保持明文。

retarget 对未标记的历史报告从权威 Bridge 数据库的 epic_page_publication 表只读恢复 Epic 稳定 token 身份。默认读取 ~/.flywheel/teamlead.db；自定义部署设置 TEAMLEAD_DB_PATH。数据库缺失、损坏或身份冲突会在远端变更前以 exit 2 停止，不猜测普通报告身份。新 Epic 发布直接持久化 mutable 标记。

storeId 用于不区分大小写的本地比较，storeApiId 保留 Vercel API 资源 ID 的原始大小写；手工补录时传入 dashboard/API 返回的完整 store ID。

轮换日：

1. 新 Hobby 账号创建 Full Account token，导出到 `REPORT_HOSTING_VERCEL_TOKEN_NEXT`。
2. 运行 `pnpm migrate:report-hosting --retarget --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN_NEXT --project-name fw-reports-<新6hex>`。可用 `--blob-token-env <ENV_NAME>` 提供目标 store 的 RW token。
3. 命令创建或重验项目、私有 store、连接，搬运保留期报告，部署并验证网关，再以 registry CAS 切换。并发 publish 导致快照过期时最多补跑三轮。
4. 成功后按最终 JSON 的 envHint 修改两行凭据。解密 token 只写入 reportsDir 的 `retarget.<project>.secrets.env`（当前 uid、0600、单行），终端只输出路径。粘贴后删除文件。marker 已切而凭据尚未切时 publish 返回 503，这是有意的交接窗口。
5. 不重启 Bridge。运行 `publish-report --publish-only` 并检查日志中的新 `store=<前8位>`。复跑同一 retarget 命令应跳过已证明的上传、部署及探针，每次仍重验项目/store/连接。

退出码：0 成功；1 远端或验证失败；2 参数、前置条件、锁争用或创建结果不明；3 等待 dashboard 凭据交接。创建 POST 结果不明时不会自动再建：到 dashboard 查 journal 中的名称，存在则带 `--store-id` 恢复，不存在则带 `--abandon-store-intent --store-name <新名称>` 归档后重跑。命令不删除旧账号资源。

网关按 gzip magic 识别明文与压缩对象。接受 gzip 时返回 Content-Encoding: gzip，无该能力或 gzip;q=0 时返回解压明文，两者都有 Vary: Accept-Encoding。损坏或解压超过 1 MiB 的对象返回 502。普通报告保留原始 createdAt 的迁移 manifest 时间语义；Epic 稳定 token 排除冻结 manifest，按最新对象 uploadedAt 计算保留期，刷新后不会被首次迁移时间永久挡住。单独部署网关保持这一区分。

固定 Epic 页只有内容 digest、hosting 绑定变化或上次成功发布满 24 小时才上传；digest 忽略时间戳、freshness 和 version。跳过时不刷新成功发布记录。跨 token 不共享对象，每条链接独立保留 14 天。

## 水位检查与回滚

Bridge 无条件安装小时级水位定时器，启动先查一次。按 founder 本地日期去重；存储达到 800,000,000 bytes、配额超限或 limits-exceeded 状态时，以 infra 身份发往 FLYWHEEL_NOTIFY_CHANNEL。正文含 count 和 retarget 命令，不含凭据。attempting 保留 30 分钟，失败退避 60 分钟，每日最多 6 次；换日或换 store 重新计数。该告警覆盖存储和状态，不代表带宽或操作次数有余量。

`--usage-check --vercel-token-env <ENV>` 只打印用量，不发通知或写通知回执。带 `--token <32hex> --blob-token-env <ENV>` 可读取对象存储字节数。交接文件尚在时会显示其年龄。

回滚需要匹配的 registry 和凭据：确认无并发 publish、registry 锁未持有后，由 operator 恢复 `registry.json.bak-*`，再恢复旧账号的两行凭据；旧账号必须仍可用。回退 Bridge 可恢复明文写入，双格式网关可继续使用，新数据库列和回执键可保留。
