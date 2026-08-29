# FLY-914 可交互 HTML 审阅件(Google Doc 式行内评论)— PRD

Issue: FLY-914 (https://linear.app/geoforge3d/issue/FLY-914/interactive-html-review-artifact-google-doc-style-inline-comments)
日期: 2026-07-06
基于: 无(本 issue 直接产出)

> 本 PRD 逐版收敛(Mode A 产品共创),git 历史即收敛轨迹。每版 commit 注明「本版改了什么」。**未标「已定」的都是草案,等对齐。**

---

## Topic tree(收敛进度,★=当前)

- [x] Round 1 意图 + topic 树 对齐
- [x] 1 批注创作 Authoring — **Annie 真机翻案 → 定 A(点段落→底部评论条)**;B 进 backlog
- [x] 2 回流 Round-trip — **Annie 拍板改简:剪贴板复制(段落原文+评论 配对)**,不做 relay(原 R-B/FLY-931 → backlog)
- [x] 4 托管 — **已定:留 Vercel + 放开 CSP(nonce)**;不选 Claude Artifacts(登录摩擦)。CSP 前提已实证
- [x] Codex Artifact 竞品研究(`research-codex-artifact.md`)
- [~] 3 渲染 Rendering — 方向清晰(Apple 浅色、段落块 = A 锚点)
- [~] 5 多轮 / 状态 — 方向清晰(open/addressed + 重发带旧批注)
- [ ] 6 拆 build issues → Tadashi(等 Honey 绿灯)★ ;A 原型已 self-QA,live URL 等 CSP 放开(build#1)

---

## Problem

Annie 越来越多在**手机**上审阅交付物(PRD、竞品扫描、mockup、plan)。现状是 Lead/runner 把结论堆成**大段 Discord 文字**,她只能整段读、整段回 —— 无法「在恰好相关的那一段旁边」留反馈。反馈与上下文脱节,来回成本高,手机上尤其难。

## Users

- **主要用户 = Annie(founder / 审阅者)**:手机为主,要在交付物上就地留评论,像 Google Doc。
- **次要用户 = 发起的 Lead / runner(交付方)**:把交付物渲成可交互 HTML 发出,收回 Annie 的行内评论,据此改。
- 全局能力:任何 Flywheel 项目的任何 Lead/runner 都能调用(全局 skill)。

## Goals

1. Annie 能在手机上打开一份交付物 HTML,**就地留段落级评论**(Google Doc 直觉,拇指顺)。
2. 这些行内评论能**批量、结构化地回流**到发起的 Lead/runner(且回到 Discord thread,保持 Discord 当 hub)。
3. 渲染任意交付物一致、Apple 浅色。
4. 做成**可复用全局 skill**;托管必须**允许交互(JS 能跑)**(见 §4 CSP 前提)。
5. 成为默认协作形式(Annie:「以后我们都会倾向于用这种形式来合作」)。

## 竞品 / 定位(详见 `research-codex-artifact.md`)

对标 Codex Canvas / Claude Artifacts:三点结论 —— ①artifact 有 JS 运行时是**行业标配**(佐证 §4 H1 放开 JS 只是拉到常规线);②我们的差异化 = **去 App 化**(Discord + 手机 + 可批注,评论回 Discord thread,竞品都绑自家 App 做不到);③段落级评论在手机比词级更稳更省(佐证 §1 A)。

## Non-goals(每加一项必砍一项)

- ✂ 不做实时协同光标 / 多人在线编辑(只做异步审阅+评论)。
- ✂ 不做 dark mode —— 固定 Apple 浅色(Honey 明确)。
- ✂ 不做富文本编辑交付物本身(HTML 只读渲染 + 评论层)。
- ✂ MVP 不做词级『划词』(= 旧方案 B,Annie 真机验证别扭)→ 进 backlog『词级精度进阶』。
- ✂ **v1 回流不做 serverless relay / 自动发回 Discord** —— 只做剪贴板复制(Annie 明确要;自动回流 = FLY-931 backlog)。
- ✂ 回流不另建评论/dashboard 系统。
- ✂ 不新造 Runner↔founder 通道(复用 gate/relay + FLY-605 兜底)。
- ✂ PM 验收流程 = 未来 FLY-830,本 issue 不做。

---

## Requirements

### 1. 批注创作 Authoring —【已定:A 点段落 → 底部评论条】

**决策轨迹**:v1 我推荐 A;Annie 想试 B(划词词级),要求真机;我做了真机可交互 B 原型(`mockups/authoring-v2-interactive.html`,本地验证选择/手柄/托盘/结构化发送全通);**Annie 真机试完亲验 B 划词在手机上别扭 → 翻回 A**。便宜验证(真原型)一次定案。

- **选择模型 = 点段落**:点任意段落 → 整段浅黄高亮(像 Google Doc 选中)→ 底部滑出评论条。锚点 = **整段**(内容小改也不漂,最稳、拇指最顺、工程小)。
- **评论**:写完 → **保存到页内托盘**(不即时发)。已有评论的段落右上角显示计数角标,点段落 = 看该段已有批注 + 编辑/删除 + 加新。
**粒度(Annie 拍板)= v1 只做整段点(甲)**:她真机后问过能否给『段里某一句』或『跨两段』留 comment,但最终拍板 **v1 只做段落级、别做进 v1**;句级/跨段 = **backlog(finer granularity 以后再加)**。保持 v1 最简、拇指最顺。

**真机反馈已改**:①保存后评论框**自动收起**②回流改成 **『复制全部批注』**(每条=段落原文全文+评论 配对,一键复制到剪贴板+成功反馈,不走 relay —— Annie 明确要的,见 §2)。同 URL 重部署。

**finer granularity(句级/跨段)= backlog**,不进 v1。原型 `authoring-v2-interactive.html`(点句+两手柄)代码可复用作以后的精确选择。

**真机可交互原型**:`mockups/authoring-A-interactive.html`(A 版 v2,self-QA)。本地端到端 QA 全过 + 公网 URL 实测非死页:点段→评论框+高亮 → 写+保存(自动收起)→ 托盘计数+角标 → 同段多条 → 编辑/删除 → **复制全部批注**(段落原文全文+评论 配对到剪贴板)。复制内容已 node 验证(配对、非整页)。**注:交互原型只在放开 CSP 的托管上真跑;fw-reports 上因 CSP 是死页。** demo(no-CSP Vercel):https://fly914-review-demo.vercel.app/

### 2. 回流 Round-trip —【Annie 拍板改简:复制到剪贴板(段落原文+评论 配对)】

**Annie 明确要简化**(她原话):「我不需要发送,我需要的只是留完 comments 之后,有个地方能把所有留的 comments 连原文段落一起 copy 出来给你。」→ **不要『发送回 Discord』那套 relay**,只要一个『复制全部批注』按钮把 **段落原文 + 评论** 配对复制,她粘给发起方。

**语义 = 批量 + 配对复制**:
- 页内评论**累积托盘**(可编辑/删除);
- 全部留完 → **『复制全部批注』**一键复制到剪贴板 + 明确复制成功反馈;
- 复制内容 = 每条『**评论的那段原文全文 + 评论**』配对(**不只 anchor→comment**)→ 发起方粘上即有完整上下文,不用查 anchor 映射。

**产物形态(纯文本,人可读)**:
```
FLY-914 批注 · <artifact> · 共 N 条

1. 原文:<段落原文全文>
   批注:<评论>
...
```

**基建 = 零后端(v1)**:纯浏览器 `navigator.clipboard` 复制,**不需要 serverless relay、不需要 CSP connect-src、不需要签名回传**。大幅简化(少一个 serverless、少一层安全面)。
- **自动回流(serverless relay → Discord thread)= backlog**(原 R-B / FLY-931 降级;以后要「一键自动发回」再做,含 Discord-hub / token / rate-limit / origin allowlist)。
- localStorage 换设备丢的问题在 v1 不成红线(她当场复制粘贴,不依赖本地持久)。

**为什么这样对(真实数据点)**:①Annie 试 relay 版『全部发送』点了没反应(relay 没建)→ 她说根本不需要发送,只要能干净 copy 出来;②FLY-915 静态版的『复制模板』她也用不顺、又 copy 整页 → 关键不是「有没有复制按钮」,而是**复制出来的就是干净的 段落原文+评论 配对**(不是整页、不用她拼锚点)。这就是本 feature 的存在理由。

### 3. 渲染 Rendering —【方向清晰】

Apple 浅色统一模板(`~/.claude/rules/html-report-style.md` 基调);把任意交付物内容渲成**可点选的段落块**(A 的锚点粒度 = 段落,渲染只需给每段一个稳定 id,不需词级 token 化,大幅简化)。

### 4. 托管 + 调用 Hosting / invocation —【已定:留 Vercel + 放开 CSP(nonce)】

**⚠️ 实证结论(FLY-915 真机发现 + 我 curl 已发布 URL 复验)**:现有 `publish-report` / fw-reports 托管在页面注入
```
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
```
`default-src 'none'` + 无 `script-src` → **浏览器拒绝执行内联 JS**。后果:交互页样式能显示,但**所有交互全废,打的字存不住导不出** —— 这正是 Annie「导出批注拿不到、只能整页复制」的**真根因**。**原型本地(无 CSP)全通,证明 UX 对;唯一拦路 = 托管 CSP。**(Annie 真机点 v2 没反应 = 此故障的用户侧复现。)

**决策(Annie 拍板『vercel it is』)= 留 Vercel、给交互页放开 CSP**:
- **不选 Claude Artifacts 当永久家** —— 它能跑 JS 但要登录(手机摩擦)+ 绑 Claude auth(以后走 Codex 就废)。
- **托管是我们自己的、CSP 我们设的** → 给这类交互 review 页放开 `script-src`,用**基于 nonce/hash 的白名单**(只放行本页自带脚本,不整个 `unsafe-inline`,保安全)。Cass 确认原则可行、是常规做法(claude.ai/Codex artifact 都允许页内 JS)。
  - **关卡①(拆单前必过)= ✅ Cass 已给全架构方向**:静态 report 严格 CSP **一字不动**;交互 artifact 走一条**显式 opt-in 的 publish 模式/flag**(宽 CSP 绝不泄漏到普通报告);`connect-src` **写死具体 relay origin、禁用 `*`**(防 exfiltrate);nonce = 发布时 crypto 随机/每页一个/绝不复用,script 绝不 `unsafe-inline`;relay HTTPS-only+token+rate-limit+origin allowlist。「新 flag」vs「report-registry 加可选 nonce」= code 结构,**Tadashi 定**(他 owns 那块代码 + 安全 posture)。(我的 demo 用独立 no-CSP Vercel 证明 JS 在 Vercel 能跑;production 走 report 路径注 nonce。)
- **v1 简化(Annie 改复制)**:v1 回流 = 剪贴板复制,页面**不 POST 到任何 endpoint** → **CSP 不需要 `connect-src`**,只需 `nonce` 的 `script-src` 让复制 JS 能跑(`default-src 'none'; script-src 'nonce-X'; style-src 'unsafe-inline'; img-src data:;`)。上面 关卡① 里的 `connect-src <relay origin>` 是**自动回流(backlog)**才需要,v1 不用。
- **安全 posture**:CSP 放开由 Tadashi 落地时签(nonce 生成方式)。

**调用**:全局 skill,Lead/runner 一条命令把交付物 → 交互审阅件 → Vercel(放开 CSP)→ 一条 Discord 消息给 Annie(发**对应 issue thread**,不发 core/general)。
**打开**:Annie 点 Discord 链接,手机上真能点。

### 5. 多轮 / 状态 Threading & resolve —【方向清晰】

- 评论状态:open / 已处理(addressed)。
- 多轮:发起方按批注改完 → 重发一版 artifact,旧批注随段落 id 带过来标「已处理/未处理」。锚点 = 段落 id,较稳(比词级偏移易迁移)。

### 6. 安全约束 —【Annie 定】

- **页里不放任何 secret**:不嵌 token / 密码 / 客户 PII。正常业务内容(如 email 地址)OK。
- **签名回传防伪 = backlog**(随自动回流 relay 一起做):v1 走剪贴板复制、无 relay、无服务端接收 → 无伪造回传的攻击面,v1 不需要签名。等以后做自动回流(FLY-931 backlog)再加 submit_token/HMAC。
- **MVP 安全姿态足够** = 公开 + **不可猜 URL**(复用 publish-report 的 token 路径)+ 签名回传 + 不放 secret。**登录 later**(与多人/隐私一起做,不在 v1)。

---

## Success metrics —【草案,待 writing-north-star-metrics 收敛】

- North Star 候选:**Annie 手机上的行内批注占她全部审阅反馈的比例**(替代大段 Discord 文字的程度)。
- 辅助:交付物发出→Annie 留完批注的时延;发起方「无需追问即可照批注改」的比例;回流成功率(发送的批注真回到 thread 的比例)。

## Open questions(收敛后剩余)

- ~~托管 H1/H2~~ → 已定 留 Vercel + nonce CSP。
- ~~relay 落点~~ → 已定 独立 serverless(非 Bridge ingress)。
- 段落 id 在重发时如何稳定映射(多轮批注迁移)?← 块5,细节,不阻塞 v1 拆分。
- Annie 真机手感终验 = 等 build#1 CSP 放开后,把 A 原型发 Vercel(可跑)→ 914 thread → 她真机试。

## Build issues —【✅ 已 file(Annie green-light 2026-07-06),team FLY / project Flywheel / label Flywheel / parent FLY-914 / High】

实现 = Tadashi 队列。**v1 = 段落级 + 剪贴板复制回流;ship 仍 founder-gated。**
> **⚠️ Annie 又简化了 round-trip(2026-07-06)= 剪贴板复制,不做 serverless relay。** PRD §2 已更新;**已 file 的 Linear issue 待 Annie 试顺后再调整**(FLY-931 降级 backlog、FLY-932 改『复制全部配对』)—— 按 Honey 指示等 demo 确认再动 filed issue,避免反复。
1. **FLY-930 [infra] 交互 artifact 托管:Vercel 放开 CSP(显式 opt-in nonce)** —— 头号前提,阻塞 932。**v1 CSP 无需 connect-src(复制不 POST)。**
2. **FLY-931 [infra] 自动回流 relay → backlog** —— v1 改剪贴板复制、不做;以后要「一键自动发回 Discord」再做。
3. **FLY-932 [skill] 交互审阅件渲染 + A 批注 UI(段落级)+ 复制全部批注** —— blockedBy 930;点段→评论框→托盘→**复制全部批注(段落原文全文+评论 配对到剪贴板)**;UX 基准 = self-QA 的 `mockups/authoring-A-interactive.html`。
4. **FLY-933 [skill] 全局调用入口** —— blockedBy 930/932。
5. **(backlog)** finer granularity(句级/跨段/划选);自动回流 relay(FLY-931);多轮批注迁移/状态。

PM 验收 = 未来 FLY-830,现在不做。
