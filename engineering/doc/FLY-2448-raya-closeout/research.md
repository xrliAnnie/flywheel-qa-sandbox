# FLY-2448 Raya 旧壳收口 — 调研
Issue: FLY-2448 (https://linear.app/geoforge3d/issue/FLY-2448)
日期: 2026-09-13
基于: exploration.md

## 实时来源

2026-09-13 使用 Linear GraphQL 查询 issue state/parent/description/comments；GitHub 使用 gh pr view、gh api 获取 PR 与固定提交源树。未修改生产 checkout。

| 要求 | 当前证据 | 结论 |
|---|---|---|
| FLY-2379 | Canceled，parent FLY-2441；描述含作废原因、④接力 | 状态满足；Discord thread 独立待证 |
| FLY-2380 | Canceled，parent FLY-2441；描述含 founder 9-8 指令、⑥接力 | 状态满足；⑥完成及 thread 待证 |
| FLY-2437 | Canceled；描述含作废原因及 #27 关闭 | 状态满足；thread 待证 |
| FLY-2381 | 初查 Done，parent FLY-1451；本次按原任务“挂 Epic”改 parent FLY-2441，mutation 返回 success=true、Done/FLY-2441 | 保留完成状态；原 parent FLY-1451 在此留痕；thread 待证 |
| raya #26/#27 | 均 CLOSED，mergedAt=null；head 分别 34c879475dfe05253d2d52b409ccd14f107fe9b2 / f1905cdaeb5747445e791649741fcdf20069b5c3 | 未合入；未删除分支 |
| 2380 分支 | ④ inventory 固定来源 41b26fa4e8baaddf076a33e7291772de979ffb8c | 本轮尚未验证远端 PR/分支处置 |
| FLY-2439 #1123 | MERGED，2026-09-08T17:33:41Z；head ee8a8ed99124cd5ecc91f83972cd4fdb16a4502f；Linear Done | 合入满足；无需重复 ship；重铸卡回执待 Lead |
| Raya 旧壳 | 远端 main 9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9，④ #61 于 2026-09-09T17:50:17Z 合入；apps 已不存在 | 下述源码扫描通过；逐文件清单及构建产物审计未完 |
| ⑥吸收 | FLY-2447 Backlog；main 有 cos/daily-report、portfolio 模块 | 业务保全存在，不能宣称⑥完成 |
| R2 停体、各 Discord thread | 现有 Linear 描述不能证明 Discord thread 和停体回执 | 待 Lead 提供精确回执 |

## 固定 Raya 源树扫描

GitHub tarball 固定 9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9，解压到 /tmp/fly2448-audit/raya；67 个 ts/mjs/js/sh 文件均位于 packages。根 package scripts 仅 build/lint/test/typecheck。

在该树根目录执行：

```sh
rg -n 'app-server|thread/start|turn/start|launchd|launchctl|discord\.js|voice-leads|profile\.json|DiscordAdapter|GatewayIntentBits' packages package.json pnpm-lock.yaml pnpm-workspace.yaml .lead README.md
```

零命中。历史 engineering 文档与 probes/evidence JSONL 仍有旧协议字符串，属于历史证据；不声称全仓字面零命中。生产 ~/.flywheel/raya/code 本地 HEAD 仍是 0f77e9772176c973eb1e09548b00c05ae550ef32；远端源码已清理不等于生产部署完成。本轮只读，未 pull、重启或部署。

尚未跑本单 full-repo lint/build/test gates，也未发 code-review 或 complete。问题 80f2b3b0-7e5d-4fdb-addd-0e5135e03784 pending；事实报告 7e00beb4-5ce0-438f-b280-8122a87de6e5。

## Lead 裁定后的收敛

问题 80f2b3b0-7e5d-4fdb-addd-0e5135e03784 已答；短计划见 progress.md。本单只审计合入后清单，清单的代码评审就是本单所需吸收确认；不等待⑥全部产品交付。#1123只记录合入；生产/R2动作不属于本节点。

四张 Linear 已分别写入作废/接力原因与 Epic 注释，comment 后缀：2379 `1e07287d`、2380 `ca1bc0f0`、2381 `c6654518`、2437 `78089d9c`。这些是 Linear issue comments；Discord thread 转述仍须 Lead，不把两种 thread 混称。

### 当前删留清单（固定 Raya main 9d63a2b2）

| 原路径/当前路径 | 处置 | 证据及理由 |
|---|---|---|
| apps/brain/** | 已由④删除，不重复删 | 当前源树无 apps；旧 cli/runtime/installer/preflight/voice-mode/text-chat 均不在活动树 |
| apps/voice/** | 已由④删除，不恢复 | 原 Codex、Discord、thread、launchd 与独立名册消费者均不在活动树 |
| packages/contracts/** | 原包已删除 | 纯业务规范位于 packages/cos/src/contracts；无旧运行包依赖 |
| scripts/install-launchd.mjs 及旧 probes 可执行文件 | 已删除 | 当前所有 67 个代码文件均在 packages/cos/src，根没有 scripts |
| packages/cos/src/**，含业务测试 | 保留 | summaries、daily-report、portfolio、meeting、questions、policy、directory 及 contracts 业务；无私有模型/Discord/launchd 驱动 |
| .lead/**、summaries/** | 保留 | persona/业务指令与 PRD §8.8 业务资料 |
| package.json、workspace、lockfile、tsconfig、README | 保留 | 只构建 cos；无旧 brain/voice 驱动启动或依赖 |
| engineering/**、probes/evidence/**、assets/** | 保留 | 历史审计、纯数据/资产；不是可运行归档；全部代码扩展清点未发现此处程序 |

**本单新删除集合为空。** 不能为了产生代码 diff 再删业务。扩展扫描 `spawn|execFile|child_process|fetch\(|WebSocket|Client\(|discord|codex|roster|launch|ingest` 逐项核查：四处 child_process 是日报/portfolio 的 Git/GitHub 业务读取或写入；`ingest` 是日报业务状态；`codexCwd` 是 summaries 的业务工作目录；discord-text 是纯文本格式化，Discord URL 是 provenance。均保留，不以关键词误删业务。无新增测试脚本，未引入行为变化，TDD不适用。

GitHub `gh pr list --repo xrliAnnie/raya --state all --head fly-2380-raya-daily-report` 返回空；这仅证明该精确 head 无可见 PR，不推断分支不存在。旧分支保持不合入，本单不改它。

## 最终执行口径与验证

Lead 问题 7e00beb4-5ce0-438f-b280-8122a87de6e5 的裁定进一步明确：每张单一条 Linear comment 即 thread 说明；旧 Discord threads 已归档，不发 Discord。FLY-2447 将吸收 persona 和 CoS 模块，本单无其他⑥依赖。FLY-2439 Linear Done，已合 #1123 可直接引用。清理集合为空，以零命中审计作清单。

R2 只读探针：`node "$FLYWHEEL_COMM_CLI" sessions --project flywheel --json` 对四张 issue 精确过滤，仅返回 FLY-2379 历史 execution `e206e20e-afaf-45a5-b769-bbc3176e478f`，status `timeout`、window `runner-flywheel:pending`；其余三单无记录。tmux 全窗口按旧 issue 前缀过滤为零；包含旧号的两处标题实际属于当前 FLY-2448，排除。当前可见 runner 登记与窗口无活体，故本次无 R2 停止操作。`ps` 进程级探针被 sandbox 拒绝（Operation not permitted），未验证未登记/脱离窗口的宿主进程；不声称全面主机进程普查。

验证结果：

- `pnpm lint` exit 0，16 个既有 warnings，无修改。
- 初次 build exit 2 / tests exit 1 因包依赖缺失；`pnpm install --frozen-lockfile` exit 0 后继续。
- `pnpm -r build` exit 0。
- `pnpm test:packages:run` exit 1。voice-core `src/__tests__/process.test.ts:66`：`AssertionError: expected '' to contain 'chunk'`；该包 1 failed / 319 passed / 4 skipped。并行 comm `src/commands/__tests__/dependency.test.ts` 的 `reports no_active_roots from real materialization over successful HTTP` 与 `reports missing_daily_root from real materialization over successful HTTP` 两例超时（5000ms）。递归命令提前退出，不能声称其余全仓测试通过。
- 无新增 `scripts/__tests__/*.test.sh`。本单只变更审计文档与已回读 Linear 状态/注释；不扩修上述无关失败。

原始本轮临时日志在 `/tmp/fly2448-audit/{build,tests,install}.log`。待代码评审与 needs_review 回执；此文档不是已交付证明。
