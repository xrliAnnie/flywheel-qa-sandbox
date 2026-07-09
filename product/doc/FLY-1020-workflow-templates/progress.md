# FLY-1020 progress ledger

Phase: design (co-eval round 6 — v6 published, 大概率定稿, awaiting Annie 拍板)
Cursor: 6/? (v6 三层定义 + inject/fork=roadmap)

## Chunks
- [done] onboard + 核码(three-stage-phases / three-stage-policy / auto-qa-coordinator / send / gate / phase-orchestrator FLY-939 / ~/.claude/commands Markdown skills)
- [done] homerail grounding(loop_gateway+skip / inject=消息型 / 无随意加节点 / 模板=YAML)
- [done] v1→v2→v3(静态→动态)→v4(固定节点+loop+skip)→v5(节点类型可扩展+两层定义)→v6(三层定义+inject/fork=roadmap)
- [done] v6 关键:三层定义(YAML 形状 + 注册表 技能/模型 + Markdown 步骤『今天这套不变』)+ 打消『YAML 重写 brainstorm』误解;inject/fork=roadmap(post-MVP,非不做)
- [done] v6 commit(ed519d4b)+ push + publish(current,v5 作废)+ curl 自验(真 nonce 2c025046 / 0 残留 / 10 框 / 0 dark / 三层 block)+ 发 Lead URL(Lead 等 v6 才 relay Annie)
- [wait] Lead QA v6 + relay Annie → 若拍板『收敛,写 PRD』→ 进 PRD 阶段;若还有批注 → v7
- [defer] Codex code review:等设计收敛、写 PRD 前跑
- [next] 收敛 → 写 1020 PRD(exploration/research/plan 三件套)→ 拆 build issue 交 Tadashi

## Publish artifacts (current = 最新)
- v6 (current): https://fw-reports-a53de2.vercel.app/r/bdcfb9ead0683e0c75c05cf6a0554443/ · msg 1524618828896796802
- v5/v4/v3/v2/v1 superseded

## 收敛后的设计(v6,大概率定稿,待 Annie 拍)
- 三层:①YAML=DAG 形状(节点/顺序/loop/skip 按名引用)②注册表=每节点带哪些技能+模型(泛化 three-stage-phases.ts)③Markdown=每技能怎么做(今天这套,不变)
- 关键:YAML+注册表=加在现有 Markdown 之上的编排层、不替代;打消『YAML 重写 brainstorm/research』误解
- 节点类型 per-category 可扩展(注册表加,跑中不 inject);动态=loop+skip;裸 session=不挂 YAML 默认;可覆盖
- MVP:新增上两层 + loop + skip + profile 复用 + 几套 shipped + 裸默认 + 可覆盖;第三层 Markdown 不动;default-off 字节兼容
- roadmap(post-MVP,进后续 PRD):node-inject / fork(留用例)。不做:编辑器/自定义/自动学

## Notes
- 遵 Lead steering:不写完整 PRD、不碰 gate、不 ship。PR #514=co-eval doc 载体不 merge。
- 每轮 co-eval 由 Lead relay Annie 触发,非自治 loop。设计高度收敛,Lead 判『这版对了大概率就定』→ 拍板即进 PRD 阶段。
