# FLY-2542 DirectEventSink 时序隔离 — 验证
Issue: FLY-2542 (https://linear.app/geoforge3d/issue/FLY-2542/flake-directeventsinktestts1605-在-ci-teamlead-shard-3-间歇红9-14)
日期: 2026-09-14
基于: research.md

本文是评审前冻结的验证快照；后续门禁收据写入 PR 和 flywheel-comm 报告，不再推文档。

修复范围仅为 `DirectEventSink.test.ts` 的 timeout 用例夹具：SDK issue mock 发出 Promise 信号后才推进 fake timer。tail 用例以及全部原有断言不变；无生产 src、依赖、配置改动，无新增 skip。

| 验证 | 当前回执 |
| --- | --- |
| 原始整文件 | 65/65 exit 0，12.55s |
| 原始 FLY-2293 组 | 20/20 次 exit 0，不能单独证明修复 |
| 控制导入重叠的红侧 | timeout 通过；tail 原零调用断言失败；真实 SDK 加载被 throw 护栏拦截 |
| dynamicImportSettled 对照 | 仍然同样失败，未采用 |
| 最终 Promise 信号绿侧 | 同一注入条件，2/2 exit 0；未触发真实 SDK 护栏；文档脚本整链再次验证 red=1 / green=0 |
| 修后整文件循环 | 20/20 次，每次 65/65，共 1300 项断言，全部 exit 0 |
| pnpm lint | exit 0；18 条 warning，未做无关修复 |
| pnpm -r build | 修前与修后均 exit 0 |
| 全包测试 | 冻结时运行中（session 68638）；最终回执以 PR / comm 报告为准，当前不声明通过 |
| 精确头 CI 相关分片连续两次 | 待最终提交/PR，尚不声明通过 |
| 精确头代码评审 | 待最终提交，尚不声明通过 |

修后循环原命令（zsh，从仓库根运行）：

```sh
mkdir -p /tmp/fly2542-fixed-loops
for iteration in {1..20}; do
  pnpm --filter flywheel-teamlead exec vitest run src/__tests__/DirectEventSink.test.ts > /tmp/fly2542-fixed-loops/run-$iteration.log 2>&1
  result=$?
  echo "$iteration $result" >> /tmp/fly2542-fixed-loops/counts.txt
  if test "$result" -ne 0; then break; fi
done
```

已逐个核对 20 份日志均为 `Tests 65 passed (65)`，counts.txt 第 1 至 20 行均为对应序号与 `0`。原始循环使用同一命令再加 `-t 'FLY-2293 Linear started-state sync'`，独立日志目录 `/tmp/fly2542-baseline-loops/`。

全包命令采用设计评审建议的真实 GUI 排除，并限制并发，避免干扰 founder 桌面。此排除不涉及被修复用例；不能把它报告为未排除任何文件的全包结果：

```sh
npm_config_workspace_concurrency=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 pnpm test:packages:run --exclude '**/tmux-viewer.macos.test.ts'
```

日志：`/tmp/fly2542-packages.log`；lint `/tmp/fly2542-lint.log`；build `/tmp/fly2542-build-final.log`。没有新增 shell 测试。受控红绿的完整复现代码与 onTaskUpdate 分次回执见 research.md。

此文档在最终评审前冻结；后续精确头 CI、评审和交接状态通过 PR 与结构化报告保留，不在 review 后推文档。

文档内脚本已执行：`python3 /tmp/fly2542-reproduce.py` exit 0；汇总 `/tmp/fly2542-reproduce-results.log`。红、绿日志位于 `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2542-proof-4zdcymzc/{red,green}.log`。脚本断言红侧 exit 1 且有原零调用错误和 SDK 拦截标记，绿侧 exit 0 且无拦截标记，两个条件都通过。
