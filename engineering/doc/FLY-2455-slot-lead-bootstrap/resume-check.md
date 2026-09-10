# FLY-2455 529 房启动恢复 — 恢复核验
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-09
基于: progress.md, plan.md, review-handoff.md

## 权威状态与范围

本次恢复取得 implement TURN epoch 6，初始工作树干净，HEAD `daeff970c`。已读 onboarding 文档和设计交接；原 design question `bdd61544-2b56-4257-8e1d-a8399854c530` 实时返回有效 APPROVED，request `33c78f8a-aba4-42d7-a70d-f53079416d77`。当前 plan.md SHA-256 为 `e77c5d19d3933fc2e6e96a0f6822762ffb82aa416813ec4322056ccff6df0df3`，与评审交接一致，未修改计划。

Lead 指令 `[lead-instruction 6dca45a7-a556-4fc7-beea-056cee2de7e5]` 明确 C1/C2 已完整提交，不重做；C3 等 FLY-2454 合入 SHA 与隔离 QA 报告。在依赖门前保持运行，准备 C4 hermetic 入口和 PR 草稿，不执行真实 slot deploy/teardown。

## 本次聚焦恢复验证

执行对象是 `daeff970c`，无代码修改。这些检查不替代 C5 最终全仓回归，也不证明真实 slot 可用。

`node --test scripts/__tests__/qa-lead-diagnostics.test.mjs`：exit 0，8 tests / 8 pass / 0 fail / 0 skipped，duration 9937.444375 ms。覆盖失败分类、路径与 symlink 拒绝、正文上限/代际/合并/处置、旧代状态、活 recorder 与无法确认退出时拒绝 discard、工具缺失/超时。

`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`：exit 0，输出：

```text
[PASS] 289 shell suites are explicitly classified (235 CI, 55 manual-only)
[PASS] 4 hermetic QA Node suites are explicitly enumerated in CI
[PASS] FLY-2455 CI-line deletion mutation is rejected
```

`bash scripts/__tests__/fly1697-v2-lease-body.test.sh`：exit 0，16 passed, 0 failed。执行真实 lead-body/claude-lead/bundle 主线，使用临时 HOME、fixture 配置与受控外部命令；覆盖 live lease/PID、ambient EXIT ownership、停止 server 前记录、child 42、诊断写失败、TERM/INT、materialize/sentinel/transport/receipt/cleanup 失败及 identity mutation/degraded 控制。

在文档提交后的 `66d4a41d4` 执行 `pnpm lint`：exit 0，Checked 3027 files in 3s，14 warnings，No fixes applied。Biome 另提示 StateStore.ts 超过其 1 MiB 配置上限；不将本命令称为逐文件无遗漏的静态检查。

同一 head 对新鲜 fetch 的 `origin/main@04ff8800aea9e796aef5f3f9f2a3d9004530f65b` 执行 `git merge-tree --write-tree HEAD origin/main`：exit 0，无冲突，结果树 `d65ad7349cd128ef34db64024d77041e26b71237`。未执行实际合并或 rebase。FLY-2454 尚未合入，该结果不能代替依赖落地后及最终 PR head 的整合检查。

## C4 hermetic 边界清单

根因专属 RED 必须由 C3 实证和增量评审决定，目前不预写猜测性修复或调整测试期望。

- 若实际失败为 verifier 客户端漂移：`fly1663-qa-launchd.test.sh` 执行真实 verifier；`test-deploy-fly1389.test.sh` D1 经真实 deploy composition 注入失败 tmux，断言具体 reason、0600 快照与停止前留证。D1 是失败诊断控制，不是客户端漂移已证实的依据。
- 若实际失败为正文早退：`fly1663-lead-v2-runtime.test.sh` 的真实 wrapper/快速退出 body 可保护捕获链；`fly1697-v2-lease-body.test.sh` 的真实 body/bundle 主线可承载 C3 指定输入的 RED。现有 child exit 42 只证明退出码保存，不证明早退输入已修好。
- `test-deploy-fly1389.test.sh` A 覆盖 `--alerts` canonical projects/token 的单一来源；E 覆盖 Leadful composition。仍须最终真实 2/3 两 Lead 和 alerts 变体。
- 成功 stdout、60×1s cadence、generationChanged、凭据 canary 与 residue 锁保持属于 C1/C2 既有保护，不为通过 C4 而放宽。

`test-deploy-fly1389.test.sh` 含固定 fixture slot 30–35 和 marker-based pkill 清理；本次只读检查，未执行该 composition 套件。最终运行前仍须核对 fixture 占用与清理隔离，不用 hermetic 名称推定所有副作用安全。

