# FLY-2389 私有下载与保留期 — 调研
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: exploration.md

## 结论

复用 B0/B1 的单一 manifest 和全部写入防线；新增真实 R2 GET presigner、最小 cleanup capability 与自动执行，修正 key 覆盖和上传收尾竞态。无需数据库、对象 key 迁移、签名 license 或账户系统。平台事实已查官方来源；工程取舍经 Lead 问题 `6fb0c951-9ca7-4bb4-ae8b-ff7734ea14fe` 确认。

## 当前代码与消费者证据

审计基线：`42869f935`（工作树已有 B0/B1）；设计进度提交 `ed4f61202` 不含实现。

| 文件 / 入口 | 当前事实 | B2 影响 |
|---|---|---|
| `packages/release-contract/CONTRACT.md` §2–4 | 双通道、精确视图、固定 `payloads/<ver>/<sha>.tgz`，C-5 re-pin 重置时钟 | 复用，追加行为修订，schemaVersion 仍为 1 |
| `packages/release-contract/src/grammar.mjs:27` | 唯一 14/28 天常量 | 不在新配置复制保留期数字 |
| `packages/payload-endpoint/src/handler.mjs:92` | 每请求从 `keys/<sha>.json` 读 key，拒 revoked | 保留即时停止新授权，不缓存 auth |
| `handler.mjs:160` | visibleEntries 选 entry 后直接 bucket.get/body | 改为先 head，目标模式返回 302 presigned GET |
| `handler.mjs:117`、`:392` | PUT post-check 只接受 live op，忽略已 commit 的 active entry | 必须补竞态保护，保留 tombstone 优先 |
| `handler.mjs:463`、`:547` | key PUT 无条件覆盖；revoke 无条件写 revoked=true | PUT 条件创建、禁止恢复或变档，revoke 幂等单向 |
| `src/views.mjs:15` | 只按 status 和 entitlement 筛选，没有到期时钟 | 在同一可见集增加历史截止，manifest/payload 同用 |
| `src/transitions.mjs:244–290` | 服务端 stamp 退任/隔离时间；current 拒 expire；重新 current 清零 | 保留，cleanup 只提案，服务端重验 |
| `src/transitions.mjs:298` | ops-admin 允许 expire/tombstone，还能 abandon | cleanup 只增加 expire/tombstone 两种写能力，不允许 abandon |
| `src/worker.mjs`、`wrangler.toml` | 单一 PAYLOADS binding；注释仍称 founder 手工部署 | 同步 B1 已更新的 CI activation 注入路径，显式目标 presign 模式 |
| `src/serve-node.mjs` | 本地 FsBucket 直接服务字节 | 显式 stream 模式，不能成为生产缺 signer 时的隐式 fallback |
| `scripts/release/license-key.mjs` | stdlib randomBytes(32)、SHA-256；issue→revoke rotation | 复用，修正“下一请求即时”文案，错误脱敏 |
| `scripts/release/payload-cleanup.mjs` | expire CAS → tombstone CAS → 全量删除重扫；dry-run 默认；失败 exit 2 | 增 cleanup token 输入，保留 ops 手动兼容，不新增删除执行器 |
| `scripts/release/lib/endpoint-client.mjs` | 规范 ETag、CAS retry 每次重新读写 | 自动清理复用，不复制 CAS 客户端 |
| `packages/onboard-shell/lib/endpoint.mjs:89` | 原生 fetch 默认跟随重定向，随后按 manifest SHA-256 验字节 | 保持返回体；补真实跨 origin 测试及固定错误文案防 URL 泄漏 |
| `scripts/release/lib/endpoint-client.mjs`、B1 upload/readback | 管理员回读用 `/admin/payload/:ver/:sha` | 保持认证 stream，不能用客户 key 读取未提交 staging |
| `.github/workflows/payload-activation.yml` | main + release environment；infra/publish 分离；vendor secret 仅 infra | 新 signer、cleanup hash 仅 infra 注入；不改 publish 授权 |
| `.github/workflows/ci.yml:1291` | endpoint unit / contract / key-cleanup / B1 / customer-E2E / credentialless Worker bundle | 新测试接此 job；不跑会触及 GUI 的根测试 |
| `scripts/__tests__/release-workflows-structure.test.sh` | S4e 精确 secret 白名单、S12 activation 分步 guard | 新 secret 必须同步机器约束，不能简单扩大所有 workflow 权限 |
| `doc/engineer/implementation/fly-1062-payload-release-runbook.md:76` | 明确未定时：ops-admin 能签客户 key | B2 增 cleanup-only 后替代该暂缓说明 |

