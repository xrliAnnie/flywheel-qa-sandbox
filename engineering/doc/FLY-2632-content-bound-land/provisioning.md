# FLY-2632 批准绑内容 — 签票密钥部署手册
Issue: FLY-2632 (https://linear.app/geoforge3d/issue/FLY-2632/land批准绑内容-founder-按卡后引擎自动-rebase-到最新-mainci复审通过且非冲突-hunk-逐字不变即沿用原批准直接)
日期: 2026-09-16
基于: plan.md

## 目的与边界

结构化 land ticket 使用 Ed25519：Bridge 独占私钥并签名，GitHub Actions 只持公钥并验签。缺少私钥、公钥或可信 Bridge GitHub login 时，自动 land 不得静默 held；引擎会回到既有重新立卡路径并通知 Lead。

本手册由有生产配置权限的 operator 执行。不要把私钥提交到仓库、PR、命令输出、Discord 或 Linear；不要用本手册触发真实合入。

## 1. 生成并自检密钥对

在受控主机的临时私有目录中生成 Ed25519 密钥：

```sh
KEY_DIR="$(mktemp -d)"
chmod 700 "$KEY_DIR"
openssl genpkey -algorithm ED25519 -out "$KEY_DIR/private.pem"
openssl pkey -in "$KEY_DIR/private.pem" -pubout -out "$KEY_DIR/public.pem"
chmod 600 "$KEY_DIR/private.pem" "$KEY_DIR/public.pem"
```

确认公私钥匹配：

```sh
printf '%s' 'flywheel-land-ticket-self-test' > "$KEY_DIR/message"
openssl pkeyutl -sign -rawin -inkey "$KEY_DIR/private.pem" \
  -in "$KEY_DIR/message" -out "$KEY_DIR/signature"
openssl pkeyutl -verify -rawin -pubin -inkey "$KEY_DIR/public.pem" \
  -in "$KEY_DIR/message" -sigfile "$KEY_DIR/signature"
```

最后一条命令必须返回成功。失败时停止部署并重新生成，不得混用两轮文件。

## 2. 配置 GitHub 受保护输入

公钥可以进入 GitHub Actions secret；私钥不可以。仓库为 `xrliAnnie/flywheel`：

```sh
base64 < "$KEY_DIR/public.pem" | tr -d '\n' | \
  gh secret set FLYWHEEL_LAND_TICKET_PUBLIC_KEY_B64 --repo xrliAnnie/flywheel
gh variable set FLYWHEEL_BRIDGE_GITHUB_LOGIN \
  --repo xrliAnnie/flywheel --body '<bridge-github-login>'
```

`<bridge-github-login>` 必须是 Bridge 实际通过 `gh` 发布评论的 GitHub login，不能填 Lead、Runner 或 founder 身份。

只核名称与变量值，不读取 secret 内容：

```sh
gh secret list --repo xrliAnnie/flywheel | \
  rg '^FLYWHEEL_LAND_TICKET_PUBLIC_KEY_B64\b'
gh variable get FLYWHEEL_BRIDGE_GITHUB_LOGIN --repo xrliAnnie/flywheel
```

## 3. 配置 Bridge 私钥

将下面一行写入生产状态目录的 `.env`（通常是 `~/.flywheel/.env`），值是 `private.pem` 的单行 base64：

```text
FLYWHEEL_LAND_TICKET_PRIVATE_KEY_B64=<base64-of-private.pem>
```

生成该值到同一私有临时目录，再由受控 secret editor 读取；不要打印或复制到日志：

```sh
base64 < "$KEY_DIR/private.pem" | tr -d '\n' > "$KEY_DIR/private.b64"
chmod 600 "$KEY_DIR/private.b64"
```

若键已存在，必须原位替换，不能留下重复定义。完成后确认 `.env` 权限为 `0600`。配置只在 Bridge 进程启动时读取；必须随批准的部署窗口重启 Bridge 才会生效。

## 4. 受管重启与验证

由具备部署权限的 operator 使用仓库既有受管流程；先 dry-run，再在批准窗口执行：

```sh
scripts/restart-services.sh --dry-run --reason FLY-2632-land-ticket-key
scripts/restart-services.sh --wait-idle --reason FLY-2632-land-ticket-key
```

重启后验证 Bridge 健康、代码合同和 GitHub 配置存在：

```sh
curl -fsS "${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:9876}/health"
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/land-merge-ticket.test.ts \
  src/bridge/__tests__/ship-workflow-failure-receipt.test.ts
gh secret list --repo xrliAnnie/flywheel | \
  rg '^FLYWHEEL_LAND_TICKET_PUBLIC_KEY_B64\b'
gh variable get FLYWHEEL_BRIDGE_GITHUB_LOGIN --repo xrliAnnie/flywheel
```

不要用生产 PR 的 `:cool:` 评论做配置探针。下一张正常 founder 批准卡由引擎产生的结构化 ticket 才是端到端证据；届时核对 workflow receipt 绑定 comment id、ticket id、nonce 与精确 head。

## 5. 清理与轮换

验证完成后安全删除临时目录。轮换时先保留在途 ticket 所需的旧公钥验证能力并停止签发新 ticket，完成对账后再替换；不得只换一侧。任何配置缺失都会触发重新立卡与 Lead alert，而不是放宽到 unsigned `:cool:`。
