# FLY-2392 客户自动更新器 — 实施记录
Issue: FLY-2392 (https://linear.app/geoforge3d/issue/FLY-2392/1143b5-客户自动更新器-止血定时更新器查-customer-release-装-即时失败回滚单飞-central)
日期: 2026-09-13
基于: plan.md

## 实现与范围

按已批准 plan v6 实施 C1–C9，未修改固定 plan。customer manifest v1 与
manifest schema 保持原合同；新增 admin 时间响应头供撤版 CAS 使用。

- customer-release capability 可将已过期的 release 标为 expired。withdraw 按服务端
  时间自动选择 previous-good；无可用候选时需 `--allow-pause`，同一 CAS 完成
  quarantine、expired 与 pointer 摘除。时间守卫 422 有界重新读取、重新派生。
- 薄壳持久化 applying、knownGood、pending、holds 与最近结果；所有修改安装的入口
  先拿单飞锁、读取账本三态、结算未完成事务。新目标和复用目标分别处理，失败先记录
  receipt 再恢复服务，同一次 startedAt 重放不重复计数。
- 定时检查默认 6 小时，默认本地 03:00 起 2 小时安装窗。被撤版 current 的替换绕过
  安装窗；paused 保留当前版本。即时失败恢复本地旧版，没有可用旧版则诚实 degraded。
- `rollback` 本地复用并 hold outgoing；`install VERSION` 先验证客户可见性，成功在
  同一账本写中清 hold。held-current 自重装失败不删除 current、不假报 rolled_back。
- 固定壳副本、packaged wrapper、bootstrap timer 与 `auto-update on/off/status`
  完成打包闭包。开启失败保留关闭标记；首次 trigger 前释放锁。status 提供中文摘要
  与 JSON。客户 README、发布运维、CONTRACT Amendment B5、打包 audit 已更新。

未合并 main、未部署、未重启 Bridge/Lead、未触碰生产数据库；fixture supervisor
代替真实客户机服务。v1 没有忙闲/会议检测与晚期 crash-loop 回滚，见运维段。

## 验证回执

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | exit 0；3495 files，16 warnings，未改无关警告 |
| `pnpm -r build` | exit 0 |
| `node --test packages/onboard-shell/__tests__/*.test.mjs` | 86/86，包括真实进程锁、15 项新增 SIGKILL 矩阵、on/off/status 与存量迁移 |
| `bash scripts/__tests__/customer-auto-update-acceptance.test.sh` | 6/6；真实 endpoint handler + release/promote CLI + npm-packed public shell |
| `bash packages/payload-endpoint/__tests__/contract-consistency.test.sh` | install 9、negatives 9、rotation 6、secret 6、qa-gaps 3，共五组 33 项通过真实 handler；publish-gate 单独执行 |
| publish-gate | 11/11，lib 闭包含所有新增模块 |
| packaged wrapper/bootstrap | wrapper 四种早退/执行路径及仅装 auto-update、可配/非法 schedule 通过 |
| provision-prebuilt / packaged-seams / package-onboard | 6/6、17/17、28/28 |
| C1/C2 targeted | endpoint 97、withdraw controls/client 27、pipeline 44、workflow 23、argv 19 均通过 |

### 全量包测试失败与 Lead 处置

执行 `pnpm test:packages:run`，按 plan §8 临时在 core Vitest 配置排除
`**/tmux-viewer.macos.test.ts`；命令结束后恢复原配置，未提交排除项。

原始结果为 **exit 1**，在 flywheel-comm 提前停止：

```text
Test Files  5 failed | 174 passed (179)
Tests       6 failed | 2474 passed | 3 skipped (2483)
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL flywheel-comm@0.1.0 test:run: vitest run
```

5 个 `Test timed out in 5000ms`：cli 的 runner-stopped/check 两项，
lead-backend-migration-registry、lead-registry-cli、dependency 各一项。
第六项为 `mailbox-terminal-archive.fly2341` 的冲突隔离断言：
`AssertionError: expected [] to deeply equal [ 'alpha' ]`。
后续依赖包未由该次递归运行完成，不能把此回执写成全量绿色。

Lead 对 question `38425927-edd0-4137-9f4e-9bacdc2885bb` 裁定：各失败文件逐个隔离
一次；隔离绿则保留全量红，以精确头 CI 为准直接进入 review/PR，不重跑全量、不调
超时、不改无关代码。裁定抵达前已在运行的五文件组合诊断为 158/158 通过；随后另按
裁定逐个执行一次 `pnpm --filter flywheel-comm exec vitest run <file>`：

| 文件 | 隔离结果 |
| --- | --- |
| src/__tests__/cli.test.ts | 59/59 |
| src/__tests__/lead-backend-migration-registry.test.ts | 9/9 |
| src/__tests__/lead-registry-cli.test.ts | 31/31 |
| src/__tests__/mailbox-terminal-archive.fly2341.test.ts | 17/17 |
| src/commands/__tests__/dependency.test.ts | 42/42 |

逐个隔离共 158/158，均 exit 0。完成裁定的报告为
`0a2a82f6-0d99-4c05-ae6f-2ed811759f23`。全量失败不被隔离成功覆盖。

### 六场景 E2E

```text
PASS E1 previous-good: withdraw auto restores locally without download and holds withdrawn version
PASS E2 expired previous-good: withdraw pauses, existing current stays, first installation fails cleanly
PASS E3 first release unhealthy: explicit degraded state, hold, no dangling current, central pause
PASS E4 update failure rolls back immediately, second allowed attempt fails, third is held
PASS E5 first successful update retains previous-good for local rollback and holds outgoing version
PASS E6 withdraw crosses retention between GET and POST: retries against server time to deterministic pause
```

E6 从第 27 天的 GET 到第 31 天的 POST 跨越合同的 28 天 release 保留边界，断言两次
POST，最终 expired + quarantined + null pointer。代理透传 `X-FW-Server-Time`。
E1 离开安装窗仍降回，KEYLOG 断言零 payload 下载，下一 tick 不再升级。
E4 restart 序列为 `9.9.10,9.9.9,9.9.10,9.9.9`，第三次 tick 无新增 restart。

paused 的结构化输出：

```json
{"action":"withdraw","withdrawn":"9.9.10","fallback":null,"latest":null,"outcome":"paused","expired":["9.9.9"]}
```

status JSON 的夹具摘录（该 E2E 不装宿主 supervisor）：

```json
{"enabled":true,"supervisorLoaded":false,"ledgerState":"valid","currentVersion":"9.9.10","previousGoodVersion":"9.9.9","shellVersion":"0.1.0","pendingVersion":null,"holds":{}}
```

### 崩溃与回放

真实子进程在 installed、flipped_intent、flipped、首次 restart 中断、failure_receipt、
target_cleaned、restored_pointer、restored_health、healthy 边界 SIGKILL 后启动新进程，
逐项核对磁盘 phase、current 指向、restart 序列、hold/attempts。
额外覆盖 receipt 写失败后 dangling current，再在结算 receipt 后第二次 SIGKILL：
最终 attempts 恰为 2，下一次自动尝试被 hold 阻止；部分递归清理中断也可恢复。
旧版 restart 失败或复验失败均为 degraded。install VERSION 的 healthy/committed
处 SIGKILL 均从耐久 intent 清除 hold；rollback 与 held-current 自重装已有对应覆盖。

macOS 锁测试实际验证双进程竞争、SIGKILL 后内核释放、子进程不继承 fd、inode 更换
拒绝。Linux 死锁目录只由测试模拟操作员清理，运行时不自动回收。

## 收尾状态

实现与上述本地验证已完成；本记录写入时精确 HEAD review、GitHub CI、PR 和
needs_review 交接仍待完成，其证据以随后 comm gate/报告与 PR checks 为准。
实现交接不等同客户机服务验收或生产发布。没有额外需要加入角色记忆的新判断，
本次代码与验证细节保存在本文件和测试中。

## 首轮 CI 与登记修复（613fd96a1）

PR #1177 首轮 CI run `34796539262`：Quick Gate、NPM payload distribution、Unit light
通过；CI 中 flywheel-comm 为 2482 passed / 1 skipped，未复现本地六项失败。
发现本任务两处登记遗漏，均按 CI 红回执补齐：

- `scripts/packaged/flywheel-auto-update.sh` 的 native-first PATH 未列入
  `path_hygiene_source_path_registry`。只新增一行登记，未改 wrapper 运行逻辑。
  `bash scripts/__tests__/check-global-path-hygiene.test.sh`：21/21，通过。
- kill-path inventory 少八条新记录：七条 QA-only 崩溃/夹具进程结束，及一条
  `process.kill(owner.pid, 0)` signal-0-probe。使用既有扫描器更新机械清单，仅新增
  八项/48 行，无信号行为更改。`pnpm --filter flywheel-claude-runner exec vitest run
  test/kill-path-inventory.test.ts`：5/5，通过。

另有本任务 diff 外的失败，未修无关代码：

- Script3 `ship-await-ci.test.sh`：144 passed / 0 failed 后，EXIT 清理报
  `rm: cannot remove '/tmp/.../repo/.git': Directory not empty`，任务 exit 1。
- TeamLead shard 3：338 files passed，4018 tests passed / 1 skipped，仍因
  `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` 记一个 unhandled error，任务失败。

Lead question `5ed61019-c1ff-4c40-8e3b-20bd81a74190` 允许登记修复后一次新头推送并冻结，
审查随 head_moved 重排；新头若只剩上述 `.git` EXIT 清理失败，允许一次 rerun failed，
再失败保留 pre-existing 回执继续。新 HEAD 的 review/CI 结果另见 comm 与 PR checks。

## guard16 收口

504c6c090 的代码审查 round 2 为 APPROVED，并指出计划 guard16 扫描根遗漏。
按 Lead question `56f2a00a-2160-4b17-91c6-3d1897e0bfdf`，仅将 onboard-shell/lib
加入 consumers-lint 的 SCAN_ROOTS；其余七条建议列在 review.md，由 Lead 跟进。
变异探针在补丁前触发「guard16 failed to reject」断言，补丁后被检测；探针已删除，
正常消费者扫描 3/3、Biome 通过。未修改客户运行逻辑。

504c6c090 的 CI run 34797264022 曾在 diff 外 db-maintenance.test.sh 得到
「weekly lifecycle repeated or failed (rc=0 receipts=4)」，10 passed / 1 failed。
该文件不在 `git diff origin/main...HEAD --name-only` 中。Lead question
`6d90de9e-d113-4ed6-9272-07e23e74d20a` 允许与已批准的 onTaskUpdate / 临时 .git
清理一样至多重跑一次失败任务，保留原红回执、不改无关代码；目前该额度尚未使用。
