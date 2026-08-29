# FLY-1098 Release CI/CD 发布流程 — 打包发布 pipeline（PRD）

Issue: FLY-1098 (https://linear.app/geoforge3d/issue/FLY-1098/prd-release-cicd-发布流程-打包发布-pipelinespec-for-fly-1062-pr4咬合-fly-1063)
日期: 2026-07-10
基于: `product/doc/FLY-1098-release-cicd/co-eval.html`（与 Annie 8 轮 co-eval，2026-07-09~10）+ `research.md`（同文件夹）；FLY-1063 PRD（ship 段，`product/doc/FLY-1063-github-cool-ship/prd.md`，已 ship 落 main 53e940e8）；FLY-1062（npm 分发层实现，PR #531）

> **状态**：**Codex design review APPROVED**（4 轮：R1 8 项 → R2 4 → R3 2 → **R4 APPROVED**，全部 blocking 已闭合；2 个非阻塞 LOW 也已折入）→ 待 HL 过目 → Annie 点头 → ship。
> **这是 spec，落地交 Tadashi**（related FLY-1062 的 PR4「发布 CI/CD」）。本 PRD 定**产品行为 + 机制 + 产品不变量 + 失败模式语义**；标 `工程定` 的选型/实现细节交 Tadashi。

---

## 0. TL;DR

把 flywheel 一次改动，切成**带版本、可重现、打包好、零源码暴露**的可分发 artifact，按**两档节奏**发布：**Beta**（内部先用）+ **对外 Release**（给客户）。核心机制：

- **两扇独立门**（REQ-0）：ship（上线/内部部署，FLY-1063 已定）⊥ release（打包发布，本 PRD）。两门可共享**身份/通知/账本 primitive**，但**各自独立的授权源与决策记录**（§2.3）。
- **判据 c**：三信号聚合（FLY-942 看门狗健康 + 版本化 bug 数 + Annie 当天可选 👍/👎（负向 veto））→ 一个 `green | hold | unknown` 的发布就绪状态（§4）。
- **⭐ auto-ship-on-silence**：对外发布从「Annie 点头才发」翻成「**判据 green 时默认自动发、除非她在否决窗口内点『别发』**」；`hold`（黄/红）和 `unknown`（信号缺失/过期/数据源自身故障/通知没送达）一律**不自动发**，fail-closed（§5）。减少 human-in-loop（接 FLY-1045 自治 / FLY-1138）。
- **渠道**：**薄壳 → 公共 npm**（npm dist-tag 只管薄壳自身）；**payload → Cloudflare R2 + manifest**（payload 通道的唯一真相，`internal-beta` / `customer-release` 两个指针，entitlement 分级）。承接 FLY-1062 已拍的**渠道 B**（§6/§7）。
- **止血**：**fleet 级 quarantine/withdraw**（把坏版从 release 指针原子摘除、阻止再下载/再升级）+ 客户端记 failed/quarantined 版本不重装 + 客户本地 `flywheel rollback`（§8）。

---

## 1. 问题 / 用户 / 目标 / 非目标

### 1.1 问题
客户侧要能一条命令装到 flywheel 的可分发产物（零仓库访问、零源码暴露，FLY-1062）。缺一套**发布流程**把「一次改动 → 一个带版本、可重现、发布好的 release」串起来，并解决 Annie 的真痛点：(1) 新版本常搞崩系统、bug 反馈散落无汇总信号；(2) 她不想被绑在 human-in-loop 每天点发布。

### 1.2 用户（两个受众，别混）
| 受众 | 是谁 | 走哪层 |
|---|---|---|
| **内部项目仓** | flywheel 自己、GeoForge3D、Feedy… = 内部管的多个代码仓 | **ship 层（FLY-1063）** —— 🆒 上线各自内部部署，对内部仓通用 |
| **对外客户** | 外面装 flywheel 来用的客户 | **release 层（本 PRD）** —— 打包发布。**现在对外只有 flywheel 一个产品** |

> **范围红线**：release/NPM 分发**现在只做 flywheel 一个仓**（Annie 定，不做通用 skill）。「其他项目（GeoForge3D）」只涉及内部 beta 节奏（§3），**对外发布仅 flywheel**。
> **命名锁定**（Annie 2026-07-09，见 FLY-1063 PRD）：**Flavio = FlyView = flywheel 本仓 = 同一系统本身**。

### 1.3 目标
G1 一次改动 → 带版本、可重现、零源码暴露的 release artifact（承接 FLY-1062）。G2 两档节奏，可配置。G3 一个 `green|hold|unknown` 发布就绪信号（判据 c），汇总散落反馈。G4 对外发布**默认自动、Annie 只在想拦时出手**，且**只在 green 时才自动**（fail-closed）。G5 客户能自动更新 + fleet 级止血 + 一键回滚。

### 1.4 非目标
❌ 计费/账号/席位/计量（免费付费是将来，B 渠道已留口子）。❌ 对外多产品通用 release skill（现在只 flywheel）。❌ 重写 FLY-1063 ship 层（已 ship，仅引用为 umbrella ship 段）。❌ 重造 bug 检测/健康监控（复用 FLY-942 原始事件）。❌ Bridge「按项目分开」改造本身（§3 目标态前置，另立 B6）。

---

## 2. 分层与硬约束（REQ-0）+ ship 段（umbrella）

### 2.1 REQ-0（Tadashi 硬约束，不得违反）
**ship ⊥ release，两扇独立门。** 不是每次 ship 都要 release；也能从**已 ship 的代码**打个版本发。**两门可分别或同时被请求，但各走自己的授权源（§2.3）**；绝不把 release 焊成 ship 的副作用。precedent = FLY-971。

### 2.2 ship 段（FLY-1063 Option B，已 ship 53e940e8，本 PRD 只引用）
- **Discord 授权，GitHub 执行**：Discord = ship 门授权源，GitHub 🆒 = 执行+门禁，不产生授权。
- **恒定形状** `🆒 → 鉴权 → gate/CI → merge → 记账`，gate 重量可变（重/中/轻/空）。记账 = Linear/Bridge/GitHub 三本账对齐。
- ship 段的 eng 硬 REQ 全在 FLY-1063 PRD，本 PRD 不重复。

### 2.3 咬合点 + 两门的授权源区分（Codex R1#6）
两门**可共享 identity / 通知 / 账本 primitive**，但**各自独立的授权源与决策记录**，绝不混：
- **ship 门授权源** = Discord 🆒（founder 亲拍，FLY-1063）。
- **release 门授权源** = 「到期 + 绑定候选的 green eligibility + veto notice 已送达 + 否决窗口内无 founder veto」（§5）；黄/红/unknown 时 = founder 显式 go。**release 授权源不是 🆒**，实现绝不能让 release 去等 🆒（会破坏 opt-out），也绝不能复用 ship 的 approval ledger 把 silence 当成 founder-approved PR head（污染两门独立记账）。
- 手动可同时触发两门（共享 UI），但产生**两条独立、可审计记录**。

---

## 3. 节奏：两档 + 分频两态

### 3.1 两档（Annie r5→r6 定，砍第三档）<span>产品定 ✓</span>
| 档 | 谁用 | 频率 |
|---|---|---|
| **Beta** | 我们自己（内部用） | §3.2 分频两态 |
| **对外 Release** | 外面的客户 | 每周一次（可配），promote 机制见 §5 |

「发版」（推 npm/R2）和「拉取更新」（各机器定时取）是**两条独立（detached）线**（Annie 确认）。

### 3.2 Beta 分频：现状 → 目标（两态都写）<span>频率产品定 · 解限工程定</span>
- **现状（今天）**：flywheel 本仓（Flavio）和 GeoForge3D **共用同一套 Bridge，没法按项目分开** → Beta **全都每 6h** 跑。**诚实标注：现在没法分频。**
- **目标态（Bridge 支持按项目分开后）**：Beta 频率 = 每项目配置项，**默认 24h**；**Flavio 6h**（活跃开发）、**GeoForge3D 24h**。
- **落地依赖**：目标态需 Bridge 先支持按项目分开（→ B6，独立泳道，见 §14）。此前维持现状全 6h。

---

## 4. Beta 稳定判据 c（消费 FLY-942 原始事件 + 新增归因/健康 + 新聚合日报）

**判据 c（Annie r4 锁定 = 三信号都要）**。**复用边界要诚实（Codex R1#5）**：FLY-942 提供的是 **Lead/Runner 检测、分类、去重、升级流**（**它明确「无 digest」**，别把版本健康日报归给它；仓库另有 FLY-727 部署 digest，也不是版本健康）。本 PRD 要**新增**三件：版本归因、数据源健康/heartbeat、新的版本健康聚合日报。

| 信号 | 消费什么 | 本 PRD 新增 |
|---|---|---|
| **崩溃/卡死/报警数** | FLY-942 的原始告警/卡死事件（已上线） | 事件当前按 project/lead/session 分类、**不带 payload version** → 必须**新增 beta version/deployment 归因** + **watchdog 自身 heartbeat**（否则「无事件」可能是 watchdog 挂了，不是健康） |
| **这版收到几个 bug** | — | 报 bug 时**自动打「当前运行版本」tag** → 按版本聚合「这版 N 个」（对齐 FLY-1045 反馈机制那条线，不另造评分系统） |
| **Annie 手感** | — | 当天**可选** 👍/👎（可选负向 veto，非必需正向，语义见 §4.1） |

### 4.1 信号语义 + 状态（Codex R1#1，fail-closed 基础）
判据 c 产出 `green | hold | unknown`（喂给 §5 安全闸）：
- **客观信号（看门狗健康 + 版本化 bug 数）= 必需 + 有 freshness 窗口**：任一 missing / stale / 数据源自身不健康（watchdog heartbeat 丢）→ 判据 = **`unknown`**（绝不当健康；FLY-942 精神 = 不确定 → fail-suspicious，绝不静默）。
- **Annie 👍/👎 = 可选的负向 veto，不是必需的正向新鲜反馈**：她标 👎 = 直接压成 `hold`；她**没标** = 不阻塞（否则又变每天 human-in-loop），但也**不单独当健康证明**（健康由客观信号决定）。
- `green` = 客观信号新鲜且无异常 + 她没标坏；`hold` = 有崩/报警/bug 超阈 或 她标坏；`unknown` = 必需信号缺失/过期/源不健康。
- 候选 beta 有**最低 soak/freshness**（具体数值可配，工程定）。

**诚实边界（Annie 认）**：v1 有 bias（👍/👎 主观、bug 数只算报上来的），但比「散在各 thread、全靠脑子记」强太多。先傻着来、以后再精。

---

## 5. ⭐ auto-ship-on-silence（对外发布：默认自动、fail-closed、Annie 可否决）

**round-8 核心反转，Annie 明确要（减 human-in-loop，接 FLY-1045 / FLY-1138）。**

### 5.1 反转：opt-in → opt-out <span>产品定 ✓（Annie r8）</span>
到对外发布的点，系统默认把候选 beta 发对外；Annie 什么都不用做；只有她想拦时点『别发』。她从「每天要点」变「只在不放心时出手」。

### 5.2 fail-closed 状态机（Codex R1#1，核心安全语义）
release 只在**判据 green** 时默认自动发；**`hold` 与 `unknown` 一律不自动发**：

```
每周 release cycle 到点（对外发布节奏，可配）→ 系统挑候选 beta → 取判据 c 状态
├─ green  → 开一次否决窗口，日报「今天默认发对外 <候选>，想拦在 [窗口] 内点『别发』」
│           · 窗口内无 founder veto 且【veto notice 已确认送达】 → 自动发对外（记账:沉默默认发）
│           · founder 点『别发』                              → 停,这周期不发,等下次或她手动 go
├─ hold   → 不自动发,日报「这版有问题(N bug/崩/你标坏),没自动发,要坚持发就点『发』」→ founder 显式 go
└─ unknown→ 不自动发（信号缺失/过期/watchdog·Bridge·scheduler·通知自身异常）→ 行为 = hold publication，日报「无法判断,已 hold」→ 修复数据源或 founder 显式 go
```

**关键 fail-closed 规则（写成 acceptance matrix，§5.5）**：
- **每周 release cycle 只开一次否决窗口**；日常日报只展示健康，**不每天问发布**（避免重造每天 human-in-loop）。
- **cycle 开始冻结候选**（§6.2 (i)：预构建 clean release artifact）；否决窗口**绑定不可变** `{candidateVersion, sourceCommit, releasePayloadSha256}`（绑**最终发布物**，非 beta hash）。**窗口内新出的 beta 只排队到下个 cycle、不替换当前候选、不重开窗口**（保「每周期一次 notice」+ fail-closed 同时成立）；只有**当前候选自身**出现新负面证据、变 `hold`/`unknown` → **取消本周期、不再开第二个窗口**，等下周期。
- **只有 veto notice 有 delivery receipt（确认送达 Annie）后，未 veto 才算「沉默通过」**；通知/Bridge/scheduler 自身异常 → `unknown`（行为 = hold publication），不放行。
- founder action（`别发` / `发`）需**身份校验 + durable + 幂等 + 绑定候选**；`hold`/`unknown` 后的 `发` **只允许 founder，且只 override readiness 决策，不得 bypass §7.3 的 CI / hash / immutable / CAS / 版本断言安全不变量**。

### 5.3 否决窗口（Annie r8 圈定）<span>产品定 ✓</span>
**几小时/当天**：**早上日报出候选 → 下午没拦就自动发**，给 Annie 一上午拦截。具体钟点（如「下午 2 点前不点别发即自动发」）由 Annie/HL 定一个值，做成配置（§13 open）。

### 5.4 owner 变更 + 记账
- **这步 owner**：从「Annie 人工点发」→「**green 时系统默认自动发（工程）+ 否决权（Annie）**」。
- **记账**：记 `who / when / 触发方式`（沉默默认发 / Annie 点发 / hold-unknown 后手动 go），三本账一致、可审计、独立于 ship 门记账。

### 5.5 上线次序（Codex R1#4/#7）
首开 auto-ship 前必须：**shadow/observe（只报不发）→ 手动 release 走通一次真 E2E → 才灰度开 auto**，且需先验证 §8 的 central quarantine 能真止血。

---

## 6. 版本号 + 命名（Option 2）<span>产品定 ✓（Annie r3）</span>

- **beta**：`vX.Y.Z-beta.N`（带 `-beta.N`，N 递增）。**对外正式版**：promote = 从**同一 `sourceCommit`** 出一个**干净版本号 `vX.Y.Z`**（去 `-beta` 后缀）。客户看到干净版本号。
- **规范化版本**：UI/git tag 可带 `v`（`vX.Y.Z`）；**package/manifest 里的 semver 不带 `v`**（`X.Y.Z`）—— 对齐 FLY-1062 `po_version()` 去前导 `v` 再比对。展示名与 package semver 分清。

### 6.1 版本单一真相 = base version 派生（Codex R2#1，B0 合同）
「同一 commit 的 `doc/VERSION` 既是 beta 又是 clean」不可能同时成立。定死：
- **`doc/VERSION` 只存 base version `vX.Y.Z`**（不带 `-beta`）。
- **beta semver `X.Y.Z-beta.N`** 由 release ledger/counter 派生（N 递增）；**clean semver `X.Y.Z`**。
- **CI 机器断言改为**：package/manifest version 必须是**该 base version 的合法 beta 或 clean 派生**（`X.Y.Z-beta.N` 或 `X.Y.Z`），**不是**两者都逐字 == `doc/VERSION`。对不上即停。

### 6.2 两个身份 + veto 绑真 artifact（Codex R2#1，消除 TOCTOU）
decision record 记两个身份，避免「Annie 沉默放行的是 beta hash、manifest 最终切的是另一个未绑定 hash」：
- `candidate = {baseVersion, betaN, sourceCommit, betaPayloadSha256}`
- `releaseArtifact = {releaseVersion=X.Y.Z, 同 sourceCommit, releasePayloadSha256}`
- **v1 唯一执行合同 = (i) 窗口前预构建**（不再「二选一」；权威顺序见 §10）：cycle 开始冻结候选后，从同 commit **预构建并验证** clean release artifact + 上传 immutable staging object + 回读验 hash，**否决窗口直接绑定 `releasePayloadSha256`**（Annie 沉默放行的就是最终发布物，无 TOCTOU）；**manifest CAS commit 在窗口后**才做。
  - （未来替代方案，非 v1 合同：窗口先绑 beta artifact、窗口后再构建 clean 并验证内容等价 —— v1 不采用，避免与 §5 冲突。）
- promote 用可重现构建 / 内容等价证明，保证没混入未经 soak 的代码。

---

## 7. 打包 + 发布通道（payload 通道单一真相）<span>工程定（承接 FLY-1062）</span>

### 7.1 打包（FLY-1062 PR1 已落，release 门复用）
打包命令**已接 CI 每次验**（真 npm 全链 smoke，验收线「装得上≠起得来」）；**可重现打包**（assembly 幂等）；**零源码暴露 4 道 CI 安全门**（secret-scan / 路径白名单 snapshot / 零 .ts·src·__tests__·doc·.git / 零仓库访问不变式）。本 PRD 保持机制级引用，不复制实现。

### 7.2 发布通道 —— 一个 payload channel 真相（Codex R1#2）
| 走哪 | 管什么 | 谁可见 |
|---|---|---|
| **npm dist-tag（`next`/`latest`）** | **只管薄壳自身**（版本独立的安装器，零 IP） | 公开 |
| **R2 + manifest** | **payload 通道的唯一真相**：manifest 两个指针 `internal-beta` / `customer-release`（字段名工程定） | **内部 entitlement 才见 beta；外部 customer entitlement 只见 customer-release**（beta 绝不暴露给客户 key） |

- 客户命令 = `npx @flywheel/onboard`（或等效），凭 license key 从薄端点验权 → 按 entitlement 读 manifest 指针 → 换 payload。
- **不用 GitHub Release**（绑仓库访问，与「零仓库访问」相反）。
- **npm 发布姿态更正（Codex R1#5）**：当前是**私有 GitHub repo 发布 public 薄壳**，**npm provenance 对此不生成**（官方文档）→ 用 **2FA + OIDC/trusted-publishing** 姿态；**删掉 provenance 承诺**（或注明需公开 build-source 前提）。

### 7.3 发布的产品不变量（Codex R1#4 —— 三套外部状态不可原子提交）
npm（壳）+ R2 object（payload）+ manifest 是三套外部状态，无法一次原子提交。定死产品不变量：
1. **payload 以 `version + sha256` 的 immutable key 上传，永不覆盖**；上传后**从下载路径回读并验 hash**。
2. **manifest 是唯一 commit point**，最后做**原子/CAS 更新**；manifest 切换失败 = 视为「未发布」，旧 `customer-release` 继续可用。
3. **同一 `releaseId` 重试幂等 + 全局单飞（single-flight）**，冲突 fail-closed。
4. **薄壳只在薄壳代码变时独立发布**，不与每次 payload promote 强绑。
5. 客户端按**版本目录**安装 → 错过上周版本可直接追到新 `customer-release`，不与在途安装互相覆盖；客户端自更新也需单飞。
6. **clean semver 永久不可复用**：一个已切进 manifest 的 clean 版本号绝不重发不同内容（对齐 npm 版本不可变；坏版走 quarantine + 新版本号，不覆盖）。
7. **staging 清理**：未通过窗口 / 被 veto / 被更高版本取代的 candidate 的 staging object，按策略清理（避免 staging 无限堆积；具体保留/清理策略工程定，纳入 B1 acceptance）。

---

## 8. 客户升级（自动更新器 B）+ 止血（quarantine + 回滚）<span>产品选型 Annie ✓ · 机制工程定</span>

### 8.1 自动更新器 B（Annie r5 选）
客户机装定时任务（像 Chrome/VS Code 自更新）：定时查 **`customer-release` 指针** → 有新版就自动下载 → 装进新版本目录 → 原子切 symlink → 重启 → 即时 health check；**装/重启/即时 health check 失败 → 自动翻回旧版**（FLY-1062 已定）。复用 FLY-1062 耐久根 + 版本目录 + `flywheel update`（FLY-1062 列 `com.flywheel.updater` 为 follow-up）。客户端自更新单飞。

### 8.2 fleet 级止血：central quarantine/withdraw（Codex R1#3 / R2#3）
坏版发出去后本地 rollback 只是事后恢复，不是 fleet 级止血（否则 manifest 还指坏版，客户下周期**再次自动升回坏版**）。**quarantine 的原子结果必须确定 —— 绝不留 dangling pointer（否则新安装/更新请求会撞协议错误、把整个安装通道打死）**：
1. **CAS 把 `customer-release` 回指最近一个仍可用的 last-known-good，并把它重新标为 current/pinned**（不再因年龄过期）+ 阻止坏版再下载/再升级。
2. **若没有可用 previous-good** → 进入显式 `updates-paused / no-release-available` 状态：**现有安装保持原版本、新安装收到诚实可重试错误**，绝不 dangling。
3. 再通知/触发客户 rollback；**客户端记录 quarantined 版本**，在出现更高的允许版本或显式 override 前**不重装**该版本。
- **B5 acceptance 覆盖三情况**：有 previous-good / previous-good 已过期 / 首个 release 就坏。

### 8.3 客户本地回滚/降级（Annie r6）
- **`flywheel rollback`** = 秒回上一个版本（本地版本目录还在，翻指针 + 重启）。
- **`flywheel install <旧版本号>`** = 从 R2 拉某旧版装上；**只保证仍在保留窗口内（§9）且非 quarantined 的版本**。
- **区分两种回滚（Codex R1#8）**：① 「装/重启/即时 health check 失败自动回滚」= FLY-1062 已定，**不是 open**；② 「装成功后较晚才 crash-loop 是否自动降级」= §13 open question。

---

## 9. 保留期 + R2 lifecycle（current 永不因年龄过期）<span>留多久=产品定 ✓ · 实现=工程定</span>

- **payload 存 Cloudflare R2**。为何 R2（研究实据，措辞更正 Codex R1#5）：R2 **Standard 每月 10 GB-month 存储 / 1M Class A / 10M Class B 免费额度，direct R2 egress 免费**（S3 旧的 5GB 永久免费已取消、egress 0.09 美元/GB）；R2 单一存储档最简单。**注意：不是无条件「10GB 永久免费」——是每月免费额度，Worker/操作超额仍可能收费。** 我们 payload 几十 MB、只留 2~4 周，量远在免费额度内。
- **保留期（Annie r5 锁定 = 数字不变）**：**beta 被 supersede 后留 14 天 / 正式版被 supersede 后留 28 天**。**lifecycle 语义（Codex R1#3）**：**current beta + current customer-release + manifest 永不因年龄过期**（否则连续几周没新绿版会把还在 serving 的 latest 删掉、新客户装不上）；**版本被 supersede 或 quarantine 后才进入 14/28 天历史窗口**（用 prefix/copy/pin 等区分「current」与「历史」，具体工程定）。到期自动删历史版本。
- 配置：R2 Dashboard → bucket → Object lifecycle rules（规则作用于「历史」前缀，不动 current）。

---

## 10. 每周对外 Release 流程（6 步 + rollback 兜底）+ checklist

一次「对外 Release」走 6 步 + 兜底。**唯一权威顺序（§5/§6.2 (i)）：打包 + 出 clean 版本号 + 得到最终 `releasePayloadSha256` 全在否决窗口【前】；manifest CAS commit 在窗口【后】。** Annie 只在第 3 步「想拦时」出手（默认自动、可否决）；其余全工程自动。

| # | 步骤（相对否决窗口的位置） | owner | 人工/自动 |
|---|---|---|---|
| 1 | **系统自动**挑 green 候选 beta + **冻结候选**（判据 c green；hold/unknown 不进入本周期） | 系统（工程） | 自动 |
| 2 | **【窗口前】** 从同 `sourceCommit` 派生 clean 版本号（Option 2）→ 打包 → CI 版本派生断言 → 得到并记录 `releasePayloadSha256` → payload 以 immutable key **上传 R2 staging + 回读验 hash**（**不切 manifest**） | Tadashi（工程） | 自动（§6.2 (i)/§7.3） |
| **3** | **【否决窗口=授权】** 发一次绑定 `{candidateVersion, sourceCommit, releasePayloadSha256}` 的 veto notice：green + notice 已送达 + 窗口内无 founder veto → 通过；她点「别发」/ hold / unknown → 停着等 founder 显式 go | **默认自动（工程）+ 否决权（Annie）** | **默认自动 + 人工可拦** |
| 4 | **【窗口后】** 通过 → **manifest CAS commit** 切 `customer-release` 到该 releaseArtifact（薄壳仅代码变时独立发 npm；commit 失败=未发布、旧 latest 继续可用） | Tadashi（工程） | 自动（§7.3 不变量） |
| 5 | 客户自动更新器拉 `customer-release` → 装、重启（即时失败自动回滚） | Tadashi（工程实现） | 自动 |
| 6 | 记账 + 通知（版本、改了啥、who/when/触发方式） | Tadashi（工程） | 自动 |
| — | 兜底止血：坏版 → central quarantine（CAS 回 last-known-good / updates-paused）+ 客户 `flywheel rollback` | 系统 + 客户 | quarantine 自动/触发 + 客户一键 |

（6 步 = 上表 6 个编号步；另有兜底止血行。「上传 staging」（步 2）与「manifest commit」（步 4）刻意拆开、分居窗口前后。§14 B0/B1/B4 的 acceptance 按此唯一顺序锁定。）

**一句话**：Annie 只在第 3 步想拦时出手，其余全自动；Tadashi 负责「怎么发」+ 止血机制；客户负责「不行就 rollback」。

---

## 11. Product-vs-Eng owner 汇总

| 决定点 | owner |
|---|---|
| 两档节奏 + 各档频率（含分频目标 Flavio 6h/GeoForge3D 24h） | **产品** ✓ |
| 判据 c 用哪些信号 + 严格度 + 状态语义（green/hold/unknown 阈值） | **产品** ✓（信号接线/freshness 实现=工程） |
| auto-ship opt-out + fail-closed 规则 + 否决窗口时点 | **产品** ✓ |
| promote = Option 2 干净版本号 | **产品** ✓ |
| 保留期 14/28 天（supersede 后） | **产品** ✓ |
| 客户升级=自动更新器 B / 回滚 / 止血是否更自动 | **产品** ✓（机制=工程） |
| 范围=只 flywheel | **产品** ✓ |
| Bridge 按项目分频（B6） / R2 vs S3 选型 + lifecycle / 打包+断言+CI / npm+R2+manifest 发布不变量实现 / 自动更新器+quarantine+rollback 机制 / 版本 tag 注入 + FLY-942 信号归因+heartbeat + 判据聚合 | **工程（Tadashi）** |

---

## 12. Success metrics

- **减 human-in-loop**：对外 release 中走「沉默默认发」的比例（越高越好）；Annie 主动操作占比（越低越好）。
- **发布安全**：`hold`/`unknown` 时零「误自动发」；auto-ship 版本客户侧崩溃/quarantine 率（越低越好）。
- **判据有用**：Annie 点「别发」的版本事后确认「确实该拦」的命中率（衡量判据 c 信号质量，v1 允许 bias）。
- **止血速度**：从发现坏版到 central quarantine 生效（客户不再自动升坏版）的时延。
- **发布正确性**：dangling manifest / 错误 payload 事件数 = 0（§7.3 不变量守住）。
- **零源码暴露**：4 道发布安全门全绿、零违规。

---

## 13. Open questions（交 Annie/Tadashi 收口）

1. **否决窗口具体钟点**（早报后到「下午几点」自动发）—— Annie 定一个值。
2. **较晚 crash-loop 是否自动降级**（区别于 §8.3 已定的即时失败自动回滚）—— Annie 定。
3. **对外 release 频率最终值**（默认每周，可配）—— Annie 定。
4. **免费/付费分档**何时开（B 渠道已留口子）—— 将来单独 issue。
5. **客户 changelog**：客户看不看得到「这版改了啥」—— 未定。
6. **Bridge 按项目分频（B6）优先级**（决定 §3 目标态多久落）。
7. **判据 c 各信号的 freshness 窗口 + 候选最低 soak 具体数值** —— 工程给建议、产品拍。

---

## 14. Build issues 拆分 + 激活依赖序（Codex R1#7）

> 落地全归 eng；related FLY-1062。**区分「可并行写代码」与「可激活」——** auto-ship 绝不能先于「可撤回发布 + 更新器 + 判据健康 + quarantine」落地。

- **B0（先锁合同）**：版本/channel/manifest 合同（§6 规范化版本、§7.2 通道真相、§7.3 不变量、manifest 字段）—— 其余都依赖它，先定。
- **B1 · 发布流水线 P4**（FLY-1062 PR4 主体）：薄壳 `npm publish`（2FA/OIDC）+ payload immutable-key 上传 R2 + 回读验 hash + manifest CAS 切指针 + 版本机器断言接 CI + 撤版。
- **B2 · R2 payload 托管 + 端点**：R2 私有 bucket + 验 key 薄端点（entitlement 分级 presigned GET）+ lifecycle（current 不过期 / supersede 后 14/28 天）+ license key 签发/校验/吊销（薄）。**B1+B2 可并行写，但联合 E2E 后才启用。**
- **B3 · 判据 c 聚合**：消费 FLY-942 原始事件 + **新增版本归因 + watchdog heartbeat/源健康** + 报 bug 打版本 tag 聚合 + Annie 👍/👎 + 产出 `green/hold/unknown` + 日报呈现。接同一版本身份（依赖 B0）。
- **B4 · auto-ship-on-silence**：opt-out + fail-closed 状态机（§5.2）+ 否决窗口（绑定不可变候选、delivery-receipt、单次开）+ 记账。**B4 最后，依赖 B1+B2+B3；且必须先 shadow/observe → 手动 E2E → 在 B5/central-quarantine 验证后灰度启用。**
- **B5 · 客户自动更新器 + 止血**：定时更新器（查 customer-release→装→即时失败回滚，单飞）+ central quarantine/withdraw（摘 pointer + 阻止再升 + 客户端记 quarantined 不重装）+ `flywheel rollback` + `flywheel install <旧版>`。
- **B6 · Bridge 按项目分频**（独立泳道）：只阻塞 §3「每项目 beta 分频目标态」，**不阻塞** flywheel-only 每周 release / 判据聚合 / auto-ship。可与 B0-B5 并行，不在 critical path。

**激活序**：B0 → (B1‖B2 联合 E2E) → B3（同版本身份）→ B5（同 manifest 的 install/update/rollback/quarantine 验证）→ **B4 最后灰度**。B6 独立。

---

## 附录 · co-eval 决定溯源（8 轮，2026-07-09~10）

| 轮 | 折进的决定 |
|---|---|
| r1-r2 | 两扇独立门（REQ-0）+ 渠道 grounding（B 已锁，FLY-1062 §5） |
| r3 | 两层 beta/release 模型 + 免费/付费路径 + 版本命名雏形 + 去黑话 |
| r4（真研究） | 具体机制 + owner 标签 + payload 托管（R2/Keygen 对比）+ Keygen 免费档 10-release 上限 |
| r5 | promote=Option 2 · 分受众节奏 · 收窄 flywheel · R2+auto-expire · 点头 option |
| r6 | 点头=Option 3（每日日报）· 保留期 14/28 天 · 判据+auto-updater 具体化（三档后 r7 砍两档） |
| r7 | 判据 c 三信号聚合（复用 FLY-942/1045）· 客户回滚 · 每周流程 + checklist |
| r7→8 | Beta 每项目分频（现状全 6h/目标可配）· ⭐ auto-ship-on-silence（opt-out + 安全闸 + 否决窗口） |
| r8 | Annie 圈定否决窗口（早报→下午）+「可以收 PRD」→ 本文 |
| Codex R1 | fail-closed 状态机 + payload 通道单一真相 + lifecycle 不删 current + 发布不变量 + quarantine + grounding 更正 + 激活时序（8 项折入本稿） |
