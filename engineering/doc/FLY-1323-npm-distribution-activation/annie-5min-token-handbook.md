# FLY-1323 · Annie 5 分钟 token 手册(一次性,之后零参与)

你只做一次:创建两枚 token + 各跑一条入库命令。之后所有发布(含 npm publish)归 runner/CI,你再不用碰。

- **token 值只在你手里**:入库用隐藏输入,值不经过任何 agent、不进聊天。
- **两枚 token 都做最小权限**:CF 只给 R2+Workers、npm 只给这一个包。将来要收紧/吊销随时能做。

---

## ① Cloudflare — 建一枚 scoped API token(纯网页点选)

1. 开 https://dash.cloudflare.com → 右上角头像 → **My Profile** → 左栏 **API Tokens** → **Create Token**。
2. 拉到最下 **Create Custom Token** → **Get started**。
3. **Token name**:填 `flywheel-onboard-activation`
4. **Permissions**（点 + Add more 加满三行，全是 Account 级）：
   - `Account` · `Workers Scripts` · **Edit**
   - `Account` · `Workers R2 Storage` · **Edit**
   - `Account` · `Account Settings` · **Read**
5. **Account Resources**:`Include` · 选你自己那个账号(**Xrliannie.b@gmail.com**,ID 尾号 `…a2b38b4`)。
6. **Zone Resources**:不用动(我们不碰任何域名)。**TTL/Client IP**:可留空,也可设个到期日更安全。
7. **Continue to summary** → **Create Token** → **复制显示的 token**(只显示这一次)。

> 若你更想用模板:选「Edit Cloudflare Workers」模板后**再加一条** `Workers R2 Storage · Edit` 也行,权限等价。

---

## ② npm — 建一枚 granular publish token(scope 限这一个包)

1. 开 https://www.npmjs.com → 登录(**你的账号**)→ 右上角头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**。
2. **Token name**:`flywheel-ai-onboard-ci-publish`
3. **Expiration**:挑一个(建议 90 天或 1 年;granular 最长 1 年,到期我提醒你换)。
4. **Packages and scopes**:
   - Permissions → **Read and write**
   - 选 **Only select packages and scopes** → 加 `@flywheel-ai/onboard`
5. **Organizations**:**No access**(发这个包不需要 org 管理权)。
6. ⚠️ **必须勾选「Bypass two-factor authentication」**(绕过 2FA 的开关,默认是关的)——
   CI 无人值守发布没法输 OTP,不勾这个,CI publish 会直接失败要验证码。你已明示接受此项。
7. **Generate token** → **复制显示的 token**(只显示这一次)。

> 这枚 granular token 用于 CI 自动发布(勾了 Bypass 2FA 才真正免 OTP)。它只能写这一个包,别的动不了。
> (万一将来 CI 发布报「需要 org 读权限」这类边缘情况,fallback 是把 Organizations 给个 read;先按上面最小化建。)

---

## ③ 两条入库命令(你亲手跑,隐藏输入,值不经过 agent)

⚠️ **必须带 `--env release`**(存进 GitHub Environment「release」,只有跑在 main 上的发布 workflow 能读)。
不带它就成了 repo 级 secret —— **任何分支的 workflow 都能读到,整个「merge 门=发布门」的保护就没了**。
两条都**不要加 `--body`** —— 不加时 `gh` 让你隐藏粘贴,token 不进 shell history、不进进程 argv、不进任何 agent。

```
gh secret set CLOUDFLARE_API_TOKEN -R xrliAnnie/flywheel --env release
```
回车后粘 **①的 Cloudflare token**、回车。

```
gh secret set NPM_PUBLISH_TOKEN -R xrliAnnie/flywheel --env release
```
回车后粘 **②的 npm token**、回车。

然后**清掉 repo 级旧副本**(若之前存过;不存在会报 not found,无害):

```
gh secret delete CLOUDFLARE_API_TOKEN -R xrliAnnie/flywheel
gh secret delete NPM_PUBLISH_TOKEN -R xrliAnnie/flywheel
```

最后核一眼(两枚都应出现在 env 列表、不出现在 repo 列表):

```
gh secret list -R xrliAnnie/flywheel --env release
gh secret list -R xrliAnnie/flywheel
```

> 将来**轮换 token 也照本节做**(同样 --env release + 删 repo 级)。
> 建议顺手把这两枚 token 也各存一份进你的密码管理器(备份;轮换/排错用)。
> `CLOUDFLARE_ACCOUNT_ID` 不是秘密,我自己配,不用你管。

---

### 跑完这三步,把「两条 gh secret set 都成功了」告诉我(或 Tadashi 转我)。

之后 bucket / Worker / payload / manifest / promote / npm publish 全部由我经 CI 执行,并把发布通道配成以后全自动 —— **你零参与**。
（我执行时只用 secret 的**名字**,拿不到、也不需要 token 的值。）
