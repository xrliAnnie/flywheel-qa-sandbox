# FLY-2215 报告页生命周期 — 实施计划
Issue: FLY-2215 (https://linear.app/geoforge3d/issue/FLY-2215/publish-report-每发一份报告泄漏一个-chrome-页面而两道-reaper-都够不着它-3-天攒了-125-页-145gb)
日期: 2026-09-02
基于: research.md

## 1. 锁定范围

目标：每次 `publish-report` 截图结束后关闭本次打开的报告 page，同时保留可复用的 agent-browser；连续发布时报告 page 与 renderer 不随 N 累积。

只改 `publish-report` 的 ProofShot finally 和对应测试。不改 reaper、TMPDIR/owner 归属、Bridge、公共 CLI 参数或依赖；不处理 WindowServer/cmux 卡顿，也不增加 feature flag 或新抽象。

## 2. 行为不变量

1. `proofshot start` 未成功时，不调用 tab close 或 stop。
2. start 成功后，无论截图成功、截图失败、PNG 超限或复制失败，都依次尝试：
   - `proofshot exec tab close`
   - `proofshot stop --no-close`
3. 两条清理命令使用与 start/screenshot 相同的 cwd，在 ProofShot session 与机器级 lock 尚存时执行。
4. tab close 失败不得阻止 stop-no-close；两者失败均明确 warning，但不遮蔽已成功截图，也不阻断既有 link-only/Discord 降级语义。
5. temp dir 删除与 lock release 仍总是发生。
6. 不调用 `agent-browser close --all`，不杀共享 browser，不放宽任何 reaper selector。

## 3. 严格 TDD 实施

### Step 1 — RED：把泄漏行为写进现有测试

编辑 `packages/flywheel-comm/src/__tests__/publish-report.test.ts`：

- happy path 的完整序列改为 start → viewport → screenshot → `exec tab close` → `stop --no-close`；断言五次调用 cwd 完全一致。
- start 后截图失败用例断言截图降级后仍按 tab-close → stop-no-close 收尾。
- 新增“tab close 抛错”用例：截图产物仍返回、stop-no-close 仍执行、warning 含 `report tab close failed`。
- stop failure 用例只在 args 精确等于 `['stop','--no-close']` 时抛错，避免模糊桩把 tab close 混成 stop。

运行：

```bash
pnpm --filter flywheel-comm test:run -- src/__tests__/publish-report.test.ts
```

预期：现代码因缺少 tab close 且 stop 参数不匹配而失败；保留 RED 输出作 TDD 证据。

### Step 2 — GREEN：最小 finally 修改

编辑 `packages/flywheel-comm/src/commands/publish-report.ts`，不新建 helper：

- 在现有 `if (started)` 内先加一个独立 try/catch，调用 `runProofShot(['exec','tab','close'], { cwd: outputDir })`；catch 写专用 warning。
- 原有 stop 调用改为 `runProofShot(['stop','--no-close'], { cwd: outputDir })`，保留独立 try/catch 与现有 stop warning。
- 更新相邻注释：说明 tab-level ownership、browser reuse 和 stop-no-close；删除“stop 后整个 browser process tree 已退出”的过时主张。

再次运行同一 focused test，预期全绿。

### Step 3 — Refactor/guard audit

- 检查 diff，确认没有 helper、配置、依赖、reaper 或公共 API 改动。
- 运行 `pnpm --filter flywheel-comm build` 与相关测试全包。
- 搜索旧的测试断言 `['stop']` 与“browser process tree is gone”说法，确保修改点不存在静默遗漏。

## 4. 真机回归证据

在有 Chrome 启动权限的 host QA 环境跑 built bytes，使用隔离 HOME/TMPDIR 与唯一 `AGENT_BROWSER_SESSION`，本地 HTTP stub 替代 publish/deliver 外部写入，连续截图 N≥3 次。每轮都记录：

- CDP `/json/list` 的全部 page 数与本次报告 URL page 数；
- 该 `--user-data-dir` 下 `--type=renderer` 进程数；
- 截图文件存在且非空；
- publishReport envelope 仍成功。

通过条件：每轮结束后本次报告 page 数为 0，全部 page 回到同一 baseline；renderer 计数序列不随 N 单调增长。最后仅关闭隔离 session，并证明默认/其他 session 未被关闭。

当前 implement runner 沙箱无法启动 Chrome，因此这里不能以 mock 冒充验收；若实现节点仍无 host 权限，必须在 PR/交接中把真机 N 次检查列为独立 QA 的硬验证项。

## 5. 全仓验证与代码审查

按实现节点合同运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本单不新增 `scripts/__tests__/*.test.sh`；因此没有额外 shell suite。随后通过 `codex:rescue` 执行代码审查，按注入协议注册 `review_code` gate；blocking finding 修复后必须新开一轮审查。

## 6. 提交与交接

建议小提交：

1. `test(FLY-2215): expose report tab leak`（RED 测试）
2. `fix(FLY-2215): close report tab after capture`（最小实现）
3. 必要的 review 修复提交
4. `engineering/doc/milestones/FLY-2215.md` 必须是 PR 前 literal last commit

提交计划文档后立即绑定 design review；design verdict 绑定后不再修改本文件。代码审查通过、全仓 gates 完成、milestone 最后提交后 push 并创建关联 FLY-2215 的 PR，PR body 包含变更摘要、测试计划与真机验证边界。最后通过 `complete --route needs_review --pr <NUMBER>` 交给 DAG orchestrator；不 dispatch QA、不请求 ship、不 merge。
