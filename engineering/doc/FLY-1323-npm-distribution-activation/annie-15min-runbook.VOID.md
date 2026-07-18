> 🛑 **VOID / 已作废(2026-07-18)** —— Annie 直令改道为「一次性 token 化,之后 runner/CI 全自动」。
> 本 15 分钟亲手发布流程作废,替代 = annie-5min-token-handbook.md。保留仅作历史。

---

# FLY-1323 · Annie 激活 runbook(逐条复制粘贴)

npm 分发层首次激活。你只做**持凭据**的步骤,分**窗口一 / 窗口二**两段,中间我干活(~30–60 分钟,你不用在场)。

## 读我(30 秒)

- **凭据全程只在你手里。我一行不碰、也不替你操作 Cloudflare / npm。**
- **token 不要直接打进命令**(会进 shell history)。凡是要贴 token 的地方都用隐藏输入,我在那一步标了「⏸ 先贴到这里」。
- ⚠️ **有隐藏输入(`read`)的块请分两次贴**:先贴到 `read` 那行、回车、粘 token、回车;**再**贴剩下的。一次性整块贴进去,`read` 会把下一行当成 token(结果是 401、会停,不出事,但白跑一遍)。
- **每个 ✅/❌ 都是闸**:看到 ✅ 才继续下一块;看到 ❌ 或任何别的数字就**停下告诉我**,别「看着差不多」往下。
- 真 Cloudflare 这一段你我都是第一次跑,**撞到怪事很正常,停下问我**,别硬闯。

---

# 窗口一(~15 分钟,你的凭据)

## 前置 · R2 + 付款(你已完成,10 秒确认)

你之前说「Cloudflare 加了 R2」——window-1 需要 R2 已启用 + 账号绑了付款方式。若都已就绪,直接往下。
(费用实话:免费额度 10GB 存储 / 1M Class-A / 10M Class-B 每月,我们几个 payload tarball 离额度很远;Cloudflare 页面写 Total Due Now = $0.00,只在超额才收费。绑卡时发卡行**可能**有一笔小额验证预授权,那是银行行为。)

## 步骤 0 · 账号 ID + wrangler 认证

```bash
export CLOUDFLARE_ACCOUNT_ID="66ab54493236cb4c0f9d865a6a2b38b4"

# 让 wrangler 认到你的 Cloudflare 账号(浏览器点一次 Allow):
npx --yes wrangler@4.111.0 login
```

浏览器会弹出授权页 —— **确认账号是 Xrliannie.b@gmail.com** 再点 Allow。回终端确认身份:

```bash
npx --yes wrangler@4.111.0 whoami
```

**必须打印你的 Xrliannie.b 账号 + account id 含 `66ab5449…`。**

- 打印的账号/ID 不对 → **停,告诉我**(别在错账号上建东西)。
- 若后面步骤 3/4 报 **R2 或 Workers 权限不足** → wrangler login 的授权没覆盖 R2:改走 API token —— Cloudflare dashboard → My Profile → API Tokens → Create Token → 用「Edit Cloudflare Workers」模板 + 加一条 R2「Edit」权限 → 生成后 `export CLOUDFLARE_API_TOKEN=<粘进来>`,再重跑 `whoami`。**这一步也全在你手里,我不碰 token。**

## 步骤 1 · 进入我给你备好的干净发布 checkout

```bash
export REL="/Users/xiaorongli/Dev/flywheel/worktrees/fly1323-release"

# 硬校验:不满足就停。整块包在 ( ) 里,cd 进不去就结束子壳,绝不会拿别的仓库核 SHA。
(
  cd "$REL" || { echo "❌ 进不去 $REL —— 停,告诉我。别继续。"; exit 1; }
  HEAD_SHA="$(git rev-parse HEAD)"; H_RC=$?
  DIRTY="$(git status --porcelain -- packages/payload-endpoint packages/onboard-shell scripts/release)"; S_RC=$?
  if [ "$H_RC" -ne 0 ] || [ "$S_RC" -ne 0 ]; then
    echo "❌ git 读不出来(rev-parse $H_RC / status $S_RC)—— 停。别把读失败当干净。"
  elif [ "$HEAD_SHA" != "d07732f7ac3f54be4b525a0d357065497d62c954" ]; then
    echo "❌ SHA 不对(实际 $HEAD_SHA)—— 停,告诉我。"
  elif [ -n "$DIRTY" ]; then
    echo "❌ 工作树不干净 —— 停,告诉我。"
  else
    echo "✅ release checkout 校验通过,可以往下走"
  fi
)
```

