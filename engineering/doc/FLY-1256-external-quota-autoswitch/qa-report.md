# FLY-1256 外部配额监控 + 自动切号器 — QA 报告

Issue: FLY-1256 (https://linear.app/geoforge3d/issue/FLY-1256)
日期: 2026-07-15
基于: plan.md, exploration.md, research.md, 本分支实现 (PR #603)

**QA 阶段**: 三段式流水线 QA 段 (Claude Opus)。实现代码由 Codex gpt-5.6-sol 提交在本分支，本报告为**独立验证**（未重写功能，只验证 + 补证据）。

**Verdict: ✅ PASS**

---

## 1. 验证范围

对照 plan.md §7 测试矩阵逐层验证：

| 层 | 内容 | 结果 |
|---|---|---|
| 单测 (teamlead 全套) | 全部 vitest | ✅ exit 0（全绿） |
| 单测 (FLY-1256 20 个测试文件) | usage-api / config / state / pollOnce / revive / cli / credentials / runtime / alert / kind-contract / cutover / switch-executor / account-store / route / pending / freshness / notifier / drained-routing | ✅ **230 passed** |
| 单测 (config 全套，含 feature-flags drift 守卫) | 24 文件 | ✅ **405 passed** |
| shell 契约 (wrapper) | env 优先级 / dist 缺失 fail-loud / crash-loop / plist | ✅ **5/5**（clean env） |
| shell 契约 (setup) | default-enable / 健康探活 / 幂等 bootstrap / monitor-only / order 校验 / symlink fail-closed / disable | ✅ **9/9**（clean env） |
| e2e (hermetic 真机) | `qa-fly-1256-quota-daemon-e2e.sh` | ✅ **PASS**（详见 §2） |
| typecheck | teamlead + config `tsc --noEmit` | ✅ 0 error |
| lint | biome check（改动文件） | ✅ 0 error |
| 安全红线 | token 不落盘 / 不进日志/告警 schema | ✅ 通过（e2e 凭证泄漏 grep + 源码 sentinel） |

## 2. 核心真机场景（Issue 硬性要求）—— PASS

Issue 明文要求：**「真机 QA 必须覆盖『Claude 全员假死时 daemon 独立完成切号』场景」**。

`scripts/qa-fly-1256-quota-daemon-e2e.sh` 是**可运行的隔离真机 e2e**（非骨架）：跑**真编译的 daemon 进程** + 本地 mock usage/OAuth server + scratch Keychain 适配器 + **真** `flywheel-claude-profile` 切号脚本 + 隔离 tmux server（真捕获的 `usage-limit-real.txt` 卡配额 pane）+ 隔离告警 sink。剧本 = active `shopping` 5h 92% → 触发 → 锁下候选验证（school 先于 backup）→ 切到 school → 假卡 pane 被 `continue`+Enter 救活 → 新 active 3% → 告警落隔离通道。

真机运行结果（本轮亲跑）：
```
[FLY-1256 E2E] PASS: cache updated, school validated before backup, Keychain/store switched, quota pane revived, alert isolated
[FLY-1256 E2E] PASS: daemon=node pane=bash proof=ps; fake claude invocation count=0
```

断言链全过，其中关键铁证：
- **`fake claude invocation count=0`** —— 全程零 Claude 进程参与（sentinel `claude` 可执行文件从未被调用）= Claude 全员假死时 daemon 独立完成切号 ✅
- **`daemon=node proof=ps`** —— 切号器是体外 Node 进程，`ps` 证明 owner 不是 claude ✅
- CAS store generation 恰 +1（一次切号，不重复）✅
- statusline 缓存从新账号刷新（five_hour.utilization=3）✅
- revive attempt 持久化（reviveEpoch.panes 记录 attempts=1）✅
- scratch Keychain 切成 refreshed `school-rotated-*` 凭证（复用既有 `use` 机制，daemon 不含 `security add-generic-password`）✅
- 候选验证顺序 school 先于 backup（7d reset 排序 + order 平手）✅
- **凭证物料泄漏 grep**（覆盖 security-argv / state / cache / daemon.log / http.log / alerts.log）零命中 ✅

## 3. plan §7 其余真机场景覆盖来源

| 场景 | 覆盖方式 |
|---|---|
| ① Claude 全员假死独立切号 | **e2e 真机 PASS**（§2） |
| ② 未触发不切 | 单测 pollOnce `observed` 分支 + e2e 触发前的 base 档观察 |
| ③ 候选全无余额只告警 | 单测 `verifyAndRankCandidates` 空 → `quota_no_target` |
| ④ 与手动 CLI 并发 CAS noop | 单测 `commitSuccessfulObservation` stale + `switchAccount` `noop_already_switched`（generation CAS） |
| ⑤ statusline 缓存回写真机对照 | **e2e 真机断言** cache 从新账号刷新 |
| ⑥ CUTOVER 翻转后 Bridge 三面退役 | 单测 `quota-daemon-cutover.test.ts` + `resolveQuotaDaemonBridgeMode` 真值表 + route 410 断言（真机 = 部署期 Bridge 重启，属 §8 上线动作，非 QA 段可安全执行——重启生产 Bridge 需 founder） |
| ⑦ enable 窗口真池 rehearsal | founder-gated 部署动作，非 QA 段 |

## 4. 安全红线核验（plan §5，全部为独立 QA 复核项）

- **R1 active 只读永不 refresh**：pollOnce 对 active 凭证过期/401 一律 `quota_read_blind`，绝不 refresh；`readCandidateCredential(refresh=true)` 只对**非 active** 候选做 `verifyCandidate`。✅
- **R2 零 token 落盘/日志**：state schema 无任何 token 字段（`quota-monitor-state.ts` 逐字核）；alert schema 只有 title/body/signature；e2e 凭证 grep 零命中。✅
- **R3 Keychain/池写全委托既有机制**：`switchAccount → use` + `verifyPoolCredential`；daemon 源码无 `security add-generic-password`。✅
- **R4 preferredOrder absent → 字节不变**：`selectNextAccount` 仅在 `preferredOrder !== undefined` 走新分支；account-store byte-compat 哨兵测试通过。✅
- **R5 default-enable + 三保障**：order 空/损坏 → monitor-only（config fallback 测试）；kill-switch 双侧（setup `--disable` 测试）；无真空切换顺序（§8）。✅
- **R6 恢复扫描只碰高置信 quota_stuck**：`classifyQuotaPane` 需真 cap 句 + idle input + 100% gauge 三条件同时满足；对抗测试（resume-menu/compact/529-echo → other → 零按键）在 `quota-revive-scan.test.ts` 通过。✅
- **R7 例行扫描绝不 probe-refresh**：`sweepCandidates` 调 `readCandidateCredential(refresh=false)`。✅
- **R8 锁纪律**：一致性观察/复核/候选验证在账号锁下取快照；usage 调用与告警发送锁外。✅

## 5. Bridge 退役（cutover）双模式核验

- Legacy 模式（`FLYWHEEL_QUOTA_DAEMON_CUTOVER` 未设）：`resolveQuotaDaemonBridgeMode` 返回全部现行 wiring（attachAccountSwitch/watchdog/route/runnerQuotaScan 按 pool 存在），字节兼容哨兵通过。
- Cutover 模式（=1）：enqueue 不接、route 稳定 410 retired（带认证）、watchdog 跳过、pending 隔离（quarantine 重命名保审计）、runnerQuotaScan 独立构造仅告警。
- **交叉核对**：plugin.ts 中 cutover 模式下 `accountSwitchRepair` 为 undefined，`runnerQuotaScan` 闭包**不再引用** `accountSwitchRepair`（已逐行确认 plugin.ts:8011-8045），不会因退役而崩。✅

## 6. 非阻塞观察（不影响 verdict）

1. **wrapper env 优先级 shell 测试在 runner 宿主机上会假失败** —— 本 runner 宿主导出了生产 `FLYWHEEL_STATE_DIR=/Users/xiaorongli/.flywheel`，wrapper 的 `ENV_FILE` 解析优先用它 → 测试读到生产 `.env`（无 `FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE`）而非 scratch `.env`，得 `from-process|`。这是**宿主环境污染**（既有 `feedback_never_run_provisioning_tests_on_host` 模式），**非代码 bug**：`env -i` 清洁环境（= CI 环境）下 5/5 全过，已验证。建议（可选 follow-up，不阻塞）：测试的 `COMMON_ENV` 显式设 `FLYWHEEL_QUOTA_ENV_FILE`/清空 `FLYWHEEL_STATE_DIR`，让其在 runner 宿主上也稳。
2. **reviveEpoch expiresAt 边界**：若触发窗口 resetAt 在切号时已是过去时刻，`expiresAt=past+30min` 可能 ≤ openedAt，重载时 `parseReviveEpoch` 判为 corrupt → 保守重置（自愈，不发键）。仅在「触发一个已 reset 的窗口」这种异常态出现，自愈可预期，非阻塞。

## 7. 结论

FLY-1256 实现完整、测试充分、安全红线到位；**Issue 硬性要求的「Claude 全员假死独立切号」真机场景已 e2e PASS**。全套单测 + config drift 守卫 + shell 契约（clean env）+ typecheck + lint 全绿。

**QA Verdict: PASS** —— 建议进入 founder 审批 ship 流程（本报告作者作为三段式 ship executor 随即开 approve gate）。
