# FLY-1160 常驻 Claude Session 语音大脑 — QA 报告（Phase A）

Issue: FLY-1160 (https://linear.app/geoforge3d/issue/FLY-1160)
日期: 2026-07-11
基于: plan.md / exploration.md / research.md + 实现 commit（本分支 flywheel-FLY-1160）

## 0. 判定：PASS（Phase A 组件 milestone）

本 PR (#550) = **Phase A only** —— voice-core 常驻脑组件 + BrainPort + cli.ts 两阶段
shutdown 装配，落 main、默认 OFF。plan §4.3 明确「**Phase A 合入只是组件 milestone，
不结单**」。/glaw(FLY-545) 与 /eleven(FLY-1006) 的接线 + issue §6 的三项真机验收
（≥3 轮不掉线 / 主动断连恢复 / 纪要真落 thread）属 **Phase B/C，在各自分支，不在本 PR**。
本分支尚无任何语音命令消费常驻脑，故 /glaw+/eleven 真机 E2E **不能也不该在此处跑**。
→ 本 QA 只对 Phase A 交付物负责；FLY-1160 **不因本 PR 关单**。

## 1. 静态与单测（全绿）

| 项 | 结果 |
|----|------|
| voice-core 单测 | 301 passed / 4 skipped（skip=RESIDENT_SPIKE 门控真 CLI） |
| voice-bridge 单测 | 322 passed |
| voice-headphone 单测（本 PR 亦碰 null-audio-io.ts） | 54 passed |
| typecheck（voice-core + voice-bridge） | 0 error |
| CI（PR head 1f4a8b35） | Build & Test **pass**（run 29143221761 success, 13m42s） |

**lint 澄清**：本地 `pnpm lint` 报 3 error + warnings，但 3 个 error 全是**未被 git 追踪**
的 `.flywheel/runs/*.json` 运行时产物（`git check-ignore` 命中、`git ls-files` 空）——
CI 干净 checkout 里不存在。用 `git archive HEAD` 模拟 CI 干净树跑 `biome check .` =
**exit 0**（0 error，仅剩 pre-existing teamlead 侧 warning，与本 PR 无关）。→ **CI lint 会过**。

## 2. Phase A 真机验证（RESIDENT_SPIKE=1，真 claude 2.1.207 / sonnet）

issue 根治点（每轮冷启动 = 慢 + 卡死 → 常驻 session 根治）在真二进制上验证，全 PASS：

| 场景 | 结果 | 直接证明 |
|------|------|----------|
| multi-turn on ONE pid + 会内记忆 + 零每轮 spawn | ✅ 8.76s | 消灭 per-turn 冷启动（FLY-1158 根因）+ 记忆连贯 |
| in-band interrupt：轮干净取消、进程存活、下轮正常 | ✅ 13.0s | barge-in 语义（中断白名单 error_during_execution） |
| mid-turn SIGKILL → respond 抛错 → --resume 重生 → 记忆完好 | ✅ 15.5s | 崩溃恢复 + 会话续接（spike 未覆盖的补测） |

byte-compat 哨兵（daemon-brain-port.test）全绿：
- 无 brain 配置 → /health JSON key 集不变、无 brain listener、clean close
- port 配了但 token env 未设 → BrainPort **不启动**（半配置 = OFF loud）
- Phase-2 teardown 失败 → 永不跳过 Phase 3（Codex #550 R1）
- port + token → Bearer 门控 /brain/health 401→200，close 后端口下线

cli.ts 两阶段 shutdown 装配核对 = 匹配 plan §3.3：Phase 1 flip shuttingDown + BrainPort
503；Phase 2 AbortController **真取消**（非停等）+ 有界预算 Promise.race；Phase 3 `finally`
不可跳过收尸（brainPort.close → manager.closeAll，逐 PID 确认 exit）。

## 3. QA 补充（已提交本分支）

### 3.1 新增真 CLI manager 收尸测试 `resident-manager.smoke.test.ts`
现有真 CLI 冒烟只驱动 `ResidentClaudeBrain` **直连**；plan §3.2 的「谁 spawn 谁收尸」
铁律（= FLY-1148 孤儿 claude 进程 load 事故那一类）此前**只在 fake 进程上验过**。补测在
**真进程**上闭合此缺口：经 manager open 2 个真 claude 子进程（各自独立 PID）→ 证全局硬
上限 fail-loud（第 3 个 open 抛 `resource-exhausted`，绝无静默第 3 次 spawn）→ closeAll()
后两 PID **确认死亡、零孤儿**。open() 只 spawn 不发 turn ⇒ **零模型消耗**。真 CLI **PASS
（3.12s）**；未设 RESIDENT_SPIKE 时正确 skip。所有 QA 跑完 `ps` 复查 = **无孤儿进程**。

### 3.2 清除 2 处失效 lint 抑制
`stream-parse.ts:38` 与 `resident-brain.test.ts:569` 的 `// biome-ignore
lint/suspicious/noExplicitAny`——`biome.json` 里该规则 `"noExplicitAny": "off"` 全仓关闭，
故这两注释是 `suppressions/unused` warning（本 PR 引入）。删除 100% 安全（`any` 本就被
配置允许），删后 voice 文件全部 lint-clean。

## 4. 结论与遗留

- **Phase A：PASS。** 组件正确、真机验证到位、默认 OFF 字节兼容，安全落 main。
- **FLY-1160 未完成**：Phase B（/glaw §4.1）+ Phase C（/eleven §4.2）接线 + 两条真机
  QA（≥3 轮 / 主动断连恢复 / 纪要真落 thread）+ 跨分支整体验证仍待做（plan §4.3 完成门）。
  B/C 归属由 Lead 调度（545/1006 在飞 Runner 或本 issue 续跑）。
- 无阻塞项、无 kickback。
