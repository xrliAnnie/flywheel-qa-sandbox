# FLY-2389 私有下载与保留期 — 实施记录
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: plan.md

## 执行依据

TURN implement epoch=2 已取得。设计 question `24197080-096a-4965-a57f-645a6fdd84f1` 当前 check 返回 `reviewVerdict=APPROVED`，request `378ae9e4-5e7e-4160-8e11-2332862d8e84`；plan blob 保持 `94accef02c6b80f663285c8b0a620b09f78766f4`。设计附录的十项 advisories 不是治理裁定；实施不修改 pinned plan。

## C1 当前对象与授权码保护

- RED：同 key 重放实际写入两次（预期一次）；重复 revoke 实际第四次写入（预期保持三次）；超长 customerId 被接受 200（预期 400）。对应修复为条件创建、零写重放、单向吊销与 4 KiB 实际流读取上限。未知字段、变档、复活、损坏记录均拒绝。
- RED：对象 PUT 落字节后、响应返回前，真实 handler 的 prepare 与 commit 均返回 200，PUT 仍返回 409 且删除 current。修复后承认已提交的非 expired VersionEntry；abandon/tombstone 的 PUT 仍 409，但不直接删除。删除由既有 tombstone sweep 执行。
- RED：实际 license CLI 在 loopback 503 响应中回显非受控服务端 error。修复后只报固定操作/HTTP 状态；rotation 新签失败不 revoke，旧 revoke 失败明确给出单独重试命令，不重复签发。
- GREEN：`node --test packages/payload-endpoint/__tests__/*.test.mjs`：71/71，exit 0。
- GREEN：`bash scripts/__tests__/payload-key-cleanup.test.sh`：19/19，exit 0。
- `pnpm exec biome check --write` 仅处理三个修改的 mjs，exit 0；`git diff --check` 通过。

以上为 C1 局部门禁，不是全仓 lint/build/test、代码评审或真实 R2 验收。C2–C6、全仓门禁、PR 与 needs_review 完成收据仍待执行。

## C2 可见集与真实签名

Lead instruction `10b63b4b-4367-4b59-9802-bffdd36d99dd` 已 ACK：七项建议纳入实现，三项仅记录边界；其中到期后回指由 Lead 明确裁定拒绝，不修改 pinned plan。