**必须看到 ✅。** 这个 checkout 我已备好、核过(HEAD=d07732f7a、干净、不含任何凭据)。

## 步骤 2 · 生成三枚 token(存进你的密码管理器)

跑 **3 次**,每次给一对 `token` + `sha256`:

```bash
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
```

| # | 叫什么 | token 明文归谁 | sha256 用在哪 |
|---|---|---|---|
| 1 | **beta-publish** | GitHub repo secret(步骤 6) | Worker(步骤 5) |
| 2 | **customer-release** | **只在你手里**(窗口二用) | Worker(步骤 5) |
| 3 | **ops-admin** | 你手里 → 密码管理器 | Worker(步骤 5) |

> 端点只存 sha256;token 泄漏就换一枚重灌。**三枚明文都不要**发 Discord / Linear / PR / 任何聊天流,只进密码管理器。

## 步骤 3 · 只读碰撞检查(别盲建)

```bash
(
  BUCKETS="$(npx --yes wrangler@4.111.0 r2 bucket list 2>&1)"; BRC=$?
  [ "$BRC" -eq 0 ] || { echo "❌ r2 bucket list 失败(exit $BRC)—— 停。原文:"; echo "$BUCKETS"; exit 1; }
  echo "$BUCKETS"
  case "$BUCKETS" in
    *flywheel-payloads*) echo "⚠️ bucket flywheel-payloads 已存在 —— 停,别覆盖,告诉我走 resume。"; exit 1 ;;
  esac
  DEPLOYS="$(npx --yes wrangler@4.111.0 deployments list --name flywheel-onboard-endpoint 2>&1)"; DRC=$?
  echo "$DEPLOYS"
  if [ "$DRC" -eq 0 ]; then
    echo "⚠️ Worker flywheel-onboard-endpoint 已存在 —— 停,告诉我走 resume。"; exit 1
  elif grep -qi "flywheel-onboard-endpoint" <<<"$DEPLOYS" && grep -qiE "not found|does not exist|could not find [^ ]*worker" <<<"$DEPLOYS"; then
    echo "✅ COLLISION_CHECK_CLEAR —— bucket 和 Worker 都不存在,可以进步骤 4。"
  else
    echo "❌ deployments list 非零但不是明确的『该 Worker 不存在』—— 可能 auth/account/网络错。停,把上面原文发我。"; exit 1
  fi
)
```

**必须看到 `COLLISION_CHECK_CLEAR`。** 看到 ⚠️「已存在」→ 停,可能是上次的半成品,走 resume 不覆盖。

## 步骤 4 · 建 bucket + 部署 Worker(先 deploy,后灌 secret)

```bash
(
  cd "$REL/packages/payload-endpoint" || { echo "❌ 进不去 payload-endpoint —— 停,别往下。"; exit 1; }
  npx --yes wrangler@4.111.0 r2 bucket create flywheel-payloads \
    || { echo "❌ 建 bucket 失败 —— 停,别 deploy。告诉我。"; exit 1; }
  npx --yes wrangler@4.111.0 deploy \
    || { echo "❌ deploy 失败 —— 停,告诉我。"; exit 1; }
)
```

> 此刻 Worker 上线但三个 capability hash 还没配 = 全 fail-closed(任何写都 401)。这是安全中间态,正常。
> **可能的交互**:若这账号从没注册过 workers.dev 子域,wrangler 会让你**现场注册一个账号级 subdomain**(一次性、之后所有 Worker 共用,会出现在客户看到的 URL 里)。**拿不准就停下问我**,别随手起。

