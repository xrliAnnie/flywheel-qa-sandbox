# FLY-2694 cos 落地 Flywheel — 实施计划

Issue: FLY-2694 (https://linear.app/geoforge3d/issue/FLY-2694/raya-并仓s1-packagescos-落地-flywheel-仓包名-flywheel-raya-cos接入-workspace)
日期: 2026-09-17
基于: exploration.md, research.md(上游施工依据:`engineering/doc/FLY-2680-raya-merge-plan/plan.md` §4 / §4.4 / §5 / §9.4 / §12 S1 行)

> **版本**:v3(Codex R1 七条 + R2 四条全部采纳,见 `design-review-round1.md` / `design-review-round2.md`;
> R1 的三条阻断分别是:CI 结构守卫会拒新 shard step、QA ⑤ 可被删除/改名绕过、lockfile 校验必误报)。
> 本单是 Epic FLY-2679 的 **S1**。上游 plan 已定边界、包名、script 与 QA 判据;
> 本文档把它们落到**逐文件、逐命令、逐用例**,并加上 research §4 spike 实测出来的
> 一条上游没核到的必要动作(tsconfig 单开关,§3.2)。**不重新设计。**

## 1. 一句话

把 `xrliAnnie/raya@90e433e87a68287ed59ba64f2584e3a6bc0da151:packages/cos` 的 120 个 `.ts` + README
**原样**落到 `packages/raya-cos/`,配一份 Flywheel 口径的 `package.json` / `tsconfig.json`,
加两份守卫测试与一行 CI 注册,提交 lockfile。精确头 CI 暴露既有全仓扫描的固定超时后，
按 Lead 裁定仅优化该测试的候选输入；除此之外不改任何既有产品文件。
落地后它自动进 workspace、CI `light` shard 与 package-gate;没有任何运行时消费者(shim 在 S2)。

## 2. 变更面(白名单)与禁区

### 2.1 白名单 —— PR 相对 `origin/main` 的变更集**必须恰好等于**下表

| 路径 | 状态 | 来源 |
|---|---|---|
| `packages/raya-cos/src/**`(120 文件) | A | Raya `90e433e8:packages/cos/src/**`,**逐字节相同**(§4 C1 校验) |
| `packages/raya-cos/README.md` | A | Raya 同路径 + §4 C3 的三处改动 |
| `packages/raya-cos/package.json` | A | §4 C2 全文 |
| `packages/raya-cos/tsconfig.json` | A | §4 C2 全文 |
| `packages/raya-cos/src/package-contract.test.ts` | A | §4 C4-a,**新文件**(不改任何搬来的文件) |
| `scripts/__tests__/raya-cos-cli-dist.test.mjs` | A | §4 C4-b |
| `.github/workflows/ci.yml` | M | §4 C4-b:quick-gate 既有 step「Test — root Node contract suites」的 `run` 块**追加一行**(不新增 step,见 §3.7) |
| `packages/config/src/__tests__/fly1981-final-ledgers.test.ts` | M | Lead 批准的精确头 CI 修复：只扫描含 `FLYWHEEL` 的候选文件，并以拼接 fixture / 过滤前后集合等价测试防止假守卫；不改 15s 超时 |
| `pnpm-lock.yaml` | M | §4 C5:只多 `packages/raya-cos` 一个 importer 条目(research §4.2 实测 +12 行,零新 resolution) |
| `engineering/doc/FLY-2694-raya-cos-landing/**` | A | 本设计文档夹 + 实施/QA 记录 |

合同例外：`engineering/doc/milestones/<issue>.md` 由 implement 合同要求，不计入产品白名单。

### 2.2 禁区 —— QA 判据 ⑤ 的 fail-closed 集合检查(单一脚本,输出即证据)

```bash
#!/bin/bash
# S1 boundary check — run from repo root on the PR head; paste the full output into the PR.
set -euo pipefail
base="origin/main"
git fetch -q origin main
status="$(git diff --name-status --find-renames "$base...HEAD")"
printf '%s\n' "$status"
# 1) any status other than A / M is forbidden: no deletes, renames, copies, type changes, unmerged.
if printf '%s\n' "$status" | awk '{print $1}' | grep -Ev '^(A|M)$' >/dev/null; then
  echo "S1-BOUNDARY FAIL: non-A/M status present"; exit 1; fi
# 2) modified pre-existing files must be exactly these three.
expected_m=$'.github/workflows/ci.yml\npackages/config/src/__tests__/fly1981-final-ledgers.test.ts\npnpm-lock.yaml'
actual_m="$(printf '%s\n' "$status" | awk '$1=="M"{print $2}' | LC_ALL=C sort)"
[ "$actual_m" = "$expected_m" ] || { echo "S1-BOUNDARY FAIL: modified set = $actual_m"; exit 1; }
# 3) added files must live under the allowed prefixes; scripts/** admits exactly one file.
added="$(printf '%s\n' "$status" | awk '$1=="A"{print $2}')"
if printf '%s\n' "$added" | grep -vE '^(packages/raya-cos/|scripts/__tests__/raya-cos-cli-dist\.test\.mjs$|engineering/doc/FLY-2694-raya-cos-landing/|engineering/doc/milestones/FLY-2694\.md$)' >/dev/null; then
  echo "S1-BOUNDARY FAIL: added file outside allowed prefixes"; exit 1; fi
[ "$(printf '%s\n' "$added" | grep -c '^scripts/')" -eq 1 ] || { echo "S1-BOUNDARY FAIL: scripts/ additions != 1"; exit 1; }
# 3b) inside packages/raya-cos/: the non-src additions must be exactly these three; src additions must be .ts
#     files and number exactly 121 (120 upstream + the guard). C1 proves the src CONTENT/SET against the pin.
expected_pkg_root=$'packages/raya-cos/README.md\npackages/raya-cos/package.json\npackages/raya-cos/tsconfig.json'
actual_pkg_root="$(printf '%s\n' "$added" | grep '^packages/raya-cos/' | grep -v '^packages/raya-cos/src/' | LC_ALL=C sort)"
[ "$actual_pkg_root" = "$expected_pkg_root" ] || { echo "S1-BOUNDARY FAIL: package root set = $actual_pkg_root"; exit 1; }
src_added="$(printf '%s\n' "$added" | grep '^packages/raya-cos/src/' || true)"
[ "$(printf '%s\n' "$src_added" | grep -c .)" -eq 121 ] || { echo "S1-BOUNDARY FAIL: src additions != 121"; exit 1; }
if printf '%s\n' "$src_added" | grep -v '\.ts$' >/dev/null; then echo "S1-BOUNDARY FAIL: non-.ts under src"; exit 1; fi
printf '%s\n' "$src_added" | grep -qx 'packages/raya-cos/src/package-contract.test.ts' || { echo "S1-BOUNDARY FAIL: guard test missing"; exit 1; }
# 4) belt and braces: no touched path (any status) names a raya/updater script outside the new package/doc/test.
if printf '%s\n' "$status" | awk '{print $NF}' | grep -Ei 'raya|updater' | grep -vE '^(packages/raya-cos/|scripts/__tests__/raya-cos-cli-dist\.test\.mjs$|engineering/doc/FLY-2694-raya-cos-landing/)' >/dev/null; then
  echo "S1-BOUNDARY FAIL: raya/updater path touched"; exit 1; fi
echo "S1-BOUNDARY OK"
```

设计要点:先**拒绝一切非 A/M 状态**(所以删掉 `scripts/update-flywheel.sh` 或改名 `lead-patrol-snapshot.sh`
都在第 1 步就红,不再依赖文件名里有没有 `raya`);`M` 集合做**精确等值**;其中 config 测试是
精确头 CI 两次触发固定 15s 超时后由 Lead 批准的范围例外;`A` 只准三个前缀且
`scripts/` 下恰好一个;**包目录内部也做精确等值**(3b:包根恰好三个文件,`src/` 恰好 121 个 `.ts` 且含守卫)——
这样 `packages/raya-cos/scripts/anything.sh` 之类的夹带会红(Codex R2#2 用合成 diff 证明 v2 放过了它);
第 4 步是对上游措辞「任何 raya / updater 脚本」的字面兜底。
新增文件名里出现 `raya`(测试文件、文档夹)不算「触碰 raya 脚本」——判据说的是**既有**脚本。
C1 的字节校验负责「A 集合里 `src/` 的内容是什么」,本脚本负责「变更集的形状」,两者合起来才是 ⑤ 的证据。

明确**不做**(上游 plan §9.4、§6.2):不加 `scripts/raya-cos.sh`、不改 `converge-flywheel-bin.sh`、
不改 `scripts/package-onboard.sh` 的 `PO_PACKAGES`、不碰 `scripts/lib/updater-raya-deploy.sh` /
`update-flywheel.sh` / `lead-patrol-snapshot.sh` / 任何 `raya-*` 测试、不碰 Raya 仓、不碰 `.lead/`、
不部署、不重启。

## 3. 裁定(每条一句理由)

| # | 裁定 | 理由 / 依据 |
|---|---|---|
| 3.1 | 目录 `packages/raya-cos/`,包名 `flywheel-raya-cos`,bin `raya-cos → dist/cli.js` | 上游 §5.1 原文;`cos` 在 Flywheel 已被 CoS Lead 占用 |
| 3.2 | **包级 tsconfig 只关一个开关 `noUncheckedIndexedAccess: false`;源码 120 文件字节不改** | research §4.3:直接 extends base 报 170 错、全由该开关引起,关掉即 0 错;其它严格开关(`noUnused*`、`noImplicitReturns`…)cos 本来就过。这是 Raya 侧编译语义的**原值**而非放松;改源码会破坏 §4.4 provenance 的可核性,并让 S3 删 Raya 副本时无法对照。Flywheel 里没有先例,所以用 C4-a 的测试把「只此一个」锁死。Codex R1 用等价编译参数独立复现了 0/170 的分界 |
| 3.3 | `package.json` 删 `lint` script、补 `test:run`,`build`/`typecheck` 保留 `-p tsconfig.json` 原样 | 上游 §5.2;根 `biome check` 覆盖全仓(research §3.6);`test:run` 字面必须是 `vitest run` 以命中 `package-gate.mjs:164-173` 的 reporter 分支(`/^vitest run(?:\s|$)/` 判定 + `--reporter=…package-gate-reporter.mjs` 追加) |
| 3.4 | `devDependencies` 只写 `@types/node ^20.0.0` / `typescript ^5.3.3` / `vitest ^3.1.4`;**没有** `dependencies` 键 | Raya 根 `package.json` 的三条原值;research §4.2 证明零新 resolution;C4-a 守卫「零运行时依赖」 |
| 3.5 | `private: true`,不写 `publishConfig`、不写 `files` | 本包不发布;上游 §6.2 裁定 Raya 不属于客户 MVP 运行时,不进 packaged 闭包 |
| 3.6 | README:顶部加 provenance 块;`:25-27` 的「从 registered workspace 跑 `business/current/...`」两句**一起**改成「Flywheel checkout 内的开发调用」;历史 extraction 四个 SHA(`:7-12`)**保留不改** | 上游 §4.4「README 顶部留一行 provenance」;`:7-12` 记录的是更早一次抽取的来源,仍是事实;「更新 `:9` 钉的 SHA」以**新增本次 pin** 满足;只换命令不换前一句会让读者从 business workspace 用相对路径找不到文件(Codex R1#5) |
| 3.7 | CLI 三条对照放 `scripts/__tests__/raya-cos-cli-dist.test.mjs`(node:test,跑构建产物),注册方式 = 在 quick-gate 既有 step「Test — root Node contract suites」(`ci.yml:129-155`,位于 `Build :125-126` 之后)的 `run` 块**追加一行** | 上游 §5.4「必须保留」;`cli.test.ts` 是进程内测试,永远不经过 `src/cli.ts:215` 的可执行 main-guard(research §2);`ci-shell-suite-enumeration.test.sh:29-35` 强制字面注册;**不能**新增 shard step —— `ci-structure.test.sh:877-885,910-940` 对五个 script shard 的 step 名称与顺序做精确等值,且它在 always-on quick-gate 跑(`ci.yml:66-67`);而该守卫**不**约束「root Node contract suites」step 的 `run` 内容(grep 该 step 名在 `ci-structure.test.sh` 无命中),这正是 FLY-2388 给根级 node:test 留的接入口(`ci.yml:127-129` 注释) |
| 3.8 | 「零 dependencies + manifest 合同」守卫放**包内** `src/package-contract.test.ts`(vitest) | 上游 §5.4 建议 node:test,但包内 vitest 自动进 light shard 与 package-gate,少一条 ci.yml 注册;且能用 `import.meta.url` 相对定位包根与仓根 |
| 3.9 | 不修改搬来的任何 `*.test.ts`;空 workspace `status` 的缺口由 C4-b 的子进程用例补 | 保持 src 字节一致(3.2);C4-b 本来就要跑这三条 |
| 3.10 | 一个 PR,**三个** commit:①搬运+manifest+lockfile,②守卫+CI 接线,③docs/evidence(见 §7);「被测 SHA」= commit ② | commit ① message 钉来源 SHA(上游 §4.4);package-gate receipt 会把运行时 HEAD 写进 summary(`package-gate.mjs:110-126`),CI 证据只能在 push 之后产生,所以 evidence 必然是第三个 docs-only commit,且必须**先推 ②、等其 CI 完成、再推 ③**(§7 时序),PR 描述要写清「tested code SHA = ②」(Codex R1#7、R2#3) |
| 3.11 | 精确头 light 的 FLY-1981 扫描只把含 `FLYWHEEL` 的文件交给 AST scanner；固定 15s 超时不变 | 两次 CI 都在 CoS 56/317 全绿后于同一全仓扫描超时；`FLYWHEEL`（不带下划线）保留拼接构造文件，回归逐一比较过滤前后命中集合；Lead 明确批准此唯一范围扩展 |

## 4. 施工步骤(chunk 即 progress.md 的 chunk id)

### C1 落盘(纯搬运,不带历史)—— 自包含、fail-closed

```bash
#!/bin/bash
set -euo pipefail
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
PIN=90e433e87a68287ed59ba64f2584e3a6bc0da151
# 临时克隆;不要动 ~/.flywheel/raya/code 生产 checkout
git clone -q --filter=blob:none https://github.com/xrliAnnie/raya.git "$work/raya"
git -C "$work/raya" cat-file -e "$PIN^{commit}"
# 上游 plan 钉的是 PIN;若 origin/main 的 packages/cos 子树已变,停下问 Lead,不要自选
if [ "$(git -C "$work/raya" rev-parse "$PIN:packages/cos")" != "$(git -C "$work/raya" rev-parse origin/main:packages/cos)" ]; then
  echo "SUBTREE MOVED vs $PIN — stop and ask Lead"; exit 1; fi
mkdir -p packages/raya-cos
git -C "$work/raya" archive "$PIN" packages/cos | tar -x -C packages/raya-cos --strip-components=2
rm packages/raya-cos/package.json packages/raya-cos/tsconfig.json     # C2 重写这两份
# 字节一致校验(贴进 PR)。排除且只排除仓内新增的守卫文件(按完整路径,不按 basename)
GUARD=packages/raya-cos/src/package-contract.test.ts
git -C "$work/raya" ls-tree -r "$PIN" packages/cos/src | awk '{print $3, $4}' \
  | sed 's#packages/cos/#packages/raya-cos/#' | LC_ALL=C sort > "$work/expected"
find packages/raya-cos/src -type f | grep -Fvx -- "$GUARD" \
  | while read -r f; do echo "$(git hash-object "$f") $f"; done | LC_ALL=C sort > "$work/actual"
diff "$work/expected" "$work/actual" && echo "src byte-identical to $PIN"
test "$(wc -l < "$work/expected")" -eq 120
test "$(find packages/raya-cos/src -type f | wc -l)" -eq "$([ -f "$GUARD" ] && echo 121 || echo 120)"
```

`diff` 为空同时证明**集合相等**(多一个或少一个文件都会出现在 diff 里),不是只比 hash。

### C2 两份 manifest(全文,直接落盘)

`packages/raya-cos/package.json`:

```json
{
	"name": "flywheel-raya-cos",
	"version": "0.1.0",
	"private": true,
	"description": "Raya CoS business package landed from xrliAnnie/raya@90e433e87a68287ed59ba64f2584e3a6bc0da151:packages/cos (FLY-2694). Zero runtime dependencies; no resident entrypoint.",
	"type": "module",
	"exports": "./dist/index.js",
	"bin": {
		"raya-cos": "./dist/cli.js"
	},
	"scripts": {
		"build": "tsc -p tsconfig.json",
		"test": "vitest run",
		"test:run": "vitest run",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"devDependencies": {
		"@types/node": "^20.0.0",
		"typescript": "^5.3.3",
		"vitest": "^3.1.4"
	}
}
```

`packages/raya-cos/tsconfig.json`(JSON 不能带注释,来源说明写在 README §「Build」与 C4-a 的测试名里):

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"noUncheckedIndexedAccess": false
	},
	"include": ["src/**/*.ts"],
	"exclude": ["src/**/*.test.ts"]
}
```

### C3 README 三处改动(其余行不动)

1. 第 1 行标题之后插入 provenance 块:
   ```markdown
   > **Provenance (FLY-2694 / Epic FLY-2679 S1).** Landed in the Flywheel repo from
   > `xrliAnnie/raya@90e433e87a68287ed59ba64f2584e3a6bc0da151:packages/cos` as
   > `packages/raya-cos` (package `flywheel-raya-cos`) without git history; the
   > pre-landing history stays in the Raya repo. The 120 upstream `src/` files are
   > byte-identical to that commit. Flywheel-side changes are limited to
   > `package.json`, `tsconfig.json`, the edits in this README, and the added
   > `src/package-contract.test.ts`.
   ```
2. `:25-27` 整段替换(原文「Run the CLI from the registered workspace via `node business/current/packages/cos/dist/cli.js`」):
   ```markdown
   For development inside the Flywheel checkout, build the package and run the CLI
   from the repo root via `node packages/raya-cos/dist/cli.js`. S1 (FLY-2694) ships no
   runtime consumer: the stable entry point for the registered business workspace is
   the host shim `raya-cos.sh` delivered by S2, so until then do not assume a
   `raya-cos` executable on PATH or any pre-linked package directory inside the
   workspace.
   ```
   后续「`prepare`, `record`, and `resume` accept `--input <workspace-relative-json>`…」原句保留。
   新段落刻意**不含** `business/current` 字样,否则下面的收尾 grep 必红(Codex R2#1)。
3. 末尾追加 `## Build` 小节,两句:extends `tsconfig.base.json`;`noUncheckedIndexedAccess` 在包级关闭,
   因为源码是按 Raya 根 tsconfig(无该开关)写的,并由 `src/package-contract.test.ts` 锁定只此一处覆盖。

收尾校验:`grep -n 'business/current\|@raya/cos' packages/raya-cos/README.md` 必须无输出。

### C4 守卫测试

**C4-a** `packages/raya-cos/src/package-contract.test.ts`(vitest,新文件;用 `new URL("../package.json", import.meta.url)` 定位包根,`new URL("../../../", import.meta.url)` 定位仓根):

| 用例 | 断言 |
|---|---|
| manifest identity | `name === "flywheel-raya-cos"`,`private === true`,`type === "module"`,`bin["raya-cos"] === "./dist/cli.js"`,`exports === "./dist/index.js"` |
| CI discoverability | `scripts["test:run"] === "vitest run"`(字面,含 package-gate reporter 分支要求);`scripts.build`/`scripts.typecheck` 存在 |
| zero runtime deps(manifest) | `"dependencies" in pkg === false`,`"peerDependencies" in pkg === false`,`"optionalDependencies" in pkg === false`;`Object.keys(devDependencies)` 排序后深等于 `["@types/node","typescript","vitest"]` |
| zero runtime deps(source, AST) | 用 `typescript` 的 `createSourceFile` 遍历 `src/**/*.ts`(排除 `*.test.ts`),收集全部模块说明符:`ImportDeclaration.moduleSpecifier`、`ExportDeclaration.moduleSpecifier`、`ImportEqualsDeclaration` 的 `ExternalModuleReference`、`CallExpression` 中 callee 为 `require` 或 `ImportKeyword` 的第一个字符串实参。每个说明符必须以 `./`、`../` 或 `node:` 开头;否则失败并打印 `文件:行 说明符`。收集逻辑抽成 `collectSpecifiers(text)` 纯函数 |
| source guard 正向对照(非空证明) | 对 `collectSpecifiers` 喂三段内存变异体:`import "left-pad";`(side-effect import)、`const x = require("left-pad");`、`import lp = require("left-pad");` —— 三者都必须被判为违规;再喂 `import { a } from "./a.js"; import { b } from "node:fs";` 必须判为合规 |
| tsconfig single override | `extends === "../../tsconfig.base.json"`;`Object.keys(compilerOptions)` 排序后深等于 `["module","moduleResolution","noUncheckedIndexedAccess","outDir","rootDir"]`;各值精确等于 `NodeNext` / `NodeNext` / `false` / `dist` / `src`;`include` 深等于 `["src/**/*.ts"]`,`exclude` 深等于 `["src/**/*.test.ts"]`;同时读 `../../tsconfig.base.json` 断言其 `compilerOptions.noUncheckedIndexedAccess === true`(证明「例外」确有其事,base 若将来放松,此断言提醒删掉包级覆盖) |
| not packaged | 读 `scripts/package-onboard.sh`:断言以 `PO_PACKAGES=` 开头的行**恰好一行**且该行不以 `\` 结尾(唯一静态赋值、无续行);用正则 `^PO_PACKAGES=\$\{PO_PACKAGES:-"([^"]*)"\}$` 提取默认值,按空白切 token,断言 token 集合不含 `raya-cos`;并断言全文没有第二处 `PO_PACKAGES=`(上游 §6.2 裁定;若将来改裁定,这条测试逼实施者同时改 payload allowlist / compat mirror / audit row) |

**C4-b** `scripts/__tests__/raya-cos-cli-dist.test.mjs`(`node:test`,跑**构建产物**):

| 用例 | 断言 |
|---|---|
| dist present | `packages/raya-cos/dist/cli.js` 存在;**不存在即失败(不是 skip)**——quick-gate 在该 step 之前已 `pnpm build`(`ci.yml:125-126`),本地要先 `pnpm --filter flywheel-raya-cos build` |
| (a) daily-report-date | `execFileSync(process.execPath,[cli,"daily-report-date","--now","2026-09-09T01:00:00Z","--timezone","America/Los_Angeles","--time","18:00"],{cwd})` stdout trim 等于 `2026-09-08` |
| (c) migration-plan 先于 status | 在**新** `mkdtemp` workspace 里先跑 `daily-report-migration-plan`:JSON,`kind === "daily_report_migration"`,`entries` 深等于 `[]`;随后 `existsSync(join(ws,"state")) === false`(read-only 合同) |
| (b) status on empty workspace | 同一 workspace 再跑 `status`:JSON,`schemaVersion === 2`,`operations` 深等于 `[]` |
| negative: unknown flag | `status --ignored yes` 以非零退出 |
| negative: outside cwd | 在 workspace 外的路径作 `--input` 跑 `prepare` 以非零退出(`cli.test.ts:117-145` 的进程内版本已有,这里证明子进程路径同样拒绝) |

`.github/workflows/ci.yml` 的改动 = 在 quick-gate step「Test — root Node contract suites」(`:129-155`)的 `run` 块末尾追加一行:

```yaml
          node --test scripts/__tests__/raya-cos-cli-dist.test.mjs
```

不新增 step、不改 step 名、不动任何 script shard。随后本地跑
`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh` 与 `bash scripts/__tests__/ci-structure.test.sh` 都必须绿。

### C5 lockfile —— 结构比较,不用 grep

```bash
pnpm install                      # 非 frozen,生成 importer 条目
pnpm install --frozen-lockfile    # 必须通过
python3 - <<'PY'
import subprocess, yaml, sys
old = yaml.safe_load(subprocess.check_output(["git", "show", "origin/main:pnpm-lock.yaml"]))
new = yaml.safe_load(open("pnpm-lock.yaml", encoding="utf-8"))
added = set(new["importers"]) - set(old["importers"])
assert added == {"packages/raya-cos"}, added
assert set(old["importers"]) <= set(new["importers"]), "an importer disappeared"
for k in old["importers"]:
    assert old["importers"][k] == new["importers"][k], f"importer changed: {k}"
imp = new["importers"]["packages/raya-cos"]
assert set(imp) == {"devDependencies"}, imp
assert set(imp["devDependencies"]) == {"@types/node", "typescript", "vitest"}, imp
for top in ("packages", "snapshots"):
    assert old.get(top) == new.get(top), f"top-level {top} changed → new resolution"
for k in set(old) | set(new):
    if k != "importers":
        assert old.get(k) == new.get(k), f"top-level key changed: {k}"
print("LOCKFILE OK: exactly one new importer, zero new resolutions")
PY
```

pyyaml 在本机 python3 可用(research 时验证);这是**本地 pre-PR 检查**,不进 CI(CI 靠 `--frozen-lockfile`)。
把 `LOCKFILE OK` 那行贴进 PR。

### C6 全套判据(上游 §5.3 原文)+ 证据

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter flywheel-raya-cos test:run        # 55 文件 + 1(C4-a)= 56,全绿
pnpm typecheck
pnpm lint
node scripts/package-gate.mjs                   # PACKAGE_GATE_RECEIPT=<dir>/summary.json
node --test scripts/__tests__/raya-cos-cli-dist.test.mjs
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm --filter flywheel-config exec vitest run src/__tests__/fly1981-final-ledgers.test.ts
bash <S1 boundary script from §2.2>
```

证据的落盘规则(Codex R1#7):
- **被测 SHA** = commit ②(守卫 + CI 接线之后、evidence 之前)。package-gate 在该 SHA 上跑,
  它的 `summary.json` 自带 `git rev-parse HEAD`;复制为
  `engineering/doc/FLY-2694-raya-cos-landing/evidence/package-gate.json`,连同 §2.2 与 C5 的输出
  一起进 commit ③(docs-only)。
- **CI 证据不提交回仓库**:PR 描述贴与被测 SHA 绑定的 checks URL(`unit-tests (light)` 与 `Quick Gate`),
  QA 复核时按 SHA 打开日志核 `flywheel-raya-cos` 的 `Test Files 56 passed`。
- commit ③ 只含 `engineering/doc/FLY-2694-raya-cos-landing/**`,所以 §2.2 的集合检查在 ③ 上仍然成立。

## 5. QA 判据映射(工单原文 ① – ⑤)

| 判据 | 证据 | 谁产出 |
|---|---|---|
| ① `pnpm --filter flywheel-raya-cos test:run` 55 文件全绿 | 本地输出 + 被测 SHA 的 CI light 日志;**C4-a 后是 56 文件**,QA 认「≥ 55 且全绿」,PR 描述写明多出的一份是新守卫 | 实施 + QA |
| ② package-gate receipt 出现 `flywheel-raya-cos` | `evidence/package-gate.json` 的 `packages[]` 行(`status: "passed"`),且其 HEAD = 被测 SHA | 实施 |
| ③ CI light shard 日志出现该包 | PR 描述里被测 SHA 的 checks URL | 实施;QA 打开核对 |
| ④ `pnpm -r build` / `typecheck` / `lint` 全绿 | C6 输出;CI `CI OK` 绿 | 实施 + CI |
| ⑤ 未触碰 raya / updater 脚本 | §2.2 脚本在 PR head 上输出 `S1-BOUNDARY OK`(贴 PR);QA 复跑 | 实施;QA |
| §5.3 全部命令为绿 | C6 | 同上 |
| 附加(本 plan 新增) | C1 字节一致 diff 为空;C4-a / C4-b 绿;enumeration 与 ci-structure 绿;C5 `LOCKFILE OK` | 实施 |

## 6. 负向守卫与失败路径

| 情形 | 表现 | 处置 |
|---|---|---|
| Raya `origin/main` 的 `packages/cos` 子树相对 PIN 变了 | C1 脚本 `exit 1` | `flywheel-comm ask` Lead:按 PIN 搬还是按新 main 搬(上游 plan 钉 PIN) |
| 有人在 src 里改了一个字节 / 多放或少放一个文件 | C1 `diff` 非空 | 还原;S1 不改源码(§3.2) |
| `noUncheckedIndexedAccess` 之外还需要关别的开关 | `pnpm typecheck` 红且 C4-a「single override」也红 | 不要静默加开关;回 Lead(research §4.3 实测只需这一个;若环境不同则是新事实) |
| 忘补 `test:run` | C4-a 红;package-gate receipt 无该包(判据 ②) | 补 |
| 忘注册 ci.yml | `ci-shell-suite-enumeration.test.sh` 红 | 补 |
| 误开新 shard step | `ci-structure.test.sh` 红(quick-gate always-on) | 改回追加到 root Node contract suites |
| 本地没 build 就跑 C4-b | 「dist present」失败 | 先 build;不要把它改成 skip |
| `pnpm install --frozen-lockfile` 红 / C5 结构比较断言失败 | lockfile 未提交、被手改,或出现新 resolution | 重跑 C5;若真有新 resolution 说明 devDep 版本与仓内不一致,回 Lead |
| src 里偷 import 第三方(任何语法) | C4-a AST 守卫红,正向对照证明它能红 | 不允许;cos 合同是零依赖 |
| 有人把 `raya-cos` 加进 `PO_PACKAGES` 或把赋值改成续行/第二处 | C4-a「not packaged」红 | 那是另一个裁定,要走上游 §6.2 括号里的整套动作 |
| PR 里出现 D/R/C/T 状态或第三个 M 文件 | §2.2 脚本 FAIL | 还原;S1 是纯增量 |

## 7. 提交与 PR

- commit ① `feat(raya-cos): land Raya packages/cos as flywheel-raya-cos`
  body 含 `Source: xrliAnnie/raya@90e433e87a68287ed59ba64f2584e3a6bc0da151:packages/cos (no git history, see README provenance)`;
  内容 = C1 + C2 + C3 + C5(lockfile)。
- commit ② `test(raya-cos): package contract + dist CLI guards, quick-gate wiring`
  内容 = C4(两份测试 + ci.yml 一行)。**这是被测 SHA。**
- commit ③ `docs(FLY-2694): S1 evidence (package-gate receipt, boundary check, lockfile check)`
  内容 = `engineering/doc/FLY-2694-raya-cos-landing/evidence/**` + progress。
- **push / wait 时序(Codex R2#3,不可省略)**:workflow 只在 push / PR head 触发(`ci.yml:3-7`),
  同一 ref 的新运行会取消旧运行(`ci.yml:19-21` `cancel-in-progress: true`),所以:
  1. 先**只**推送到 ②,开 PR(或 push 后等 PR 的 checks);
  2. 等 ② 上的 `Quick Gate` 与 `unit-tests (light)` 完成,记下这两个 checks URL(它们绑定 ② 的 SHA);
  3. 再在本地创建 ③ 并推送;③ 是 docs-only,`classify` 可能判 `no_code` 并跳过测试 lane,这正是
     为什么「被测 SHA」定义为 ② 而不是 PR 最终 head;
  4. 在最终 head(③)上重跑 §2.2 脚本,**只**把这一次的输出贴进 PR(③ 只加 doc 文件,结果仍应 OK)。
  若在 ② 的 CI 结束前推了 ③,②的运行被取消、URL 失效 —— 必须重来:再推一个空改动是不行的
  (会产生新的 SHA),正确做法是在 ③ 之后等 ③ 的 CI,并把「被测 SHA」改记为 ③,同时在 ③ 之后
  重跑 package-gate 生成新的 receipt(其 HEAD 必须与被测 SHA 一致),再补一个 ④ docs commit。
- PR 描述必含:① Linear 链接;② 被测 SHA 与其 checks URL;③ §2.2 脚本在最终 head 上的全输出(`S1-BOUNDARY OK`);
  ④ C1 字节一致校验输出;⑤ C5 `LOCKFILE OK`;⑥ 「已逐条核对上游 plan §14:六条修订均落在
  S4/S3/§7A/§11/§10.4/§10.5,不涉及 S1」;⑦ package-gate receipt 行;⑧ 「本 PR 不部署、不改 launchd、
  不碰 Raya 仓;运行时消费者在 S2」。
- 不请求 ship 授权(设计节点不做);实施节点按其自身 handoff 走。

## 8. 回滚

单 PR revert 即完全回滚:本单**零状态、零部署、零运行时消费者**(shim 在 S2 才出现),
revert 后 workspace / package-gate / light shard 自动少一个包,quick-gate 少一行,lockfile 少一个 importer。
不存在数据迁移或宿主文件。

## 9. 风险与边界

- **不做**:S2 shim / 收敛、S3 Raya 仓改造、S4 persona 投影、M0、T1–T6。
- **一个 PR 两处「首例」**:Flywheel 首个覆盖 base 严格开关的包(§3.2);首个「源码零依赖」由 AST 测试锁定的包。
  两者都由 C4-a 显式声明,不靠约定。
- **不改搬来的测试**导致 (b) 空 workspace `status` 只在子进程测试里覆盖 —— 可接受,C4-b 就是为此存在。
- research §4 的实测在 macOS 本机做;Linux CI 唯一差异点是 `goal-store.test.ts` 的真 git,
  CI 已 `git config --global user.*`(`ci.yml:231-234`),且该测试自设仓内身份,不依赖全局。
- quick-gate 的「root Node contract suites」step 每加一条 `node --test` 都拉长 always-on lane;C4-b 六个用例
  都是毫秒级子进程,可忽略。
- `FLY-2657`(PR #1241)与本单零文件交集(§2.1 白名单 vs 上游 §9.4),可并行。
- 现场事实:旧壳 `com.xrli.raya.brain` 已 bootout + disable(2026-09-17T22:01Z);S1 与此无关,不复核、不改动。
