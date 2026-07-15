# FLY-922 决策 memory — progress ledger

Issue: FLY-922 (https://linear.app/geoforge3d/issue/FLY-922)
日期: 2026-07-06

## 阶段游标

- [x] onboard — 读 memory / CLAUDE.md / spec §3.2
- [x] 审计 codebase — 现有 file-based agent-memory 雏形 + Decision Layer + spec §3.2 + 溯源最早 issue(FLY-52 §3.2 → GEO-149 CIPHER / FLY-65 learning loop / FLY-69 权限解锁)
- [x] brainstorm gate — Round 1 CONFIRMED(理解对;Lead 授权 D+E 我发挥;焊死 founder 硬地板;先跑 deep research)
- [x] exploration.md
- [x] research.md(WebSearch 打底;ChatGPT DR 等 Chrome 空闲 Lead green-light 补跑)
- [x] plan.md(PRD v0.2 — Codex design review 2 轮 APPROVED,8 blocker 全采纳:action-first floor 等)
- [x] 交互 HTML 雏形(annie-review.html;mobile + 每节留言 + JS 导出 + 无-JS 兜底;功能验证过)
- [ ] Lead async 带 Annie review HTML → 按 5 岔口定稿
- [ ] 回填 A/B/C 深化 + F/G
- [ ] 拆 build issue(链回 FLY-65/69/GEO-149)交 Tadashi
- [ ] PR + land

## 关键事实(审计所得)

- **最早构想 = product-experience-spec §3.2**(几个月前已写下学习循环骨架):学习来源/应用/纠正机制/偏离检测/决策权扩展;§3.1 = 当前静态自主性边界表。
- **已有雏形** = `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/`(约 186 文件;feedback 型 120 = 决策语料主体)。格式已含 决策 + Why + How to apply + 判据 + 来源 + [[链接]]。
- **Decision Layer** = Hard Rules → Haiku Triage → Verify → Route(auto_approve / needs_review / pr_handoff)= human-in-the-loop 的强制点,memory 要接进这里。
- **缺口**:passive recall 未接 Decision Layer;无信心/毕业跟踪;无偏离检测;§3.1 表 hard-coded 无解锁机制;跨 Lead 无共享决策层;capture 靠 session 顺手记非系统性。
