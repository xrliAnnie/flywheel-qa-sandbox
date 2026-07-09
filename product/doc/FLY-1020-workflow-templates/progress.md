# FLY-1020 progress ledger

Phase: design (co-eval round 4 — v4 收敛版 published, awaiting Annie 拍板)
Cursor: 4/? (v4 大收敛:固定节点 + loop + skip = 动态,不加节点)

## Chunks
- [done] onboard + 核码(three-stage-phases / three-stage-policy / auto-qa-coordinator / send / gate / phase-orchestrator FLY-939 kickback loop)
- [done] homerail grounding(loop_gateway+skip / inject=消息型 / 无随意加节点 / 模板=YAML / TOML=widget / 无可视编辑器)
- [done] v1(10 节)→ v2(11,7 点)→ v3(12,静态→动态叙事)→ v4(11,大收敛:固定节点+loop+skip,node-inject 降级到不做)
- [done] v4 关键:节点固定动态靠 loop+skip;skip=条件跳节点(product 跳 QA);node-inject 明确不做;YAML 带 skip;纠正 v3 product 独立节点旧框架
- [done] v4 commit(a1706930)+ push + publish(current,v3 作废)+ curl 自验(真 nonce 62f444c8 / 0 残留 / 11 框 / 0 dark / 图+YAML)+ 发 Lead URL
- [wait] Lead QA v4 + relay Annie → 若拍板收敛 → 写 PRD;若还有批注 → v5
- [defer] Codex code review:等设计收敛、写 PRD 前跑
- [next] 收敛 → 写 PRD(exploration/research/plan)→ 拆 build issue 交 Tadashi

## Publish artifacts (current = 最新)
- v4 (current): https://fw-reports-a53de2.vercel.app/r/1078cf1f8b2f8b8ecc31a935080edfb5/ · msg 1524610641002758275
- v3/v2/v1 superseded

## 收敛后的设计(v4,待 Annie 最终拍)
- 固定节点 palette:Design / Implement / QA(每个绑模型 = profile,已有)
- 动态 = loop(重复直到条件,如 qa->implement when fail)+ skip(条件跳节点,如 product 跳 QA)
- YAML 定义『哪些节点/顺序/哪 loop/哪 skip』;无加节点语法
- 裸 session = 不挂 YAML 默认;可覆盖(换模板/调节点/裸兜底)
- MVP:YAML(节点+边+loop+skip)+ profile 复用 + 几套 shipped + 裸默认 + 可覆盖;default-off 字节兼容
- 明确不做:node-inject / fork / 可视化编辑器 / 用户自定义 / 自动学

## Notes
- 遵 Lead steering:不写完整 PRD、不碰 gate、不 ship。PR #514 = co-eval doc 载体不 merge。
- 每轮 co-eval 由 Lead relay Annie 批注触发,非自治 loop。设计已高度收敛,若下轮拍板即进 PRD 阶段。
