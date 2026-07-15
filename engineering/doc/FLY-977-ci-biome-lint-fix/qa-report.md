# FLY-977 修 main 上 biome lint red — QA 验收报告

Issue: FLY-977 (https://linear.app/geoforge3d/issue/FLY-977/修-ci-biome-lint-red-on-main-fly-968-spike-文件-格式化修好不排除)
日期: 2026-07-07
基于: plan.md, research.md

## 结论:PASS ✅

FLY-968/FLY-960 spike `.mjs` 已被真正格式化 / 语法整形修好,CI lint 回绿。**未**用排除、抑制、改规则或删文件的绕过手法。三重独立证据交叉确认 CI 会绿。

## 验证方法与证据

### 1. 真实 CI ground-truth(最硬证据)
- PR #498 的 GitHub Actions **「Build & Test」job PASS**(run `28906563951`,10m49s)。
- 该 job 顺序执行 Build → Typecheck → **Lint(`pnpm lint`,`.github/workflows/ci.yml:61-62`)** → Test;GitHub Actions step 顺序执行、任一非零即 fail 整个 job。job pass ⇒ `pnpm lint` step 在 PR head `ada5a8e6` 上退 0。
- ⇒ **CI lint 已绿。**

### 2. 干净 checkout 本地复现(CI-equivalent)
- 用 `git archive HEAD | tar -x` 导出**只含已提交文件**的树(= CI 全新 checkout 真正看到的内容),在其中跑 `biome check`:
  - `CLEAN_TREE_BIOME_EXIT=0`,`Found 14 warnings`、**0 error**。
  - `pnpm lint` = `biome check` **无** `--error-on-warnings`,warning 不 gate CI(research §1 已证)。
- 两个 spike 文件夹 scoped 检查:`biome check engineering/spike/FLY-968-voice-bakeoff/ engineering/spike/FLY-960-dave-stt/ --reporter=summary` → `Checked 16 files … No fixes applied`,**0 diagnostics**,exit 0。达成 plan 的严格验收(0 error/0 warning/0 info)。

### 3. 本地裸 `pnpm lint` 的 1 个「error」= 假阳性(已排除)
- 在完整工作树跑 `pnpm lint` 会看到 **1 error**,来自 `.flywheel/runs/60474e25-…/land-status.json`(formatter)。
- 该文件是本 pipeline 跑 PR/land 流程时写入工作树的**运行时产物**:
  - `git ls-files` 查不到 → **未被 git 跟踪**;
  - 仅被 `.git/info/exclude`(本地、不提交的 exclude)忽略,故 biome 的 `vcs.useIgnoreFile`(只读 `.gitignore`,不读 `info/exclude`)本地会扫到它。
  - 已提交树里 `.flywheel/` 只有 `config.yaml` + `agents/*.md`,**无** `.flywheel/runs/`。
- ⇒ CI 全新 checkout 里此文件根本不存在,**不影响 CI**。属本地环境噪声,非 FLY-977 改动。

## Diff 范围(scope discipline 核对)
- 改动仅:`engineering/doc/FLY-977-ci-biome-lint-fix/*`(文档) + `engineering/spike/FLY-968-voice-bakeoff/*.mjs`(8) + `engineering/spike/FLY-960-dave-stt/*.mjs`(2)。
- **未碰**:`biome.json`、`.github/`、`packages/**`(生产/测试)、`scripts/**`、`package.json`。
- 无文件删除;无 `// biome-ignore` 抑制注释(commit 里唯一的 "biome-ignore" 字样出现在 commit message 描述文本,非代码)。

## 行为等价性核对(核心风险点)
所有改动均为纯格式化 / 语法整形,零运行时行为变化,逐处核对:

| 改动 | 规则 | 行为保真核对 |
|------|------|-------------|
| 6 处 `new Promise((r) => (X = r))` → `(r) => { X = r; }`(s3×3, s4, s4a, s4c) | `noAssignInExpressions` | Promise 构造器忽略 executor 返回值;改成语句体返回 `undefined` 对解析零影响。resolver 仍被外层变量/对象属性捕获。✅ |
| `s2` 删 `statSync` | `noUnusedImports` | 已确认 `statSync` 在文件中不再出现,删除安全;保留 `readFileSync`/`writeFileSync`。✅ |
| `s4c:132` `const end = await pushAudio(...)` → `await pushAudio(...)` | `noUnusedVariables` | **保留 `await` 副作用**,仅去掉未用绑定(返回值本就未用)。✅ |
| `login-smoke` `useTemplate` | `useTemplate` | 嵌套模板串 `` ` [${…join(",")}]` `` 与原 `" [" + … + "]"` 产出**同一字符串**。✅ |
| `probe-join` 删 `VoiceConnectionStatus` | `noUnusedImports` | 保留仍在用的 `joinVoiceChannel`。✅ |

## 补充行为验证(QA 新增)
- 对全部 10 个改动的 `.mjs` 跑 `node --check` → **10/10 通过**,格式化 / executor 重写 / 模板改写后仍是合法 ESM(语法错误会在此暴露)。
- spike `.mjs` 是一次性脚本,不进 `pnpm test` / build 图,无自动化测试可加;lint 命令本身即验证 gate(plan TDD 说明一致)。

## 验收清单
- [x] `pnpm lint`(CI 同款)在干净 checkout / 真实 CI 上退 0;
- [x] 两个 spike 文件夹 0 diagnostics;
- [x] `biome.json` / `.github/` / 生产代码 diff 为空;
- [x] 无文件删除、无 `// biome-ignore`、无规则改动;
- [x] 10/10 改动 `.mjs` `node --check` 通过。
