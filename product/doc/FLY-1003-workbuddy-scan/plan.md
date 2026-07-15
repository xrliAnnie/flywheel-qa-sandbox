# FLY-1003 WorkBuddy 竞品分析 — 实施计划

Issue: FLY-1003 (https://linear.app/geoforge3d/issue/FLY-1003/workbuddy-竞品分析-腾讯-workbuddy-vs-flywheel-competitor-scan)
日期: 2026-07-08
基于: research.md

> 这是文档活(竞品情报),不碰技术实现。产出 = 一份深挖 deepdive + 折进 FLY-909 competitor-scan + FLY-911 影响评估的轻改。**目标形态与 matrix/paperclip deepdive 一致。**

---

## 交付物清单(3 个文件改动 + 1 个 Lead 回报)

### D1 — 新建 `product/doc/FLY-909-competitor-scan/workbuddy-deepdive.md`(主交付)
放 FLY-909 文件夹,跟 matrix/paperclip deepdive 并列(Lead 已批)。**严格照 matrix-deepdive.md 模板**。**用证据分级 inline 标(【官方】/【媒体】/【分析】/【评测】/【⚠️存疑】)**,高影响事实必须逐条标 provenance:
- 抬头 3 行(Issue FLY-1003 / 日期 / 基于:FLY-1003 research.md)+ 为什么挖它 + 资料来源诚实声明(含证据分级说明)。
- 一句话定位(verbatim,腾讯官方口径)/ **目标用户(官方逐字 "one-person company / freelancers / small team leaders" + 电商选品/落地页/客服场景 —— 正面撞我们 beachhead,别淡化)** / 产品形态(桌面+9 渠道 IM 双形态;持久性 = 官方只证「个性化记忆」,daemon 说法标【⚠️存疑】)/ 公司背景+体量(13M DAU 等标【⚠️非独立审计】)/ onboarding / 亮点 feature / **腾讯三剑客分工辨析(CodeBuddy=建软件给开发者·QClaw=真 OpenClaw 衍生·WorkBuddy=办公含 development 角色,关键 nuance)** / 已知软肋 / 定价(标区间⚠️)。
- 「跟 Flywheel:像谁 / 不一样」= research.md §2 的逐轴诚实对比表(哪几轴站/塌;**目标用户已降级⚠️、领域收窄为「长期 ownership lifecycle」、Push 拆两半**)。
- 值得借鉴(from WorkBuddy):多 agent 并行拆解 / 100+ 专家角色即 onboarding / sandbox 隔离 / 免费档+50GB / **别学**:红海无差异化 + 腾讯生态锁定。
- 一句话差异化**候选**(收窄后,给 Annie 挑;措辞用「当前最像还站得住的候选差异」不写「收敛到 X 条」定论口气)。
- 大厂威胁形态段(research.md §3,含 substitution path)。

### D2 — 编辑 `product/doc/FLY-909-competitor-scan/competitor-scan.md`(折进)
- **横切表 A(①)加 WorkBuddy 一行**:定位一句话 / **目标用户(一人公司/个体创业者/自由职业者/小团队负责人 + 白领/企业;与 beachhead 正面重叠)** / **形态(桌面 + 官方 9 个 IM 渠道;媒体说 12+ 标差异)** / **非技术体验(电商选品/落地页/IM 客服都很贴,但缺长期 ownership lifecycle)** / 定价(区间⚠️)。加 🆕 标记,插在合适位置(大厂档,靠近 Cowork/Codex)。
- **表下「观察」note 补一句**:大厂(腾讯)已正面覆盖多条候选形态差异(IM/多模型/个性化记忆/多 agent)**且官方直接打一人公司/自由职业者**,「靠单点形态差异化 + 靠目标用户差异化」两条路都被堵。
- **新增 ⑧ 节「WorkBuddy(腾讯)—— 最强的大厂威胁」**(镜像 ⑥ Cowork/Codex、⑦ OpenClaw 的写法):逐轴站/塌(**目标用户降级⚠️、Push 拆两半、领域收窄为长期 ownership lifecycle**)+ 供应商中立&手机IM&目标用户 显式退出/降级 + 大厂威胁形态(含 substitution path)+ 「没到取代」的诚实另一半。
- **「跟谁像/差异候选」总结节补 WorkBuddy**:当前最像还站得住的候选差异 = 长期 ownership lifecycle(给非技术 operator)+ 被协调组织自推进 backlog(措辞用「候选」不用「收敛到 X 条」)。
- **开放问题(喂 911)**可选补一条:面对 WorkBuddy 这种带分发、且官方已打一人公司的大厂办公 agent,产品化速度 + 长期 ownership 专注是防线 —— 押不押、怎么讲,911 拍。

### D3 — 轻改 `product/doc/FLY-911-product-positioning/positioning.md`(Lead 已批「视结论轻改竞品表+诚实边界」)
**最小、显式标注 FLY-1003 fold,不动 §0 主线/§1 beachhead/§2 主差异段/§3 支柱/§4 信任:**
- **§5 竞品表加 WorkBuddy 一行**:「最强大厂威胁 · 覆盖面+目标都撞(官方打一人公司/自由职业者+电商选品/落地页/客服)· 活着的候选差异 = 长期拥有并演进一套软件/业务系统的 lifecycle」。
- **§7 诚实边界补**:(a)手机 IM + 供应商中立经 WorkBuddy 正面覆盖退出差异清单;(b)目标用户不再是差异(官方打一人公司/自由职业者);(c)活着的 Push 只剩「自发起 backlog 分诊+跨 Lead 协调+持续 ownership」半,「记忆+IM 后台派发/回报」半已商品化(「always-on daemon」存疑,别据此强断);(d)当前最像还站得住的候选差异 = 长期 ownership lifecycle + 被协调组织自推进 backlog,**均写「候选/待 911」,更窄、靠速度守**。**不用「收敛到 X 条」定论口气,不动主线。**

### D4 — 结论回报 Lead(Lead 点名:哪几轴站/塌 + 大厂威胁形态)
写完后 `flywheel-comm ask` 把结论发 Lead,Lead surface Annie。

---

## 顺序 & 校验
1. D1 deepdive → 2. D2 competitor-scan 折进 → 3. D3 positioning 轻改 → 4. 通读一致性(口径/术语/无反引号问题)→ 5. commit → PR → approve gate → D4 回报。
- **口径校验**:定位大结论不硬下(全写候选/待 911);诚实、UNKNOWN 标 ⚠️;不美化腾讯口径。
- **一致性**:三份文件对「站/塌」的判定一致;术语跟 FLY-909/911 一致(done-for-you / 被协调组织 / 结果证明)。

## 不做(scope 纪律)
- 不做 PM 验收(= 未来 FLY-830)。
- 不改 FLY-911 定位主线/beachhead/支柱/信任(那是 Annie 的,只轻改竞品表+诚实边界)。
- 不建 HTML 交互工件(除非 Lead/Annie 另要;本 issue 交付是 deepdive+折进+影响评估)。
- 不自 merge(founder-gated,PR 给 Annie review)。

## 风险
- ⚠️ 官网挡爬 → 已多源拼 + 标 ⚠️;若 Annie 要一手交互事实,Deep Research 复核为可选后续,不阻塞。
- ⚠️ 轻改 positioning.md(别的 issue 的 v1-final 文档)—— 已 Lead 批 + 最小化 + 显式标注,可轻易 revert。