- RED：库默认 presign 的解析 query 违反 <=60 秒；依赖精确锁定 `aws4fetch@1.0.20`。薄 signer 显式 GET、auto/s3、起始秒和 TTL，固定账号 host 与部署 bucket，无任意对象路径。固定 60 秒向量另用 Python hashlib/hmac 独立计算，结果 `7945c337af848ecd0ab2e96dc60b0a2097f128238c2f1f0d0d1a20c0875079e9`，与库输出一致。
- RED：旧路径返回 stream 200、缺配置也返回 200、对象缺失仍发 302；修复为显式模式、完整 manifest validator、HEAD hash/size 检查与固定 503/404。五个直接调用方全部显式注入，Worker 使用 presigned，四个本地调用方 stream。
- RED：auth/head/sign 卡顿后仍返回链接；修复后签名始于 auth I/O 前的 requestStartedAt，签前/签后检查绝对截止。历史只剩 20 秒原返回 60，修复为截止向下取整，current 仍最多 60 秒。
- RED：历史到期仍 200、到期回指仍 200；读取当场过滤，回指在截止前 1ms 可行、等于/之后 422 且 manifest 字节不变。current 放置一年仍可读。PUT 设置 private/no-store metadata，签名带同值 response override。
- 夹具修正：serve-node 与 contract server 旧种子缺合法 beta 血缘；现在补足共享合同，未放宽 validator。管理端与 B1 withdraw 的成功夹具旧历史已超期，改为保留窗口内的退任时间；独立新测试明确验证到期拒绝。
- GREEN：端点 80/80；B1 pipeline 42/42；promote-controls 4/4；contract-consistency 五个 real-handler 套件全部通过。首轮 contract 的 npm pack 因默认 cache 路径不可写失败，重跑使用 `npm_config_cache=/tmp/fly2389-npm-cache`；首轮失败不计为通过。
- 来源核对：[Cloudflare presigned URL 文档](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[aws4fetch 上游实现](https://github.com/mhart/aws4fetch/blob/master/src/main.js)。真实 R2 签名拒绝与 cache header 读回仍留独立 QA。

## C3 安装器字节链

- RED：真实双 HTTP origin 302 下载后，对象端 403 被错误归为 unauthorized；原始网络/JSON/传输异常回显底层消息。修复只区分跨 origin response 与端点自身鉴权错误，并固定异常词汇。
- GREEN：`presigned-download.test.mjs` 2/2；真实 fetch/真实 handler/真实 shell 证明授权头未到对象端、hash 正确/错误两侧、有效 key 不因对象 403 被提示轮换。对象传输 origin 替换为 loopback，明确不代表 R2 签名验证。
- GREEN：`npm_config_cache=/tmp/fly2389-npm-cache bash scripts/__tests__/customer-e2e-acceptance.test.sh` 8/8，exit 0；B1 reserve→build→claim→upload→prepare→commit→license→安装与 FsBucket 重启恢复均实际执行。该既有链为 stream 模式，不能代替 QA 的真实 R2 联合证据。

## C4 最小清理能力

- RED：cleanup token 被当作未知 401，重复 capability hash 未拒绝；增加第四 hash，只授权 expire/tombstone/delete，初始化与 key/payload/publish 操作仍拒绝。hash 比较大小写规范化，重复返回固定 503。
- RED：CLI 不认专用 token，两种 token 同传时竟使用 ops 执行了删除；修复为二选一，兼容单独 ops-admin，自动路径使用 cleanup-only。Worker/Node/test serve 显式映射专用 hash。
- GREEN：专用 token dry-run/apply + ops rerun、模糊 token 拒绝，key-cleanup 脚本 21/21；失败 DELETE 后 tombstone 与对象保留，恢复后重扫可删除且 current 保留。端点套件 85/85，exit 0。

## C5 自动运行与配置

- RED：缺 cleanup workflow/native JSON；新增每小时 `17 * * * *`，main + release environment + contents read，独立 `payload-cleanup` concurrency，不取消运行。未配置明确 skip，所有后续步骤由 activated gate 控制；skip 不算清理成功。
- JSON 仅 abort incomplete multipart 7 天；payload/manifest/key 无原生年龄删除。parsed YAML/JSON 对 main/env/skip/秘密范围、共享并发误改、cancel-in-progress 与 native TTL 注入做负向突变。
- 激活顺序固定：输入校验 → bucket create/resume → private domains/live lifecycle 读回校验 → multipart-only 规则应用/readback → signer/cleanup hash 经 stdin 注入 → Worker 部署。新 secret 仅 mode=infra，不进入 publish 或 job-wide env。签名 bucket 与绑定机器比对，账号普通 var 由既有 account variable 注入。
- 可执行 VM 夹具运行 workflow 内原 JS，外部 fetch/child 为拒绝默认的桩；覆盖缺凭据、重复能力、bucket 不符、公开 managed/custom domain、未知/危险规则、HTTP 错误、secret stdin 和明示 skip。既有未知规则不会静默被替换；运行前还需运营按 runbook 核 live diff。
- 锁定 Wrangler 4.111.0 源码确认 lifecycle set 默认会询问覆盖，红测试后显式传 `--force`，且只在上述校验之后调用；新 Worker 的 secret put 在 CI 自动创建 draft 的 fallback 为 true。
- GREEN：activation-config 4/4；workflow structure 23/23；Worker dry-run exit 0，63.81 KiB / gzip 14.82 KiB，metafile 确认 release-contract + aws4fetch + presign.mjs 均入包。没有真实 CF 写入或 workflow dispatch。

## C6 验收补全与全仓门禁

- 双 origin 测试补为同一次真实 B1 client reserve→upload/readback→prepare（customer 404）→commit→presigned GET→真实 shell hash 链；测试 2/2 通过。loopback 对象服务读取刚上传的 bucket 字节，不代表真实 R2 验签。
- 补齐 beta 14 天前/等于/后边界，以及已发链接后 revoke/quarantine 禁止再签发，端点套件 91/91 通过。
- lint exit 0（14 warnings）；首轮 build 因本地缺已声明依赖失败，frozen-lockfile install 后完整 build exit 0，lockfile 无额外变化。
- 首轮全仓 packages exit 1：comm 四个既有 CLI 超时及 onTaskUpdate 超时；失败文件独立 62/62 通过。使用 npm_config_workspace_concurrency=1、VITEST_MAX_FORKS/THREADS=2、VITEST_MIN_FORKS/THREADS=1 降并发完整重跑；不修改测试 timeout 或跳过用例。
- codex:rescue companion 在 thread 创建前遭 sandbox_apply Operation not permitted / helper exit71，未产生 verdict。Lead question 41996fff-2eed-44cb-8677-27e7bab16218 已确认以 Bridge exact-head registered request-review 为代码门禁，不重试 rescue。

- 全仓 R2 仍 exit 1：comm 154 files / 2190 passed / 2 skipped；claude-runner 49 files / 1224 passed / 2 skipped，但 onTaskUpdate RPC timeout 为 unhandled error。Lead question 7272fc03-c4ad-481f-9f4a-0a651af6cd1e 已确认继续补齐六个未运行包、诚实记录两份失败收据，以最终 exact-head CI 14/14 为完整门禁；不改无关测试。
- E1 补全后端点全套再次 91/91 exit 0，最终 lint exit 0（同 14 warnings）。

## 最终本地收据（2026-09-10）

余下六包补跑 exit 1：edge-worker 1318、gemini-agent 157、voice-headphone 54、voice-bridge 649、voice-codex 122 个断言通过；teamlead 926 files / 12452 passed / 7 skipped，但 onTaskUpdate RPC timeout 为 unhandled error。无本次改动断言失败，不主张本地 full-green。Lead 已收到补跑报告，按已确认的 exact-head Bridge review + CI 14/14 路线继续。原文收据存 progress.md 与 PR。