## 平台事实（2026-09-09 查证）

- R2 presigned URL 是限定对象、HTTP 方法和时限的 bearer capability；用 S3 API host，不能把它换成公共自定义域名。签名生成不联系 R2，因此签名前独立校验权限和 head 存在性。[Cloudflare presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- Workers R2 binding 没有原生 presign 方法。官方给出 `aws4fetch`，使用 Fetch 与 WebCrypto，适合现有 Worker。当前 lockfile 没有 AWS signer；实现应只增加 `aws4fetch` 的精确版本/锁文件，避免自行实现 SigV4，也不引入整套 AWS SDK。[Cloudflare aws4fetch](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)、[库主仓](https://github.com/mhart/aws4fetch)
- R2 原生生命周期按前缀和时间作用，不能读取 manifest；删除通常有异步延迟，规则数量也有限。故不能把“撤掉规则后 re-pin”当原子免死。[Cloudflare object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- R2 Object Read only token 可以限定 bucket，但允许读与列对象，不是端点用户的 entitlement。只留在 Worker；调用者拿到的签名只授权确切 GET，改 key/list/PUT 都不通过。[Cloudflare authentication](https://developers.cloudflare.com/r2/api/tokens/)
- Fetch 标准在跨 origin 重定向时移除 Authorization。这支持保持壳下载接口；仍需 Node 实际 HTTP 集成证明头未送到对象 origin，不能靠 handler stub 推定。[WHATWG Fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)

## 当前验证与限度

执行 `node --test packages/payload-endpoint/__tests__/handler-customer.test.mjs packages/payload-endpoint/__tests__/lifecycle.test.mjs`：**28/28 PASS**。初次运行因工作树缺 workspace package link 报 ERR_MODULE_NOT_FOUND；随后 `pnpm install --filter flywheel-payload-endpoint --ignore-scripts --frozen-lockfile` 完成环境准备后通过，未改锁文件。它们证明现有视图与 CAS 基础，**不证明 presign、真实 R2 或自动清理已实现**。

独立只读研究用现有 MemoryBucket 注入 race：PUT 已写入，返回前完成 prepare+commit；收尾结果为 `PUT 409 / latest=1.55.0-beta.2 / status=active / objectExists=false`。这支持计划中的 current 对象保护；实现须把此交错固化为红→绿测试，不能把口述复现当永久测试证据。

## 最小实现方向

1. 授权入口仍是 `/manifest`、`/payload/:ver`；机器身份不变，UI 展示名仍用 `v` 前缀，禁止新增 npm payload-channel 真相。
2. 固定配置选择 stream 或 presigned：Worker 明确 presigned，Node 明确 stream。缺 signer 在 presigned 模式 fail closed。
3. 一套可见集决定 manifest/payload，对未到清理时机但已超过保留窗口的历史记录停止新签名。
4. 自动清理只持 cleanup token，所有写仍通过原 handler + transition validator；schedule 不接 release gate，也不发布新版本。
5. 验收分三层：确定性时钟/竞态夹具、真实 Node 跳转与 B1 联合链、独立 QA 的隔离真实 R2 证据。设计阶段不执行真实发布/部署/签发。

## 文档与工具约束

项目 CLAUDE.md / product-experience-spec 已完成 onboarding。使用现存 research/write-plan 技能工作形状，任务 DOC-FLOW 和指定 review 命令覆盖旧文件名、版本 bump、人工 brainstorm gate 与实现建议。未找到独立可读的 brainstorm/diagram-design/codex-design-review/html-report-style 技能文件；对应意图按任务合同手动执行：设计审计、Mermaid 本地渲染、request-driven review。HTML 视觉沿用 B1 的 Apple-light 模板，仅零依赖单脚本交互。
