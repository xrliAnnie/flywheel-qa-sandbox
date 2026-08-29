# FLY-360 — Lead 1M-context rollout runbook

**Issue**: FLY-360
**Date**: 2026-06-19
**Plan**: `doc/engineer/plan/new/v1.51.0-FLY-360-lead-1m-context-tier.md`
**适用**: 把选定 Lead 切到 Opus 4.8 的 1M-context 窗口。

---

## 背景(一句话)

`claude-opus-4-8` 本身就是 1M context、标准定价、**无 per-token 溢价**。Claude Code 默认把有效窗口压到 ~200K;要真用满 1M,Lead 的启动 model id 需为 **`claude-opus-4-8[1m]`**(`[1m]` 是 Claude Code CLI 的窗口选择器,不是另一个 API 模型)。

本 PR 已让 `Opus 4.8 (1M)` 成为 fleet console 的一等可管档(`CLAUDE_TIER_OPTIONS`)。下面是**部署 + 应用**的执行步骤 —— 执行需 Annie 签字(哪些 Lead)+ 重启窗口。

---

## ⚠️ 两次"重启"是不同的东西,别混

| | 重启什么 | 作用 |
|---|---|---|
| **步骤 A** | **Bridge** | 让 fleet console 暴露出新的「Opus 4.8 (1M)」档。**单独重启 Bridge 不会让任何在跑的 Lead 换 model**。 |
| **步骤 B** | **选定的 Lead**(由 Fleet 引擎做) | 真正把那些 Lead 切到 `claude-opus-4-8[1m]` 并生效。 |

---

## 步骤 A — 部署本 PR(重启 Bridge)

1. PR merge 后,生产机 `git -C ~/Dev/flywheel pull`(主仓 main)。
2. `pnpm -r build`(让 teamlead dist 带上新 tier)。
3. **重启 Bridge**(精准杀 run-bridge 进程树,见 MEMORY「停 Bridge bootout 杀错 PID」+「精准杀」纪律;别裸 pattern sweep,别误杀 QA-slot worktree bridge)。
4. 验证:打开 fleet console,Claude 后端 Lead 的 model 下拉里出现「Opus 4.8 (1M)」档。
   - **攒批纪律**:这个 Bridge 重启最省事搭下次 cutover / 别的 Bridge 侧 PR 一起做(MEMORY「多个 Bridge 侧 PR 攒一次重启」)。开跑前先问 team-lead 有没有别的 Bridge PR 在排。

## 步骤 B — 应用 model(Fleet 引擎重启选定 Lead)

> **由 Annie 决定哪些 Lead**(建议见下)。单一真源 = `~/.flywheel/projects.json` 的 `leads[].model`。

经 fleet console(或批准的 `flywheel-fleet.sh` CLI 流程)把选定 Lead 的 model 切到 `Opus 4.8 (1M)`(= `claude-opus-4-8[1m]`)。Fleet 引擎做事务化切换:写 config → 重生 plist → **重启那些被选中的 Lead** 才生效。

验证:被选中的 Lead 重启后,其 pane 顶部 model 显示带 `1m`,且 ctx% 不再频繁逼近压缩/clear。

## 回滚

把该 Lead 的 `model` 清回缺省(account default = ~200K 窗口)→ 经同一 Fleet 流程重启那些 Lead。

---

## 成本 / 速度(给 Annie 签字的依据)

- **美元成本**:Opus 4.8 1M **无 per-token 溢价**(标准 `$5/$25`)。Lead 走 Claude 订阅、非 per-token 计费(CLAUDE.md「Cost tracking: N/A」)→ 真实代价 = **usage-cap(5h/7d 额度)消耗**:context 真变大时每请求 token 更多 → 更快逼近订阅上限。
- **速度**:大 context 单请求延迟略高;prompt caching 对稳定前缀缓解大头。
- **收益**:Lead 常驻长会话,200K 频繁 compact/clear → 丢上下文 + 重读 + 可能加剧 reply malform(FLY-306)。1M 几乎消除反应式压缩。

## 建议哪些 Lead(Annie 拍)

- **全员可上**(无溢价,机制一致)。
- 若要保守分批:**companion(Mufasa / Belle)+ 重 context Lead(cos / eng-lead 等)优先**。
- Codex 后端 Lead(若有)不适用 `--model claude-...`,其 tier 仍是只读 GPT-5,不受影响。
