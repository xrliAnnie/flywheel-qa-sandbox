# FLY-3138 安装包发布流水线 wrangler→cf — 实施计划
Issue: FLY-3138 (https://linear.app/geoforge3d/issue/FLY-3138/cloudflaref5挂起-安装包分发的发布流水线从-wrangler-改用-cf-触发条件cf-正式版发布)
日期: 2026-10-02
基于: research.md

**Version**: TBD（ship 时取空号）
**Status**: draft r2（挂起单：触发条件 = cf 正式版 GA）
**目标仓**: 生产 Flywheel（`payload-activation.yml` 只在生产 main，本沙箱无，见 exploration §1；审计基线 = 生产 `origin/main` `2abffd1e6`）

## 0. 目标与非目标

**目标**（= issue 验收 1–4）：
1. 发布流水线（`payload-activation.yml` infra 模式 + `ci.yml` 部署演练）全部改用 `cf`，含设密钥；整个 workspace 不再依赖 `wrangler` 包。
2. 手动 `workflow_dispatch`（mode=infra, confirm=ACTIVATE）一次完整演练成功。
3. CI 部署演练（credentialless dry-run + 三项打包证据）通过。
4. Worker 名 / R2 桶 / 绑定名 / signer 文本绑定 / 密钥名 / GitHub 凭据位置全部不变（exploration §3 清单）。

**非目标**：npm 发布（mode=publish 不碰 Cloudflare）；workers.dev 子域名与 manifest 初始化步骤（curl/fetch，与 CLI 无关）；`wrangler tail`（流水线不用）；改 Worker 代码行为；改 GitHub 环境/凭据。

## 1. 触发与「开工闸门」（挂起单的核心）

本单 **不得** 在下列全部成立前做任何真实写入；runner 被派发时先跑 §2 核对表，任一项 ✗ 走 §5 分支，不硬做：

- **G1 GA**：`npm view cf dist-tags.latest` 是非预发布版本（无 `-beta`/`-rc`），且 Cloudflare 有 GA 公告/changelog。
- **G2 单密钥写入 + 可靠成功回执**：GA 版有「设单个 Worker 密钥」命令，值走 stdin（或等价不落盘方式），**且** 该命令的输出能可靠区分「已写入」与「取消/跳过」（V3/V8）。只有「exit 0 + 名字存在」不算满足。
- **G3 无 wrangler 包**：迁移后 `pnpm why -r wrangler` 为空且 `pnpm-lock.yaml` 中无 `wrangler@` 条目（整个 workspace，不只根）。
- **G4 部署保留未声明密钥**：有官方文档或 **钉定 GA 版本的源码** 证据表明：普通 `cf deploy` 上传新版本时，远端已有但配置未声明的密钥（`FW_OPS_ADMIN_TOKEN_SHA256`、缺省时的 B4 名单）**原值继承**。证据写进 `ga-verification.md`（链接 + 源码行号）。无法确认 → 保持挂起，或经现有授权流程决定是否在 **隔离的临时 Worker** 上实测；不得在生产 Worker 上「部署后才发现」。
- **G5 账号变量可安全注入**：V6 证明部署账号 ID 能以 §3.2 的方式进入 `FW_R2_ACCOUNT_ID`，且 credentialless dry-run 不需要真实账号也不需要「判断是否 dry-run」。

## 2. GA 当天核对表（spike，只读、不碰真账号，产出 `ga-verification.md`）

全部用 `cf --help` / `cf schema` / `cf … --dry-run` / 官方文档 / 钉定版本的 npm 包源码，**不登录**（凭据只在 GitHub `release` 环境）。每项写「命令原文 + 版本 + 出处」：

| # | 要确认 | 用于 |
|---|---|---|
| V1 | 建桶命令 + 「已存在」的退出码 / JSON 错误码 | A |
| V2 | 生命周期设置命令 + 是否吃现有 `r2-lifecycle.json` + 是否需 `--force` | B |
| V3 | 单密钥命令名、stdin 用法、作用 Worker 的指定方式；**成功回执的确切形状**（JSON 字段 / 文本） | C/D/F/G |
| V4 | 列出密钥名命令（只列名不列值） | 存在性补充读回 |
| V5 | `cf deploy` 成功回执：workers.dev URL、version ID、deployment ID 字段；查询「当前活动部署及其版本」的命令；幂等 no-op 时的回执形状 | E |
| V6 | 配置求值时能否读 `process.env`；是否有 CLI 级变量覆盖 | §3.2 / G5 |
| V7 | `cf build` / `cf deploy --dry-run` 的 Build Output：是否含求值后的配置（name/entry/compat/bindings）与模块清单 | 身份校验 + 打包证据 |
| V8 | 非交互下哪些命令算「破坏性」、`Aborted.`/exit 0 规则是否仍在、`--force` 语义；单密钥写入是否属于此类 | 全部写步骤 |
| V9 | 遥测关闭变量名（`CF_SEND_TELEMETRY=false` / `DO_NOT_TRACK=1`） | 全部 |
| V10 | Node 最低版本 | `.node-version` |
| V11 | （G4）普通 deploy 对「未声明但已存在」密钥的继承语义；`bindings.secret()` 声明是否让「密钥不存在」成为部署前置条件 | §3.1 密钥声明 |

## 3. 改动清单（按文件）

### 3.1 配置：`packages/payload-endpoint/wrangler.toml` → `cloudflare.config.ts`
- **本地** `cf migrate packages/payload-endpoint/wrangler.toml --dry-run` 看 follow-up，再真跑；生成文件 **人审后提交**，删除 `wrangler.toml`。打包器配置文件（`wrangler.config.ts` 或 Vite 路径的 `vite.config.ts`）按 G3 结论保留并在 PR 说明。
- 必须保持：`worker.name = "flywheel-onboard-endpoint"`、`entrypoint = "src/worker.mjs"`、`compatibilityDate = "2026-07-01"`、`PAYLOADS` → R2 `flywheel-payloads`、`FW_R2_BUCKET` 文本 = `flywheel-payloads`。名字常量放在 `packages/payload-endpoint/deploy-identity.mjs`（`WORKER_NAME`、`BUCKET_NAME`）供配置 import——**但校验永远针对求值后的配置 / Build Output，不针对常量**（见 §3.6）。
- **密钥声明（避免部署前置循环）**：默认 **不** 用 `bindings.secret()` 声明任何密钥。理由：F/G 两个 hash 在 E 部署 **之后** 才写（首次激活 / 缺失恢复时尚不存在），ops-admin 与 B4 可缺省。若 V11 表明「不声明 = 部署时被清掉」，则 G4 不满足 → 挂起（§5 分支 D），**不** 用「声明一部分」去凑。

### 3.2 部署变量 `FW_R2_ACCOUNT_ID`（无需判断 dry-run）
- `cloudflare.config.ts` **永远严格**：读 `process.env.FW_R2_ACCOUNT_ID`，要求匹配 `/^[a-f0-9]{32}$/`，否则抛错；**没有占位默认值，也不尝试判断本次是不是 dry-run**。
- CI 演练（ci.yml）：步骤 env 设 `FW_R2_ACCOUNT_ID: "00000000000000000000000000000000"`（全零哨兵，注释说明「仅供无凭据打包」）。不引入任何 `CLOUDFLARE*` 名字，S4a 不受影响。
- activation E 步骤：env `FW_R2_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}`；部署前守卫：值 == `CLOUDFLARE_ACCOUNT_ID`、匹配 32 hex、**≠ 全零哨兵**，否则拒绝部署。部署后读回（§3.3 E）确认远端 `FW_R2_ACCOUNT_ID` 文本绑定 == 账号 ID。
- 若 V6 有官方 CLI 变量覆盖，也可用它，但「配置严格 + 全零哨兵仅在 CI + 部署前拒绝哨兵」三条不变。V6 两种方式都不可行 → G5 ✗ → 挂起。

### 3.3 `.github/workflows/payload-activation.yml`（只改 infra 模式里的 CLI 调用，**步骤名、顺序、gate、环境、权限、并发组全不动**）
- job `env` 加 `CF_SEND_TELEMETRY: "false"`、`DO_NOT_TRACK: "1"`。
- **A 建桶**：换 V1 命令；resume 判定 = 「JSON 错误码 = 已存在」，不再 grep 英文文本；之后用现有 curl API 读回桶存在。
- **B 生命周期**：`execFileSync('pnpm', ['exec','cf', …V2…])`；前后 API 读回校验保持原样。
- **C/D/F/G 设密钥** —— 共享 helper `packages/payload-endpoint/src/cf-secret.mjs`，四处都走它（F/G 的 shell 管道改为 node 调 helper，与 C/D 同形）：
  - `putWorkerSecret(name, value, { execFileSync })`：`execFileSync('pnpm', ['exec','cf', …V3…], { input: value, stdio: ['pipe','pipe','pipe'] })`；**解析 V3 定义的成功回执**，回执缺失 / 含取消标记（如 `Aborted.`）/ 无法解析 / 名字不符 → **立即抛错**。调用方是现有循环，抛错即停：下一个密钥 **不会** 被写入（保持 `release-deployment.mjs` 「先收紧 decision policy、再授予 capability/control」的顺序语义与 `activation-config.test.mjs` 「首个失败即停」）。
  - 错误信息只含密钥 **名** 与通用原因，**不** 透传 child-process 的 stdout/stderr（可能回显敏感内容），保留 `set +x`。
  - 每批写完再 `listWorkerSecretNames()`（V4）做 **存在性补充**：本批名单 ⊆ 远端名单。它不是成功证据，只是二次防线。
  - B4「缺省 = 保留远端」：名单为空时 **零** cf 调用（与现在一致）；不得出现任何整版本密钥替换调用（禁用 `--secrets-file`）。
  - 现有功能性证明保留：F（beta hash）之后的 manifest init 用 beta token 打 `/admin/manifest`，401 即失败——这是 beta hash 值正确的端到端证据。
- **E 部署**：工作目录 `packages/payload-endpoint`（含 `cloudflare.config.ts`，防自动配置改文件）；`pnpm exec cf deploy …`，解析 V5 回执：
  1. 回执必须含 version ID + deployment ID（缺 / 取消 → 失败）；
  2. 用 V5 的「查询活动部署」命令读回：活动部署指向该 version；幂等 no-op 时按 V5 定义证明「活动版本 == 目标构建」，**不** 要求 ID 必变；
  3. URL 从回执 JSON 取，并匹配现有正则 `^https://flywheel-onboard-endpoint\.[a-zA-Z0-9-]+\.workers\.dev$`；
  4. **部署前**（E 内、cf deploy 之前）记录远端密钥名单 + 当前活动 version ID；**部署后立即**（F/G 之前）读回名单，断言部署前名单 ⊆ 部署后名单（含 `FW_OPS_ADMIN_TOKEN_SHA256`，若部署前存在）。这是 G4 的运行时二次防线；值继承本身由 G4 的文档/源码证据保证，名字比对不冒充它。
  5. 读回 Worker 设置：`PAYLOADS` → `flywheel-payloads`、`FW_R2_BUCKET` 文本 == `flywheel-payloads`、`FW_R2_ACCOUNT_ID` 文本 == 账号 ID。
- 「Validate B2 deployment inputs」：原来用正则读 wrangler.toml 文本；改为读 **求值后的配置**（V7：Build Output 中的配置，或 `cf build` 产物）断言 `bucket_name` 与 `FW_R2_BUCKET` 都 == `flywheel-payloads`。保留现有「配置里两者不一致 → 拒绝」负向用例。若 V7 Build Output 不含配置，则在步骤里 `import` 并求值 `cloudflare.config.ts`（经 cf 提供的加载器，V7 定），不得退化为比较常量。
- 注释里所有 wrangler 字样更新（含「wrangler comes from the REVIEWED lockfile」段）。

### 3.4 `.github/workflows/ci.yml` 部署演练
- `pnpm exec cf deploy --dry-run`（工作目录 `packages/payload-endpoint`），env：遥测关闭 + `FW_R2_ACCOUNT_ID` 全零哨兵；删 `WRANGLER_LOG_PATH`。dry-run 后 `git diff --exit-code` 断言工作树未被自动配置改动。
- **打包证据（三项都要，绑定本次 Build Output）**：
  - 方案 1（首选）：Build Output 模块清单 / sourcemap sources 含 `aws4fetch`、`payload-endpoint/src/presign.mjs`、`release-contract/src/`——与现 metafile 断言同三条。
  - 方案 2（降级）：三项各一个内容识别——`aws4fetch` 用其实现内部稳定标识（GA 时从钉定版本源码选，如 `AwsV4Signer` 类）、presign 与 release-contract 各用稳定导出名；**加** 断言产物模块中 **没有 bare specifier 的 import**（只允许相对路径 / 产物内模块），证明依赖已闭合打包而非外置。
  - 断言失败时打印实际清单。两方案都不成立 → §5 分支 C 的「不 ship」。
- 同时用同一份 Build Output 做 §3.6 的身份断言（求值后配置）。
- 本 job **仍然零 `CLOUDFLARE*` 引用**。

### 3.5 依赖
- 根 `package.json`：删 `"wrangler": "4.111.0"`，加 `"cf": "<GA 精确版本>"`（不带 `^`）；Vite 路径（分支 C）时连同 GA 验证过的 Vite 及插件精确版本、`vite.config.ts` 一起加；`pnpm install` 更新 lockfile；G3 用 `pnpm why -r wrangler` + lockfile grep 证明。
- `.node-version`：若 V10 要求 >22 的小版本下限，钉到具体版本；`packages/payload-endpoint` 的 `engines` (`>=20`) 不需动（Worker 代码不跑在 Node 上），但若 cf 作为根依赖要求更高 engines，按 V10 结论同步。

### 3.6 测试 / lint（TDD：先写这些）
- **`cf-secret.test.mjs`（新）**：
  1. argv == V3 原文且 **不含值**；值只在 `options.input`；
  2. 回执为 `Aborted.` + exit 0，**即使远端名单已含该名** → 抛错；
  3. 回执为空 / 不可解析 → 抛错；错误信息不含子进程原始输出；
  4. 正常回执 → 通过；
  5. `listWorkerSecretNames` 缺名 → 抛错；
  6. 空名单 → 零调用。
- **`activation-config.test.mjs`**：B4 断言改为调用 helper（不再逐字断言 wrangler argv）；新增「B4 第一个 put 返回 `Aborted.`/0 → 只调用 1 次即停、后续 capability 未写」；保留「首个失败即停」与「缺省零写入」；B2 校验步骤保留「配置 bucket 与 FW_R2_BUCKET 不一致 → 拒绝」并新增变异「保留 identity import、但实际 `FW_R2_BUCKET` 改成 `other` → 拒绝」。
- **E 部署合同测试（新，离线 mock execFileSync/fetch）**：合法旧 URL + 缺 version ID 的回执 → 失败；回执 OK 但活动部署指向别的 version → 失败；部署后名单少了部署前存在的 `FW_OPS_ADMIN_TOKEN_SHA256` → 失败（不进入 F/G）；`FW_R2_ACCOUNT_ID` 为全零哨兵 / 与账号不符 → 部署前拒绝。
- **配置测试（新）**：`FW_R2_ACCOUNT_ID` 缺失 / 非法 → 求值抛错；合法值 → 准确进入 `FW_R2_ACCOUNT_ID` 文本绑定；求值后 name/entry/compat/`PAYLOADS`/`FW_R2_BUCKET` 等于 exploration §3 清单。
- **打包证据变异测试**：对一个夹具 Build Output 删除 aws4fetch 实现 / 改成 bare import 但保留两个本地标识 → 断言脚本必须失败。
- **`release-workflows-structure.test.sh` S4a 改形**（research §5）：ci.yml 恰好 1 处 `pnpm exec cf deploy --dry-run` 且 0 处非 dry-run 的 `cf deploy`；**全部 workflow 0 处 `wrangler`**（负向守卫）；含 `pnpm exec cf ` 的 workflow 必须设 `CF_SEND_TELEMETRY`；任何 workflow 出现 `--secrets-file` → FAIL。变异自测：塞回一个 `wrangler` → 必须 FAIL。
- （核对过：生产 `contract-consistency.test.sh` 不引用 wrangler/配置，不改。）

## 4. 验证与证据（对应验收）

| 验收 | 证据 |
|---|---|
| ① 不再需要 wrangler | `pnpm why -r wrangler` 空 + lockfile 无 `wrangler@`；`git grep -n wrangler -- .github package.json packages scripts` 只剩历史文档或为零；S4a 负向守卫绿 |
| ② 手动完整演练 | merge 后经授权在 main 上 dispatch `mode=infra, confirm=ACTIVATE`；全部步骤绿：每个密钥成功回执、部署回执 + 活动版本读回、部署前后密钥名单比对、manifest init（200 或 412+resume）。run URL 记进 PR |
| ③ CI 演练 | PR 上 ci.yml 部署演练（三项打包证据 + 求值配置身份断言 + 工作树未改）+ S4a + 新单测全绿 |
| ④ 名字不变 | 演练 E 步骤内读回：Worker `flywheel-onboard-endpoint`、`PAYLOADS`→`flywheel-payloads`、`FW_R2_BUCKET`/`FW_R2_ACCOUNT_ID` 文本绑定、密钥名单 ⊇ 部署前名单（含 `FW_OPS_ADMIN_TOKEN_SHA256`）；值继承由 G4 证据保证 |

> ② 需要真实 Cloudflare 账号写操作，属于创始人授权范围：实施节点只准备 PR 与演练说明，不自行 dispatch；dispatch 由 Lead/创始人按现有 activation 规程决定。

## 5. 分支（GA 时某闸门不满足）

- **分支 A（G1 ✗：还没 GA）**：不做，保持挂起，回报 Lead「仍 beta.N」。
- **分支 B（G2 ✗：GA 无单密钥命令，或其回执无法区分写入/跳过）**：不擅自改用 `--secrets-file`，不接受「exit 0 + 名字存在」。在 ga-verification.md 记录现状与 `--secrets-file` 的继承/落盘问题，`ask` Lead，由创始人在「继续等 / 接受落盘+时序改动（另起设计）」中二选一。
- **分支 C（G3 ✗：仍拉 wrangler 包）**：试 `cf migrate --bundler vite`（GA 时核对它是否自装 Vite / 生成 `vite.config.ts`，按结果补依赖与配置）；CI 演练三项打包证据成立则继续；否则回报，验收 ① 无法满足前不 ship。
- **分支 D（G4 ✗：无法证明 deploy 保留未声明密钥 / 声明会制造部署前置循环）**：保持挂起，回报 Lead；可选项（由创始人/授权流程定）：在隔离临时 Worker 上实测继承语义，不碰生产 Worker、不把 ops-admin 原值引入 CI。
- **分支 E（G5 ✗：账号变量无法安全注入）**：保持挂起，回报 Lead。

## 6. 实施顺序（单 PR，TDD）

1. 前置：在生产 main 最新 HEAD 重跑 exploration §2 审计（文件会变）；跑 §2 核对表 → `ga-verification.md`；判 G1–G5，任一 ✗ 走 §5。
2. RED：先写/改 §3.6 全部测试与 lint → 跑出失败。
3. GREEN：`deploy-identity.mjs` → `cf migrate` 产物审核提交（含 §3.2 严格账号读取）→ `cf-secret.mjs` → activation.yml（A/B/C/D/E/F/G + B2 校验）→ ci.yml → 依赖与 lockfile。
4. 本地：`pnpm install --frozen-lockfile`、payload-endpoint 全部测试、structure lint、`cf deploy --dry-run`（在 `packages/payload-endpoint`，带全零哨兵）+ 打包证据脚本 + `git diff --exit-code`。
5. PR（链接 FLY-3138 + FLY-3102 F5），Codex code review，等 ship 授权；merge 后按 §4 ② 演练。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| exit 0 假成功（`Aborted.`），含「旧名已存在」场景 | G2 要求可靠成功回执；helper 逐个解析回执、失败即停；名单读回仅作补充 |
| 普通 deploy 抹掉 CI 外密钥 | G4 前置证据（文档/源码）+ 部署前后名单比对（F/G 之前）；不声明密钥避免前置循环；禁用 `--secrets-file` |
| 部署假成功 / URL 不变掩盖失败 | 回执 version/deployment ID + 活动部署读回 |
| 身份漂移（配置改错但常量正确） | 校验求值后配置 / Build Output + 远端设置读回，含 signer 文本绑定 |
| 占位账号进入真实部署 | 配置无默认值；全零哨兵只在 CI；activation 部署前拒绝哨兵 |
| 打包漏依赖 / 外置 | 三项证据 + 无 bare import 断言 + 变异测试 |
| CI 里自动配置偷改文件 | 所有 cf 调用在含 `cloudflare.config.ts` 的目录；dry-run 后 `git diff --exit-code` |
| 密钥值泄露到 argv/日志 | 只走 stdin；错误不透传子进程输出；helper 单测断言；保留 `set +x` |
| GA 后命令仍小改 | cf 精确版本钉死 + frozen lockfile；升级 cf 走独立 PR |
| 挂起期生产 workflow 已变 | §6 第 1 步重审计 |
