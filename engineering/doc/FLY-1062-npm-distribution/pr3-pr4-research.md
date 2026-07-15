# FLY-1062 收尾圈(PR3 托管+key / PR4 发布 CI/CD) — 调研

Issue: FLY-1062 (https://linear.app/geoforge3d/issue/FLY-1062/build-buddy-onboarding-分发层-客户-npm-install-安装包零仓库访问替代-curlgit-clone)
日期: 2026-07-11
基于: pr3-pr4-exploration.md(brainstorm gate 已过:范围=PR3/PR4=FLY-1098 的 B2/B1;FLY-1143 留 B3-B6;真 publish+promote=founder gate)

---

## 1. 审计 A:PR2 客户端合同(byte-stable 红线的逐字条款)

服务端(PR3)必须逐字满足 `packages/onboard-shell` 已 ship 的客户端期待:

| 条款 | 客户端位点 | 服务端义务 |
|---|---|---|
| `GET <endpoint>/manifest` + `Authorization: Bearer <key>` → JSON `{latest: string, versions: [{ver, sha256}]}` | `lib/endpoint.mjs fetchManifest()` | 按 entitlement 产出这个**视图**;字段缺失/非 JSON = 客户端 protocol 错 |
| `latest` 与每个 `ver` 必须过 `isSafeVersion`(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`、≤64、无 `..`) | `lib/config.mjs isSafeVersion()` | semver/semver-beta 天然满足;服务端不发怪版本串 |
| `GET <endpoint>/payload/<ver>` + Authorization → tarball bytes(客户端整体 buffer 后验 sha256) | `endpoint.mjs downloadPayload()` | 返回 bytes;`Content-Type` 客户端不看;sha256 必须与 manifest 一致 |
| 401/403 = key 无效/吊销 → 触发 rotation(隐藏重读一次) | `EndpointError kind="unauthorized"` | 无效/吊销/缺 header 一律 401(不区分,防枚举) |
| 其他非 2xx = network 错(诚实话术后退出,零半成品) | 同上 | 5xx/超时自然落这类 |
| update 判据 = `manifest.latest !== 当前版本` | `lib/update.mjs` | entitlement 视图切了 `latest`,同一套端点天然驱动客户 update |
| 端点解析 = `FLYWHEEL_ONBOARD_ENDPOINT` env → `DEFAULT_ENDPOINT` 常量(现为 `.invalid` 占位) | `lib/config.mjs` | PR3/PR4 填真 URL;URL 变更 = 薄壳再发版(壳自身走 npm latest,可接受) |

**推论**:entitlement 分级(internal-beta vs customer-release)完全发生在服务端视图映射,薄壳零逻辑改动——与 gate 批的方案一致。

## 2. 审计 B:打包器版本合同现状 vs B0 派生断言(PR4 必改点)

- `scripts/package-onboard.sh po_version()`:唯一版本源 = `doc/VERSION` 去前导 v(现 v1.55.0 → `1.55.0`)。
- `po_gate()`(≈:796):断言 `package.json == .flywheel-prebuilt 哨兵 == doc/VERSION` **三者逐字相等**。
- FLY-1098 §6.1(B0 合同):`doc/VERSION` 只存 base `X.Y.Z`;beta 发布物 semver = `X.Y.Z-beta.N`(ledger 派生),clean = `X.Y.Z`;CI 断言改为「**是该 base 的合法派生**」而非逐字相等。
- **落点**:打包器加显式注入口(如 `PO_RELEASE_VERSION` env;缺省 = 现状 base,**现有断言路径逐字保留** = reverse-compat sentinel),`po_gate` 版本断言在注入时改验派生形态(`^<base>(-beta\.[0-9]+)?$`);beta N 计数放 release ledger(见 §6)。

## 3. 审计 C:发布安全门与 publish gate 现状(全部已存在,PR4 只做接线)

- payload 侧 4 道门(`po_gate_tarball`,pack 后解包验):secret-scan(`scripts/lib/fleet-sanitize.sh:168 scan_for_secrets`)+ 白名单 snapshot + 零 .ts/src/__tests__/doc/.git + 零仓库访问 grep(allowlist = `scripts/packaged/audit-grep-allowlist.tsv`)。CI 已每次跑(`ci.yml` package-onboard 套件 + 真 npm smoke)。
- 薄壳侧 publish-content gate(PR2 落):`packages/onboard-shell/__tests__/onboard-shell-publish-gate.test.sh`——pack 产物 = bin/lib/README/package.json 白名单、零私仓 URL、`private:true` 锁发布。**PR4 解锁点**:去 `private:true` 时必须同步把「private 锁」断言换成「发布形态断言」(publishConfig/access 明确),gate 其余逐字保留。
- `scan_for_secrets` 需补 license key pattern(research §10 既定):key 造型定为 `fwk_<hex>`(见 §5),pattern 直接匹配 `fwk_[0-9a-f]{32,}`,零误报面。

## 4. 审计 D:vendor 事实核验(文档级已核;真机核验项标注给 implement/P5)

1. **R2 条件写(CAS)**:Workers R2 binding `put(key, value, {onlyIf: {etagMatches | etagDoesNotMatch}})` 真实存在;条件不符 `put()` 返回 `null`(不落盘)。`get()` 同支持 `onlyIf`。→ manifest CAS 可用原生机制,无需 Durable Object。(来源:developers.cloudflare.com/r2/api/workers/workers-api-reference/)【真机核验:P5 用真 bucket 验一次冲突路径】
2. **R2 一致性**:R2 读写强一致(read-after-write),对「吊销即时生效」是关键——per-key 对象存储下吊销写入后下一次请求即拒。(来源:developers.cloudflare.com/r2/reference/consistency/)【同上真机验】
3. **Workers 响应体积**:Cloudflare 不对 Worker 响应体积设限;isolate 内存 128MB → **必须流式**(R2 body 直接透传 Response,不 buffer),几十 MB tarball 免费档可行。(来源:developers.cloudflare.com/workers/platform/limits/)
4. **npm trusted publishing(OIDC)**:GA(2025-07);**私有 GitHub repo 可用**(OIDC 发布机制不要求公开仓);**provenance 私仓不生成**——与 FLY-1098 §7.2 的更正一致,发布姿态 = trusted publishing + npm 账号 2FA,不承诺 provenance。(来源:docs.npmjs.com/trusted-publishers/;github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)【注意:dry-run 不验证 OIDC 信任关系(见 §4-9);OIDC 验收 = 真实下一版本 publish】
5. **Workers KV(备选注记)**:最终一致,边缘读可 stale 至 ~60s → 吊销有窗口。这是把名单从 KV 改到 R2 per-key 对象的直接原因(§5)。
6. **undici redirect(D1b fallback 注记)**:Node fetch 跨域 redirect 剥 Authorization header——若将来切 presigned 302,key 不会外泄到存储域;v1 不用。
7. **GitHub environments 的私仓限制(Codex R1#1 补核)**:required reviewers 等 environment 保护规则在**私有仓只对 GitHub Enterprise 计划可用**(Free/Pro/Team 仅 public repo 生效——Codex R2#1 更正),且 repo 管理员默认可 bypass。→ founder gate 不能只押在 environment 上:凭据 custody 才是结构性底线(见 plan §3)。(来源:docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
8. **R2 object lifecycle 只按对象年龄/日期 + prefix 运作**(Codex R1#5 补核):不读 manifest、不因指针切换重新计时 → 「supersede 后 14/28 天、current 永不过期」**无法用 bucket lifecycle rule 表达**;对 payloads/ 配年龄规则会删仍在 serving 的 current。→ 本圈零破坏性 lifecycle 规则,retention 用 manifest 的 pointer-tenure 钟 `retentionSince`(离开 latest 盖章、re-pin 清零;plan §B0-10)+ 带 current-guard 的显式清理脚本(自动化归 FLY-1143)。(来源:developers.cloudflare.com/r2/buckets/object-lifecycles/)
9. **npm trusted publishing 前提与 bootstrap**(Codex R1#6 补核):要求 Node ≥22.14 + npm CLI ≥11.5.1 + GitHub-hosted runner + workflow `id-token: write` + package.json `repository.url` 精确匹配;**trusted publisher 只能在已存在的 package 上配置**(首发 bootstrap 必须走别的路);`--dry-run` 不验证 OIDC 信任关系(错误只在真 publish 时暴露)。(来源:docs.npmjs.com/trusted-publishers/)
10. **R2 put 的存储侧校验**:`R2PutOptions` 带 `sha256` 字段——上传时 R2 对流做校验,Worker 无需为「回读验 hash」整体 buffer;发布客户端再从下载路径流式 hash 复验。(来源同 §4-1)

## 5. 审计 E:key 名单存储选型细化(**对 gate 批复的一处基底替换,需 review 确认**)

gate 消息写的是「Workers KV key 名单」;调研发现 **R2 per-key 对象**在同一「服务端名单」形态下严格更优:

| 维度 | Workers KV | **R2 per-key 对象(主选)** |
|---|---|---|
| 一致性 | 最终一致(~60s stale)→ 吊销延迟 | **强一致 → 吊销即时** |
| 签发/吊销并发 | 每 key 独立条目,无冲突 | 每 key 独立对象 `keys/<sha256(key)>.json`,无冲突、零 CAS |
| 供应链 | 多一个 KV namespace | **复用同一私有 bucket**(payloads/manifest/keys 一处) |
| 读延迟 | 边缘快 | 一次 R2 get(几十 ms),对安装场景无感 |

对象内容:`{customerId, entitlement: "customer"|"internal", revoked: bool, createdAt, note}`;**存 sha256(key) 为名,明文 key 永不落存储**。key 造型:`fwk_` + ≥128-bit 随机 hex(前缀供 secret-scan 精确匹配)。签发/吊销/轮换 = runbook 一条命令,经端点的 ops-admin 路由写(所有写经 Worker 单一收口;初稿的「wrangler 直写不建管理端点」被 Round-1/2 推翻——直写绕开 validator 且要求把 Cloudflare 主凭据下放)。**此替换属实现基底(产品形态不变),在 plan 里明标,交 Codex design review + Lead 过目确认。**

## 6. 审计 F:manifest 真相与发布状态(B0 v1 子集的存储形态)

- R2 单对象 `manifest.json`(内部形态)——**schema 权威版本 = plan §B0-2**(Round-3 后含 `status: active|quarantined|expired`、`retentionSince`/`quarantinedAt` 生命周期钟、`sourceCommit/releaseId/derivedFromBeta` lineage、以及 **`releaseOps` 发布操作账本**——预约/候选/提交/放弃全并进同一对象,单 CAS 消灭跨对象事务窗口,Codex R3#1);本节初稿的两字段枚举已 superseded。
- **视图映射**(Worker 内纯函数):internal → latest=internal-beta、versions=全部 status=active;customer → latest=customer-release、versions=仅 channel=release 且 status=active(留 `flywheel install <旧版>` 的窗口内旧版路径,FLY-1098 §8.3)。
- **beta N 计数**:releaseLedger 挂在 manifest 内(同一 CAS 事务里递增)——不另开存储,满足 §6.1「ledger 派生」。
- **immutable 上传**:payload 对象 key 含 sha256;「已存在即拒」由**端点原子强制**(409-on-exists 判定与写在 handler 单点收口;绝不用非原子的「先 head 后 put」两步——Codex R3#3 废止初稿措辞);**manifest 是唯一 commit point**(FLY-1098 §7.3-2),CAS 失败=未发布,旧指针继续可用。
- **单飞**:GitHub Actions `concurrency: {group: payload-release}`(仓内已有 ship-pr-<n> 同款 idiom)+ manifest etag CAS 双保险。

## 7. 审计 G:founder gate 的机械落点(Tadashi 红线;**本节 Round-2 修订,以 plan §3 为准**)

- **结构性底线 = 凭据 custody,不是 GitHub UI 门**:能切 customer-release 指针的 capability token + Cloudflare 主凭据(R2 write/Worker deploy)都只能在 founder 控制的位置;**任何非-founder workflow 不得持有 vendor control-plane 凭据**(否则被改 workflow 可绕 Worker 直写 manifest 或重部署去掉校验的 Worker——Codex R2#1)。
- GitHub `release-publish` environment + required reviewers 仅在 **Enterprise 计划**对私仓可用(§4-7);计划不支持时 fallback = promote-commit 与**每一次** shell publish 都由 Annie 本地执行(founder-local 2FA / 本机 token),trusted publisher 配置随 gate 可用性再启用。
- 三条发布 workflow 中:beta 线只持 Worker 的 beta-publish capability token(app 级,非 vendor 凭据);promote-commit 与 shell-publish 走 founder gate(environment 或本地形态)。
- 与 ship 门(:cool:/verify-approval)授权源独立(FLY-1098 §2.3),不复用 ship 门记录。

## 8. 审计 H:CI/workflow 现状与新增面

- 现状:`.github/workflows/` 仅 `ci.yml`(测试)+ `ship-on-comment.yml`(:cool: ship)。发布 workflow 全新增,不碰现有两条(byte-compat)。
- 新增三条(全 `workflow_dispatch`,v1 无定时无 auto):`payload-beta-release.yml`(预约→打包→门→版本派生断言→**releaseOps 占位登记(上传前)**→immutable 上传(挂 claim)→回读验 hash→转 prepared→manifest CAS 切 internal-beta;幂等协议 = plan §B0-9)· `payload-promote.yml`(**两段式,Round-2/3 修订,以 plan PR4-3 为准**:prepare 无门——从 beta 的 sourceCommit 构建 clean + 等价证明 + **先在 manifest releaseOps 登记候选 claim(上传前)再上传**;commit 挂 founder gate——只复验已备 artifact 的 sha 后单 CAS 切指针,**gate 后零构建**;撤版模式 = quarantined + 指针回指显式 fallback)· `shell-publish.yml`(founder environment;publish gate→npm publish OIDC)。
- Worker 部署:`wrangler deploy` = **founder custody 的 Cloudflare token 按 runbook 手动执行**(v1 无部署 workflow——vendor control-plane 凭据不进任何 repo secret,plan §3 底线二;端点代码变更频率低)。wrangler 不进 monorepo 生产依赖(独立 devDep 或 npx 即用即走)。

## 9. Annie 动作清单素材(plan 内单独一节、一次问完;此处只登记事实)

1. npm:org/scope 定名(`@flywheel` 归属待查,备选 `@flyview`/`@flywheelhq`)+ npm 账号 2FA + trusted publisher 配置(指向本仓 workflow)。
2. Cloudflare:账号(免费档够用:R2 10GB-month/1M Class A/10M Class B + direct egress 免费;FLY-1098 §9 已研究)+ R2 bucket 创建。**API token(R2 write/Workers deploy)= vendor control-plane 凭据,保持 founder custody,绝不进 repo secrets**(Codex R2#1);Worker 部署为低频 runbook 动作,用她的 token 执行。
3. GitHub:先确认本仓计划(私仓 required reviewers 需 Enterprise,§4-7)→ 支持则建 `release-publish` environment + required reviewer 设她;不支持走本地 fallback(plan §3)。
4. 首客户 key 签发(runbook 一条命令,key 经她手交客户)。

## 10. 风险登记增量(并入 plan;exploration §6 的 1/2 已核销)

| # | 风险 | 缓解 |
|---|---|---|
| 1 | ~~R2 条件写支持面~~ 已核:binding put onlyIf 存在 | P5 真机验冲突路径 |
| 2 | ~~npm OIDC 私仓~~ 已核:可用(无 provenance) | 首发走 founder 本地 2FA bootstrap(§4-9);OIDC 验收 = 下一真实版本真 publish(dry-run 不验 OIDC) |
| 3 | Worker 端点单点(客户装不了) | 诚实话术已在薄壳;端点健康探针进 runbook;R2/Workers SLA 免费档可接受(v1) |
| 4 | manifest/keys 手滑写坏(运维面) | 所有写路径过脚本(带 schema 校验 + CAS + 回读);禁裸 dashboard 编辑进 runbook 红线 |
| 5 | key 明文只在签发瞬间存在 | 签发脚本打印一次即弃;存储只有 sha256;泄露=吊销+换发(PR2 rotation 通道已 ship) |
| 6 | 打包器版本注入口破坏现有断言 | 缺省路径逐字保留 + sentinel 测试(项目家规) |
| 7 | endpoint 常量烧进已发布薄壳 | URL 用自有域(或 workers.dev)一次定妥;env override 兜底;壳可 npm 再发 |
