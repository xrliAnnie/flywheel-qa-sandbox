# FLY-1062 · 分发层发布 Runbook(payload 托管 + key 生命周期 + 薄壳 npm)

**Issue**: FLY-1062(PR3/PR4 收尾圈)
**Date**: 2026-07-11

> **A1 — FLY-2388 (2026-09-08):** FLY-2102 已删除 publish broker、socket CLI 与 Bridge token 供给;§7b 只保留退役记录。当前 customer payload 动作走 `.github/workflows/payload-promote-commit.yml`,薄壳走 `.github/workflows/payload-activation.yml` 的 npm OIDC trusted publishing。B1 只提供执行面;founder go / B4 veto 才是授权源。本文不授权执行任何真实 publish、commit 或 withdraw。

---

## 0. 红线(先读)

1. **禁裸 dashboard 编辑 bucket 对象**。一切写(manifest、payload、keys)只走 Worker admin API(validator/CAS/capability 全在那一段代码里);dashboard 手改 = 绕过全部不变量。
2. **Cloudflare API token(R2 写/Worker 部署)= vendor control-plane 凭据**,只允许放在 GitHub environment `release` 的 `CLOUDFLARE_API_TOKEN`;不得放 repo-level secret 或 Bridge env。把它放回该 environment 是 founder 一次性前置,未完成前 infra activation 应 fail closed。
3. **customer-release capability** 只允许放在 environment `release` 的 `FW_CUSTOMER_RELEASE_TOKEN`;B1 workflow 以零构建方式消费。薄壳没有长期 npm token,只用 npm OIDC trusted publisher。两条执行面都不等于授权源:Annie 不 go / B4 不放行就不得 dispatch。
4. **clean semver 永不复用**;发布单飞(Actions `concurrency: payload-release` + manifest etag CAS 双保险)。
5. beta workflow 只持 repo secret `FW_BETA_PUBLISH_TOKEN`(内部 beta blast radius);beta = `schedule` 每 6h + dispatch 全自动(pre-activation guard:`FW_ENDPOINT` 未配时 no-op)。Customer-facing workflow 只在 main 的 `environment: release` job 中运行;`shell-publish.yml` 与长期 npm token 均已删除。

## 1. 一次性初始化(P5 前置;第 2/3 步 = Annie 动作清单第 2 项)

1. 生成四枚互不相同的 capability token(各 ≥32 字节随机 hex,前缀随意,建议 `fwcap_` 便于识别)+ 计算各自 sha256:
   ```
   node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
   ```
   custody:beta-publish → repo secret `FW_BETA_PUBLISH_TOKEN`;customer-release → environment `release` secret `FW_CUSTOMER_RELEASE_TOKEN`;ops-admin → 运营侧(Tadashi/runbook);cleanup → environment `release` 的 `FW_CLEANUP_TOKEN`。Worker 只存 **sha256**，自动清理不持有 ops-admin。
2. Cloudflare(账号**已存在** = Annie 的,登录邮箱 **xrliannie.b@gmail.com**;Peter/GeoForge3D 核实 2026-07-11):
   - **首把 API token 需浏览器登录 bootstrap 一次**(Runner 用 Claude-in-Chrome 替她操作,需要密码/2FA/不可逆确认时才叫她),之后建 bucket / 部署 Worker / 发后续 token **全走 wrangler/API**(Cloudflare 有完整 API,不必再进浏览器)。
   - `wrangler r2 bucket create flywheel-payloads`(R2 大概率未启用,namespace 对我们干净)。
   - `CLOUDFLARE_ACCOUNT_ID`:GeoForge3D repo 的 GitHub Actions secret 同名项,或 dashboard 直接取。
   - **硬边界(绝对不碰)**:该账号 GeoForge3D 在用两块——Cloudflare Pages 项目 `custom-map-studio`(`*.geoforge3d.pages.dev`)+ `memoscaped.com` 的 Email Routing/MX/DNS。我们**只新增** R2 bucket + Worker。
   - endpoint 形态 = **workers.dev** 免费地址(Annie 确认;真 URL 部署后一次定妥,填进 `DEFAULT_ENDPOINT`)。
