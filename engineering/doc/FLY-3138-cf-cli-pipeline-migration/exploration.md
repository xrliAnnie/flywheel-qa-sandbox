# FLY-3138 安装包发布流水线 wrangler→cf — 探索
Issue: FLY-3138 (https://linear.app/geoforge3d/issue/FLY-3138/cloudflaref5挂起-安装包分发的发布流水线从-wrangler-改用-cf-触发条件cf-正式版发布)
日期: 2026-10-02
基于: 无（上游产品文档 = 生产仓 `product/doc/FLY-3102-cloudflare-cf-cli/proposal.html` F5 + `explainer.html` 第 4、8 格）

## 0. 一句话

把「安装包分发」这条发布流水线（`payload-activation.yml` + CI 部署演练 + 配套测试）里所有 `wrangler` 调用换成 Cloudflare 新 CLI `cf`，Worker 名字 / R2 存储桶 / 密钥名 **一个都不变**；本单 **挂起**，触发条件 = cf 正式版（GA，公测结束）。

## 1. 审计范围与「沙箱缺口」声明

本次 design 节点跑在 QA 沙箱 worktree（`flywheel-qa-sandbox` 快照，`doc/VERSION`=v1.55.0）。issue 引用的三样东西 **沙箱里都不存在**：

| issue 引用 | 沙箱 | 生产 `~/Dev/flywheel` origin/main (`2abffd1e6`) |
|---|---|---|
| `.github/workflows/payload-activation.yml` | ❌ 无 | ✅ 463 行 |
| `product/doc/FLY-3102-cloudflare-cf-cli/{proposal,explainer}.html` | ❌ 无 | ✅ |
| `packages/payload-endpoint/wrangler.toml` | ✅（FLY-1062 PR3 旧版，无 `[vars]`） | ✅（有 `[vars] FW_R2_BUCKET`） |

因此：**本设计以生产 origin/main 为准**（只读参考），实施节点必须在生产分支上做；沙箱里只落设计文档。实施前第一步要重新对一遍生产文件（见 plan §6 前置检查），因为挂起期间生产文件还会变。

## 2. 生产现状：wrangler 用在哪（逐处）

`git grep wrangler`（排除 md/html/lockfile）命中 7 个文件，真正「会执行 wrangler」的只有 2 个 workflow：

### 2.1 `payload-activation.yml`（12 处提及，**9 个执行点**，只在 `mode=infra`）

| # | 步骤 | 现在的 wrangler 调用 | 说明 |
|---|---|---|---|
| A | Create R2 bucket | `pnpm exec wrangler r2 bucket create flywheel-payloads` | 输出含 "already exists" 时当作 resume 成功 |
| B | Verify private R2 + lifecycle | `wrangler r2 bucket lifecycle set flywheel-payloads --file packages/payload-endpoint/r2-lifecycle.json --force` | 前后都用 **curl 直打 Cloudflare API 读回** 校验（与 CLI 无关） |
| C | Stage B2 Worker secrets | 循环 `wrangler secret put <NAME> --config …/wrangler.toml`（stdin 喂值），3 个：`FW_R2_ACCESS_KEY_ID` / `FW_R2_SECRET_ACCESS_KEY` / `FW_CLEANUP_TOKEN_SHA256` | **设密钥第 1 处** |
| D | Stage B4 Worker secrets | 循环同上，名单 = `releaseDeploymentSecrets(env)` 的 key（可为空 = 保持远端现状） | **设密钥第 2 处**；「缺省配置 = 保留远端」语义 |
| E | Deploy Worker | `wrangler deploy --config … --var "FW_R2_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"`，再从输出 grep `https://flywheel-onboard-endpoint.<sub>.workers.dev` | URL 抓取依赖 **wrangler 的人类可读输出** |
| F | Stamp beta sha | `printf sha \| wrangler secret put FW_BETA_PUBLISH_TOKEN_SHA256` | **设密钥第 3 处**（在 deploy 之后） |
| G | Stamp customer sha | 同上 `FW_CUSTOMER_RELEASE_TOKEN_SHA256` | **设密钥第 4 处** |

另：workers.dev 子域名步骤、manifest 初始化步骤用 curl / fetch，**不用 wrangler**，不在本单范围。`mode=publish`（npm 发布）**完全不碰 Cloudflare**，不在范围。

> issue 说「设 4 次」= 4 个 **设密钥调用点**（C/D/F/G），实际写入的密钥个数是 3 + N(B4) + 1 + 1。

### 2.2 `ci.yml`（部署演练，1 处）

```
pnpm exec wrangler deploy --dry-run --outdir $RUNNER_TEMP/payload-worker \
  --metafile $RUNNER_TEMP/payload-worker-meta.json --config packages/payload-endpoint/wrangler.toml
```
之后用 node 读 **esbuild metafile** 的 `inputs`，断言 bundle 里包含 `aws4fetch`、`payload-endpoint/src/presign.mjs`、`release-contract/src/*`（= 「Worker 真把签名器和发布合同打进包了」的证据）。`WRANGLER_LOG_PATH` 指到 runner temp。**无凭据**。

### 2.3 写死 wrangler 字面量的测试 / lint

| 文件 | 写死了什么 |
|---|---|
| `packages/payload-endpoint/__tests__/activation-config.test.mjs` | 断言 B4 步骤 `execFileSync('pnpm', ['exec','wrangler','secret','put',NAME,'--config','packages/payload-endpoint/wrangler.toml'])` 参数逐字；名单顺序 = `releaseDeploymentSecrets` key 顺序；失败第一个就停 |
| `scripts/__tests__/release-workflows-structure.test.sh` S4a | ci.yml 里必须 **恰好 1 处** `pnpm exec wrangler deploy` 且恰好 1 处 `--dry-run`；任何 workflow 出现 `CLOUDFLARE\|WRANGLER\|CF_API` 必须是 release-env workflow 或 ci.yml 的唯一 dry-run |
| activation 「Validate B2 deployment inputs」步骤 | 用正则从 **wrangler.toml 文本** 读 `bucket_name` 和 `FW_R2_BUCKET`，断言都等于 `flywheel-payloads` |
| 根 `package.json` | devDependency `"wrangler": "4.111.0"`（精确锁），`pnpm install --frozen-lockfile` |
| `packages/payload-endpoint/src/worker.mjs` | 仅注释提到 wrangler.toml |

## 3. 不能变的东西（验收 ④ 的精确清单 = 「稳定身份」）

| 身份 | 值 | 现在定义处 |
|---|---|---|
| Worker 名 | `flywheel-onboard-endpoint` | wrangler.toml `name`（且 deploy URL grep 正则写死） |
| R2 桶 | `flywheel-payloads` | `bucket_name` + `[vars] FW_R2_BUCKET` |
| R2 绑定名 | `PAYLOADS` | `[[r2_buckets]] binding` |
| 入口 | `src/worker.mjs` | `main` |
| compatibility_date | `2026-07-01` | 同上 |
| Worker 密钥名 | `FW_R2_ACCESS_KEY_ID`、`FW_R2_SECRET_ACCESS_KEY`、`FW_CLEANUP_TOKEN_SHA256`、B4 名单、`FW_BETA_PUBLISH_TOKEN_SHA256`、`FW_CUSTOMER_RELEASE_TOKEN_SHA256` | workflow + `release-deployment.mjs` |
| **CI 之外的密钥** | `FW_OPS_ADMIN_TOKEN_SHA256`（创始人手设，刻意不进 CI） | 无代码，只在远端 Worker 上 |
| deploy 时变量 | `FW_R2_ACCOUNT_ID` = `vars.CLOUDFLARE_ACCOUNT_ID` | `--var` |
| GitHub 侧凭据 | `secrets.CLOUDFLARE_API_TOKEN`（`release` 环境）、`vars.CLOUDFLARE_ACCOUNT_ID` | 不变 |

最后一行是最危险的隐性约束：**任何「整版本带一份密钥文件上传」的写法都可能把不在文件里的 `FW_OPS_ADMIN_TOKEN_SHA256` 抹掉或保留——行为要在 GA 时实测确认**（见 research §3）。

## 4. cf 现状（2026-10-02 实查）

- npm `cf` 最新 `1.0.0-beta.11`（10/2 发布），5 天 11 个 beta —— 命令仍在快速变。**GA 未发生，触发条件未满足。**
- 官方「Commands not yet supported」仍列 `wrangler secret put`：「cf cannot set a single secret yet … or upload secrets with a new Worker version by passing `--secrets-file <PATH>` to `cf deploy`」。
- 其余详见 research.md。

## 5. 待澄清 / 假设（非阻塞，写进 plan 的 GA 前置核对）

1. **假设**：GA 时 cf 会提供「单独设一个密钥」命令（proposal 的整个挂起理由就建立在这上面）。若 GA 仍没有 → plan §5 的「GA 仍缺单密钥」分支：不自作主张改用 `--secrets-file`，回报 Lead 由创始人定。
2. **假设**：`cf migrate` 默认保留「Wrangler 打包器」时，GA 版不再需要安装 `wrangler` 包；否则验收 ①「不再需要 wrangler」不成立 → 改用 Vite 打包器或回报。GA 时实测 `pnpm why wrangler`。
3. 挂起期间生产 workflow 还可能被别的单改（B4 等已经在长），实施节点必须以 **实施当天的生产 main** 重新审计，本表只是基线。
