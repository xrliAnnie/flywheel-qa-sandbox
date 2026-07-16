# FLY-1309 Lead 身份唯一性 — QA 验证报告
Issue: FLY-1309 (双进程互斥 + 同身份并存检测,今晚双 Lead 事故根治)
日期: 2026-07-16
基于: plan.md
阶段: 三段式 QA phase(独立验证 implement 交付,PR #620,head 904f3b9b8)

## 结论

**PASS** —— 三层纵深(lease 互斥 / 检测告警 / 溯源审计)在真机 CLI 打真 DB 的
端到端验证下按设计工作;今晚事故那条「幽灵 Lead 的错误授权指令」在 enforce 下
被结构性拦下且零落库。所有测试绿经突变验证证明非空过;PR head==本地 head,CI 绿。

## 验证方法(不靠「感觉做完了」)

QA 全程遵循本项目铁律:**测试绿 ≠ 证据**。每一条「通过」都配了:
- **阳性对照**(证明 harness 真能产生被测行为,不是参数错误骗过 rc≠0);
- **突变验证**(阉割被测逻辑 → 测试必须变红 → 恢复 → 变绿,证明尺子是好的);
- **main 阴性对照**(可疑失败在无 FLY-1309 代码的 main 上跑,证明与本单无关)。

## 1. 单元/集成测试(RED→GREEN 全绿)

| 套件 | 结果 |
|------|------|
| flywheel-comm: lead-lease / enforce / canonical-lead / carrier-self-check / db-provenance-migration | **61 passed** |
| teamlead: dual-active-scan / bridge-gate / diagnostics / self-check / episode-delivery / queue-order / carrier-evidence-poller / kind-contract | **56 passed** |
| bash: test-lead-identity-preflight.sh(bash 3.2 真机) | **18 passed**(真实 exit 0) |

## 2. 真机 E2E — 重演 2026-07-15/16 事故(隔离 seam,零生产接触)

harness: `scratchpad/qa-s2.sh` + `qa-e2e.sh`,全部经 `FLYWHEEL_LEAD_LEASE_DB` /
`FLYWHEEL_PROJECTS_FILE` / `FLYWHEEL_ALERT_QUEUE_DIR` 等测试 seam 隔离,不碰 `~/.flywheel/` 生产状态。

事故形态精确重建:sup1 起 gen1 bind 到 pane1 → sup1+pane1 死 → **不同的** sup2 接替(gen+1=gen2)
→ 一个仍持 gen1 的「幽灵」进程试图给 runner 发指令。

| 场景 | 期望 | 实测 |
|------|------|------|
| **阳性对照**: gen1 pane 当前代次写入 | ALLOW + 落库 | ✅ 0→1 |
| 接替: sup2 代次自增 | gen1→gen2 | ✅ 1→2 |
| **THE INCIDENT: 幽灵(gen1)发「你的 publish 未经授权」** | enforce 下**拒绝 + 零落库** | ✅ rc≠0, 行数 1→1(未增), stderr 含 `denied` |
| 后继 gen2 继续工作(合法接替零影响) | ALLOW | ✅ 1→2 |
| enforce + **删 lease DB** | 仍拒绝 + 零落库 | ✅(删库≠旁路) |
| enforce + BYPASS=1(救火出口) | 放行 + **响亮**(stderr WARNING + alert-queue 条目) | ✅ |
| audit_only(合入默认) stale 写入 | 放行 + 记 `would_block`(观察窗有真信号) | ✅ |
| mode=off(字节兼容哨兵) | 放行 + 静默(零校验零审计) | ✅ |
| 非 configured 调用者(runner)enforce 下 | 零变化 | ✅ |

**溯源(验收3)**: 落库行携带 `sender_generation` / `sender_holder_pid` / `writer_pid`;
阳性对照行 gen=1、后继行 gen=2 → 跨代可回放审计。`[lead-instruction <id>]` 前缀经
diff 核对为**上下文行未改动**(字节不变红线守住)。

## 3. 突变验证(证明测试不是空过绿)

| 突变 | 位置 | 结果 |
|------|------|------|
| 阉割 enforce 拒绝抛出(`throw LeadLeaseDeniedError` → 提前 return allow) | dist/lead-lease.js | **幽灵指令真的写进了 CommDB(1→2),S2 变红** → 恢复后变绿 ✅ |
| 精确 `--agent` 匹配 → 子串匹配 | lead-dual-active-scan.ts | **runner 的 `--agent-id` 阴性样本被误判,4 测变红** → 恢复后 14 全绿 ✅ |

两个突变各证明:没有 lease 拒绝逻辑,今晚的错误授权指令会照发;没有精确匹配,
runner 会被误报成双活 Lead。测试真的在守这两条线。

## 4. 可疑失败归因(全部经 main 对照证明与 FLY-1309 无关)

全仓并行跑出若干红。逐一用 **main(3d862dea2,无 FLY-1309 代码)对照**判定:

| 失败套件 | 与 FLY-1309 diff 关系 | main 对照 | 判定 |
|---------|---------------------|----------|------|
| ship-eligibility(16) | 未碰(FLY-869) | main 同为 16 failed | pre-existing 本机 env flake |
| codex-lead-runtime(22 单独) | carrier env allowlist 在 diff 内 | main **逐字节相同** 22 failed/92 passed | FLY-350/245 release-gate 缺本机 token,非本单 |
| run-dispatcher(9) | 未碰 | main 同为 9 failed | pre-existing |
| preflight/archive/quarantine/InboxRouter | 部分未碰 | **单独跑全绿** | 仅并行资源竞态,非真 bug |

CI 在 PR head 904f3b9b8 上 **Build & Test pass**(17m26s)印证:这些红只在本机环境出现。

## 5. Lint / 字节兼容

- `biome check` 核心新文件(lead-lease / canonical-lead / dual-active-scan): **0 error**。
- provenance 6 列均为可选/nullable,无 lease env 时零行为变化(mode=off 哨兵实测静默)。
- `[lead-instruction <id>]` 前缀 + runner 回执协议:diff 核对未改动。

## 6. 验收映射复核

| Issue 验收 | 交付 | QA 证据 |
|-----------|------|---------|
| 1 结构性互斥(第二进程拒起/降级只读,绝不发指令) | lease + fail-closed 校验 | §2 幽灵指令拒绝+零落库 + §3 突变 |
| 2 并存检测+告警+标记后起 | dual-active scan | §1 56测 + §3 精确匹配突变 |
| 3 指令可溯源 | CommDB 溯源列 + envelope | §2 sender_generation 跨代 + 前缀字节不变 |
| 4 回归零影响(KeepAlive/resume/合法接替) | 代次+1 接替语义 | §2 后继 gen2 正常 + 非 configured 零变化 + audit_only 默认 |

## 遗留 / 边界(设计已声明,非缺陷)

- enforce 翻转是 ship checklist 显式项(Ship §6),需 Tier-3 重启后 readiness proof 硬门;
  合入默认 audit_only = 零行为变化。**本 QA 验的是逻辑正确性,非生产 enforce 翻转**
  (那是 ship 环节,需 founder gate + 24h 观察窗)。
- terminal-mcp send-keys 旁路 / Codex lead backend / per-Lead credential = 设计声明的 v1 范围外 follow-up。
