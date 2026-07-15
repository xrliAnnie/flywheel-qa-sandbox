# FLY-880 建对内 PM agent — 实施计划

Issue: FLY-880 (https://linear.app/geoforge3d/issue/FLY-880/pmbuild-建对内-pm-agent-协作式产品思考者互动模型-pm-skills-prd-输出按-fly-679-设计)
日期: 2026-07-05
基于: exploration.md, research.md

## 0. 批准状态

brainstorm gate 全通过(2026-07-05):复述 ✓;(1) 扩现有 executor 不新增文件、(2) curated vendor 进 flywheel-skills + 场景→skill 地图 + 去重、(5) PRD repo 内逐版 commit = Tadashi 批;(3) v1 互动走 thread relay、(4) PM issue 单 session + `no-three-stage` label = Annie 批(经 Tadashi relay「OK」)。

**Codex design review:Round 1 APPROVED**(2026-07-05,xhigh;feedback 存档 /tmp/codex-rescue-design-feedback-flywheel-FLY-880-plan-round1.md)。两条非阻断建议均已采纳:① progress.md 与 plan 状态同步(已更新);② 「skill 缺失手动兜底」写进 role .md 本文(已并入 Step 2 第 4 点)。

## 1. Scope 与验收

**建什么**:把 `.flywheel/agents/engineering/product-designer-executor.md` 扩成完整对内 PM agent(FLY-679 互动模型行为规范)+ curate 13 个 PM skill vendor 进 flywheel-skills repo 全机分发 + PRD 输出协议。

**验收(Tadashi 定,5403cd1e)**:真起一个 PM runner,能按互动模型跟 Annie 开工 productization 第一单。

**Out of scope**(exploration §2.3):Product pipeline 形态 / PM 验收 gate(FLY-830)、对外 PM 卫星 bot、Designer role、任何新 Runner↔founder 通道 infra、793 引擎改动。**本仓零 packages 代码改动。**

## 2. 交付物(两仓)

| # | 仓 | 交付物 | 生效方式 |
|---|----|--------|----------|
| 1 | flywheel-skills(canonical `xrliAnnie/flywheel-skills`,本地 `~/Dev/flyview-skills`) | 13 个 vendored PM skill + LICENSE/provenance | Annie 批 → merge → launchd skills-sync → `~/.claude/skills`(hot-load,无需 Bridge 重启) |
| 2 | 本仓 flywheel | role .md 扩写 + 守卫测试 + 本 doc 文件夹 + CLAUDE.md 里程碑 | merge + 生产 `git pull` 即生效(`readAgentFile` spawn 时现读,同 FLY-217 先例) |

## 3. 实施步骤(Implement phase 执行;顺序即依赖序)

### Step 1 — flywheel-skills PR:13 个 PM skill vendor

- **来源与清单**(research §3.1 已定):Lenny 10 个(problem-definition / defining-product-vision / working-backwards / writing-prds / scoping-cutting / prioritizing-roadmap / writing-north-star-metrics / product-taste-intuition / analyzing-user-feedback / dogfooding,取自 [RefoundAI/lenny-skills](https://github.com/RefoundAI/lenny-skills),MIT)+ 官方 3 个(product-brainstorming / user-research-synthesis / competitive-analysis,取自 [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) product-management,vendor 前核对其 LICENSE 条款允许再分发;若不允许 → 该 3 个降级为「plugin 安装指引」写进 role .md,不 vendor)。
- **vendor 纪律**:pin 上游 commit SHA;每 skill SKILL.md 头部加 provenance 注释(source repo / commit / license);LICENSE 文件随目录;放 `skills/generic/` 下(与 repo 现行布局一致,子目录形态以 repo 惯例为准)。
- **description/触发词校对**:逐个核对 13 个 skill 的 frontmatter description 不与本机既有 skill(brainstorm/research/write-plan/minimalist-entrepreneur 系列)抢触发面;必要时改写 description 收窄触发条件(vendor 后允许本地化修改,MIT/署名保留)。
- **过 5 道门 CI**(lint/触发词/shellcheck/blocklist/contract);纯文档型 skill 无 shell,主要过 lint + 触发词 + blocklist。
- **ship 模式** = FLY-510/443 先例:PR 开出 → Annie 批 → Tadashi merge(founder-gated)→ skills-sync 分发(等每日 launchd 或手动跑 `~/.flywheel/bin/skills-sync.sh` 一次)。

### Step 2 — role .md 扩写(本仓唯一实质改动)

文件:`.flywheel/agents/engineering/product-designer-executor.md`(41 行 → 目标 ≤ 250 行,远低于 40k 注入截断线,research §1.1)。结构按 research §5 骨架:

1. **frontmatter**:name/description 更新(体现「对内 PM / 产品共创」);保留 skills:/model: 形态与其他 executor 一致,加一行注释注明 frontmatter 为文档性(runtime 不解析,research §1.1)。
2. **两种触发形态**:A. **产品共创模式**(`product`/`pm` label 或 Lead 指名)= 本次新增主体;B. **文档/设计产出模式**(`doc`/`docs`/`design`/`ux`/`designer`)= 现状行为压缩保留,语义不变。
3. **产品共创模式行为规范**(核心,FLY-679 五条逐条落地):
   - **先摸真实意图**:开工第一轮 `gate question` = 复述理解 + 探意图,不确认不往下拆。
   - **一路来回、不憋 PRD**:小步多轮,每轮 = 本地 research → 一小块 proposal → gate 等回;明令禁止闷头产全量 PRD。
   - **topic 树协议**:大 topic 拆子 topic(树写进 PRD 草稿),一次只钻一个子块、标记当前位置。
   - **探定见协议**:每个子块第一轮固定先问「这块你有定见、还是我发挥?」——有定见 → 对清为止不自作主张;放手 → PM 出方案再回来对。
   - **PRD 协议**:落点 `engineering/doc/<ISSUE>-<slug>/prd.md`(doc-flow 抬头),段落 checklist = problem / users / goals / non-goals / requirements / success metrics / open questions / build issues;逐版 commit,每版 gate 消息附「本版改了什么」;git 历史即收敛轨迹。
   - **拆 issue 协议**:PRD 收敛后用 `create-issue`(team FLY + project Flywheel + 部门 label),列给 Tadashi 兜底;PM 验收 gate 显式标注「未来 FLY-830,现在不做」。
   - **通道说明**:每轮 `gate question` 经 Tadashi relay,FLY-605 兜底 Annie 可直答;禁用 SendMessage(现状规则保留)。
4. **skill 地图**:场景 → 显式 skill 名(research §3.1 的 13 个 + §3.3 已装引用),写明「显式 invoke,不赌自动触发」。**必须含缺失兜底指令**(Codex R1 #2):地图指名的 skill 若本机不可用(两仓时序窗内可能),PM 按地图描述的框架手动照做、并把缺失 skill 报给 Tadashi——不停摆、不静默跳过。
5. **怎么起(给 Lead 的 dispatch 纪律)**:`pm`/`product` label + **`no-three-stage` label**(否则被 793 拆三段,research §1.3);单 session 全程陪跑;模型建议 Fable(高价值 founder 互动),由 dispatch 侧 label/参数定,不在 .md 写死。
6. **边界与现状保留**:不碰 793/pipeline;不写生产代码;CRITICAL rules / Docs & branch / Reporting(`flywheel-comm ask`,禁 SendMessage)全保留。

### Step 3 — 守卫测试(lite,防回归)

`scripts/__tests__/test-pm-executor-contract.sh`(跟 repo 现行 bash harness 形态一致):断言 role .md ① 存在且 < 40k 字符(注入截断红线);② 含关键锚点行(产品共创模式 / no-three-stage / gate question / prd.md);③ B 形态锚点仍在(docs/design 职责未被误删)。约 20 行,不做过度工程(过程轻重按风险分档;40k 截断与误删是真实风险)。

### Step 4 — 硬门与 PR

- 全仓 `pnpm lint`(本仓只有 .md + bash 测试,照跑防漂移)+ 新守卫测试跑绿。
- Codex code review(`codex:rescue`,绝不 raw exec)loop 到 APPROVED。
- 本仓 PR:role .md + 守卫测试 + doc 文件夹;CLAUDE.md 里程碑行 = PR 最后 commit(`feedback_archive_docs_in_main_pr`;doc-flow 文件夹随分支 merge,无状态子目录不挪)。
- flywheel-skills PR 与本仓 PR **并行开、独立 review**;merge 顺序约束见 §5 风险 4。

### Step 5 — QA(QA phase 执行;验收 = Tadashi 5403cd1e)

真机验证,不接受纯读文验收:

1. **前置检查**:`~/.claude/skills` 下 13 个 PM skill 已由 skills-sync 落地(Step 1 merge 后)。
2. **真 dispatch**:建测试 product issue(`pm` + `no-three-stage` label)→ Tadashi/Bridge 正常链路起 PM runner(不走 QA 直起捷径,验证 label 路由 → product-designer .md)。
3. **行为断言**:① 未被拆三段(session 单体,role=main);② PM 第一轮 gate = 复述意图 + 探定见句式;③ gate → relay 链路通(问题到 Tadashi / thread);④ PRD 落点与抬头正确;⑤ skill 地图指名的 skill 能被 invoke(至少验 1 个 vendored skill,如 problem-definition)。
4. **终验** = Annie 亲自跑 productization 第一单(FLY-679 落法:Cass 代班版可对照)——这属于「建成后的使用」,QA 只验 agent 按模型可跑,不替 Annie 拍产品体验。

## 4. TDD 适配说明(诚实边界)

本 issue 交付物是 **prompt/skill 文本 + 另仓 vendored 内容**,本仓无 runtime 代码改动 → 无 vitest 面。「测试先行」落成:Step 3 守卫测试先写锚点断言(RED:现文件无「产品共创」锚点)→ Step 2 扩写(GREEN)→ 收口重构;flywheel-skills 侧 CI 5 道门即硬测试。QA(Step 5)是行为级真机验证。

## 5. 风险与回退

1. **skill 误触发(全机 ambient +13)**:CI 触发词门 + role .md 显式指名策略;真误触 → flywheel-skills 单 PR revert,零 Bridge 影响。
2. **role .md 扩写伤 B 形态**:labels 不动、B 段语义保留 + 守卫测试锚点;回退 = 单文件 git revert。
3. **互动延迟体验**:Annie 已拍接受 v1;实战嫌慢 → 单开通道 issue(role .md 边界注明)。
4. **两仓时序**:role .md skill 地图指名的 skill 若未分发,PM 首跑 invoke 不到 → 约束:**QA Step 5 前置检查硬卡 skills 落地**;本仓 PR 可先 merge(地图指名不存在的 skill 只是暂时空指,PM 有「skill 不在就手动照做」的 generic 兜底),但 QA 必须在 skills 分发后跑。
5. **官方 plugin license 不允许 vendor**:降级路径已在 Step 1 写明(3 个官方 skill 改为安装指引),不阻塞。
6. **`no-three-stage` 纪律靠人**:忘打 label → issue 被拆三段(功能性无害但体验错)。缓解:role .md「怎么起」+ Tadashi 侧知会;结构化方案(issue 类型→pipeline 形态)明确归 FLY-830。

## 6. Implement phase 交接

- 同分支 `flywheel-FLY-880` 接力(三段式共享分支),pin 本 design head。
- Implement 执行 Step 1-4,QA phase 执行 Step 5;flywheel-skills 是另一 repo 的 PR,implement runner 在 `~/Dev/flyview-skills` 按其 worktree 惯例开分支。
- 本 plan 批准即为 Design phase 出口(codex-design-review APPROVED + design_review stage);progress.md 已按 phase 记录光标。
