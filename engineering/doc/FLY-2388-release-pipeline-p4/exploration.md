# FLY-2388 发布流水线 P4(B1) — 探索

Issue: FLY-2388 (https://linear.app/geoforge3d/issue/FLY-2388/1143b1-发布流水线-p4薄壳-npm-publish2faoidc-payload-immutable-key-上传-r2-回读验)
日期: 2026-09-08
基于: 无(上游:PRD `product/doc/FLY-1098-release-cicd/prd.md` §6.2/§7/§10/§14;B0 合同 `packages/release-contract/CONTRACT.md`;FLY-1062 `pr3-pr4-plan.md`;FLY-1323 `ci-activation-design.md`)

> **一句话**:B1 的机器件(immutable-key 上传、回读验 hash、manifest CAS、版本派生断言、prepare/commit/withdraw 脚本、清理协议)在 FLY-1062 PR3/PR4 + FLY-2387 里**已经落地并有 hermetic 测试**;本单真正缺的是**四件事**:① 把 `customer-release` 指针切换接上一个可触发、零构建、sha 绑定的执行面(今天没有任何 workflow 能切客户指针,S4b 明令禁止);② 薄壳 npm 发布从长期 token 改成 PRD §7.2 要求的 trusted publishing(OIDC)姿态并补 `--tag next` 断言;③ §7.3-7 staging 清理策略工程定稿;④ **先把死了 52 天的 beta 线救活**(激活以来 210/210 次失败于 CAS 412),否则端到端验收无从谈起。

---

## 1. 现场事实(2026-09-08 审计;全部可复核)

### 1.1 已落地(B1 不重造)

| PRD 条款 | 落点 | 证据 |
|---|---|---|
| §7.3-1 immutable key + 回读验 hash | `PUT /admin/payload/<ver>/<sha>`:tombstone 拒、live-claim 拒、已存在 409、存储侧 sha 校验、post-check;客户端 `readbackVerify` 流式复验 | `packages/payload-endpoint/src/handler.mjs:337-408`;`scripts/release/lib/endpoint-client.mjs:103-118` |
| §7.3-2 manifest 唯一 commit point(CAS) | `POST /admin/manifest {baseEtag, manifest}`,412 冲突;commit 前 HEAD size/sha 硬门 | `handler.mjs:203-307` |
| §7.3-3 releaseId 幂等 + 单飞 | releaseOps 状态机 + `concurrency: payload-release` | `transitions.mjs`;三份 workflow |
| §6.1 版本派生断言接 CI | `po_version` / `po_version_is_derivation` / `po_release_version` + 打包门;CI 跑注入 sentinel + 跨语言向量 | `scripts/package-onboard.sh:167-209, 897-914`;`ci.yml:1299-1303, 659-667, 717-718` |
| §6.2 两身份 + veto 绑真 artifact | `deriveVetoBinding` 在 commit 的 CAS mutate 内重派生;C-6b 服务端 fence | `payload-promote.mjs:440-446`;`transitions.mjs:158-184` |
| promote prepare(等价证明 + 登记 + 上传 + 复验) | `payload-promote.mjs prepare`;`payload-promote.yml`(只有 prepare job) | `payload-promote.mjs:185-339` |
| promote commit / withdraw **脚本** | `commit --release-id --expected-sha256`(零构建标记行以下无构建);`withdraw --withdraw --fallback` | `payload-promote.mjs:341-505` |
| §7.3-7 清理协议(expire→tombstone→delete + 全量 sweep) | `payload-cleanup.mjs`(dry-run 默认);14/28 天 pointer-tenure 钟 | `scripts/release/payload-cleanup.mjs`;`grammar.mjs:26-29` |
| 薄壳首发 | `@flywheel-ai/onboard@0.1.0` 于 2026-07-18 发出(npm registry 可查) | `npm view @flywheel-ai/onboard` |
| 端点 | Worker 在线(`/manifest` 无 key → 401) | `https://flywheel-onboard-endpoint.xrliannie-b.workers.dev` |

### 1.2 缺口(B1 要做)

| # | 缺口 | 现状证据 |
|---|---|---|
| G1 | **没有任何执行面能切 `customer-release` 指针** | `payload-promote.yml` 只有 prepare job(S5a 断言无 commit job);`FW_CUSTOMER_RELEASE_TOKEN` 在零个 workflow(S4b);旧 broker 已被 FLY-2102 删除;CONTRACT.md §7 REQ-0 表 promote commit 行写「B1 尚未实现;B1 必须显式重谈 S4b」 |
| G2 | **npm 发布姿态 = 长期 token**,不是 PRD §7.2 的 OIDC | `payload-activation.yml:263-268` 用 `NODE_AUTH_TOKEN: secrets.NPM_PUBLISH_TOKEN`;`permissions` 无 `id-token: write`;preflight 以 `--founder-local` 跳过 OIDC 工具链门;`package.json` 无 `repository.url` |
| G3 | **`--tag next` 未实现未断言**(合同 §1.2 指定 B1) | 全仓无 `--tag`;`CONTRACT.md` / FLY-2387 plan:60,129 |
| G4 | **staging 清理策略未定稿**:失败/被弃候选如何 abandon、谁触发 | prepare 用 beta-publish token,而 abandon `kind=release` 需 customer-release/ops-admin(`transitions.mjs:315-319`,`lifecycle.test.mjs:1158-1170` 实证 403)⇒ 失败的 prepare **无法自清**;cleanup 无 workflow,`FW_OPS_ADMIN_TOKEN` 在零个 workflow |
| G5 | **beta 线自激活起全失败** | 见 §1.3 |
| G6 | **凭据面为空** | 见 §1.4 |
| G7 | 首发 publish 的「registry 可见性」轮询 60s 太短,上次 publish 成功却把 run 判红 | run 29646793262:`did not become visible after publish`,而 npm 实际已有 0.1.0 |

### 1.3 事故级事实 A:beta 线 210/210 失败(2026-07-18 18:22 起,每 6h 一次)

- 激活前(`FW_ENDPOINT` 未设)26 次「成功」全是 pre-activation guard 的 no-op;`FW_ENDPOINT` 于 07-18 13:55 设好后**没有一次成功**。
- 每次日志完全相同:`reserve: CAS conflict — re-reading and re-judging (attempt 1..8)` → `CAS retries exhausted` → exit 1。第一次 CAS 就 412,并非真并发。
- 根因假说(证据链,待 token 探针一次确认):
  1. `GET /admin/manifest` 用 `ETag: "<hex>"` 回强 ETag(`handler.mjs:199`);
  2. Cloudflare 对 workers.dev 的 JSON 响应做压缩(实测:无 auth 的 404 JSON 也带 `content-encoding: br`);Cloudflare 文档:**做压缩变换时强 ETag 被改写成弱 ETag `W/"..."`**;
  3. 客户端原样回传 `res.headers.get("etag")`(`endpoint-client.mjs:46`);
  4. handler `stripQuotes` 只剥首尾引号(`handler.mjs:68-70`):`W/"abc"` → `W/"abc` ≠ `abc` → 412(`:253-255`);
  5. 客户端 412 分支不打印 body(`endpoint-client.mjs:69-73`),52 天里每条红日志都长得像「并发冲突」。
- hermetic 测试(MemoryBucket/FsBucket + node http 壳)没有 Cloudflare 边缘,永远测不到。**这是 B1 端到端验收的前置**:没有 committed beta 就没有 promote 候选。

### 1.4 事故级事实 B:GitHub 凭据面与套餐限制

| 项 | 现状(API 实测) |
|---|---|
| repo secrets | 只有 `FW_BETA_PUBLISH_TOKEN`、`SHIP_PAT` |
| environment `release` secrets | **0 个**(`CLOUDFLARE_API_TOKEN` / `NPM_PUBLISH_TOKEN` 都不在;07-18 首发时它们在 repo 级,之后被移除) |
| environment `release` 保护 | 只有 branch policy(main);`can_admins_bypass: true` |
| required reviewers | **本仓套餐不支持**(临时 env 探针 PUT reviewers → 422 "billing plan";探针已删) |
| 后果 | ① `payload-activation.yml` 两种 mode 今天都跑不了(无 CF token、无 npm token);② Worker 无法重部署;③ **GitHub 层做不出「founder 点一下」的人门**;④ 本机所有 runner 共用 Annie 的 gh 登录(`gh api /user` = xrliAnnie),GitHub 身份在本机不是 founder 专属 |

### 1.5 端点侧的尖角(设计要绕开或修)

1. `/admin/payload` **无 HEAD**:commit 为了拿 `size` 把整个对象下载了第二遍(`payload-promote.mjs:389-394`)。
2. 服务端不做字节级回读复验;§7.3-1 的「回读验 hash」是客户端行为。任何绕过 `payload-promote.mjs` 的提交都能不复验就切指针。
3. 违规串只有 C-6b 带编号,其余 transition 错误是自然语句;B1 不能靠编号分支,只能靠 HTTP 状态。
4. 端点零日志(有意);发布审计只能来自 workflow run log + manifest 的 server-owned 时间戳。
5. withdraw 的 fallback「必须 active release」只在客户端;服务端不核 fallback 对象仍在。

---

## 2. 问题空间与方案

### 2.1 Q1 promote commit 的执行面放哪(核心决定)

| 选项 | 描述 | 授权/凭据 | 评价 |
|---|---|---|---|
| **A(推荐)CI workflow,environment `release`,main-only** | 新建 `payload-promote-commit.yml`:`workflow_dispatch` 输入 `{release-id, expected-sha256, action}`;job 声明 `environment: release` + 与 activation 逐字相同的 job gate;零构建(不 checkout 源码构建、不 pnpm build);只跑 `payload-promote.mjs commit`;`FW_CUSTOMER_RELEASE_TOKEN` 作 environment `release` 的持久 secret(runner 一次性 mint、零回显,与 beta token 同前例) | 与 FLY-1323 姿态一致:「进 main = 代码授权前置」;能读该 secret 的只有 main 上声明 `environment: release` 的 job。**发布授权源(否决窗口/founder go)在 B4**;B1 期间 = founder 在 Discord 说 go → Lead 核身后 dispatch,run log + GitHub deployment 记录 who/when | 凭据边界不比今天更松:env `release` 本就要放 CF token,而 CF token 可以改写 Worker 的任何 capability 哈希(它是 customer-release 的超集);runner 能做的最坏事 = 提前 commit 一个**已由 main 代码 prepare 且过等价证明**的候选(跳过窗口),做不到「推任意字节给客户」(需要 beta-publish 明文,而 runner 读不到 secret) |
| B Bridge 持 token 直跑脚本 | 把 `FW_CUSTOMER_RELEASE_TOKEN` 放 Bridge 进程 env/文件,由 B4 状态机直接调 `payload-promote.mjs commit` | Discord 核身 founder(本机唯一 founder 专属信号) | 同 UID runner 可读 Bridge 的 env/文件(FLY-1062 Codex R3 判「0600 文件不是边界」);老 broker 就是为此而生、已被 FLY-2102 删掉;等于重建 broker。**拒** |
| C 手工脚本(现状) | 人拿 token 在本机跑 | 无机器门 | 不满足「发布全自动、不依赖 Annie 本机」直令;不可审计。**拒** |
| D GitHub required reviewers 人门 | environment 加 founder 为 reviewer | founder 点批准 | **套餐不支持(实测 422)**;且本机 gh 身份与 runner 共用。**不可行** |

**A 的诚实边界**:B1 交付的是「可被 B4 机械触发的 commit 执行面」,不是 founder 专属的授权门;授权门(否决窗口 + 送达回执 + founder veto/go 的 Discord 核身)= B4,B4 的执行动作就是 dispatch 这条 workflow。

### 2.2 Q2 customer-release token 托管:持久 env secret vs 每运行现 mint

- FLY-1323 §4 设想「每运行现 mint + `wrangler secret put`」,理由是不想为持久化 capability 再要一枚 admin PAT。但 runner 的 gh 登录本就能 `gh secret set`(beta token 就是这么放的),该理由不成立;每运行 mint 反而要求 CF token 出现在**每次 commit run** 里,并且每次改 Worker secret 会产生一个新 Worker version。
- **推荐:持久 env secret**,一次性 mint(`node -e crypto.randomBytes(32)` 直管 `gh secret set --env release`,零落盘零回显);其 sha256 由 activation `mode=infra` 新增一步灌进 Worker(需 CF token,一次);轮换 = 重跑同两步。

### 2.3 Q3 npm 壳发布姿态

- PRD §7.2 明令:2FA + OIDC/trusted publishing,**删 provenance 承诺**。
- 事实:npm trusted publishing 需 npm ≥ 11.5.1、node ≥ 22.14、`id-token: write`、`package.json.repository.url` 逐字等于仓库、npmjs 侧一次性配 trusted publisher(owner/repo/workflow 文件名/environment 名);私仓不生成 provenance(npm 按仓库可见性自动决定;显式 `NPM_CONFIG_PROVENANCE=false` 保证确定性)。
- 冲突点:`repository.url` 会把私仓 slug `xrliAnnie/flywheel` 写进公共 package.json,而 publish-gate G3 断言「零私仓 slug」。裁决:G3 登记**唯一例外**(仅 `package.json.repository.url` 且值逐字等于本仓 URL),其余文件仍零引用。slug 不是秘密(私仓 URL 对外 404;客户路径不经 GitHub)。
- 收益:删除长期 npm token(90 天上限、绕 2FA);Annie 一次性网页操作后零参与。

### 2.4 Q4 staging 清理策略(§7.3-7,PRD 交工程定)

- 候选 = `releaseOps[id]` 处于 `reserved|prepared` + 对象。三类要清:prepare 中途失败(reserved 有 tuple、对象可能已传)、被 veto/放弃、被更新候选取代。
- 策略:**同 base 只保留最新 prepared 候选**;新 prepare 成功时不自动 abandon 旧候选(prepare 只持 beta-publish,无权 abandon release op);`abandon` 由 commit workflow 的 `action=abandon` 承担(customer-release 权限),并给出 `--stale-days N`(默认 14)批量 abandon 早于 N 天的 `reserved|prepared` release 候选;abandoned 对象由既有 cleanup 三步收敛。
- cleanup 定时化:`FW_OPS_ADMIN_TOKEN` 同时能签发/吊销 license key,放进 CI 的爆炸半径过大;**本单不定时化**,维持 runbook 手动 + `--apply`,并把「拆 ops-admin 能力」记为 follow-up(不在 B1)。

### 2.5 Q5 withdraw 归属

PRD §14 B1 行含「撤版」;FLY-2387 §1.6 把 withdraw/paused 归 B5。折中:同一 commit workflow 提供 `action=withdraw`(带 `--fallback`,脚本已存在、同一凭据面,零新脚本);**paused / 无 fallback 原语与客户话术仍归 B5**。

### 2.6 Q6 beta 线修复归属

必须在 B1 内(chunk 0):客户端 ETag 归一化(剥 `W/` 与引号)+ handler 容忍弱 ETag + 412 分支打印 body + 双侧回归测试(mock 服务端回 `W/"..."`);Worker 重部署需 CF token,所以 handler 侧修复的生效时间 = Annie 重放 CF token 之后;客户端修复不依赖重部署,合入 main 后下一个 6h 定时即可验证。

---

## 3. 推荐方向与假设

**推荐**:选项 A + 持久 env secret + OIDC + 三动作 workflow + 清理策略如 §2.4 + chunk 0 修 beta 线。

假设(未获 Lead 反馈即按此进行):
1. environment `release` 继续作为唯一放 vendor/customer 凭据的环境;不新建 environment(套餐无 reviewer 功能,新建无增益)。
2. Annie 一次性动作:① 重新把 `CLOUDFLARE_API_TOKEN` 放进 env `release`;② npmjs 配 trusted publisher(`xrliAnnie/flywheel`,`payload-activation.yml`,environment `release`);③ 无需再建 npm token。
3. 本单不做 B4 否决窗口、不做 B5 paused/客户话术、不做 B3 判据、不做 cleanup 定时化、不拆 ops-admin。
4. 真发布(真 promote 一个 clean 版给客户)不在 design/implement 节点发生;E2E 分两层:hermetic(CI)+ 真 vendor 联合 E2E(QA 段,B2 端点已在线)。

## 4. 非阻塞问题与 Lead 裁决(question 1250dbe5,2026-09-08)

| # | 问题 | Lead 裁决 |
|---|---|---|
| F1 | beta 线 52 天静默失败是否另开事故单 | **不另开单**;根因修复作 B1 chunk 0(客户端剥 `W/` + handler 容忍 + 双侧回归);把「2026-07-18 起 210/210 CAS 412」作为一条评论记到 **FLY-2134**(「无人看的监视器」目录单)并在本文引用。本 design 节点无 Linear 写入凭据(MCP 401、无 API key),评论文本已随 DONE 报告交 Lead 代贴 |
| D1 | commit 执行面 | **接受 A**:`workflow_dispatch` + main-only + environment `release` + runner 零回显 mint 的持久 env secret;授权 = founder 每次实例化的「go」经 Lead 转达(R1 领域,绝不 Lead 自发),机器否决窗口归 B4 |
| D2 | npm OIDC | **接受**;凡需 Annie 本人的步骤(npmjs trusted publisher 配置、把 `CLOUDFLARE_API_TOKEN` 放进 env `release`)进 founder HTML 的「founder 手动前置清单」;**不得假设已完成,也不让 B1 代码阻塞于此** |
| D3 | 三动作 | **接受**;paused / 无 fallback → B5 |
| D4 | `repository.url` 暴露私仓 slug | **接受并披露**:founder HTML 明说私仓 slug 会出现在公共 npm 页(外人 404);登记为 publish-gate 唯一例外 |

FLY-2134 备注文本(供 Lead 代贴):「`payload-beta-release.yml` 自 2026-07-18 18:22 UTC(`FW_ENDPOINT` 设定后首个定时 fire)起至 2026-09-09 00:41 UTC 连续 210 次失败,全部为 `reserve: CAS conflict` ×8 → `CAS retries exhausted`;此前 26 次「成功」是 pre-activation no-op。无任何告警接线;发现者 FLY-2388 design 节点。根因假说与修复见 `engineering/doc/FLY-2388-release-pipeline-p4/`。」

## 5. 边界

不做:B3/B4/B5;不改 PR2 客户端字节;不改 manifest schema(仍 1);不改 Worker 能力模型(除弱 ETag 容忍 + 可选 HEAD 路由);不做任何真发布动作。