输出里会有一行 `https://flywheel-onboard-endpoint.<你的子域>.workers.dev`。📌 **把这行完整发我**(我要用它改代码占位符),并存起来:

```bash
export FW_ENDPOINT="https://flywheel-onboard-endpoint.<你的子域>.workers.dev"
```

## 步骤 5 · 灌三个 sha256 进 Worker(粘 sha256,不是 token)

整块一起贴;wrangler 会**依次**提示三次 `Enter a secret value:`,你按顺序粘对应的 **sha256** 再回车。

```bash
(
  npx --yes wrangler@4.111.0 secret put FW_BETA_PUBLISH_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 beta sha 失败 —— 停,别继续。"; exit 1; }
  npx --yes wrangler@4.111.0 secret put FW_CUSTOMER_RELEASE_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 customer sha 失败 —— 停,别继续。"; exit 1; }
  npx --yes wrangler@4.111.0 secret put FW_OPS_ADMIN_TOKEN_SHA256 --config "$REL/packages/payload-endpoint/wrangler.toml" \
    || { echo "❌ 灌 ops sha 失败 —— 停。"; exit 1; }
  echo "✅ 三个 sha256 都灌进 flywheel-onboard-endpoint 了"
)
```

> 每条带 `--config` 是指死那个 Worker 的配置,不依赖你此刻在哪个目录。哪条报错就停、告诉我。

## 步骤 6 · 配 GitHub repo secret(明文 beta-publish token)

```bash
gh secret set FW_BETA_PUBLISH_TOKEN -R xrliAnnie/flywheel
```

> **不要加 `--body`。** 不加时 `gh` 让你隐藏输入/从 stdin 粘贴,token 不进 history、不进进程 argv。粘 **beta-publish 的明文 token**(不是 sha256)。

## 步骤 7 · 初始化 manifest(空态)—— 分两块贴

**先贴这块,看到 ✅ 才贴下一块:**

```bash
if cd "$REL"; then echo "✅ 已进入 $REL —— 可以贴下面那块"; else echo "❌ 进不去 $REL —— 停,下面一行都别贴。"; fi
```

**⏸ 看到 ✅ 之后**才贴下面(它会先让你粘 beta-publish token,隐藏输入):

```bash
printf 'beta-publish token: '
IFS= read -rs BETA_TOK; echo

printf 'Authorization: Bearer %s\n' "$BETA_TOK" | \
curl --fail-with-body -sS -o /tmp/fw-init.out -w '%{http_code}\n' \
  -X POST "$FW_ENDPOINT/admin/manifest" \
  -H @- \
  -H 'content-type: application/json' \
  -d '{"baseEtag":null,"manifest":{"schemaVersion":1,"channels":{"internal-beta":{"latest":null},"customer-release":{"latest":null}},"versions":{},"releaseOps":{},"releaseLedger":{},"tombstones":[]}}'

cat /tmp/fw-init.out; echo
unset BETA_TOK
```

**必须打印 `200`。** 任何别的数字 → **停,告诉我**(401 = token 错;别的按原文发我)。

## 步骤 8 · 打开 beta CI 激活开关(窗口一最后一步)

manifest 初始化成功(上一步 200)**之后**才做:

```bash
gh variable set FW_ENDPOINT -R xrliAnnie/flywheel --body "$FW_ENDPOINT" \
  || echo "❌ gh variable set 失败 —— 停,告诉我。"
STORED="$(gh variable get FW_ENDPOINT -R xrliAnnie/flywheel 2>/dev/null)"; G_RC=$?
if [ "$G_RC" -eq 0 ] && [ "$STORED" = "$FW_ENDPOINT" ]; then
  echo "✅ FW_ENDPOINT_SET —— 已设且回读一致:$STORED"
else
  echo "❌ FW_ENDPOINT 回读不一致(exit $G_RC,存的 '$STORED' ≠ 要的 '$FW_ENDPOINT')—— 停,告诉我。"
fi
```

