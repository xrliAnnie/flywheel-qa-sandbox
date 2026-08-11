# FLY-1688 Cloudflare Containers 作为 Runner 底座 — 调研

Issue: FLY-1688 (https://linear.app/geoforge3d/issue/FLY-1688/researchhl-cloudflare-containers-作为-runner-底座-价格-凭据安全-远程-tmux-可观测性fly)
日期: 2026-08-10
基于: exploration.md(同文件夹)

> **标注约定**:【厂商自报】= Cloudflare / Anthropic 官方文档自己写的数字或说法,我没有独立验证;【实测】= 我在这台生产机上跑命令量到的;【审计】= 读 codebase 得到的,给了 file:line;【推断】= 我从前两者推出来的,标明推理链;【查不到】= 找了没找到,不猜。
>
> **零动手验证**:本单没有 Cloudflare 账号、没有部署过一个容器、没有真跑过一个 Runner。所有 Cloudflare 侧结论都是文档推导。见 §6。

---

## 1. 一句话现状

三个问题的答案分别是:**③ 已解决得比预期好**(有一条成熟的官方命令)、**② 比自己买机器贵一个数量级**(不是「贵一点」)、**① 只解决了一半** —— GitHub 那半能收敛到最小权限,**Claude 订阅那半收不了**,而那正是 Annie 当初选物理机的理由。

---

## 2. ① 凭据安全

### 2.1 先审自己:Runner 现在到底带着什么

| 凭据 | 是什么 | 现在存在哪 | 作用域 / 有效期 | 来源 |
|---|---|---|---|---|
| **Claude Code 登录态** | OAuth access + refresh token,`subscriptionType: "max"`,scopes 含 `user:inference` | macOS **Keychain** 条目 `Claude Code-credentials`(Linux 上是 `~/.claude/.credentials.json`) | **整个 Claude 账号**;refresh token 长期有效 | 【实测】`security find-generic-password -s "Claude Code-credentials"` 一条命令即可读出明文 |
| **GitHub** | `gh` CLI 的 `oauth_token` | `~/.config/gh/hosts.yml`(0600) | 账号级(除非换成 fine-grained PAT) | 【实测】文件存在、权限 0600 |
| **Codex**(codex runner) | `auth.json` + `config.toml` | `~/.codex/`(0600) | ChatGPT 账号级 | 【实测】 |
| **Kimi**(kimi runner) | `config.toml` + `credentials/` | `~/.kimi-code/`(0700) | Moonshot key 或会员 | 【实测】 |
| **Linear API key** | `LINEAR_API_KEY` | `~/.flywheel/.env` —— **Bridge 读,Runner 不读** | workspace 级 | 【审计】`packages/teamlead/src/config.ts:154` |
| **Bridge ingest token** | `FLYWHEEL_INGEST_TOKEN` | **注入进 Runner env**(每 session) | 只能打 Bridge 的 `/events` | 【审计】`packages/claude-runner/src/TmuxAdapter.ts:468` |
| **Discord bot tokens** | 一堆 `*_BOT_TOKEN` | `~/.flywheel/.env` —— Bridge/Lead 读,**Runner 不读** | 各 bot | 【实测】`.env` 键名清单 |

**一个今天成立的好性质(值得先说清,因为上云会改变它):**
Runner **没有**拿到 `GITHUB_TOKEN` / `LINEAR_API_KEY` 这类 env 变量。它是**隐式继承宿主机的 `gh` 登录态和 Claude Keychain**。所以今天一个 Runner 的爆炸半径是「宿主机的 gh 账号 + Annie 的 Claude 账号」,**不是整个 `.env`**。

**上云会把这个隐式继承变成显式投递** —— 容器里没有 Annie 的 Keychain,凭据必须被主动塞进去。这既是机会(可以趁机收窄权限),也是新的暴露面(它们变成了容器进程 env 里的明文)。

### 2.2 一个必须报告的事故(本次审计造成)

审计 ①「Claude 登录态存在哪」时,我跑了 `security find-generic-password -s "Claude Code-credentials" -g`。这条命令**把 Annie 的 Claude OAuth access token + refresh token 明文打进了本 session 的 transcript**,因此它们进了:① 本机 `~/.claude/projects/…` 的 session 日志文件;② 发往模型 API 的上下文。

- **爆炸半径**:是 Annie 自己的 Claude 账号 token,收方是签发方(Anthropic)本身,泄漏面小但**不为零**。
- **我没有把它写进任何文档、HTML 或 commit**,也没有再次执行该命令。
- **处置建议交给 Annie/Tadashi 决定**:要不要轮换该 token(重新 `claude login`)。我不自作主张动生产登录态。
- **它同时是 ① 的一个实证**:这条凭据距离「任何以她的用户身份运行的进程」只有一条命令。这正是下面 §2.4 爆炸半径分析的核心事实,不是抽象风险。

### 2.3 Cloudflare 侧提供什么

| 机制 | 事实 | 来源 |
|---|---|---|
| 容器拿 env 的两条路 | ① Container class 上的 `envVars`(该 Container 的**所有**实例共享);② **per-instance** —— `startAndWaitForPorts({ startOptions: { envVars: {...} } })`,「Each instance gets a different set of environment variables」 | 【厂商自报】`developers.cloudflare.com/containers/examples/env-vars-and-secrets/` |
| 官方警告 | 「Do not use plaintext environment variables to store sensitive information — use secrets or Secrets Store bindings instead」 | 【厂商自报】同上 |
| Secrets Store | **open beta**(非 GA)。「securely encrypted and stored across all Cloudflare data centers」。目前只跟 Workers + AI Gateway 打通 | 【厂商自报】`developers.cloudflare.com/secrets-store/` |
| Secrets Store 的权限模型 / 轮换 / 审计日志 | **【查不到】** —— overview 页没写谁能读、有没有 RBAC、有没有轮换和审计。要用它做凭据面,这三条必须先问清楚 | — |
| 容器间隔离 | 「Each instance runs inside its own VM, which provides strong isolation」 | 【厂商自报】`containers/platform-details/` |
| 出网控制 | 默认**有**公网出网(`enableInternet` 默认开);可 `enableInternet = false` 全关,或用 `allowedHosts` 做 **deny-by-default 白名单**(支持 `*` glob),或 `deniedHosts` 黑名单 | 【厂商自报】`containers/platform-details/outbound-traffic/` |

**关键落点**:`envVars` 最终**就是容器进程环境变量**(文档原话:「Variables passed through these methods become visible in the container process environment」)。所以 Cloudflare 这条路是「把 secret 安全地送到容器边界」,**不是**「让容器永远看不到 secret」。

> 对照参考(不是 Cloudflare 的能力,是说明「能看不到」长什么样):Anthropic Managed Agents 的 vault `environment_variable` 凭据是**出口替换**的 —— 沙箱里只有占位符,真 secret 在请求离开沙箱时才被换进去,容器内代码「cannot read or exfiltrate it」。**Cloudflare Containers 侧我没找到等价机制**【查不到】。这是两者在凭据面上的结构性差别。

### 2.4 爆炸半径:一个 Runner 容器被攻破会怎样

三个事实叠起来:

1. **我们的 Runner 跑 `bypassPermissions`。**【审计】`packages/edge-worker/src/Blueprint.ts:2682` → `permissionMode: "bypassPermissions"`。
2. **Anthropic 自己的文档对这个组合写得很直白**:
   > 「When executed with `--dangerously-skip-permissions`, dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`. … Avoid mounting host secrets such as `~/.ssh` or cloud credential files into the container; prefer repository-scoped or short-lived tokens.」
   >
   > 【厂商自报】`code.claude.com/docs/en/devcontainer`
3. **容器里的 secret 就是进程 env**(§2.3)。

⇒ **一个被攻破的 Runner 容器 = 它手上那份 Claude token + 那份 GitHub token 全部外泄。** 容器之间是 VM 级隔离(所以不会横向扩散到别的 runner),但**单个容器内部没有第二道墙**。

**还有一条容易被忽略的路**:`wrangler containers ssh`(见 §4)意味着**任何对该 Container 有写权限的 Cloudflare 账号身份,都能 shell 进一个正在跑的 Runner**,那个 Runner 手上正拿着上面两份凭据。也就是说:**解决 ③ 的那个能力,同时是 ① 的一条新的凭据通路。** Cloudflare 账号本身成为一个新的、必须被当作最高等级凭据来守的东西。

### 2.5 能不能做到「一次性、最小权限」?—— 分两半,答案不同

**GitHub 这一半:能,而且我们已经有现成模式。**
- GitHub App installation token ≈ 1 小时;fine-grained PAT 可锁到单仓 + 精确 scope。
- Flywheel 内部已有两个先例:FLY-350/245 的 `FLYWHEEL_GATEWAY_GITHUB_TOKEN`(fine-grained,`contents:write` + `pull_requests:write`,经 broker 送、不进模型 env)【审计】`packages/teamlead/src/lead-backends/codex/gateway/GitPushRunner.ts:42`;以及 Anna 的 `ANNA_GITHUB_TOKEN`(scoped PAT + `scripts/verify-anna-isolation.sh` 做隔离验证)。
- 配上 Cloudflare 的 **per-instance envVars**,「每个 issue 一个只能碰那个仓、1 小时过期的 token」在架构上是成立的。

**Claude 这一半:收不了 —— 这是本单最硬的一条事实。**
- 容器里没有 macOS Keychain。无人值守容器要跑 Claude Code,官方给的路是 `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`。
- 这个 token:**有效期一年**、认证的是**整个 Claude 订阅账号**、需要 Pro/Max/Team/Enterprise。它只能发模型请求(不能开 Remote Control、不能拉 claude.ai connectors),算是**一点点**收窄,但**不是按 issue、按仓、按小时的最小权限**。【厂商自报】`code.claude.com/docs/en/authentication`
- 唯一真正可收窄的替代是 `ANTHROPIC_API_KEY` —— workspace 级、可撤销、可设支出上限。但那等于**从订阅制换成按 token 计费**,是一个**独立的、量级很大的成本决定**(见 §3),不能当作凭据方案顺手做掉。
- ⚠️ **这条跟 Cloudflare 无关**。换成 AWS、GCP、自建 Linux 卫星机,结论一样:只要 Claude Code 跑在你不物理控制的机器上,它就带着一份一年期的全账号订阅凭据。

### 2.6 回答 Annie 的原问题:「先物理机出于安全」是被缓解了还是仍然成立?

**分轴回答,不给一个笼统的是/否:**

| 轴 | 原判断 | 现在 |
|---|---|---|
| GitHub 写权限 | 泄漏 = 账号级 GitHub | **被缓解** —— 可收到「单仓 + 1 小时」,且我们已有模式 |
| Linear / Discord / 其它 `.env` | 不想让它们出机器 | **本来就不用出** —— Runner 今天也不持有它们(§2.1),上云不改变 |
| 容器间横向移动 | — | **被缓解** —— per-instance VM 隔离【厂商自报】 |
| **Claude 订阅登录态** | **不想让它离开我的机器** | **基本没变** —— 仍然是一份一年期、全账号的凭据,而且现在放在一台她不拥有的机器上,且有一条经 Cloudflare 账号进入的 shell 通路 |
| 攻击面形状 | 家里机器,无公网入站 | **变了** —— 多了一个必须当最高等级凭据守的 Cloudflare 账号 |

⇒ **她当初那句话的核心理由(Claude 凭据不离开自己的机器),在 Cloudflare 这条路上仍然成立。** 其余几条被实质缓解了。这是事实陈述,不是建议 —— 要不要为了弹性接受这条,是她的决定。

---

## 3. ② 价格

> **本节按 Annie 2026-08-10 的追加要求拆成三块**:(1) 官网价目表原样 → §3.1;(2)「免费」到底免在哪一层 → §3.2;(3) 按我们真实形态估月成本 → §3.5–3.6。

### 3.1 官网价目表原样(三张表,不合并)

跑一个 Runner 容器会**同时**踩到三个产品的计费:Workers(入口)→ Durable Objects(路由到实例)→ Container(真正干活的)。所以三张表都要看。**以下全部【厂商自报】,抓取日期均为 2026-08-10。**

#### (a) Workers — 入口层
来源:`https://developers.cloudflare.com/workers/platform/pricing/`(页面标注 Last Updated: **2026-07-07**)

| | Free 计划 | Paid 计划 |
|---|---|---|
| 月费 | **$0** | **$5 起** |
| 请求数 | 100,000 / **天** | 10,000,000 / 月包含,超出 **+$0.30 / 百万** |
| CPU 时间 | 每次调用 **10 毫秒** | 30,000,000 CPU-毫秒 / 月包含,超出 **+$0.02 / 百万 CPU-毫秒** |
| 时长(wall time) | 不计费 | 不计费也不限制(单次调用上限 5 分钟;Cron/Queue 15 分钟) |
| 超额行为 | **每日 00:00 UTC 重置;超了操作直接失败** | 按上面单价计费 |

Free 计划**明确不含**:KV 存储后端的 Durable Objects、Workers Trace Events Logpush、Enterprise 用量模型。

#### (b) Containers — 干活层
来源:`https://developers.cloudflare.com/containers/pricing/`(页面标注 Last Updated: **2026-04-21**)

| 维度 | 计价方式 | 单价 | 每月包含额度 |
|---|---|---|---|
| **内存** | 按**已分配**(provisioned) | $0.0000025 / GiB-秒 | 25 GiB-小时 |
| **vCPU** | 只按**实际活跃 CPU**(active usage only) | $0.000020 / vCPU-秒 | 375 vCPU-分钟 |
| **磁盘** | 按**已分配** | $0.00000007 / GB-秒 | 200 GB-小时 |
| **出网** 北美/欧洲 | 按 GB | $0.025 / GB | 1 TB |
| **出网** 大洋洲/韩国/台湾 | 按 GB | $0.05 / GB | 500 GB |
| **出网** 其它 | 按 GB | $0.04 / GB | 500 GB |

- 计费粒度:「Containers bill for every **10ms** that they are actively running」;实例进入 idle 超时后停止计费,可以 scale to zero。
- 页面明确写:**「The Free plan offers no container access.」**
- 页面自己声明:Workers requests、Durable Objects、Workers Logs **另行计费**。
- **入网(ingress)是否计费**:【查不到】—— 公开价目表只列了 egress。

#### (c) Durable Objects — 路由层
来源:`https://developers.cloudflare.com/durable-objects/platform/pricing/`(页面标注 Last Updated: **2026-08-10**)

| 维度 | Free 计划 | Paid 计划 |
|---|---|---|
| 存储后端 | **仅 SQLite** | SQLite + KV(KV 仅限已有 KV namespace 的账号) |
| 请求数 | 100,000 / 天 | 1,000,000 / 月包含,+$0.15 / 百万 |
| 时长 | 13,000 GB-秒 / 天 | 400,000 GB-秒 / 月包含,+$12.50 / 百万 GB-秒 |
| SQLite 读行 | 5,000,000 / 天 | 250 亿 / 月包含,+$0.001 / 百万 |
| SQLite 写行 | 100,000 / 天 | 50,000,000 / 月包含,+$1.00 / 百万 |
| SQLite 存储 | 共 5 GB | 5 GB-月包含,+$0.20 / GB-月 |

⚠️ 一条对我们特别相关的注:**「Duration charges apply while objects actively execute *or remain idle without hibernation eligibility*」** —— DO 在「醒着但闲着」时也计时长。我们的 Runner 阻塞在 gate 上时,DO 这一层是否也在计费、以及能不能 hibernate,**【查不到】,本单未建模**。

### 3.2 「免费」到底免在哪一层 —— 直接判定那条说法

**先把三层摊开,一眼看清免费的边界落在哪:**

| 层 | 有没有免费版 | 对「跑一个 Runner」的意义 |
|---|---|---|
| Workers | ✅ 有($0,10 万请求/天) | 入口是免费的 |
| **Containers** | ❌ **完全没有** | **这一层直接把你挡在门外** |
| Durable Objects | ✅ 有(仅 SQLite 后端) | 但容器进不去,这个免费额度对我们没意义 |

**官网证据(两处,互相印证):**
- Containers 定价页:「**The Free plan offers no container access.**」
- Containers 概览页(`developers.cloudflare.com/containers/`):「**Available on Workers Paid plan**」

⇒ **想跑容器,$5/月是入场费,不是用量费。** 交完这 $5,容器的内存/CPU/磁盘/出网**再按 §3.1(b) 另外收**。

**还有一个容易踩的坑 —— 免费版超额不是多收钱,是跑不动。** Workers Free 是**硬限**(每日 00:00 UTC 重置,超了操作直接失败);Paid 才是「包含额度 + 超额单价」的模型。这两种「超出」性质完全不同。

#### 判定:小红书那条「免 VPS、免 Docker、免费的电脑」

| 说法 | 判定 | 官网证据 |
|---|---|---|
| **「免费的电脑」** | ❌ **错** | Containers 不在 Free plan(上面两处原话)。最低 Workers Paid **$5/月** 起步,之上还要按量付内存/CPU/磁盘/出网。按我们真实形态每月约 **$402–1,549**(§3.5) |
| **「免 VPS」** | ✅ **成立,但要说清** | 你确实不用租、不用运维一台服务器,Cloudflare 管调度和生命周期。但这是**把「租机器」换成「按秒付费」,不是不花钱** —— 而按我们的量,它比自己一台机器贵约 17 倍(§3.6) |
| **「免 Docker」** | ⚠️ **一半错** | 免的是「自己运维 Docker 主机」,**不免 Dockerfile**。官网原话:「**Docker or a Docker-compatible CLI tool must be running for Wrangler to build and push images. This is not necessary if you are using a pre-built image.**」(`containers/image-management/`)⇒ 除非直接用现成镜像,否则本地仍需要 Docker 才能构建 |

#### 关于那个标题「Its Fast Lane Isn't Free」

它说的**不是** Cloudflare Containers,而是 **`@cloudflare/computer`** —— 也就是那条小红书帖的原主角。

- 出处:`https://aifounders.cz/en/cloudflares-agent-computer-is-open-source-its-fast-lane-isnt-free/`,发布日期 **2026-08-07**。**这是第三方博客,不是 Cloudflare 官方**,以下为该文说法【第三方自报】。
- 它的论点:代码是 MIT 开源、免费;但三个执行后端里被当成「快速默认」的那个(isolate-shell 模式)**只跑在付费的 Dynamic Workers 上**,而且按每个 worker、每百万请求、每百万 CPU-毫秒计费 ——「change a byte and the meter resets」。
- 它同时说:**container 模式走的是常规容器计费**,不需要 Dynamic Workers。

⇒ **这个标题和那条小红书帖说的是同一件事的两面,而且都不假**:代码开源免费是真的,跑起来要钱也是真的。**对我们没有矛盾** —— 我们要的是 container 模式(跑 tmux + Claude CLI),它本来就走常规容器计费,跟 fast lane 那条无关。

⚠️ **但请注意:`@cloudflare/computer` 本身本单没有评估。** 本单评估的是 Cloudflare Containers。上面这段只是为了回答「那条帖子说的免费到底是什么」,**不构成对 `@cloudflare/computer` 的任何判断**。

### 3.3 我们该选哪一档

**实例规格**(`containers/pricing/` + `containers/platform-details/limits/`,后者标注 Last Updated: 2026-07-03,抓取 2026-08-10):

| 类型 | vCPU | 内存 | 磁盘 |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

账号级上限【厂商自报】:并发内存 6 TiB、并发 vCPU 1,500、并发磁盘 30 TB、账号镜像总存储 50 GB。都可申请提额。**我们峰值 27 个 runner 离这些上限差着两三个数量级,账号上限不是约束。**


【实测】本机当前活着的 `claude` 进程 RSS:**0.41 – 0.56 GB / 个**(12 个采样)。
FLY-1005 记的是 **~1.3–1.4 GB / runner**。差异不矛盾:前者只是 CLI 进程本身,后者是整个 runner 的占用(还要跑 `pnpm install`、`pnpm -r build`、vitest —— 这个 22-workspace monorepo 的构建才是内存大头)。

⇒ **standard-1(4 GiB / 0.5 vCPU)对我们这个仓大概率不够**;现实档位是 **standard-2(6 GiB / 1 vCPU)** 或 **standard-3(8 GiB / 2 vCPU)**。【推断,基于实测内存 + 已知构建负载,未在 Cloudflare 上实跑验证】

### 3.4 每小时成本推导(把单价换算成好用的数)

- 内存:3600 × $0.0000025 = **$0.009 / GiB-小时**
- vCPU:3600 × $0.000020 = **$0.072 / vCPU-小时**(100% 忙时)
- 磁盘:3600 × $0.00000007 = **$0.000252 / GB-小时**

| 实例 | 固定部分(内存+磁盘) | CPU 占空比 15% | 30% | 100% |
|---|---|---|---|---|
| standard-2(6 GiB / 1 vCPU / 12 GB) | $0.0570/h | **$0.068/h** | **$0.079/h** | $0.129/h |
| standard-3(8 GiB / 2 vCPU / 16 GB) | $0.0760/h | **$0.098/h** | **$0.119/h** | $0.220/h |

> CPU 占空比是我给的**假设参数**(agent 大量时间在等模型返回、等 gate,不在烧 CPU)。真实值只能实跑测。三档都列出来是为了让 Annie 看到区间,而不是一个假精确的单点。

### 3.5 按我们真实形态算一个月

**并发口径**(Annie 提供的生产库实测,近 21 天):峰值 27;408 个采样时刻里 340 个 ≥5、192 个 ≥10。用 `last_activity_at` 当结束时间会**高估**,当上界看。

从这三个点能**夹出**平均并发的上下界【推断,算术】:
- 下界:68 个采样按 0 算、148 个按 5 算、192 个按 10 算 → (148×5 + 192×10)/408 = **6.5**
- 上界:68 个按 4、148 个按 9、192 个按 27 → (68×4 + 148×9 + 192×27)/408 = **16.6**

所以取 **7 / 12 / 27** 三档跑(27 = 一直顶在峰值的最坏情况)。换算:N 并发 × 730 小时 = 每月 runner-小时。

**月成本(standard-2,CPU 30% 占空比 → $0.079/runner-小时):**

| 平均并发 | 每月 runner-小时 | 月成本 |
|---|---|---|
| 7 | 5,110 | **≈ $402** |
| 12 | 8,760 | **≈ $689** |
| 27(一直顶峰) | 19,710 | **≈ $1,549** |

**换 standard-3($0.119/runner-小时):** 7 → ≈$609;12 → ≈$1,044;27 → ≈$2,349。

包含额度基本可忽略:25 GiB-小时内存在 6 GiB 实例上只够跑约 4 小时;375 vCPU-分钟 = 6.25 vCPU-小时。

**出网**:runner 的出网是 git push、API 调用、PR 操作 —— 相对小,大概率吃不满 1 TB 免费额度。下载(npm/pnpm 包、git clone)是入网,按公开价目表不计费(但见 §3.1 的【查不到】)。

### 3.6 跟自己买物理机比:盈亏平衡点

物理机的成本形态是**固定的**(买不买都在),Cloudflare 是**按用量的**。所以盈亏平衡点可以写成一个公式,Annie 代入自己的真实机器价即可:

> **盈亏平衡 runner-小时/月 = (机器价 ÷ 摊销月数 + 每月电费) ÷ Cloudflare 每 runner-小时单价**

代入一组**假设**参数(不是报价):机器 $2,000、摊销 36 个月、电费按 60W × 730h × $0.30/kWh ≈ $13/月 → 固定成本 ≈ **$68.6/月**。

- 对 standard-2 @30%($0.079/h):平衡点 = 68.6 / 0.079 ≈ **868 runner-小时/月 ≈ 1.19 个持续并发**。

⇒ **只要你持续跑得动 ~1.2 个以上的并发 runner,一台自己的机器就已经比 Cloudflare 便宜了。** 我们实测平均并发在 6.5–16.6 区间,**远在平衡点之上**。

按边际成本看更直观:一台 64 GB 机器如果能装 ~20 个 runner 槽位,每槽位月成本 ≈ $3.4;Cloudflare 每槽位 ≈ $57.4。**约 17 倍差距。**【推断,基于上面的假设参数】

> ⚠️ **这个 17x 里藏着一个必须说出来的假设(Lead 2026-08-10 指出):它默认那台物理机能「免费吸收」全部并发。**
>
> 注意上面两个数的口径其实不同:breakeven 写的是 **1.2 并发**,而 17x 用的是「一台机器装 20 个槽位」。**若一台机器真的只能扛 1.2 个并发,27 并发就需要二十几台**,物理侧成本会跟着涨,17x 就不成立。
>
> **而且我们有反例说明它不是免费吸收的**(Lead 提供,本单未独立核实):① 1M context runner 曾把内存吃爆(swap exhaustion),因此 1M 被改成显式 opt-in;② 高 load 时段是 chrome 断连等故障的复发温床。这两条都说明**物理机的并发是有拥塞成本的,不是免费的**。
>
> **⇒ 17x 是「忽略物理机拥塞成本」前提下的上界比值。** 把机器的拥塞/降级成本计入后,**真实倍数会低于 17x,但方向不变(云仍然更贵)**。精确倍数需要「单台机器的真实并发容量」数据 —— **本单没有,也没有去测**。

**内存能不能装下**:12 并发 × ~1.4 GB ≈ 17 GB;峰值 27 × 1.4 ≈ 38 GB。**一台 64 GB 的机器基本能覆盖当前峰值。**(FLY-517 的 16 GB 装不下 —— 那是机器太小,不是「必须上云」。)⚠️ 这只算了**内存**装不装得下,**没算 CPU、IO、以及上面那条拥塞成本** —— 「装得下」不等于「跑得动 27 个还不降级」。

**所以价格这一问的诚实结论是**:Cloudflare Containers 在我们这个形态下**不是省钱方案,是买弹性的方案**。它值钱的地方是「峰值溢出到自有容量之外时按秒付费」和「失败域隔离」,不是单位成本。

### 3.7 一个结构性的计费错配(值得单独说)

**内存按「已分配」计费,而不是按 CPU 活跃度。** 我们的 Runner 有一大段时间是**阻塞在 gate 上等 Annie 回复** —— 那段时间 CPU 几乎不动,但内存一直被占着、一直在计费。以 standard-2 为例,一个 runner 在门口等 10 小时,光内存就是 10 × $0.054 = **$0.54**,而它什么也没干。

**这不是一般性缺点,是精准命中我们形态的一条。**

> 等待占比约 24%(Honey Lemon 实测,本单未独立复核)。
> 口径:完成单中 founder_gate 处于打开状态的时长 ÷ 整单跨度;仅统计 gate 已正常关闭的单,n=5(span 603 分钟 / 节点工作 459 分钟 / founder gate 144 分钟)。
> ⚠️ 此数早前有一版「67% 在等」是错的,已公开撤回。错因:原查询对未关闭的 gate 用了「算到现在」,而 9 个完成单里有 5 个 gate 从未关闭 —— 等待时长被虚高约 3 倍。现值为修正后的版本。
> ⚠️ n=5 样本很小,只能作方向性判断,不要当精确值使用。真实占比可能在此上下浮动;本单未重新测量。

**这段等待时间在自有机器上是免费的,在容器上按内存计费** —— 这是我们这种 human-in-the-loop 形态**特有的成本放大**,一个纯自动化的 CI 负载不会有这一条。

能不能让它睡过去?**不能,不改架构的话** —— 因为:
- 「All disk is **ephemeral**」;
- 「when it goes to sleep, the next time it is started, it will have a **fresh disk** as defined by its container image」。
  【厂商自报】`containers/faq/`

⇒ **睡一觉 = worktree 和 tmux session 全没了。** 一个 issue 做到一半的 runner 不能靠 sleep 省钱。

要绕开只有改形态(gate 前 commit+push、gate 后重建容器重进 session),那是一个**真实的产品/工程决定**,不是配置项。**这条正是「4–13 小时一个 issue」这个形态跟 provisioned-memory 计费之间的错配** —— 也是为什么上面的月成本估算是**下不去的**。

---

## 4. ③ 远程可观测性(接 FLY-624)

### 4.1 Annie 的要求 vs 业界几种做法

| 做法 | 是什么 | 代价 / 成熟度 |
|---|---|---|
| **exec / SSH 进容器** | 一条命令拿到 shell,再 `tmux attach` | 最贴她的要求。需要一个受控入口和身份验证 |
| 远程 tmux attach(经 SSH/Tailscale) | FLY-624 的原设计:`ssh <机器名> -t 'tmux attach -t …'` | 成熟、我们已经在用 Tailscale。前提是能 SSH 到那台机 |
| 会话录制回放(asciinema / script) | 事后看,不能干预 | 便宜、但「点进去干预」做不到 |
| 日志流(stdout/stderr → 集中日志) | 看得到输出,看不到交互式 TUI | 最省事,但 tmux + Claude TUI 的画面不是日志 |
| 桌面共享 / VNC | 全画面 | 重、贵、跟无人值守容器不搭 |

### 4.2 Cloudflare Containers 具体支持哪种 —— **支持 SSH,而且是官方一等公民**

【厂商自报】`developers.cloudflare.com/containers/ssh/` + `workers/wrangler/commands/containers/`,以及三条 changelog:
- 2026-03-12 `SSH into running Container instances`
- 2026-05-12 **`SSH through Wrangler is now enabled by default for Containers`**
- 2026-05-28 `Wrangler supports SSH ProxyCommand for Containers`

**命令形态:**
```
wrangler containers instances          # 列出实例,拿 INSTANCE_ID
wrangler containers ssh <INSTANCE_ID>  # 开交互 shell
wrangler containers ssh <INSTANCE_ID> -- <command>   # 直接跑一条命令
```
也支持当 OpenSSH 的 ProxyCommand 用:
```
ssh -o ProxyCommand="wrangler containers ssh %h" cloudchamber@<INSTANCE_ID>
```

**⇒ Annie 要的那条「成熟、随时可用的命令」在 Cloudflare 上大致长这样:**
```
wrangler containers ssh <INSTANCE_ID> -- tmux attach -t <session>
```
这跟 FLY-624 定的 `ssh <tailscale-机器名> -t 'tmux attach -t cmux-<window>'` **是同一个形状**,只是寻址从「哪台机」换成「哪个容器实例 ID」。

**安全模型与限制(全部【厂商自报】):**
- 「SSH does not expose a publicly accessible port on the Container. The only way to connect is through Wrangler … which authenticates against your Cloudflare account.」—— **不开公网端口**,这点比裸 SSH 好。
- 只支持 **`ssh-ed25519`** 一种密钥类型;公钥要写进 Container 配置的 `authorized_keys`。
- 「Anyone with **write access to a Container** can SSH into it with Wrangler as long as a matching public key is listed in `authorized_keys`.」→ **见 §2.4:这同时是一条凭据通路。**
- `ssh.enabled` **默认为 true**。
- **容器必须已经在跑** —— 「SSH will not start a stopped Container」;而且「an active SSH connection alone will **not** keep a Container alive」。**⇒ 一个已经 sleep 掉的 runner,你点不进去看。**
- 进程可见性依赖 `containers_pid_namespace` 兼容性标志(compatibility date ≥ 2026-04-01 默认开)。

### 4.3 顺带核实 Annie 在 issue 里已写的三条(全部为真)

- **无硬性运行时长上限**:「Cloudflare will not actively shut off a container instance after a specific amount of time」,除非你配了 `sleepAfter` 或手动停。但「host server restarts occur on an **irregular cadence**」—— **不承诺任何 uptime**。【厂商自报】`containers/faq/`
- **关闭序列**:「a `SIGTERM` signal, and then a `SIGKILL` signal after **15 minutes**」。【厂商自报】`containers/platform-details/`
- **冷启动**:「often in the **1-3 second** range, but this is dependent on **image size** and code execution time」。【厂商自报】同上。⚠️ 我们的 Runner 镜像要装 node/pnpm/git/gh/claude CLI(可能还有 codex/agy/kimi),**远大于示例镜像**;1–3 秒对我们成不成立**没验证过**。而且真正的冷启动成本还要加上 `git clone` + `pnpm install`(ephemeral disk 意味着每次都要重来),那不是秒级。

### 4.4 日志侧的现状(不如 SSH 那么完备)

- Worker 配置里开 `observability = true` → Dashboard 有 live tail;日志保留 **Free 3 天 / Paid 7 天**;Enterprise 可用 Logpush 外送。【厂商自报】
- **容器 stdout/stderr 自动转进 Workers Logs 目前是一个 open feature request,不是已发布能力**(`cloudflare/workers-sdk` issue #12998)。
- `wrangler containers` **没有** `logs` / `stop` / `start` / `restart` 子命令 —— 这也是一个 open issue(#12988)。目前有的是:`build / delete / images / registries / info / instances / list / push / ssh`。

### 4.5 对 FLY-624 的影响

FLY-624 的**核心工程要求不变**:「Bridge 需要记录每个 runner/session 在哪里,才能生成对的置顶命令」。云上只是把「机器名」换成「容器实例 ID」。所以:
- FLY-624 的设计**不需要推翻**,只需要在「位置标识」那一栏留一个可以装 `<tailscale-host>` 或 `<container-instance-id>` 的抽象。
- Tailscale 那层在 Cloudflare 路径上**不需要**(Wrangler 自己就是受控入口)。混合形态(自有机器 + 云节点)则两条寻址都要支持。

---

## 5. 顺带发现:Cloudflare Sandbox SDK(不是本单命题,但相关)

Cloudflare 另有一个 **Sandbox SDK**,建在 Containers 之上,明确面向「让 AI agent 安全执行代码」:「run untrusted code safely in isolated environments」,提供命令执行、文件管理、后台进程、**WebSocket terminal connections**、S3 兼容对象存储挂载等。**目前状态是 preview,不是 GA。**【厂商自报】`developers.cloudflare.com/sandbox/`

它跟本单的关系:如果真要走 Cloudflare,「裸 Containers 自己搭 runner-agent」和「用 Sandbox SDK」是两条不同的路,后者省事但绑定更深、且还在 preview。**本单没有深入评估它** —— 列在这里是为了不让它被漏掉。

---

## 6. 本单没覆盖什么(重要,别当作已验证)

1. **零动手验证。** 没有 Cloudflare 账号、没有部署、没有跑过一个真 Runner 容器。所有 Cloudflare 结论都是文档推导。**下一步若要推进,第一件事应该是一个 spike:真起一个容器,跑通 claude CLI + tmux + 一次 `wrangler containers ssh`。**
2. **冷启动的真实数字没测。** 1–3 秒是厂商对一般镜像的说法;我们的大镜像 + `git clone` + `pnpm install` 的真实 time-to-first-token **未知**。
3. **Claude Code CLI 在 Cloudflare 容器运行时下能不能正常跑没验证** —— 尤其是交互式 TUI + tmux 的组合。
4. **三张官网价目表已抄录(§3.1),但月成本模型只算了 Containers 那一张的内存/CPU/磁盘/出网。** Workers requests、Durable Objects(尤其是「醒着但闲着」的 DO 时长)、Workers Logs 都另计费,**没有按我们的形态建模** —— 所以 §3.5 的月成本是**下界**,不是全额账单。入网是否计费【查不到】。
5. **物理机对照用的是假设参数**,不是报价。§3.5 给的是公式,数字要 Annie 代入真实机器价重算。
6. **CPU 占空比是假设**(15/30/100% 三档),不是实测。这是月成本估算里最大的不确定项之一。
7. **Secrets Store 的权限模型 / 轮换 / 审计日志【查不到】** —— 要真用它当凭据面,这三条必须先问清楚。
8. **没有横向比其它云底座**(AWS Fargate、Fly.io、GCP Cloud Run、自建 Linux 卫星机)。本单只回答「Cloudflare Containers 这一个具体底座」,不回答「云底座里哪家最好」。
9. **没有评估 Lead 上云** —— FLY-555 已定不上,本单不重开。
10. **没有重做 FLY-1005 的多机架构**(Bridge 暴露/鉴权 = 锚点 A、wake 跨机路由 = 锚点 C、warm pool、profile 分池)。那些在云上一条不少,**成本和复杂度都不在本单的数字里**。
11. **没有评估 Sandbox SDK**(§5),只标注了它存在且是 preview。
12. **并发数据我没有重新查生产库** —— 直接用了 Annie 在 issue 里给的三个数(峰值 27 / 340 个 ≥5 / 192 个 ≥10)和她自己标的高估口径。

---

## 7. 三问的事实收口(不含建议)

### 7.0 一条独立的安全约束(优先级高于本单命题)

> 这条**不是**关于 Cloudflare,也**不是**事故记录。它是本单审计过程中暴露出来的、**当下就成立**的设计约束,写在这里是因为它比「要不要上 Cloudflare」更重要,不该只活在一次 ASK 的对话里。

**约束**:Runner 跑 `bypassPermissions`(【审计】`packages/edge-worker/src/Blueprint.ts:2682`)⇒ **它执行的任何命令都没有人工拦截层**。因此:

1. **任何能读到凭据的命令 —— 读 Keychain、`cat` 凭据文件、打印 env —— 一旦被执行,凭据就落进该 session 的 transcript**,也就是本机 session 日志 + 发往模型 API 的上下文。没有任何机制会拦下它或告警。
2. **这跟「谁在跑那条命令」无关。** agent 自己出于正当目的审计时会这么做(本单 §2.2 就发生了一次);一个被注入的恶意 repo 也会这么做。在 `bypassPermissions` 下,这两者**没有区别** —— 系统分不出来,也不试图分。
3. **它是靠执行者自报才被发现的。** 没有自报,这次就不会有人知道。**「靠 agent 自觉」不是控制措施。**
4. **上云不改善这一条,只放大它。** 同样一条命令,在自己机器上是把凭据打进自己的日志;在云上是打进**别人家的日志和别人家的上下文**,而且 §2.4 的 `wrangler containers ssh` 还多开了一条进入活体 Runner 的通路。

**⇒ 推论(对任何底座都成立):只要 Runner 保持 `bypassPermissions`,§2.5 的「凭据本身最小权限化」就是唯一的实质防线** —— 因为「不让它执行到凭据」这条防线**根本不存在**。这也意味着:凭据收窄(单仓、短期、可撤销)不是可选的加固项,而是这个架构下**唯一**还剩的那道墙。

**本单不对此提方案**(那是独立的工程/产品决定,应另开 issue),只把约束陈述清楚。

### 7.1 三问

| 问 | 事实 |
|---|---|
| **① 凭据安全** | GitHub 侧可收敛到「单仓 + 1 小时」,我们已有模式;容器间是 VM 级隔离;但 **Claude 订阅登录态收不了** —— 无人值守容器只能用 `claude setup-token` 的**一年期全账号** token,唯一可收窄的替代是换 API key(= 换计费模式)。单容器内部无第二道墙(我们跑 `bypassPermissions`,Anthropic 文档对此有明确警告)。`wrangler containers ssh` 同时是一条新的凭据通路,Cloudflare 账号成为新的最高等级凭据。**⇒ Annie「先物理机」的核心理由在 Claude 这一轴上仍然成立,其余轴被实质缓解。** |
| **② 价格** | standard-2 约 **$0.068–0.129 / runner-小时**(随 CPU 占空比)。按平均并发 7 / 12 / 27 折算约 **$402 / $689 / $1,549 每月**。**盈亏平衡点 ≈ 1.2 个持续并发** —— 我们实测平均并发 6.5–16.6,远在其上,单位成本约为自有机器的 **~17 倍**。内存按已分配计费,而我们的 runner 大量时间阻塞在 gate 上等回复;sleep 会丢 ephemeral disk,所以那段时间**省不掉**。**⇒ 它买的是弹性和隔离,不是省钱。** |
| **③ 可观测性** | **已解决,而且比预期好。** `wrangler containers ssh <INSTANCE_ID>` 自 2026-05-12 起默认开启,不开公网端口、经 Cloudflare 账号鉴权、支持 `-- <command>` 和 OpenSSH ProxyCommand。「点进去看 tmux」的命令形态 = `wrangler containers ssh <id> -- tmux attach -t <session>`,与 FLY-624 的设计同形。**限制**:容器必须还活着(睡掉的点不进去)、只支持 ed25519、日志侧较弱(容器 stdout→Workers Logs 仍是 open feature request,`wrangler containers` 也还没有 logs/stop/start)。 |

---

## 关联

FLY-555(父 epic,原判断)· FLY-1005(多机 research/PRD,Done)· FLY-624(多机版 tmux-attach,③ 落点)· FLY-1072 / FLY-517(并发天花板 / OOM)· FLY-346(沙箱化)· FLY-353(session-log,云端 failover 前提)· FLY-350 / FLY-245(fine-grained GH token + broker 模式,② 的现成参考)
