# FLY-1062 PR2 公共 onboard-shell — QA 报告

Issue: FLY-1062 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: pr2-thin-shell.md · plan.md §P3 · qa-report.md(PR1 那一圈)

> **范围界定**:本报告验的是 **PR2 = 公共薄壳包 `@flywheel/onboard`**(PR #541,
> commits `da6ea8d6`→`d5e4be59`,PR1 #531 已 merge 于 `5c6c14f0`)。PR2 落客户「一
> 条 `npm install`」的**全部薄壳逻辑**——凭 key 换打包产物、装、原子翻 current、exec
> onboard——端点用 **stub HTTP** 测。真 gated 端点 / key 服务 / 托管 = PR3;薄壳
> `npm publish` / payload 上传 CI = PR4。**这是 brainstorm gate 已批的 PR 拆分**
> (pr2-thin-shell.md §0)。见文末「交给 founder 的 scope 边界」。

## 结论

**PASS**(2026-07-10,head `d5e4be59` 独立复验)。PR2 薄壳的客户装链路、失败路径
(零半成品)、key 换发 + update seam、密钥零泄漏矩阵、公共包内容门,均经**真实行为**
验证(真 `npm pack` + 真 `npm install --prefix` + loopback stub 端点 + 隔离 temp-HOME)。
QA 另独立找出 3 个 implement 阶段测试**没钉住**的真实边界行为,逐一 live 探针确认实现
**正确**,并落成 committed 回归测试(见 §3)。无 kickback。

## 验证矩阵

### 1. Hermetic 套件(本地全绿,与 CI 接线一致)— 37/37
真 `npm pack` fixture payload → 真 `npm install --prefix` → 隔离 temp-HOME +
`FLYWHEEL_STATE_DIR`;stub 端点跑 loopback。

| 套件 | 结果 | 覆盖 |
|---|---|---|
| onboard-shell-install | 9/9 | A1 首装全链(隐藏读 key→Authorization 换 payload→sha256→install→镜像→原子翻 current→exec onboard.sh)· A1b key 落 0600 .env · A1c 版本进 journal 且 key 不进 · A1d/A1e key 不上 stdout + strip 出子进程 env · A2 二次直 exec 零端点请求 · A3 key 只走 header · A4/A4b setup 失败保留 install + 诚实话术 + 续传零重拉 |
| onboard-shell-negatives | 8/8 | N1 401 · N2 sha 不符 · N3 网络失败 · N4 env-key 无双开关拒 · N5 路径穿越版本(`latest:".."`)拒 + runtime sentinel 存活 · N6 缺脚本 payload 拒 · N7 误敲 key 当 arg 不回显 · N8 仅缺 restart seam 拒 |
| onboard-shell-rotation | 6/6 | R1 `license set` 验证+原子 0600 覆写+续装 · R2 stored key 401→隐藏轮换一次→成功 · U1 already-latest 不重翻 · U2 update 新版本装+翻+restart+journal · U3 不健康重启→回滚到旧版本 · U4 update 前 strip key 出 restart 子进程 env |
| onboard-shell-secret | 6/6 | S0 装+update 真发生(防「absent 白过」)· S1 key 全 state 树只在 .env · S2 不上 stdout/stderr · S3 不进 journal · S4 strip 出 onboard.sh env · S5 只走 Authorization header |
| onboard-shell-publish-gate | 5/5 | G1 无 scripts/packages/agents/tgz · G2 打包内容 = 精确注册文件集(subset+superset)· G3 零 `xrliAnnie/` · G3b secret-scan 干净 · G4 `private:true`(PR2 不发布) |
| **onboard-shell-qa-gaps(QA 新增)** | **3/3** | 见 §3 |

### 2. 独立红线复核(不靠实现者的测试,QA 亲手验)
Annie 的两条硬红线,我亲手 `npm pack` 公共薄壳后逐条看:
- **零源码暴露**:客户 `npm install` 收到的**只有** `README.md + bin/flywheel-onboard.js + lib/*.mjs(9)+ package.json` = 12 文件,精确等于注册集;**内部面 scripts/packages/agents/tgz 命中 0**。
- **零仓库访问**:包内 `xrliAnnie/` 私仓 slug 命中 **0**;`git clone`/`gh repo clone`/`git@github` 命中 **0**。私仓源码(payload IP)绝不进公共包。
- **密钥红线**:key 只走 `Authorization: Bearer`(A3/S5 keylog 证);持久化后 strip 出所有子进程 env(A1e/S4/U4);全 state 树 grep key 只在 0600 `.env`(S1)。

### 3. QA 独立补测(committed 本分支)— `onboard-shell-qa-gaps.test.sh`
通读实现后独立识别 3 个 implement 阶段**在代码里走到、但无断言钉住**的真实行为。
每个先 live 探针确认实现**正确**(非 bug),再落成回归测试锁死:

- **Q1 协议错误 → generic 而非 network 消息**:manifest 返 200 但 body 非 JSON →
  `EndpointError("protocol")` → `messageFor` → `MSG.generic`。N 系列覆盖了
  网络/校验/401,但**从没测过坏 manifest**。若这条错走成 network 消息,会误导客户去
  查网络(Codex R1#7 明修的诚实话术)。**探针实测**:走 generic「安装没能完成…」、
  **不**含「连不上安装服务器」、current 未建、零残留。→ 锁死。
- **Q2 无旧版本 + update 不健康重启 → degraded 而非虚假 rollback**:rotation 的 U3
  只测了「有好旧版本」的 happy rollback。当**没有**旧版本可回退时,`update.mjs` 删掉
  失败的新版本目录、丢掉 current symlink、报 `updateRollbackDegraded`——它绝不能谎称
  「已切回上一个能用的版本」。**探针实测**:走「这台机器现在可能处于不完整状态…」、
  **不**含「已经自动切回上一个能用的版本」、current 不悬空指向已删目录、版本目录已清。→ 锁死。
- **Q3 persistKey 拒 symlink .env(安全红线)**:若 `.env` 是指向攻击者控制文件的
  symlink,persistKey 必须 throw 而非把 key 写穿 symlink。**无 implement 测试覆盖**。
  **探针实测**:persistKey throw「refusing symlink env file」,symlink 真实目标内容
  **未被改动**(secret 未落地)。→ 锁死。

CI 接线:6 个套件全接进 `.github/workflows/ci.yml`「Test — FLY-1062 PR2 onboard-shell」step。

### 4. 字节兼容 / scope 隔离
- PR2 diff(`5c6c14f0..HEAD`)**只碰**:新独立包 `packages/onboard-shell/`(零 workspace
  依赖、零 `flywheel-*` 依赖、零 `dependencies`)+ `ci.yml` 一段新 step(additive)+
  `pnpm-lock.yaml` 2 行 + doc。**零现有运行件改动** → 不装这个包的机器(含 Annie 生产
  全 fleet)逐字不变。
- 客户可见话术全**诚实中文**(黑话红线继承 1023):失败按种类给「发生什么+怎么办」,
  从不泄漏路径/密钥/内部术语。

### 5. 质量
- 6 个测试脚本 `bash -n` 干净;新 `onboard-shell-qa-gaps.test.sh` 同。
- `biome check`(仓库 lint,v2.1.4)对新包 bin+lib 10 文件 **0 issue**;PR2 零 `.ts` 改动
  → 现有 biome 面不受影响。
- `ci.yml` 编辑后仍是有效 YAML(`yaml.safe_load` 过)。

## QA 补测/改动清单(committed 本分支)
1. **新增 `packages/onboard-shell/__tests__/onboard-shell-qa-gaps.test.sh`**(Q1/Q2/Q3,3 例)。
2. **`.github/workflows/ci.yml`** 把 qa-gaps 套件接进 PR2 step(第 6 个)。
3. **本报告** `pr2-qa-report.md`。

## 交给 founder 的 scope 边界(非缺陷)
PR2 = **客户薄壳逻辑本体**,端点用 stub 测。它证明了:凭一个 license key 就能换到
打包产物、装成一个自洽能起来的 runtime、全程零仓库访问零源码暴露、失败零半成品、密钥零
泄漏。但客户**还不能真的今天就 `npm install`**——因为:
- 真 gated 端点 + key 服务 + 托管 = **PR3**(端点现是占位常量 `onboard.flywheel.invalid`);
- 薄壳 `npm publish`(现 `private:true`)+ payload 上传 CI = **PR4**。

**FLY-1023 关单(Annie 的完整硬要求「customer 不接触源码」)需 PR3/PR4 落地后才算完成。**
PR2 是这条链路上「客户命令本身」那一环,已可 ship 且被独立验为正确。
