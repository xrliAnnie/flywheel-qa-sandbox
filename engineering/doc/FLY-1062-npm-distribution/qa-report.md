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

**PASS**(PR1 范围内)。打包流水线、packaged-mode 三处 seam、P2 prebuilt provision/
setup、发布安全门(含 Annie 硬要求的**零仓库访问不变式**)全部经真实行为验证通过;
「装得上 ≠ 起得来」验收线在**真 npm 全链**上过关。QA 补一个此前缺失的直测,关闭
审计表声称却未落地的覆盖缺口。

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

## 交给 founder 的 scope 边界(非缺陷)
PR1 是**分发层地基**:它让 monorepo 能被组装成一个自洽、能起来的 payload tarball,且
不装包的生产机器零变化。但客户还**不能**直接 `npm install` —— 那条命令(P3 薄壳)+
托管/key 渠道(P4)是**同 issue 下一圈**。**FLY-1023 关单需 P3/P4 落地后才算完成。**
