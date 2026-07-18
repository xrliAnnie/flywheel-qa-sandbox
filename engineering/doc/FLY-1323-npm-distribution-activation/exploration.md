# FLY-1323 激活 npm 分发层 — 探索

Issue: FLY-1323 (https://linear.app/geoforge3d/issue/FLY-1323/激活-fly-1062-npm-分发层一次性初始化-建-bucket-部署-worker-灌-token-发首个-payload-npm)
日期: 2026-07-16
基于: 无(上游 = FLY-1062 四个已 merge 的 PR + doc/engineer/implementation/fly-1062-payload-release-runbook.md)

---

## 1. 这单是什么

FLY-1062 把 npm 分发层的**机器件**全建完了(四个 PR 全 merged、单已 Done),但**从没跑过一次真发布**。
结果:客户「零仓库访问、一条命令装」的承诺今天物理上不成立 —— 仓库是 PRIVATE,新用户必须有私仓权限才能装。

这单不是写功能,是**一次性初始化**:建 bucket、部署 Worker、灌 token、发首个 payload、发薄壳包。
本质是**运维激活**,不是 feature build。代码改动预计只有一处(DEFAULT_ENDPOINT 占位符)。

## 2. 现状审计(我自己复核,不是转述 issue)

### 2.1 issue 给的三条硬事实 —— 全部成立

| 事实 | 我的复核方式 | 结果 |
|---|---|---|
| `npm view @flywheel-ai/onboard` → E404 | 真跑 npm view | ✅ E404,包从未发布 |
| `config.mjs:12` DEFAULT_ENDPOINT 是占位符 | 读文件 | ✅ `https://onboard.flywheel.invalid` |
| 无 repo variable `FW_ENDPOINT` | `gh variable list -R xrliAnnie/flywheel` | ✅ 空 |

### 2.2 我额外查出来的(issue 没提)

- **`gh secret list` 也是空的** —— 不只 `FW_ENDPOINT` 这个 variable 缺,**`FW_BETA_PUBLISH_TOKEN` 这个 repo secret 同样不存在**。
  也就是说 beta release CI 就算 endpoint 配好了,没这个 secret 也发不出去。Annie 清单里必须有这一条。
- **`wrangler` 本机未安装** —— runbook §1 的每条命令都以它开头。装它是我能做的事(npx / devDependency),不占 Annie 时间。
- **org 名 `flywheel` 登录后发现已被占** —— registry 侧 `scope:flywheel` 曾查到零包看似可用,但**空 ≠ 可注册**:
  真正登录去 Add Organization 时 npm 报「`flywheel` is not available」。产品侧拍板改名 → org `flywheel-ai`(已建好,owner=xrliannie.b),
  包名相应 `@flywheel-ai/onboard`。教训:org 名可用性只有登录后 Add Organization 才算数,registry 零包不代表可注册。
- **R2 需要先在账号上启用,且启用 R2 要绑付款方式**(免费额度也要)。
  Annie 账号(xrliannie.b@gmail.com)目前大概率没启用过 R2。**这一步卡住,后面全停** ——
  必须在她那 15 分钟之前就让她知道,否则窗口白开。

### 2.3 机器件盘点 —— 该有的都在

- `packages/payload-endpoint/` — Worker(`worker.mjs`)+ **纯函数 handler** + 三 capability 模型(端点只存 sha256)
- `packages/payload-endpoint/src/serve-node.mjs` — **本机可跑的真端点**(FsBucket 后端,同一个 handler)
- `packages/onboard-shell/` — 薄壳包 `@flywheel-ai/onboard`(bin + lib,publishConfig.access=public)
- `scripts/release/` — payload-release / payload-promote / license-key / payload-cleanup / shell-prepare / broker-request
- `.github/workflows/` — payload-beta-release.yml(每 6h + dispatch,带 pre-activation guard)+ payload-promote.yml(prepare 半段)
- `packages/teamlead/src/bridge/publish-broker/` — broker(#565 已落地,unix socket + approve gate,`FLYWHEEL_PUBLISH_BROKER=1` 才启,默认关)
- `scripts/__tests__/customer-e2e-acceptance.test.sh` — **整条链的真形态 E2E**(见下)

**结论:缺的不是件,是「一次真发布」。**

## 3. 关键发现:彩排不用我从头造

原本我打算自己搭一套本机彩排。审计时发现 **`customer-e2e-acceptance.test.sh` 已经就是那套彩排**,
而且是真形态、服务路径零 stub:

```
真 release 脚本 ──publish──▶ 真端点(serve-node + FsBucket)
                                  ▲
客户机:npm-pack 装出来的壳 ──Bearer key──┘
```

覆盖 E1 建 manifest → E2 beta 发布 → E3 promote(等价证明 + commit)→ E4 签 key →
E5 **全新 HOME 从 npm tarball 装壳、端到端装完**(零仓库访问)→ E6 端点重启后第二个客户仍能装。

沙箱性我先验过:E5 用 `env -i HOME="$H"`,不碰真 `~/.flywheel`(记忆里那条「Runner 绝不 host 上跑 provisioning 测试」的雷,这里不踩)。

**意义**:Annie 的 15 分钟窗口之前,整条链能不能跑通是**可以先证明的**,不用拿她的时间去试错。
这把**协议层和薄壳/serve 路径**的风险提前证掉了。

> ⚠️ **后续更正(Codex design R1 抓出,我核源码后认)**:一开始我在这里写的是
> 「压到只剩 vendor 侧配置对不对」——**过度声称**。这个 E2E 用 **fake packer**
> 绕开了生产 `package-onboard.sh`,没证明真 payload 组装 / 真 Bridge 启动 /
> 任何 R2·Worker 真实语义。详见 research §1.0。

### 3.1 一个真实的坑(记一笔)

第一次跑我写成 `timeout 900 bash ...`。macOS 没有 `timeout`,命令根本没执行,
但因为管道到了 `tail`,**退出码是 0**。差点当成「彩排通过」。
—— 这正是「空过的绿测」:绿不等于跑过。改成裸 `bash` 重跑。

## 4. 分工(issue 已定,我照做)

- **我**:备齐一切 —— 逐条命令、Worker 配置、runbook 核对、npm 账号确认、本机全链彩排。干到「只差 Annie」再约窗口。
- **Annie**:~15 分钟,只做持凭据的步骤(建 bucket / 授权 / publish 确认)。

## 5. 三段执行

| 段 | 谁 | 做什么 | 凭据 |
|---|---|---|---|
| A | 我 | 本机 serve-node 全链彩排 → 把 Annie 的 15 分钟压成逐条 copy-paste 清单(每条我验证过等价形态) | 零 |
| B | Annie | 启用 R2 + 建 bucket + `wrangler deploy` + 三个 sha256 secret + 建 npm org + 出 GAT + `gh variable/secret set` | 她本人 |
| C | 我 + 她两次 approve | beta CI 真跑 → **DEFAULT_ENDPOINT 换真 URL 的 PR** → promote commit(approve)→ npm publish(approve)→ 干净环境验收 | broker 内存 |

**为什么 DEFAULT_ENDPOINT 必须是第二个 PR**:真 URL 是 `https://flywheel-onboard-endpoint.<subdomain>.workers.dev`,
`<subdomain>` 是账号级的,**部署完才知道**。所以占位符的修复物理上不能跟 A 段同 PR。

## 6. 待 Lead 拍的两件事(已进 brainstorm gate)

### ① npm publish 走 broker 还是 Annie 本机直发?

- **broker 路(runbook §7 的设计形态,我倾向)**:要 Bridge 带 `FLYWHEEL_PUBLISH_BROKER=1` +
  进程 env 注入 `FW_NPM_GAT_TOKEN`/`FW_CUSTOMER_RELEASE_TOKEN` **重启一次 = Tier-3**,
  且 token 只活在 Bridge 内存、重启即失效。代价:一次 Tier-3 重启 + 供 token 的运维动作。
  收益:设计已 design-review 过、留 audit log,**且 payload 的 promote-commit 反正也得走 broker —— 一次重启覆盖两个动作**。
- **直发路**:Annie 在她自己终端 `npm publish`(她本就在场、2FA 在她手上),省她时间但偏离已审形态。

重启窗口不是 Runner 能定的 → Lead 拍。

### ② 我不用 Claude-in-Chrome 代 Annie 操作 Cloudflare

runbook §1.2 写了 Runner 可以用 Chrome 替她 bootstrap 首把 API token。但那跟两件事冲突:
issue 本身的分工(Annie 亲跑持凭据步骤)、以及「不冒用 founder 会话做访问控制变更」。
**发 API token 就是访问控制变更**。我按 issue 分工走 = 一行凭据不碰。

## 7. 验收

干净、无私仓权限的环境:`npx @flywheel-ai/onboard` 一条命令走通下载 + 安装引导。
(FLY-1322 摩擦 #1/#2 的关闭判据。)

**这条我不自验** —— 按规矩要独立 QA。实现者自验 = 自证。