3. Annie 把 `CLOUDFLARE_API_TOKEN` 放进 GitHub environment `release`;activation `mode=infra` 通过 repo 中的 wrangler 配置部署 Worker,并从三个 capability secret 派生 sha256 后写入 Worker。不得在日志打印明文 token。
4. conditional create 初始化 manifest(beta/customer-release/ops-admin 可用，cleanup 不可;初始 = 双 channel null + 空表):
   ```
   curl -X POST "$FW_ENDPOINT/admin/manifest" -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"baseEtag":null,"manifest":{"schemaVersion":1,"channels":{"internal-beta":{"latest":null},"customer-release":{"latest":null}},"versions":{},"releaseOps":{},"releaseLedger":{},"tombstones":[]}}'
   ```
5. repo variable `FW_ENDPOINT` = Worker URL(workers.dev 或自有域,Annie 拍;`DEFAULT_ENDPOINT` 常量同步一次定妥)。
6. **顺序铁律:先 publish(beta/release 指针非空)再签发对应 entitlement 的 key**(空态签发会被端点与脚本双重拒绝)。
7. npmjs 包 `@flywheel-ai/onboard` 配置 Trusted publisher:GitHub Actions,user/org `xrliAnnie`,repository `flywheel`,workflow `payload-activation.yml`,environment `release`,并让 Allowed actions 允许直接 `npm publish`。本设计不用 staged publishing;配置完成前 publish mode 以 auth/E404 fail closed 是预期。

## 2. 发 beta(全自动无门,GitHub CI)

自动:每 6h `schedule` 触发 `Payload Beta Release`(无需人)。scheduled 运行用**确定性 releaseId = `beta-<HEAD sourceCommit>`** + dedup(该 sourceCommit 已有 committed beta → skip),main 空闲不刷 beta.N、崩溃重试收敛。手动强发:GitHub → Actions → `Payload Beta Release` → Run workflow(填 release-id 强制一个新 beta)。**pre-activation guard**:`FW_ENDPOINT` 未配时 no-op(P5 前定时 fire 不产噪、不失败)。
本地等价(调试):
```
FW_ENDPOINT=… FW_BETA_PUBLISH_TOKEN=… node scripts/release/payload-release.mjs           # 定时形态(派生 id + dedup)
FW_ENDPOINT=… FW_BETA_PUBLISH_TOKEN=… node scripts/release/payload-release.mjs --release-id <id>  # 强发
```
协议:reserve(与 ledger 同 CAS)→ 占位登记(上传前)→ immutable 上传(409 容忍)+ readback 复验 → prepared → 单 CAS commit(entry + internal-beta 指针 + op committed)。**同 releaseId 重跑幂等**;任何一步失败零半成品。

## 3. promote(两段;审批物 = 候选 tuple 的 sha256)

1. **prepare(无门,GitHub CI)**:Actions → `Payload Promote (prepare)` → 填 release-id + beta 版本号(**sourceCommit 由 workflow 从 manifest 派生,不许操作者填**)。做:checkout 派生 commit → 同 commit 重建 clean 版 → **等价证明**(与在库 beta payload 逐字节比对,只归一化版本戳;不等价 = 停,回 design review,绝无降级放行)→ 登记耐久候选 → 上传 → prepared。
2. **commit(否决窗口后,零构建)**:只在 founder go(Lead 核身)或未来 B4 机器门放行后,从 main dispatch `Payload Promote (commit / abandon / withdraw)`,输入 `confirm=COMMIT`,`action=commit`,`release-id`,`expected-sha256`。workflow 先以完整 `validateManifest` 校验生产快照,再对确切 prepared object 回读重算 sha;只有 sha 与审批物一致才用一次 CAS 新增 release entry、切 `customer-release` 指针并把 op 提交。GitHub run/deployment log 与 `PROMOTE_RESULT` 是执行证据;dispatch 本身不是 founder 身份证明。
3. 候选被否 → 同一 workflow `action=abandon` + `release-id` → op `state=abandoned`。B1 期间仍须 founder go;B4 落地后由 B4 dispatch。对象随后按 §5 tombstone→delete。
4. **失败恢复**:重跑 `payload-promote.mjs validate-snapshot`,再用完全相同的 action 输入重试。committed/abandoned 已达态为幂等成功;sha、kind、state 或当前指针不匹配一律 fail closed。