**必须看到 `FW_ENDPOINT_SET`。**

### ▶ 窗口一结束 —— 把那行 workers.dev URL 发我,我接手中段(改占位符 PR + 发 beta payload + promote prepare,~30–60 分钟,你不用在场)。

---

# 中段(我做,你不用在场)

- 改 `DEFAULT_ENDPOINT` → 你的真 URL,开 PR、过 Codex review、founder-gated merge
- dispatch beta release CI(真发第一个 payload),留证据
- 跑 promote prepare(clean 重建 + 逐字节等价证明)
- **把窗口二下面的三个空填好**(PR merge SHA / release-id / 候选 sha256),再把更新版发你

---

# 窗口二(~5 分钟,你的凭据)—— 下面三个空我在窗口一后填好再发你

```
<REL 不变> / <PR-2 merge SHA:待填> / <release-id:待填> / <候选 sha256:待填>
```

## 步骤 9 · promote 发布(customer 指针)

```bash
export REL="/Users/xiaorongli/Dev/flywheel/worktrees/fly1323-release"
export FW_ENDPOINT="<你的真 URL>"

# 窗口二的树也要重核(checkout 已被我推进到 PR-2 merge SHA):
if cd "$REL"; then
  HEAD_SHA="$(git rev-parse HEAD)"; H_RC=$?
  DIRTY="$(git status --porcelain -- packages/payload-endpoint packages/onboard-shell scripts/release)"; S_RC=$?
  if [ "$H_RC" -ne 0 ] || [ "$S_RC" -ne 0 ]; then echo "❌ git 读不出(rev-parse $H_RC / status $S_RC)—— 停。"
  elif [ "$HEAD_SHA" != "<待填:PR-2 merge SHA>" ]; then echo "❌ SHA 不对(实际 $HEAD_SHA)—— 停,告诉我。"
  elif [ -n "$DIRTY" ]; then echo "❌ 树不干净 —— 停,别 commit/publish。"
  else echo "✅ SHA 对且树干净,继续"; fi
else echo "❌ 进不去 $REL —— 停。"; fi
```

**先只读核对候选 hash(带凭据,分两块贴)。⏸ 先贴这块:**

```bash
printf 'customer-release token: '
IFS= read -rs REL_TOK; echo
MANIFEST="$(printf 'Authorization: Bearer %s\n' "$REL_TOK" | \
  curl --fail-with-body -sS -H @- "$FW_ENDPOINT/admin/manifest" 2>&1)"; CRC=$?
if [ "$CRC" -ne 0 ]; then echo "❌ 读 manifest 失败(curl $CRC)—— 停。原文:"; echo "$MANIFEST"
elif jq -e --arg id "<待填:release-id>" --arg sha "<待填:候选 sha256>" '.releaseOps[$id].sha256 == $sha' <<<"$MANIFEST" >/dev/null 2>&1; then
  echo "✅ 库里候选 hash == 我给你的那个"
else echo "❌ 不一致(或库里没这个候选)—— 停,别 commit"; fi
```

**只有 ✅ 才执行发布:**

```bash
FW_CUSTOMER_RELEASE_TOKEN="$REL_TOK" node scripts/release/payload-promote.mjs \
  commit --release-id <待填> --expected-sha256 <待填:候选 sha256>
PROMOTE_RC=$?
unset REL_TOK
if [ "$PROMOTE_RC" -eq 0 ]; then echo "✅ PROMOTE_COMMITTED —— 只有看到这行才允许进步骤 10。"
else echo "❌ promote commit 失败(exit $PROMOTE_RC)—— 停。没有 PROMOTE_COMMITTED 绝不许跑步骤 10。"; fi
```

## 步骤 10 · 发 npm 薄壳包 `@flywheel-ai/onboard`

### 10a. 先跑 preflight(不能跳)

