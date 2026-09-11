# FLY-1949 评审并发 — 验证记录
Issue: FLY-1949 (https://linear.app/geoforge3d/issue/FLY-1949/评审并发-review-全局并发写死-2-提高并做成可配置founder-直令)
日期: 2026-09-10
基于: plan.md

## 实施与范围

依据 Lead question 47a5e0ee-7167-4710-810d-aaca4a5a3206：保留 FLY-2037 默认无限，仅增加可选环境变量，构造时读取，无热更新。生产代码 commit ead433df0；设计 APPROVED gate 10c0893b-f8a0-4ed8-9cae-54401d578421；代码 APPROVED gate 2e779d2a-0c42-4200-9b9a-55b2c69f33c5，reviewedHeadSha ac3c0472465753cd7234021fe2d1ac6ef27af2bf（R1）。此后只补交付文档与里程碑。

配置说明集中于 plugin.ts coordinator wiring 注释。默认模式保持原调度调用顺序；cap 模式在 per-execution chain 内申请 FIFO slot，所有已获取 slot 的返回/异常路径 finally 释放。stop 唤醒等待者但不启动 job；pending rows 可由新 coordinator boot redrive。环境名在 NON_FLAG_ALLOWLIST 登记。

## TDD 证据

- 首个 cap=1 测试 RED：预期仅启动 1 个 reviewer，旧实现实际为 2；最小 semaphore 后 GREEN，queued request 最终 done。
- 非法 cap 输入测试 RED：7 个案例缺少 warning；严格十进制安全整数验证后 GREEN。
- 回归曾发现默认模式额外 await 改变 head-move 时序；默认无限路径保留旧调用顺序后全套恢复。
- 最终 coordinator suite 140/140 PASS，包含 unset/0/empty/invalid 无限、构造后 env 变化不生效、异常释放、stop/boot 恢复、排队门过期 fail-close、同 execution 串行。

## 本机命令结果

| 命令 | 结果 |
| --- | --- |
| pnpm lint | exit 0，15 warnings，未自动修复无关文件 |
| pnpm -r build | exit 0 |
| pnpm test:packages:run | exit 1，遇 flywheel-comm 失败提前退出；不宣称全仓绿 |
| pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/review-request-coordinator.test.ts | 140 passed |
| feature-flags-drift（总套件内） | 14 passed |
| pnpm --filter flywheel-teamlead exec vitest run | 970 文件通过 / 3 失败；13139 测试通过 / 5 失败 / 7 skipped；1 worker error |

flywheel-comm 总套件：3 files failed / 154 passed，4 tests failed / 2262 passed / 2 skipped。失败包括 cli.test.ts 两个 5s timeout、dependency.test.ts 一个 5s timeout、runner-stop-declaration-race.test.ts 一个 stale/sent 竞态断言；另有 onTaskUpdate worker timeout。三文件隔离复跑：102 passed / 2 timeout / 1 worker error；race 用例通过，cli runner-stopped 与 dependency no_active_roots 仍超时。

TeamLead 总套件失败：claude-profile-cli.integration.test.ts 两个 subprocess failure；fly2339-bounded-delivery-maintenance.test.ts 实际 1197ms 超过 1000ms；automated-message-inventory.test.ts 两个 5s timeout；另有 onTaskUpdate worker timeout。这三个文件隔离复跑 22/22 PASS（exit 0）。隔离通过不改写原 aggregate 失败。

未新增 scripts/__tests__/*.test.sh，无新 shell suite；无 schema/migration。生产未部署或重启，真实账号限额和 FLY-1884 排队现场尚未验证。最终 PR HEAD 的 CI 另行核验。

## 非阻塞建议

代码评审 APPROVED，六条 advisory 已转交 Lead：复用 core semaphore、env/deps seam、排队可观测性、排队门过期提示、非法值日志上下文、共享测试 env 隔离。依 Lead 指令不扩范围修改。门过期仍沿既有 fail-close；排队持久化并不延长 gate TTL。pending 同 head 复用窗口是设计评审提出的后续议题，本次不改去重协议。

## 本机日志指纹

- /tmp/fly1949-red-cap.log: SHA-256 `b4dd58f7eee1816c220e4f3987b1c93367941fbf8164eb17b5bb3af143d6388a`
- /tmp/fly1949-green-cap.log: SHA-256 `232776cb3ddac94c825a909b5c19c170a193d369cc639e849b6f98e82f300000`
- /tmp/fly1949-red-validation.log: SHA-256 `f3f66cda9442b8341ab545f3491c1e6a8e66ce975badedb76a2cbc9741d737de`
- /tmp/fly1949-focused-current.log: SHA-256 `6118d7137702739b8236e711e0596d8badf1b0374e14e130c84b5d0b2376e251`
- /tmp/fly1949-lint.log: SHA-256 `a4fa393d3175e996352b9a890f6ca65ed67e112d05f52610d10eb5b3c3fa29cb`
- /tmp/fly1949-build-final.log: SHA-256 `0bf3d2352d24c0005d9ddfdff05065efc03dfdffb236b42fec98d1ced401732a`
- /tmp/fly1949-packages.log: SHA-256 `f4fc75ecf98c057820d38a49260eeeb946c225e286f0554982ecaa7821111350`
- /tmp/fly1949-comm-recheck.log: SHA-256 `e5e17658d1306142d45d7a41186770695b60f97d98fdaea52b63f1ad14dfd51b`
- /tmp/fly1949-teamlead.log: SHA-256 `f16044cc41f1256877aa369b021f289af3bfadce055370fb84d29ca8d1cfd2f9`
- /tmp/fly1949-teamlead-recheck.log: SHA-256 `0730a8db84aa5d855f8349a8a5d9d64607a64cbac172ff218e43d5f78ddee25c`
- /tmp/fly1949-code-review.json: SHA-256 `82dc04282cee60da3dc74e9575c65699cbcf7d5f22143590990e9fe565970b33`
