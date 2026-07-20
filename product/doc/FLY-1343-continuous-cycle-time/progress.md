# FLY-1343 持续周期时间采集与分析 — 进度账

Issue: FLY-1343 (https://linear.app/geoforge3d/issue/FLY-1343/prdhl-per-issue-cycle-time-持续研究-并发-load-周期时间采集与分析)
日期: 2026-07-17
基于: 无

## 光标

- phase: design (PRD, mockup-first co-eval)
- cursor: 3/5
- next: 等 ① Annie 对样子稿的形状意见(HL publish 后回传) ② Tadashi「为什么长/怎么修」想法(HL 转)→ 到手后 fil/ 迭代 mockup → 形状 OK 才写 prd.md 正文

## 已完成

- [x] onboard:吃透 FLY-1327 采集工具(PR #630 未合)+ 方法学(归段/归类/裁决/七建议映射,第7条=1343)
- [x] brainstorm gate:Honey Lemon PASS,五问全答 + 北极星两层 + mockup-first 流程
- [x] 真机跑 8 张真实 issue(含在跑的 1314)出真实分段:idle_gap 62% 头号瓶颈,verdict=mechanism
- [x] 第一交付物 mockup.html(低保真样子稿·真实数据·4视图)→ 已交 HL 待 publish(ask b6c4c037)
- [x] exploration.md
- [x] research.md(Tadashi 六黑洞 + 3+1 需求已收填 §5;最小集扩 ①②③④,消费者 4→7 张改进单;MVP/演进吸收纪律落地)

## 已交付(补)

- [x] 分支 push 到 origin(HL 急件①,持久化纪律)
- [x] mockup v2:7 框评论层(vA/vB/vC/vD/放哪/诚实边界/总评)+ radio 建/不建/待定 + 复制回传 + sign-off(nonce JS,本地实测交互通过)+ 视图 D 黑洞人话名注解(HL ②③)

## 已交付(补)

- [x] Annie 重心重定向:去诊断化,PRD 主体三章=记录机制/Dashboard/每日报告集成;形状(四视图)她认可
- [x] 核实 daily-digest(FLY-727)dark:代码全建好但 plist 未装、launchctl 无 → 从没真跑
- [x] exploration/research 加重定向注 + research §2.5 每日报告第三条腿现状核实
- [x] **prd.md 写完**(三章 + 数据源 + 成功指标两层 + build issues B1/B2/B3 + 7 消费者)

## 待办

- [ ] Codex design review(prd.md)→ 修 → 交 HL publish 给 Annie lgtm
- [ ] 形状/PRD OK → build issues 拆分交 Tadashi → 开 doc PR
- [ ] prd.md 正文(形状 OK 后)+ Codex design review
- [ ] build issues 末节拆 Tadashi
- [ ] 交 HL(不 publish、不 founder-facing)

## 备注

- stage 上报本时段被 Bridge 瞬断反复 aborted(best-effort,不影响交付)
- 采集工具从 commit f5cf09e8e 抽到 scratchpad 跑(分支 tip 已重组,该 commit 有完整可跑版本)
