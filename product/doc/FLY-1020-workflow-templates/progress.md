# FLY-1020 progress ledger

Phase: design (co-eval round 3 — v3 published, awaiting Annie 批注)
Cursor: 3/? (v3 叙事升级:静态 DAG → 动态 DAG)

## Chunks
- [done] onboard + 核码现状(three-stage-phases / three-stage-policy / auto-qa-coordinator / send / gate / phase-orchestrator kickback loop)
- [done] homerail grounding(FLY-1004:loop_gateway / inject=消息型 / 无随意加节点 / 模板=YAML / TOML=widget非模板 / 无可视编辑器)
- [done] v1(10 节)→ v2(11 节,7 点)→ v3(12 节,叙事升级静态→动态 DAG)
- [done] v3 关键:QA↔implement loop 已硬编码进三段式(FLY-939 kickback)= loop 需求铁证;loop=MVP 原语;node-inject 可能永不做;YAML DSL 采纳(修正 v2)
- [done] v3 commit(56129aac)+ push + publish(current,v2 作废)+ curl 自验(真 nonce 04e8870d / 0 残留 / 12 框 / 0 dark / YAML block)+ 发 Lead URL
- [wait] Lead QA v3 + relay Annie → 第 3 轮 co-eval → v4 / 收敛
- [defer] Codex code review:等设计收敛、写 PRD 前跑
- [next] 收敛 → 写 PRD(exploration/research/plan)→ 拆 build issue 交 Tadashi

## Publish artifacts (current = 最新)
- v3 (current): https://fw-reports-a53de2.vercel.app/r/05621e609a56d9465a879ab6a46ef385/ · msg 1524609062019268728
- v2 (superseded): https://fw-reports-a53de2.vercel.app/r/9e57c3c4c37f9d962cc7874dea691460/
- v1 (superseded): https://fw-reports-a53de2.vercel.app/r/e3429790d8aaa798a17c1bd2a82fefa3/

## MVP 方向(v3 待 Annie 拍)
- 轻 YAML 模板(节点+边+loop)+ 几套 shipped(eng 三段式带 QA loop / product 短无 QA)+ profile 复用 + QA 变模板节点 + 裸 session 默认 + 可覆盖;default-off 字节兼容
- Later: fork ; 可能永不做: node-inject / 可视化编辑器 / 用户自定义 / 自动学

## Notes
- 遵 Lead steering:不写完整 PRD、不碰 gate、不 ship。PR #514 = co-eval doc 载体不 merge。
- 每轮 co-eval 由 Lead relay Annie 批注触发,非自治 loop。