## 4. withdraw(撤版;显式 fallback)

有已知 active previous-good 时,在同一 `payload-promote-commit.yml` dispatch `action=withdraw`,`withdraw-version=<当前客户版本>`,`fallback-version=<已知好版本>`。脚本会在 CAS 内再次确认被撤版本就是当前 `customer-release` pointer,然后一次 CAS 将坏版本 quarantined 并回指 fallback;fallback re-pin 自动清零 retention 钟(服务端盖章)。不是当前 pointer、fallback 非 active release 或保留期已到、两版本相同或并发漂移都零写拒绝。客户视图即时回退;paused / 无 previous-good 仍归 FLY-1143 B5。

## 5. retention 清理(dry-run 默认)

先收口搁浅 release 候选(14 天为 A1 工程定稿;默认先 dry-run):
```
FW_ENDPOINT=… FW_CUSTOMER_RELEASE_TOKEN=… node scripts/release/payload-promote.mjs abandon --stale-days 14
FW_ENDPOINT=… FW_CUSTOMER_RELEASE_TOKEN=… node scripts/release/payload-promote.mjs abandon --stale-days 14 --apply
```
显式 veto 使用 §3 的 workflow `action=abandon`;beta 的旧 live 候选由下一次 beta reserve/dedup sweep 收敛。`FW_CUSTOMER_RELEASE_TOKEN` 不得移出 environment `release`;上面的命令只描述 workflow 内等价诊断,不是把 secret 复制到本机的指示。

```
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/payload-cleanup.mjs          # 只看
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/payload-cleanup.mjs --apply  # 执行
```
顺序铁律(脚本结构即协议,测试锁死):**① expire/abandon**(端点用自己的钟强制 entry 窗口:beta 14 天 / release 28 天,current/pinned 永不过期;abandoned op 已终态)→ **② tombstone**(耐久 guard:从此新引用/PUT 复活全被拒)→ **③ delete + 全量 sweep**(每次 apply 重放全部 tombstones;delete 失败留 orphan 下次收敛)。B2 已拆 cleanup-only capability：`.github/workflows/payload-cleanup.yml` 每小时17分运行，也支持 dispatch。只在 main + environment release 读 `FW_ENDPOINT` 与 `FW_CLEANUP_TOKEN`，使用独立 `payload-cleanup` 并发组。未配置时明确 skip，不是清理成功；配置后失败必须排查。CLI 可用专用 token，或单独用上述 ops-admin；两者同时设置会拒绝。

## 6. key 签发 / 吊销 / 轮换(ops-admin)

```
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs issue  --customer <id> --entitlement customer|internal [--note "…"]
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs revoke --key-id <sha256>
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs rotate --key-id <旧sha256> --customer <id> --entitlement …
```
- 明文 key 只在签发瞬间打印一次(附非敏感 key id 供吊销);系统只存 sha256;明文经 Annie 手交客户(founder 家规:清单第 4 项)。
- 空态前置检查:目标 entitlement 的 channel `latest` 为 null → 拒(脚本 + 端点双重)。
- 轮换 = 先签新再吊旧,客户零断档。吊销后端点不再发新链接；已发链接最多剩余60秒可开始下载，已下载字节不能召回。若新签成功而旧吊销失败，CLI 非零退出；保留新 key/key id，单独重试 revoke --key-id <旧sha256>，不要重跑 rotate。

## 7. 薄壳 npm 发布(OIDC trusted publishing)

从 main 手动 dispatch `Payload Activation`,输入 `confirm=ACTIVATE`,`mode=publish`;job 必须在 environment `release`,并声明 `id-token: write`。顺序由 workflow 和 S15 锁死:

