# FLY-3138 安装包发布流水线 wrangler→cf — 调研
Issue: FLY-3138 (https://linear.app/geoforge3d/issue/FLY-3138/cloudflaref5挂起-安装包分发的发布流水线从-wrangler-改用-cf-触发条件cf-正式版发布)
日期: 2026-10-02
基于: exploration.md

## 0. 资料来源（2026-10-02 实查，cf 仍为公测）

- `npm view cf` → `latest: 1.0.0-beta.11`（2026-10-02T06:58Z）；beta.5→beta.11 只用 3 天。
- https://developers.cloudflare.com/cf/wrangler/ 、`/cf/wrangler/migrate/`、`/cf/wrangler/reference/`、`/cf/projects/`、`/cf/ci/`（页面 dateModified 2026-09-30）。
- 生产仓 FLY-3102 explainer 第 4、8 格（9/30 的一手调研）。

**所有 cf 命令名、参数在 GA 前都可能变**（官方原话：「Commands, configuration, and Build Output can change before the stable release」）。下文凡标 🔁 的，都是 plan §2「GA 当天核对表」必须重新确认的项。

## 1. 逐处对照：wrangler 现在 → cf 公测版能力

| 执行点 | wrangler 现在 | cf 公测版（今天） | GA 前置核对 |
|---|---|---|---|
| A 建桶 | `wrangler r2 bucket create flywheel-payloads`，靠输出文本 "already exists" 判 resume | 有 R2 资源命令（`cf r2 buckets …`），**资源命令收 API 要的标识**；输出多为 JSON | 🔁 准确命令名；「已存在」时的退出码/JSON 错误码，**改成按错误码判 resume，不再 grep 英文文本** |
| B 生命周期 | `wrangler r2 bucket lifecycle set … --file … --force` | 应有对应 lifecycle 命令（3000+ 操作 ≈ 整个公开 API） | 🔁 命令名、文件格式是否仍吃 `r2-lifecycle.json`（同 API 格式则零改） |
| C/D/F/G 设单个密钥 | `wrangler secret put NAME --config …`（stdin） | **不支持**。官方给的替代：`cf deploy --secrets-file <PATH>` / `cf workers versions create --secrets-file` | 🔁 **GA 是否有单密钥命令**（本单挂起的唯一硬条件）；是否支持 stdin 喂值（不落盘） |
| E 部署 | `wrangler deploy --config … --var FW_R2_ACCOUNT_ID:…`，grep 输出拿 URL | `cf deploy`；项目必须先有 `cloudflare.config.ts`；**文档未列 `--var`**；输出 JSON | 🔁 JSON 里 workers.dev URL 的字段名；deploy 时注入变量的方式 |
| CI 演练 | `wrangler deploy --dry-run --outdir --metafile`，读 esbuild metafile | `cf deploy --dry-run`：「构建+校验，不上传，不发 API，不要凭据」；**没有 `--outdir`/`--metafile`**；产物在 `.cloudflare/output/v0/` | 🔁 Build Output 里能否看到打进包的模块（源路径或内容） |
| 配置 | `wrangler.toml`（12 行） | `cf migrate` → `cloudflare.config.ts`（TypeScript）；保留 Worker 名/绑定/资源 ID；`vars`→`bindings.text()`；`secrets.required`→`bindings.secret()` | 🔁 migrate 产物逐字审 |
| 凭据 | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | **同名同义**，两工具都读 | 无变化 —— GitHub `release` 环境不用动 |

## 2. 公测版里四个「会咬人」的行为（设计必须正面处理）

1. **非交互「假成功」**：CI 里破坏性命令没有 `--force` 时打印 `Aborted.`、**不做任何改动、退出码 0**。→ 设计规则：每个写操作步骤 **不以退出码为成功证据**，必须读回（桶存在/生命周期 deep-equal/密钥名在 `secrets list` 里/部署版本 ID 变了）。B 步骤现在就有 API 读回，照搬到 A、C/D/F/G、E。
2. **自动配置会在 CI 里不问就改文件**：在没有 `cloudflare.config.ts` 的目录跑 `cf deploy`（含 `--dry-run`）会「接受探测结果、装包、改项目文件」，且对非框架 Worker 直接报错。→ `cloudflare.config.ts` 必须 **本地 `cf migrate` 生成、人审、提交**；CI 里所有 cf 调用都必须在含该文件的目录或用 `--prebuilt`；加一条结构 lint：仓库里 cf 调用的工作目录必须有 `cloudflare.config.ts`。
3. **默认上报遥测**，且搜索词也在上报范围。→ 特权 job（持有 Cloudflare token）和 CI 演练都设 `CF_SEND_TELEMETRY=false` + `DO_NOT_TRACK=1`，结构 lint 强制。
4. **「Wrangler 打包器」路径**：`cf migrate` 对非 Vite 项目默认保留 Wrangler 打包器并写实验性 `wrangler.config.ts`。若 GA 时这条路径仍要装 `wrangler` 包 → 违反验收 ①。→ GA 核对 `pnpm why wrangler`；不满足就选 `--bundler vite`（我们是纯 `src/worker.mjs` + 两个 workspace 依赖，Vite 打包风险低但需 CI 演练证明 presign/aws4fetch/release-contract 仍被打进包）。

另：cf 要求 **Node ≥ 22.18**。生产 `.node-version` = `22`（setup-node 会解析到最新 22.x，满足），但 plan 要求把 `.node-version` 显式钉到 ≥22.18 的具体版本或在步骤里断言 `node --version`，否则 cf 报错难懂。

## 3. 为什么不现在就用 `--secrets-file`（被否决的方案，记录理由）

官方给的「现在就能设密钥」的路是 deploy 时带一份密钥文件。拒绝理由：

| 问题 | 细节 |
|---|---|
| 密钥落盘 | 现在密钥只走 stdin 管道；`--secrets-file` 要求写 JSON/.env 文件到 runner 磁盘 —— 新增暴露面（日志/缓存/artifact 误上传） |
| 「不在文件里的密钥」怎么办未知 | `FW_OPS_ADMIN_TOKEN_SHA256` 是创始人在 CI 外手设的；新版本是继承还是清空它，文档没说。清空 = 运维管理能力静默丢失 |
| 时序被打乱 | 现在 B2/B4 在 deploy **前**、两个 sha stamp 在 deploy **后**（stamp 后才 init manifest）。全塞进一次 deploy 要改流水线语义，且要重审 B4「缺省配置 = 保留远端」 |
| 两套并存 + 迁两次 | 公测命令还在变（5 天 11 版），现在迁 = 等于迁两次（proposal F5 原结论） |

结论与 proposal F5 一致：**挂起到 GA**。若 GA 仍不给单密钥命令，`--secrets-file` 是唯一候选，但必须先单独实测「继承 vs 清空」，并由创始人拍板（plan §5 分支 B）。

## 4. CI 演练「打包证据」的替代方案

现在的证据 = esbuild metafile 的 `inputs`。cf 没有 metafile。候选（GA 时按顺序试）：

1. **Build Output 自带模块清单**：`cf build` 后读 `.cloudflare/output/v0/config.json` / 模块列表，若含源路径则断言同三条（首选，语义等价）。
2. **内容哨兵**：在 `presign.mjs`、`release-contract/src/index.mjs` 各有一个稳定导出名；断言打包后的 JS 里出现对应标识（esbuild 不 minify 时保留）。语义稍弱（证明「代码在」而非「源文件在」），但足以挡住「打包漏了签名器」这一回归。
3. 两者都不行 → 保留 wrangler 仅用于本地/CI 的打包证明会违反验收 ①，不选；回报 Lead。

## 5. 结构 lint 的新形状（S4a）

S4a 现在数 `pnpm exec wrangler deploy` = 1 且 `--dry-run` = 1。迁后改为：
- ci.yml 恰好 1 处 `pnpm exec cf deploy --dry-run`，0 处不带 `--dry-run` 的 `cf deploy`；
- **全仓 workflow 0 处 `wrangler`**（新增负向守卫 = 验收 ①的机器证明）；
- 关键字集合加 `cf ` 调用的识别（避免 `cf` 这个短词误匹配：用 `pnpm exec cf ` 精确前缀）；
- 任何含 `pnpm exec cf ` 的 workflow 必须同时设 `CF_SEND_TELEMETRY: "false"`。

## 6. 回滚边界

- 代码层：整单是一个 PR，回滚 = revert（wrangler.toml / devDependency 回来）。远端资源（Worker、桶、密钥）**名字没变**，wrangler 和 cf 操作的是同一批 API 对象，回滚后 wrangler 能直接接着管。
- 远端层：唯一不可逆点是「一次 deploy 推了新版本」——与现在每次 infra 演练相同，可用 Cloudflare 版本回滚。迁移本身不删任何远端对象。
- 版本钉死：`cf` 作为根 devDependency **精确版本**（不用 `^`），走 frozen lockfile，与 wrangler 4.111.0 现状同纪律。
