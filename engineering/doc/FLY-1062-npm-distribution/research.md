# FLY-1062 Buddy onboarding 分发层(npm 安装包) — 调研

Issue: FLY-1062 (https://linear.app/geoforge3d/issue/FLY-1062/build-buddy-onboarding-分发层-客户-npm-install-安装包零仓库访问替代-curlgit-clone)
日期: 2026-07-09
基于: exploration.md

> Brainstorm gate 已过(Tadashi 确认,无更正)。**渠道 Annie 已拍 B(公共薄壳 + license key,2026-07-09)**——本文 §8/§10 为 B 主线;A 降级为 plan 附录。以下全部为对 FLY-1023 代码(初审对 origin/flywheel-FLY-1023 @ 5f4087c0;**#523 merge 后已对 origin/main ≥ bc9c9bfb 复核,7 个被引文件逐字一致,行号原样成立**)+ 生产机的**真实审计**,非猜测。

---

## 1. 审计 A:客户机运行时闭包(包必须装下什么)

客户 MVP 的常驻/运行面(来源:fleet manifest `launchdJobs` + M5 services 步 + Buddy 流程):

| 运行件 | 形态 | 现状来源 | 打包处置 |
|---|---|---|---|
| Bridge daemon | `npx tsx scripts/run-bridge.ts`(薄 TS 入口,import 全来自 `packages/*/dist/*.js`) | 仓库 checkout + 现场 build | 入口编译进 dist;wrapper 加 node-dist 分支(§5) |
| Lead(Captain) | `packages/teamlead/scripts/claude-lead.sh` → `node -e "import('file://…/dist/ProjectConfig.js')"` + claude CLI | 同上 | **零改动**——全部走 dist 文件路径,发布树保留布局即成立 |
| Buddy 全套 | bash(onboard/buddy/steps/setup/provision)+ copy/persona/brain-prompts | 仓库 scripts/ | 原样进包(curated 白名单) |
| flywheel-comm CLI | `packages/flywheel-comm/dist/index.js`(bin: flywheel-comm) | 同上 | dist 原样进包 |
| agent-team-transport CLI | bin: `dist/bin/agent-team-transport-cli.js`(mailbox backend 要求在 PATH,M5-a 定案项) | 同上 | dist 原样进包 |
| inbox-mcp / terminal-mcp | bin: `dist/index.js` | 同上 | dist 原样进包 |
| validate-projects | `packages/teamlead/dist/bin/validate-projects.js`(flywheel-setup.sh:289 fail-closed 引用) | 同上 | dist 原样进包 |
| daily-standup | `scripts/daily-standup.sh`(其 Bridge 重启 fallback 在 :73 用 `npx tsx run-bridge.ts`) | 同上 | 进包;fallback 行加 packaged 分支(§5) |
| updater | `scripts/update-flywheel.sh` = `git pull --ff-only` + 重建 | 仓库 | packaged 模式诚实报错 + 指向 npm 更新命令(§7) |
| launchd/systemd 模板 | `scripts/launchd/*.plist` + `_fleet_linux_specs` | 仓库 | 原样进包 |
| ~/.flywheel/bin 三件 | wrapper ×2 + restart-services(provision `phase_flywheel_home` 从 `$REPO_ROOT/scripts` 原子安装) | 仓库 | wrapper 进包;packaged 模式 bin 安装**扩展**:随行 `lib/host-config.sh` 等支撑 lib(plan P2-4),首装服务安置走 packaged bootstrap(plan P2-5),restart-services.sh packaged 路径禁用;monorepo 模式逐字不变 |

**仓库外抓取登记(零仓库访问不变式的全集)**——客户路径上今天一共 4 处外部 git 依赖:

1. `xrliAnnie/flywheel`(**PRIVATE**)— onboard :85 clone + provision `phase_repos` clone+build → **本 issue 消灭**(被 npm 包替代);
2. 客户自己的项目仓 — `gh repo create <owner>/<project> --private`(M3,客户自己的资产)→ 保留,不属于「我们的代码」;
3. `xrliAnnie/claude-plugins-official`(**实测 PUBLIC**,gh repo view 确认)— Lead 启动门槛的 discord plugin fork,生产机 `~/.flywheel/bin/update-discord-plugin.sh` 内 `git clone`;脚本本身不在 flywheel 仓里(GEO-296 手工安置产物,FLY-1023 M5-a 承诺收编)→ MVP **允许例外**(公开仓、自动化拉取、不碰私仓),vendor 进包列 follow-up;
4. `xrliAnnie/flywheel-skills`(**PRIVATE**)— fleet manifest 对新客户机 `skillsSyncPresent:false`,**不在客户供应链**,canonicalRepo 仅记录字段 → 不需处理(哨兵测试锁住:客户路径零 skills clone)。

结论:消灭 #1 + 例外登记 #3,即达成 R1。**不变式测试**:对发布树 grep + 对安装流程 trace,断言除 #2/#3 外零 `git clone`/`github.com` 抓取。

## 2. 审计 B:workspace 包名 import 图 → 发布树内解析方案

`packages/*/package.json` 的 workspace 依赖(实测):

```
teamlead      → agent-team-transport, claude-runner, flywheel-comm, config, core, edge-worker
edge-worker   → claude-runner, config, core, dag-resolver, {github,linear,slack}-event-transport
flywheel-comm → agent-team-transport, config, token-usage
claude-runner → flywheel-comm, config, core
inbox-mcp / terminal-mcp → flywheel-comm
```

src(→dist 原样镜像)里是**裸包名 import**(`from "flywheel-core"` 等)。发布成单一 npm 包后,这些裸 specifier 必须能被 Node 解析。三个候选,取舍如下:

- ❌ **esbuild 逐入口 bundle**:claude-lead.sh 用 `import('file://…/dist/ProjectConfig.js')` 等**文件路径**直接 import 单个 dist 文件(≥4 处),bundle 会摧毁 per-file 布局,teamlead 一侧脚本全要重写——违背「不动 1023 机制层」。
- ❌ **vendor 整个 node_modules 进 tarball**:better-sqlite3 是原生模块,**必须在客户平台上装**(prebuilt 二进制按平台/Node ABI 分发);打包机的 node_modules 对客户平台是错的。
- ✅ **`bundleDependencies` 内嵌 workspace 包 + 第三方依赖声明并集**:npm pack 唯一会把 `node_modules/` 内容打进 tarball 的通道就是 bundleDependencies 列出的包。workspace 包全是纯 JS(dist),平台无关,pack 时物理放进包内 `node_modules/flywheel-*/`(package.json + dist + 必需资产);第三方依赖(better-sqlite3、sql.js、@linear/sdk、discord 库等)= 各被装包 dependencies 的**程序化并集**声明在发布 package.json,npm 在客户机按平台安装。解析走 Node 标准 walk-up:`…/onboard/node_modules/flywheel-teamlead/dist/x.js` 里的裸第三方 specifier 向上命中安装前缀的扁平 node_modules。布局保留 → claude-lead.sh 的 file-URL import 改一个根即可成立(SCRIPT_DIR 相对推导本来就成立——claude-lead.sh 在包内 `node_modules/flywheel-teamlead/scripts/` 下,`$SCRIPT_DIR/../dist/` 依旧命中)。

**实现期核验(硬项,vendor 行为家规)**:① npm pack 对 bundleDependencies 的实际包含行为(含嵌套 node_modules 完整性);② 并集依赖无版本冲突(冲突时 fail the build,人工对齐);③ CI 冒烟:pack 出的 tarball 在干净 temp prefix `npm install` 后,node 直接 import 每个入口(bridge/comm/transport/validate-projects/两 MCP)零 MODULE_NOT_FOUND。

## 3. 审计 C:TS-at-runtime 残留面(全量)

对分支 grep `npx tsx|tsx ` 的客户路径命中,逐个处置:

| 位置 | 处置 |
|---|---|
| `flywheel-bridge-wrapper.sh:152` `exec npx tsx scripts/run-bridge.ts` | 打包时把 run-bridge.ts 编译为 `dist/run-bridge.js`(它只 import packages dist,tsc/esbuild 单文件即可);wrapper 加分支:存在 dist 则 `exec node`,否则现有 tsx 路径**逐字**保留(Annie 生产不变) |
| `daily-standup.sh:73` fallback `npx tsx run-bridge.ts` | 同上分支 |
| `scripts/cleanup-sessions.ts`、`scripts/e2e-*.ts` | dev/QA 专用,**不进发布白名单** |
| `packages/teamlead/scripts/codex-lead.sh` 内 tsx | Codex Lead 不在客户 MVP(1023 既有 out:codex adapter 占位)→ 不进白名单或原样进包不激活;取 **原样进包**(claude-lead.sh 同目录资产,白名单按目录收) |

处置后:**发布树可以完全不带 tsx 依赖、不带任何 .ts**。

## 4. 审计 D:原生模块

- `better-sqlite3 ^12`(teamlead / flywheel-comm / inbox-mcp):npm 安装时经 prebuild 机制拉平台二进制;目标矩阵 = macOS arm64/x64、Linux x64(glibc,含 WSL2)。缺 prebuilt 时 fallback node-gyp 编译——mac 侧 Xcode CLT 本来就是 git 前置(onboard 环境检查已要求),linux 侧 build-essential 可进 preflight deps 的 packaged 分支。**实现期真机核验矩阵**(干净 VM,家规)。
- `sql.js`:纯 wasm,零处置。
- 其余 heavy dep 扫描(sharp/playwright/puppeteer/onnx):**零命中**。

## 5. 审计 E:byte-compat seam 清单(R7)

全部改动 = additive 分支 + 哨兵,复用项目既有 reverse-compat sentinel 模式:

| 触点 | packaged 判据 | 不装包时 |
|---|---|---|
| `flywheel-onboard.sh` fetch 段(:79-90) | 包内形态下 BASH_SOURCE 探测**天然命中包根**,clone 分支根本不触发(实测逻辑:`_fo_dir/flywheel-setup.sh` 存在即 in-place)——fetch 皮**甚至可以零改动**;仅当保留 curl 皮时其下载目标从 clone 换 npx(§8) | 逐字不变 |
| `provision-fleet-host.sh` `phase_repos` | 发布树内置哨兵文件(如 `.flywheel-prebuilt`,内容=版本)→ 跳 flywheel clone+`pnpm install/build`;deps 面在 prebuilt 模式去 pnpm(manifest deps 由 `fs_generate_fleet_artifact` 生成,加条件) | 逐字不变(哨兵不存在) |
| `flywheel-bridge-wrapper.sh` / `daily-standup.sh` | `[ -f "$FLYWHEEL_DIR/dist/run-bridge.js" ]` → `exec node`;否则现有 `npx tsx` 行逐字保留 | 逐字不变 |
| `update-flywheel.sh` | 哨兵存在 → 诚实话术报错 + 指 npm 更新命令 | 逐字不变 |
| FLYWHEEL_DIR 指向 | **零新机制**:FLY-650 host.json seam 已在 wrapper 落地(host_config_load,malformed fail-closed,absent=默认 `~/Dev/flywheel`)——packaged 安装把 `flywheelDir=~/.flywheel/runtime/current` 写进 host.json 即可 | host.json 不写则默认不变 |

## 6. 审计 F:耐久根与安装机制

- **为什么不能原地跑 npx cache / 全局 node_modules**:launchd/systemd 服务长期指向 FLYWHEEL_DIR;npx cache 半瞬态、`npm update -g` 在服务运行中原地换文件。
- **落地机制(以 plan §0 布局合同为准)**:bin 入口(薄 wrapper)执行 `npm install --prefix ~/.flywheel/runtime/versions/<ver>` 装包+依赖(原生模块此时按客户平台解析);真实落点 = `<prefix>/node_modules/<pkg>` 即 **PKG_ROOT**;安装后建 `packages/<dir> → node_modules/flywheel-<name>` 兼容镜像,再原子翻 `~/.flywheel/runtime/current` → PKG_ROOT → exec `current/scripts/flywheel-onboard.sh`。npx 入口进程自身瞬态与否无所谓——它只是安装器。
- **journal/续传(R3)**:state 根 `~/.flywheel`(`FLYWHEEL_SETUP_STATE_DIR` seam)与运行根解耦,journal v2 的 steps/buddy 键不存 repo 绝对路径(evidence 是 provider/version、repo full_name 等非路径事实,抽查实测);重跑 = 再次 npx → 已装版本直接 exec → journal cursor 续。**版本切换后 resume**:current symlink 稳定路径保证 plist/wrapper 不失效;测试锁「装 v2 后重跑,v1 的 journal 原样续」。

## 7. 版本与更新通道(R4)

- 版本单一真相 = 发布 package.json version(与 `doc/VERSION` 同步,CI 断言相等);journal/`~/.flywheel/runtime/current` 记录已装版本。
- dist-tags:`latest`(客户缺省)/`next`(内测);`npx <pkg>@latest` 天然拿最新。
- **MVP 更新路径**:重跑安装命令(或包内 `flywheel update` 子命令,同一代码路)→ 装新版本目录 → 翻 symlink → 重启已安置服务(**注:restart-services.sh 经 Codex design review 核实是 monorepo deploy 脚本——git 状态检查/pnpm build/tsx fallback——packaged 模式不可复用,须新建 packaged update seam,见 plan P3**)。update-flywheel.sh 的 git 自动更新在 packaged 模式禁用(诚实话术)。com.flywheel.updater 的 npm 化自动更新 = follow-up。
- 撤版:npm 72h 后不可 unpublish → 坏版本用 `npm deprecate` + 发修复版,runbook 记录。

## 8. 渠道 B(已拍)下的入口形态(+ Node 前置)

- 主入口(客户命令不变):`npx @flywheel/onboard`(scoped 包名待 Annie 定 org 后核可用性;bin 名 `flywheel-onboard`)——但公共包只是**薄壳**:安装器 + bootstrap,零话术零构建产物零 IP;真 payload 凭 license key 从 gated 端点换取(§10)。engines 钉 `node >= 20`。
- Node 前置鸡生蛋:甲类客户可接受「先装 Node 再 npx」;零前置皮 = ~30 行公开 curl 脚本(装 Node → 转 npx,零 IP,托管在渠道无关的公开位置)——**可后补,不阻塞主体**(D 形态兜底注记)。
- 薄壳 license = `UNLICENSED` + LICENSE 文本;publish 用 npm provenance/2FA;org 与包名申请 = Annie 侧动作清单。payload 本身不经 npm registry,不存在 72h 公开问题。

## 9. 发布安全门(R5/R2)

- `files:` **白名单**(非 ignore 黑名单)——只进:curated scripts/ 子集、`node_modules/flywheel-*/`(bundleDependencies)、buddy/teamlead 资产、plist 模板、LICENSE/README。
- pack 后强制门(CI):① `scan_for_secrets`(fleet-sanitize.sh,path 形态)扫解包树;② tarball 内容 snapshot 测试(新文件进包必须显式过白名单 diff);③ 断言零 `.ts`/`src/`/`__tests__/`/`doc/`/`.git`;④ 黑话面:客户可见输出仍走 1023 的黑话 lint(话术层不变,无新增客户文案面)。

## 10. B 渠道机制审计(主线;「key 服务尽量薄」为 Tadashi/Annie 明确约束)

打包流水线(§1-§5)、安装/运行层(§6)、provision prebuilt 模式**全部复用**——渠道无关分层正是为此;唯一换的是「payload 获取步」。B 的四个机构件:

1. **公共薄壳包**(~百行 bin):收 key(**唯一正常通道 = 隐藏 TTY 读或已存 0600 `.env`**,绝不进 argv/history——`fs_ask_secret` 同款纪律;env 注入仅限测试/CI 且须显式 `FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1` 双开关,持久化后从子进程 env 剥除)→ 凭 key 请求 gated 端点(key 走 **Authorization header**,绝不进 URL/query/日志)→ 下载 payload tarball(即 §1-§5 的同一产物)→ 校验 sha256(对照同端点的版本 manifest)→ 转 §6 落地步(`npm install --prefix <本地 tarball>`,第三方依赖仍由 npm registry 按平台装,payload 内 bundleDependencies 不受影响)。
2. **payload 托管 + 鉴权(薄)**:一个下载端点——验 token → 返回 tarball(直接流式或短时效 URL);版本 manifest(`{latest, versions[{ver, sha256}]}`)同端点同鉴权。托管底座可复用 FLY-203 publish-report 已验证的托管模式(私有 blob + 薄函数层)。**实现期核验**:选定托管位后真机验证鉴权 + 大文件(tarball 可能几十 MB)传输。
3. **key 签发/校验/吊销(薄,两个起步形态实现期二选一)**:(a) **服务端名单**——每客户一条长随机 token(≥128-bit),端点对照 0600 名单文件/KV;吊销 = 移出名单;或 (b) **静态签名 token**——`customer-id + HMAC(secret)`,端点离线验签 + 一个小吊销名单。两者都不需要数据库/用户系统;**明确不做**:账号体系、席位、计量、到期时间(全部 phase-2)。
4. **key 泄露轮换路径**:给该客户签发新 token → 旧 token 进吊销名单 → 客户机换 key 有专用通道(**不被二次运行快路挡死**):`npx <薄壳> license set`(隐藏读→校验→原子 0600 覆写 `.env`),或 install/update 途中遇 401/吊销先隐藏读换 key 一次再失败。payload 无 per-customer 定制 → 泄露的 key 只影响「下载权」,吊销即止损。

**key 的 secret 红线(继承 1023 逐字)**:key 只落 `~/.flywheel/.env`(0600);绝不进 journal/日志/argv/brain 上下文/转人工摘要(`scan_for_secrets` pattern 集补 license-key 形态);下载 URL 不带 key。**更新通道**:`flywheel update` 用已存 key 拉新版本 manifest + tarball,其余与 §7 同。**薄壳自身的更新** = npm latest(壳无 IP,坏版本 `npm deprecate`)。

## 11. 风险登记(带缓解,进 plan)

| # | 风险 | 缓解 |
|---|---|---|
| 1 | bundleDependencies 行为边角(嵌套完整性/hoisting 差异) | 实现期真 npm 实测 + CI tarball 冒烟(§2 核验③) |
| 2 | better-sqlite3 prebuilt 缺口平台 | 干净 VM 矩阵真机验;linux preflight 补 build-essential 分支 |
| 3 | 依赖并集版本冲突 | 并集生成器冲突即 fail build;人工对齐后重跑 |
| 4 | 发布树漏文件(运行时才发现) | 白名单 + tarball 冒烟跑真入口 + 干净 VM 全流程 QA |
| 5 | Annie 生产被 additive 分支波及 | 每个 seam 一个 reverse-compat sentinel(§5 表逐行) |
| 6 | #523 review 期间 skin 变动 | 本设计只挂 skin/seam,合同稳定;implement 基于合并后 main rebase |
| 7 | npm 包名/org 不可用 | 渠道拍板时给 Annie 备选名清单 |
| 8 | 意外发布(手滑 publish) | private:true 于 monorepo 根不变;发布只走 CI 的显式 tag 流程 + npm 2FA |
| 9 | payload 端点不可用 = 客户装不了(单点) | 托管选高可用底座(FLY-203 模式);薄壳给诚实话术 + 重试;端点健康监控进 runbook |
| 10 | key 走漏进日志/journal/转人工摘要 | secret 红线机械保证(§10)+ scan_for_secrets 补 license-key pattern + hermetic 注入测试 |
| 11 | payload tarball 体积(几十 MB)传输边角 | 实现期真机验大文件下载 + 断点重试;sha256 校验兜完整性 |

## 12. 交接复核注记(post-OOM,2026-07-09,successor design runner)

前任 design runner(852c70ef)死于 OOM 后,接棒 runner 对本设计做了**独立增量审计**(未读本三件套先审代码,结论回并):

1. **PKG_ROOT 布局合同对两处最硬的路径推导逐字成立**(独立推演复核,与 §0/P0 冒烟③④一致):
   - `packages/teamlead/src/bridge/run-infra.ts:139-155` — repo root = `import.meta.url` 上跳 4 级 + `agents/generic-executor.md` 哨兵校验(附 `FLYWHEEL_REPO_ROOT` env 覆盖 seam)。PKG_ROOT 形态下 `node_modules/flywheel-teamlead/dist/bridge` 上跳 4 级恰落 PKG_ROOT,`agents/` 物理在根 → 哨兵命中,与 monorepo 形态(`packages/teamlead/dist/bridge` 上跳 4 级 = repo 根)同构;
   - `packages/edge-worker/src/Blueprint.ts:945` — commCliPath = 从 edge-worker dist 相对解析 `../../flywheel-comm/dist/index.js`。两形态同构成立的前提 = **内嵌目录名与包名一致且与 packages/ 目录同深度**(`node_modules/flywheel-comm` ↔ `packages/flywheel-comm`),此为 §0 布局合同的隐含不变式,P0 冒烟①②已覆盖。
2. 复核结论:**零设计变更**;审计其余发现(git clone 位点、provisioner build 链、native 依赖面、skills/plugin 两个相邻 fetch 洞)均已被 §1-§5 覆盖且本文更完整。