1. `preflight --workflow`:拒占位 endpoint,要求 Node/npm OIDC 工具链与精确 `repository.url`;不查 registry 占用。
2. helper `pack` 只打一次包并输出确切 tarball、sha256、版本和 dist-tag(clean → `latest`,prerelease → `next`)。
3. helper `gate` 对这一个 tarball 跑内容门;不从源目录重 pack。
4. `shell-publish-helper.mjs preflight` 只把显式 E404 当 free;已有同版本且 tarball sha256 与 dist-tag 都一致 → `idempotent`;任一不同 → `conflict` 并停止。
5. 只有 `outcome=free` 才执行 `npm publish "$TARBALL" --access public --tag "$TAG"`;认证只来自 OIDC,没有 `NODE_AUTH_TOKEN` / `NPM_TOKEN` / `NPM_PUBLISH_TOKEN`。私仓不能生成 provenance,workflow 显式 `NPM_CONFIG_PROVENANCE=false`。
6. helper `verify` 从 registry 下载该版本 tarball重算 sha256,并确认 dist-tag 指向它;12 次、每次 15 秒有界回读。任何 registry 错误、sha/tag 不等或超时都红,不得把版本已存在直接当成功。

本地 `prepublishOnly` 保留 `shell-publish-preflight.sh --founder-local` 作为 fail-closed 内容/占用兜底,但不持有发布凭据。真壳发布必须等 §1.7 trusted publisher 完成并取得 founder 授权;本 runbook 不授权执行。

## 7b. publish broker 运维(已退役;禁止操作)

FLY-2102 已删除 broker、socket CLI、`FW_NPM_GAT_TOKEN` 和 Bridge token 供给。不得设置 `FLYWHEEL_PUBLISH_BROKER`,不得向 Bridge env 注入 `FW_CUSTOMER_RELEASE_TOKEN`,不得调用已删除的 `broker-request.mjs`。现行执行面只有 §3/§4 的 customer workflow 与 §7 的 OIDC activation;授权仍由 founder go / B4 提供。

## 8. 断案手册

| 症状 | 含义 | 处置 |
|---|---|---|
| `412 etag mismatch` | CAS 输了(并发写/重试旧基线) | 重读 `GET /admin/manifest` → 按 B0-9 幂等判定(同 id 已达态 = 成功)→ 重试或停;脚本已内置有界重试 |
| 同一 action 连续 8 次 CAS conflict 且确认没有并发 writer | endpoint 返回的 ETag 可能从 strong 改成 weak/quoted 形态,客户端没有正确规范化 | 停止重试;检查 `GET /admin/manifest` 的 ETag 是否为 32/64 lowercase hex 的 bare/quoted/weak quoted 形态,再核 endpoint 与 shared client 都使用 `normalizeEtag`;不要放宽成任意字符串 |
| `409 object already exists` | 上传重试撞 immutable | 正常:readback 复验 + 幂等续走(脚本自动) |
| `409 no live claim` | 占位登记没做/被 abandon | 先 CAS 登记 tuple 再 PUT;确认 releaseId 状态 |
| `409 refused: key not tombstoned` | 想跳过两步删除 | 先 tombstone CAS(前提:仅终态引用),再 DELETE |
| `401`(客户面) | key 缺/错/已吊销 | 客户走薄壳 rotation 通道;运营核 key id 是否被吊销 |
| `503 not activated` | 该 entitlement channel 空态(运维态) | 先 publish 指针再发 key;客户不应撞到 |
| orphan 对象(上传后搁浅) | claim 在 manifest 可见(reserved/prepared) | abandon 该 op → 清理脚本 tombstone→delete;同 `<ver>/<sha>` 可被新 releaseId 接管重试,不死锁 |
| 等价证明红 | clean 构建 ≠ beta 树 | fail-closed:不发布,回 design review 查构建不确定性来源 |
| capability token 泄漏 | 依泄漏能力判 blast radius;beta 泄漏仍切不动客户指针 | 生成新 token → 更新对应 GitHub/运营 custody → 用 activation infra 更新 Worker sha256 → 旧 token 即刻失效;不在日志展示新 token |

## 9. custody 一览

