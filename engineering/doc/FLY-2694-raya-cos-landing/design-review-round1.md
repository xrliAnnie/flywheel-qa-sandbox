# Design Review — plan.md (Round 1)

Date: 2026-09-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

S1 的总体方案可行且边界基本正确；尤其是固定 Raya commit、保持 120 个源文件字节一致、通过包级单一开关保留 Raya 编译语义的方向是合理的。不过当前施工书仍有会让必跑 CI 直接失败、让 QA ⑤ 被删除/重命名绕过、以及让合法 lockfile diff 被判失败的阻断问题，因此尚未达到 implementation-ready。

## What's Good (Keep)

- 固定 `90e433e…:packages/cos`、不带历史地落到 `packages/raya-cos`，并把 shim 明确保留给 S2，忠实传播了上游的搬运与 provenance 边界（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:14-17`; `engineering/doc/FLY-2680-raya-merge-plan/plan.md:95-103,131-138`）。
- `noUncheckedIndexedAccess: false` 的单一覆盖决定是有证据且最小的：Flywheel base 在 `tsconfig.base.json:9-20` 开启了该项，而 spike 记录显示启用时 170 个错误、仅关闭该项后 0 错，其余严格项仍通过（`engineering/doc/FLY-2694-raya-cos-landing/research.md:131-140`）。本轮用等价编译参数重新执行也复现了 0/170 的分界；保留此裁定。
- workspace、light shard 与 package-gate 的发现路径判断正确：workspace 自动包含 `packages/*`，light shard 调用所有未排除包的 `test:run`，package-gate 则按 manifest 中的 `test:run` 发现并在 Vitest 分支附加结构化 reporter（`pnpm-workspace.yaml:1-2`; `.github/workflows/ci.yml:217-220`; `scripts/package-gate.mjs:149-173`）。
- C4-b 使用真实 `dist/cli.js` 子进程、把缺失 dist 当失败，并补空 workspace `status` 与负向参数/路径用例，这确实覆盖了现有进程内测试没有经过的 executable main guard（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:172-181`; Raya `packages/cos/src/cli.ts:212-226`; Raya `packages/cos/src/cli.test.ts:108-145`）。
- S1 没有引入 shim、部署、Raya 仓修改或 updater/patrol 改造，和上游 S1→S2 的依赖及 §9.4 并行边界一致（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:49-52,265-274`; `engineering/doc/FLY-2680-raya-merge-plan/plan.md:544-552,880-883`）。

## Issues & Recommendations

1. **阻断：按当前 C4-b 注册方式实施后，Quick Gate 的 CI 结构守卫必红。** Plan 要给 `script-tests-5` 新增一个独立 step（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:183-190`），但 `ci-structure.test.sh` 对该 shard 的测试 step 名称和顺序做严格等值断言，当前允许清单中没有 FLY-2694 step（`scripts/__tests__/ci-structure.test.sh:877-885,910-940`）；该守卫又在 always-on Quick Gate 中执行（`.github/workflows/ci.yml:61-67`）。**建议：**最小方案是把新的 `node --test …raya-cos-cli-dist.test.mjs` 字面命令加入 Build 之后现有的 “root Node contract suites” step（`.github/workflows/ci.yml:125-155`），不新增 shard step identity；若坚持独立 shard-5 step，则必须把 `scripts/__tests__/ci-structure.test.sh` 加入白名单并同步 `expected_shard_tests`，同时更新 §2.2 的 M 文件集合。

2. **阻断：QA 判据 ⑤ 的三条命令不是所声称的精确白名单，并可被删除/重命名绕过。** `(a)` 只在 `M/D` 路径中匹配文件名里的 `raya|updater`，`(b)` 只检查 `M`，`(c)` 只检查 `A`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:35-47`）。因此删除 `scripts/update-flywheel.sh` 或 `scripts/lead-patrol-snapshot.sh` 会同时避开三条检查：两条路径不含该正则，而删除既不是 `M` 也不是 `A`；这两份文件却被本 plan 明列为禁区（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:49-52`）。rename/copy/type-change 等状态也没有被约束。**建议：**基于 `git diff --name-status --find-renames origin/main...HEAD` 做一个 fail-closed 集合检查：先拒绝所有 `D/R/C/T/U/X/B`；再要求 `M` 精确等于允许的既有文件集合；对 `scripts/**` 要求唯一允许路径就是新增的 `scripts/__tests__/raya-cos-cli-dist.test.mjs`；最后对 `A` 做允许前缀检查并由 C1 校验精确源文件集合。把这份单一结果作为 QA ⑤ 证据。

3. **阻断：C5 的“零新 resolution”命令会拒绝预期中的合法 importer。** 当前 grep 只放行包含 `packages/raya-cos`、`devDependencies`、`specifier` 或 `version` 的新增行（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:194-200`），但 pnpm importer 必然另有 `@types/node:`、`typescript:`、`vitest:` 三个 dependency-key 行；现有 importer 的实际格式可见 `pnpm-lock.yaml:681-690`。因此即使 lockfile 恰好只新增预期的 12 行，该命令仍会输出三行并按文档口径失败。**建议：**不要继续扩充 grep allowlist；用 YAML 结构比较 `origin/main` 与 worktree lockfile，断言只新增 `importers["packages/raya-cos"]` 且其值精确等于三项 devDependencies，同时断言顶层 `packages`/`snapshots` 深等，才能真正证明零新 resolution。

4. **高：C1 命令既不自包含，也没有按文字承诺 fail closed。** 命令从未创建或赋值 `$TMP`，却直接 clone 到 `$TMP/raya` 并写 `$TMP/expected`/`actual`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:71-90`）；子树不一致时只 `echo` 后继续 archive，而不是停止（`:78-82`）；最后的计数又没有排除新守卫文件，所以 C4-a 加入后会得到 121，却仍注释“必须 = 120 / 已排除”（`:88-91`）。**建议：**显式 `work_dir="$(mktemp -d)"` 并设置清理 trap；用 `if …; then …; else exit 1; fi` 阻断 subtree drift；hash diff 和数量检查都排除且只排除根部那一个新守卫文件，并用 `test "$count" -eq 120` 真正断言。最好同时断言本地 `src` 集合恰为上游 120 项加明确列出的 Flywheel 新测试，避免同名文件在子目录中被 `find ! -name` 一并豁免。

5. **高：README 的计划改法会留下错误的执行上下文，并且 provenance 文案自相矛盾。** 上游 README 原文是 “Run the CLI from the registered workspace via” 后接 `business/current/...`（Raya `packages/cos/README.md:23-27`）；plan 只把命令替换为相对路径 `node packages/raya-cos/dist/cli.js`，同时又说明其 cwd 是 Flywheel checkout（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:140-155`）。不改前一句时，读者从 registered business workspace 执行该相对路径会找不到文件。provenance 又说 “Every file copied … byte-identical”，但同一段把 README edits 列为 Flywheel-side additions（`:142-150`）。**建议：**把两行一起改为“在 Flywheel checkout 内的人工/开发调用”；明确生产 workspace 的稳定入口要等 S2 shim，S1 没有运行时消费者。provenance 则精确写成“上游 120 个 `src` 文件（排除新增 contract test）逐字节一致；README/manifest/tsconfig 为列出的 Flywheel 侧改动”。

6. **高：C4-a 的核心 tsconfig 断言是非空的，但“零运行时依赖”和“不进 packaged”两条仍可被语法/格式变化绕过。** source guard 只列出 `from "…"` 与 `import("…")`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:167-169`），会漏掉 side-effect `import "pkg"`、`require("pkg")`、`import = require()` 等；上游调研本身正是按 `from`、动态 import、require、bare import 全量检查的（`engineering/doc/FLY-2680-raya-merge-plan/research.md:80-85`）。`PO_PACKAGES` 守卫则只要求“那一行”不含 `raya-cos`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:170`），变量改成续行或另一处赋值即可误判。**建议：**用已存在的 TypeScript compiler API 遍历 module specifier/require 形态，并给 bare import、require 两个正向变异样例证明会转红；对 `PO_PACKAGES` 要求唯一静态赋值、解析完整 shell 字符串为 token 后断言缺席。tsconfig 用例保留 exact-key + `false`，再补 exact `module/moduleResolution/rootDir/outDir/include/exclude` 与 base 中该开关仍为 `true` 的断言，使“单一例外”合同完整。

7. **中：证据落盘与“两 commit”序列存在不可实现的时间环。** Plan 要等 CI 完成后把 light-shard 日志写入仓库（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:216-219`），却又规定 commit 2 已包含 C4 和 evidence（`:247-253`）；CI 只有在该 commit 推送后才产生，补 evidence 必然生成后续 commit 并触发新的 HEAD。package-gate receipt 也会把运行当时的 `git rev-parse HEAD` 写入 summary（`scripts/package-gate.mjs:110-126`），所以未说明 tested SHA 会造成验收 provenance 含混。**建议：**把 code/test/CI wiring 作为 tested commit，receipt 明确记录该 SHA；CI 证据使用与该 SHA 绑定的 checks URL 或 workflow artifact，不把日志摘录提交回触发同一 CI 的 PR。若必须版本化证据，则承认第三个 docs/evidence commit，并在 PR 中明确“tested code SHA”和最终 docs-only SHA 的关系。

## Verdict

CHANGES REQUESTED — address items above
