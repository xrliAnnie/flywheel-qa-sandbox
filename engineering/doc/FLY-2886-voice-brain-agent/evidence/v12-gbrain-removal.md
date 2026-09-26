# FLY-2886 整机删除 gbrain — 验证记录
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: plan.md §14.8

## 先红

`packages/teamlead/src/lead-capabilities/__tests__/gbrain-removed.test.ts`，删除前（HEAD `bc4adc7d5`）：

```
   × gbrain is not a Lead integration > has no catalog operation or upstream tool row 6ms
   × gbrain is not a Lead integration > is not an optional integration a manifest can name 2ms
   × gbrain is not a Lead integration > is not an upstream baseline server 5ms
   × gbrain is not a Lead integration > ships no gbrain module 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected [ 'knowledge.add_link', …(29) ] to deeply equal []
AssertionError: expected true to be false // Object.is equality
AssertionError: expected [Function] to throw an error
AssertionError: expected [ …(3) ] to deeply equal []
      Tests  4 failed (4)
```

## 后绿（本地，定向，不是全量证据）

- `gbrain-removed.test.ts` 4/4；直接改动的 12 个 lead-capabilities 测试文件 83/83。
- 按 `.js` 说明符找到的改动模块测试消费者（catalog / manifest / upstream-* / deployment / browser-sandbox / voice-capability-brief / runtime-factory）：teamlead 27 个文件 379/379。唯一排除：`scripts/__tests__/qa-fly-2519-browser-node.test.mjs`（有头 Chrome，会弹到 founder 屏幕；且本机 Chrome 版本与钉住版本不一致，见 `v12-related-test-scope.md`）。
- `vitest related`（叶子模块 runtime-factory / voice-capability-brief / browser-sandbox / deployment / handlers/upstream-read / upstream-baseline）：31 个文件 418/418。catalog.ts / manifest.ts / upstream-inputs.ts 是枢纽，不跑 related，改用上面的消费者清单。
- voice-codex：`vitest related admission-residuals.ts` 87/87，`vitest related CodexVoiceContainer.ts` 68/68。
- scripts：`qa-codex-lead-parity.test.mjs` 9/9、`qa-codex-lead-parity-drill.test.mjs` 10/10（用新 dist 重跑）。
- `pnpm lint` exit 0（25 warnings，均为 main 上已有）；`pnpm --filter "flywheel-teamlead..." build`、`pnpm --filter "flywheel-voice-codex..." build` 通过；`pnpm --filter "...flywheel-teamlead" typecheck` 通过。

## 全仓扫描型守卫（按路径 grep 找不到的一类）

用 `git grep -lE "ls-files|readdirSync\((REPO_ROOT|repoRoot|ROOT|root)|walk\(|globSync|fast-glob|scan[A-Z][A-Za-z]*Inventory"` 在测试目录里列出 38 个会扫全仓的测试，挑与本单改动面相关的跑：

| 测试 | 结果 |
|---|---|
| claude-runner `kill-path-inventory.test.ts` | 上一个 HEAD 红（v12 残留回收新增 4 处 kill 未登记）→ 补登记后 5/5 |
| teamlead `bridge-child-process-census.test.ts` | 上一个 HEAD 红（`node-runtime-closure.ts` otool、`admission-residuals.ts` ps 未登记）→ 补登记后 1/1 |
| teamlead `required-wall-clock-thresholds` / `report-registry` / `repository-git-listing-buffer` / `automated-message-inventory` / `fly1560-teardown-guard` / `machine-watermark` / `read-deny-removed.sentinel` / `resident-codex-lead-lifecycle-retention` / xiaohongshu `runtime-bundle` | 全绿（118 条） |
| scripts `runner-test-discipline` 145/145、`fly2655-voice-room` 19/19、`remove-retired-dist` 8/8、`ci-structure.test.sh`、`fly2144-retired-dispatch-residue.test.sh` 4/4 | 全绿 |
| config `feature-flags-drift` 14/14、agent-team-transport `grep-gate` 3/3、claude-runner `codex-home` 194/194 | 全绿 |

未跑（与本单改动面无关）：log-rotate、WorktreeManager.resume、progress.realgit、isolation-boundary.real-process、workflow-docs-git-stall、lifecycle-sweep、switch-record、attachment-probe-cache、media-validator、其余 shell 扫描脚本。

## 部署注意

teamlead 的 `tsc` 不清理已删源文件的旧产物：已部署机器上 `dist/lead-capabilities/gbrain-*.js` 会残留，但不被任何模块引用、也不在部署回执里，属惰性文件，可在部署时顺手删。

## 独立评审（Claude，非 Codex 门）后的补充

- `e1e8c0d32` 的提交内容比标题宽：先前用 `git rm` 暂存的 gbrain 文件删除被一起带进了这个「只登记守卫」的提交，单看这个提交构建不过（`runtime-factory.ts` 仍 import `gbrain-provider.js`）；紧随其后的 `645ecf66d` 补齐其余改动，分支末端树正确。未改写历史（需 force-push）；PR 按 squash 合并不受影响。
- parity drill 的 P15 代表操作改为 `memory.search` 后，`parity-drill.test.ts` 的 fixture 里没有 `memory.*` 调用，所以 drill 汇总里 P15 从 `representative_fixture_exercised` 变为 `unverified`——这是如实的结果（原先由 gbrain 的 `knowledge.search` 撑着），不是回归；`LEAD_PARITY_COVERAGE` 的 P15 标签同步改为 `catalog`（`memory.*` 走 Bridge 处理器）。
- 部署窗口的版本错位：新 proxy 用收窄后的枚举解析 manifest，旧 dist 生成的带 `{id:"gbrain"}` 的语音 manifest 会被拒；只在新旧 dist 并存的窗口出现，且语音后台默认关闭。
- 仓库外遗留（不在本 PR）：GeoForge3D `.lead/shared/common-rules.md` 的「Project Wiki (gbrain)」段仍要求 Lead 调 `mcp__gbrain__query`，已复制进 `~/.flywheel/lead-rules/{cos,ops,product}-lead/` 与当前生效 bundle；已报 Lead 另开单。
- 背景：旧 dist 的 `gbrain-host` 要求 `~/.gbrain/config.json` 存在，常驻 Codex Lead 默认 fail_closed；gbrain 卸载后，本 PR 部署前常驻 Codex Lead 若重启会激活失败。

