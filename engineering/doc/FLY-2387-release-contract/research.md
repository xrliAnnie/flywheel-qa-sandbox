# FLY-2387 先锁合同:版本/channel/manifest — 调研

Issue: FLY-2387 (https://linear.app/geoforge3d/issue/FLY-2387/1143b0-先锁合同版本channelmanifestprd-1098-6-规范化版本-72-通道单一真相-73-发布不变量)
日期: 2026-09-06
基于: exploration.md

> 目的:把 exploration 选定的方案 B(零依赖合同包 + 跨语言向量 + JSON Schema)所依赖的每个技术事实核实一遍,并把 G1–G9 每个缺口落到具体文件行。全部在本 worktree 实测,不是转述。

---

## 1. 版本语法:权威定义与现状分歧(G1 / G7)

**权威**:semver 2.0.0 规定数字标识符 `0 | [1-9]\d*`(禁前导零);预发布标识符点分,数字标识符同样禁前导零。PRD §6 只允许两种形状:`X.Y.Z` 与 `X.Y.Z-beta.N`;ledger `nextBetaN ≥ 1`(validator 不变量 4 已断言)⇒ `N ≥ 1`。

**现状实测(2026-09-06,本 worktree)**:

| 输入 | `manifest.mjs isPayloadSemver` | bash `po_version_is_derivation 1.56.0 <v>` | 合同应判 |
|---|---|---|---|
| `1.56.0-beta.0` | true | ok | **拒**(ledger 永不产出 N=0) |
| `1.56.0-beta.01` | true | ok | **拒**(与 `beta.1` 字节不同、语义相同 → 版本归因分裂) |
| `01.2.3` | true | (base 由 doc/VERSION 给,不校验) | **拒** |
| `1.56.0-rc.1` | false | rejected | 拒 ✓ |
| `v1.56.0` | false | (po_version 已去 v) | manifest 层拒 ✓;文件层允许 |
| base=`1.56.0-rc`, ver 同 | — | **accepted**(`$ver = $base` 短路) | **拒**:base 自身必须是 clean |

三份实现:`scripts/package-onboard.sh:175-181`(bash)、`packages/payload-endpoint/src/manifest.mjs:25-43`、`scripts/release/lib/endpoint-client.mjs:161-163`(`baseOf` 只做 `replace(/-beta\.\d+$/, "")`,对非法输入静默返回原串)。没有任何测试同时喂三者同一组输入。

**结论**:合同定义正则 `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$` 与 `…-beta\.(?:[1-9]\d*)$`;`doc/VERSION` 规范化 = 去空白、去一个前导 `v`、然后**必须**匹配 clean 正则(G7)。三份实现改为:mjs 两份 import 合同包;bash 保留自己的实现但由共享向量文件 `vectors/version-derivation.json` 锁(bash 测试用 `jq` 逐条读向量,`jq` 已是打包测试的既有依赖)。

## 2. JSON Schema 工具链(G4)

- 仓库没有 manifest 的机器可读 schema;`validator.mjs` 是手写关系不变量(299 行),**应保留为关系层权威**(形状层 schema 表达不了「latest 指向 active entry」这类跨字段约束,强行用 `if/then` 只会写出第二份更难读的验证器)。
- 形状层用 **JSON Schema draft 2020-12**。校验器选 `ajv@8.17.1`:已在 `pnpm-lock.yaml`(传递依赖,6 处引用),作为新包的 devDependency 零新增下载面;用法 `import Ajv2020 from "ajv/dist/2020.js"`,`strict: true, allErrors: true`。**只在测试里用**,合同包运行时依旧零依赖(Worker 打包不会带 ajv)。
- schema 要点:`additionalProperties: false` 全开;`versions`/`releaseOps`/`releaseLedger` 用 `propertyNames.pattern` 锁 key 语法(payload semver / 非空 id / clean base);`channels` 用 `required + additionalProperties:false` 锁恰好两个通道;所有 hex 字段 `pattern: ^[0-9a-f]{64}$` / `{40}`;时间戳 `format: date-time` 不启用(ajv strict 下需 ajv-formats,且 `isIso` 已在关系层做严格等价校验),形状层只锁 `type: string`。
- 客户视图 `manifest-view.schema.json`:`{latest: string, versions: [{ver, sha256}]}`,`additionalProperties: false` —— 这是 PR2 客户端字节合同,`packages/onboard-shell/lib/endpoint.mjs:52-72` 的手写校验就是它的消费者,B5 不得扩字段(扩就要开 schemaVersion 或新路由)。

## 3. 合同包放置与消费者链路(方案 B 可行性)

| 消费者 | 语言/解析 | 接入方式 | 实测依据 |
|---|---|---|---|
| `packages/payload-endpoint`(Worker) | ESM `.mjs`,wrangler 4.111.0 (esbuild) 打包 | `"flywheel-release-contract": "workspace:*"`;`manifest.mjs` 改为重导出 | `payload-activation.yml:114` 先 `pnpm install --frozen-lockfile` 再 `:167 wrangler deploy --config …`;pnpm 会在 `packages/payload-endpoint/node_modules/` 建符号链接,esbuild 按 node 解析规则可达。**保险**:plan 加一条 hermetic 测试 `wrangler deploy --dry-run --outdir <tmp>` 证明打包产物含合同代码且零凭据需求 |
| `scripts/release/*.mjs`(CI 脚本) | node ESM,从 repo root 运行 | 相对 import `../../packages/release-contract/src/index.mjs`(脚本不是包,不能声明 workspace 依赖) | `payload-release.mjs` 已用相对 import `./lib/endpoint-client.mjs` |
| B3/B4(Bridge,`packages/teamlead` 等 TS) | `moduleResolution: node`(teamlead)/ `NodeNext`(edge-worker) | workspace 依赖 + 包内 `"main": "src/index.mjs"`, `"types": "index.d.ts"`, `"type": "module"`;不写 `exports` map(classic `node` 解析不认) | 两种解析都能命中 `main`+`types` |
| `scripts/package-onboard.sh`(bash,打包环境可能无 node_modules) | bash | **不 import**;共享向量文件锁一致 | `package-onboard-version-injection.test.sh` 已是 bash + jq 形态 |
| `packages/onboard-shell`(发布到 npm 的薄壳,必须零依赖、字节稳定) | ESM | **不 import**;由 `manifest-view.schema.json` + 现有 `contract-consistency.test.sh` 锁 | PR2 合同「byte-stable」是 FLY-1062 红线 |
| `.github/workflows/payload-activation.yml:210` | YAML 内联 JS | 改调 `emptyManifest()` | 内联对象与 `manifest.mjs emptyManifest()` 是第二份空 manifest 定义 |

**`payload-endpoint` 「零 flywheel-* 依赖」原则的放宽**:原则的目的是「Worker 不拖 monorepo 大包、hermetic 可测」;合同包零运行时依赖、纯函数、同为 `node --test`,满足原目的。plan 明写为一条有意的放宽并加打包 dry-run 断言。

## 4. G6:paused 态在现有状态机里的落点

- `transitions.mjs:59-70` 把任何 `latest` 变化归类为 `pointer` op(`to` 可为 null),`capabilityAllows` 按通道分配能力(`customer-release` 通道 → `customer-release` 能力)—— **状态机层已经能表达指针置 null**,拦住它的只有 `validator.mjs:119-125` 不变量 1 的「null 但该 channel 存在 entry」检查(`any` 不看 status)。
- 服务端盖章(`transitions.mjs:209-231`)对离开 latest 的 entry 盖 `retentionSince=now`;quarantined 的钟用 `quarantinedAt` —— 指针置 null 后的历史 entry 计时逻辑无需改。
- 视图层 `views.mjs:23-25` latest null → `{empty:true}` → `handler.mjs:146-147` 503 `{error:"not activated"}`。paused 与 never-activated 服务端可区分(前者该 channel 有非 active entry),合同定为同 503 状态码、body `error` 字段取值不同(`not activated` / `no-release-available`),**客户端行为不变**(`endpoint.mjs:43` 非 2xx 一律 `network` 类错误)。客户可见话术映射 = B5。
- `license-key.mjs:74-99` 签发前置检查「目标 entitlement 指针非 null」→ paused 期间自动拒发新 key,符合 PRD §8.2「新安装收到诚实可重试错误」的服务端半边。
- 需改的测试:`validator.test.mjs:13-20`「null latest with entries present → violation (both directions)」要改成「null 但存在 **active** entry → violation;只剩 quarantined/expired → 合法」。
- 现有 `withdraw --fallback` 原语不动;**withdraw-without-fallback(进 paused)= B5 新增 CLI 路径**,B0 只让合同与 validator 允许它。

## 5. §6.2 身份派生的数据来源(G5)

| 身份 | 字段 | 来源(全部 manifest 内) |
|---|---|---|
| `BetaCandidate` | `baseVersion, betaN, betaVersion, sourceCommit, betaPayloadSha256` | `versions[betaVersion]`(要求 `channel=beta ∧ status=active`;quarantined/expired 的 beta 不能成为候选 → 派生函数抛错,B4 据此判 `hold`) |
| `ReleaseArtifact` | `releaseId, releaseVersion, sourceCommit, releasePayloadSha256, objectKey` | `releaseOps[releaseId]`(要求 `kind=release ∧ state=prepared`,tuple 三字段非 null) |
| `VetoBinding` | `releaseId, candidateVersion(=releaseVersion), sourceCommit, releasePayloadSha256` + `derivedFromBeta` | 上两者 join,并断言 `op.betaVersion` 的 entry 存在且 `sourceCommit` 逐字相等(lineage) |

`payload-promote.mjs commit` 已要求 `--expected-sha256` 且零构建(`:338-376`),即 B4 只需把 `VetoBinding.releasePayloadSha256` 原样传入 —— **不需要 manifest 新字段**。B4 的决策记录(who/when/触发方式,PRD §5.4)存 Bridge 侧账本,键 = `releaseId`,内容含 binding 三元组;不镜像进 manifest(避免第二本账)。

## 6. 通道名与 dist-tag(G3 / G8)

- 通道名字面量出现在非测试代码 8 处(`manifest.mjs`、`validator.mjs`、`transitions.mjs`、`views.mjs`、`handler.mjs`、`payload-release.mjs`、`payload-promote.mjs`、`license-key.mjs`)+ workflow 注释与 `payload-activation.yml:210` 内联对象。合同包导出 `CHANNELS`、`CHANNEL_OF_POINTER`、`ENTITLEMENT_POINTER`、`POINTER_CAPABILITY`(通道 → 允许切它的能力,`transitions.mjs:267-270` 现为 if/else 硬编码),消费者改 import;结构 lint 只扫 `packages/payload-endpoint/src`、`scripts/release`(含 lib)两处的 **非注释行**字面量,workflow 注释不扫。
- npm dist-tag:`payload-activation.yml:268-273` `npm publish --access public` 无 `--tag` ⇒ npm 默认打 `latest`。合同写死:薄壳发布 = `latest`;`next` 仅供薄壳自身预发布(版本带预发布后缀时 **必须** `--tag next`,否则 npm 会把预发布版打成 latest);dist-tag 永不表达 payload 通道。实现(preflight 断言「预发布版本 ⇒ --tag next」)= B1。

## 7. REQ-0 机器层证据(G9)

- 三个 payload workflow 触发器:`schedule + workflow_dispatch`(beta)、`workflow_dispatch`(promote / activation);**没有** `push`/`pull_request` 触发,merge 不会连带发布 payload。
- `scripts/release/`、`packages/payload-endpoint/src`、payload workflows 中零 `cool`/`verify-approval`/`evaluateShipEligibility` 引用(grep 实测)⇒ release 路径不读 ship 账本。
- `release-workflows-structure.test.sh` S4b:`FW_CUSTOMER_RELEASE_TOKEN` 在零个 workflow。B0 合同把「promote commit 的授权输入 = `{releaseId, expectedSha256}`,授权源 = B4 否决窗口沉默或 founder 显式 go」写死;B1 落 commit 路径时重谈 S4b 的形态(FLY-1323 §4「每运行现 mint」姿态下,commit 的能力 token 也是现 mint),B0 不动 S4b。
- FLY-1323 把「merge 到 main」定为**薄壳 publish 与 beta** 的授权闸;它没有(也不应)把 `customer-release` 切换绑到 merge —— 与 PRD §2.3「release 授权源不是 🆒、不是 ship 账本」一致。REQ-0 表据此填写,不重写 FLY-1063/FLY-1323。

## 8. CI 接线事实

- 新 node 测试:`ci.yml:1228` 的 payload-distribution job 已用 `node --test packages/payload-endpoint/__tests__/*.test.mjs`,同 step 追加 `packages/release-contract/__tests__/*.test.mjs`。
- 新 bash 向量测试放 `scripts/__tests__/release-contract-vectors.test.sh`,**必须**在 `ci.yml` 字面枚举(`ci-shell-suite-enumeration.test.sh` 会因未枚举而红)。
- biome 覆盖 `.mjs`(`biome.json includes`),新包按现有 tab 缩进风格。

## 9. 风险与回滚边界

| 风险 | 缓解 |
|---|---|
| 收紧语法后,已存在的 manifest 里若有 `beta.0`/前导零 entry 会被新 validator 拒 → 端点写路径全部 412/400 | 实测生产 manifest 为空(FLY-1323 中间态);plan 加「启动前用 schema + validator 跑一次生产 manifest 快照」的 B1 激活前置项;回滚 = 还原合同包版本,manifest 字节不动 |
| wrangler 打包找不到 workspace 依赖 | dry-run 打包测试进 CI;失败即红,不会到 deploy |
| 三份实现改 import 后行为漂移 | 现有 6 套 hermetic 套件(validator/lifecycle/pipeline/contract-consistency/version-injection/e2e)全部保留并必须继续绿;本单不改任何断言语义,只加 |
| 结构 lint 误伤注释 | 只扫非注释行,白名单文件 = 合同包本身 |
