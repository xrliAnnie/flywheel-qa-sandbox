# FLY-1323 · CI 全自动发布 — 设计文档(安全姿态变更)

Issue: FLY-1323 (https://linear.app/geoforge3d/issue/FLY-1323/激活-fly-1062-npm-分发层一次性初始化-建-bucket-部署-worker-灌-token-发首个-payload-npm)
日期: 2026-07-18
基于: annie-5min-token-handbook.md;推翻 fly-1062-payload-release-runbook.md §0 底线一/二/三 的「凭据绝不进 CI」形态

---

## 0. 为什么有这份文档 —— 一次**有意的**安全合同反转

Annie 直令(2026-07-18):拒绝每次亲手发布,要求**一次性 token 化**——她只创建两枚 token,之后所有执行(含 npm publish)归 runner/CI,以后零参与。

这直接推翻 FLY-1062 reviewed 设计的三条底线,而且这三条**不是文档口号,是机器强制的**——`scripts/__tests__/release-workflows-structure.test.sh`(S1/S4a–f)硬断言「任何 workflow 零 Cloudflare 引用、零 npm token、零 `npm publish`、无 shell-publish.yml」。本设计的**核心交付不是加一条 workflow,是把这份机器合同重写成新姿态**。

> 这份文档存在的意义 = 让这次反转是**被审过、被记录、可解释**的,不是某个 diff 里悄悄发生的。Codex 审的重点应是 §2 的新合同 + §3 的缓解够不够,而非 workflow 的 YAML 细节。

## 1. 旧姿态 vs 新姿态

| | 旧(FLY-1062,Codex 已批) | 新(本设计) |
|---|---|---|
| CF API token | 只在 Annie 手里,绝不进 CI(底线二) | 进 GitHub **Environment `release`** secret |
| npm 发布 token | 只在 broker 父进程内存,绝不进 CI(底线三) | 进 Environment `release` secret |
| customer-release / ops-admin | broker 内存 / Annie 密管 | **每次运行现 mint、用完即弃**(见 §4) |
| 发布授权 | 每次发布 = Annie 一条 Discord approve(broker gate) | **merge 到 main = 发布授权**(见 §2) |
| npm publish | broker 动作,绝不进 CI | main 上的 CI workflow |

## 2. 新安全姿态:merge 门 = 发布门

**唯一的授权闸从「每次发布 Annie approve」变成「merge 到 main」。** 机制:

- 两枚持久 secret(`CLOUDFLARE_API_TOKEN` / `NPM_PUBLISH_TOKEN`)放 GitHub **Environment `release`**,不是裸 repo secret。
- Environment `release` 配 **deployment branch policy = 只允许 `main`**。
- GitHub 的语义:**只有跑在 `main` 上、且声明了 `environment: release` 的 job 才能读到这两枚 secret**。任何 PR、任何非-main 分支、任何 fork 的 workflow **拿不到**。
- 本仓 main 受 branch protection + founder-gated merge(FLY-175 founder-only-authority + 本单 #628 就是 Annie approve 后 Tadashi 才合的)。

**推论**:能触发发布 = 能让代码上 main = 通过 founder-gated merge。所以「零参与发布」对 Annie 的实际含义 = 她不再逐次 approve npm publish,但**每个进入发布通道的改动仍过她的 merge 门**。这就是用 merge 门替换 per-publish 门,不是取消门。

## 3. Blast radius 与缓解

| 风险 | 缓解 |
|---|---|
| CF token 进 CI = 任意 workflow 能部署 Worker / 写 R2 | Environment + main-only:PR/分支 workflow 读不到;只有 main 上声明 `environment: release` 的 job 能用 |
| npm token 进 CI = 任意 workflow 能发这个包 | 同上 + npm token 是 **granular、scope 限 @flywheel-ai/onboard、read+write**(别的包动不了) |
| CF token 权限过大 | token 建时最小化:Workers Scripts Edit + R2 Storage Edit + Account Settings Read,限她那一个账号(见 annie-5min-token-handbook.md) |
| 2FA-bypass 的 npm token 泄漏 | granular + 单包 scope + 可设到期 + 随时 revoke;泄漏面 = 只能发这一个包 |
| 一个恶意/有 bug 的 workflow 改动 | 它要先 merge 到 main 才能读 secret = 先过 founder-gated merge + Codex code review(FLY-827) |

**诚实边界**:这确实比旧姿态松(旧姿态 = token 根本不在 CI,物理上 CI 发不出去)。新姿态把「不可能」降级为「要过 merge 门」。这是 Annie 明确选择的 tradeoff(她要零参与),缓解是把 merge 门做成真门(Environment + main-only + 现有 branch protection + founder-gated merge)。

## 4. Capability token 托管:每运行现 mint,不持久

beta-publish / customer-release / ops-admin 三枚 capability token(Worker 只存其 sha256)**不进任何持久 secret**。每个写 Worker 的 workflow:

1. 现场 `crypto.randomBytes(32)` mint 一枚临时 token,算 sha256;
2. 用 CF token `wrangler secret put` 把 sha256 灌进 Worker(覆盖上一枚);
3. 用这枚临时 token 做本次操作(manifest / release / promote / license);
4. 运行结束即弃(只活在这一次 CI 运行的内存)。

**收益**:Annie 仍只建 2 枚 token(CF + npm),不需要第 3 枚 admin PAT 去把 capability token 持久化进 GitHub secret;持久 secret 面收敛到 2 枚。Worker 永远只认「最近一次运行灌的」sha256,旧的自动失效。

**代价/边界**:同一时刻只应有一个发布 workflow 在跑(否则两个 run 抢着灌 sha256 会互踩)——沿用现有 `concurrency: payload-release` 单飞组,天然串行。

## 5. 本 PR 的范围(最小 activation)

`.github/workflows/payload-activation.yml`(`workflow_dispatch`,`environment: release`,main-only,confirm=ACTIVATE)。**两个 mode**——npm 发出去的必须是 reviewed 树,而真 workers.dev URL 只有第一次 deploy 后才知道,所以 infra 和 publish 之间隔着 DEFAULT_ENDPOINT 的 PR:

- **mode=infra**:subdomain 验证(不发明,见 §7c)→ 建 bucket(容忍已存在=resume)→ `wrangler deploy` 抓 URL → 从 `FW_BETA_PUBLISH_TOKEN` secret 在 run 内派生 sha256 灌 Worker(见 §7a;customer/ops 不灌=fail-closed,等各自 workflow)→ init manifest(conditional create,412+GET 校验=resume)→ 打印 URL。**不发布。**
- **(中间)**:我开一条一行 PR 把真 URL 写进 `DEFAULT_ENDPOINT` → Codex review → founder-gated merge。
- **mode=publish**:拒占位符(URL PR 没合并就物理跑不了)→ preflight(`prepublishOnly` 钩子兜底重跑)→ `npm publish @flywheel-ai/onboard` → `npm view` 精确版本回读确认。

**首发后**:我(runner,非 Annie)`gh variable set FW_ENDPOINT <URL>`(URL 非秘密),使现有 beta-release workflow 的 pre-activation guard 解除、开始每 6h 自动发 beta。

**随后**(同路径,各自 PR + Codex code review):正式 promote-commit workflow + shell-publish workflow(重建当年删掉的那条,但这次在 release environment + main-only),各自 mint 自己那枚临时 capability。

**不在本 PR**:改 broker(broker 路保留、不动);改 Worker 代码;发真 customer payload(那要 promote workflow)。所以本 PR 首发的 0.1.0 壳装得上、但 manifest 空 = customer 装会 503,直到 promote workflow 跟上——这是「打通管线」的中间态,无真客户,可接受。

## 6. 机器合同的重写(`release-workflows-structure.test.sh`)

旧断言 → 新断言:
- **S4a**(零 CLOUDFLARE 引用)→ 「CLOUDFLARE 只出现在声明了 `environment: release` 的 workflow 里」。
- **S4c**(零 npm token)→ 「npm token 只出现在 `environment: release` 的 workflow 里」。
- **S4f / S1**(零 `npm publish` / 无 shell-publish)→ 「`npm publish` 只出现在 `environment: release` + main-only guard 的 workflow 里」。
- **新增 S5**:每个引用 CF/npm secret 的 workflow **必须**声明 `environment: release` **且**带 main-only ref guard——缺任一即红。这是把「merge 门=发布门」变成机器强制的正断言(不只是放宽旧禁令)。
- 保留:beta/promote 仍只持 beta-publish(S4d/S4e 对那两条不变)。

> 关键:重写不是「删掉旧闸」,是「把旧闸(禁令)换成新闸(正向要求 Environment+main-only)」。一个把 CF token 放进没有 `environment: release` 的 workflow 的 mutation,必须在这里变红。

## 7. 实施定案(建成时的三个具体化 + 一个 follow-up)

### 7a. beta capability token 的托管(对 §4 的一处具体化)
beta-publish token 与 customer/ops 不同:**现有 beta workflow(每 6h)需要它持久存在**,而 GITHUB_TOKEN 无法在 CI 内写 repo secret。故 beta token 由 orchestrating runner 一次性 mint(node crypto → gh secret set 直管,零落盘零回显)进 repo secret `FW_BETA_PUBLISH_TOKEN` —— **这本来就是 FLY-1062 旧姿态明文允许的**(「GitHub CI 只持 beta-publish token」,internal-beta blast radius)。activation workflow 在 run 内从该 secret 派生 sha256 灌 Worker,secret 与 Worker 永不漂移。customer/ops 维持 §4 的 per-run ephemeral(它们的 workflow 落地时各自 mint)。

### 7b. vendor secrets 必须是 Environment 级(合并前置)
Annie 首次入库时手册还写的是 repo 级命令(Codex R1 HIGH-1 抓的:活文档会在每次轮换重新引入洞)——**手册已改为 canonical 的 env 级形态**(--env release + 删 repo 级 + 双列表核验,轮换同款)。当前实际状态仍是 repo 级(已核:env release 下为空),所以**首次 dispatch 前必须完成一次迁移**:Annie(或 Tadashi 代)把两枚 secret 以 `--env release` 重新入库 + 删除 repo 级副本(值只有她有,agent 无法搬运)。命令(隐藏输入,不加 --body):
gh secret set CLOUDFLARE_API_TOKEN -R xrliAnnie/flywheel --env release
gh secret set NPM_PUBLISH_TOKEN -R xrliAnnie/flywheel --env release
gh secret delete CLOUDFLARE_API_TOKEN -R xrliAnnie/flywheel
gh secret delete NPM_PUBLISH_TOKEN -R xrliAnnie/flywheel

### 7c. workers.dev subdomain 是 founder 决定
账号级 subdomain 出现在客户 URL 里。activation workflow **只验证不发明**:无 subdomain 且未提供输入 → fail-closed 并提示 founder 起名后带 `workers-subdomain` 输入重派。

### 7d. Follow-up:npm Trusted Publishing(OIDC)迁移(Tadashi 指令 bc7dd42c)
npm granular token 有 90 天上限 + 绕 2FA。npm 官方推荐 **Trusted Publishing(OIDC)**:无 token、无轮换,workflow 用 `id-token: write` 直连 npmjs 信任关系。迁移步骤:① 首发后在 npmjs 包设置里配置 trusted publisher(指向本 repo + payload-activation.yml;需 npm owner 一次网页操作)② workflow 去掉 NODE_AUTH_TOKEN、加 id-token: write、CI 内升 npm ≥11.5.1(R4 的 oidc-toolchain-floor 测试就是这个铺垫)③ **删除 NPM_PUBLISH_TOKEN secret + revoke 该 token**。届时 structure test 的 S4c 允许名单相应收紧(id-token 只许 activation)。
