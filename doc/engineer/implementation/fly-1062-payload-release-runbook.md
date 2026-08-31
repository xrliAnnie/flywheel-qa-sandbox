# FLY-1062 · 分发层发布 Runbook(payload 托管 + key 生命周期 + 薄壳 npm)

**Issue**: FLY-1062(PR3/PR4 收尾圈)
**Date**: 2026-07-11

> **RETIRED — FLY-2102 (2026-08-27):** 本文中的 publish broker 路径、socket CLI 与 Bridge token 供给已删除,不可再按 §3/§4/§7/§7b 操作。`@flywheel-ai/onboard` 的真实发布路径是 `.github/workflows/payload-activation.yml`;FW 发布 token 不得进入 Bridge env，Bridge 启动也会在任何其他工作前防御性清除这两个旧 credential 名。以下 broker 内容只保留为历史设计记录。

> ⚠️ **发布授权 = 自动化形态(Codex design R7 APPROVED,plan §3)。分两个 PR 落**:本 PR(#558)= 机器件 + beta-auto CI + promote-prepare CI(**不发布任何真东西**);**customer-facing 发布(promote-commit + shell npm publish)= FLY-245 broker 动作 + approve gate,是 1062 底下的下一个 PR**。**硬约束:真发布(§5 P5 真机段)在 broker PR 落地前不许发生**。本 runbook §3/§6/§7 涉 broker 的段落标「broker PR」。

---

## 0. 红线(先读)

1. **禁裸 dashboard 编辑 bucket 对象**。一切写(manifest、payload、keys)只走 Worker admin API(validator/CAS/capability 全在那一段代码里);dashboard 手改 = 绕过全部不变量。
2. **Cloudflare API token(R2 写/Worker 部署)= vendor control-plane 凭据,只在 Annie 手里**,绝不进 repo secrets、绝不进任何 workflow。Worker 部署是低频 runbook 动作,由她(或她在场)执行。首把 token 需浏览器 bootstrap 一次,之后 wrangler/API。
3. **两把对外发布 token(customer-release capability + npm GAT)只在 FLY-245 broker 父进程内存**——**永不落盘、绝不进 GitHub CI、绝不进任何子进程**(同 UID 0600 文件不是 boundary)。真发布(promote-commit / shell publish)= 她一条 Discord approve → broker 核内存 founder-approval 登记(非 DB-backed verify-approval)过 → broker 执行。「Annie 不批,customer 面物理动不了」。
4. **clean semver 永不复用**;发布单飞(Actions `concurrency: payload-release` + manifest etag CAS 双保险)。
5. **GitHub CI 只持 beta-publish token**(内部 beta blast radius);beta = `schedule` 每 6h + dispatch 全自动(pre-activation guard:`FW_ENDPOINT` 未配时 no-op)。**customer-facing 发布不在 CI**——是 broker 动作(下一个 PR)。`shell-publish.yml` 已删除。

## 1. 一次性初始化(P5 前置;第 2/3 步 = Annie 动作清单第 2 项)

1. 生成三枚 capability token(各 ≥32 字节随机 hex,前缀随意,建议 `fwcap_` 便于识别)+ 计算各自 sha256:
   ```
   node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
   ```
   custody:beta-publish → repo secret `FW_BETA_PUBLISH_TOKEN`;customer-release → **只进 broker 父进程内存**(§7b 供给方式;同 UID 0600 文件不是 boundary,绝不落盘);ops-admin → 运营侧(Tadashi/runbook)。Worker 只存 **sha256**。
2. Cloudflare(账号**已存在** = Annie 的,登录邮箱 **xrliannie.b@gmail.com**;Peter/GeoForge3D 核实 2026-07-11):
   - **首把 API token 需浏览器登录 bootstrap 一次**(Runner 用 Claude-in-Chrome 替她操作,需要密码/2FA/不可逆确认时才叫她),之后建 bucket / 部署 Worker / 发后续 token **全走 wrangler/API**(Cloudflare 有完整 API,不必再进浏览器)。
   - `wrangler r2 bucket create flywheel-payloads`(R2 大概率未启用,namespace 对我们干净)。
   - `CLOUDFLARE_ACCOUNT_ID`:GeoForge3D repo 的 GitHub Actions secret 同名项,或 dashboard 直接取。
   - **硬边界(绝对不碰)**:该账号 GeoForge3D 在用两块——Cloudflare Pages 项目 `custom-map-studio`(`*.geoforge3d.pages.dev`)+ `memoscaped.com` 的 Email Routing/MX/DNS。我们**只新增** R2 bucket + Worker。
   - endpoint 形态 = **workers.dev** 免费地址(Annie 确认;真 URL 部署后一次定妥,填进 `DEFAULT_ENDPOINT`)。
3. Annie(在 `packages/payload-endpoint/` 下,用她自己的 Cloudflare token):
   ```
   wrangler secret put FW_BETA_PUBLISH_TOKEN_SHA256
   wrangler secret put FW_CUSTOMER_RELEASE_TOKEN_SHA256
   wrangler secret put FW_OPS_ADMIN_TOKEN_SHA256
   wrangler deploy
   ```
4. conditional create 初始化 manifest(任一 capability token 均可;初始 = 双 channel null + 空表):
   ```
   curl -X POST "$FW_ENDPOINT/admin/manifest" -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"baseEtag":null,"manifest":{"schemaVersion":1,"channels":{"internal-beta":{"latest":null},"customer-release":{"latest":null}},"versions":{},"releaseOps":{},"releaseLedger":{},"tombstones":[]}}'
   ```
5. repo variable `FW_ENDPOINT` = Worker URL(workers.dev 或自有域,Annie 拍;`DEFAULT_ENDPOINT` 常量同步一次定妥)。
6. **顺序铁律:先 publish(beta/release 指针非空)再签发对应 entitlement 的 key**(空态签发会被端点与脚本双重拒绝)。

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
2. **commit(founder gate = Flywheel approve gate → broker;broker PR 已落地)**:
   ```
   node scripts/release/broker-request.mjs --action publish-release --release-id <id> --sha256 <候选sha256>
   ```
   请求本身**不带任何授权**:broker 把「发布审批请求卡」发到审批频道,**Annie 在那条卡上点 ✅**(canonical founder id 精确校验,零 AI)→ broker 内存登记该 (action, releaseId, sha256) 审批(单次消费)→ 用**内存里**的 customer-release token 跑 commit(复验 readback sha → 切 customer 指针,单 CAS)+ 写 audit log(`~/.flywheel/publish-audit.jsonl`)。**gate 后零构建**(结构测试锁死:`scripts/__tests__/publish-broker-structure.test.sh`)。执行失败审批**不消费**,修好重试;成功后残留的 ✅ 结构上无法再触发第二次发布。**真发布仍等 P5**(真 token 未供给前 broker 一律拒 `token_not_provisioned`)。
3. 候选被否 → abandon(ops token 发 `state→abandoned` 的 manifest CAS)→ 对象随下一次清理进 tombstone→delete。

## 4. withdraw(撤版;broker 动作,= 1062 下一个 PR)

customer-release token 只在 broker 内存 → withdraw 也经 broker(approve gate)。逻辑:
```
node scripts/release/payload-promote.mjs withdraw --withdraw <坏版本> --fallback <已知好版本>
```
一次 CAS:坏版本 quarantined + 指针回指 fallback;fallback re-pin 自动清零 retention 钟(服务端盖章)。客户视图即时回退。「无 previous-good」的自动化归 FLY-1143(B5)。

## 5. retention 清理(dry-run 默认)

```
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/payload-cleanup.mjs          # 只看
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/payload-cleanup.mjs --apply  # 执行
```
顺序铁律(脚本结构即协议,测试锁死):**① expire**(端点用自己的钟强制窗口:beta 14 天 / release 28 天,current/pinned 永不过期)→ **② tombstone**(耐久 guard:从此新引用/PUT 复活全被拒)→ **③ delete + 全量 sweep**(每次 apply 重放全部 tombstones;delete 失败留 orphan 下次收敛)。定时自动化归 FLY-1143;本圈人工触发。

## 6. key 签发 / 吊销 / 轮换(ops-admin)

```
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs issue  --customer <id> --entitlement customer|internal [--note "…"]
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs revoke --key-id <sha256>
FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs rotate --key-id <旧sha256> --customer <id> --entitlement …
```
- 明文 key 只在签发瞬间打印一次(附非敏感 key id 供吊销);系统只存 sha256;明文经 Annie 手交客户(founder 家规:清单第 4 项)。
- 空态前置检查:目标 entitlement 的 channel `latest` 为 null → 拒(脚本 + 端点双重)。
- 轮换 = 先签新再吊旧,客户零断档。吊销即时(R2 强一致,下一请求即拒)。

## 7. 薄壳 npm 发布(broker 动作 + approve gate;broker PR 已落地)

shell publish 与 payload 路径完全对称、复用同一 broker + approve gate 机制:
1. **prepare/stage**:
   ```
   node scripts/release/shell-prepare.mjs          # npm pack → sha256 → stage,打印 broker 请求 JSON
   node scripts/release/broker-request.mjs --json '<上一步输出>'
   ```
   prepare 会**拒绝** `DEFAULT_ENDPOINT` 还是 `.invalid` 占位的形态(填真 URL 前发不出去)。
2. **approve**:broker 把「壳版本 + tarball sha256」的审批卡发给 Annie,她在卡上点 ✅(绑该 sha256、单次消费)。
3. **broker publish**:broker 核内存 founder-approval 登记过 → **发布前对 staged tarball rehash 断言 == 批准 sha256 + 内容 gate 权威版在 broker 重跑**(白名单/零 secret/零私仓 URL/非占位 endpoint;prepare 段的 gate 在 compromised runner 域不可信)→ 用**内存里**的 npm **GAT(write on `@flywheel/onboard` 唯一包)**做**进程内 registry PUT**(GAT 绝不进任何子进程;staged 物,不重 pack)→ 写 audit log。
4. **npm 409(版本已存在)不当然成功**:broker 从 registry 下载该版本 tarball、重算 sha256 比对 == 批准值,一致才算成功(不信 npm sha1 `dist.shasum`/sha512 `dist.integrity`)。

registry preflight(版本未用)也在 broker 端跑;`scripts/release/shell-publish-preflight.sh` 仍是人工快检入口。壳版本 bump 必须显式走 PR。
**真壳发布等 P5 供给真 GAT + Annie 批**(此前 broker 一律拒)。hardening note:将来 Enterprise/org 化可迁回 OIDC trusted publishing(无长期 token)+ environment required-reviewers,退役 broker GAT。

## 7b. publish broker 运维(FLY-1062 broker PR)

- **默认关**:Bridge env `FLYWHEEL_PUBLISH_BROKER=1` 才启动(生产字节兼容;P5 才开)。
- **token 供给(已退役)**:不得再向 Bridge env 注入 `FW_CUSTOMER_RELEASE_TOKEN` / `FW_NPM_GAT_TOKEN`;Bridge 启动会在任何其他工作前无条件删除这两个旧 credential 名，防止误配置泄漏给 runner/lead/tmux 子进程。真实发布凭据只走 `.github/workflows/payload-activation.yml` 的既有 Actions secret 路径。
- **审批面**:`FLYWHEEL_PUBLISH_APPROVAL_CHANNEL`(Discord 频道 id)+ canonical founder id(既有 `discordOwnerUserId`/`founderConsent` 推导)。没配 = 请求全部 pend,不执行。
- **请求面**:unix socket `~/.flywheel/publish-broker.sock`(0600;`FLYWHEEL_PUBLISH_BROKER_SOCKET` 可改);CLI = `scripts/release/broker-request.mjs`(exit 0=已执行 / 2=等审批 / 1=拒)。
- **audit**:每个决定(登记/挂起/执行/失败)追加 `~/.flywheel/publish-audit.jsonl`(releaseId/ver/sha/approverRef/时间戳;永无 token)。
- **withdraw 边界(诚实声明)**:v1 broker 只暴露 publish-release / publish-shell 两动作;withdraw 仍是 `payload-promote.mjs withdraw` 手跑(需临时供给 customer-release token 的运维动作),broker 化随 FLY-1143。

## 8. 断案手册

| 症状 | 含义 | 处置 |
|---|---|---|
| `412 etag mismatch` | CAS 输了(并发写/重试旧基线) | 重读 `GET /admin/manifest` → 按 B0-9 幂等判定(同 id 已达态 = 成功)→ 重试或停;脚本已内置有界重试 |
| `409 object already exists` | 上传重试撞 immutable | 正常:readback 复验 + 幂等续走(脚本自动) |
| `409 no live claim` | 占位登记没做/被 abandon | 先 CAS 登记 tuple 再 PUT;确认 releaseId 状态 |
| `409 refused: key not tombstoned` | 想跳过两步删除 | 先 tombstone CAS(前提:仅终态引用),再 DELETE |
| `401`(客户面) | key 缺/错/已吊销 | 客户走薄壳 rotation 通道;运营核 key id 是否被吊销 |
| `503 not activated` | 该 entitlement channel 空态(运维态) | 先 publish 指针再发 key;客户不应撞到 |
| orphan 对象(上传后搁浅) | claim 在 manifest 可见(reserved/prepared) | abandon 该 op → 清理脚本 tombstone→delete;同 `<ver>/<sha>` 可被新 releaseId 接管重试,不死锁 |
| 等价证明红 | clean 构建 ≠ beta 树 | fail-closed:不发布,回 design review 查构建不确定性来源 |
| 三 token 泄漏 | 分权限损(beta 泄漏切不动客户指针) | 生成新 token → Annie `wrangler secret put` 换 sha → 旧 token 即刻失效;按 custody 表重新分发 |

## 9. custody 一览

| 凭据 | 位置 | 能做 |
|---|---|---|
| beta-publish token | repo secret `FW_BETA_PUBLISH_TOKEN` | beta 全链、promote prepare;**结构上做不了** customer 面 |
| customer-release token | **broker 父进程内存**(boot 注入即从 env 抹除;永不落盘/不进 CI/不进子进程) | promote commit(broker `publish-release`,approve gate);withdraw v1 = 运维临时供给手跑 |
| npm GAT(write on `@flywheel/onboard` 唯一包) | **broker 父进程内存**(同上) | 薄壳 publish(broker `publish-shell`,approve gate) |
| ops-admin token | 运营侧(不进任何 workflow) | keys、expire、tombstone、DELETE、abandon |
| Cloudflare API token | Annie 本人 | bucket/Worker 部署(runbook 动作) |
| npm 账号(2FA) | Annie 本人 | GAT 的签发/轮换(一次性配置动作) |
