# FLY-2283 报告链接固定保留 14 天 — 实施记录
Issue: FLY-2283
日期: 2026-09-03
基于: plan.md

## 1. Founder 返工与最终合同

原 plan.md 记录的是旧方案（把 TTL 改成 14 天，同时继续受共享 count/bytes 上限约束）。
2026-09-03 founder 明确打回该方案：不能把“配置写成 14 天、实际一两天被挤掉”当成交付；
每份托管报告必须完整可访问 14 天，不分档、不加开关。该反馈取代旧方案的容量裁剪部分，
FLY-2289 已取消并入本单；本文件记录实际实施，已通过审查的 plan.md 历史 blob 不回写。

最终合同：

- `publish-report` 返回的 URL、`reportId` 和 `deliver` 合同不变；
- 每份 HTML 是一个 private Vercel Blob 对象，固定网关沿用原
  `https://fw-reports-*.vercel.app/r/<token>/` 链接；
- 正常 publish 恰好上传一个对象，不创建 Vercel deployment；
- 网关从报告创建时刻起在精确 14 天边界返回 404，14 天内返回 HTML；
- 删除 count/bytes retention cap，任何未满 14 天的报告都不会被容量挤掉；
- 无 tier、env retention override 或项目级旋钮；
- 既有链接通过一次性迁移原 token、正文和原 `createdAt` 平滑切换。

## 2. 实现

### 正常发布路径

`ReportRegistry.stagePublish()` 只做单份 HTML hardening、token/metadata staging 和固定 14 天
年龄裁剪，不再组装全量 Vercel deployment，也不按数量/累计字节删除。`reports-route` 要求 durable
cutover marker 已存在，然后调用 `VercelBlobReportStore.putReport()` 一次并提交 registry。
Blob upload 失败时不落本地状态；本地 commit 失败时 best-effort 删除 orphan Blob。每次成功
publish 会 best-effort 删除本次发现的到期对象。

private Blob 使用确定性 `r/<32hex>/index.html` pathname、`access: private`、无随机后缀。
实现校验 SDK 返回的确实是预期 private Vercel Blob URL；public store 配错时 fail closed。
Bridge 每小时遍历 `r/` prefix，新对象按 SDK `uploadedAt`、迁移对象按 registry 原 `createdAt`
回收。gateway、cleaner、registry 与 migration 共用 `report-retention.ts` 的同一个判定函数，精确
采用 `now - createdAt >= 14d`（到点即过期）；cleaner 抖动不会延长网关可访问时间。
共享 helper 保持纯函数语义；各 caller 在调用前按用途处理 invalid createdAt：gateway 返回 502、
migration 中止、registry 在登记统计中按过期移除，但不会把该条目列入 publish 后的远端删除清单。
Blob cleaner 的不可逆删除口径更保守：registry
时间无效时回落到 Blob `uploadedAt`，只有回落值也已满 14 天才删除；两者都不可得则保留对象，
并在 store 生命周期内只写一条不含凭据的固定告警。

### 固定网关

一次性部署只包含：

- `api/report.js`：原生 Vercel Node handler；
- `api/report-gateway-html.js`：publisher/gateway 共用的 canonical HTML scanner；
- `api/report-gateway-migration-manifest.js`：仅旧 token → 原 createdAt；
- `api/report-retention.js`：gateway/cleaner 共用的 14 天取等判定；
- `vercel.json`：原 `/r/:token/` 到 handler 的 rewrite；
- `package.json`：`@vercel/blob` runtime dependency；
- `robots.txt`。

网关以 server-side `BLOB_READ_WRITE_TOKEN` 读取 private Blob，不暴露 Blob URL。它校验 128-bit
lowercase hex token，普通新报告按 Blob `uploadedAt`、迁移报告按原 `createdAt` 执行 14 天边界。
返回时从已 harden 的 HTML 提取 CSP（包括交互报告 nonce）并同时写入 HTTP
`Content-Security-Policy`，另写 `private, no-store`、`nosniff`、`DENY` 与 noindex 头。publisher
拒绝带 CR/LF 的 author CSP；gateway 对历史坏对象的 header construction 也捕获并显式返回 502，
不会让 `new Response()` 异常升级成 500。凭证、Blob 读取或 CSP 缺失均 fail closed。

