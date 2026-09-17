# FLY-2680 Raya 并仓设计 — 调研

Issue: FLY-2680 (https://linear.app/geoforge3d/issue/FLY-2680/raya-并仓设计-迁移方案packagescos-并入-flywheel-仓的边界加载方式旧机制拆除清单割接与回滚与后续子单拆分)
日期: 2026-09-17
基于: exploration.md

> **取证方法与边界。** 本页全部为 2026-09-17 的只读调查:`git show`/`cat`/`grep`/
> `ls`/`ps`/`launchctl list`/`lsof`/`dig`,以及 `gh` 的只读查询。没有修改任何文件、
> 没有改动生产、没有在 Raya 仓开分支、没有重启任何服务。
>
> 路径约定:无前缀的路径相对 Flywheel 仓(本 worktree `~/Dev/flywheel-FLY-2680`);
> Raya 仓路径标 `raya:`,读法为 `git show origin/main:<path>`(生产 checkout 落后,
> **不能**以工作树为准)。行号来自上述精确读取。核不到的写「未验证」。
>
> **基线 SHA**
>
> | 对象 | SHA | 说明 |
> |---|---|---|
> | Flywheel 本 worktree HEAD | `9241a9331` | `docs(FLY-2668)…(#1235)` |
> | Raya `origin/main` | `90e433e87a68287ed59ba64f2584e3a6bc0da151` | 2026-09-16 |
> | Raya 生产 checkout HEAD | `0f77e9772176c973eb1e09548b00c05ae550ef32` | 落后 origin/main **105** commit |
> | `~/.flywheel/deployed-sha` | `06cbb36157890f91a44acb850f5243bb13a171e7` | Flywheel 宿主已部署 |
>
> **未验证**:Linear MCP 本会话 401(`linear-api AUTH_HEADER_REJECTED`),
> Epic FLY-2679 正文与 founder 2026-09-17 20:29Z 原话无法从本会话直接读取。

---

## 1. Raya 仓边界清单(逐目录)

`raya:` 顶层(`git ls-tree origin/main`):`.github .gitignore .lead README.md assets
biome.json engineering package.json packages pnpm-lock.yaml pnpm-workspace.yaml
probes scripts summaries tsconfig.json`。**origin/main 上没有 `apps/`,也没有 `IDENTITY.md`**
—— 二者被 FLY-2445 的 `9d63a2b`(PR #61)删除/改名。工作树上还能看到它们,是 9-08 之前的残留。

| 路径 | 文件数 | 处置 | 依据 |
|---|---:|---|---|
| `raya:packages/cos/src/**` | 120 `.ts`(65 源 + 55 测试) | **进 Flywheel** | `git ls-tree -r origin/main packages/cos/src` |
| `raya:packages/cos/package.json` | 1 | **进**(需改名/加 script,§5) | 全文 16 行 |
| `raya:packages/cos/tsconfig.json` | 1 | **进**(`:2` extends 相对路径要改) | 全文 9 行 |
| `raya:packages/cos/README.md` | 1(319 行) | **进**(`:9` 钉的 extraction SHA 要更新) | — |
| `raya:scripts/verify-business-package.mjs` | 1(148 行) | **进或退役**(§5.4) | — |
| `raya:.github/workflows/ci.yml` | 1(32 行) | **不进**,就地改 | `ci.yml:28-32` |
| `raya:biome.json` | 1(21 行) | 不进;`:12` 的 evidence 排除项随 `engineering/doc` 留下 | — |
| `raya:package.json` / `pnpm-workspace.yaml` / `tsconfig.json` / `pnpm-lock.yaml` | 4 | 不进,就地瘦身 | — |
| `raya:.lead/raya/identity.md` | 1(274 行) | **留** | `verify-business-package.mjs:48` 把它算进业务包三件套 |
| `raya:summaries/**` | 48(1 README + 47 条) | **留** | §4 |
| `raya:README.md` | 1(228 行) | 留,改写 | `:3-4,:6-12,:14-18,:33-36` |
| `raya:engineering/doc/**` | 37 | 留(FLY-2031 语音时代历史证据) | — |
| `raya:probes/**` | 26 | 留(FLY-2074 C0 探针证据) | `probes/evidence/README.md:1-3` |
| `raya:assets/**` | 2 | 留(头像) | `raya:README.md:12` 归为 non-runtime |
| `xrliAnnie/raya-memory` 仓 | — | **完全不动** | — |

**并仓后在 Flywheel 的位置**:`packages/raya-cos/`(目录),包名见 §5.1。

### 1.1 Raya 仓的历史形态 —— 为什么 `summaries/` 不能跟着搬

- 总 commit **457**(2026-08-26 初始 → 2026-09-16)。
- FLY-2445 之后(`9d63a2b..origin/main`,104 commit,9-09→9-16):
  summaries-only 文件提交 **61** + summary PR merge **37** = **98/104 ≈ 94%**;
  代码侧只有 1 个 PR merge(`#154` FLY-2619)+ 5 个只动 `packages/cos` 的文件提交。
- summaries 提交作者:`Flywheel Summary <flywheel-summary@localhost>` 31 条(文件提交),
  `xrliAnnie` 19 条(全是服务端 merge commit,committer `GitHub <noreply@github.com>`)。
  分支命名 `summary/<project>/<leadId>/<16-hex>`。
- `raya:summaries/` 目录:`flywheel/ geoforge3d/ growth/ joycon-typeless/
  personal-assistant/ tidal-echo/`;47 条正文 100% 匹配
  `summaries/<project>/<YYYY-MM-DD>--<leadId>--<seq>.md`。
- **Raya 仓 main 无任何服务端保护**:`gh api repos/xrliAnnie/raya/branches/main/protection`
  → HTTP 404 "Branch not protected";`…/rules/branches/main` → `[]`。
  即「只能走 `flywheel-comm summary merge`」「summary PR 不得碰 `summaries/` 外文件」
  完全靠约定 + `flywheel-comm` 内部校验,GitHub 侧不强制。

**结论**:稳态下 Raya 仓 ≈94% 的提交流量是 summary inflow,由机器人持续开 PR。
把它并进 Flywheel 主仓 = 每天几十条 summary PR 去抢 Flywheel 的 main 与全量 CI
(Raya 仓自己的 CI 只有一个 15 分钟的 `business` job),且会让 R1 窄豁免的
「仅 `summaries/` 前缀」条件从「整仓语义」退化成「同仓两套权限」。**不搬。**

---

## 2. 依赖方向 —— 工单前提被证伪

方法:把 origin/main 的 120 个 `packages/cos/src/**.ts` 导出后,对 `from "…"`、
`import("…")`、`require("…")`、裸 `import "…"` 全量正则提取去重,再对多行
`} from` 做二次校验,再单独 grep `../../`、`/Users/`、`@flywheel`、`cyrus`、
`createRequire`、`import.meta.resolve`、`process.env`。

**去重后的全部非相对 module specifier 只有 8 个:**

| specifier | 次数 | 一处引用 |
|---|---:|---|
| `node:fs` | 50 | `raya:packages/cos/src/business-round.test.ts:1` |
| `node:path` | 50 | `raya:packages/cos/src/business-round.test.ts:3` |
| `vitest` | 55 | `raya:packages/cos/src/action-policy.test.ts:1`(仅测试) |
| `node:crypto` | 37 | `raya:packages/cos/src/business-round.ts:1` |
| `node:os` | 32 | `raya:packages/cos/src/business-round.test.ts:2` |
| `node:child_process` | 5 | `raya:packages/cos/src/daily-report/repo-writer.test.ts:2`(**仅测试**) |
| `node:buffer` | 4 | `raya:packages/cos/src/daily-report/collector.test.ts:1` |
| `node:url` | 1 | `raya:packages/cos/src/cli.ts:12` |

其余 ~95 个 specifier 全是包内相对 import,**没有一个 `../../`**(grep 0 命中)、
无绝对路径、无 `@flywheel/*`、无 `cyrus-*`、无 `createRequire`/`import.meta.resolve`。
动态 `import()` 全在 `*.test.ts` 内。

> **更正(Codex R1#5,已复核)**:本页初稿写「`process.env` 源与测试均 0 命中」,**不成立**。
> 逐文件复核(`for f in $(git ls-tree -r --name-only origin/main packages/cos/src); do
> git show "origin/main:$f" | grep -n "process\.env"; done`)得到**恰好一处**:
> `raya:packages/cos/src/portfolio/goal-store.test.ts:47`
> `env: options.env ? { ...process.env, ...options.env } : process.env,`
> —— 是测试 fixture 给 `execFile` 子进程合并环境。
> 准确表述:**非测试运行时代码零 `process.env` 读取;测试辅助代码有一处继承/合并子进程环境。**
> 这不改变架构结论(仍无 Flywheel import、无运行时环境依赖),但强事实必须准确。

**工单点名的两个文件:**

- `raya:packages/cos/src/meeting-voice.ts`(328 行):import 全在 `:1-10` ——
  `node:crypto`(`:1`)、`./business-round.js`(`:2`)、`./formatting/discord-text.js`(`:3`)、
  `./meeting-artifact.js`(`:4`)、`./meeting-round.js`(`:5`)、`./operation-store.js`(`:6-10`)。
  **无 Flywheel import。** 唯一 "flywheel" 字样在 `:37`,是 `:24-39` 构造的
  `{tool:"current_turn", arguments:{action:"run_voice_command", …}}` 里的一句 prompt 文本
  ——它**产出**一条让宿主 Lead 去跑 `flywheel-comm` 的指令,自己不调用。
- `raya:packages/cos/src/summary-workflow.ts`(297 行):import 全在 `:1-8` ——
  `node:crypto`、`./business-round.js`、`./operation-store.js`、`./summary-round.js`。
  **无 Flywheel import。** `:190` 是 `else if (input.tool === "flywheel-comm")`(校验宿主回填),
  `:272` 是产出 `{tool:"flywheel-comm", arguments:{argv:["summary","merge","--repo","xrliAnnie/raya",…]}}`。
- `raya:packages/cos/src/ports.ts`(106 行):**零 import**,纯接口。
- `raya:packages/cos/src/index.ts`(37 行):37 行全是 `export * from "./…js"`。
- `raya:packages/cos/src/directory.ts`(11 行):**零 import**。

**`raya:packages/cos/package.json` 全文 16 行里没有 `dependencies`/`devDependencies`/
`peerDependencies` 字段**;`raya:scripts/verify-business-package.mjs:73-77` 还主动断言
`Object.keys(manifest.dependencies ?? {}).length === 0`,失败消息
"business package has runtime dependencies"。

### 结论

**依赖方向本来就是单向的 Flywheel → cos**,cos 通过 `ports.ts` 接受注入
(`raya:packages/cos/README.md:14-17` 亦如此声明)。**没有反向依赖,没有循环。**
并仓后**不需要**把任何 import 改成 workspace 依赖——因为一个都没有。

需要改的只有三处硬编码:

1. `raya:packages/cos/tsconfig.json:2` 的 `"extends": "../../tsconfig.json"`(目录深度变化)
2. `raya:packages/cos/src/summary-workflow.ts:264,276` 的硬编码 `"xrliAnnie/raya"`
   —— 本方案不搬 `summaries/`,所以这两处**保持不变**,但要在 plan 里写明「故意不动」
3. `raya:scripts/verify-business-package.mjs:45-51,65-67,91,101` 硬编码的
   `.lead/raya/identity.md` + `packages/cos/{package.json,dist}` 相对布局

---

## 3. 加载方式 —— 今天根本没有加载

### 3.1 标准载体的完整解析链(逐跳带行号)

```
~/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist
  └─ /bin/bash ~/.flywheel/bin/flywheel-lead.sh ~/.flywheel/manifests/raya-raya.json
       ├─ RUN_BACKEND = manifest.leadBackend.backendId            scripts/flywheel-lead.sh:103-107
       ├─ selector ← flywheel-comm lead-registry selector          scripts/flywheel-lead.sh:572-575
       │     projects.json[raya].projectRoot = ~/Dev/raya-lead-workspace
       ├─ manifest↔registry 绑定校验                                scripts/flywheel-lead.sh:590-609
       ├─ FLYWHEEL_CODEX_LEAD_PROJECT_DIR = FLYWHEEL_CODEX_TUI_CWD = projectRoot
       │                                                            scripts/flywheel-lead.sh:176-177
       ├─ FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES
       │     = ${project_root}/.lead/${RUN_LEAD}/identity.md        scripts/flywheel-lead.sh:188  ← 唯一 Raya 侧输入
       └─ exec packages/teamlead/scripts/codex-lead.sh raya <projectRoot> raya
                                                                    scripts/flywheel-lead.sh:259
            └─ exec node packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js
                                                                    packages/teamlead/scripts/codex-lead.sh:234-238
                 ├─ fullAccessProjectRoot ← FLYWHEEL_CODEX_LEAD_PROJECT_DIR
                 │                          packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:876-890
                 ├─ systemPromptFiles     ← FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES
                 │                          packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:751
                 ├─ capabilityBundleVersion = undefined (Raya, 见 3.2)
                 │                          packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:572-575
                 ├─ requirePersona(config)  packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:1676
                 └─ baseInstructions = readBaseInstructions(identity.md)
                                            packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1758-1762
```

**载体对业务代码的解析点:不存在。** 全仓 grep(排 node_modules/dist)
`businessPackage` / `business-package` / `businessModule` / `@raya/` /
`verify-business-package` → **0 命中**。载体内无任何针对 `~/.flywheel/<lead>/code`
的 `import()` / `createRequire` / path join。`packages/teamlead/dist/lead-backends/codex/
codex-lead-tui-runtime.ts:1028` 里那句 `"Raya context usage sample unavailable"` 是
**误导性日志文案**:`contextUsagePath` 对所有 Lead 无条件设为
`<stateDir>/metrics/context-usage.jsonl`(`codex-lead-runtime.ts:984-985`),不是 Raya 分支。

### 3.2 Raya 今天走的是 legacy(非 capability-v2)分支

`~/.flywheel/projects.json` 的 raya lead 行**没有** `codexCapabilityBundleVersion` 字段。
`resolveCodexLeadCapabilities` 只在该字段 `=== 2` 时输出 bundle
(`packages/config/src/codex-lead-capabilities.ts:45-48`);
`resolveLeadCapabilities` 在 undefined 时 `return null`
(`packages/teamlead/src/lead-capabilities/resolve.ts:21`);
于是 `packages/teamlead/scripts/lib/canonical-lead-identity.sh:186` 会
`unset FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION`。

### 3.3 `business/current` —— 唯一的业务包投递路径,写者只有旧班车

| 事实 | 依据 |
|---|---|
| shuttle 把 `$RAYA_CODE_DIR/packages/cos/{package.json,dist}` 复制进版本目录 | `scripts/lib/updater-raya-deploy.sh:745-757, 867-878` |
| 版本目录 = `<workspace>/.flywheel-managed/versions/<raya_sha>` | `scripts/lib/updater-raya-deploy.sh:501-502, 647-648` |
| 指针 = `<workspace>/business/current` 符号链接,由 `raya_atomic_symlink_replace` 原子替换 | `scripts/lib/updater-raya-deploy.sh:775-778` |
| 同一步还把 `.lead/raya/identity.md` 从 checkout 投影进工作区 | `scripts/lib/updater-raya-deploy.sh:763-772` |
| **没有任何 Flywheel TS 代码读取 `business/current`** | grep `business/current`/`businessCurrent` → 仅 `updater-raya-deploy.sh` 与其 shell 测试 |
| `raya:scripts/verify-business-package.mjs:97-101` 也只是自己造一个 `workspace/business/current -> artifact` 布局做验证,`productionActivated:false`(`:122-145`) | — |

### 3.4 生产实况(只读,2026-09-17)

| 观测 | 结果 |
|---|---|
| `launchctl list \| grep -i raya` | `1671 0 com.xrli.raya.brain` / `- 0 com.xrli.raya.voice` / `17271 0 com.flywheel.lead.raya-raya` |
| 旧壳进程 | PID 1671,`Thu Sep 17 10:23:39 2026` 起,`node ~/.flywheel/raya/code/apps/brain/dist/cli.js run` |
| 宿主启动 | `sysctl -n kern.boottime` = `Thu Sep 17 08:55:11 2026`(旧壳是重启后被 `RunAtLoad` 拉回) |
| **旧壳仍连着 Discord** | `lsof -a -p 1671 -i -n -P`:两条 ESTABLISHED → `162.159.133.234:443`、`162.159.134.234:443`;两个 IP 都在 `dig +short gateway.discord.gg` 的 A 记录集合内 |
| 但旧壳不出声 | `~/.flywheel/raya/data/logs/brain.stdout.log` 0 字节(8-26 起);`brain.stderr.log` 9-04 后未动 |
| voice job 被拒 | `~/.flywheel/raya/data/logs/voice.stdout.log:1` `{"status":"startup_refused","reason":"pid_owner_alive"}` |
| 标准 Lead | PID 17271,`12:04:57` 起,`node ~/Dev/flywheel/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js` |
| 标准 Lead 今天确在干活 | `~/Dev/raya-lead-workspace/state/presentation-event-119702/*` 今日写入;`~/.flywheel/logs/lead-raya-raya.log` 13:38 仍在刷 `tui-window: real TUI up (raya-raya, thread 01a0a781-…)` |
| 标准 Lead 工作区内容 | 仅 `.lead/raya/identity.md`、`memory/`、`state/` —— **无 `business/`、无 `.flywheel-managed/`** |
| manifest | `~/.flywheel/manifests/raya-raya.json` 字段集固定为 `leadId/projectDir/projectName/projectsFile/subdir/workspace/mcpExclude/model/leadBackend`,由 `scripts/materialize-lead-manifests.sh:61-93` 投影,**无 code-path 字段** |
| 迁移账本 | `~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json`:`checkpoint:"P2"`、`cursor.status:null`、`prestop_retry:true`;`legacy_owner[0]` 记的是 `pid:54811 / start:"Tue Sep  8 00:05:46 2026"`(与当前 PID 1671 不符 → 正是 FLY-2657 要修的 stale-PID 情形) |
| 部署回执 | `~/.flywheel/raya/deploy-receipt.json`:`schemaVersion:1`、`outcome:"rolled_back"`、`failure:"preflight-rc:1:rolled-back"`、`deployed_sha:0f77e977`(9-08) |
| 人设漂移 | 工作区 `.lead/raya/identity.md`(9-14 13:14 手工放置,sha256 `4e982448…`)vs `raya:origin/main` 版(`ca1240f1…`)**差 247 行、落后 3 个 commit**;该文件在 `0f77e977` 上**不存在** |
| 生产 checkout 的 cos | `~/.flywheel/raya/code/packages/cos/` **只有 `dist/`,没有 src** —— 因为 `packages/cos` 在 `0f77e977` 上尚未入库,那份 dist 是后来被 reset 掉的孤儿产物 |

### 3.5 对其他 Lead 零影响的证明

载体对 Lead **完全无名字分支**;persona 路径模板对所有 codex Lead 一致
(`scripts/flywheel-lead.sh:188`;capability-v2 同 `packages/teamlead/src/lead-capabilities/rule-sources.ts:223-235`)。
所有 Raya 专属逻辑都是 **if-present 守卫**:

| 位置 | 守卫形式 |
|---|---|
| `packages/teamlead/src/bridge/plugin.ts:3508-3520` | `const rayaIdentity = rayaIdentities[0]; if (rayaIdentity) { … }` |
| `packages/teamlead/src/bridge/summary-absorption-rider.ts:505-513` | `resolveRaya` 找唯一 `raya`,零匹配返回 null 并退化 |
| `packages/teamlead/src/lead-backends/codex/lead-actions/lead-actions-main.ts:195-198` | `cfg.leadId === "raya" && requestedEventId && isReservedRayaSummaryEventId(…)` |
| `scripts/update-flywheel.sh:716-722` | `if raya_host_capable; then updater_raya_pass; else RAYA_DEPLOY_STATE=not_configured` |
| `packages/teamlead/src/lead-capabilities/rule-sources.ts:284` | `.lead/shared/*` `existsSync` 守卫 |
| `packages/teamlead/src/workflow-menu.ts:507-508` | `.flywheel/menus/adoption.yaml` `existsSync` 守卫 |

同载体的另一个 full-access codex Lead 是 `flywheel/codex-infra-bot-lead`
(manifest `~/.flywheel/manifests/flywheel-codex-infra-bot-lead.json`,`leadBackend.backendId`
同为 `codex-app-server`),走**与 raya 完全相同的路径**且从不设置任何业务包字段。
**未验证**:`growth/mufasa-lead` 的 plist ProgramArguments(它的 manifest 无 `leadBackend`,
由 `scripts/converge-flywheel-bin.sh:81` 列出的专用 wrapper 启动)。

### 3.6 由此得到的设计约束

1. 并仓后要让 cos 真正被加载,**必须新增一条载体侧的加载路径**——今天不存在任何可复用的。
   这条路径必须是对所有 Lead 可选的 if-present 字段,才能保持零影响。
2. 旧班车是唯一会投递 cos 的东西,所以**「拆旧机制」和「建新加载路径」不能分成两张互不依赖的单**;
   顺序必须是先建后拆。
3. 今天在回 #raya 的是**标准 Lead**(state 今日写入 + TUI 活跃),它的能力来自 persona,
   不来自 cos。因此**并仓本身不会让 Raya 掉线**——真正的风险在人设投影与旧壳的两条 Discord 长连接。

---

## 4. 保持不变的东西(summary 机制与 R1 窄豁免)

| 事实 | 依据 |
|---|---|
| summary 目标仓硬编码 | `packages/flywheel-comm/src/commands/summary.ts:23-24` `const TARGET_REPO = "xrliAnnie/raya"; export const SUMMARY_TARGET_REPOSITORY = TARGET_REPO;` |
| `verify-pr --repo` 只接受两个仓 | `packages/flywheel-comm/src/commands/summary.ts:181-190`,否则 `summary_verifier_repo_forbidden` |
| merge 白名单 | `packages/flywheel-comm/src/summary-pr-merge.ts:12-15` `ALLOWED_SUMMARY_REPOS = {"xrliAnnie/raya","xrliAnnie/raya-memory"}` |
| **交付方式是临时克隆,不碰生产 checkout** | `packages/flywheel-comm/src/summary-delivery.ts:263-292` `gh repo clone <repo> <tmpdir>/repo --branch <default> --single-branch --depth 1` |
| 路径前缀常量 | `packages/flywheel-comm/src/summary-contract.ts:5` `SUMMARY_PREFIX = "summaries/"`;写入路径 `summaries/<project>/` 见 `summary-delivery.ts:152` |
| 三处前缀声明必须一致 | `scripts/verify-summary-prefix-pair.sh:42-60` 同时校验 ① `raya:summaries/README.md` 的 ``single fixed prefix is `X` `` ② `packages/teamlead/lead-rules-base/founder-only-authority.md` 的 ``single fixed prefix `X` `` ③ `packages/flywheel-comm/src/summary-contract.ts` 的 `SUMMARY_PREFIX` |
| Raya 侧合同 | `raya:summaries/README.md:3-5` "open PR = unread · merge = read receipt";`:29-33` summary PR **不得**触碰 `summaries/` 以外任何文件、不得含可执行/配置;`:37-53` frontmatter + `## Facts` + `## Judgment` 必填 |
| Raya 人设里的红线 | `raya:.lead/raya/identity.md:51-58` 唯一允许的 merge 路径是 `flywheel-comm summary merge --repo xrliAnnie/raya --pr <n> --round <roundId>`,裸 `gh pr merge` 是红线 |

**因为本方案不搬 `summaries/`、不改 Raya 仓名、不改 `SUMMARY_PREFIX`,
上述整条链路与 R1 窄豁免的两条机器可检条件原样成立,`flywheel-comm summary`
的目标仓不变。** `verify-summary-prefix-pair.sh` 的三点校验也继续成立——
但注意它校验的 ② 在 Flywheel 仓的 `founder-only-authority.md`,所以**改那份规则文件时
不能动带 `single fixed prefix` 的那一行**。

---

## 5. 旧机制拆除清单(逐文件/符号)

> **路径更正**:工单写的 `scripts/updater-raya-deploy.sh` 不存在;
> 实际是 `scripts/lib/updater-raya-deploy.sh`(1241 行)。
> `raya_host_capable` 与 `updater_raya_pass` 都定义在这个 lib 里,
> `scripts/update-flywheel.sh` 只是 source 并调用。

### 5.1 `scripts/update-flywheel.sh`(739 行)的 6 个 Raya 挂点

| # | 位置 | 内容 |
|---|---|---|
| 1 | `:55-57` | `source "${SCRIPT_DIR}/lib/updater-raya-deploy.sh"` |
| 2 | `:62` | `raya_configure_runtime_paths`(在 `updater_configure_runtime_paths` 之后重钉路径) |
| 3 | `:99-117` | `raya_alert_dispatch()`:severe→`deploy_failed "Raya deploy failed"` + `--mention-user $FLYWHEEL_FOUNDER_USER_ID`;warning→`deploy_degraded`;经 `scripts/lead-alert.sh` 发出。lib 的 `raya_alert()`(`updater-raya-deploy.sh:71-77`)用 `declare -F` 探测它 |
| 4 | `:446-463` | `updater_cleanup()` 里 `:461 raya_lock_release \|\| true` |
| 5 | **`:713-727`** | **scheduled 分支** `:715-722`:`if raya_host_capable; then updater_raya_pass \|\| true; else RAYA_DEPLOY_STATE=not_configured; RAYA_DEPLOY_DETAIL=host-capability-absent`。**urgent 分支** `:724`:`log "raya shuttle: skipped wake=urgent"`。unknown `:725` fail-closed 跳过。`:727` 汇总 log |
| 6 | `:487-494` | `UPDATER_WAKE_KIND` 判定(非 Raya 专属,被 #5 消费) |

`updater_raya_pass` 的返回码被 `|| true` 吞掉,只影响日志。

- `raya_host_capable`(`updater-raya-deploy.sh:103`)= `raya_validate_canonical_manifest`
  (`:92-102`):canonical manifest 是普通文件、`projectName==leadId=="raya"`、
  `leadBackend.backendId=="codex-app-server"`、`projectDir` 是绝对路径且为非 symlink 目录。
  FLY-2385 原版 `:81` 判的是旧 plist 是否存在,FLY-2445 改成 manifest 判定。
- `updater_raya_pass`(`:1156-1241`)返回码:0 deployed;1 not_configured/locked;
  2 所有 awaiting_* / prestop-failed / source-prepare-failed;3 cutover-failed/proof-invalid/finalize-failed。
  **告警面**:只有 `raya_fail` 走 severe(`deploy_failed` + @founder);
  prestop 与 awaiting 类只写 refused 回执、不告警(`updater-raya-deploy.test.sh:794-826` 锁定该行为)。

### 5.2 `scripts/lib/updater-raya-deploy.sh` 读写的宿主路径

| 变量 | 路径 | 读/写 |
|---|---|---|
| `RAYA_CODE_DIR` | `~/.flywheel/raya/code` | fetch / ff-merge / pnpm install+build(**写**) |
| `RAYA_DEPLOYED_SHA_FILE` | `~/.flywheel/raya/deployed-sha` | 读 `:557,609,688,1177`;写 `:594-600` |
| `RAYA_DEPLOY_RECEIPT` | `~/.flywheel/raya/deploy-receipt.json` | 读 `:522-543,675-698,765`;写 `:545-592` |
| `RAYA_DEPLOY_LOCK_DIR` | `~/.flywheel/raya/deploy.lock.d` | `:113-143` |
| `RAYA_CANONICAL_MANIFEST` | `~/.flywheel/manifests/raya-raya.json` | 只读 |
| `RAYA_MIGRATION_MANIFEST` | `~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json` | 读写(`raya_manifest_transform :182-196`,CAS by sha256 + 原子 rename) |
| `RAYA_STANDARD_PROOF_FILE` | 同目录 `proof.json` | 读 `:465-491`;quarantine 改名 `:1104-1108` |
| `RAYA_WORKSPACE` | `~/Dev/raya-lead-workspace` | 写 `.flywheel-managed/versions/<sha>/`、`.lead/raya/identity.md`、`business/current`(`:740-781`) |
| `$RAYA_HOME/build-check/<sha>` + `.export` | 临时 worktree 与导出 | `:839-909` |
| `FLYWHEEL_LEAD_BIN` | `~/.flywheel/bin/flywheel-lead.sh` | 调 `preflight/install/verify`(`:352`) |
| `dist/bin/raya-migration-manifest.js` | | `raya_shuttle_step :354-357` |
| `dist/bin/raya-summary-presentation-migrate.js` | | `:1025-1049`(FLY-2619) |

### 5.3 迁移账本与 `raya-migration-init`

- 账本目录 `~/.flywheel/raya/migrations/FLY-2445-standard-lead/`:`manifest.json`、`proof.json`、
  `precheck.intent`、`seed-input.json`、`prestop-probe.intent`/`cutover-probe.intent`
  (`packages/teamlead/src/bin/raya-migration-shuttle.ts:139`)、`*.retired-<nonce>.json`(`:159`)。
  路径硬编码于 `scripts/lib/updater-raya-deploy.sh:38-39,55-56`、
  `packages/teamlead/src/bin/raya-migration-init.ts:157-160`、`raya-migration-shuttle.ts:96-98`、
  `raya-migration-resolve.ts:43`、`raya-migration-proof.ts:39-41`。
- **`raya-migration-init` 不是独立 bin**:是 `dist/bin/raya-migration-manifest.js` 的 `init` 子命令
  (`packages/teamlead/src/bin/raya-migration-manifest.ts:289-299` 动态 import,main 入口 `:320-330`)。
  `packages/teamlead/package.json` 无对应 bin 条目。
- CLI 子命令(`raya-migration-manifest.ts:266-318`):`quiet-check | prestop-probe | cutover-probe |
  seed-boundary [--lock-owner N]`、`init --target-raya-sha …[--resume-from-failed]`、
  `resolve | resolve-quiet-window`。proof 另有入口 `raya-migration-proof.ts:29-446`。
- 锁协议共享:`raya-migration-io.ts:50-127 withRayaDeployLock` 与 shell `raya_lock_acquire:113-137`
  同用 `deploy.lock.d/{pid,start}`。
- **fixture 依赖**(删 TS 文件时必须同步):
  `packages/claude-runner/test/fixtures/kill-path-inventory.json:1173-1177`、
  `scripts/fly-2006-retention-consumer-gate.config.json:588-593`、
  `packages/teamlead/ci-test-costs.json:783,979`。

### 5.4 prestop 校验

| 位置 | 内容 |
|---|---|
| `scripts/lib/updater-raya-deploy.sh:839-909 raya_prestop_prepare` | 前置 `raya_legacy_stop_authorized :222-237` + `raya_verify_legacy_owners :783-814`(plist 内容/sha、pid+start 与账本一致);remote 必须是 `xrliAnnie/raya` `:846-848`;`origin/main == target_raya_sha` `:850`;`checkout_before` 是 target 祖先 `:851`;在 `build-check/<sha>` detached worktree 里 bounded `pnpm install --frozen-lockfile` + `pnpm build` `:857-861`;导出 `.lead/raya/identity.md` + `packages/cos/{package.json,dist}` `:870-887`;persona 必须与工作区现有 identity 一致 `:868-869`;`prestop-probe` + `quiet-check` `:896-897`;ff-merge 生产 checkout `:903-905`;再次复验 `:906-908` |
| `:953-961` | 失败 → `prestop-failed` / `prestop-validation-failed`,账本 `.prestop_retry=true` |
| `:1205-1209` | prestop-failed → 只 log + 释放锁 + return 2,**不写 failed 回执、不 severe** |
| `raya_quiesce_legacy_owner :260-317` | `launchctl disable` → 读回 `print-disabled` → `bootout`;每步先把 `stop_started_at_ms/disabled_at_ms/stopped_at_ms` 写账本 |
| 测试 | `scripts/__tests__/raya-prestop.test.sh`(146 行,20 个场景,`:140`) |

`scripts/restart-services.sh` 中**没有** Raya/prestop 挂点(grep 为空)。
`packages/voice-bridge/src/assistant/config.ts:32` 的 "pre-stop barge-in gate" 是语音功能,同名无关。

### 5.5 `deploy-receipt.json` v1 / v2

Schema 判定在 `scripts/lib/updater-raya-deploy.sh:511-520 raya_receipt_keys_valid`:

- **v1(22 键,FLY-2385)**:`brain_pid checked_at checkout_before deployed_sha failure gen_before
  generation head identity interrupt_notice ledger node_bin origin_main outcome preflight_rc
  rollback_sha schemaVersion session_at_cutover session_grace state voice voice_pid`
  —— 面向 legacy launchd brain/voice 的进程代际。
- **v2(30 键,FLY-2445)**:v1 全部键(legacy 进程字段一律写 null,`:571-573`)**+ 8 个**:
  `business carrier checks cutover flywheel_deployed_sha lead migration_id rollback_target`。
  `carrier:"standard-lead"` 固定 `:576`;`rollback_target` 来自 `raya_previous_standard_target :522-543`。
- **v1 写者已不存在**:当前树只有 v2 写者 `raya_write_standard_receipt :545-592`
  (`schemaVersion:2` at `:570`)。v1 写者 `raya_write_receipt` 在 `f731d0033` 的同名文件 `:405-440`,
  被 FLY-2445 (#1134) 删除。**宿主上那份 v1 回执是 FLY-2385 时代的遗留。**
- 生产者调用点:`:1186 :1200 :1216 :1229`(refused)、`:1055`(failed,via `raya_fail`)、
  `:609/611`(current/deployed,via `raya_standard_finalize`)。
- 消费者:lib 自身(`:522-543` rollback_target 推导、`:675-698` P7 起点校验、
  `:765` 读 `.business.persona_digest`)、巡检 `scripts/lead-patrol-snapshot.sh:1125-1152`、
  规则文本 `packages/teamlead/lead-rules-base/founder-only-authority.md:96-104`、
  `packages/teamlead/lead-rules-base/summary-inflow.md:21-25`、
  `packages/edge-worker/src/skill-templates/linear-issue-context.ts:32`、
  测试 `updater-raya-deploy.test.sh:397-465`、`lead-patrol-snapshot.test.sh:1689+`。
- `deployed-sha` 生产者 `:594-600`(仅 `:613` 调用);消费者 `:557,609,688,1177`、
  `lead-patrol-snapshot.sh:1095-1111`、`founder-only-authority.md:105-106`。

### 5.6 巡检快照的 `raya checkout=` 事实行

- 配置:`scripts/lead-patrol-snapshot.sh:140`(`RAYA_SHUTTLE_STALE_SECONDS=$((13*3600))`)、
  `:145-149`(`RAYA_PATROL_HOME`/`CODE_DIR`/`CANONICAL_MANIFEST`)。
- 采集器 `raya_collect_patrol_fact :1053-1187`(辅助 `:1033-1051`),产出行在 **`:1186`**:
  ```
  RAYA_PATROL_FACT="raya checkout=$RAYA_PATROL_CODE_DIR head=$head8 origin_main=$origin8 branch=$branch behind=$behind deployed_sha=$deployed_sha receipt_age_h=$receipt_age_h drift_age_h=$drift_age_h checkout_drift=$checkout_drift deploy_drift=$deploy_drift shuttle_stale=$shuttle_stale overdue=$overdue receipt_schema=$receipt_schema receipt_carrier=$receipt_carrier manifest_carrier=$manifest_carrier carrier_mismatch=$carrier_mismatch"
  ```
  结构性缺失时 `:1039-1043` 输出 `raya checkout=UNAVAILABLE(structural: …)`。
  注入 STEP 5(仅 `PROJECT_NAME=flywheel`)`:1300-1311`。
- **runbook 对应段**:`packages/teamlead/lead-rules-base/runbooks/patrol-v1.md:194-207`
  (`overdue=yes` → 在 `CHAT_CHANNEL_ID` 发 warning 含 `FLY-2385`,evidence
  `raya_checkout_overdue.<head8>.<origin8|none>`,同 UTC 日去重,STEP 5 定稿 FINDING;
  连续两 tick 建工程单)。同文复制于
  `packages/teamlead/lead-rules-base/legacy-token-savings/runner-patrol-rules.md:202-215`;
  概述提及 `packages/teamlead/lead-rules-base/runner-patrol-rules.md:39,51`。
  `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts:176-200` 锁定 runbook 锚文本与 FINDING 格式。
- **未验证**:未实际运行快照。按现场数据**推断**当前真实输出应含
  `receipt_schema=1 receipt_carrier=legacy carrier_mismatch=yes shuttle_stale=yes overdue=yes`。

### 5.7 CI 接线(拆任何一项都要同步改)

| 位置 | 内容 |
|---|---|
| `.github/workflows/ci.yml:86-89` | always-on lane:`bash scripts/__tests__/raya-standard-migration.test.sh` |
| `.github/workflows/ci.yml:749` | 注释「Raya 由上面的 standard Lead migration 套件覆盖」 |
| `.github/workflows/ci.yml:1045-1048` | `bash scripts/__tests__/qa-raya-voice.test.sh`(语音,**不是** deploy 机制) |
| `.github/workflows/ci.yml:1139-1140` | `bash scripts/__tests__/updater-raya-deploy.test.sh` + `raya-prestop.test.sh` |
| `scripts/__tests__/ci-shell-suite-enumeration.test.sh` | 要求每个 shell 套件在 workflow 里被字面枚举 —— 删套件必须同时删枚举行 |
| `scripts/__tests__/update-flywheel-sources.test.sh:42-47` | 要求 `updater_raya_pass raya_configure_runtime_paths raya_host_capable raya_alert_dispatch` 四个函数存在 |
| 同上 `:69-73, :76-79, :82-92, :100-131` | bash 3.2 语法守卫、要求 ci.yml 跑 `updater-raya-deploy.test.sh`、路径重钉顺序 |
| `scripts/package-onboard.sh:129`、`scripts/package-onboard-files.allow:67`、`scripts/converge-flywheel-bin.sh:81,92,155` | 打包/收敛清单含 `lib/raya-standard-migration.sh` |

**顺带发现的既存隐患(不在本单范围,建议单独开单)**:
`scripts/update-flywheel.sh:55-57` 无条件 source `lib/updater-raya-deploy.sh`,
而 `scripts/package-onboard.sh` 的 `PO_SCRIPT_FILES` **不含**该文件(全文件 grep `raya` 仅 `:129` 一处)
→ packaged 安装里 `update-flywheel.sh` 会 source 失败。
**未验证**:packaged 环境是否实际运行 `update-flywheel.sh`。

### 5.8 FLY-2654 Part B

**未验证**:`engineering/doc/FLY-2654*` 目录在本 worktree 不存在,
全仓 grep `FLY-2654` 只在 `.claude/skills/*/SKILL.md`(本会话注入的上下文)命中。
工单提到的「FLY-2654 Part B 归档内容」无法在本仓定位;建议由 Lead 补一条指针再纳入拆除单。

### 5.9 构建历史

| commit | FLY | 内容 |
|---|---|---|
| `f731d0033` | **FLY-2385** (#1111) | 新建 `lib/updater-raya-deploy.sh` + 测试;v1 回执 / launchd brain-voice 载体 |
| `04ff8800a` | **FLY-2445** (#1134) | 改为 standard Codex Lead 路径;新建 `lib/raya-standard-migration.sh`;v2 回执;删旧专属 wrapper/plist |
| `42869f935` | FLY-2453 (#1138) | 触及 `update-flywheel.sh`(auto-merge gate,Raya 相关性**未验证**) |
| `66d804a27` | **FLY-2496** (#1179) | 新建 TS `raya-migration-{init,shuttle,proof,resolve}.ts`、`raya-prestop.test.sh`、prestop/rebind;`founder-only-authority.md` 授权行 |
| `2768d5dc7` | **FLY-2619** (#1223) | `raya-summary-presentation-migrate.ts` 接进 standard-update 路径 |

### 5.10 现在能不能拆:不能,一项都不能

理由(三条都是现场事实,不是推断):

1. 这套机制仍是**唯一**的自动化 Raya 部署载体,而 cos 的新加载路径尚不存在(§3)。
2. 账本停在 P2、`prestop_retry:true`,`com.xrli.raya.brain` 仍在跑且仍连着 Discord(§3.4)。
3. FLY-2657 今晚要用它做最后一次切换(该单仍在 implement 4/6)。

提前删任一项会让 `update-flywheel-sources.test.sh:42-47/76-79` 与 `ci.yml:1139-1140` 红掉,
并让巡检 STEP 5 失去 Raya 真相行。**分界线写在 plan §拆除顺序。**

---

## 6. cos 的真实调用形态:人设里写死的 shell CLI,不是 import

`raya:.lead/raya/identity.md:157-174`「## Durable business commands」原文:

```
At every summary event, business wake, founder conversation, or Lead reply,
run these commands from the registered business workspace (not the Codex home):

    node business/current/packages/cos/dist/cli.js status
    node business/current/packages/cos/dist/cli.js resume  --input state/cos/resume-input.json
    node business/current/packages/cos/dist/cli.js prepare --input state/cos/prepare-input.json
    node business/current/packages/cos/dist/cli.js record  --input state/cos/record-input.json

… The CLI performs no external effects. See the README for
input shapes. Do not assume a `raya-cos` executable is installed on PATH.
```

三点直接结论:

1. **载体对 cos 零耦合。** cos 是模型在 Lead 工作区 cwd 下用 shell 跑的一个 CLI;
   `packages/teamlead` 里没有任何代码 import 它(§3)。因此**并仓不需要改载体**,
   「对其他 Lead 零影响」是结构性的,不靠 if-present 守卫。
2. 需要改的只有**路径**:`business/current/packages/cos/dist/cli.js`
   这个相对路径,是旧班车符号链接布局的产物。
3. **活工作区那份 identity.md 里根本没有这一段**
   (`grep -n "business/current\|raya-cos" ~/Dev/raya-lead-workspace/.lead/raya/identity.md` 无输出)
   —— 生产 Raya 从未被告知要跑 cos。这是 cos 在生产完全惰性的第三重佐证。

### 6.1 宿主上已有的、可复用的部署根解析

| 事实 | 依据 |
|---|---|
| 部署根变量 `FLYWHEEL_DIR`,逐字段 `ENV > host.json > 默认` | `scripts/lib/host-config.sh:104-106` |
| 默认值 `$HOME/Dev/flywheel` | `scripts/lib/host-config.sh:106` |
| 导出点 | `scripts/lib/host-config.sh:147` `export FLYWHEEL_DIR="$(_hc_expand_path "$flywheel_dir")"` |
| `~/.flywheel/host.json` 本机**不存在** → 走默认值 | `ls ~/.flywheel/host.json` → No such file |
| `host-config.sh` 已被收敛进 `~/.flywheel/bin/lib/` | `ls ~/.flywheel/bin/lib/` |
| 收敛器 | `scripts/converge-flywheel-bin.sh:81`(`FILES`),不变量 = 内容校验和匹配 repo 源 **且** mode 555(`:15-27`) |
| Lead 子进程 PATH | `scripts/flywheel-lead.sh:8` `~/.local/bin:~/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH` —— **不含** `~/.flywheel/bin`,所以人设要用绝对路径 |

=> 并仓后把 cos 的调用形态换成「收敛进 `~/.flywheel/bin/` 的一个小 shim,
内部 source `bin/lib/host-config.sh` 后 exec `node "$FLYWHEEL_DIR/packages/raya-cos/dist/cli.js" "$@"`」
是**完全走现有房规**的做法:不改载体、不加 Lead 专属字段、跟着 Flywheel 班车一起部署,
且 `converge-flywheel-bin.sh` 的 555+校验和不变量自动覆盖它。

### 6.2 与 FLY-2657 的衔接

`engineering/doc/FLY-2657-raya-cutover-resume/plan.md`(分支 `flywheel-FLY-2657`,
进度 `progress.md` = `implement 4/6`,`nextStep: rerun full package gate after
kill-path inventory repair`)修的是旧机制的两个恢复断点:

1. `raya_verify_legacy_owners` 遇 launchd 明确报告旧服务不存在时,
   用账本 `pid + start` 只读判断旧 owner 已退场;
2. `raya-migration-init --resume-from-failed` 复用已存在的标准 Lead cursor,
   账本写 `cursor.status="preexisting"`。

**现场正好命中它要修的情形**:账本 `legacy_owner[0]` 记的是 `pid:54811 /
start:"Tue Sep  8 00:05:46 2026"`,而 `com.xrli.raya.brain` 当前是 PID 1671、
`start Thu Sep 17 10:23:39 2026`(宿主 08:55:11 重启后被拉回)。
`scripts/lib/updater-raya-deploy.sh:801-806` 要求 `.pid == $pid`,所以 prestop 必然拒绝。
另一条独立的拒绝理由:`:850` 要求 `origin/main == target_raya_sha`,
而现场 `origin/main = 90e433e8` ≠ 账本 `target_raya_sha = 5913bb47`。
**未验证**:最近一次失败具体是哪一条(未读 updater 日志)。

**两条拒绝理由都与「cos 要不要搬」无关**,所以本方案既不等 2657、也不阻塞它;
2657 成功与失败各自的衔接写在 `plan.md`。

---

## 7. 权限面

### 7.1 `founder-only-authority.md` 的三段 Raya 文本

文件:`packages/teamlead/lead-rules-base/founder-only-authority.md`(873 行)。
`~/Dev/flywheel` 主 checkout 的同名文件与本 worktree **逐字节一致**(`diff -q` 无输出);
`~/.claude/plugins/cache/` 下**没有**该文件的副本(`find` 0 命中)。
`~/.flywheel/state/FLY-2264-window/source*/` 下有旧副本,缺 `:93-114` 整段 —— 那是 9-02 的
detached worktree,不是生产。

生产装载路径:`packages/teamlead/scripts/claude-lead.sh:2687`
`BASE_RULES_DIR="${SCRIPT_DIR}/../lead-rules-base"`;Codex 侧
`packages/teamlead/scripts/codex-lead.sh:196-198`
`assemble_full_access_governance "$FLYWHEEL_LEAD_ID" "${SCRIPT_DIR}/../lead-rules-base"`;
TS 侧 `packages/teamlead/src/lead-capabilities/rule-sources.ts:243-244`。
Raya 的 `codexProfile:"full-access"` ⇒ 它装载这份文件。

| 段 | 行 | 与本单的关系 |
|---|---|---|
| 框定句 | `:26-29` 「…the separate issue-bound Raya read-receipt exemption defined under R1 below」 | 不改 |
| **「Raya 仓:merge 不等于 deploy」** | **`:94-114`** | **必须改写**:该段把「上线」定义成「班车把生产 checkout 推到目标 Raya SHA + `flywheel-lead.sh verify` + `schemaVersion:2 / carrier:standard-lead` 回执」。并仓后这三样都不再存在 |
| **FLY-2496 授权行** | **`:110-114`**,令牌行在 `:113` `FLY-2496 AUTHORIZE register cutover=<sha8> urgent-restart baseline=quiet15m` | 随旧机制一起退役 |
| **R1 窄豁免** | `:116-147`,两条机器可检条件在 **`:129`**(`summaries/` 前缀)与 **`:131-134`**(无可执行/配置文件) | **原样保留**。`:125` 点名 `xrliAnnie/raya` 与 `xrliAnnie/raya-memory` |

> 🔴 **`:129` 那一行不能动**:`scripts/verify-summary-prefix-pair.sh:46-49`
> 用正则从这份文件抽取 ``single fixed prefix `X` ``,且要求**恰好一条**声明。
> 改写 `:94-114` 时若不慎在附近新增一句含相同措辞的文本,该校验会直接失败。

被钉住原文、改动即红的测试:
`packages/teamlead/src/__tests__/lead-rules-bundle.test.ts:222-250`
(钉了 "Narrow exemption — Raya's read-receipt merges"、"single fixed prefix `summaries/`"、
"Raya 仓:merge 不等于 deploy"、"com.flywheel.updater"、"com.flywheel.lead.raya-raya"、
"公共 `flywheel-lead.sh verify`"、"`schemaVersion:2`",以及 summary-inflow 的
"Raya 代码 PR 的合入不等于部署"、"deploy-receipt.json")。

### 7.2 `summary-inflow.md:21-25` 的回执句(逐字)

```
21 - Raya 代码 PR 的合入不等于部署;定时班车通过公共 standard Lead 完成生产
22   checkout、`flywheel-lead.sh verify`、文字与 summary 验收后写入
23   `~/.flywheel/raya/deploy-receipt.json`。只有绑定两仓 SHA 的
24   `schemaVersion:2`、`carrier:standard-lead` 回执可作为上线证据;Done 条件见
25   `founder-only-authority.md` 的 R1。
```

同文件 `:26-29` 重申窄豁免只属于 Raya、只在她那两个仓、只对通过两条机器条件的 PR。
该文件仅在 `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1` 时装载(`:3-4`;
`packages/teamlead/scripts/claude-lead.sh:2871-2887` 在 duty 为真而文件缺失时 exit 1)。

### 7.3 `lead-rules-base` 是什么、怎么改

- 就是 teamlead 包里的一个 Markdown 目录:`packages/teamlead/lead-rules-base/`
  (README `:1-3` 「flywheel-shipped, project-agnostic Lead rules」)。
- 分发方式:Lead 启动时 `--append-system-prompt-file` 追加进系统提示(README `:29-34,:55`);
  Codex full-access 缺文件即 fail-closed(`codex-lead.sh:199-202`)。
- 变更流程(README `:70-78`):建文件 → 同时接进 `claude-lead.sh` 与 `lead-rules-bundle.sh`
  → 更新 README 表 → 更新 `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`。
- **没有针对规则文件的专用闸。** 真正的闸是通用的那一个:

| 事实 | 依据 |
|---|---|
| Flywheel main 保护 | `gh api repos/xrliAnnie/flywheel/branches/main/protection`:`required_status_checks:["CI OK"]`、`required_approving_review_count:0`、`enforce_admins:true` |
| 非 founder 的唯一自动合入口是 FLY-2453 窄闸,且需 `machine_class docs_only`,默认还是 `dry_run` | `founder-only-authority.md:149-155`(`:151` dry_run) |
| docs 前缀白名单 | `packages/teamlead/src/bridge/ship-relevant-diff.ts:9-16`(`doc/ docs/ engineering/doc/ product/doc/ content/doc/ marketing/doc/`),判定 `isShipDocsPath` `:143-145` |
| ⇒ `packages/teamlead/lead-rules-base/` **不在** docs 前缀里 | 所以规则文件 PR 一律判 `ship_relevant` → **不能自动合 → 必须 founder 按卡** |

### 7.4 Raya 仓的 PR 政策

- **Raya 仓 main 没有任何服务端保护**:`gh api repos/xrliAnnie/raya/branches/main/protection`
  → HTTP 404 "Branch not protected";`…/rules/branches/main` → `[]`。
- 非 `summaries/` 的 PR 不适用窄豁免:`founder-only-authority.md:135-136`
  「If either condition fails, this exemption does not apply and the normal R1
  prohibition stands」;Raya 侧合同 `raya:summaries/README.md:29-33`
  「PRs violating either rule … will sit until a human looks」。
- 既往实践:`engineering/doc/milestones/FLY-2249.md:4`「requires separate founder merge authority」;
  `engineering/doc/FLY-2159-voice-response-recovery/plan.md:240`「raya 仓 PR … merge 需 founder 单独授权」。
- **未验证**:Raya 仓最近的代码 PR `#154`(FLY-2619,2026-09-16T19:56Z 合入)
  的 `mergedBy` 显示为 `xrliAnnie` —— 但 summary PR 的 `mergedBy` 也是 `xrliAnnie`
  (Raya 用同一个 GitHub 账号),所以**从这个字段分辨不出是谁按的**。

### 7.5 两处必须纠正的工单前提

#### (A) 「今晚 FLY-2657 切换(旧机制最后一次使用)」—— 未验证

- FLY-2657 **不是一次切换**,是对既有 P0–P7 割接的两个**恢复断点修复**
  (`engineering/doc/FLY-2657-raya-cutover-resume/plan.md:10-12`,在本地分支 `flywheel-FLY-2657` 上)。
- 该单仍在 `implement 4/6`,`tests` 状态 `doing`,`nextStep: rerun full package gate after
  kill-path inventory repair`(`progress.md`,更新于 2026-09-17T20:32Z);
  **本地分支,没有 `origin/` ref,没有 PR**。
- 它的 plan `:14` 明确写「不运行班车、不更新生产 checkout、不重启服务」。
- **没有任何文档说「今晚」。** 可核到的只有:updater 定时在 00:00/12:00
  (`scripts/launchd/com.flywheel.updater.plist` 的 `StartCalendarInterval`),
  且只在 `scheduled` 唤醒且 `raya_host_capable` 时跑 `updater_raya_pass`
  (`scripts/update-flywheel.sh:714-724`)。
- ⇒ 本方案按「FLY-2657 何时落地、是否落地都不确定」来设计,两条衔接路径见 `plan.md`。

#### (B) 「FLY-2654 Part B 归档内容」—— 不在 main 上,且已关闭

- FLY-2654 在**本地+远端分支 `flywheel-FLY-2654`**(worktree `~/Dev/flywheel-FLY-2654`),
  docs-only,7 文件 +597 行;**没有 PR**(`gh pr list --search FLY-2654` 只命中无关的 #808)。
- Part B 原本要把 `founder-only-authority.md:110` 的逐-SHA 授权行换成一条 standing carve-out。
- **它已经自己关闭了**:该分支 `plan.md:122`「# Part B — 历史归档(已关闭,由 FLY-2679 取代)」;
  `plan.md:11`「founder 2026-09-17 20:29Z 已拍板 Raya 总管逻辑迁入 Flywheel(Epic FLY-2679),
  Part B 已关闭」;`progress.md:6-8`「Part B closed, superseded FLY-2679」。
- ⇒ **main 上没有 FLY-2654 Part B 的任何内容可拆。** 本方案对它的唯一动作是:
  确认 `flywheel-FLY-2654` 分支不再推进,由 Lead 决定是否把那份 docs-only 归档合入或弃掉。

### 7.6 宿主遗留(仓库外,运维动作)

| 遗留 | 状态 |
|---|---|
| `~/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` | **仍在**,mode `-r-xr-xr-x`,9-01 23:52。仓库侧守卫 `scripts/__tests__/raya-standard-migration.test.sh:82-96` 只断言**仓库里**这四个专属载体文件不存在,不覆盖宿主 bin 目录 —— 这是一条仍可执行的旧载体再入口 |
| `~/Library/LaunchAgents/com.xrli.raya.{brain,voice}.plist` | 仍在,brain 仍 loaded 且连着 Discord(§3.4) |
| `~/.flywheel/raya/{deploy-receipt.json(v1), deployed-sha, migrations/}` | 仍在,回执 `rolled_back`,账本 P2 |
| `~/.flywheel/bin/lib/raya-standard-migration.sh` | 仍在(由 `converge-flywheel-bin.sh:81` 收敛) |
