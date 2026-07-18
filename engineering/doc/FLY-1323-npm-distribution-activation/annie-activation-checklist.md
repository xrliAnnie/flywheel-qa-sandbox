# FLY-1323 Annie 激活清单 — 持凭据的步骤

Issue: FLY-1323 (https://linear.app/geoforge3d/issue/FLY-1323/激活-fly-1062-npm-分发层一次性初始化-建-bucket-部署-worker-灌-token-发首个-payload-npm)
日期: 2026-07-16
基于: plan.md

---

## 读我(30 秒)

- 每条命令的形状我都本机实测过(wrangler 4.111.0),不是从文档抄的。
- **协议层我本机真跑通了**(真端点 + 真脚本 + 真 npm tarball 装机,8/8 PASS)—— 下面不是拿你的时间试错。
  但**说句实话**:那次彩排用的是测试内的**假 payload**,**没**验过真 R2/Worker 的行为。
  真 Cloudflare 那一段你我都是第一次跑 —— **撞到怪事很正常,停下问我**。
- **凭据全程只在你手里。我一行都不碰,也不替你操作 Cloudflare。**
- **token 不要直接打进命令**(会进 shell history)。下面用隐藏输入,照做即可。
- ⚠️ **有隐藏输入(`read`)的块请分两次贴**:先贴到 `read` 那一行、回车、粘 token、回车;
  **再**贴剩下的命令。若一次性把整块粘进去,`read` 会把下一行当成 token(结果是 401、会停下,不会出事,但白跑一遍)。这类块我都标了「先贴到这里 ⏸」。

### 时间的实话

issue 写「~15 分钟」。实际是**两次触摸**,中间我干活:

| | 你做什么 | 时长 |
|---|---|---|
| **窗口 1** | 步骤 0–7 | ~15 分钟 |
| *(我)* | beta CI + DEFAULT_ENDPOINT 的 PR + promote prepare | ~30–60 分钟,你不在场 |
| **窗口 2** | 步骤 8–10 | ~5 分钟 |

想一次坐完也行(中间等 CI 5–10 分钟,共 ~25–30 分钟)。你挑。

---

## 步骤 0 · 三个预检 —— **我已经替你核完了(只读)**

> 你在 thread 里说「Cloudflare 有可能已经绑过了,你可以先去试一下」——**我去看了,结论在下面。**
> 全程**只读**:没建 token、没改设置、没启用任何服务、没点任何付款按钮。截图留档。

### 0a. Cloudflare R2 —— ⚠️ **确实还没启用,而且账号上没有付款方式**

| 我查的 | 实际状态(2026-07-16 只读核实) |
|---|---|
| 登录状态 | ✅ 已登录,账号 = **Xrliannie.b@gmail.com**(runbook 点名的那个,对得上) |
| **R2 启用了吗?** | ❌ **没有**。`/r2/overview` 直接跳到购买页,显示「Add R2 subscription to my account」 |
| **付款方式绑了吗?** | ❌ **没有** —— Billing 页原文:**"No payment method on file"**(billing email 也 Not set、地址也没有) |
| 现有订阅 | 只有 memoscaped.com 的 **Free Plan**(Active) |

→ **所以这一步确实要你**:点「Add R2 subscription to my account」+ 绑一张卡。**这两个动作我不碰**(付款 + 接受条款 = 你的决定)。

**关于钱,我上一版写错了,更正**:我之前写「有人报告立刻扣 5 USD」。
**Cloudflare 自己的页面上写的是**:**Total Due Now = $0.00**、「Due Monthly $0.00 + additional usage」、
「You will only be charged if you exceed the monthly limits」。免费额度 = 10GB 存储 / 1M Class-A / 10M Class-B 每月。
我们这个用量(几个 payload tarball)**离免费额度很远**。
那个 $5 是社区帖的 anecdote,**不是这个账号会看到的东西** —— 我不该拿它当事实吓你。
(诚实边界:绑卡时银行**可能**有一笔小额验证预授权,那是发卡行行为,Cloudflare 页面没提。)

→ **你只需要判断一件事**:接不接受「为了 R2 在这个账号上绑一张卡」。接受 → 继续;不接受 → 停,我们换托管形态(产品决定)。

### 0b. npm org `flywheel-ai` —— ✅ **已建好,你只需验证**

org `flywheel-ai` 已建好(owner = 你的 xrliannie.b)。这一步你只需验证:`npm org ls flywheel-ai <你的用户名>` —— 应显示 owner。不用再建任何 org。

> 背景:原计划用 `flywheel` 这个 org 名,但登录后发现**已被占**(npm 上 2012 年有人注册过同名),
> 所以产品侧拍板改用 `flywheel-ai`,包名相应是 `@flywheel-ai/onboard`。改名已记录在案。

> ⚠️ 顺带看到的、跟我们有关的:npm 站顶挂着横幅 ——
> **「npm tokens that bypass 2FA are being restricted — account changes (Aug 2026) and direct publishing (Jan 2027)」**。
> 这会影响 broker 那条路的长期形态(它靠一枚长期 GAT)。**不影响这次首发**,但我已记为 follow-up。

### 0c. Cloudflare 账号 ID —— ✅ **已拿到,不用你查了**

```
export CLOUDFLARE_ACCOUNT_ID="66ab54493236cb4c0f9d865a6a2b38b4"
```

(从 dashboard URL 直接读到的;这就是 Xrliannie.b@gmail.com 那个账号。
所以原来「whoami 可能列多个账号让你选」那一步**省了** —— 直接 export 上面这条即可。)

## ⚠️ 硬边界 — 这个账号上不要碰的

| 不要碰 | 是什么 |
|---|---|
| Pages 项目 `custom-map-studio` | `*.geoforge3d.pages.dev` |
| `memoscaped.com` 的 DNS / MX / Email Routing | 邮件路由 |

我们**只新增**:一个 R2 bucket + 一个 Worker。别的都别点。

---

## 步骤 1 · 进入我给你备好的 release checkout(**别用 ~/Dev/flywheel**)

> **为什么**:`~/Dev/flywheel` 是长期工作树 —— 我实查过,它现在**落后 origin/main 98 个提交、还带未跟踪文件**。
> 从它部署 = 可能发出**旧的 Worker 源码或旧的壳**。发布必须从固定的、reviewed 的 SHA 出发。
> 我会在你窗口前准备好这个干净 checkout(**里面不含任何凭据**),并把预期 SHA 填进下面。

```bash
export REL=<我填:release checkout 路径>

# 硬校验 —— 不满足就停,别继续。
# 整块包在 ( ) 里:cd 进不去就直接结束这个子 shell,绝不会拿"你当时碰巧在的那个仓库"去核 SHA。
(
  cd "$REL" || { echo "❌ 进不去 $REL —— 停,告诉我。别继续。"; exit 1; }
  # 先把两条 git 的输出**和退出码**分别取下来。Codex R6 抓的:
  # 原来直接把 $(git status) 的**文本**拿去判空 —— 如果 git status 自己失败(exit 非零、
  # 输出为空),会被读成「树干净」→ 从一个没核过的脏树发布。读失败绝不能当干净。
  HEAD_SHA="$(git rev-parse HEAD)"; H_RC=$?
  DIRTY="$(git status --porcelain -- packages/payload-endpoint packages/onboard-shell scripts/release)"; S_RC=$?
  if [ "$H_RC" -ne 0 ] || [ "$S_RC" -ne 0 ]; then
    echo "❌ git 读不出来(rev-parse exit $H_RC / status exit $S_RC)—— 停,告诉我。别把读失败当成干净。"
  elif [ "$HEAD_SHA" != "<我填:预期 SHA>" ]; then
    echo "❌ SHA 不对(实际 $HEAD_SHA)—— 停,告诉我。别继续。"
  elif [ -n "$DIRTY" ]; then
    echo "❌ 工作树不干净 —— 停,告诉我。别继续。"
  else
    echo "✅ release checkout 校验通过,可以往下走"
  fi
)
```

> **这块为什么也要包 `( )`**(Codex R4;上一轮我只修了步骤 9 那一处,这里是漏网):
> 如果 `cd "$REL"` 失败而后面照跑,`git rev-parse HEAD` 核的就是**你当时所在的那个仓库** ——
> 它完全可能打印一个 **✅**,而你根本不在 release checkout 里。**一个会对错的树说「通过」的校验,比没有校验更糟。**

**必须看到 ✅ 才继续。** 看到 ❌ 就停 —— 不要「看起来差不多」就往下。

---

## 步骤 2 · 生成三枚 token

跑 **3 次**,每次给一对 `token` + `sha256`。**存进你的密码管理器**。

```bash
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
```

| # | 叫什么 | token 明文归谁 | sha256 归谁 |
|---|---|---|---|
| 1 | **beta-publish** | GitHub repo secret(步骤 6) | Worker(步骤 5) |
| 2 | **customer-release** | **只在你手里**(步骤 8) | Worker(步骤 5) |
| 3 | **ops-admin** | 你手里 → **密码管理器**,之后当面/密管交 Tadashi | Worker(步骤 5) |

> **端点只存 sha256。** token 泄漏就换一枚、重灌新 sha,旧的立刻失效。
> **ops-admin 的明文不要**发 Discord / Linear / PR / 任何 agent 消息流 —— 只走密码管理器。

---

## 步骤 3 · 先做只读碰撞检查(别盲建)

```bash
# 整个碰撞检查包进子 shell:任一步查不清楚(非零、或含糊)都 exit 1 停在这里,
# **只有**两项都确认「不存在」才打 COLLISION_CHECK_CLEAR。Codex R7 抓的两点:
# ① bucket-list 失败原来只打印不停 → 现在 exit 1;
# ② deployments 的 not-found 判太宽(`could not find account …` 这种 auth 错也被当「Worker 不存在」)
#    → 现在要求消息里**点名了 flywheel-onboard-endpoint** 且是 not-found 措辞才算没碰撞;其余非零一律停。
(
  BUCKETS="$(npx --yes wrangler@4.111.0 r2 bucket list 2>&1)"; BRC=$?
  [ "$BRC" -eq 0 ] || { echo "❌ r2 bucket list 失败(exit $BRC)—— 停。原文:"; echo "$BUCKETS"; exit 1; }
  echo "$BUCKETS"
  case "$BUCKETS" in
    *flywheel-payloads*) echo "⚠️ bucket flywheel-payloads 已存在 —— 停,走 resume,别覆盖。"; exit 1 ;;
  esac

  DEPLOYS="$(npx --yes wrangler@4.111.0 deployments list --name flywheel-onboard-endpoint 2>&1)"; DRC=$?
  echo "$DEPLOYS"
  if [ "$DRC" -eq 0 ]; then
    echo "⚠️ deployments list 成功(exit 0)= Worker flywheel-onboard-endpoint 已存在 —— 停,走 resume。"; exit 1
  elif grep -qi "flywheel-onboard-endpoint" <<<"$DEPLOYS" \
       && grep -qiE "not found|does not exist|could not find [^ ]*worker" <<<"$DEPLOYS"; then
    echo "✅ Worker 不存在(消息点名了 flywheel-onboard-endpoint 且是 not-found)= 没碰撞。"
  else
    echo "❌ deployments list 非零但**不是**明确的「该 Worker 不存在」(exit $DRC)—— 可能 auth/account/网络错。停,把上面原文发我判断,别当没碰撞。"; exit 1
  fi
  echo "✅ COLLISION_CHECK_CLEAR —— 两项都确认无碰撞,可以进步骤 4。"
)
```

- 两个名字(`flywheel-payloads` / `flywheel-onboard-endpoint`)**都不存在**(bucket 不在列表里、deployments 报 not found)→ 正常,继续
- **已存在**(列表里有该 bucket、或 deployments 打印出真实记录)→ **停,告诉我**(可能是上次失败的半成品,要走 resume 分支而不是覆盖)

---

## 步骤 4 · 建 bucket + 部署 Worker(**先 deploy,后灌 secret**)

```bash
(
  cd "$REL/packages/payload-endpoint" || { echo "❌ 进不去 payload-endpoint —— 停,告诉我。下面的都别跑。"; exit 1; }
  # 每一步失败都必须停:建 bucket 失败绝不能继续去 deploy(Codex R5 抓的:原来两条是独立行,
  # 建桶失败照样往下 deploy)。
  npx --yes wrangler@4.111.0 r2 bucket create flywheel-payloads \
    || { echo "❌ 建 bucket 失败 —— 停,别 deploy。告诉我。"; exit 1; }
  npx --yes wrangler@4.111.0 deploy \
    || { echo "❌ deploy 失败 —— 停,告诉我。"; exit 1; }
)
```

> **为什么先 deploy**:`wrangler secret put` 在 Worker 还不存在时会问
> 「Do you want to create a new Worker with that name?」——先 deploy 就没这个提示。
> 此刻 Worker 已上线但**三个 capability 的 hash 都还没配 = 全部 fail-closed(任何写都 401)**。
> 这是安全的中间态,不是问题。

> **可能出现的交互(先说好,免得你愣住)**:如果这个账号**从没注册过 workers.dev 子域**,
> wrangler 会让你**现场注册一个账号级 subdomain**(全账号一次性、之后所有 Worker 共用),
> 也可能再让你确认一次账号。这个子域名会出现在**客户看到的 URL 里**。
> **拿不准就停下问我**,别随手起一个。

输出里会有:

```
https://flywheel-onboard-endpoint.<你的子域>.workers.dev
```

📌 **把这个 URL 完整发给我**(我要用它改代码占位符)。存起来:

```bash
export FW_ENDPOINT="https://flywheel-onboard-endpoint.<你的子域>.workers.dev"
```

---

## 步骤 5 · 灌三个 sha256 进 Worker

每条会提示粘贴 —— **粘 sha256,不是 token 本体**。(每条会自动部署一个新 version,正常。)
**一条一条贴、看到成功再贴下一条**(每条会提示 `Enter a secret value:`,你粘 sha256 再回车)。

**整块一起贴**;wrangler 会**依次**提示三次 `Enter a secret value:`,你按顺序粘对应的 sha256 再回车。**任何一条失败,整块立刻停**(不会往下灌错/漏灌)。

```bash
(
  npx --yes wrangler@4.111.0 secret put FW_BETA_PUBLISH_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 beta sha 失败 —— 停,别继续。告诉我。"; exit 1; }
  npx --yes wrangler@4.111.0 secret put FW_CUSTOMER_RELEASE_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 customer sha 失败 —— 停,别继续。告诉我。"; exit 1; }
  npx --yes wrangler@4.111.0 secret put FW_OPS_ADMIN_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 ops sha 失败 —— 停,告诉我。"; exit 1; }
  echo "✅ 三个 sha256 都灌进 flywheel-onboard-endpoint 了"
)
```

> **每条为什么带 `--config`**(Codex R5 抓的 HIGH):步骤 4 那个子 shell 跑完,你的当前目录**已经变回原处**了 ——
> 这三条 `secret put` 如果不指目录,wrangler 会拿**你当前目录**里碰巧存在的 wrangler.toml 来定位 Worker,
> 可能灌进**别的 Worker**、或找不到 config 直接失败。`--config` 指死
> `flywheel-onboard-endpoint` 那个 Worker 的 wrangler.toml,不依赖你此刻站在哪。
> **哪条报错就停、告诉我**,别继续灌下一条。

---

## 步骤 6 · 配 GitHub repo secret(**先只配 secret,别配 variable**)

> **顺序很重要**:`FW_ENDPOINT` 这个 variable 是 **beta CI 的激活开关**
> (workflow 只看它决定跑不跑)。现在就配它的话,manifest 还没初始化,
> 而 beta CI **每 6 小时自动触发一次** —— 会撞上「没有 manifest」直接变红。
> 所以:**secret 先配(它本身不激活任何东西)→ manifest 初始化 → 最后才配 variable。**

```bash
gh secret set FW_BETA_PUBLISH_TOKEN -R xrliAnnie/flywheel
```

> **注意:不要加 `--body`。** 不加的话 `gh` 会让你**隐藏输入/从 stdin 粘贴**,
> token 就不会进 shell history、也不会短暂出现在进程 argv 里。

---

## 步骤 7 · 初始化 manifest(空态)

token 用隐藏输入读进来,**既不写进命令文本、也不进任何外部进程的 argv**:

**先贴这一块,必须看到 ✅ 才贴下一块:**

```bash
if cd "$REL"; then
  echo "✅ 已进入 $REL —— 可以贴下面那块了"
else
  echo "❌ 进不去 $REL —— 停,告诉我。下面那块一行都别贴。"
fi
```

> **为什么这里要拆成两块贴**(QA ff38290f 抓的最后一条 HIGH,**是我上一轮的漏网,而且我在 commit message 里还写了「re-grep 归零」——那句是假的**):
> 我上一版写的是 `cd "$REL" || echo "❌…"`。`echo` **只是打印,不中止** —— 你要是一次性把整块贴进去,
> 后面的 `read` / `curl` **照样跑**,只是跑在错的目录里。**又是一个「看着像闸、其实不拦」的假控制。**
> 那为什么不像别处那样包 `( )`?因为这块必须**留在当前 shell**:token 要用隐藏输入读进变量,
> 子 shell 里读完变量就没了。而交互式 shell 里**已经粘进去的行是拦不住的** ——
> 真要「中止」只能 `exit`,那会**关掉你的终端**(比跑错目录更糟)。
> 所以这里的「闸」是**你**:先贴 cd 那块、看到 ✅ 再贴第二块。**这是我能给的最诚实的形态,不是我假装它会自动拦。**

**看到 ❌ 就停在这里。** 下面这块**只在 ✅ 之后贴**:

```bash
printf 'beta-publish token: '        # 提示词单独打印(zsh 的 read 不认 -p)
IFS= read -rs BETA_TOK; echo

# token 经 printf(shell 内建,不 fork 进程 → ps 看不到)从 stdin 喂给 curl 的
# -H @-,curl 的 argv 里没有 token。content-type 不是秘密,内联即可。
printf 'Authorization: Bearer %s\n' "$BETA_TOK" | \
curl --fail-with-body -sS -o /tmp/fw-init.out -w '%{http_code}\n' \
  -X POST "$FW_ENDPOINT/admin/manifest" \
  -H @- \
  -H 'content-type: application/json' \
  -d '{"baseEtag":null,"manifest":{"schemaVersion":1,"channels":{"internal-beta":{"latest":null},"customer-release":{"latest":null}},"versions":{},"releaseOps":{},"releaseLedger":{},"tombstones":[]}}'

cat /tmp/fw-init.out; echo
unset BETA_TOK
```

**必须打印 `200`。** 任何别的数字 → **停,告诉我**。
(这条 JSON body 跟我本机跑通那次、跟 runbook §1.4 **逐字一致** —— 我比对过。)

---

## 步骤 8 · 打开 beta CI 的激活开关(窗口 1 最后一步)

manifest 初始化成功**之后**才做这一步:

```bash
gh variable set FW_ENDPOINT -R xrliAnnie/flywheel --body "$FW_ENDPOINT" \
  || { echo "❌ gh variable set 失败 —— 停,告诉我。别把下面的 list 当成功。"; }
# 回读**存进去的值本身**,跟你要设的比对 —— 不是只看「变量在不在」(Codex R7:失败的 set
# 后面跟一条成功的 list 会把整块盖成 exit 0;而且只看「在不在」核不出值对不对)。
STORED="$(gh variable get FW_ENDPOINT -R xrliAnnie/flywheel 2>/dev/null)"; G_RC=$?
if [ "$G_RC" -eq 0 ] && [ "$STORED" = "$FW_ENDPOINT" ]; then
  echo "✅ FW_ENDPOINT_SET —— 已设且回读一致:$STORED"
else
  echo "❌ FW_ENDPOINT 回读不一致(exit $G_RC,存的 '$STORED' ≠ 要的 '$FW_ENDPOINT')—— 停,告诉我。别开激活开关。"
fi
gh secret list -R xrliAnnie/flywheel   # 只读,顺带看 secret 在不在,不作为成功判据
```

(URL 不是 secret,`--body` 在这里没问题。**激活开关的硬前提 = 上面打出 `FW_ENDPOINT_SET`。**)

**窗口 1 结束 —— 把 URL 发给我,我接手。**

---

## 🔧(我做,你不用在场)

- 改 `DEFAULT_ENDPOINT` → 你的真 URL,开 PR-2、过 Codex review、merge
- dispatch beta release CI(真发第一个 payload),留 run URL / commit / version 证据
- 跑 promote prepare(clean 重建 + 逐字节等价证明)
- 把步骤 9 的 `<release-id>` / `<sha256>` 填好,并给你一个**新的**预期 SHA(= PR-2 的 merge SHA)

---

## 步骤 9 · promote 发布(窗口 2,~2 分钟)

```bash
export REL=<我填>
export FW_ENDPOINT="<你的真 URL>"

# 路径不对就必须停在这里,不能继续往下核 SHA(否则会在错的树上核对)。
if cd "$REL"; then
  HEAD_SHA="$(git rev-parse HEAD)"; H_RC=$?
  # 窗口 2 的树也必须干净:步骤 1 的干净检查是窗口 1 做的,之后 checkout 被推进到 PR-2 merge SHA,
  # 所以这里要**重新**核树干净 —— 否则一个没提交的 endpoint/config/preflight 改动会跟着 SHA 一起
  # 通过、被步骤 10 的 npm publish 发出去(Codex R7 抓的 HIGH:只核 HEAD 不核脏树)。
  DIRTY="$(git status --porcelain -- packages/payload-endpoint packages/onboard-shell scripts/release)"; S_RC=$?
  if [ "$H_RC" -ne 0 ] || [ "$S_RC" -ne 0 ]; then
    echo "❌ git 读不出来(rev-parse $H_RC / status $S_RC)—— 停,别 commit。读失败不当成「对上/干净」。"
  elif [ "$HEAD_SHA" != "<我填:PR-2 merge SHA>" ]; then
    echo "❌ SHA 不对(实际 $HEAD_SHA)—— 停,告诉我。别 commit。"
  elif [ -n "$DIRTY" ]; then
    echo "❌ 工作树不干净(有未提交改动)—— 停,别 commit/publish。发布必须从 reviewed SHA 的原样树出去。"
  else
    echo "✅ SHA 对上且树干净,可以继续步骤 9 的下一块"
  fi
else
  echo "❌ 进不去 $REL —— 停,告诉我。下面的都别跑。"
fi
```

> **为什么不写 `cd "$REL" || return`**(QA ff38290f F4 抓的,我实测过):
> 交互式 zsh 里粘贴这段,`cd` 失败后 **`return` 不会中止后面的行** —— 后续命令照跑,
> 又是一个「看着像闸、其实不拦」的假控制。
> **也不写 `cd "$REL" || exit`**:`exit` 在交互式 shell 里会**直接关掉你的终端窗口**(我 zsh 实测:
> 整个 shell 没了)。你正拿着凭据做不可逆的事,窗口在这一步爆掉是最糟的形态 ——
> 跟前面那条 `read -rs -p` 是同一类事故。
> 所以改成 `if cd ...; then ... else ... fi`:进不去就只打印一行「停」,**不杀你的 shell、也不会假装成功往下走**。

**先只读核对你要批的候选 hash**(不带任何凭据):

```bash
printf 'customer-release token: '
IFS= read -rs REL_TOK; echo
# 先把 manifest 读进变量并**单独**看 curl 的退出码,再让 jq 比对(Codex R5 抓的:
# 原来是 curl | jq && echo ✅ —— 交互式 zsh 没 pipefail,curl 失败但 jq 恰好评真时会打假 ✅)。
MANIFEST="$(printf 'Authorization: Bearer %s\n' "$REL_TOK" | \
  curl --fail-with-body -sS -H @- "$FW_ENDPOINT/admin/manifest" 2>&1)"; CRC=$?
if [ "$CRC" -ne 0 ]; then
  echo "❌ 读 manifest 失败(curl exit $CRC)—— 停,别 commit。原文:"; echo "$MANIFEST"
elif jq -e --arg id "<我填:release-id>" --arg sha "<我填:候选 sha256>" \
       '.releaseOps[$id].sha256 == $sha' <<<"$MANIFEST" >/dev/null 2>&1; then
  echo "✅ 库里的候选 hash == 我给你的那个"
else
  echo "❌ 不一致(或 manifest 里没有这个候选)—— 停,别 commit"
fi
```

**只有打印 ✅ 才执行发布**:

```bash
FW_CUSTOMER_RELEASE_TOKEN="$REL_TOK" node scripts/release/payload-promote.mjs \
  commit --release-id <我填> --expected-sha256 <我填:候选 sha256>
PROMOTE_RC=$?
unset REL_TOK                 # 无论成败都清 token
if [ "$PROMOTE_RC" -eq 0 ]; then
  echo "✅ PROMOTE_COMMITTED —— commit 成功。只有看到这行,才允许进步骤 10。"
else
  echo "❌ promote commit 失败(exit $PROMOTE_RC)—— 停,告诉我。**没有 PROMOTE_COMMITTED 绝不许跑步骤 10 的 npm publish。**"
fi
```

> **为什么要单独抓 `PROMOTE_RC` + 打 `PROMOTE_COMMITTED`**(Codex R6 抓的 HIGH):
> 原来 commit 那条后面紧跟 `unset REL_TOK` —— `unset` **总是成功**,所以整块的退出码变成 0,
> **commit 失败被 unset 盖成「成功」**,你可能就此走到步骤 10 那条**不可逆的 `npm publish`**,
> 而 customer 指针根本没动。现在:token 无论成败都清;但**只有 commit 真的 exit 0 才打 `PROMOTE_COMMITTED`**。
> **步骤 10 的硬前提 = 你在这里亲眼看到 `PROMOTE_COMMITTED`**;没看到就停、别发布。

> **诚实说明 ①**:设计上这步该走 broker + Discord approve gate(runbook §7)。
> broker 要 Bridge 重启才能注入 token,Tadashi 拍了**首发你直发、零重启**。
> **这是对设计形态的一次性偏差,已记录在案。第二次发布起走 broker。**
>
> **诚实说明 ②(我的错,已改正)**:我上一版清单在这条命令上写了 `--sha256 <hash>`,
> 让它看起来像「你确认的 hash 被强制绑定」。**那个 flag 根本不存在** ——
> 脚本只认 `--release-id`,多余参数被**静默忽略**。我照 broker 的参数抄的,没实测。
> **假控制比没控制更坏。** 上面那段 `jq -e` 只读比对就是替代:它真的会在不一致时拦住你。
> `--expected-sha256` **已经是 PR-1 里落地的、必填的结构性保证**了 —— 不是「将来」。
> 上面这条命令你真传它:传错/传重复/写成等号形式都会被拒,客户指针一动不动。

---

## 步骤 10 · 发 npm 薄壳包(窗口 2,~3 分钟)

### 10a. 先跑 preflight —— **不能跳**

```bash
(
  cd "$REL" || { echo "❌ 进不去 $REL —— 停,告诉我。别继续 10b/10c。"; exit 1; }
  bash scripts/release/shell-publish-preflight.sh --founder-local
)
```

**必须看到 `PREFLIGHT PASS`。** 它挡:① 占位符 endpoint ② 版本号已被占 ③ 打包内容超白名单 ④ 内容 gate 红。

> **为什么这条是硬要求**:`npm publish` 自己**什么都不查** ——
> 历史上 `onboard-shell/package.json` 没有任何 script,裸 `npm publish` 不经过任何闸。
> **PR-1 已经加了 `prepublishOnly` 钩子** —— 现在裸 `npm publish` 会自动跑这个 preflight,
> 占位符/错 registry/版本复用都会被拦,不再靠你记得手跑。
> 10a 这一步是**显式再跑一遍**(双保险 + 让你亲眼看到 PASS);即便你忘了,钩子也会兜住。
> 我实测过:裸 `npm publish --dry-run` 在占位符树上 exit 1、永远到不了 "Publishing to"。

### 10b. 确认身份和 registry(首次不可逆发布,值这 10 秒)

```bash
npm config get registry              # 必须是 https://registry.npmjs.org/
npm login                            # 你的账号 + 2FA

# 身份和角色分开看,且 whoami 失败必须停 —— 不能让一个失败的探针把查询悄悄放宽
if NPM_USER="$(npm whoami)" && [ -n "$NPM_USER" ]; then
  echo "✅ 当前身份:$NPM_USER —— 必须是你预期的那个账号"
  npm org ls flywheel-ai "$NPM_USER"    # 这条才看得到角色:必须是 owner 或 admin
else
  echo "❌ npm whoami 没拿到用户名 —— 停,告诉我。别发布。"
fi
```

> **为什么不写 `npm org ls flywheel-ai $(npm whoami)`**(Codex R4 抓的,**这是我上一轮修 whoami 时自己引入的新洞**):
> `npm whoami` 一旦失败,`$(...)` 展开成**空**,那条命令就变成 `npm org ls flywheel-ai` ——
> 从「查我的角色」**悄悄变成「列整个 org」**,而它照样打印一堆东西、看着像成功了。
> **我在一个专门用来修 fail-open 的改动里,又写了一个 fail-open。** 现在先取值、要求非空,拿不到就停。

> **为什么是两条命令而不是一条**(Codex code R3 抓的,我原来写错了):
> 我之前把 `npm whoami` 注成「必须是 flywheel-ai org 的 owner」。**它做不到这件事** ——
> npm 自己的说明就一句话:`Display npm username`,**它只回显你是谁,不回答你有什么权限**。
> 我把一个「身份检查」标成了「授权检查」,而这页是你要照着念的 ——
> 你会看着一条根本没在验角色的命令,以为角色已经验过了。
> 角色要用 `npm org ls flywheel-ai <username>` 单独看(真实签名 `npm org ls orgname [<username>]`,我查过 CLI 才写)。
> 首发不可逆,所以「谁」和「有没有权」这两件事必须分别看见。

(10a 的 preflight 现在也会自己核 registry —— 不是 npmjs 就直接拒,首包发不错地方。)

### 10c. 发

```bash
(
  cd "$REL/packages/onboard-shell" || { echo "❌ 进不去 onboard-shell —— 停,别发布。告诉我。"; exit 1; }
  npm publish --access public \
    || { echo "❌ npm publish 失败 —— 停,告诉我。别把下面的 view 当成功证据。"; exit 1; }
  # 发布证据:必须能 view 到**我们刚发的那个确切版本**,且它 == 本地版本。
  # 光 view 到"某个版本"不算(Codex R5 抓的:可能是 registry 上早就存在的旧版本)。
  LOCAL_V="$(node -p "require('./package.json').version")"
  PUB_V="$(npm view "@flywheel-ai/onboard@$LOCAL_V" version 2>&1)"; VRC=$?
  if [ "$VRC" -eq 0 ] && [ "$PUB_V" = "$LOCAL_V" ]; then
    echo "✅ 已发布并确认:@flywheel-ai/onboard@$LOCAL_V 在 registry 上可见"
  else
    echo "❌ 发布后没能确认 @flywheel-ai/onboard@$LOCAL_V(view exit $VRC, 回来='$PUB_V')—— 停,告诉我。"; exit 1
  fi
)
```

> **这一块为什么必须包在 `( )` 里**(Codex R4 抓的,是我上一轮只修了一处的漏网):
> 如果 `cd` 失败而你继续粘贴,`npm publish --access public` 就会**在你当时所在的任意目录**执行 ——
> 这是全流程**最不可逆**的一条命令。`( ... )` 里的 `exit 1` 只结束这个子 shell,**不会关掉你的终端**。

> **不要**加 `--ignore-scripts`(将来 PR-2 的 gate 就靠 script 钩子)。

---

## 步骤 11 · 签一枚 license key 给 QA

```bash
export FW_ENDPOINT="<你的真 URL>"
printf 'ops-admin token: '
IFS= read -rs OPS_TOK; echo

# 10c 现在包在子 shell 里,你的当前目录不会被它改掉;但仍显式进 $REL 再跑,进不去就停。
(
  cd "$REL" || { echo "❌ 进不去 $REL —— 停,别签 key。"; exit 1; }
  FW_OPS_ADMIN_TOKEN="$OPS_TOK" node scripts/release/license-key.mjs issue \
    --customer qa-fly-1323 --entitlement customer --note "FLY-1323 acceptance"
)
LICENSE_RC=$?
unset OPS_TOK                 # 无论成败都清 token
# Codex R7:原来失败的 issue 后面跟一条成功的 unset,把整块盖成 exit 0(跟 R6 promote 那个 bug 同形)。
if [ "$LICENSE_RC" -eq 0 ]; then
  echo "✅ LICENSE_ISSUED —— key 已签发(明文在上面,只这一次)"
else
  echo "❌ 签 key 失败(exit $LICENSE_RC)—— 停,告诉我。上面没有可用的 key。"
fi
```

**明文 key 只打印这一次。**

- **不要**把它贴进 Discord / Linear / PR / 任何 agent 消息流
- 交给独立 QA 的最窄做法:**你在 QA 的隐藏输入里亲手粘贴**
- **记下非敏感的 key id** —— 验收完就 revoke

> 顺序铁律:**必须先有步骤 9(customer 指针非空)再签 key**。空态签发会被端点 + 脚本双重拒(`503 not activated`)。

---

## 完事之后

独立 QA 在**没有 flywheel 私仓权限的干净机器**上跑:

```bash
npx @flywheel-ai/onboard
```

一条命令走通下载 + 安装引导 = 验收通过 = FLY-1322 摩擦 #1/#2 关闭。
**我不自己验这条** —— 实现者自验 = 自证。

---

## 万一 QA 挂了(首次发布不可逆,先想好)

**npm 版本号发出去就覆盖不了**,而且这是首个 customer release —— **没有「上一个好版本」可以回退**。
所以不是「回滚」,是:

1. **立刻 revoke 那枚 QA key**(`license-key.mjs revoke --key-id <id>`),**不要再发第二枚给任何人**
2. 保留失败证据(run URL / manifest tuple / 报错)
3. **壳的问题** → `npm deprecate @flywheel-ai/onboard@<ver>` + 在 PR 里 bump 版本修复前进
4. **payload / Worker 的问题** → 停止对外分发,按端点允许的 quarantine / 修复前进处置
5. 全程告诉我,我按 runbook §8 断案手册处置

---

## 撞墙了怎么办

| 症状 | 含义 | 怎么办 |
|---|---|---|
| R2 要绑卡 / 有收费 | 预检 0a | **停,你决定** |
| `npm org ls flywheel-ai <你>` 查不到你是 owner | 预检 0b | **停,告诉我** —— org 归属要先理清（org 已由 QA 建好,正常应显示 owner） |
| `whoami` 列出多个账号 | 预检 0c | **停,告诉我**,别猜 |
| `npm org ls` 说你不是 owner/admin | 步骤 10b | **停,告诉我** —— 权限是账号级的事,别硬发 |
| bucket / Worker 名已存在 | 步骤 3 | **停,告诉我** —— 走 resume,别覆盖 |
| SHA 校验打印 ❌ | 步骤 1 / 9 | **停,告诉我** —— 别从不对的树发布 |
| 步骤 7 不是 200 | manifest 没建成 | **停,告诉我** |
| `412 etag mismatch` | CAS 撞了 | 告诉我,按 runbook §8 |
| `503 not activated` | channel 空态 | 顺序错了 —— 先 publish 再签 key |
| `401` | token 错/没配 | 核对:**sha256 进 Worker、明文进 GitHub** |
| 别的任何不对劲 | — | **停下问我,别硬闯** |
