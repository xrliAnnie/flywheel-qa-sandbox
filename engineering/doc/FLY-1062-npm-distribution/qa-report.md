# FLY-1062 Buddy onboarding 分发层(npm 安装包) — QA 报告

Issue: FLY-1062 (https://linear.app/geoforge3d/issue/FLY-1062)
日期: 2026-07-09
基于: plan.md · exploration.md · research.md · packaged-path-audit.md

> **范围界定(重要)**:本 PR = **PR1 = P0 + P1 + P2**(打包流水线 + packaged-mode
> runtime seams),对应 PR 标题 "packaging pipeline + packaged-mode runtime
> (P0+P1+P2)"。**客户侧那条 `npm install <包>` 命令本身(P3 公共薄壳 + license
> key 换 payload)与托管/key 渠道基建(P4)不在本 PR** —— plan §1 与 progress.md
> 都明确把它们列为「同 issue 下一圈」。因此 PR1 交付的是**地基**(可发布 payload
> tarball + 从包里能起来的 runtime),**不是**客户能直接 `npm install` 的成品体验。
> FLY-1023 关单(Annie 的完整硬要求)仍需 P3/P4。此分档是 brainstorm gate 已批的
> 设计,QA 据此验 PR1 自身正确性,并把这条 scope 边界明确交给 founder。

## 结论

**PASS(Round 3 re-verify,2026-07-09)** —— gate④ 经 implement 阶段 4 轮收敛
(anti-masking → normalization+detector → combo → **exact-line allowlist**)后,
Round-2 的零仓库访问绕过已根治:Codex 逐轮构造的每种绕过形态(masking / 大小写 /
引号分割 / 双空格 / `git -C` / 双宽行 joint-clear / 反斜杠续行分割)全部被拒,且真
payload 仍逐字过门(无误判)。QA 另行独立构造 7 种 M1-M9 未覆盖的仓库访问拼写
(SSH URL / `gh repo clone` / tab 分隔 / 全大写 / slug-only `git fetch` / 缩进 /
纯注释)——全部正确拒绝,并把这 7 例落成 committed 回归测试。verdict 由 Round-2 的
FAIL 翻回 **PASS**。详见下方「Round 3」。

> **FAIL / KICKBACK(Round 2,已被 Round 3 修复推翻)** —— 补跑被 pipeline 跳过的
> FLY-827 codex code review 后,codex 抓到 **1 个 HIGH**,QA 已独立复现:**gate④
> 零仓库访问不变式可被绕过**(详见下方「Round 2」)。这正是 PR1 存在的核心保证
> (Annie 硬要求),故当时 verdict 由 PASS 翻为 FAIL,踢回 implement 阶段修 gate④。
> 其余项(打包流水线、三处 seam、P2 prebuilt、真 npm 全链「装得上≠起得来」、字节
> 兼容)Round 1 均验过为真,见下。

> **Round 1(初判 PASS,已被 Round 2 推翻)**:打包流水线、packaged-mode 三处 seam、
> P2 prebuilt provision/setup、发布安全门都经真实行为验证;「装得上 ≠ 起得来」验收
> 线在真 npm 全链上过关。**但 Round 1 漏了 gate④ 的 masking 路径**(既有 G4 负例注入
> 的是未注册引用,从没走过「私仓 slug 与已注册 git-clone 子串同行」),故 codex 补
> review 抓到、我复现确认。教训:发布安全门的负例必须覆盖「注入到已注册文件」这条。

## 验证矩阵

### 1. Hermetic 套件(本地全绿,与 CI 接线一致)
| 套件 | 结果 | 覆盖 |
|---|---|---|
| package-onboard.test.sh | 26/26 | assembly / 依赖并集 / 4 道发布门(含注入负例)/ 兼容镜像 / force-nest / 审计表闭包 / PR1 no-publish 守卫 |
| packaged-seams.test.sh | 13/13 | bridge-wrapper·daily-standup·update·converge·linux-preflight·supervisor **两侧**(packaged 走新路 + monorepo reverse-compat sentinel 逐字不变) |
| setup-prebuilt.test.sh | 6/6 | prebuilt deps 去 pnpm + cc fallback / manifest slug=null / host.json flywheelDir / monorepo 逐字 sentinel |
| provision-prebuilt.test.sh | 6/6 | repos 跳 flywheel clone+pnpm / host-config lib 闭包 / 拷贝态 wrapper 解析 current / packaged bootstrap 装四类服务 / monorepo sentinel |
| **packaged-restart.test.sh(QA 新增)** | **5/5** | P3 restart 脚本:哨兵拒绝 · bridge/leads 经 supervisor seam 重启 · 健康门 · rc 传播 |

