# FLY-2387 先锁合同:版本/channel/manifest — 探索

Issue: FLY-2387 (https://linear.app/geoforge3d/issue/FLY-2387/1143b0-先锁合同版本channelmanifestprd-1098-6-规范化版本-72-通道单一真相-73-发布不变量)
日期: 2026-09-06
基于: 无(上游 = `product/doc/FLY-1098-release-cicd/prd.md` §6 / §7.2 / §7.3 / §14;`engineering/doc/FLY-1062-npm-distribution/pr3-pr4-plan.md` §0 B0-1…B0-10;`engineering/doc/FLY-1323-npm-distribution-activation/ci-activation-design.md`)

> **一句话**:B0 要锁的合同**大半已经是运行中的代码**(FLY-1062 PR3/PR4 + FLY-1323,全部 merged、CI 强制)。本单不是从零定合同,而是把散在 bash / 两份 mjs / 一份 54KB plan 里的合同**收成一个可被 B1–B5 单独依赖的真相源**:一份合同文档 + 一个零依赖合同包(语法 + 身份派生 + JSON Schema + 跨语言测试向量)+ 断言测试,并补上审计发现的 6 个缺口。**不做任何发布动作。**

---

## 1. 审计结论:哪些已经落地(不是要重做的)

| PRD 条款 | 已落地位置 | 机器断言 | 状态 |
|---|---|---|---|
| §6 规范化版本(`v` 只在展示;package/manifest 不带 `v`) | `scripts/package-onboard.sh:165` `po_version` 去前导 `v` | `package-onboard-version-injection.test.sh` V1 | ✅ |
| §6.1 版本单一真相 = base 派生(`doc/VERSION` 只存 base;payload semver 必须是 base 或 base-beta.N) | bash `po_version_is_derivation`(`:175`)+ gate(`:888-898`);mjs `CLEAN_SEMVER_RE`/`BETA_SEMVER_RE`/`baseOf`(`packages/payload-endpoint/src/manifest.mjs:25-43`);`scripts/release/lib/endpoint-client.mjs:161` 第三份 `baseOf` | V2/V3/V4;`validator.test.mjs` | ✅ 但**三份语法互不引用** |
| §6.2 两个身份 + veto 绑真 artifact | `releaseOps[id]{kind:release,state:prepared,ver,betaVersion,sourceCommit,sha256,objectKey}`;`payload-promote.mjs commit --expected-sha256` 必填,零构建 | `payload-release-pipeline.test.sh`(promote 两段式) | ✅ 但**没有一个具名的「候选/发布物/绑定」类型**供 B4 直接消费 |
| §7.2 payload 通道单一真相(`internal-beta` / `customer-release`) | `manifest.mjs CHANNELS` + `CHANNEL_OF_POINTER`;`views.mjs` entitlement→pointer;客户视图 `{latest, versions[{ver,sha256}]}` | `handler-customer.test.mjs`;`contract-consistency.test.sh`(PR2 客户端套件对真 handler) | ✅ 但 `views.mjs`、`payload-activation.yml:210`、`license-key.mjs` 各自硬编码通道名 |
| §7.2 npm dist-tag 只管薄壳 | 薄壳 `@flywheel-ai/onboard@0.1.0` 与 `doc/VERSION` 无关;preflight 只查「该版本未在 npm 存在」 | `shell-publish-preflight.sh` | ⚠️ `next`/`latest` dist-tag 未实现(`payload-activation.yml:273` 无 `--tag`) |
| §7.3-1 immutable key + 回读验 hash | `PUT /admin/payload/<ver>/<sha>` 已存在→409;`readback` 流式复验 | `handler-admin.test.mjs`;pipeline R2 | ✅ |
| §7.3-2 manifest 唯一 commit point,CAS | `POST /admin/manifest {baseEtag, manifest}`;412 冲突;失败=未发布 | `handler-admin.test.mjs` | ✅ |
| §7.3-3 releaseId 幂等 + 单飞 | `releaseOps` 状态机(`transitions.mjs`)+ `concurrency: payload-release` | pipeline R1/R2a;`release-workflows-structure.test.sh` S2 | ✅ |
| §7.3-4 薄壳独立发布 | 见 §7.2 行 | 结构测试 | ✅ |
| §7.3-5 客户端按版本目录安装、不互相覆盖、自更新单飞 | PR2 `~/.flywheel/runtime/versions/<ver>` + 原子 symlink | `onboard-shell-install.test.sh` | ✅(单飞 = B5) |
| §7.3-6 clean semver 永不复用 | `transitions.mjs` 拒绝 entry 删除 + 核心字段不可变;`versions` 只增 | `lifecycle.test.mjs` | ✅ 但**没有一条以「同一 clean 版本号换内容重发」为名的负例** |
| §7.3-7 staging 清理 | B0-10 三步(expire→tombstone→delete)+ sweep | `payload-key-cleanup.test.sh` | ✅ |
| manifest 字段(B1 CAS / B4 否决窗口 / B5 更新器) | `manifest.mjs emptyManifest()` + `validator.mjs` 8 条关系不变量 | `validator.test.mjs` | ✅ 但**只有代码和 plan 散文,没有机器可读 schema** |

**结论**:B0 的价值不在「定」,在「收」。今天 B1/B2/B3/B4/B5 若各自开工,会各自去读 54KB 的 pr3-pr4-plan 和三份不互引的语法,再各抄一份 —— 这正是 PRD §6.1 / §7.2 反复强调要消灭的「镜像词汇」。

## 2. 缺口清单(B0 必须补的)

| # | 缺口 | 谁受影响 | 严重度 |
|---|---|---|---|
| G1 | **版本派生语法三份互不引用**(bash / `manifest.mjs` / `endpoint-client.mjs`),无跨语言一致性测试。已发现细节分歧:bash 不校验 base 本身是 `X.Y.Z`(`doc/VERSION` 手写成 `v1.56.0-beta.2` 会静默通过);bash 与 mjs 都接受 `beta.0` 与前导零(`beta.01`),而 ledger `nextBetaN ≥ 1` 永远不会产出这两种串 → 同一 base 可能出现两个「等价但字节不同」的 beta 名 | B1(CI 断言)、B3(版本归因按字符串聚合) | 高 |
| G2 | **对象 key 派生两份**(`payloadObjectKey` / `payloadKeyOf`) | B1 | 中 |
| G3 | **通道名硬编码在 4 处**(`views.mjs`、`license-key.mjs`、`payload-activation.yml` 内联空 manifest、`handler.mjs`),entitlement→pointer 映射只活在 `views.mjs` 里 | B2、B5 | 中 |
| G4 | **没有机器可读的 manifest schema 与示例**;验收「manifest 示例通过 schema 校验」今天没有对象可校验 | B1/B2/B5 全部 | 高 |
| G5 | **§6.2 的两个身份没有具名类型与派生函数**:B4 要绑定的 `{candidateVersion, sourceCommit, releasePayloadSha256}` 今天要自己从 `releaseOps` 拼 | B4 | 高 |
| G6 | **manifest 表达不了 §8.2 的 `updates-paused / no-release-available`**:validator 不变量 1 规定「`latest: null` 仅当该 channel **没有任何** entry」,因此「首个 release 就坏、无 previous-good」时无法把 `customer-release` 摘成 null(`withdraw` 强制 `--fallback`)。B5 验收第三种情况在合同层就不可表达 | B5 | 高 |
| G7 | `doc/VERSION` 无格式守卫(没有测试断言它是 `v?X.Y.Z` 且不带预发布后缀) | B1 | 中 |
| G8 | 薄壳 npm dist-tag(`latest`/`next`)合同缺席:PRD §7.2 明确 dist-tag 只管薄壳,但没写「薄壳默认发哪个 tag、`next` 留给什么」 | B1 | 低 |
| G9 | `release-workflows-structure.test.sh` S4b 断言「customer-release token 在零个 workflow」——B1 落 promote-commit 时必须显式重谈;REQ-0 表要先写清「哪一步的授权源是什么」 | B1、B4 | 中 |

## 3. 候选方案

### 方案 A · 只写合同文档 + 对照表(零代码)
- 做法:一份 `contract.md` 把 pr3-pr4-plan §0 抄成正式合同,逐条映射到现有代码/测试。
- 优点:最小改动。
- 缺点:G1/G2/G3 的三份语法照旧漂移;G4 无 schema;G5/G6 不解决;验收「manifest 示例通过 schema 校验」无法满足。**不达标,否决。**

### 方案 B · 新建零依赖合同包 `packages/release-contract/`(推荐)
- 做法:一个 `private` 的纯 ESM 包(与 `payload-endpoint` 同风格:`.mjs` + 手写 `index.d.ts`,零运行时依赖,`node --test`),内含:
  1. `grammar.mjs`:版本语法(base/beta/clean 正则、`parsePayloadVersion`、`baseOf`、`isDerivationOf`、`toDisplayLabel`、`normalizeBaseFromVersionFile`)、通道常量(`CHANNELS`、`CHANNEL_OF_POINTER`、`ENTITLEMENT_POINTER`)、`payloadObjectKey`、状态枚举、保留窗口。
  2. `identity.mjs`:§6.2 两个身份的派生函数 `deriveBetaCandidate(manifest, betaVersion)`、`deriveReleaseArtifact(manifest, releaseId)`、`deriveVetoBinding(manifest, releaseId)`(fail-closed:非 prepared / lineage 断 / beta 非 active 一律抛错)。
  3. `schema/manifest.schema.json`(JSON Schema 2020-12,形状层)+ `schema/manifest-view.schema.json`(客户视图,字节合同)+ `examples/*.json`(空态、beta-only、release 已切、withdraw 后 paused、quarantined)。
  4. `vectors/version-derivation.json`:正反例向量,**同一份文件**同时喂 mjs 测试与 bash 测试。
  5. `__tests__/`:语法向量、身份派生、schema 校验(示例全过、坏例全拒)、**消费者结构 lint**(`payload-endpoint/src`、`scripts/release`、release workflows 里不许再出现通道名/版本正则字面量)。
- 消费者改造(本单范围内,纯重导出/替换,不改行为):`payload-endpoint/src/manifest.mjs` 改为从合同包重导出;`endpoint-client.mjs` 删除 `baseOf`/`payloadKeyOf` 改 import;`views.mjs`/`license-key.mjs` 用 `ENTITLEMENT_POINTER`;`payload-activation.yml` 内联空 manifest 改调 `emptyManifest()`;bash 不 import,改为**被向量测试锁住**。
- 优点:一个真相源、跨语言由向量锁、B3/B4(Bridge TS)可直接 `import`、B5 客户端(必须零依赖、字节稳定)靠 view schema 锁而不需 import。
- 缺点:多一个包;`payload-endpoint` 原则「零 flywheel-* 依赖」要放宽为「只依赖零依赖的合同包」(wrangler/esbuild 能打包 workspace symlink;runbook 加一句 `pnpm install`)。

### 方案 C · 真相源留在 `payload-endpoint/src/manifest.mjs`,其他人相对路径 import
- 优点:不新建包。
- 缺点:Bridge 侧 B3/B4 要 import 一个 Cloudflare Worker 包;方向反了(端点是合同的**消费者**之一,不该是宿主);bash 仍无锁。**否决。**

**推荐 B。** 「一个源、多个消费者」的无聊解法就是一个独立的小包。

## 4. 合同要点草案(细节进 plan)

### 4.1 版本(§6 / §6.1)
- `doc/VERSION` 文件内容 = `v?X.Y.Z`(允许前导 `v` 与空白),规范化后的 **base** = `X.Y.Z`,每段 `0|[1-9]\d*`。**禁止**任何预发布后缀 / build metadata。
- payload semver ∈ { `X.Y.Z`(clean),`X.Y.Z-beta.N`(beta) },`N ≥ 1`、无前导零。其他一律非法(`rc`、`alpha`、四段、带 `v`、`+meta`)。
- `isDerivationOf(base, ver)` ⇔ `baseOf(ver) === base`。
- 展示标签 = `v` + semver(UI / git tag);package.json / manifest / 对象 key / 版本目录 = 不带 `v`。
- beta N 的唯一分配者 = `manifest.releaseLedger[base].nextBetaN`(§B0-9 预约 CAS);任何脚本不得自算 N。

### 4.2 通道(§7.2)
- payload 通道真相 = `manifest.channels` 的两个指针;entitlement→pointer 固定映射 `internal→internal-beta`、`customer→customer-release`。
- 指针是**权威**:客户端不得用 max(versions) 推断 latest(withdraw 会让指针后退)。
- npm dist-tag 只描述薄壳:薄壳发布默认 `latest`;`next` 只保留给薄壳自身预发布;**dist-tag 永不表达 payload 通道**。
- 不用 GitHub Release(PRD §7.2)。

### 4.3 §7.3 七条不变量 → 机器断言(逐条对照,见 plan §3 表)
- 每条写成:合同谓词 / 现有落点 / 现有测试 / B0 新增负例 / 若属客户端则标 owner=B5。

### 4.4 manifest 字段合同
- 形状层 = JSON Schema(`schemaVersion: 1` 不变,本单改动全部向后兼容);关系层 = `validator.mjs`(权威实现)+ 文档逐条编号。
- **G6 修正**:不变量 1 放宽为「`channels[ch].latest` 为 null ⇔ 该 channel **没有 `status=active`** 的 entry」;这个态命名为 `paused`(= PRD §8.2 的 `updates-paused / no-release-available`),视图层保持 503(现有客户端行为不变,客户可见话术映射 = B5 边界)。
- 身份类型:`BetaCandidate {baseVersion, betaN, betaVersion, sourceCommit, betaPayloadSha256}`、`ReleaseArtifact {releaseId, releaseVersion, sourceCommit, releasePayloadSha256, objectKey}`、`VetoBinding {releaseId, candidateVersion, sourceCommit, releasePayloadSha256}`;全部**由 manifest 派生**,不另存副本(B4 的决策记录只存 binding 三元组 + releaseId,commit 时用 `--expected-sha256` 回绑)。

### 4.5 REQ-0 对照(初稿,plan 定稿)
| 动作 | 门 | 授权源 | 执行面 | 合同断言 |
|---|---|---|---|---|
| merge 到 main | ship | Discord 🆒(FLY-1063,只引用) | `ship-on-comment.yml` | 不读任何 payload token(结构测试 S1/S4) |
| 薄壳 npm publish | release(壳) | main + Environment `release`(FLY-1323) | `payload-activation.yml publish` | 壳版本 ≠ `doc/VERSION` 派生 |
| beta 发布(`internal-beta` 指针前进) | release(内部) | 定时/dispatch,无人工门 | `payload-beta-release.yml` | 只持 beta-publish 能力;不能碰 `customer-release` |
| promote prepare(staging + prepared) | release | 无门(可重跑、可放弃) | `payload-promote.yml` | 不切指针 |
| **promote commit(`customer-release` 指针切换)** | release(对外) | **B4 否决窗口沉默 / founder 显式 go**(PRD §2.3;不是 🆒,不是 merge) | B1 落 commit 路径;S4b 届时重谈 | 只接受 `{releaseId, expected sha256}`;零构建 |
| withdraw / quarantine | release(止血) | customer-release 能力持有者 | B5 | 同一 CAS 内摘指针 + 重钉 fallback 或进 paused |

## 5. 假设(明说)
1. 生产 manifest 目前无对外 release 内容(FLY-1323 进度:壳已发 0.1.0、manifest 空、客户装会 503)。G6 的不变量放宽向后兼容,即便已有内容也不需迁移。
2. `schemaVersion` 保持 1;若未来出现不兼容字段再升 2,并在合同文档写升级规则。
3. bash 打包脚本继续用 bash 实现语法(它必须能在无 node_modules 的打包环境跑),由共享向量文件锁一致性,而不是让 bash 调 node。
4. B0 不新增 workflow、不动 broker、不动 FLY-1323 姿态;只声明 REQ-0 对照并让 B1 依此落 commit 路径。

## 6. 非阻塞问题(已发 Lead,按默认继续)
- Q1 合同包放 `packages/release-contract/`(方案 B)还是塞进 `payload-endpoint`(方案 C)?默认 B。
- Q2 不变量 1 放宽为「无 active entry 才允许 null」以表达 paused 态,是否认可放在 B0(合同层)而非 B5?默认放 B0。
