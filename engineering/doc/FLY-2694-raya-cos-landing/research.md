# FLY-2694 cos 落地 Flywheel — 调研

Issue: FLY-2694 (https://linear.app/geoforge3d/issue/FLY-2694/raya-并仓s1-packagescos-落地-flywheel-仓包名-flywheel-raya-cos接入-workspace)
日期: 2026-09-17
基于: exploration.md

> 路径约定:无前缀的路径相对 Flywheel 仓(本 worktree `~/Dev/flywheel-FLY-2694`,HEAD `f01754584`);
> Raya 仓路径标 `raya:`,读法为 scratchpad 里 `git clone --filter=blob:none` 后
> `git show origin/main:<path>`(`origin/main = 90e433e8`)。
> **本节点没有读、没有 fetch 生产 checkout `~/.flywheel/raya/code`。**
>
> §4 的「实测」是在本 worktree 里做的**一次性可行性 spike**:把 cos 落进 `packages/raya-cos/`
> 跑 install/typecheck/build/test/biome,**做完即整目录移出 worktree、lockfile 复原**,
> `git status` 为空。spike 产物留在本会话 scratchpad,不入库;plan.md 的施工书按它的结果写。

## 1. Raya 侧:要搬的东西到底是什么

| 项 | 值 | 依据 |
|---|---|---|
| 顶层文件 | `README.md`、`package.json`、`tsconfig.json`、`src/` —— **没有** vitest 配置、没有 `dist/`、没有 `biome.json` | `git ls-tree --name-only origin/main:packages/cos` |
| `src/**` | 120 个 `.ts`(65 源 + 55 `*.test.ts`,测试与源**同目录**,如 `src/cli.test.ts`);无任何非 `.ts` 文件 | `git ls-tree -r` 计数 |
| 外部 import | 只有 `vitest`(测试)与 `node:path` / `node:fs` / `node:crypto` / `node:os` / `node:child_process` / `node:buffer` / `node:url`;**零第三方运行时依赖** | `git grep -h -o 'from "[^.][^"]*"' origin/main -- packages/cos/src` 去重 |
| `process.env` | 非测试代码零读取;`src/cli.ts:79` 只用 `process.cwd()` 作默认 workspace;`raya:packages/cos/src/portfolio/goal-store.test.ts:47` 给 `execFile` 子进程合并环境 | `git grep` |
| 测试的外部依赖 | 大量 `mkdtempSync(tmpdir())`;`goal-store.test.ts:27-33` 用真 `git init -b main` + 自设 `user.name/email`(不依赖全局 git 身份) | 同上 |
| `package.json` | `name: @raya/cos`,`private`,`type: module`,`exports: ./dist/index.js`,`bin: {raya-cos: ./dist/cli.js}`,scripts `build: tsc -p tsconfig.json` / `lint: biome check src` / `test: vitest run` / `typecheck: tsc -p tsconfig.json --noEmit`;**没有** `dependencies` / `devDependencies`(由 Raya 根 `package.json` 提供 `@types/node ^20` / `typescript ^5.3.3` / `vitest ^3.1.4` / `@biomejs/biome 2.1.4`) | `git show origin/main:packages/cos/package.json`、`origin/main:package.json` |
| `tsconfig.json` | `extends: ../../tsconfig.json`,`rootDir: src`,`outDir: dist`,`include: src/**/*.ts`,`exclude: src/**/*.test.ts` | `git show` |
| Raya 根 `tsconfig.json` | `target ES2022`、`module/moduleResolution NodeNext`、`strict`、`declaration`、`esModuleInterop`、`forceConsistentCasingInFileNames`、`skipLibCheck` —— **没有** `noUncheckedIndexedAccess` / `noUnused*` / `noImplicitReturns` | `git show origin/main:tsconfig.json` |
| Raya `biome.json` | 2.1.4,`indentStyle: tab`,recommended 规则 —— 与 Flywheel 根 biome 同版本同缩进 | `git show origin/main:biome.json` |
| Raya CI | 单 job `business`:`pnpm lint` → `pnpm -r build` → `pnpm --filter @raya/cos test` → `pnpm verify:business-package` | `git show origin/main:.github/workflows/ci.yml` |
| README | 319 行;`:7-12` 钉的是**上一次 extraction** 的四个来源 SHA(Raya main `0f77e977` 等);`:26` 写 `node business/current/packages/cos/dist/cli.js` | `git show … README.md` |

## 2. `scripts/verify-business-package.mjs` 的 CLI 三条(§5.4 要求保留)

`raya:scripts/verify-business-package.mjs:102-121` 对**构建产物** `dist/cli.js` 以**子进程**方式断言:

| # | 命令 | 期望 |
|---|---|---|
| a | `daily-report-date --now 2026-09-09T01:00:00Z --timezone America/Los_Angeles --time 18:00` | stdout `2026-09-08` |
| b | `status`(空 workspace) | JSON 且 `operations` 深等于 `[]` |
| c | `daily-report-migration-plan`(空 workspace) | JSON 且 `entries` 深等于 `[]` |

`raya:packages/cos/src/cli.test.ts` 现有覆盖(**进程内**调 `runCoSCommand`,不经过 `dist/`):

| # | 覆盖 | 位置 |
|---|---|---|
| a | ✅ 完全相同的参数与期望 | `cli.test.ts:14-30` |
| b | ⚠️ 只覆盖「记录一个 operation 之后的 status」(`operations: [{operationId: "report:one", …}]`),**没有空 workspace 的 `operations: []`** | `cli.test.ts:108-112` |
| c | ✅ `entries: []` 且不创建 `state/` | `cli.test.ts:148-166` |
| 可执行入口 | ❌ `src/cli.ts:215` 的 main-guard(`import.meta.url === pathToFileURL(realpathSync(executable)).href`)只有**真的以子进程跑 `dist/cli.js`** 才会走到;进程内测试永远不经过它 | — |

spike 实测(§4.5):以子进程跑构建出的 `dist/cli.js`,三条输出分别为
`2026-09-08`、`{"schemaVersion":2,"operations":[]}`、
`{"schemaVersion":1,"kind":"daily_report_migration","entries":[],"digest":"4f53cda1…"}`。
**副作用**:`status` 在空 workspace 里会创建 `state/cos/operations/` 目录(`migration-plan` 不创建);
这是 Raya 侧原有行为,不是本单引入的。

## 3. Flywheel 侧:接入点逐个 file:line

### 3.1 workspace

`pnpm-workspace.yaml:1-2` 是 `packages: [packages/*]` —— 新目录**自动**入 workspace,零改动。

### 3.2 两个发现器(plan §5.2 表,已核)

| 发现器 | file:line | 判据 |
|---|---|---|
| CI `light` shard | `.github/workflows/ci.yml:217-220`:`pnpm --filter './packages/*' --filter '!flywheel-teamlead' --filter '!flywheel-claude-runner' --filter '!flywheel-comm' --filter '!flywheel-edge-worker' test:run` | 目录在 `packages/*` 且不在四个排除名单 ⇒ 被 filter 选中;pnpm 对没有 `test:run` 的包**静默跳过** |
| package gate | `scripts/package-gate.mjs:149-154`:`readdirSync(join(root,"packages"))…filter(pkg => pkg?.scripts?.["test:run"])`,再按 `name` 排序逐包 `pnpm --filter <name> test:run`;`:157` 若 script 以 `vitest run` 开头则加 `--reporter=…package-gate-reporter.mjs` | **必须** `test:run` 且建议字面 `vitest run`(否则拿不到结构化 receipt,`classifyAttempt :3-22` 的 worker_rpc_timeout 分类也失效) |

spike 实测(§4.4):补 `test:run` 后,复刻 gate 过滤器得到 **19** 个包(原 18 + `flywheel-raya-cos`);
light shard 的 filter 表达式 dry-run 选中 **20** 个包,其中含 `flywheel-raya-cos`
(20 ≠ 19 是因为 filter 也选中了没有 `test:run` 的 `@flywheel-ai/onboard`,pnpm 对它静默跳过)。

### 3.3 CI 里 build 先于 test 的事实

七个 job 都在跑测试前 `pnpm build`:`ci.yml:126`(quick-gate)、`:251`(unit-tests)、
`:308`(script-tests)、`:538`(-2)、`:935`(-3)、`:1254`(-4)、`:1358`(-5)。
`unit-tests` 的顺序是 `pnpm install --frozen-lockfile :237` → apt → better-sqlite3 → `pnpm build :251` → matrix。
⇒ 任何依赖 `packages/raya-cos/dist/` 的 script 测试放在 script-tests 任一 shard 都能拿到构建产物。

### 3.4 script 测试的注册规则

`scripts/__tests__/ci-shell-suite-enumeration.test.sh:29-35`:`scripts/__tests__/*.test.mjs`
**每一个**都必须以 `node --test scripts/__tests__/<name>.test.mjs` 的字面形式出现在 `ci.yml`,
否则该测试自己红(「new suites cannot remain local-only coverage」)。
现成写法例:`ci.yml:318-319`(FLY-2664 `node --test scripts/__tests__/audit-merged-worktrees.test.mjs`)。
shard 5(`ci.yml:1324-1332`)是 FLY-2598 后的最轻 shard(基线 490s,预算 1020s)。

### 3.5 tsconfig

`tsconfig.base.json`(仓根**只有**这一份,无 `tsconfig.json`):`module ESNext`、`moduleResolution node`、
`strict`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`noFallthroughCasesInSwitch`、
**`noUncheckedIndexedAccess`**、`declaration`/`declarationMap`/`sourceMap`。
参照包 `packages/voice-core/tsconfig.json:2-7`:extends base,包级覆盖回 `module/moduleResolution: NodeNext`。
**23 个包没有任何一个覆盖 base 的严格开关**(`grep -L tsconfig.base packages/*/tsconfig.json` 空;
`grep -n noUncheckedIndexedAccess packages/*/tsconfig.json` 空)。

### 3.6 lint

根 `package.json` `lint: biome check`(全仓);`biome.json` `files.includes` 排除 `engineering/doc/**` 等,
**不排除** `packages/*`;`formatter.formatWithErrors`;缩进默认 tab(与 Raya 一致)。
Raya 侧的 `lint: biome check src` script 在 Flywheel 里多余(plan §5.2 说可删)。

### 3.7 lockfile

`pnpm-lock.yaml` `importers` 段按包路径分条;上一次新增包(FLY-546 `packages/voice-headphone`,#496)
在包目录之外**只**改了 `pnpm-lock.yaml`(+19)。仓内没有其它「包清单」:
`grep -rl voice-headphone` 在包外只命中 lockfile、`voice-core`(它的 import)、`teamlead/ProjectConfig.ts`(功能接线)
与若干历史 `package-gate*.json` 证据文件。

### 3.8 packaged 闭包(不进)

`scripts/package-onboard.sh:47` `PO_PACKAGES` 是固定列表(plan §6.2 原文已抄录),不含 `raya-cos`;
plan §6.2 裁定不进。S1 不改它。

## 4. 可行性 spike 实测(本 worktree,已清理)

### 4.1 布置

`git -C <scratch>/raya archive origin/main packages/cos | tar -x --strip-components=2` 到 `packages/raya-cos/`
(src 120 文件 + README 原样);写 `package.json`(name `flywheel-raya-cos`,加 `test:run`,删 `lint`,
加三条 devDependencies)与 `tsconfig.json`(extends base + `NodeNext` 覆盖)。

### 4.2 install

`pnpm install --offline` 10s 完成;lockfile 净增 **12 行**,只多 `packages/raya-cos` 一个 importer 条目,
三个 devDep 解析到已在锁里的 `@types/node 20.19.21` / `typescript 5.9.3` / `vitest 3.2.4(patch_hash=6cbeb8d…)`,
**零新 resolution**。随后 `pnpm install --frozen-lockfile --offline` 通过
(有一条与本单无关的既有 WARN:`voice-codex` 的 `flywheel-voice-bridge` bin 目标 dist 不存在,未 build 所致)。

### 4.3 typecheck / build:直接 extends base 会红

| 配置 | `tsc --noEmit` 结果 |
|---|---|
| extends base + `NodeNext` 覆盖(照 voice-core 抄) | **170 错误**,26 个源文件;按码:`TS2322` 127、`TS2345` 39、`TS2532` 2、`TS18048` 1、`TS2538` 1;全是 `JsonValue \| undefined` 不可赋给 `JsonValue` 一类 |
| 上式 + `--noUncheckedIndexedAccess false` | **0 错误** |
| 上式 + 再关 `noUnusedLocals` / `noUnusedParameters` | 0 错误(说明这两个开关本来就不红,**不需要**关) |

⇒ 唯一需要覆盖的开关是 `noUncheckedIndexedAccess`。包级 tsconfig 加 `"noUncheckedIndexedAccess": false` 后
`pnpm build` / `pnpm typecheck` 全绿,`dist/` 260 文件,无 `*.test.*` 产物。

### 4.4 test / lint / 发现器

- `pnpm --filter flywheel-raya-cos test:run`:**55 files / 310 tests 全绿**,17s(`goal-store` 的真 git 用例最慢 3.5s)。
- `pnpm exec biome check packages/raya-cos`:122 文件,0 诊断(Raya 侧就是 tab + biome 2.1.4,格式无冲突)。
- 根 `pnpm lint`:4929 文件,22 个 warning、0 error —— warning 全是仓内既有的,不在 `packages/raya-cos`。
- 发现器:见 §3.2。

### 4.5 dist CLI 三条对照

见 §2。三条均与 `verify-business-package.mjs` 期望一致。

### 4.6 未在 spike 里跑的(留给实施节点的 §5.3 全套)

`pnpm -r build` 全仓、`pnpm -r typecheck` 全仓、`node scripts/package-gate.mjs` 全仓
—— 都是分钟级全量命令,且没有其它包 import 本包,不存在跨包类型影响;
实施节点按 plan §5.3 跑完整套并把 `PACKAGE_GATE_RECEIPT` 的 summary.json 贴进 PR。

## 5. 与上游 plan 的差异(只有事实修正,无口径变更)

| plan 原文 | 实况 | 影响 |
|---|---|---|
| §4.1「`extends` 改成 `tsconfig.base.json`」 | 还必须包级关 `noUncheckedIndexedAccess`(§4.3) | plan.md §3.2 新增裁定 |
| §4.4「5 个代码 commit」 | 6 个 | 措辞 |
| §5.4 CLI 三条「`cli.test.ts` 已存在,确认是否已覆盖;未覆盖就补」 | (b) 空 workspace `status` 未覆盖;可执行入口 main-guard 无任何覆盖(§2) | plan.md §4 补两处测试 |
| §5.4「运行时依赖数为 0 …建议做成 `scripts/__tests__/` 里的小 node:test」 | 采纳,但放进包内 vitest 更省一条 ci.yml 注册(§3.4);dist 入口对照才需要 script-tests(§3.3) | plan.md §4 |

## 6. 现场事实(与 S1 无关,只记录)

- 旧壳 `com.xrli.raya.brain` 已于 2026-09-17T22:01Z 由 Lead 按 founder 指示 `bootout + disable`(工单原话)。
  S1 不部署、不重启,与此无关;S2/T6 的施工者要把 plan 里「停旧 Raya」读成「复核仍为停用」。
- FLY-2657(PR #1241)独立推进;plan §9.4 末行:S1 不碰 `updater-raya-deploy.sh`,可并行。
- Linear MCP 本会话 401,Epic FLY-2679 正文未读;工单正文已把 QA 判据原文抄给本单,足够施工。
