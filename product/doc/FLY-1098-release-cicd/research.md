# FLY-1098 Release CI/CD 发布流程 — 调研

Issue: FLY-1098 (https://linear.app/geoforge3d/issue/FLY-1098/prd-release-cicd-发布流程-打包发布-pipelinespec-for-fly-1062-pr4咬合-fly-1063)
日期: 2026-07-09
基于: 无(co-eval 先行；本文为 co-eval.html 的 grounding 审计，非 PRD 正文）

> **这轮交付 = 一张 release 层 co-eval HTML 画布**（`co-eval.html`），不写 PRD 正文（Annie 要 HTML-先-想清楚，HL 定）。本文记录画布背后的代码/issue 审计与网研 grounding，供 Annie 收敛后写 PRD 时复用。

---

## 0. 分层与硬约束（画布地基）

| 层 | 归属 | 一句话 |
|---|---|---|
| **ship 上线层** | FLY-1063（**已拍 Option B**，PR #532） | 🆒 → authz(Discord 账本) → CI/gate → merge → record。「一次改动怎么上线/内部部署」 |
| **release 发布层** | **本 PRD** | 把一次改动切成带版本、可重现、打包好、零源码暴露的可分发 artifact → 发布给客户。「一个版本怎么被构建 + 发布」 |
| **咬合点** | 🆒 | 共享入口；但见 REQ-0 |

**REQ-0（Tadashi，issue 评论，硬约束）**：ship ⊥ release，**两扇独立门**。不是每次 ship 都 release（内部改动 ship 了客户不该收新包），也不是每次 release 都重新 ship（可从已 ship 的代码打版本发）。🆒 可只开 ship / 只开 release / 都开，但绝不把 release 焊成 ship 的副作用。precedent = FLY-971（merge-to-main 与自动重启彻底分离）。

> **对「sibling vs umbrella」边界题的结论**：REQ-0 说无论文档怎么组织（兄弟 PRD / 大伞 section），「两扇独立门」都不变 → sibling/umbrella 纯是文档组织选择。画布 Q4 附带问 Annie 偏好，不阻塞设计。

## 1. ship 层素材（FLY-1063 Option B，PR #532，读它别重做）

- **Q1 = Option B**：Discord 是唯一授权源；GitHub 🆒 = 执行 + gate，不是竞争性授权。
- 恒定形状：`🆒 → authz → gate/CI → merge → record`；账本对账（记账）是一等最终步。
- **REQ-1**（ship 层）：GitHub 侧必须独立核验账本（founder-approved gate 绑定到 PR head，经 `cool-ship-gate` resolver 复用 `verify-approval`/`evaluateShipEligibility`）才 merge —— 否则持 token 的 agent 可 🆒 绕过 founder。
- Q2 身份分离 = deferred（暂用 Annie 个人账号；产品化前置）。Q3 首批 = FlyView + GeoForge3D。
- 副产品：main **无 branch protection**（private repo GitHub Free 返 403），与 `Blueprint.ts:1481` 矛盾 → REQ-3。**对 release 层的影响**：发布门若也想靠 branch protection 兜底，同样不成立，需自己的账本核验。

## 2. release 层首片 = FLY-1062 现状（读 PR #531）

FLY-1062 = 客户 `npm install` 拿打包产物、零仓库访问、零源码暴露。**渠道已由 Annie 2026-07-09 拍 B**（exploration §5 决策块）。三层拆解（渠道无关分层）：

- **① 打包流水线（P0，PR #531 已落）**：monorepo → 可发布 artifact。白名单收树 + workspace 包 `bundleDependencies` + `file:` 配对内嵌 + 第三方依赖程序化并集 + 4 道 CI 发布安全门（secret-scan / 路径白名单 snapshot / 零 `.ts`·`src`·`__tests__`·`doc`·`.git` / 零仓库访问不变式）。**`private:true` 不可发布**（X2 断言，Tadashi guardrail）。
- **③ 安装/运行层（P2/P3）**：npm bin 薄壳 → 落耐久根 `~/.flywheel/runtime/versions/<ver>` → 原子翻 `current` symlink → exec onboard（prebuilt 模式跳 clone/build）。
- **② 发布渠道 = B**：公共 npm 只发**薄壳**（安装器，零话术零产物）；客户输 **license key** 从 gated 端点换真 payload（构建产物 + 话术/prompts）。

### 2.1 channel 对比表（Annie 已看过并据此拍 B；画布 ① 原样呈现当背景）

| 渠道 | 客户体验 | 源码暴露面 | 成本 |
|---|---|---|---|
| A · npm 公开 scoped | `npx @flywheel/onboard`，零 token | 最大：任何人下载安装器 + 编译 JS + **话术/prompts 可读** | 最低 |
| **B · 公开薄壳 + key 换 gated payload ✓** | `npx` + 输 license key | 最小：薄壳零 IP；payload 只给持 key 客户 | 中（托管 + key 签发/吊销） |
| C · 私有 registry | 客户先配 registry token | 最小 | 低托管 + **高**（每客户 token 分发/轮换） |
| D · 自托管 tarball + curl | `curl <token URL> \| sh` | 同 B 可控 | 中 |

**诚实边界（exploration §3）**：Node/bash 产品无真·源码保护（bash + 编译后 JS 天然可读）。B 真正保证 = 客户拿不到 TS 源、git 历史、内部文档，话术/prompts 只给持 key 客户。

### 2.2 画布 ① 真正开放的子决策 = payload 托管在哪

FLY-1062 把 B 的 payload 托管/key 基建列为 **P4 follow-up**（PR #531 out of scope）→ 这正是 release 层要定的。两条路：
- **自搭薄 gated 端点**：验 token → 返回版本 manifest(`{latest, versions[{ver, sha256}]}`)/ payload tarball；复用 **FLY-203 publish-report** 已验证托管底座（私有 blob + 薄函数层）。全在自己手里、成本可控。
- **商用 licensing+分发平台**（Keygen 类）：per-customer entitlement token + 即时吊销现成；少写基建但引外部依赖 + 订阅。`UNKNOWN`：定价/数据驻留未细查（Annie 若倾向再深挖）。

## 3. Tadashi 三条 eng REQ（画布 ②③ 落点）

1. **打包命令接 CI 每次验** —— **已落**（PR #531 加两步 CI）：hermetic 打包套件（assembly/依赖并集/发布门含注入负例/compat mirror/审计闭包）+ **真 npm 全链 smoke**（pack → `npm install --prefix` → mirror → bare-import 矩阵 → better-sqlite3 native → **packaged Bridge serves `/health`** → Lead launcher dry-run）。**验收线 = 「装得上 ≠ 起得来」**。发布门复用同一条链，不另造。
2. **可重现打包** —— assembly 幂等（重跑 diff 为空，P0 验收项）。
3. **版本机器断言** —— payload `package.json` version == `doc/VERSION`，**CI 断言相等**（对不上 = 构建失败）。dist-tags：`latest`（客户默认）/ `next`（内测）。

**客户升级（R4，research §7/§8/§10）**：MVP = 重跑安装命令 or 包内 `flywheel update`（同代码路）→ 用已存 key 拉新 manifest + tarball → 装新版本目录 → 原子翻 symlink → 重启已装服务（新建 packaged update seam，**不复用** monorepo `restart-services.sh`）→ health 失败自动回滚。坏版本 = `npm deprecate` + manifest 摘除（npm 72h 不可 unpublish）。全自动后台更新 = follow-up。

## 4. 🆒 → release 触发链（画布 ③）

`🆒（发布意图）→ 发布门（独立授权，不蹭 ship 门）→ 打包(可重现) → 版本机器断言 → 发布（薄壳 npm publish + payload 上 gated 端点 + 更新 manifest）→ 记账`。P4 发布流程细节（PR #531 out，本 PRD spec 驱动）：薄壳 npm publish（显式 tag + provenance/2FA，壳版本独立）；payload CI 构建后上传 gated 端点（payload version == `doc/VERSION`，CI 断言）。

## 5. 网研 grounding（渠道通行做法 + 同类工具先例）

- **scoped 私有默认**：私有包必带 scope，scoped 包默认 restricted；公开需 `--access=public`；npm 私有包需付费 org 账号。（npm Docs）
- **GitHub Packages**：仅 scoped，消费侧要配 token；air-gapped/全控 → Verdaccio 自托管 registry。（CloudRepo / npm Docs）
- **tarball/git-url 分发** = 脆弱管线（分支删除/改名/网络抖动即断）vs registry 稳定版本化 —— FLY-1062 用 sha256 + 版本 manifest 缓解。（CloudRepo）
- **thin shell + gated payload + license key 是业界成熟模式**：**Keygen** 把它产品化（distribution API 只放行 licensed user 拿 release artifact；per-customer entitlement token + 即时吊销）；`software-license-key` npm 库做 key 生成/校验；闭源包 license = `UNLICENSED` 标准。有「npm CLI 企业分发：build/sign/deliver」实践文。（Keygen / npm Docs / DEV）
- **暴露风险**：私有包也可能因误公开或下到多用户机器而泄露 —— 对应 FLY-1062 §9 发布安全门 + private:true。

**Sources**:
- [About private packages | npm Docs](https://docs.npmjs.com/about-private-packages/)
- [Creating and publishing private packages | npm Docs](https://docs.npmjs.com/creating-and-publishing-private-packages/)
- [Private npm Registry Guide | CloudRepo](https://www.cloudrepo.io/articles/private-npm-registry-guide)
- [Working with the npm registry — GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [Keygen — License and Distribute Commercial Node Packages](https://keygen.sh/for-npm-packages/)
- [Keygen — How to License and Distribute a Private Node Module](https://keygen.sh/blog/how-to-license-and-distribute-commercial-node-modules/)
- [Shipping an npm CLI Tool Securely to a Specific Customer](https://codenote.net/en/posts/npm-cli-enterprise-distribution-build-sign-deliver/)

## 6. co-eval 画布结构（Annie 逐块拍）

`co-eval.html`（host-only 发布，HL QA + relay）：
- **A 整套 flow 图**：🆒 → 两扇独立门（ship 已拍 / release 这页拍），共享入口 + 共享账本 + meshbar 声明「release 绝不是 ship 副作用」。
- **① 渠道 + payload 托管**：A/B/C/D 对比表（B 已锁高亮）+ 开放子决策 = payload 托管（自搭 FLY-203 薄端点 vs Keygen 类平台）+ 确认薄壳 = npm public scoped。
- **② 版本 + 升级**：version==doc/VERSION CI 断言、latest/next、升级路、deprecate 撤版；问自动 vs 手动升级。
- **③ 🆒 → 发布触发链**：三条 REQ（CI 已落 / 可重现 / 版本断言）+ REQ-0 独立授权。
- **④ 首片 vs fleet**：1062 PR4 首片 + 设计留 fleet 推广口 + 附带 sibling/umbrella 文档组织问题。

## 7. 开放问题（等 Annie 收敛）

1. ①-payload：自搭薄端点 vs 商用平台（Keygen）？
2. ②-升级：MVP 手动 vs 推送自动？内测 next 通道是否要 Annie 自己先试？
3. ③-触发：发布是否要 Annie 单独点一次头（哪怕代码已上线）？是否用与 🆒 不同的发布标记？
4. ④-节奏 + 文档组织：首片 vs fleet 节奏；sibling PRD vs umbrella section？
5. **给 HL 的 ① 框定问题**（已 ask，pending）：把渠道当 grounding 呈现（B 已锁）对不对，还是要重新给 Annie 确认整个渠道？

## 8. Annie round-1 收敛 + ship 段 prep（下一版一起做）

### 8.1 Annie round-1 批注已折进 v3（efb203c0）
- **A**：release 分两层 = beta（Flywheel 自己 always-update，自动、每 ~6h）+ 对外正式版（beta 跑稳→founder 点头提升）。
- **①**：免费/付费产品路径 —— B（薄壳+key+gated payload）天然是免费/付费开关；现在建 B 留通路径。payload 托管选择与免费/付费挂钩（Keygen 类自带分档）。
- **③**：三频率（ship/commit · beta/~6h · 正式版=提升）+ 命名 `v1.56.0-beta.N`（next）→ `v1.56.0`（latest），机器断言。
- **④**：去黑话（「先在 1062 一个产品跑通 / 以后铺到所有项目」）。
- **②**：beta/正式版通道方案（我们跟 beta、别人跟正式版 + 升级路）。

### 8.2 ship 段 = FLY-1063 Option B（已 ship 落 main，mergeCommit 53e940e8，PR #532）
> **注**：1063 docs 实际在 `product/doc/FLY-1063-github-cool-ship/`（HL brief 说 engineering/doc 是笔误）。prd.md 已读。

Annie 定的 ship 层（下一版作统一 PRD 的 ship 段并入）：
- **Q1 = Option B**：Discord = 授权源（她 cool = founder 授权），GitHub = 执行 + 门禁，不是竞争授权。一句话「Discord 授权,GitHub 执行」。
- **恒定形状**：`🆒 → 鉴权 → gate/CI → merge → 记账`（每个 repo 一样）。**变的只是 gate 重量**：重（代码 repo：门禁+全套 CI）/ 中（config/skill：lint+contract）/ 轻（内容：格式检查）/ 空（纯素材：无 gate 但照走 🆒 flow）。→ **这个「同一形状、gate 重量可变」概念天然连着 ④「推广到所有项目」**——统一画布可用它把 ship 段的 fleet 化讲清。
- **5 步流程**（Annie 亲述）：① Discord 拍 cool（唯一授权）→ ② Runner 去 GitHub 触发门禁 → ③ 鉴权+gate+CI 全跑 → merge to main → ④ deploy（各 repo 自己方式）→ ⑤ Runner 回 Discord 报完 + 自动销账 + 清理。
- **记账**（三本账 Linear/Bridge/GitHub 对齐）= 一等收尾步。
- Q2 身份分离 = deferred（暂用她账号；外部产品化前置）。Q3 首批 = flywheel(=FlyView) + GeoForge3D。
- **eng 硬 REQ**（归未来 PRD 的 eng 段，非 Annie-facing 画布）：REQ-1 GitHub 侧独立核账本（founder-approved gate 绑 head sha，非「commenter 有写权限」）；REQ-1a `cool-ship-gate` resolver；REQ-1b 不跑 PR-head 代码（self-hosted runner M1 只跑可信代码）；REQ-2b 对齐 `evaluateShipEligibility` + strict 无-bypass；REQ-3 branch protection（个人 Pro / Team org + `enforce_admins`）；REQ-4.6 上线次序（observe→阻断）。

### 8.3 下一版（round 3）计划：ONE 统一 CI/CD PRD 画布
- **sibling vs umbrella 已定 = umbrella**（Annie：1063 内容补进统一 1098）。画布重定位为「一个统一 CI/CD PRD，两段」。
- **ship 段**（1063 Option B，已 ship）：flow 画布 ship 泳道用 1063 五步形状 + 标「已 ship · 53e940e8」+（可选）gate 重量可变概念连 ④。
- **release 段**（beta/release 两层）：Annie round-1 已折的 v3 内容 + 她 round-2 批注。
- **REQ-0** 串两段：ship ⊥ release 两个独立门。
- **执行**：等 Annie 对 v3 的批注回来，与 ship 段一起做 round 3（HL 指示「别急着单独出」）。eng REQ 不进 Annie 画布（去黑话原则），留给未来写 PRD 正文时的 eng 段。
