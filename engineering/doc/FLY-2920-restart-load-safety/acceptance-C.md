# FLY-2920 起体与排空 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

状态：C 实现与本地针对性验证完成；联合实现后的构建、有效评审及交卷另行进行。以下仅本地受控延迟/隔离数据库证据。

## 行为与边界

`defaultAsyncExecFile` 删除 exit 后独立 250ms drain timer。成功仍须 exit=0 且收到 close，后代持有的 stdout/stderr 在整体 deadline 内继续收集。调用方 timeout 优先，没有正有限 timeout 时使用 90,000ms。退出后的直接 PID 和负 PGID 都不再发信号；deadline 仅销毁本次管道并返回 ETIMEDOUT，保留真实退出信息。ENOENT、非零退出、maxBuffer 与执行期间硬超时合同保留。

`RunDispatcher` 的受观察启动，只对已经确定 precommit_failed 且 physicalEvidence 为 absent/cleaned 的结果清理 claim/CommDB。unknown 和 committed 交给既有恢复路径。`runs-route` 不再从任意 start 异常推断 absent；只有现有明确 pre-launch 类型可使用该证据。观察超时同属 unknown，返回 202 LAUNCH_PENDING，不能从超时推导死亡。

## 红/绿记录

| 夹具 / 命令 | 红证据 | 当前绿证据 |
| --- | --- | --- |
| claude-runner `vitest run test/async-exec-file.test.ts` | 旧版 baseline 7通过；新增期望后3失败/6通过：600ms被250ms拒绝、持管道超时错误类型错误、缺默认90s整体预算 | 9通过；真实父子进程与双管道尾输出、1500ms整体deadline、无退出后signal |
| claude-runner 两 vendor 文件 `-t FLY-2920` | 临时恢复 HEAD 的 TmuxAdapter.ts 后，两例均失败；之后原样恢复已验证修复 | 两 vendor 全文件合计365通过；Claude本例目前仅ensure入口，尚不能代替execute验收 |
| teamlead `run-infra-async-child.test.ts` | 600ms证据命令因250ms拒绝，1失败/3通过 | 4通过；真实跨包helper。第一次绿尝试仍使用旧dist，准确记录为失败；重建claude-runner后通过 |
| teamlead `run-dispatcher-pre-registration-cleanup.test.ts -t FLY-2920` | unknown/throw错误删除预登记，2失败/2通过 | 全文件9通过，absent/cleaned释放，unknown/throw保留；临时真实CommDB |
| teamlead `runs-route-generalized-pending.test.ts -t FLY-2920` | 任意throw及commit后throw均500，新增两例失败 | 真实HTTP+临时StateStore全文件12通过；包括同节点generation1释放后generation2成功、unknown原handle恢复且仅一次dispatch |
| 同 route `-t 'observation deadline'` | 503违背unknown待定合同，1失败 | 202 LAUNCH_PENDING；core将timeout定义为仅unknown，原503分支已删除 |
| CodexTmuxAdapter `-t FLY-2920`（新增非零退出后） | 非零退出是保留负例，不声称旧版失败 | 2通过：600ms preflight后execute成功；真实exit7保留stderr且runtime零次启动 |

完整已读日志：`/tmp/fly2920-C-{baseline,red,green,vendors-red,vendors-green,cross-red,cross-green,lifecycle-red,lifecycle-green,claim-red,timeout-red,route-final,codex-extra}.log`。`cross-green`是尚未重建依赖时的失败记录，真正跨包绿在`lifecycle-green`。

`vendors-green`: 3文件374通过（188 Claude +177 Codex +9 helper），没有把同文件之外的包内测试称为已通过。随后新增Codex保留负例单独2通过，未覆盖全包。

`lifecycle-green`: 4文件41通过（原route10 + recovery18 + cleanup9 + cross4）；随后route新增延续证明与超时修正，全文件12通过。

## 最终消费者与补齐证据

- Claude `execute()` 两例使用真实 async helper，600ms 继承管道；exit0 只创建一次窗口并回调一次，exit9 保留非零诊断/stderr、不创建窗口、不重试。最终测试字节在旧250ms源码下两例均红（`/tmp/fly2920-claude-execute-red-final.log`）；当前源码两例绿（`/tmp/fly2920-claude-execute-green.log`）。夹具首次整体2s预算受主机负载超时，最终使用5s整体预算与15s测试预算；产品预算未调整。
- claude-runner `vitest related src/TmuxAdapter.ts --run` 采用明确3文件配置：377通过，1条现有30ms退休回调计数在负载下失败（3而非4）。原断言/原代码未改，单独重跑1通过（`/tmp/fly2920-C-{runner-related,retirement-retry}.log`）。不能把第一次 related 称为全绿。
- teamlead `vitest related src/bridge/run-dispatcher.ts src/bridge/runs-route.ts --run` 明确白名单选中3文件25通过（`/tmp/fly2920-C-teamlead-related.log`）；恢复模块18条此前独立保留并通过。
- 其他 adapter 保留消费者6文件48通过，含新增真实SIGTERM错误元数据测试（`/tmp/fly2920-C-adapter-consumers.log`）。FLY-2211 inventory5通过（`/tmp/fly2920-C-inventory.log`），仅增加这一新QA signal语句条目。
- dispatcher直接消费者8文件155通过（`/tmp/fly2920-C-dispatch-regression.log`）。route直接消费者10文件223通过、1既有跳过、1注册测试超时（`/tmp/fly2920-C-route-consumers.log`）。隔离重跑仍在15s动态import阶段失败；诊断日志仅有import-start、尚未进入startBridge。将同一import移到已注册mock后的模块收集阶段，保留原15s运行预算/HTTP断言，注册用例4.34s通过（`/tmp/fly2920-C-registration-collected.log`；收集48.11s）。原失败/诊断日志保留，未增大超时。
- edge-worker直接helper消费者2文件60通过（WorktreeManager及Blueprint plugin readiness，`/tmp/fly2920-C-edge-consumers.log`）。teamlead其余直接helper/实际quota恢复消费者6文件55通过（ActionExecutor、fleet-console、workflow-docs-git两文件、sync-op marker、quota bench；`/tmp/fly2920-C-extra-consumers.log`）。
- config lexical guards2文件20通过（`/tmp/fly2920-C-config-guards.log`）；FLY-1674 residue87通过、runtime-role auto-QA retirement通过（`/tmp/fly2920-C-{residue,autoqa}.log`）。
- `consumers-C.json`逐项列出171处搜索匹配的保留/排除理由；额外直接helper消费者在retained名单。相关路径Biome10文件通过（`/tmp/fly2920-C-biome.log`），diff检查通过。新helper已编译，B保留shell回归亦在重建两个包后通过；联合最终构建待D-G完成。
- C生产规格复核、质量复核及注册夹具后续复核均通过。这不是有效全头code review、完整CI或QA证据。
