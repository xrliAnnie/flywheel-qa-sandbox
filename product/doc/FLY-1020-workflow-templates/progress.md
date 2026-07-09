# FLY-1020 progress ledger

Phase: design (co-eval round 2 — v2 published, awaiting Annie 批注)
Cursor: 2/? (v2 折进 Annie 第 1 轮 co-eval)

## Chunks
- [done] onboard + 核码现状(three-stage-phases.ts / three-stage-policy.ts / PipelineConfig / AgentDispatcher / auto-qa-coordinator.ts / send.ts / gate.ts)
- [done] homerail grounding(FLY-1004 homerail-code-report:inject=消息型 / fork=checkpoint / loop=loop_gateway / 模板=YAML / TOML=widget非模板 / 无可视编辑器)
- [done] design HTML v1(10 节)→ publish → Lead QA 过 → relay Annie → 收到 7 点 co-eval
- [done] design HTML v2(11 节)折进 7 点:三段式=eng 主线 / auto-QA 头号动机 / inject 两分 / inject·fork·loop 三分 / 裸session默认 / DSL·编辑器澄清 / Later
- [done] v2 commit(395a5cec)+ push + publish(current 链接,v1 作废)+ curl 自验(真 nonce 4ab8c58e / 0 残留 / 11 框 / 0 dark / 0 外链)+ 发 Lead URL
- [wait] Lead QA v2 + relay Annie → Annie 第 2 轮 co-eval 批注 → v3 / 收敛
- [defer] Codex code review:等设计收敛、写 PRD 前跑(FLY-827 硬门只挡 merge,我们不 merge)
- [next] 收敛 → 写 PRD(exploration/research/plan)→ 拆 build issue 交 Tadashi

## Publish artifacts
- v2 (current): https://fw-reports-a53de2.vercel.app/r/9e57c3c4c37f9d962cc7874dea691460/  · msg 1524588540065878187
- v1 (superseded): https://fw-reports-a53de2.vercel.app/r/e3429790d8aaa798a17c1bd2a82fefa3/

## Notes
- 遵 Lead steering:不写完整 PRD、不碰 gate、不 ship。PR #514 = co-eval doc 载体(同 353 #511),不 merge。
- 红线:轻/可覆盖/非死板。MVP = 裸session默认 + per-category 模板 opt-in(eng 三段式+product 短)+ profile 复用 + QA变模板节点;inject/fork/loop 留 Annie 拍 Later;DSL/编辑器 不做。
- Loop 停:每轮 co-eval 由 Lead relay Annie 批注触发,非自治 loop。
