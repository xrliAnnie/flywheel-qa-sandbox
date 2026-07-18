# FLY-1326 Superpowers vs mattpocock/skills — 探索/框定

Issue: FLY-1326 (https://linear.app/geoforge3d/issue/FLY-1326/research-mattpocockskills-能否取代-superpowers-系统减重盘点-依赖-blast-radius)
日期: 2026-07-16
基于: 无(本文件夹起点)

---

## 1. 这个 issue 在问什么

Annie(2026-07-17,#flywheel-product)在提示词/技能瘦身线(FLY-1260/1299)里提的一问:

> 「是不是应该把 Superpowers 拿掉?它可能让我们的系统变得有点太重。想看 Matt 的 skill
> 是不是可以取代 Superpowers,让系统整体更轻量。」

Matt 的 skill = [mattpocock/skills](https://github.com/mattpocock/skills)(Matt Pocock,MIT)。

**核心痛点 = 「重」。** 所以这份 intel 的第一要务不是罗列功能,而是把「重」量化到 token,
再把「拿掉 Superpowers 要动多少东西(blast radius)」测准 —— 这两条决定 Annie 能不能安心做取舍。

## 2. 铁律(继承 FLY-1260,Annie 自己立的)

**没有评测数据,不改任何生产提示词/skill。** 本单 = 纯 intel + 对照矩阵 + 选项,零生产变更:
不卸载 Superpowers、不安装 Matt 的、不动任何 hook/rule。真正的「换不换」由 FLY-1299 的 A/B
拿数据定。本文档**不下「该换」的结论** —— Annie + 数据定。

## 3. 交付边界(brainstorm gate 已与 Lead HL 锁定)

- **我(runner)只写 intel markdown** 交 HL;**HTML 由 HL 产、由 HL 投** founder-facing(single-owner)。
  runner 不发 founder-facing、不 publish。
- 文档走 doc-flow **full**:本文件夹下 `exploration.md` + `research.md` + `plan.md`。
  - `exploration.md`(本文件)= 框定 + 范围决定 + 假设 + 方法纪律。
  - `research.md` = 核心 intel:盘点×2 + blast-radius 清单 + 对照矩阵 + 减重账(交付主体)。
  - `plan.md` = 三臂方案(喂 FLY-1299)+ 采纳路径(vendor 进 FLY-216)+ 交接。

## 4. 范围决定(scoping 纪律 — 每一行都要能改变决策)

Lead HL 在 brainstorm gate 拍的两条,直接决定矩阵形状:

1. **对照矩阵的行 = 只有 Superpowers 的 14 个 skill**(它才是「拿掉候选」,决策只需要它)。
   **不反向盘 Matt 的 22 个 shipped skill 对我们库的覆盖** —— 那对「能不能拿掉 Superpowers」
   这个决策没贡献,纯增重。
2. **矩阵的列 = 3 列**:① Matt 有没有 **model 可达**的等价物(有/半/无 —— **user-invoked 的不算**,
   headless runner 够不着)② 我们自己库(FLY-216 库 + PM skill)有没有已经重复
   ③ **静态接线(引用证据)**。
   ⚠️ **v4 更正**:③ 原写「我们实际用不用」= overclaim —— prompt 引用只证明**静态接线**,
   **不证明 runtime 真 invoke**(真实使用率需 session telemetry = **UNKNOWN**)。以 research.md 为准。

## 5. 假设(显式列出,不默默填坑)

- **A1**(v2 修正后证实但需细化):「重」主要来自 Superpowers 的 SessionStart **hook 注入**。
  ⚠️ v1 把「库=按需加载=完全不占常驻」当成了全部事实 —— **不对**:装上 plugin 后,
  **model-invoked skill 的 name+description 会常驻**在 skill 列表里(否则模型不知道它们存在)。
  所以「常驻成本 = hook 注入 + catalog metadata」,两边都要算。见 research.md §减重账(v2)。
- **A2**:token 用**实测**(真跑 tokenizer),不估算。tokenizer = `tiktoken cl100k_base`;byte 数是
  ground truth,token 数**始终标注为 cl100k proxy** —— **不是 Claude 实际计费 token**
  (Claude tokenizer 不公开),不假装精确。
- **A3**(v2 更正 —— v1 此处自相矛盾:同句写「13 个」又写「实测 14 个」):issue 原文说的
  「13 个 PM skill」是**约数**;**实测**我们全局库 `~/.claude/skills/` 里 product/PM 那组 =
  **14 个**(analyzing-user-feedback、competitive-analysis、defining-product-vision、dogfooding、
  prioritizing-roadmap、problem-definition、product-brainstorming、product-taste-intuition、
  scoping-cutting、synthesize-research、working-backwards、writing-north-star-metrics、
  writing-prds + deep-research)。**以实测 14 为准**,不沿用 issue 的约数。
- **A4**:blast radius 只算**生产运行时**真读到的文件(runner spawn prompt / lead rules / dispatcher /
  blueprint / hook),不算历史 changelog、archived doc、或**本 issue 自己注入的 context**(那是
  self-reference,不是依赖 —— 见方法纪律)。

## 6. 方法纪律(同一把尺 + 阳性对照,防「标签当事实」)

- **同一把尺**:对 Matt 的和对 Superpowers 都读真文件、都跑同一个 tokenizer;不对一边宽一边严。
- **阳性对照(尺子没坏的证明)**:所有「引用 0 次 / 没有 / 干净」的结论,先跑一个**已知会命中**的
  grep(如 `brainstorm`/`Runner`)证明 grep 在同一批目录上工作正常,再报 0。否则一个坏掉的 glob
  会给出假 0(本单实测撞到一次:zsh 吞了未加引号的 `--include=*.ts` → 假「no matches」,加引号重跑)。
- 🔴 **但阳性对照不够(v4 血泪补充)**:它只证明**尺子没坏**,**不证明你量对了东西**。
  本单真实翻车:我搜插件名 `superpowers` 得到「`.flywheel/agents/` 零耦合」,而真实耦合是**裸 skill 名**
  (`brainstorming`)—— 我的阳性对照 `grep brainstorm` **恰恰命中了那个文件**,我却把它读成
  「grep 正常」而没问「Superpowers 的 skill 名怎么会在部门角色里」。**反证就在我自己的输出里。**
  ⇒ **查询语义完整性**必须单独检查:搜一个东西的**名字**,和搜它的**所有入口**(namespace、
  别名、14 个裸 skill 名),是两回事。
- **self-reference 排除**:`.claude/skills/{flywheel-git-workflow,flywheel-escalation,linear-issue-context}`
  里出现 "Superpowers" 是**本 issue 标题/正文被注入**进 runner context 的结果,不是系统依赖,不计入
  blast radius。
- **查不到 = 标 UNKNOWN**,不脑补。

## 7. 下游

- research.md → plan.md → 交 HL 做 co-eval HTML → 喂 FLY-1299 A/B。
- 关联:FLY-1260(框架,Done)· FLY-1299(A/B 执行,本单喂它)· FLY-217(Superpowers 接入史 =
  blast radius 起点)· FLY-216(技能库 = 采纳路径)· FLY-1199(Charlie Hills 目录,同类先例)。