| 凭据 | 位置 | 能做 |
|---|---|---|
| beta-publish token | repo secret `FW_BETA_PUBLISH_TOKEN` | beta 全链、promote prepare;**结构上做不了** customer 面 |
| customer-release token | GitHub environment `release` secret `FW_CUSTOMER_RELEASE_TOKEN`;不进 repo secret、Bridge env 或本地文件 | `payload-promote-commit.yml` 的 commit/abandon/withdraw;activation infra 只把 sha256 灌入 Worker |
| npm OIDC identity | npmjs trusted publisher 绑定 `xrliAnnie/flywheel`,`payload-activation.yml`,environment `release`;无长期 token | 只发布 workflow 打出的确切 `@flywheel-ai/onboard` tarball |
| ops-admin token | 运营侧(不进任何 workflow) | keys、expire、tombstone、DELETE;因能签客户 key,本单不定时化 cleanup |
| Cloudflare API token | GitHub environment `release` secret `CLOUDFLARE_API_TOKEN`;由 Annie 一次性恢复 | activation infra 的 bucket/Worker 部署;不进 repo secret |
| npm 账号(2FA) | Annie 本人 | 一次性配置/维护 trusted publisher;不签发 GAT |


## B2 私有 R2 激活与回退（FLY-2389）

激活前由授权运营在 environment `release` 配置 bucket 限定的 Object Read only R2 credential：`FW_R2_ACCESS_KEY_ID`、`FW_R2_SECRET_ACCESS_KEY`，以及 ≥32随机字节的 `FW_CLEANUP_TOKEN`。控制面仍是既有 `CLOUDFLARE_API_TOKEN`，两类 credential 不混用。account 取既有 `CLOUDFLARE_ACCOUNT_ID` variable；signer bucket 与 `PAYLOADS` 绑定同为 `flywheel-payloads`，不能配置任意 host。ops-admin 仍不进入 workflow。

先读回 managed r2.dev 状态、custom domain 列表、全部原生 lifecycle 规则，与 `packages/payload-endpoint/r2-lifecycle.json` 做完整 diff。公开入口、完整对象年龄删除、未知规则都先停，由运营确认后处理，再重跑同一 infra workflow；不能用全量 set 悄悄覆盖未知 benign rule。原生配置只中止未完成 multipart，不能代替历史 payload 清理验收。没有公开域还应由 QA 核对客户不存在其它公开/缓存绕行入口。

授权的 `payload-activation.yml mode=infra confirm=ACTIVATE` 执行：校验 secrets/账号/bucket → bucket create/resume → 私有性与 live rules 核验 → 应用 reviewed multipart rule 并读回 → 通过 stdin 预置 Worker signer secrets 与 cleanup hash → 部署 Worker。各新增 secret 只在 infra step 可用，不进 publish。原生规则应用在读取校验后显式确认；失败只有固定操作错误，不保存原始响应/secret。这段说明不授权现在 dispatch。

上线顺序：实现和全仓门禁 → 独立 QA 在授权隔离 Worker/private bucket 做 B1+B2 联合 E2E → 既有授权的 infra 激活 → 正式 smoke → 一次自动清理成功证据。验签负例（方法/路径/query/过期）与旧对象实际 Cache-Control header 必须来自真实 R2；local stream/双 origin fixture 不能替代。执行前核 read-only signer 作用域、R2 私有性、版本 tuple、被测 SHA 与部署 id；不把 key 或 signed URL 存进报告。

定时运行可延迟。运营核对最近一次**实际 apply 成功**，超过2小时没有成功就排查，必要时授权 dispatch 同一个 cleanup workflow。未激活 skip 不刷新成功时间。cleanup 无权 abandon live reservation；继续按 A1 先收口，再由全集 tombstone sweep 清理。读侧在14/28天截止立即隐藏历史，不依赖 scheduler。

回退只回退 Worker 程序或停止调度；不回滚 schema1 manifest、pointer、keys、tombstones，不恢复已吊销 key。代码回退不能找回已删除对象。需要临时 stream 构建时保留 C1 的不可覆盖 key 与 PUT 当前对象保护，不能原样回到有破坏性竞态的旧 handler；stream 恢复服务仍不满足 B2 presign 验收。泄漏短链接等待最多60秒；signer secret 泄漏时吊销并更换 R2 credential，期间返回503，不把 bucket 改公开。REQ-0 仍禁止 merge/ship 自动触发客户 release。