QA attempt 3 发现原 A6 用例断言的是 URL report token，而不是 Blob 凭据，且没有经过真正会插值
上游异常正文的路径。最终用例让 Blob `uploadedAt` accessor 抛出内嵌 Blob 凭据常量的错误，并直接
断言最终日志不含该凭据。gateway metadata、publish route 的 stage/upload/commit/cleanup failure、
定时 retention sweep，以及 migration CLI 顶层 failure 均只记录固定操作上下文，不再插入不受信任的
上游异常正文。

### 一次性迁移

`pnpm migrate:report-hosting`：

1. 要求本机 `VERCEL_TOKEN`、`BLOB_READ_WRITE_TOKEN`，以及已构建的 gateway runtime、retention
   predicate 与 canonical HTML scanner；在任何外部调用前自动核对 runtime 的每个 local named import
   都由将要部署的对应 module 导出，stale/partial build 会 fail loud；
2. 复用 registry 已有的 `fw-reports-*` 项目名；空 reports 目录则生成并原子持久化一个稳定项目名，
   让首次迁移可以配置后重试而不会漂移；再通过 Vercel project env API 确认该项目的 **production target** 已连接
   `BLOB_READ_WRITE_TOKEN`（只检查 key 与 target，不读取/打印 value）；
3. 把 registry 中仍未满 14 天的报告以原 token 幂等上传到 private Blob；
4. 对原项目只做一次 fixed-gateway production deployment；该 deployment 不含报告正文；
5. deployment READY 后才原子写 `hosting.provider=vercel-blob` marker，Bridge 此后才接受正常 publish。

上传失败时不部署、不写 marker；部署失败时不写 marker；marker 已存在时整条迁移 no-op。
因此重试不会重复切换，且切换前旧 production alias 继续服务旧链接。

## 3. TDD 证据

每项行为均先观察 RED，再做最小实现并回到 GREEN：

- publish 从全量 redeploy 改为单对象 PUT；缺 Blob 或未迁移时 fail closed；
- registry 在 2,500 份、每份 512 KiB 的未满 14 天 metadata fixture 下保留全部报告，证明没有
  count/bytes 早淘汰；
- private store、public-store 误配拒绝、分页 cleaner 与精确 14 天删除；
- gateway stable path、private read、CSP response header、普通与迁移报告精确边界、原始 createdAt
  优先于当日 Blob upload time、原生 Node handler；
- migration 内容隔离、production-scope env preflight、上传/部署失败、durable marker 与重复运行幂等；
- stale scanner named export 在任何 env/upload/deploy 前被拒绝；gateway 与 cleaner 共用单一 `>=`
  retention predicate；
- A6 凭据日志探针先证明 `uploadedAt` accessor 错误正文会带合成凭据标记，再改为固定错误上下文；
  publish route 的 stage/upload/commit 失败路径也分别以含凭据的异常完成 RED→GREEN；
- 第 9 轮审查后的三层时间裁决先用 RED 证明坏 registry 时间会误删年轻 Blob、两个时间都坏也会误删，
  再改为 gateway 502、registry 统计按过期、Blob 删除回落 `uploadedAt`；无可用时间时保留并只告警一次；
- code review 的空目录迁移负例先 RED（缺既有项目名直接抛错），再由 registry 生成并持久化稳定的
  `fw-reports-<6hex>` 名称后 GREEN；publish 的坏时间条目也先 RED（从统计裁剪时误进 Blob 删除清单），
  再把“登记裁剪”和“有充分时间证据的远端删除”分离后 GREEN；