## 下一步

PR 草稿见 pr-draft.md，未开 PR。FLY-2454 PR #1137 在本次查询仍为 OPEN，head `2f0b62338958282085e213600a86eeee6e0c205a`、CI 14/14 SUCCESS、mergedAt=null。问题 `20c04c1f` 尚未答复；另依 Lead 指令注册非阻塞 waiting-on-merge 问题 `2de4ce60-1c77-42bf-a195-84cf0e65090b`。依赖通过后才开始 baseline/诊断 head 复现和 root-cause.md。

## 后续依赖变化与集成预检

PR #1137 后续推进到 `7fc824cf96e549c041cf85ebc17fb0c1e370a9ec`，仍 OPEN/unmerged；新 CI run `34390750882` 在发现时运行中，旧头 14/14 不再是当前 CI 证据。新头 milestone 明确记录旧轮 QA FAIL、真机快照 diff 非空、未发布 QA PASS；其中原始证据不能自行解释为 C3 隔离门已通过。已通过报告 `051a6c1b-960a-4a34-a085-b31c4bb69668` 通知 Lead 新头变化。

只读 `git merge-tree --write-tree HEAD 7fc824cf96e549c041cf85ebc17fb0c1e370a9ec` 返回 1，唯一文本冲突是 `scripts/__tests__/test-deploy-qa-room.test.sh`。解决方向已核对：保留 FLY-2455 的 start/verify/main/extra diagnostic-wiring 断言，再保留 FLY-2454 从 `SLOT_CONTRACT_PROJECTION` 验证 delivery-secret 的新断言；不能保留已移除的 BRIDGE_EXTRA_ENV 字面赋值断言。未实际合并未合入的依赖分支，也未修改测试。

另发现 C4 命令合同冲突：plan.md 和 QA 判据指定普通 `2 --extra-lead 3:Ops-Test --expect-head ...`，但当前脚本 `scripts/test-deploy.sh:273-275` 及新依赖头都明确拒绝非 generalized 模式的 EXPECT_HEAD。已提交非阻塞问题 `ca062df3-f200-439c-bd40-a35315c59ddc`：请 Lead 裁定普通模式 source-HEAD fence 是否纳入 C3 增量设计，或提供经批准的等价身份校验命令。不静默添加 generalized、不丢弃身份校验、不改已批准计划；未执行 deploy。后续自然间隔同时检查此问题。

该问题随后收到 Lead RULING：不放宽 EXPECT_HEAD-only-with-generalized 守卫，也不加 generalized；普通模式保留原始 `2 --extra-lead 3:Ops-Test` 命令，在启动后读取 slot Bridge 自己的 `/api/health.buildSha` 并严格比较预期 head，不匹配或端点不可达即 fail closed。这一等价 HEAD fence 必须记录进 C3 增量设计，plan.md 其余字节保持锁定。Lead 同时确认 test-deploy-qa-room 冲突按上述方式保留双方断言，但只能在 2454 落地后的 merge 时解决，现在不 merge。该裁定不解除 FLY-2454 合入/隔离 QA 前置，也不代表真实 HTTP/buildSha 校验已执行。

依赖再次返工：`349be8042` 包含 `50f3a9639` 的 runner/Bridge 共享 CommDB 坐标修复。其 CI run `34399235662` 最终 12 项 SUCCESS，Quick Gate 与汇总门 FAILURE；失败日志精确指出 `scripts/__tests__/flywheel-snapshot-control.test.mjs` 未登记 ci.yml（job `102626664948`，2026-09-09T20:08:42Z）。已报告 Lead `39b1b331-92d9-4228-a21d-4d6b941c32a2`，没有修改依赖单。

随后 `42f3e74ebc73387ba64df31f8f39e99262892caa` 合入 main，新 CI run `34401851675` 在发现时运行中。只读 diff 确认 main 已补 snapshot 测试登记，并将枚举范围扩为所有 root Node suites。只读 merge-tree 现在有两处冲突：qa-room 测试，以及 `ci-shell-suite-enumeration.test.sh`。后者在依赖落地后应保留上游全量 Node 枚举（含多行 node --test 参数解析）与 endpoint-client 删行突变，同时保留本单 qa-lead-diagnostics 删行突变；不能为消冲突缩回 qa-* 子集或丢掉任何一个门。当前未实际合并或修改脚本。新冲突及处理边界已报告 Lead `d2421134-9b1c-4438-ba98-00f3b3ccb7c7`。
