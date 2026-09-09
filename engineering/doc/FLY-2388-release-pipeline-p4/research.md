# FLY-2388 发布流水线 P4(B1) — 调研

Issue: FLY-2388 (https://linear.app/geoforge3d/issue/FLY-2388/1143b1-发布流水线-p4薄壳-npm-publish2faoidc-payload-immutable-key-上传-r2-回读验)
日期: 2026-09-08
基于: exploration.md

> 本文只记**可复核的事实**与它们对设计的约束;方案本身在 plan.md。每条事实附落点(文件:行 / API / 外部文档)。

---

## 1. 现有机器件逐条对照(代码真相)

### 1.1 端点 admin wire(`packages/payload-endpoint/src/handler.mjs`)

| 路由 | capability | 关键行为 | 行 |
|---|---|---|---|
| `GET /admin/manifest` | 任一 | 200 raw manifest + `ETag: "<hex>"`(强 ETag,带引号) | :199 |
| `POST /admin/manifest {baseEtag, manifest}` | 按 diff 归类 | `stripQuotes(baseEtag) !== cur.etag` → 412;顺序:transition 422 → capability 403 → validator 422 → addVersion HEAD size/sha 409 → `put(onlyIf.etagMatches)` 412 | :253-307 |
| `PUT /admin/payload/<ver>/<sha>` | beta-publish ∨ customer-release | 无 manifest 409;tombstoned 409;无 live claim 409;已存在 409;`put({sha256, onlyIf.etagDoesNotMatch:"*", customMetadata})`,sha 不符 400;post-check 丢 claim → 删对象 + 409 | :337-408 |
| `GET /admin/payload/<ver>/<sha>` | beta-publish ∨ customer-release | 流式回读(客户端 hash 复验路径) | :322-335 |
| `HEAD /admin/payload/...` | — | **不存在**,落到统一 404 | :310-425, :518 |
| `DELETE /admin/payload/...` | ops-admin | 前提 key ∈ tombstones | :410-424 |

`stripQuotes`(:68-70)= `etag.replace(/^"|"$/g, "")`:只剥首尾引号,**不认 `W/` 弱前缀**。

### 1.2 transitions 与 capability(`transitions.mjs`)

| op | 需要的 capability | 行 |
|---|---|---|
| `pointer(customer-release)` / `addVersion(release)` / `commitOp(release)` | customer-release | :298-309 |
| `reserveRelease` / `registerTuple` / `toPrepared` | **beta-publish**(prepare 用 beta token) | :310-314 |
| `abandon`(kind=release) | customer-release 或 ops-admin;**beta-publish 403** | :315-319;`lifecycle.test.mjs:1158-1170` |
| `quarantine`(任意 channel) | customer-release | :320-321 |
| `expire` / `tombstone` | ops-admin | :322-324 |

C-6b fence(:158-184)对**结果快照**判定:release 的 `addVersion`/`commitOp` 所在 CAS 里,`derivedFromBeta` 必须 `channel=beta ∧ status=active`;quarantined 或 expired 的 beta 都拒(422,manifest 字节不动)。

### 1.3 合同包(`packages/release-contract`)

- `deriveReleaseArtifact` 只接受 `state=prepared`(`identity.mjs:55-57`);`deriveVetoBinding` 要求 beta active、base 一致、sourceCommit 逐字相等(:82-102)。
- CONTRACT.md:230:promote commit 行 = 「授权源 B4;触发 **B1 尚未实现**;断言 = 仅 `{releaseId,expectedSha256}`、零构建、C-6b;**B1 必须显式重谈 S4b**」。
- CONTRACT.md:259:**激活 B1 前必须用本包对生产 manifest 快照跑 schema + `validateManifest`**。
- CONTRACT.md §4.1(:186-194):commit 回调两条路——`prepared` 重派生 `VetoBinding` 并要求 beta active;`committed` 只核 `kind ∧ op.sha256===expectedSha256` 幂等零写;其余状态停。

### 1.4 发布脚本(`scripts/release/`)

| 脚本 | 接口 | 关键事实 |
|---|---|---|
| `payload-release.mjs` | `--release-id` `--repo-root`;env `FW_ENDPOINT` `FW_BETA_PUBLISH_TOKEN` | 默认 releaseId = `beta-<HEAD>`,定时 dedup;四步各一次 CAS(reserve / register / upload+readback→prepared / commit);exit 1 = die |
| `payload-promote.mjs` | `prepare --release-id --beta [--repo-root]`;`commit --release-id --expected-sha256`;`withdraw --withdraw --fallback`;严格 argv(拒 `=`、位置参数、短选项、重复、悬空) | commit 零构建标记 `:341-346`(P4 结构断言);mutate 内先核 `cur.sha256===expected`(:427-432)再 `deriveVetoBinding`(:440-446);为拿 `size` 把对象整个再下载一次(:389-394);withdraw 无 sha 绑定,fallback 必须 active release(:492-497) |
| `payload-cleanup.mjs` | `[--apply]`;env `FW_OPS_ADMIN_TOKEN` | expire → tombstone → delete + 全量 sweep;exit 0/2/1;dry-run 默认;C3a/C3b 结构锁 |
| `shell-prepare.mjs` | `--out` `--allow-placeholder` | 产 staged tarball + sha;**唯一消费者 broker-request.mjs 已被 FLY-2102 删除**(`fly2102-flag-freeze.test.sh:122-136`),今天是死代码 |
| `shell-publish-preflight.sh` | `--founder-local` / `--check-endpoint-only` | 门 2「OIDC 工具链」(npm ≥ 11.5.1、node ≥ 22.14、`repository.url` 必须存在)**只在非 `--founder-local` 下跑**(:82-115);门 3 registry E404 才算未占;**无 dist-tag 逻辑** |
| `lib/endpoint-client.mjs` | `casUpdate`(8 次重试,412 只打一行不打 body,:69-73)、`uploadPayload`(200/409 皆成功)、`readbackVerify`(流式 sha) | `readManifest` 原样回传 `res.headers.get("etag")`(:46) |

### 1.5 workflows(`.github/workflows/`)

| 文件 | 触发 | 凭据 | 门 | 备注 |
|---|---|---|---|---|
| `payload-beta-release.yml` | `schedule 0 */6 * * *` + dispatch | `secrets.FW_BETA_PUBLISH_TOKEN`、`vars.FW_ENDPOINT` | main-only;pre-activation guard | 每 6h 跑 `payload-release.mjs` |
| `payload-promote.yml` | dispatch(`release-id`, `beta`) | 同上 | main-only;sourceCommit 从 manifest 派生后 checkout | **只有 `prepare` job** |
| `payload-activation.yml` | dispatch(`confirm=ACTIVATE`, `mode=infra\|publish`) | `CLOUDFLARE_API_TOKEN`、`NPM_PUBLISH_TOKEN`、`FW_BETA_PUBLISH_TOKEN` | `environment: release` + job gate 逐字 `github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'`;`permissions: contents: read` | publish 步 = `npm publish --access public` + `NODE_AUTH_TOKEN`;无 `id-token`、无 `--tag`、无 `--provenance`;preflight 以 `--founder-local` 调用(跳过 OIDC 门);可见性轮询 6×10s |

### 1.6 结构断言(`scripts/__tests__/release-workflows-structure.test.sh`)

B1 会撞到的:**S4b**(:118-125,`FW_CUSTOMER_RELEASE_TOKEN` 零 workflow)、**S4c**(:127-142,`id-token` 只许 activation 且必须 env-gated)、**S4e**(:155-171,per-file secret 白名单:activation = `{CLOUDFLARE_API_TOKEN, NPM_PUBLISH_TOKEN, FW_BETA_PUBLISH_TOKEN}`)、**S5a/S5b**(promote 无 commit job、无 environment)、**S11**(引用 `CLOUDFLARE_API_TOKEN|NPM_PUBLISH_TOKEN` 的 job 必须 `environment: release` + 逐字 job gate)、**S12**(activation 十个步骤名前缀 → `inputs.mode` 条件映射,缺一即红)、**S13**(三份 workflow 的精确触发器集合)。

### 1.7 CI 接线(`ci.yml` `payload-distribution` job,:1241-1336)

零凭据;跑 endpoint/contract 单测、tsc、credentialless wrangler dry-run + metafile 断言、`package-onboard-version-injection`、`release-contract-vectors`、`contract-consistency`、`payload-key-cleanup`、`payload-release-pipeline`、`shell-preflight-registry`、`oidc-toolchain-floor`、`release-workflows-structure`、`ship-merge-token`、`shell-pack-install-dryrun`、`customer-e2e-acceptance`。`ci-ok` 依赖它。

### 1.8 版本机器断言(已接 CI)

`scripts/package-onboard.sh:167-209`(`po_version` / `po_version_is_derivation` / `po_release_version`)+ 打包门 `:897-914`(package.json.version == `.flywheel-prebuilt` 哨兵 ∧ 是 `doc/VERSION` 派生 ∧ `.flywheel-build-sha == HEAD`);`ci.yml:1299-1303`(注入 sentinel V1-V4 + bash/mjs 共享向量 22 条)。壳版本刻意独立于 `doc/VERSION`,且由 `consumers-lint.test.mjs:58-70` 断言 shell 脚本零 `doc/VERSION` 引用。

## 2. 生产现场事实(2026-09-08/09 实测)

### 2.1 beta 线

```
gh api …/workflows/payload-beta-release.yml/runs (236 runs)
  2026-07-12 … 07-18 12:23   26 × success   ← FW_ENDPOINT 未设,pre-activation no-op
  2026-07-18 18:22 … 09-09 00:41   210 × failure ← 全部 "reserve: CAS conflict" ×8 → "CAS retries exhausted"
```
- `FW_ENDPOINT` 变量设定时间 2026-07-18T13:55:41Z;首个失败 run 29655743762(18:22)与最新 run 34296075491 日志逐字同形。
- 边缘压缩实证:`curl -sI -H 'Accept-Encoding: gzip, deflate, br' <endpoint>/manifest` → `HTTP/2 404`、`content-type: application/json`、**`content-encoding: br`**(一个 30 字节的 JSON 都被压)。Node fetch 默认发 `Accept-Encoding`。
- Cloudflare 文档(ETag headers):做压缩变换时把强 ETag 改成弱 ETag,格式 `etag: W/"foobar"`。
- 推论:`stripQuotes('W/"abc"')` = `W/"abc` ≠ `abc` → 412;每次第一次 CAS 即失败,与「并发」无关。**待 c0 用 token 探针一次确认**(`curl -sI -H "Authorization: Bearer $FW_BETA_PUBLISH_TOKEN" $FW_ENDPOINT/admin/manifest` 看 `etag:` 是否 `W/` 开头)。
- hermetic 套件(MemoryBucket / FsBucket + node http 壳)没有边缘压缩层,结构上测不到;这类「生产才出现的传输层改写」需要一条**协议级**回归:客户端对 `W/"x"`、`"x"`、`x` 三形态都归一化;服务端对三形态都接受。

### 2.2 GitHub

| 事实 | 值 |
|---|---|
| 仓库 | `xrliAnnie/flywheel`,private,owner type User |
| repo secrets | `FW_BETA_PUBLISH_TOKEN`(2026-07-18)、`SHIP_PAT`(2026-08-11) |
| environment `release` | 存在;branch policy `main`;`can_admins_bypass: true`;**secrets total_count = 0** |
| required reviewers | `PUT /environments/fly-2388-probe {reviewers:[…]}` → **422 "billing plan does not support the required reviewers protection rule"**(探针环境已删,仅剩 `release`) |
| gh 登录身份 | `gh api /user` = `xrliAnnie`(runner 与 founder 同一 GitHub 身份) |
| variables | `CLOUDFLARE_ACCOUNT_ID`、`FW_ENDPOINT` |

后果:`payload-activation.yml` 两个 mode 今天都无凭据可用;Worker 无法从 CI 重部署;GitHub 层无人门可用;GitHub 身份不能证明「是 founder 本人」。

### 2.3 npm

`npm view @flywheel-ai/onboard --json`:versions `["0.1.0"]`,dist-tags `{latest: 0.1.0}`,published 2026-07-18T13:47:50Z,`repository: null`,`dist.attestations: null`。首发 run 29646793262 在 publish 成功后死于「Verify the published version is live」(6×10s 内 `npm view` 未见,实际 registry 已有)。

## 3. 外部依据

### 3.1 npm trusted publishing(docs.npmjs.com/trusted-publishers)

- 工具链:**npm CLI ≥ 11.5.1,Node ≥ 22.14.0**。本仓 `.node-version` = `22`(setup-node 会装最新 22.x,自带 npm 10.x → **workflow 需 `npm i -g npm@11`** 一步,且 preflight 的门 2 会核)。
- 权限:workflow `permissions: id-token: write`;`package.json.repository.url` 必须逐字等于 GitHub 仓库。
- npmjs 侧配置:Organization or user = `xrliAnnie`;Repository = `flywheel`;Workflow filename = `payload-activation.yml`(只写文件名);Environment name = `release`(可选,填上更严)。
- provenance:trusted publishing 默认自动生成 provenance,但**私仓不支持**(GitHub changelog 2023-07-25);npm 按 `repository_visibility` 自动决定,私仓不生成;显式 `NPM_CONFIG_PROVENANCE=false` 消除歧义。**与 PRD §7.2「删掉 provenance 承诺」一致。**
- 2FA:trusted publishing 用短期 OIDC 交换 token,不需要绕 2FA 的长期 token;账号 2FA 照常开着。
- 注意 `workflow_call` 复用 workflow 时校验的是调用方文件名——本设计不用 reusable workflow。

### 3.2 GitHub environments(docs.github.com manage-environments)

- 私仓 environment 需 Pro/Team;required reviewers 在本仓实测不可用(§2.2)。deployment branch policy 可用(已在用)。
- GitHub 语义:只有跑在 `main`、声明 `environment: release` 的 job 能解析该 environment 的 secret;PR/分支/fork 的 workflow 拿不到。这是 FLY-1323 已接受的姿态(`ci-activation-design.md` §2)。

### 3.3 Cloudflare ETag(developers.cloudflare.com/cache/reference/etag-headers)

压缩变换 → 弱 ETag `W/"…"`。文档未单独说明 Workers,但 §2.1 的 `content-encoding: br` 实测证明 workers.dev 响应确实经过边缘压缩。

## 4. 对设计的约束(由事实推出)

| # | 约束 | 来源 |
|---|---|---|
| C1 | 客户端与服务端都必须把 ETag 归一化为裸 hex(剥 `W/` 与引号)再比;412 分支必须打印服务端 body | §2.1 |
| C2 | promote commit 执行面只能是「main 上、声明 `environment: release` 的 job」;人门在 GitHub 做不出 | §2.2 |
| C3 | `FW_CUSTOMER_RELEASE_TOKEN` 若进 CI 只能作 environment `release` 的 secret;S4b/S4e/S11 必须同步重写成白名单 | §1.6 |
| C4 | commit workflow 零构建:不 `pnpm install/build`、不 checkout 源码用于打包;只 checkout 到脚本(脚本本身是 main 上的 reviewed 树) | CONTRACT.md:230;P4 |
| C5 | prepare 无权 abandon 自己的 release 候选 → 清理策略必须给 customer-release 侧一个 abandon 动作 | §1.2 |
| C6 | OIDC 需要 `repository.url` → publish-gate G3 要登记唯一例外;Lead 已裁「接受并披露」 | §3.1;exploration §4 |
| C7 | 壳版本带预发布后缀 ⇒ `--tag next`(合同 §1.2);npm 默认 tag `latest` | §1.5;CONTRACT §1.2 |
| C8 | activation 十步映射(S12)与 S4e 白名单要随新增步骤/secret 一起改,否则结构测试红 | §1.6 |
| C9 | 端点无 HEAD → commit 多下载一次;可加 HEAD 路由(端点改动,需重部署)或接受 | §1.1 |
| C10 | 激活前必须对生产 manifest 快照跑合同校验(CONTRACT.md:259);快照获取需要任一 capability token → 放在 commit workflow 的 preflight 步(用同一 token 读 `GET /admin/manifest` 后本地 `validateManifest`) | §1.3 |
| C11 | Annie 一次性动作(CF token 入 env release、npmjs trusted publisher)不可假设完成;B1 代码与 hermetic 测试不得依赖它们 | Lead 裁决 D2 |
| C12 | 本机 gh 身份 = founder 身份 ⇒ 「谁 dispatch 了 commit」不能当 founder 证明;founder 的 go 由 Lead 在 Discord 核身后转达,run log 记 actor + 输入,B4 接管机器门 | §2.2;Lead D1 |

## 5. 排除项与理由

| 方案 | 理由 |
|---|---|
| Bridge 进程持 customer-release token 直跑 commit | 同 UID runner 可读;老 broker 为此而生并已被 FLY-2102 删除(见 `fly2102-flag-freeze.test.sh`) |
| 每运行现 mint customer-release capability(FLY-1323 §4) | 每次 commit 都要 CF token 在场并改 Worker secret;runner 的 gh 登录本可 `gh secret set`,原理由不成立 |
| 给 commit 加 GitHub required reviewers | 套餐不支持(422 实测) |
| cleanup 定时 workflow 持 `FW_OPS_ADMIN_TOKEN` | 该能力同时能签发/吊销客户 key,爆炸半径超出 B1;拆能力 = Worker 改动,归 follow-up |
| R2 bucket lifecycle 规则做清理 | 会绕过 tombstone 协议、破坏 C-8(manifest 仍引用已删对象);`pr3-pr4-research.md:47` 已否 |
| 用 `dist.integrity`/`shasum` 做 npm 回读校验 | 不是 sha256 且由 registry 自述;沿用 FLY-1062 R6 结论:本地重算 sha256 |
