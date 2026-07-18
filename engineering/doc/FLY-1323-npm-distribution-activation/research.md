# FLY-1323 激活 npm 分发层 — 调研

Issue: FLY-1323 (https://linear.app/geoforge3d/issue/FLY-1323/激活-fly-1062-npm-分发层一次性初始化-建-bucket-部署-worker-灌-token-发首个-payload-npm)
日期: 2026-07-16
基于: exploration.md

---

## 0. 调研目标

激活是**一次性、持凭据、Annie 只出 15 分钟**的动作。所以调研只有一个目的:
**把她那 15 分钟里的每一条命令,先在本机验证到「不用试错」。**

任何我没验证过就写进清单的东西 = 拿她的时间赌。下面每一条都标了**我怎么验的**。

## 1. 本机彩排证明了什么(以及**没**证明什么)

**结论:协议层 + 薄壳/serve 路径本机真跑 8/8 PASS —— 但这不等于「整条链已证明」。见 §1.0。**

`scripts/__tests__/customer-e2e-acceptance.test.sh`(#565 带来的)就是整条链的真形态彩排,服务路径零 stub:

```
真 release 脚本 ──publish──▶ 真端点(serve-node + FsBucket)
                                  ▲
客户机:npm-pack 装出来的壳 ──Bearer key──┘
```

我真跑的结果:

```
[TEST] ✓ E1 conditional-create initialized the manifest (real route)
[TEST] ✓ E2 beta released via payload-release.mjs (reserve→pack→claim→upload→readback→commit)
[TEST] ✓ E3a promote prepare (clean build + equivalence proof + staged candidate)
[TEST] ✓ E3b promote commit → customer-release.latest = 9.9.9
[TEST] ✓ E4 customer license key issued through the real endpoint
[TEST] ✓ E5 customer chain: tarball-installed shell → real endpoint → 9.9.9 installed + handoff ran
[TEST] ✓ E5b zero repository access in the customer-visible install
[TEST] ✓ E6 endpoint restart (same FsBucket dir): a second fresh customer still installs
RESULTS: 8 passed, 0 failed
```

### 1.0 ⚠️ 这个 8/8 到底证明了什么 —— 我一开始吹了,已收窄

我原话是「**这把风险压到只剩 vendor 侧配置对不对**」。**这是过度声称。Codex design R1 抓出来,我核了源码,认。**

**真相**:`customer-e2e-acceptance.test.sh:51-80` 自己造了一个 **fake packer**
(`$SANDBOX/fake-packer.sh`),通过 `FW_PACKER=` 注入,**绕开生产的 `scripts/package-onboard.sh`**。
它产的「payload」是:一个最小 `package.json` + `echo "// bridge entry"` + 一个只写 marker 的 handoff 脚本。

所以这 8/8 **证明了**:
- manifest 状态机 + CAS + releaseOps 幂等账本
- release / promote / license-key 脚本的真实协议往返
- 客户 Bearer 读取 + **真 npm tarball 装出来的薄壳** + 安装目录翻转
- FsBucket 重启后的耐久性

**它没有证明**:
- 真 payload 组装(真 `package-onboard.sh`、真依赖、better-sqlite3 原生模块)
- 真 provision / bootstrap / Bridge 起得来
- **任何 R2 / Worker 的真实语义**

**FsBucket 跑绿盖不住的真 vendor 风险**(Codex 列的,我认同):
账号/R2 subscription 与 `PAYLOADS` binding 绑错账号或错 bucket;workers.dev 子域 / DNS / TLS 传播;
意外的 Cloudflare Access 让客户拿到 403/HTML;Workers runtime 的 Web Streams / `crypto.subtle` 与 Node 行为差异 +
CPU/内存/body limits;R2 对 `onlyIf` / etag / customMetadata 的真实语义 + 多 Worker 实例并发
(FsBucket 只是**单进程 mutex**,`fs-bucket.mjs:80-93`);真 payload 的体积与上传/回读耗时。

**诚实结论**:这 8/8 **显著 de-risk 了协议层和薄壳/serve 路径** —— 不是「只剩 vendor 配置」。
真 R2/Worker 的 checkpoint 是生产 beta、promote prepare、direct commit 这三步,
**最终验收仍然只认独立 QA 在干净机器上的那一条命令**。

### 1.1 差点被骗的一次(记下来)

第一次我写 `timeout 900 bash scripts/__tests__/customer-e2e-acceptance.test.sh 2>&1 | tail -30`。
macOS **没有 `timeout`**(那是 GNU coreutils 的)。命令根本没跑,但管道末端是 `tail`,
**退出码 0**,输出只有一行 `command not found`。

差一点就记成「彩排通过」。**绿 ≠ 跑过**。裸 `bash` 重跑才是上面那 8 行。

### 1.2 沙箱性(先验后跑)

跑之前先确认它不碰生产 `~/.flywheel`(「Runner 绝不 host 上跑 provisioning 测试」那条雷):
`grep` 出 `env -i HOME="$H"` + `FLYWHEEL_STATE_DIR="$H/.flywheel"` —— 全新 HOME,`env -i` 连环境都清了。安全。

## 2. Annie 的两个真 blocker

### 2.1 R2 必须绑付款方式 —— 已证实,且可能立刻扣钱

### ⚠️ 已被真机只读核实推翻/收窄(2026-07-16,Annie 授权 Claude-in-Chrome 只读)

**别看下面的二手查证 —— 我后来直接看了她的 dashboard,以真机为准:**

| 问题 | 二手查证(下表)说 | **真机只读实测** |
|---|---|---|
| R2 启用了吗 | 需要 R2 subscription | ❌ **没启用**(`/r2/overview` 跳购买页) |
| 要绑付款方式吗 | 「必须绑,免费额度也要」 | ✅ 成立 —— Billing 页原文 **"No payment method on file"**,确实得绑 |
| **会被扣 $5 吗** | 社区报告「立刻扣 5 USD」 | ❌ **这个账号页面上不是这样**:**Total Due Now = $0.00**、「Due Monthly $0.00 + additional usage」、「You will only be charged if you exceed the monthly limits」。免费额度 10GB/1M/10M 每月,我们的用量差得远。 |

**教训**:我把一条 **community anecdote** 当成了「她会遇到的事实」写进给 founder 的清单 —— 这是拿别人的轶事吓 founder。
真机一看就推翻了。**该查一手的时候别引二手。** 清单已更正(§0a)。
(诚实边界:绑卡时发卡行**可能**有小额验证预授权 —— 那是银行行为,Cloudflare 页面没提,我不当事实说。)

| 二手查证(留档,已被上面推翻/收窄) | 结果 |
|---|---|
| Cloudflare R2 get-started 文档 | 前置 = "a Cloudflare account with an **R2 subscription**" |
| R2 定价页 / 社区 | 「启用 R2 必须绑定付款方式」→ **真机证实要绑** |
| 社区帖「绑卡后立刻被扣 5 USD」 | **真机推翻:Total Due Now = $0.00** |

**这是她的钱,必须她自己知情后决定** —— 不是我能替她点的(「Add R2 subscription」+ 绑卡 = 付款 + 接受条款,红线)。
放清单**第 0 条预检**:这一步过不了,后面全停。

来源:
- [Cloudflare R2 get-started](https://developers.cloudflare.com/r2/get-started/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [社区:R2 要求绑付款方式](https://community.cloudflare.com/t/if-i-want-to-use-cloudflare-r2-i-have-to-link-a-payment-method-i-suggest-not-doin/887578)
- [社区:R2 激活被扣 5 USD](https://community.cloudflare.com/t/question-regarding-5-usd-charge-for-r2-storage-activation/900480)

### 2.2 npm org `flywheel` —— 风险比我一开始判断的**低**

一开始我担心两件事,查完只剩一件:

| 疑虑 | 查证 | 结论 |
|---|---|---|
| scope 被占? | registry 查 `scope:flywheel` → 零包;`/-/org/flywheel` → 404 | scope 是空的 |
| **无 scope 包 `flywheel` 存在会不会挡住建同名 org?** | registry 查 → **存在**,2012 年建,maintainer `hughfdjackson`,latest 0.1.0 | **不挡** —— 见下 |
| org 名真能注册? | npm 官方文档 `creating-an-organization` **没写任何命名冲突规则** | **只有登录点一次才知道** |

**「无 scope 包不挡同名 org」我不是猜的,是找到了反例证据**:
- 无 scope 包 `babel` 存在(200) **且** org `@babel` 存在(`@babel/core` 200)
- 无 scope 包 `angular` 存在(200) **且** org `@angular` 存在(`@angular/core` 200)

同名无 scope 包与 org 可以共存 → 2012 那个 `flywheel` 包**不是 blocker**。

**剩余风险(低但非零)**:npm org 名与 **username** 可能同命名空间;`/-/user/org.couchdb.user:flywheel` 返回 401(要 auth,查不出)。
所以只能:**Annie 登录 → Create Org → 输 `flywheel` → 看能不能建**。
万一被占 → **包名要改 = 产品决定 → 升 Annie**(Tadashi 已确认这条路由)。

> 踩过的坑:`npmjs.com` 直接 curl 全是 403 —— 那是 Cloudflare 拦无 User-Agent 的请求,不是「不存在」。
> 用 registry API(`registry.npmjs.org`)才是可靠判据。

## 3. 工具链 —— 全部实测,不是从文档抄的

### 3.1 wrangler:不用装

```
npx --yes wrangler@4.111.0 --version   → 4.111.0     (实测,无需 auth)
```

**不用 `pnpm add`、不用全局装。** 直接 npx,Annie 那边零安装成本。

### 3.2 runbook 里的命令在 4.111.0 上还存在吗 —— 实测过

runbook 是 2026-07-11 写的,wrangler 是活跃项目,命令可能改名。逐条 `--help` 验:

| runbook 命令 | 4.111.0 实测 |
|---|---|
| `wrangler r2 bucket create <name>` | ✅ 存在,签名一致(`Create a new R2 bucket`) |
| `wrangler secret put <key>` | ✅ 存在,签名一致(`Create or update a secret for a Worker`) |

(只验到 `--help` 层 —— 真正的建桶/部署要她的 token,那是 B 段。
但**命令名和参数形状是真的**,不会在她窗口里撞「unknown command」。)

### 3.3 `wrangler.toml` 缺 `account_id`

```toml
name = "flywheel-onboard-endpoint"
main = "src/worker.mjs"
compatibility_date = "2026-07-01"
[[r2_buckets]]
binding = "PAYLOADS"
bucket_name = "flywheel-payloads"
```

**没有 `account_id`**。她账号下有 GeoForge3D 在用的东西(Pages 项目 `custom-map-studio` + `memoscaped.com` 的 DNS/Email Routing),
如果 token 覆盖多个账号,wrangler 会要求指明。
→ 清单里给 `CLOUDFLARE_ACCOUNT_ID` 的取法,并在部署命令前显式 export。**避免她在窗口里撞交互式选择器。**

### 3.4 token 生成命令(runbook §1.1)—— 实测可用

```
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
```
实测输出 token + sha256 两行,正常。端点只存 sha256,token 本体按 custody 表分发。

## 4. issue 没提但会咬人的:repo secret 也是空的

`gh secret list -R xrliAnnie/flywheel` → **空**。

issue 只说了「repo variables 无 `FW_ENDPOINT`」。但 **`FW_BETA_PUBLISH_TOKEN` 这个 repo secret 同样不存在**。
→ 光配 `FW_ENDPOINT`,beta release CI 仍然发不出去(它要 `secrets.FW_BETA_PUBLISH_TOKEN`)。

**两条都得配。以清单(annie-activation-checklist.md)里的命令为准 —— 那里是唯一权威的凭据命令来源。**
其中 **secret 绝不能用 `--body`**(会把 token 落进 shell history + 短暂进程 argv);清单用不加 `--body` 的隐藏 stdin 形式:
```
# variable 是 URL,不是 secret,--body 无所谓:
gh variable set FW_ENDPOINT -R xrliAnnie/flywheel --body "<真 workers.dev URL>"
# secret 是 token,必须隐藏输入(不加 --body → gh 从 stdin 读,不进 history/argv),见清单步骤 6:
gh secret set FW_BETA_PUBLISH_TOKEN -R xrliAnnie/flywheel
```
(2026-07-17 更正,Codex R7:此处原来给的 `gh secret set … --body "<beta token 明文>"` 与凭据契约冲突,已改。)

## 5. endpoint URL 的形状 & 为什么占位符只能第二个 PR 修

Annie 确认过 endpoint 形态 = **workers.dev 免费地址**(runbook §1.2)。
worker name = `flywheel-onboard-endpoint` → URL 形如:

```
https://flywheel-onboard-endpoint.<account-subdomain>.workers.dev
```

`<account-subdomain>` 是**账号级的、部署完才知道**。
→ `DEFAULT_ENDPOINT` 的修复**物理上不能**跟 A 段同一个 PR。必须 B 段拿到真 URL 之后单开 PR。

### 5.1 ⚠️ 占位符的闸**不在** `npm publish` 路径上 —— 直发把它丢了

我一开始写的是「占位符没修壳根本发不出去,顺序被代码锁死」。**这是错的,我核了源码后推翻**:

- `shell-prepare.mjs` 确实有硬闸(撞 `flywheel.invalid` 就拒 stage,除非 `--allow-placeholder`)
- **但 `npm publish` 根本不经过它。** `packages/onboard-shell/package.json` 里
  **一个 script 都没有**(实测 `scripts: <NONE>`)—— 没有 `prepublishOnly`、没有任何钩子。

→ **走 broker 本来自带这道闸;Tadashi 拍的「首发 Annie 直发」把它丢了。**
这是那个偏差的真实代价,不能假装不存在。

> 🔴 **2026-07-17 更正(本节以下是修复前的观察,已被后续实现推翻)**:
> 本 PR **已经在 `packages/onboard-shell/package.json` 里加了 `prepublishOnly` 钩子**
> (`bash ../../scripts/release/shell-publish-preflight.sh --founder-local`)。
> 所以现在**裸 `npm publish` 会自动跑这道 preflight** —— 它**不再只是「人执行的补偿」,而是结构性的闸**
> (由 G6a/G6b/G7 + shell-pack P4d 钉住)。下面这几段「零 script / 只能靠人记得跑」的描述是当时的现状,
> 保留作历史,但**当前契约以此更正为准**。

**补偿控制**:`scripts/release/shell-publish-preflight.sh --founder-local`。
它就是为这条路造的 —— 文件头原话:*"the SHARED guard for BOTH publish paths
(the dormant shell-publish.yml workflow AND **the founder-local 2FA command in the runbook**)"*。
`--founder-local` 只跳过 OIDC 工具链地板,仍然查:① 占位符 ② 版本复用 ③ 打包内容白名单。

**实测它现在真的会拒**(当前树还是占位符):
```
$ bash scripts/release/shell-publish-preflight.sh --founder-local
[shell-publish-preflight] DEFAULT_ENDPOINT is still the .invalid placeholder — ...
EXIT=1
```
不是读注释推断的 —— 真跑,真 exit 1。

→ **清单步骤 10a 把这条设成硬要求**(必须看到 `PREFLIGHT PASS` 才许 publish)。
~~这是人执行的补偿控制,不是结构性保证~~ —— **已被本节顶部的更正推翻**:PR-1 加了 `prepublishOnly` 钩子,
裸 `npm publish` 现在会自动跑这道 preflight,**是结构性的闸**(G6a 精确匹配 + G6b + G7 + shell-pack P4d 钉住);
步骤 10a 显式再跑一次是**双保险**,不是唯一防线。上面这段是修复前写法,留作历史。

## 6. 发布路径 —— Tadashi 已拍(混合)

| | 首发(本单) | 常态(下一个批量重启窗口) |
|---|---|---|
| payload promote-commit | Annie 直发 | broker + approve gate |
| shell npm publish | **Annie 本机 `npm publish`**(她在场、2FA 在手、零重启) | broker `publish-shell` + approve gate |

**不为本单单独触发 Tier-3 重启**(现在有 attended 陪走 + 1182 常开在飞,重启窗口 Tadashi 统一排)。
首发直发**如实记为对 broker 设计形态的一次性偏差** —— 不粉饰。
二发起走 broker,正好一次验证两形态。

## 7. 顺序铁律(runbook §1.6,代码双重强制)

**先 publish(channel 指针非空)再签发对应 entitlement 的 key。**
空态签发会被端点 + 脚本双重拒(`503 not activated`)。
→ 清单顺序不能调:beta → promote → key → 壳。

## 8. 我不碰的东西(边界)

- **一行凭据不碰**:Cloudflare API token / npm GAT / 2FA 全程在 Annie 手里。
- **不用 Claude-in-Chrome 代她操作 Cloudflare**:发 API token = 访问控制变更。
  runbook §1.2 那句让位于 issue 分工 + 「不冒用 founder 会话做访问控制变更」。Tadashi 已确认我的读法。
- **验收不自验**:干净环境 `npx @flywheel-ai/onboard` 由**独立 QA** 跑。实现者自验 = 自证。
