# FLY-1062 Packaged-Path 审计表 — 实施产物(P0-2)

Issue: FLY-1062 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md(P0-2 审计表 + 闭包规则)

> **本表是进包边界的单一真相**(Codex R1#5)。枚举 payload 白名单(`scripts/package-onboard-files.allow` ↔ `PO_SCRIPT_FILES`)内每个脚本中引用 `FLYWHEEL_DIR` / `packages/` / `git clone` / `pnpm` / `tsx` / `agents/` / `restart-services` / `flywheel-daemon` 的位点,逐行定处置。
> **闭包规则**:① 表外脚本进包即 fail(`package-onboard.test.sh` 断言白名单全集被本表覆盖);② 兼容镜像集合 = payload package.json 的 `flywheelPackagesMirror`(由 `PO_PACKAGES` 生成);③ wrapper 拷贝到 `<state>/bin` 时必须随行的支撑 lib = `lib/host-config.sh`(bootstrap-services.sh + provision prebuilt 分支同步安置);④ 嵌套 vendoring 双表 = `dependency-union-exceptions.tsv`(声明冲突)+ `force-nested-deps.tsv`(装机期 peer/hoist 冲突,实测发现:mem0ai peer 把 @anthropic-ai/sdk ^0.40 顶到 prefix 顶层、npm 在 bundled 树内 reify 失败留空壳目录遮蔽平铺副本 → create-compat-mirror 安装期清空壳 + vendor 副本嵌套安置)。

## 处置类型

- **included-and-patched** — 进包,且带 packaged 分支(`.flywheel-prebuilt` 哨兵判据,additive + reverse-compat sentinel);
- **included-mirror-covered** — 进包,`packages/` 路径引用经安装期兼容镜像(`packages/<dir> → node_modules/flywheel-<name>`)原样成立,零改动;
- **included-guarded** — 进包,引用带 `[ -f ]`/`[ -x ]` 守卫,目标缺失时优雅降级,零改动;
- **included-unreachable** — 进包,但引用位点在客户路径上不可达(测试锁);
- **assembly-patched** — 进包,但打包期由 assembly 改写(不是运行时分支);
- **monorepo-only / excluded** — 不进白名单;客户路径不得调用(负例测试锁)。

## 表 · scripts/(payload 顶层)

| 脚本 | 引用位点(非注释) | 处置 | 证明 |
|---|---|---|---|
| flywheel-onboard.sh | `:85 git clone $FO_REPO_URL`(私仓 fetch 皮) | **assembly-patched** — `po_patch_onboard` 打包期整块替换 fetch 分支为诚实报错 + 删 `FO_REPO_URL` 默认;锚点缺失即 build fail(漂移守卫) | package-onboard.test.sh(patch 后零 `git clone`/零 `FLYWHEEL_ONBOARD_REPO`、`FO_BUDDY_SHELL` 保留、锚点漂移负例) |
| flywheel-buddy.sh / flywheel-buddy-steps.sh / lib/buddy-escalate.sh / lib/buddy-connect.sh | 无命中(buddy-captain-preview 见下) | included(零改动) | gate④ 全树 grep |
| lib/buddy-captain-preview.sh | `:35 packages/teamlead/scripts/claude-lead.sh` | **included-mirror-covered** | package-onboard-smoke.test.sh(镜像后路径合同成立) |
| flywheel-setup.sh | `:289 packages/teamlead/dist/bin/validate-projects.js`(真 loader 门);`:292` 报错文案含 pnpm;`:417` deps_json pnpm 条目 | **included-and-patched**(FLY-1062 P2-2/P2-3 已落):prebuilt 分支换 deps_json(去 pnpm、补 cc 兜底)、manifest flywheel slug=null、host.json 写 `flywheelDir=~/.flywheel/runtime/current`;validator 路径经镜像成立;`:292` 是 validator 缺失时的报错文案(客户树 validator 必在,佐证=冒烟②) | setup-prebuilt.test.sh(prebuilt 两分支 + 无哨兵 byte-compat sentinel) |
| provision-fleet-host.sh | `:107-110` 忽略继承 env;`:292 git clone`(manifest 驱动);`:303-304 pnpm install/build`;`:336` 拷 restart-services.sh;`:484/:501-502` darwin 叙述文案 | **included-and-patched**(FLY-1062 P2-1/P2-4/P2-5 已落):prebuilt 跳 flywheel clone + 跳 pnpm;`:292` 保留給**客户自己项目仓**(gate④ 注册行);`:336` 循环带 `[ -f ]` 守卫 — packaged 树无 restart-services.sh → 自然跳过(测试锁);phase_launchd prebuilt 路由 packaged bootstrap,restart-services/flywheel-daemon 不出现在执行路径 | provision-prebuilt.test.sh(零 clone/零 pnpm stub 断言 + restart-services 不安置 + 无哨兵 sentinel) |
| daily-standup.sh | `:9 FLYWHEEL_DIR` 自身推导;`:40` restart.lock.d 注释级检查;`:64 packages/teamlead/dist/bridge/plugin.js` 探测;`:76-79` dist/run-bridge.js 分支(P1-3 已落) | **included-and-patched**(P1-3)+ `:64` **included-mirror-covered**;`:65` 报错文案 pnpm 仅坏安装可见 | packaged-seams.test.sh(两侧)+ 冒烟②(镜像) |
| flywheel-bridge-wrapper.sh | `:30 FLYWHEEL_DIR` 默认(host.json 覆盖);`:63 lib/bridge-port.sh`;restart gate + bounded meta-alert 路径;dist 分支 | **included-and-patched**(P1-2);restart gate 及告警闭包全部进包;FLYWHEEL_DIR 经 host.json flywheelDir=current 解析 | packaged-seams.test.sh(由真实脚本 assembly 构造 packaged fixture,验证 gate 闭包 + dist 分支两侧)+ provision-prebuilt.test.sh(host.json) |
| flywheel-lead-wrapper.sh | `:35 FLYWHEEL_DIR` 默认;restart gate + bounded meta-alert 路径;`packages/teamlead/...` | **included-mirror-covered**(launcher 经兼容镜像)+ restart gate 及告警闭包全部进包 + host.json flywheelDir | packaged-seams.test.sh(gate 闭包)+ 冒烟②(claude-lead.sh 路径合同)|
| flywheel-lead-wrapper-v2.sh / flywheel-lead-attach.sh / flywheel-view-attach.sh / flywheel-node-status.sh / lib/lead-address.sh / teamlead:scripts/lead-body.sh / teamlead:scripts/lib/lead-body-receipt.sh (FLY-1663/FLY-1884) | v2 launchd carrier 与 cmux 可见面的完整运行时闭包；wrapper 直接启动 private tmux server，body/receipt 承担一次性 Claude 进程与 resume 三振，lead attach 负责 Lead 持久重连，view attach 负责 runner 镜像重建后的持久重连，node status 负责无窗口节点的非空白状态面 | **included runtime closure**；packaged bootstrap 按 projects.json `carrier` 选择 v1/v2，未知值 fail-close | package-onboard.test.sh 白名单闭包 + packaged-seams.test.sh 安装闭包 + fly1663 runtime harness + fly1884-view-attach.test.sh |
| restart-storm-gate.py / lib/bounded-run.sh / lead-alert.sh / meta-alert.sh | wrapper 的 fail-closed restart gate;gate hold 的 Discord + 本地独立告警;gate 缺失时 wrapper 的有界同步本地告警 | **included runtime closure** — 四件缺一会导致 packaged Bridge/Lead 永久不起或静默;逐文件白名单,保持可执行位 | packaged-seams.test.sh S0(真实 assembly 产物四件齐全且可执行)+ wrapper seam |
| update-flywheel.sh | `:20 FLYWHEEL_DIR`;`:67-179 git fetch/pull`;`:76-77 restart-services.sh`;`:96 packages/flywheel-comm` | **included-and-patched**(P1-4 已落):prebuilt 哨兵 → 诚实拒绝 + 指向包更新命令,exit 3,git/restart-services 全部不可达;monorepo 逐字不变 | packaged-seams.test.sh(prebuilt 拒绝 + 无哨兵 sentinel) |
| converge-flywheel-bin.sh | `:61 FILES` 含 restart-services.sh(packaged 树永缺 → 每次 Lead 启动 rc=1 + 误报 alert);`ALERT_BIN` 默认 lead-alert.sh(现为 restart gate runtime closure 一部分) | **included-and-patched**(本 PR 新增):prebuilt 哨兵 → FILES 去 restart-services.sh(lead/bridge wrapper 照管);monorepo 逐字不变;ALERT_BIN 进包且调用仍以 `\|\| true` 守卫 | packaged-seams.test.sh(prebuilt 下 restart-services 缺失不告警不 rc=1 + 无哨兵 sentinel) |
| check-global-path-hygiene.sh + lib/path-hygiene.sh(FLY-1389) | 只读扫描器 + 判据库;converge 硬 source path-hygiene(缺 = converge 启动即死),`[ -f ]` 守卫 hygiene 挂载 | included(零改动;packaged 树 `.git` 非文件、非 temp 路径 → 判据天然放行) | converge-flywheel-bin.test.sh + check-global-path-hygiene.test.sh |
| teamlead:scripts/lib/resume-recovery.sh(FLY-1389) | claude-lead.sh 硬 source(缺 = Lead 启动即死,packaged smoke ④d 抓过) | included(零改动;纯函数库) | package-onboard-smoke.test.sh ④d |
| lib/lead-restart-lifecycle.sh + lib/lead-body-sweep.sh + teamlead:scripts/lib/lead-launch-authority.sh(FLY-1602) | claude-lead.sh 三个硬 source;缺任一文件都会让 packaged Lead 在 lease/adoption 前启动即死 | included(零改动;换代波协议、孤儿 body 证据与 launch authority 判据的运行时闭包) | package-onboard-smoke.test.sh ②b + ④d |
| linux-preflight.sh | `:110 for c in node pnpm git jq tmux gh`(--check 模式 pnpm 缺失 = 非零退出,阻断 packaged linux setup);`:119 corepack` 提示;`:122-129 FLYWHEEL_DIR/.git` 检查 | **included-and-patched**(本 PR 新增):prebuilt 哨兵 → 必需命令去 pnpm、checkout 检查改认哨兵;monorepo 逐字不变 | packaged-seams.test.sh(prebuilt 下无 pnpm --check 过 + 无哨兵 sentinel) |
| materialize-lead-manifests.sh | 无非注释命中 | included(零改动) | gate④ |
| lib/host-config.sh | `:104/:147 FLYWHEEL_DIR` 解析(FLY-650 seam);`xrliAnnie/flywheel-skills` 默认值 | included(零改动)— flywheelDir=current 正是本设计的接入点;skills 默认值 = gate④ 注册行(customer path 不 fetch) | host-config 既有测试 + provision-prebuilt.test.sh(拷贝态解析 current) |
| lib/supervisor.sh | `:235` darwin 叙述文案(flywheel-daemon.sh 字样) | **included-and-patched**(FLY-1062 已落):`FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1` opt-in 真 darwin 安装;默认 darwin 路径逐字保留 no-op(byte-compat) | packaged-seams.test.sh S11/S11b/S12 |
| lib/flywheel-log.sh(FLY-1887) | source-only 的按次 append 日志 rename 轮转库;不持有 launchd `StandardOutPath` / `StandardErrorPath` 文件描述符 | **included runtime closure** — packaged Lead/Bridge hooks 与 tmux rescue 共用 10 MiB + 3 代有界轮转;缺失时调用方只降级为不轮转,不阻断服务 | flywheel-log-rotate.test.sh(9/9,含 packaged allowlist 合同)+ package-onboard-smoke.test.sh(产物闭包) |
| lib/bridge-port.sh / lib/self-ship-queue.sh / lib/lead-body-evidence.sh / lib/fleet-sanitize.sh / lib/platform-deps.sh / lib/script-sanity.sh / lib/tmux-server-rescue.sh | 仅注释/自身逻辑命中；lead-body-evidence 是 claude-lead.sh 的 guarded 观测闭包(缺失只降级 unknown) | included(FLY-1671 增加 body provenance 观测库) | gate④ + package-onboard-smoke.test.sh(tmux 恢复与 body 观测依赖闭包) |
| packaged/create-compat-mirror.sh | `packages/` 命中 = 镜像自身逻辑 | included(FLY-1062 新增件) | package-onboard-smoke.test.sh |
| packaged/bootstrap-services.sh | 无非注释命中 | included(FLY-1062 新增件,P2-5) | provision-prebuilt.test.sh(temp-HOME 装四类服务) |
| packaged/restart-packaged-services.sh | 无非注释命中 | included(FLY-1062 新增件,P3 更新链用) | packaged-restart.test.sh(QA·FLY-1062 直测:哨兵拒绝 + bridge/leads 经 supervisor seam 重启 + 健康门 + rc 传播);supervisor seam 本体另由 packaged-seams.test.sh S11/S12 覆盖 |
| launchd 模板(scripts/launchd/*) | 模板内路径 | included — packaged bootstrap 不用这些模板(supervisor spec 渲染);进包仅作 linux/darwin 参考资产;updater plist 指向的 update-flywheel.sh 在 packaged 树自拒(P1-4) | packaged-seams.test.sh(update 拒绝) |

## 表 · monorepo-only(不进包,客户路径不得调用)

| 脚本 | 理由 | 客户路径不可达证明 |
|---|---|---|
| restart-services.sh | monorepo deploy 机器(git 状态检查 / pnpm build / tsx fallback / 硬编码 ~/Dev/flywheel) | 不在白名单(gate② 兜底);唯三运行时引用 = update-flywheel.sh(prebuilt 自拒,P1-4)、provision `:336`(`[ -f ]` 守卫自然跳过)、converge `FILES`(本 PR prebuilt 分支去除)— 三处全testcovered |
| flywheel-daemon.sh | 硬编码 ~/Dev/flywheel + 从树内拷 wrapper | 不在白名单;packaged 首装走 bootstrap-services.sh(P2-5),phase_launchd prebuilt 路由测试锁定 |
| cleanup-sessions.ts / e2e-*.ts / qa-* / __tests__/ / fleet-capture.sh / discord-bot-pool.sh / restart-* / self-ship 周边 | 内部运维/测试 | 不在白名单(gate② 兜底) |
| scripts/run-bridge.ts | TS 源(gate③ 禁 .ts) | 打包期编译为 dist/run-bridge.js(P1-1),import 重写指向 node_modules |

## gate④ 注册行(repo-access 引用)与其行为测试

`scripts/packaged/audit-grep-allowlist.tsv` 每行必须有行为测试(闭包规则):

| 注册行 | 行为测试 |
|---|---|
| provision-fleet-host.sh × `git clone`(客户项目仓) | provision-prebuilt.test.sh:prebuilt 全相跑通时 flywheel 条目跳过、客户仓条目照旧 |
| flywheel-setup.sh × `xrliAnnie/flywheel`(manifest 模板 slug) | setup-prebuilt.test.sh:prebuilt manifest flywheel slug=null |
| flywheel-setup.sh × `git clone`(注释文案) | gate④ 自身(substring 匹配注册)+ 冒烟(payload 内该行仍为注释) |
| host-config.sh / flywheel-setup.sh / flywheel-buddy-steps.sh × `xrliAnnie/flywheel-skills`(默认值) | setup-prebuilt.test.sh:客户 manifest `skillsSyncPresent:false`,packaged 路径零 skills clone(research 审计 A#4) |
| flywheel-comm `summary.js` / `summary-pr-merge.js` + founder-only-authority.md × Raya 自有仓名 | package-onboard-smoke.test.sh ④d/④e:客户 Lead 显式为 `summaryRole=exempt`;即使给出其余 plausible selector,summary delivery 也以 `summary_duty_required`、summary merge 也以 `summary_merge_authority_required` 在调用 `gh` 前 fail-closed;规则文档只描述窄豁免,不含 fetch verb |
