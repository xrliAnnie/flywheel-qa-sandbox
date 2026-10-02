# FLY-3138 安装包发布流水线 wrangler→cf — 实施计划
Issue: FLY-3138 (https://linear.app/geoforge3d/issue/FLY-3138/cloudflaref5挂起-安装包分发的发布流水线从-wrangler-改用-cf-触发条件cf-正式版发布)
日期: 2026-10-02
基于: research.md

**Version**: TBD（ship 时取空号）
**Status**: draft（挂起单：触发条件 = cf 正式版 GA）
**目标仓**: 生产 Flywheel（`payload-activation.yml` 只在生产 main，本沙箱无，见 exploration §1）

## 0. 目标与非目标

**目标**（= issue 验收 1–4）：
1. 发布流水线（`payload-activation.yml` infra 模式 + `ci.yml` 部署演练）全部改用 `cf`，含设密钥；仓库不再依赖 `wrangler` 包。
2. 手动 `workflow_dispatch`（mode=infra, confirm=ACTIVATE）一次完整演练成功。
3. CI 部署演练（credentialless dry-run + 打包证据）通过。
4. Worker 名 / R2 桶 / 绑定名 / 密钥名 / GitHub 凭据位置全部不变（exploration §3 清单）。

**非目标**：npm 发布（mode=publish 不碰 Cloudflare）；workers.dev 子域名与 manifest 初始化步骤（curl/fetch，与 CLI 无关）；`wrangler tail`（流水线不用）；改 Worker 代码行为；改 GitHub 环境/凭据。

## 1. 触发与「开工闸门」（挂起单的核心）

本单 **不得** 在下列全部成立前开工；runner 被派发时先跑 §2 核对表，任一项 ✗ 走 §5 分支，不硬做：

- G1 `npm view cf dist-tags.latest` 是 **非预发布** 版本（无 `-beta`/`-rc`），且 Cloudflare 有 GA 公告/changelog。
- G2 GA 版有「设单个 Worker 密钥」命令（支持 stdin 或等价不落盘方式）。
- G3 GA 版用 `cf migrate` 迁移后，`pnpm why wrangler` 为空（打包不再拉 wrangler 包）。

## 2. GA 当天核对表（spike，只读、不碰真账号，产出 `ga-verification.md`）

全部用 `cf --help` / `cf schema` / `cf … --dry-run` / 官方文档，**不登录**（凭据只在 GitHub `release` 环境）。每项写「命令原文 + 版本 + 出处」：

| # | 要确认 | 用于 |
|---|---|---|
| V1 | 建桶命令 + 「已存在」的退出码 / JSON 错误码 | A |
| V2 | 生命周期设置命令 + 是否吃现有 `r2-lifecycle.json` + 是否需 `--force` | B |
| V3 | 单密钥命令名、stdin 用法、作用 Worker 的指定方式（读 `cloudflare.config.ts` 还是 `--name`） | C/D/F/G |
| V4 | 列出密钥名命令（只列名不列值），用于读回 | C/D/F/G 读回 |
| V5 | `cf deploy` 的 JSON 输出里 workers.dev URL 与版本 ID 字段 | E |
| V6 | 部署时注入 `FW_R2_ACCOUNT_ID` 的方式（见 §3.2） | E |
| V7 | `cf deploy --dry-run` / `cf build` 的 Build Output 是否暴露模块清单 | CI 演练 |
| V8 | 非交互下 `Aborted.`/exit 0 规则是否仍在；哪些命令算「破坏性」 | 全部 |
| V9 | 遥测关闭变量名（`CF_SEND_TELEMETRY=false` / `DO_NOT_TRACK=1`） | 全部 |
| V10 | Node 最低版本 | `.node-version` |

## 3. 改动清单（按文件）

### 3.1 配置：`packages/payload-endpoint/wrangler.toml` → `cloudflare.config.ts`
- **本地** `cf migrate packages/payload-endpoint/wrangler.toml --dry-run` 看 follow-up，再真跑；生成文件 **人审后提交**，删除 `wrangler.toml`（以及若 G3 要求的 `wrangler.config.ts` —— 若打包器配置是必需产物且不拉 wrangler 包，则保留并在 PR 说明）。
- 必须逐字保持：`worker.name = "flywheel-onboard-endpoint"`、`entrypoint = "src/worker.mjs"`、`compatibilityDate = "2026-07-01"`、`PAYLOADS: bindings.r2({ name: "flywheel-payloads" })`（按 migrate 实际产物形状）、`FW_R2_BUCKET: bindings.text("flywheel-payloads")`。
- 密钥声明：用 `bindings.secret()` 声明 **CI 管的** 密钥名（若 GA 语义是「声明 = 部署时必须存在」，则不声明 `FW_OPS_ADMIN_TOKEN_SHA256` 与可缺省的 B4 名单，避免部署被缺省值卡住——以 V3/V4 实测为准，写进 ga-verification.md）。

### 3.2 部署变量 `FW_R2_ACCOUNT_ID`
首选（V6 若无 CLI 变量覆盖）：`cloudflare.config.ts` 里读 `process.env.CLOUDFLARE_ACCOUNT_ID`，**fail-closed**：仅在非 dry-run 构建时要求其匹配 `/^[a-f0-9]{32}$/`，否则抛错；dry-run（CI 无凭据）给占位常量并在 config 里注释。若 V6 有等价 `--var`，直接用 CLI 参数，config 不读环境。二者择一，PR 写明。

### 3.3 `.github/workflows/payload-activation.yml`（只改 infra 模式里的 CLI 调用，**步骤名、顺序、gate、环境、权限全不动**）
- job `env` 加 `CF_SEND_TELEMETRY: "false"`、`DO_NOT_TRACK: "1"`。
- **A 建桶**：换 V1 命令；resume 判定改为「退出码 + JSON 错误码 = 已存在」，**再** 用现有 curl API 读回桶存在。
- **B 生命周期**：`execFileSync('pnpm', ['exec','cf', …V2…])`；前后 API 读回校验保持原样（不依赖 CLI 输出）。
- **C/D/F/G 设密钥**：抽一个共享 helper `packages/payload-endpoint/src/cf-secret.mjs`：`putWorkerSecret(name, value, { execFileSync })` → `execFileSync('pnpm', ['exec','cf', …V3…], { input: value, stdio: ['pipe','pipe','pipe'] })`；四处调用都走它（单一事实来源，测试只断言一次 argv）。F/G 的 shell 管道改为 `node` 调 helper（与 C/D 同形）。每批写完调用 `listWorkerSecretNames()`（V4）断言 **本批名单 ⊆ 远端名单**——挡住 `Aborted.`/exit 0 假成功。
  - B4「缺省 = 保留远端」：名单为空时 **不调用** 任何 cf 命令（与现在一致）；不得出现「整版本替换密钥」的调用。
- **E 部署**：`pnpm exec cf deploy …（V5 JSON 输出）`，用 `jq`/node 从 JSON 取 URL，并断言 URL 匹配现有正则 `^https://flywheel-onboard-endpoint\.[a-zA-Z0-9-]+\.workers\.dev$`（Worker 名不变的机器证明）。工作目录 = `packages/payload-endpoint`（含 `cloudflare.config.ts`，防自动配置改文件）。
- 「Validate B2 deployment inputs」里读 wrangler.toml 的正则 → 改为 `import` 一个小模块 `packages/payload-endpoint/deploy-identity.mjs`（导出 `WORKER_NAME`、`BUCKET_NAME`），且 `cloudflare.config.ts` 也从它 import——**一处定义，校验步骤与配置共用**，替代「正则读配置文本」。
- 注释里所有 wrangler 字样更新（包括「wrangler comes from the REVIEWED lockfile」那段 → cf）。

### 3.4 `.github/workflows/ci.yml` 部署演练
- `pnpm exec cf deploy --dry-run`（工作目录 `packages/payload-endpoint`），env 加遥测关闭；删 `WRANGLER_LOG_PATH`。
- 打包证据：按 research §4 的顺序选 V7 方案 1（模块清单断言同三条），不行用方案 2（内容哨兵）。断言脚本保留「失败时打印实际 inputs」。
- 本 job **仍然零 `CLOUDFLARE*` 引用**。

### 3.5 依赖
- 根 `package.json`：删 `"wrangler": "4.111.0"`，加 `"cf": "<GA 精确版本>"`（不带 `^`）；`pnpm install` 更新 lockfile；`pnpm why wrangler` 为空（G3）。
- `.node-version`：若 V10 要求 >22 的小版本下限，钉到具体版本（如 `22.18.0` 或更高 LTS）；并检查其它 workflow/包 `engines` 不冲突。

### 3.6 测试 / lint
- `activation-config.test.mjs`：B4 argv 断言改为断言调用了 `cf-secret.mjs` helper，helper 自身有单测断言 argv = V3 原文 + `input` = 值 + 不出现在 argv（**密钥值绝不进 argv**）。保留「第一个失败就停、不授予控制」测试。
- 新增 `cf-secret.test.mjs`：①argv 不含值；②`listWorkerSecretNames` 缺名 → 抛错（假成功守卫）；③空名单零调用（B4 缺省保留远端）。
- `release-workflows-structure.test.sh` S4a 改形（research §5）：ci.yml 恰好 1 处 `pnpm exec cf deploy --dry-run` 且 0 处非 dry-run；**全部 workflow 0 处 `wrangler`**（负向守卫）；含 `pnpm exec cf ` 的 workflow 必须有 `CF_SEND_TELEMETRY`。对 lint 做变异自测：故意塞回一个 `wrangler` → 必须 FAIL。
- `contract-consistency.test.sh` 等若读 wrangler.toml → 改读 `deploy-identity.mjs`。
- 新增 `deploy-identity.test.mjs`：`WORKER_NAME === 'flywheel-onboard-endpoint'`、`BUCKET_NAME === 'flywheel-payloads'`，且 `cloudflare.config.ts` 引用的是它（文本断言 import）。

## 4. 验证与证据（对应验收）

| 验收 | 证据 |
|---|---|
| ① 不再需要 wrangler | `git grep -n wrangler -- .github package.json packages/payload-endpoint scripts` 只剩历史注释/文档或为零；`pnpm why wrangler` 空；S4a 负向守卫绿 |
| ② 手动完整演练 | merge 后创始人（或经授权）在 main 上 dispatch `mode=infra, confirm=ACTIVATE`；所有步骤绿，含每批密钥读回、URL 正则断言、manifest init（200 或 412+resume）。run URL 记进 PR |
| ③ CI 演练 | PR 上 ci.yml 部署演练 + S4a + 新单测全绿 |
| ④ 名字不变 | 演练后用 API 读回：Worker `flywheel-onboard-endpoint` 存在、绑定 `PAYLOADS`→`flywheel-payloads`、`secrets list` 名单 ⊇ 原名单 **且仍含 `FW_OPS_ADMIN_TOKEN_SHA256`**（证明迁移没抹掉 CI 外密钥） |

> ② 需要真实 Cloudflare 账号写操作，属于创始人授权范围：实施节点只准备 PR 与演练说明，不自行 dispatch；dispatch 由 Lead/创始人按现有 activation 规程决定。

## 5. 分支（GA 时某闸门不满足）

- **分支 A（G1 ✗：还没 GA）**：不做，保持挂起，回报 Lead「仍 beta.N」。
- **分支 B（G2 ✗：GA 仍无单密钥）**：不擅自改用 `--secrets-file`。先在 ga-verification.md 记录 `--secrets-file` 对「不在文件里的密钥（FW_OPS_ADMIN_TOKEN_SHA256）」是继承还是清空（只读文档/源码；若需真账号实测，由创始人决定），再 `ask` Lead 由创始人在「继续等 / 接受落盘+时序改动」中二选一。
- **分支 C（G3 ✗：仍拉 wrangler 包）**：试 `cf migrate --bundler vite`，CI 演练证明打包证据仍成立则继续；否则回报，验收 ① 无法满足前不 ship。

## 6. 实施顺序（单 PR，TDD）

1. 前置：在生产 main 最新 HEAD 重跑 exploration §2 审计（文件会变）；跑 §2 核对表 → `ga-verification.md`。
2. RED：先改测试/lint（S4a 负向守卫、cf-secret、deploy-identity）→ 跑出失败。
3. GREEN：`deploy-identity.mjs` → `cf migrate` 产物审核提交 → `cf-secret.mjs` → activation.yml → ci.yml → 依赖与 lockfile。
4. 本地：`pnpm install --frozen-lockfile`、payload-endpoint 全部测试、structure lint、`cf deploy --dry-run`（在 `packages/payload-endpoint`）。
5. PR（链接 FLY-3138 + FLY-3102 F5），Codex code review，等 ship 授权；merge 后按 §4 ② 演练。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| exit 0 假成功（`Aborted.`） | 每个写步骤 API/CLI 读回，不信退出码 |
| CI 里自动配置偷改文件 | 所有 cf 调用在含 `cloudflare.config.ts` 的目录；dry-run 后 `git diff --exit-code` 断言工作树未变 |
| 密钥值泄露到 argv/日志 | 只走 stdin；helper 单测断言；保留 `set +x` |
| 抹掉 CI 外密钥 | 禁止整版本密钥替换；演练后读回含 `FW_OPS_ADMIN_TOKEN_SHA256` |
| GA 后命令仍小改 | cf 精确版本钉死 + frozen lockfile；升级 cf 走独立 PR |
| 挂起期生产 workflow 已变 | §6 第 1 步重审计 |