- Bridge 注入 Blob store、missing-token 失败，以及 `BLOB_READ_WRITE_TOKEN` 不进入 full-access
  Codex child 的正向 allowlist；
- publish 连续三次得到三次 Blob PUT；route source sentinel 证明没有 deployment API 调用。

FLY-2276 新增的 inline-script/CSP hardening 与 Blob hosting 合并验证为 Teamlead 报告/Codex-env
focused suite 9 files / 277 tests GREEN；`publish-report` / `verify-report` 另有 116 tests GREEN、1 skipped；
teamlead typecheck 与 build GREEN。production-only credential guard 也遵循 RED
（preview/development-only 凭证被错误接受）→ GREEN。合流时还发现 FLY-2276 允许带首尾空格的
author `http-equiv`，gateway 原解析会返回 502；对应集成用例先 RED（502）后 GREEN（200），CSP
header 内容保持一致。

全仓门禁结果：

- `pnpm lint` exit 0（14 条既有 warning，无 error）；
- `pnpm -r build` exit 0（最终 main merge head 为 21 个 workspace）；
- `pnpm test:packages:run` 在 core 的两个未改动 Terminal.app/HiServices 真机用例因当前
  session 无法连接 macOS GUI 服务而 first-fail；排除该文件后 core 19 files / 219 tests GREEN；
- 后续 package 补偿运行中，claude-runner 39 files / 971 tests GREEN、2 skipped，但 Vitest worker
  在全部断言完成后报 `Timeout calling onTaskUpdate`；
- teamlead full run 为 772 files / 10,143 tests GREEN、6 skipped，6 个未改动测试在全量并发下失败：
  5 个为 5 秒 timeout/时序干扰，相关三个文件立即隔离重跑 61/61 GREEN；余下 1 个是真 tmux
  对含 TAB 的 window name 返回 `invalid window name`，与本单报告路径无关；该 full run 同时有
  同类 Vitest worker RPC timeout；
- QA 在 main 合流后的完整 `git diff --check` 观察到 exit 2，来源是已提交 plan/progress 文档的空白差异；
  因此不再把完整检查记为 GREEN。本单没有新增 `scripts/__tests__/*.test.sh`。

没有放宽 timeout、跳过断言或把上述环境/全量并发失败记成通过。code review 与最终 CI 结果在
完成后补入 milestone。

按合同调用了 read-only `codex:rescue`，但 Claude Code 在 Codex 启动前因当前 session quota
退出；该次尝试不记为 review PASS，也没有使用禁止的 raw `codex exec`。权威结论以合流后
精确 head 的 request-driven cross-family review 为准。

## 4. 规模与运维边界

QA 输入为在册 100 份、平均 71.4 KiB、最大 372 KiB；14 天预计 672–3,830 份、约
47–267 MiB。旧的 10 MiB 单 deployment 模型相差一到两个数量级，不能靠抬 cap 满足。
新模型每份报告独立存储，正常 publish 的网络/构建成本不随在保报告总量增长，也不消耗
Vercel deployment 次数。

上线前的唯一外部前置是 founder/Lead 给 Bridge 和原 report gateway project 接入同一
`BLOB_READ_WRITE_TOKEN`。本 implement 节点不部署、不改外部 canonical
`founder-html-delivery` skill；skill 的 7→14 天文案由 Lead/CoS 跨仓同步。

生产切换顺序必须是：先给 Bridge 与既有 gateway production target 配置同一 Blob store，再重启
含本改动的 Bridge，然后执行迁移。**从 Bridge 重启到 migration 成功写 marker 之间，所有新 publish
都明确返回 503，这是计划内的发布停机窗口。**这样迁移读取 registry 期间不会有旧 Bridge 并发加入
一份未被上传的新报告。迁移部署 READY 并成功写 marker 后，正在运行的 Bridge 会在下一次请求直接
读到它，无需再重启；任一步失败则保持 503，修复后重跑幂等 migration。