```bash
( cd "$REL" || { echo "❌ 进不去 $REL —— 停。"; exit 1; }
  bash scripts/release/shell-publish-preflight.sh --founder-local )
```

**必须看到 `PREFLIGHT PASS`。** 它挡:占位符 endpoint / 版本号已被占 / 打包超白名单 / 内容 gate 红。

### 10b. 确认身份 + registry(首次不可逆发布)

```bash
npm config get registry              # 必须是 https://registry.npmjs.org/
npm login                            # 你的账号 + 2FA
if NPM_USER="$(npm whoami)" && [ -n "$NPM_USER" ]; then
  echo "✅ 当前身份:$NPM_USER —— 必须是你预期的账号"
  npm org ls flywheel-ai "$NPM_USER"    # 必须显示 owner 或 admin
else echo "❌ npm whoami 没拿到用户名 —— 停,别发布。"; fi
```

- `npm org ls flywheel-ai <你>` 查不到你是 owner/admin → **停,告诉我**(org 归属要先理清;org 已由 QA 建好,正常应显示 owner)。

### 10c. 发

```bash
(
  cd "$REL/packages/onboard-shell" || { echo "❌ 进不去 onboard-shell —— 停,别发布。"; exit 1; }
  npm publish --access public || { echo "❌ npm publish 失败 —— 停,告诉我。"; exit 1; }
  LOCAL_V="$(node -p "require('./package.json').version")"
  PUB_V="$(npm view "@flywheel-ai/onboard@$LOCAL_V" version 2>&1)"; VRC=$?
  if [ "$VRC" -eq 0 ] && [ "$PUB_V" = "$LOCAL_V" ]; then
    echo "✅ 已发布并确认:@flywheel-ai/onboard@$LOCAL_V 在 registry 上可见"
  else echo "❌ 发布后没能确认版本(view exit $VRC, 回来='$PUB_V')—— 停,告诉我。"; exit 1; fi
)
```

> 别加 `--ignore-scripts`(将来 gate 靠 script 钩子)。

## 步骤 11 · 签一枚 license key 给独立 QA(分两块贴)

```bash
export FW_ENDPOINT="<你的真 URL>"
printf 'ops-admin token: '
IFS= read -rs OPS_TOK; echo
( cd "$REL" || { echo "❌ 进不去 $REL —— 停,别签 key。"; exit 1; }
  FW_OPS_ADMIN_TOKEN="$OPS_TOK" node scripts/release/license-key.mjs issue \
    --customer qa-fly-1323 --entitlement customer --note "FLY-1323 acceptance" )
LICENSE_RC=$?
unset OPS_TOK
if [ "$LICENSE_RC" -eq 0 ]; then echo "✅ LICENSE_ISSUED —— key 已签发(明文在上面,只这一次)"
else echo "❌ 签 key 失败(exit $LICENSE_RC)—— 停,告诉我。"; fi
```

**明文 key 只打印这一次。** 不要贴进任何聊天流;给独立 QA 时你在 QA 的隐藏输入里亲手粘。记下非敏感的 **key id**,验收完 revoke。

### ▶ 窗口二结束 —— 激活完成。独立 QA 在干净机器上 `npx @flywheel-ai/onboard` 一条命令走通 = 验收通过。

---

## 撞墙速查

| 症状 | 怎么办 |
|---|---|
| wrangler 报 R2/Workers 权限不足 | 步骤 0 fallback:建 API token(Edit Workers + R2 Edit)→ export CLOUDFLARE_API_TOKEN |
| bucket/Worker 名已存在 | 停,走 resume,别覆盖 |
| SHA 校验 ❌ | 停,别从不对的树发布 |
| 步骤 7 不是 200 / 步骤 9 no PROMOTE_COMMITTED | 停,告诉我 |
| `401` | token 错/没配:核对 sha256 进 Worker、明文进 GitHub |
| `503 not activated` | 顺序错了:先 publish 再签 key |
| 别的任何不对劲 | **停下问我,别硬闯** |
