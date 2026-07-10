# FLY-1089 建 PM + Prototype 两个 executor 角色 — 调研

Issue: FLY-1089 (https://linear.app/geoforge3d/issue/FLY-1089/建-pm-prototype-两个-executor-角色-三条流里剩下的两条fly-1059-只做了-designer)
日期: 2026-07-09
基于: exploration.md

---

本篇只回答一个问题:**要落地这两个角色,运行时到底给了我什么、限制我什么。**
每条结论都在代码里核过,附文件行号。

## 1. agent.md 是怎么进 Runner 的

`Blueprint.ts` 的 `readAgentFile()` 把文件**正文逐字**塞进 Runner 的 system prompt:

```ts
agentContent.slice(0, 40_000)          // Blueprint.ts:1637
domainContent.slice(0, 10_000)         // Blueprint.ts:1647
```

结论:

- **40 000 是字符不是字节**,超出**静默截断**(不报错)。所以守卫测试必须卡住这条红线。
- **frontmatter 不被解析** —— `model:` / `skills:` / `permissionMode:` 全是文档性的。
  真实来源:model 走 `dispatch label > roles.<role>.model > env`;skill 是整机环境自带;
  permissionMode 运行时硬编码 `bypassPermissions`。
  (FLY-880 / FLY-1059 的 role .md 里已有这段注释,本 issue 复核无误,照抄进新文件。)

**推论**:这两个角色是**提示词**,不是运行时代码。没有 vitest 面可测,守卫只能是
「文件存在 + 不超 40k + 流程锚点没被静默删掉」这一层 —— 正是 `test-pm-executor-contract.sh`
的形态。

## 2. label 怎么路由到 agent —— 顺序敏感,标签必须互斥

`AgentDispatcher.dispatch()`(`AgentDispatcher.ts`):

```ts
this.entries = Object.entries(agents);   // ← YAML 里的书写顺序
// Step 2a: 先在 issue 的 owningDept 作用域内找,首个 label 命中即返回
// Step 2b: 再退到顶层 catch-all(agent_file 直接在 .flywheel/agents/ 下)
// Step 3 : shipped-generic 兜底
```

关键事实:**首个命中即返回,遍历顺序 = YAML 书写顺序。**

- 如果两个 agent 的 `match.labels` 有交集,谁在 YAML 里靠前谁赢 —— 一个隐式、脆弱的耦合。
- 反过来,**只要标签集两两不相交,单-label issue 的路由就与书写顺序无关**。⚠️ 但这**只保证
  「一个 label 只属于一个 agent」**;一个 issue 若**同时带两个 executor-family label**(如
  `pm` + `prototype`)仍是 first-match(YAML 顺序)—— 前提是「一 issue 一 executor-family label」。
  真正的多-label ambiguity 拒绝 = 引擎 follow-up,不在本 config-only scope。

**本 issue 必须守住的不变式:`engineer` / `qa` / `product-designer` / `designer` / `pm` /
`prototype` 六个 agent 的标签集两两不相交。** 这是可测的,写进 dispatch 测试。

### 2a. `departments` 双注册(FLY-901)

Step 2a 里:

```ts
const depts = registeredDepts(cfg);
if (!depts || !depts.includes(owningDept)) continue;
```

- 默认 dept 从 `agent_file` 路径推(`.flywheel/agents/engineering/x.md` → `engineering`)。
- `departments: [engineering, product]` 让同一个文件**额外注册**到 `product` 部门。
- Honey Lemon(产品线 Lead)派发时 `owningDept=product`。**新的 `pm` / `prototype` 不双注册,
  她的自动派发就够不着,会掉进 shipped-generic。** 这是必须做的,不是可选优化。

## 3. 三段式(three-stage)会不会把单 session 切碎

`three-stage-policy.ts` 的决策顺序:

```
1. FLYWHEEL_THREE_STAGE=0        → OFF(全局 kill-switch)
2. Linear `no-three-stage` label → OFF(per-issue override)   ← 行 54, 68
3. pipeline.three_stage === true → ON,但还要过 three_stage_channels 白名单
4. 其余                          → OFF
```

flywheel 项目当前 `.flywheel/config.yaml`:

```yaml
pipeline:
  three_stage: true
  three_stage_channels: ["1516209714097291335"]   # #flywheel-engineer
```

`resolveThreeStageEntry()` 还有一道:**只有 `requestRole === "main"` 的全新派发才可能进三段式**。

**两层保护,都已存在,一行代码不用加**:

1. 白名单把入口限死在 `#flywheel-engineer` —— **Honey Lemon 从产品频道派的 PM / Prototype
   天然不进三段式**(`dispatchChannelId` 不在白名单 → fail-close 单 session)。
2. 万一是 Tadashi 从工程频道派的,`no-three-stage` label 是 per-issue 硬 override。

所以「一个工种 = 一个 session」靠**纪律 + 既有机制**成立。结构化的 `issue-type → pipeline`
映射是 **FLY-830**,本 issue 不做(与 FLY-880 的边界声明一致)。

> ⚠️ 但这层保护是**配置态**的,不是代码强制的:`three_stage_channels` 一旦被删或加进产品频道,
> PM/Prototype 从工程频道派就会被切成三段。所以 role .md 里的「派我时带 `no-three-stage`」
> 必须写成硬规则,并被守卫测试断言 —— 这正是 FLY-880 已经做的,照做。

## 4. founder 交互只有一条物理通道

Runner **物理上发不了 Discord**。可用的只有注入进 prompt 的 gate 指令:

| 原语 | 行为 | 用在哪 |
|---|---|---|
| `flywheel-comm gate question` | **阻塞**,等到 Lead / founder 回答才返回 | co-eval / 挑方向 / 判可行性 —— 每一轮 = 一次 gate |
| `flywheel-comm ask` | **非阻塞**,发出去就返回;plain ask 的回复**不会推 mailbox 唤醒** | DONE 回报、非阻塞提问(要自己轮询 `check`) |
| `flywheel-comm gate brainstorm` | 阻塞,理解确认 | 开工前 |

**这两个原语混淆过一次**(FLY-880 的 Codex R1 抓到),所以守卫测试里同时断言了
「BLOCKING gate」和「non-blocking ask」两侧文字。新角色沿用。

兜底:gate 挂 ~10 分钟没人答,FLY-605 会把问题 + `@founder` 直接贴进 `[FLY-XX]` thread,
Annie 可以直接答。所以**不要冻住,也不要刷屏**。

gate 消息里**不能有反引号**(zsh 命令替换会吞掉 code token,FLY-372)—— 用「」标字面量。

## 5. founder 物料只能由 Lead 投递

`publish-report` 支持 `--channel`,但项目铁律(FLY-1048 教训,记忆里两条 feedback):

- Runner **建** HTML → `publish-report` **不带 `--channel`** → 拿到 URL → 经 `ask` 交 Lead;
- **Lead 出唯一一张卡**。Runner 直投会和 Lead 的官方卡撞在一起,Annie 会混。

PM 流的「出 explainer HTML」这一步,和 Designer 流的 A/B/C 方向卡,走的是同一条规矩。

CSP 会拒内联 JS,交互式 HTML 要做静态版。样式走 `~/.claude/rules/html-report-style.md`
(Apple 风浅色主题)。

## 6. skill 可用性 —— 实测,不靠猜

`~/.claude/skills/` 实测(2026-07-09):

| skill | 在哪 |
|---|---|
| `writing-prds` `problem-definition` `product-brainstorming` `working-backwards` `scoping-cutting` `prioritizing-roadmap` `writing-north-star-metrics` `product-taste-intuition` `defining-product-vision` `analyzing-user-feedback` `synthesize-research` `competitive-analysis` `dogfooding` | ✅ `~/.claude/skills/`(FLY-880 时还是 0/13,现已全部落地) |
| `proofshot` `founder-html-delivery` `deep-research` `last30days` | ✅ `~/.claude/skills/` |
| `mvp` `validate-idea` `processize` `pricing` `minimalist-review` | ✅ plugin `marketplaces/minimalist-entrepreneur/skills/` |
| `frontend-design` | ✅ plugin `cache/claude-plugins-official/` |
| `dataviz` `mermaid` `artifact-design` | ✅ 内置 / 本地命令 |
| `codex-image` `gemini-image` | ✅(Designer 用;Prototype 一般用不上) |

结论:两个新角色要引用的 skill **全部可用**。但 skill 分发是异步的(launchd `skills-sync.sh`),
所以 role .md 里必须保留 **skill-missing fallback** 条款:缺 skill 不停摆,手工照做同样流程、
保住同样的产出契约、并报 Lead。

## 7. Prototype 该用什么 skill —— 现有资产映射

Prototype 流是「定要验证什么 → 搭最便宜的真原型 → 跑给 founder 体验 → 能做/不能做」。
现成 skill 里正好有一条与之同构的方法论(minimalist-entrepreneur):

| Prototype 步骤 | 现成 skill |
|---|---|
| 1 定要验证什么(把「想做 X」翻成一条可证伪的假设) | `problem-definition`、`validate-idea` |
| 2 搭最便宜的真原型(手工先于自动,能不写代码就不写) | `processize`(manual-first)、`mvp`(最小切片)、`scoping-cutting` |
| 2' 真要写一点代码时 | `frontend-design`(界面壳)、`superpowers:test-driven-development`(只在原型需要被信任时) |
| 3 跑给 founder 体验 | `proofshot`(截真运行界面)、`founder-html-delivery`(托管 URL 交 Lead) |
| 4 判定 + 交接 | `minimalist-review`(决策 gut-check)、`create-issue`(能做 → 拆 productionize issue) |

**「最便宜的真原型」的排序**(写进 role .md,防止 Runner 一上来就写生产代码):
手工跑一遍(processize) → 一次性脚本 → 静态假界面 + 假数据 → 打通一条真链路的最小切片。
**能停在前一档就绝不进下一档。**

## 8. Prototype 与 Designer 的边界(Annie 明确要求写死)

| | Designer(FLY-1059) | Prototype(本 issue) |
|---|---|---|
| 问的问题 | 「**长什么样**才好用?」 | 「这事**做不做得成**?」 |
| 产出 | 视觉方向 A/B/C → 高保真 mock + 一页 spec | 可行性验证原型 + 一份**能做 / 不能做**的判定 |
| 保真度 | 视觉高保真、功能假 | 功能真(哪怕只有一条链路)、视觉可以很丑 |
| 代码 | 不写生产代码 | 写**一次性**代码,**不是生产级** |
| 终局 | 交工程做进真产品 | 能做 → 交工程 productionize;**不能做 → drop**(drop 是合法且成功的结局) |

「drop 也是成功」这条必须写进 role .md —— 否则 Runner 会为了「有产出」硬把不可行的东西
做成半成品(这是最贵的失败模式)。

## 9. 已知风险

| 风险 | 说明 | 处理 |
|---|---|---|
| 标签重划打断存量 issue | 现存 `product` / `pm` issue 会改路由到 `pm-executor` | 内容等价 + 补两步,不退化;dispatch 测试断言新映射 |
| 与 FLY-1059 的 PR 顺序耦合 | 本分支叠在 #527 上;#527 若被大改,本 PR 要重做 rebase | Lead 已拍板顺序,#527 已 Annie lgtm 只等亲批 |
| `product-designer` 抽掉 Mode A 后名字不再贴切 | 它只剩 doc/docs/design/ux | **不改名**(scope discipline);在文件头写清它现在是什么 |
| 守卫测试是文本断言,可被绕过 | 改文字就能「修」测试 | 断言选**流程语义锚点**(如「有定见」「drop」「BLOCKING gate」),删掉它们等于删掉契约 |
