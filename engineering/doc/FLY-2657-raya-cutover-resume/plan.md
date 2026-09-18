# FLY-2657 Raya 割接恢复 — 实施计划
Issue: FLY-2657 (https://linear.app/geoforge3d/issue/FLY-2657/修复-raya-割接工具容忍旧壳已自死-标准-lead-已在线raya-verify-legacy-owners)
日期: 2026-09-17
基于: 无

## 目标与边界

只修两个已出现的恢复断点，不改变正常割接路径、授权格式、P0–P7 状态机或部署回执 schema：

1. `raya_verify_legacy_owners` 遇到 launchd 明确报告旧服务不存在时，用账本记录的 `pid + start` 只读判断进程身份：PID 已不存在，或当前 PID 的启动时间与账本不同（PID 已被复用），都证明旧 owner 已退场并允许 prestop 继续；PID 与启动时间仍匹配旧 owner，或 PID 存在却取不到启动时间时，仍然拒绝。若 launchd 在主机重启后重新拉起旧壳，则以 launchd 当前 PID 和匹配旧 plist `ProgramArguments` 的进程命令为准，继续走正常 prestop，而不被过期账本 PID 阻断。prestop 全部可逆步骤成功后，既有 `raya_quiesce_legacy_owner` 已卸载分支再持久 disable 并读回，用同一个观测时刻一次写齐 `stop_started_at_ms`、`disabled_at_ms`、`stopped_at_ms`，最后发一条 warning alert。
2. `raya-migration-init --resume-from-failed` 遇到已有标准 Lead cursor 时，只在 public `~/.flywheel/bin/flywheel-lead.sh verify --stage live` 通过后复用该文件；该 verify 自带唯一 launchd running PID 判据。账本写 `cursor.status="preexisting"`。没有 resume 标志、Lead 不 live、verify 失败、cursor 不安全时仍然拒绝。
3. preexisting cursor 不走“停止 writer 后 seed”的旧路径：P3 只读验证当前 cursor 覆盖 migration boundary；P4b 先确认现有 Lead live，再执行受控 install 把进程重启到本轮物化的 artifact/persona，并按既有生产节拍最多 30×2 秒等待 live-verify；P6 以 migration boundary 的 canonical digest 为 `seed_digest`，同时核实当前 cursor 仍不落后。cursor 只前进，不伪造 `writerStopped:true`。

实现节点不重建生产账本、不运行班车、不更新生产 checkout、不重启服务，也不写生产 deploy receipt；这些是后续受权的部署/QA 工作。

## 最小实现

- 复用现有 `raya_manifest_transform`、`raya_legacy_disabled`、`raya_alert`、`RAYA_STANDARD_NODE_BIN`、`readPrivate`、`digest` 与 `MigrationIO.run`；仅为两处需要同一身份判据的 shell 调用提取一个小 helper，不新增依赖。
- `raya_verify_legacy_owners` 的缺失服务分支保持只读：先接受原有 `pid == null` / 已有 stop intent；否则 helper 读取账本中的正整数 PID 与非空 `start`。`kill -0` 失败证明 PID 已不存在；若 PID 存在，则读取当前启动时间，只有它与账本 `start` 不同（PID 重用）时才视为旧 owner 已退出。当前启动时间相同或无法读取时拒绝。live 服务分支改用 launchd 当前 PID，并通过标准库解析 `ps -ww` 结果，要求其三个 argv 与已验证 plist 的 `ProgramArguments` 一致；正常 prestop 写 stop intent 时同步账本 `pid + start` 为实际被停的旧壳身份。
- `raya_quiesce_legacy_owner` 在 prestop 成功之后处理已卸载 owner 时复用同一 helper；随后沿用既有顺序执行并读回 `launchctl disable`，以同一个毫秒时间戳和 `//=` 一次写齐三个字段，再发 warning。因为第一次/第二次 verify 都零写，fetch、build、quiet-check、ff 或 candidate 校验失败不会产生 stop intent，下一班仍走完整 prestop。
- TypeScript 只在 `resumeFromFailed && cursor exists` 的窄分支调用 public `~/.flywheel/bin/flywheel-lead.sh verify --stage live <canonical manifest>`；不重复实现 launchd parser。给 `MigrationIO.run` 增加可选 timeout 参数，该次 live verify 使用 30 秒，其余调用保留 15 秒默认值。通过后用既有 cursor parser 验证私有普通文件，但不把易漂移的 init 时刻摘要当作冻结证据。
- 给现有 cursor 工具增加一个窄的 `--preexisting` 只读模式：要求 seed 明确写 `writerStopped:false`，原子读取并验证 current 与 canonical boundary 的 key 集合一致且每个值 `>=` boundary；返回 current digest 与独立的 canonical boundary digest，不写 cursor。普通 seed 模式仍要求 `writerStopped:true`，语义不变。
- P3 的 `seed-boundary` 根据 init 写入的 `cursor.status` 生成真实 `writerStopped`。updater 对 preexisting 走独立记录分支，不调用 `raya_manifest_record_cursor`，把 boundary digest 存在既有 `cursor.sha256`（保持 P6 `seed_digest` 语义）、把 current digest 仅作观测字段并保留 `status="preexisting"`；普通分支仍通过原函数，继续拒绝 `already_advanced`。
- `scripts/lib/raya-standard-migration.sh` 的 `raya_standard_preinstall_ready` 增加显式 preexisting 臂：普通 `seeded/already_seeded` 仍要求磁盘 cursor 摘要精确等于 `cursor.sha256`；preexisting 则调用只读 boundary validator，绝不拿 live 文件摘要与 boundary digest 做相等比较。P4b 通过该闸后先 public live verify，再调用 public install 受控重启；install 完成时间持久化后最多 30×2 秒轮询 live，耗尽则返回 awaiting/refused，下一趟只续等而不重复 install。普通迁移仍走 preflight → install → installed verify。
- P6 proof 仅在 `cursor.status=="preexisting"` 时要求 `writerStopped:false`，并继续逐频道断言当前 cursor 不落后于 seed boundary；其他状态仍要求 `writerStopped:true`。这样 live cursor 可继续前进，而 proof 与 v2 receipt 的 `seed_digest` 始终指向真实 migration boundary。
- 生产恢复顺序固定为先用 founder 授权行执行 `init --resume-from-failed`，再由后续受权班车推进 P2–P7。fresh init 会把已消失旧壳记为 `pid:null`；shell 的 stale `pid + start` 修复用于已生成账本后旧壳自行退出/PID 重用的防复发场景，两项不互相依赖。

## TDD 与验证

1. 先扩展 `scripts/__tests__/updater-raya-deploy.test.sh`：构造两个 owner 同时 service missing，以及单 owner 的 PID 已退出 / 被无关进程复用；跑过两次只读 verify、quiesce、retired gate，断言同一时间戳三字段、disable readback、warning、P2 可推进 P3。对照证明 PID 与账本启动时间仍一致（旧壳仍活）时拒绝且零账本/disable 写入。
2. 在同一 shell 套件注入 verify 通过后的 fetch（或 target SHA）失败，断言 stop 三字段仍为空；下一次 `raya_prepare_source` 必须重新进入 prestop，而不是命中 `stop_started_at_ms` 快路径。
3. 先扩展 `packages/teamlead/src/bin/raya-migration-init.test.ts`：已有 cursor + resume + public live verify PASS 时重建账本并记 `preexisting`；live verify 失败、cursor 不安全或无 resume 时文件字节不变。
4. 扩展 cursor、shuttle、proof、`raya-standard-migration.sh` 与 updater 聚焦夹具：preexisting current 等于/领先 boundary 时保持 cursor 只读并到 P5/P6，低于/缺 key/多 key 拒绝；断言调用一次受控 install、在第三次 post-install live verify 才推进、30 次耗尽有界且下一趟不重复 install，并且不调用普通 seed 写路径或写出 `writerStopped:true`；普通迁移的 exact digest 与 `already_advanced` 拒绝保持原行为。
5. 先运行相关聚焦套件确认红，再做最小生产改动并跑绿。
6. 运行 `pnpm lint`、`pnpm -r build`、相关 root shell suite 与 CI 结构测试。2026-09-18 Lead 按 FLY-2467 裁定本次返工禁止本地主机 package aggregate；只跑受返工影响的包与聚焦阴性对照，整包结论以 exact-head GitHub CI run id 为准，不把聚焦绿冒充全量绿。
7. exact-head 代码审查通过后提交并 push，创建 PR；不 merge、不部署、不派 QA。

## 验收映射

| 需求 | 当前实现节点证据 | 后续生产证据 |
| --- | --- | --- |
| 旧壳自死不再卡 prestop | shell 整链夹具证明 disable、三时间字段、retired gate 与 P2→P3 | 账本写出 `old_stopped_at` 并推进 P3，而非只看错误字符串消失 |
| live 标准 Lead 可复用 cursor 重建账本 | init + 只读 boundary 验证的正/负夹具；零 cursor 写入，受控 install 后再次 live verify | 用 founder 授权行执行 init 后账本为 `preexisting`，班车 P4b 重启到新 artifact 后 live verify PASS |
| P0–P7 与 v2 standard-lead receipt | proof 夹具覆盖 live advanced cursor 与真实 boundary digest，既有 v2 key/schema 测试保持绿 | 受权班车账本到 P7，回执 `schemaVersion:2`、`carrier:"standard-lead"` |

## R4 advisory 处置

| findingKey | 实现处置 |
| --- | --- |
| `quiesce-helper-rejects-pid-null-owners` | quiesce 对 init 新建的 `pid:null, loaded:false` owner 直接进入既有 disable/三字段路径；只有账本仍记录正整数 PID 时才调用 stale-PID helper。补 `pid:null` 整链夹具。 |
| `warning-alert-fires-on-normal-cutover-path` | 记录本轮首次 `launchctl print` 是否已经 missing；只有“进入 quiesce 前已自行退出”的 owner 在持久化三字段后发 warning。由本轮正常 bootout 的 owner 不发 warning，并补阴性断言。 |
| `p4b-preexisting-arm-drops-bridge-token-gate` | preexisting P4b 仍按原顺序通过 `raya_standard_preinstall_ready` 与 `raya_bridge_token_ready`，之后才执行 live verify → install → live verify。 |

## Code review R1

HIGH `preexisting-p4b-skips-lead-restart` 有效：只验证既有 Lead live 不能证明进程已经读取本轮新物化的 artifact/persona。最小修复保留 preexisting cursor 的只读语义，但在 P4b 通过 cursor 与 bridge gate 后按 `verify live → install → verify live` 重启标准 Lead；夹具固定该顺序，P5 只在重启后的 live readback 通过后推进。

## Code review R2

HIGH `preexisting-install-then-live-verify-has-no-readiness-wait` 有效：launchctl bootstrap 返回不等于新 Lead 的 inbox socket 已 ready。修复复用仓库生产重启的 30×2 秒节拍；install 成功后先在 P4b 持久化 `lead_restart_installed_at`，再轮询 live verify。耗尽时班车写 refused/awaiting 并释放锁；下趟看到该字段只继续 readiness，不重复 install 或刷 severe。夹具覆盖前两次失败、第三次成功、30 次耗尽与续跑不重复 install。

## Code review R4

HIGH `preexisting-window-probe-consumed-before-activation` 有效：preexisting 路径原先只在 P3 发探针，而标准 Lead 当时已经在线，可能在 P4b 的 `activated_at` 之前消费并回复；P6 的 activation-window 证据会永久拒绝这组消息。最小修复保留 P3 探针作为静默窗口与 cursor seed boundary，重启后的 Lead live-verify 通过时再原子写入 `activated_at`、把旧探针归档为 `seed_probe`，随后在 P4b 发一枚新的 post-activation 探针，只有该探针成功持久化后才进入 P5。P4b shuttle 只对 `cursor.status="preexisting"`、有效 restart/activation/seed/reset 证据开放，并用 Discord snowflake 拒绝早于 activation 的消息；POST 结果不确定时仍停在 P4b，显式 `probe_not_delivered` / `probe_message-id` 恢复后可幂等续跑。

## Lead 生产事实更新

2026-09-17 主机重启后，launchd 曾把 brain 旧壳以新 PID 拉起，而账本仍保留旧 PID。实现因此同时覆盖并测试两条路径：live 且 argv 匹配的当前 launchd owner 走正常 disable/bootout；launchd owner 缺失且账本身份证明旧进程已退场时，才走 already-exited 记账与 warning。live label 若对应外来命令则在任何 stop intent 或 lifecycle 副作用前拒绝。
