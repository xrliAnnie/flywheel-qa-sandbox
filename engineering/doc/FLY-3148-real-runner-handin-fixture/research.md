# FLY-3148 真 Runner 交卷夹具 — 调研
Issue: FLY-3148 (https://linear.app/geoforge3d/issue/FLY-3148/qa-sbx-fly-3038-real-runner-handin-fixture-529-generalized-real-drill)
日期: 2026-10-01
基于: exploration.md

## 1. 守卫怎么判定「已登记」

见 `qa-fly-3038/probe-registry.test.mjs`：

- 已登记集合的来源：读 `probes.txt`，按 `\n` 切行，每行 `trim()`，再去掉空行和以 `#` 开头的行。
- probe 集合的来源：列出 `runs/` 下的条目，只保留含有 `probe.txt` 的子目录，再映射成 `qa-fly-3038/runs/<name>/probe.txt`。
- 断言：`missing`（在 probe 集合里、但不在已登记集合里的路径）必须为空。

由此可以推出：

- 登记行必须逐字是 `qa-fly-3038/runs/202610010731-f45ed7/probe.txt`。这是仓库相对路径，不能加 `./` 前缀，也不能写成目录。
- 行尾的换行或空白会被 `trim()` 去掉，所以不影响判定。按 POSIX 习惯，文件以 `\n` 结尾。
- 已有的那行 `#` 注释保留。

## 2. 「恰为一行 PROBE-1」的字节形态

- 选用 `PROBE-1\n`，共 8 字节。这是 POSIX 意义上「一行」的形态：`wc -l` 为 1，`cat` 和 `$(cat …)` 读出来都是 `PROBE-1`。
- 不带结尾换行时，`wc -l` 为 0，会被判成零行。所以带一个 `\n`。
- 用 `printf 'PROBE-1\n' >` 写入，避免编辑器追加多余内容。验收命令：`od -c` 确认恰为 `P R O B E - 1 \n`。

## 3. 测试选择（local-test-policy/v1）

- 改动文件：`qa-fly-3038/runs/202610010731-f45ed7/probe.txt`（新建）、`qa-fly-3038/probes.txt`（追加一行），另加 `engineering/doc/…` 下的文档。
- 发现：对下面每一项跑 `git grep -lF`：新字面量 `PROBE-1`，两个完整变更路径，basename `probe.txt` 和 `probes.txt`，以及父目录 `qa-fly-3038/runs/202610010731-f45ed7`、`qa-fly-3038/runs`、`qa-fly-3038`。完整清单见 plan.md 第 0 步，实际命中写进 milestone。
  - 保留：`qa-fly-3038/probe-registry.test.mjs`。这是唯一读这两个文件的测试，用 `node --test <该文件>` 单独跑。
  - 排除：`qa-fly-3038/README.md`、`qa-fly-3038/pre-handin-check.mjs`、`.flywheel/config.yaml`，以及字面量命中的 `engineering/doc/FLY-1071-enable-window-closeout/plan.md`。原因：这些不是测试文件（文档、夹具脚本、配置）；`pre-handin-check.mjs` 会作为交卷自检整体运行。
- 没有改 TypeScript，所以不需要 `vitest related`。也没有新增 `scripts/__tests__/*.test.sh`。

## 4. 交卷链路

- pre-handin 自检要求工作树干净。scratchpad 文件放在会话 scratchpad 目录，不放进 worktree。`.flywheel/runs/<exec>/` 已在 `info/exclude` 里，不算脏。
- 合并检查：HEAD 已包含 `origin/main`。新增文件都在 `qa-fly-3038/runs/` 和 `engineering/doc/` 下，与 main 不会冲突。如果 main 在交卷前前进了，按 pre-handin 的提示合并 `origin/main` 即可。
- PR base 是 `main`。CI 由 `pull_request → main` 触发，冻结头后跑 `ci-full ensure` 拿精确头全量 CI。
- milestone `engineering/doc/milestones/FLY-3148.md` 必须是最后一个 commit。PR 号先预测，没命中时再补一个只改 milestone 的 commit。
