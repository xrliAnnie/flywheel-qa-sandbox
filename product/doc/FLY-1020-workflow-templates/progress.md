# FLY-1020 progress ledger

Phase: design (co-eval round 5 — v5 published, 大概率定稿, awaiting Annie 拍板)
Cursor: 5/? (v5 两层定义 + 节点类型可扩展)

## Chunks
- [done] onboard + 核码(three-stage-phases / three-stage-policy / auto-qa-coordinator / send / gate / phase-orchestrator FLY-939 kickback loop / skills 目录)
- [done] homerail grounding(loop_gateway+skip / inject=消息型 / 无随意加节点 / 模板=YAML)
- [done] v1→v2→v3(静态→动态)→v4(固定节点+loop+skip)→v5(节点类型 per-category 可扩展 + node-inject/fork 用例 + ⭐⭐ 两层定义)
- [done] v5 关键:两层定义(YAML 形状 + 节点类型注册表 行为=泛化 three-stage-phases.ts);节点类型 per-category 可扩展(注册表加,非跑中 inject);node-inject/fork=现在不做+用例
- [done] v5 commit(ba569b30)+ push + publish(current,v4 作废)+ curl 自验(真 nonce 87f67892 / 0 残留 / 10 框 / 0 dark / 两层+YAML)+ 发 Lead URL
- [wait] Lead QA v5 + relay Annie → 若拍板『收敛,写 PRD』→ 进 PRD 阶段;若还有批注 → v6
- [defer] Codex code review:等设计收敛、写 PRD 前跑
- [next] 收敛 → 写 PRD(exploration/research/plan)→ 拆 build issue 交 Tadashi

## Publish artifacts (current = 最新)
- v5 (current): https://fw-reports-a53de2.vercel.app/r/96d1f6b97b3cc50675b048c489da6c1c/ · msg 1524613571328344106
- v4/v3/v2/v1 superseded

## 收敛后的设计(v5,大概率定稿,待 Annie 拍)
- 两层定义:①YAML=DAG 形状(节点/顺序/loop/skip 按名引用)②节点类型注册表=每节点行为(prompt+skills+model)=泛化 three-stage-phases.ts
- 节点类型 per-category + 可扩展(注册表加新类型,跑中不 inject);eng=Design/Implement/QA、创作视频=Research/生成视频
- 动态 = loop(重复到条件)+ skip(条件跳节点);裸 session=不挂 YAML 默认;可覆盖
- MVP:两层定义 + loop + skip + profile 复用 + 几套 shipped + 裸默认 + 可覆盖;default-off 字节兼容
- 现在不做(留用例):node-inject(跑中加新步骤如安全审计)/ fork(并行 A/B);不做:编辑器/自定义/自动学

## Notes
- 遵 Lead steering:不写完整 PRD、不碰 gate、不 ship。PR #514=co-eval doc 载体不 merge。
- 之前 node-inject 不做/可能不做冲突(Q 704cfacb)已由 Annie 定为『现在不做+用例』,moot。
- 每轮 co-eval 由 Lead relay Annie 触发,非自治 loop。设计高度收敛,拍板即进 PRD 阶段。