### 2. 真 npm 全链 install 冒烟(package-onboard-smoke.test.sh)— 12/12
真 `npm pack`(带全部门)→ 真 `npm install --prefix`(registry 拉依赖并集)→ 在**真实安装布局** PKG_ROOT 上:
- ①a-c 打包+装+PKG_ROOT 哨兵/版本一致(v1.55.0)
- ②a-d 兼容镜像:`packages/teamlead` symlink + `claude-lead.sh`/`flywheel-comm` 路径合同成立;vendored 嵌套依赖(teamlead `@linear/sdk@60.0.0`、claude-runner `@anthropic-ai/sdk@0.77.0`)就位;空 husk 目录已剪
- ③ `agents/generic-executor.md`+`qa-executor.md` 从 PKG_ROOT 可解析(run-infra sentinel)
- ④a **每个内嵌包 bare-import 零 MODULE_NOT_FOUND**
- ④b **better-sqlite3 native module 加载成功**(本机 Node 25.6.1,install script 真跑了 prebuild/编译)
- ④c **packaged Bridge(dist/run-bridge.js)起来并服务 /health**
- ④d **Lead launcher dry-run 从安装树经镜像路径吐出 launch plan**

→ 「装得上 ≠ 起得来」验收线(plan P0-4 / Codex R1#1)在真链上通过。

### 3. 零仓库访问不变式(Annie 硬要求,打包层)— 独立复核 PASS
- gate④ 逻辑:对**解包后的 tarball** grep `git clone` + `xrliAnnie/`,任何未登记命中 fail(读源确认 + G4 负例测试证明拦截生效)。
- 真 tarball 过 gate④(冒烟 ①a)。
- 独立逐条核对 packaged 脚本里的每处命中:
  - `flywheel-onboard.sh` 的私仓 `git clone` → **组装期 `po_patch_onboard` 剥除**(A2 测试 + assembly 断言 line 166),不进 tarball;
  - `flywheel-setup.sh`/`flywheel-buddy-steps.sh`/`host-config.sh` 的 `xrliAnnie/flywheel(-skills)` → 全在 audit-grep-allowlist 登记(prebuilt 置 slug=null / skillsRepo 默认从不 fetch);
  - `provision-fleet-host.sh` 的 clone = **客户自己项目仓**(登记);
  - `test-deploy.sh`/`fleet-capture.sh`/`verify-anna-isolation.sh`/`sync-gbrain-docs.sh` = **不在打包白名单**,不进包。
- SSH(`git@github.com:xrliAnnie/…`)/`gh repo clone xrliAnnie/…` 均含 `xrliAnnie/` 子串 → 被 grep 覆盖;现存私仓仅 xrliAnnie 名下两个 → grep 面充分。

### 4. 字节兼容 / 黑话红线
- 5 处 seam 全 additive,按 `.flywheel-prebuilt` 哨兵或 `dist/run-bridge.js` 存在性分支;monorepo 侧逐字保留(reverse-compat sentinel 各测)。**不装包的机器(含 Annie 生产全 fleet)逐字不变。**
- 客户可见新话术仅 update 拒绝 + preflight 提示,均**诚实中文**(如「这台机器上的 Flywheel 是安装包形态,不能用这个老的更新方式」),守黑话红线。
- fleet-sanitize 重构:vendor regex 抽成共享 `_fleet_vendor_re()`(pattern 逐字一致),新增 code-tree 三层扫描(vendor 全树 + 高熵全树 + config-class 文件全网),对旧 caller byte-compat。

### 5. 质量
- 全部新增/改动脚本 `bash -n` 语法干净。
- shellcheck(-S warning)仅 4 条 cosmetic:`package-onboard.sh:707` SC2034(`line` 声明未用,无害)、`:715` SC2053(RHS 不加引号 = **有意 glob 匹配** allowlist)、`bootstrap-services.sh:102` SC2043(单元素 loop,扩展保留)、`supervisor.sh:253` SC2155(**PR 前既有代码**,不在本 diff)。**无功能 bug;CI 不跑 shellcheck(只 `pnpm lint`=biome/TS),故不 fail CI。**
- 本 PR 零 `.ts` 改动 → biome lint 不受影响。

## QA 补测 + 修正(已提交本分支)
1. **新增 `scripts/__tests__/packaged-restart.test.sh`(5 例)** + 接入 CI —— 关闭覆盖缺口:审计表原声称 `restart-packaged-services.sh` 由 packaged-seams.test.sh 覆盖,但该套件零引用它。新测试直测:哨兵拒绝 / bridge-only(--no-leads)/ bridge+每个 lead 经 supervisor seam / 健康门失败 exit 1 / lead restart 失败 rc 传播。
2. **修正 `packaged-path-audit.md` 第 40 行**覆盖声明,指向新测试(诚实化)。

## Round 2 — FLY-827 codex code review(补跑)+ kickback finding

Pipeline 跳过了 FLY-827 codex code review(await-codex-gate 没拦住),Lead(Tadashi)
要求补上。我用 codex companion(xhigh,前台)对 head 253673a8 跑了 Round 1,codex 也
独立探查了 codebase + 真跑了各测试。

**codex verdict: CHANGES REQUESTED** —— 1 个 HIGH(其余全绿:codex 也复跑了
26+13+5+6+6 hermetic + 真组装/打包 tarball 过现有门 + `git diff --check` 干净)。
codex 自身沙箱断网发不了 PR review,我已代发到 PR #531(标注代发)。

### HIGH — gate④ 零仓库访问不变式可被绕过(QA 独立复现确认)
- **位置**:`scripts/package-onboard.sh` po_gate ④ 的匹配循环(~:708–723,masking 源在 `:715` 的 `[[ "$text" == *"$apat"* ]]` **松散子串**匹配)+ `scripts/packaged/audit-grep-allowlist.tsv`。
- **机制**:gate④ 对每个 `git clone`/`xrliAnnie/` 命中行,只要匹配**任一** allowlist 行(文件 glob + 松散子串)就放行。真 allowlist 有一条宽泛的 `provision-fleet-host.sh` + `git clone`(合法的客户仓 clone)。于是一行 `git clone https://github.com/xrliAnnie/flywheel.git` 因含 `git clone` 子串被放行,**同一行里的私仓 `xrliAnnie/` slug 再也不会独立触发失败**。
- **复现(codex + QA 各自独立)**:干净 payload → `po_gate` PASS(应然);把真私仓 clone 注入到那条 allowlisted 行 → `po_gate` **仍 PASS**。这是 PR1 存在的核心保证被击穿。
- **live 影响**:当前 payload **不** ship 可达私仓 clone(prebuilt 模式跳 flywheel clone + onboard clone 组装期 patch 掉),所以**今天没有真泄漏**;但守护该不变式的门可被骗过 → 未来某次改动可能悄悄重新引入仓库访问。严重度 = HIGH(门完整性 = PR1 的意义本身)。
- **fix direction(交 implement 阶段,QA 不自改)**:让 registered-check 对每个 forbidden pattern 独立判定(`git clone` 的 allowlist 行不得放行同时含未注册 `xrliAnnie/` slug 的行),或把 allowlist 行收紧成 exact-line-shape 而非松散子串。
- **QA 已落地(本分支,RED→GREEN 目标)**:新增 `scripts/__tests__/gate4-allowlist-masking.test.sh` + 接入 CI —— M1(sanity:未 mask 的私仓 slug 被拒,证门是活的)PASS;**M2(注入到已注册 git-clone 行的私仓 slug 必须被拒)现 FAIL**,钉住 bug。implement 修好 gate④ 后 M2 转 GREEN、CI 转绿。

**处置**:qa-result = **fail**(retract Round 1 的 premature PASS),踢回 implement 阶段。
注:Round 1 我在 codex 门满足前就发了 qa-result pass + 开了 approve gate(过早),现经
qa-result fail 纠正;head 移动后旧 gate 绑定自然失效,re-verify PASS 后再开新 gate。

## Round 3 — gate④ 修复 re-verify(2026-07-09,PASS)

implement 阶段在同分支上对 gate④ 做了 4 轮收敛(commits `7d780e13`→`4ded7064`),
Codex code review 每轮独立构造新绕过、逐轮击杀,最终落到 **exact-line allowlist +
detector** 的闭形式(`package-onboard.sh` po_gate ④ + `po_g4_norm`/`po_g4_detect` +
`audit-grep-allowlist.tsv` 重写为 6 条精确行)。QA 在新 head(`4ded7064`)独立复验:

### 1. 回归测试全绿(committed 本分支)
| 套件 | 结果 | 覆盖 |
|---|---|---|
| **gate4-allowlist-masking.test.sh** | **9/9** | M1 sanity(门是活的)· M2 Round-2 masking bug 现 GREEN · M3-M6 normalization 变体(小写/引号分割/双空格/`git -C`)· M7 exact-registered 正例仍放行 · M8 Round-3 combo joint-clear · M9 Round-4 反斜杠续行分割 |
| **gate4-forms-probe.test.sh(QA 新增)** | **12/12** | QA 独立构造、M1-M9 未覆盖的仓库访问拼写:F1 SSH URL · F2 `gh repo clone` · F3 tab 分隔 · F4 全大写 · F5 slug-only `git fetch` · F6 缩进 · F7 纯注释提及 slug —— 全拒;**detector 隔离(Codex R1 加固)**:C1-C3 clone-only(无 slug,独立锁 clone 探测器) · S1 slug-only(无 clone,独立锁 slug 探测器);P1 精确注册行仍放行(正控)。每条负例断言拒绝确实来自 gate④ `UNREGISTERED repo-access`(防其他门误绿) |
| package-onboard.test.sh | 26/26 | 无回归 |
| packaged-seams / packaged-restart / setup-prebuilt / provision-prebuilt | 13 / 5 / 6 / 6 | 无回归 |

### 2. 真 payload 无误判(关键)
`package-onboard-smoke.test.sh` 12/12,其中 **①a「gated tarball produced」= 真组装
payload 逐字过 R4 exact-line gate④**。exact-line 语义最严(每条 `git clone`/slug 行
必须归一化后与 6 条注册行之一逐字相等),若真 shipping 行与注册行有任何偏差,组装即
在打包步 fail —— 现通过,证明 6 条注册行精确对齐真 payload,修复没引入 release 阻断。

### 3. 修复正确性 — QA 独立判断(不只跑实现者的测试)
- **闭形式方向正确**:比较键两侧都用同一个 bash `po_g4_norm`(自洽);awk twin 只决定
  「哪些行被送审」,其归一化+探测正则与 `po_g4_detect` **逐字 in-lockstep(等价)**
  (源码注释明写「MUST stay in lockstep with the awk twin」)。安全裕度:即便二者未来
  漂移,唯一危险方向是 awk 漏判(该行不被送审);而 awk 若比 bash 更宽只会多送审=
  fail-safe。QA 的 C1-C3 clone-only 探针独立锁死 clone 探测器(不被 slug 探测器遮蔽)。
- **不变式覆盖面充分**:访问私仓 flywheel 必然在某处出现 `xrliAnnie/` slug(slug 探测器)
  或 `git … clone`(clone 探测器);SSH host 形 `git@github.com:xrliAnnie/…`、`gh repo
  clone xrliAnnie/…`、`codeload.github.com/xrliAnnie/…` 均含 slug 子串 → 被 slug 覆盖。
  QA 的 F1-F7 实测印证。
- **snapshot 纪律**:新增/改动任何带 forbidden 形态的行都会 fail 直到显式重注册——
  这正是 Annie 硬要求想要的「未来某次改动不能悄悄重引入仓库访问」的结构性保证。

**处置**:qa-result = **pass**(re-verify),QA 作为本三段流水线 ship executor 开 approve
gate。scope 边界不变(见文末):PR1 = 分发层地基;客户可直接 `npm install` 的 P3/P4
仍是 FLY-1023 关单前同 issue 下一圈。

## 交给 founder 的 scope 边界(非缺陷)
PR1 是**分发层地基**:它让 monorepo 能被组装成一个自洽、能起来的 payload tarball,且
不装包的生产机器零变化。但客户还**不能**直接 `npm install` —— 那条命令(P3 薄壳)+
托管/key 渠道(P4)是**同 issue 下一圈**。**FLY-1023 关单需 P3/P4 落地后才算完成。**
