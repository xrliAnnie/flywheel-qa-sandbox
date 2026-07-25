# FLY-1463 Ship-gate 交付 interactive ship-report HTML — 探索

Issue: FLY-1463 (https://linear.app/geoforge3d/issue/FLY-1463/机制founder-可见-ship-gate-交付-interactive-ship-report-html-qa-pass-时随-gate)
日期: 2026-07-24
基于: 无

## 1. 问题(Annie 直令 2026-07-24)

design 阶段有设计 HTML,但 **ship gate 冒出来时没有一份"总账"**。Annie 每次要拍板 ship/不 ship,都得在 thread 里追着 Lead 问:这个怎么修的?QA 怎么测的?有没有 e2e?——今天一上午就是活证明。她要的是:**gate 冒出来的同一时刻,手里就有一份一页看清全貌、能直接在页面上拍板的 interactive HTML**。

## 2. 机制定位(照 FLY-1461 同招)

FLY-1461(#699,2026-07-24 merge)刚验证过这个机制模式:**硬规则写进 runtime-loaded 的 QA executor role .md(`.flywheel/agents/engineering/qa-executor.md`),QA Runner 自持有,不依赖 Lead 的概率性记忆;CI 守卫(grep sentinel + 40k byte budget)防规则被静默删掉;不加引擎门**(引擎不阻塞 PASS,Annie 铁律:不加 feature flag / 不加 engine gate)。

本 issue 完全复用这个模式:**QA runner 发 PASS verdict 的同时,必须产出并 publish 一份 ship-report HTML 到该 issue thread**。PASS 时刻 = ship gate 冒出时刻,所以 gate 和 HTML 永远一起到 Annie 面前。没发 = QA 未完(跟 529 N-to-N 一条待遇)。

### 为什么是 QA runner 写(issue 原文,审计确认成立)

QA runner 是 gate 前最后一棒,手里同时有:PR diff(怎么修)、全部测试证据(测了什么)、529 thread link + GIF(E2E 铁证)。一个作者一页讲清。审计确认:auto-QA 的 `QaContext` 注入了 `parentIssueIdentifier` / `prNumber` / `branch` / `prHeadSha`(`auto-qa-coordinator.ts:1230`),QA worktree 里能读到 PR diff 和实现方的 plan 文档——内容来源全部在手。

## 3. 代码库审计发现(设计的硬约束)

### 3.1 时序:PASS 之后 QA runner 会被立刻清理 → HTML 必须在 PASS **之前** publish

`auto-qa-coordinator.ts` `onQaResult`(pass 分支,~line 1486):

```
qa-result pass → notifyShipReady(发 founder ship-ready 卡到 parent issue thread)
              → safeStampIssueStage(parent, "approve")(⏳待批 badge)
              → closeQaRunner(自动清理 QA runner:cmux + tmux + Terminal tab)
```

**发出 pass 后 QA runner 随时会被杀**。所以规则的硬时序是:**先 publish ship-report → 再 emit `qa-result --status pass`**。这个顺序同时天然保证 HTML 落在 thread 里的位置就在 ship-ready 卡之前——"一起到"不需要任何引擎协调。

### 3.2 投递缺口:QA runner 今天**够不着** parent issue thread

- `publish-report` → Bridge `/api/reports/deliver` 只认 raw `channelId`,不传就落到项目 `generalChannel`(`reports-route.ts:370-381`)——发 core channel 违反 `feedback_founder_html_into_thread_not_core`。
- `QaContext` 给了 `parentIssueIdentifier`,**没有** thread id;thread 映射在 StateStore `chat_threads`(`UNIQUE(issue_id, channel_id)`,FLY-270 canonical key),只有 Bridge 侧能查(`getChatThreadByIssue`,`notifyShipReady` 的实现走的就是它)。
- `/api/chat-threads/send` 能按 `issueIdentifier` 解析 thread,但要 `channelId + leadId`(runner 没有)、只发纯文本(没有截图卡)、还挂在 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` flag 后面。

→ 需要一个**极小的加法性投递管道**:`publish-report --issue <FLY-XX>` → `/api/reports/deliver` 服务端解析 parent issue thread(复用 `/chat-threads/send` 的 identifier→UUID→`getChatThreadByIssue` 解析链)。这是 delivery plumbing(跟 FLY-203 publish-report 本身同类),**不是 engine gate**——引擎从不因为"没发 HTML"阻塞 PASS。诚实声明:这一点超出了 FLY-1461"纯 .md 改动"的形态,是本 issue 与 1461 的唯一结构性差异,理由在 research.md 里逐项对比过替代方案。

### 3.3 CSP 与 hosted 页面的物理能力(决定交互方案)

`report-registry.ts`:hosted 页面 CSP = `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:;`

- **内联 JS 可用**(FLY-930 nonce 机制 live):源 HTML 写 `<script nonce="__CSP_NONCE__">` + `addEventListener`(inline onclick 不被 nonce 覆盖,禁用)。留言框 / 勾选 / localStorage 暂存 / 一键复制都真能跑(FLY-349 copy-button 已在 Annie 真机验收过)。
- **没有 `connect-src`** → hosted 页面上任何 `fetch()`/XHR 都被 CSP 封死;且 Bridge 只监听 localhost,Annie 手机根本连不到。**"HTML 里点一下直接回传到 Lead"在当前物理层不存在**,除非新建公网回传端点(Vercel function + 轮询,或暴露 Bridge)——新 infra + 鉴权面,v1 不做。
- **`img-src data:`** → 截图/GIF 只能以 data URI 内嵌,外链图片(Discord CDN)会被 CSP 拦。
- **512KB 上限**:`MAX_HTML_SIZE = 512KiB`(publish-report 与 Bridge `/api/reports/publish` 双侧同 cap)→ GIF 内嵌必须预算化,mermaid.js 整库内嵌(~2.5MB)直接出局。

### 3.4 Mermaid:authoring 用 Mermaid,hosting 端预渲染成 SVG

issue 里"hosted HTML 原生支持 mermaid"指的是 claude.ai Artifact;**fw-reports hosted 页面没有原生 mermaid**(CSP + 无外链 JS + 512KB 都不允许运行时渲染)。方案:QA runner 写 Mermaid 源码 → 生成时本地预渲染成 **inline SVG**(本机 `mermaid` skill / mmdc;fallback 输出 PNG data URI)。Annie 拿到的仍是她要的"多张 mermaid 图",且零运行时依赖、手机秒开。

## 4. 交互回传方案(issue 点名 design 阶段定)

**v1 = 结构化 copy-export(推荐,零新 infra,已被 Annie 真机验收过的模式)**:

- 逐段 inline 留言框(FLY-353/1045 标准:每个 section 正下方一个 `.cbox`,不堆页尾)+ localStorage 自动暂存。
- 页顶/页尾 **ship 裁决区**:单选 ✅ Ship / ❌ 不 ship(+说明框)——对齐 `feedback_annie_signs_off_on_html_not_chat`(收口动作发生在 HTML 上)。
- 一键复制按钮输出**机器可解析的 markdown payload**(`SHIP-VERDICT: yes|no` + `## <section-key>` 分段)→ Annie 粘回**同一个 issue thread**(gate 卡就在那,一步之遥)→ Lead/runner 按 section-key 定位区域;`SHIP-VERDICT: no` = 打回信号。
- 验收 ①(comment 可定位区域)② (不 ship 信号可达)由此闭环;真·callback 端点列为 v2 follow-up(需要 connect-src + 公网端点 + 鉴权设计,单独立项)。

## 5. 与既有规矩的冲突消解

`feedback_runner_no_direct_founder_publish` / `feedback_founder_artifacts_lead_only_delivery`(Tadashi 2026-07-09):founder 物料默认 Lead 出。**本 issue 是 Annie 2026-07-24 直令,明确点名 QA runner 产出并 publish 到 issue thread**——正因为 Lead 投递是概率性的(FLY-1461 同一教训),这份"总账"要的就是确定性时序。所以:ship-report 这一种 artifact 类型由 QA runner 直发 issue thread,是对旧默认的**显式豁免**(写进 qa-executor.md,义务与授权同一处);其他 founder 物料仍走 Lead。

## 6. 排除的方向(和为什么)

| 方向 | 为什么不 |
|------|---------|
| 引擎 gate(Bridge 校验"没 HTML 不放 gate") | Annie 铁律:照 1461 同招,不加引擎门;引擎阻塞会把 HTML 故障升级成 ship 停摆 |
| Lead 在 gate 时刻代发 | Lead 记忆概率性 = 本 issue 要治的病本身 |
| notifyShipReady 卡片内嵌 HTML url(引擎拼) | 引擎要等/找 runner 的产物 → 引入耦合与阻塞路径,违背"引擎不管 HTML" |
| 运行时 mermaid.js(CDN 或内嵌) | CDN=外链依赖+供应链面;内嵌 2.5MB 爆 512KB cap |
| 真·callback 端点(v1) | 无 connect-src、Bridge 不公网、需新建鉴权面;copy-export 已满足验收 ①② |
| spawn 时把 thread id 注进 QA prompt | thread 可能在 spawn→PASS 之间被归档重建,快照会 stale;deliver 时服务端现查更稳 |

## 7. 下一步

research.md:逐项核对 512KB 预算切分、mermaid 预渲染工具链在 runner 环境的可用性、`--issue` 解析链的复用点、CI 守卫断言清单、模板文件放置点(40k md budget 装不下整套 HTML 模板 → 模板落 repo 文件,md 只放指针+自查清单)。
