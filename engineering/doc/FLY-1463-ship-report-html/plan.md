# FLY-1463 Ship-gate 交付 interactive ship-report HTML — 实施计划

Issue: FLY-1463 (https://linear.app/geoforge3d/issue/FLY-1463/机制founder-可见-ship-gate-交付-interactive-ship-report-html-qa-pass-时随-gate)
日期: 2026-07-24
基于: research.md

> **2026-08-09 更正:** 本计划记录当时方案；其 HTML ship / 不 ship 裁决及 `SHIP-VERDICT` 回传设计已废止。现行批准只认 ship 卡片上的 founder ✅ reaction 或卡片 thread 内 founder 直接回复。

## 0. 一句话

QA runner 在发 `qa-result --status pass` **之前**,必须产出并 publish 一份 founder 语言的 interactive ship-report HTML 到 parent issue thread(gate 冒出的地方)——机制照 FLY-1461:义务写进 `.flywheel/agents/engineering/qa-executor.md` 自持有 + CI 守卫,引擎只加一处**送信**管道(`publish-report --issue`),永不加 gate。

**一致性边界(诚实声明)**:无 engine gate 下,"gate 和 HTML 永远一起到"是**正常路径**的强顺序保证;报告基础设施故障时 QA verdict 仍 fail-open(PASS 不被报告绑架),gate 可能先于人工补投的报告到达——这是可观测补救,不是原子一致性,是 Annie 拍板保留的取舍。

## 1. 交付物清单(4 件)

| # | 文件 | 类型 | 说明 |
|---|------|------|------|
| D1 | `.flywheel/agents/engineering/qa-executor.md` | 编辑(+~5KB) | 新 self-owned section「QA PASS → ship-report HTML(MANDATORY, self-owned)」 |
| D2 | `.flywheel/templates/ship-report-template.html`(+ 同目录 render-helper 契约注释) | 新文件 | 自包含模板:Apple-light + 逐段 cbox + ship 裁决区 + copy-export + nonce 字面量 + 安全填槽契约 |
| D3 | `packages/flywheel-comm` `publish-report --issue` + `packages/teamlead` `/api/reports/deliver` `issueIdentifier` + `plugin.ts` typed resolver | 加法性代码 | 服务端解析 parent issue thread + 该 thread 的发送 bot identity;fail-closed,绝不 fallback generalChannel |
| D4 | shell sentinel + vitest(route/CLI/DOM/模板/reachability)+ committed CSP mutation harness | 测试群 | 文案守卫最小化,行为契约交给真测试(见 §5) |

## 2. D1 — qa-executor.md 新 section(行为规范全文要点)

插入位置:`## Discord-capable changes → 529 N-to-N` 之后、`## Work loop` 之前。锚点句(CI 守卫逐字盯):

1. **标题**:`## QA PASS opens the founder ship gate → publish the ship-report HTML FIRST (MANDATORY, self-owned)`;正文含 `you own it, not your Lead`(1461 同款自持有措辞)。
2. **触发**:你的 PASS 将打开 founder ship gate → 发 pass **之前**必须 publish;FAIL 不触发(founder 不被打扰)。pipeline QA 的顺序锚点是 `qa-result --status pass`;manual QA 不发 `qa-result`,顺序锚点改为**在向 Lead 报 PASS 之前**先 publish。覆盖范围按 §6 reachability matrix 声明,不夸大。
3. **硬时序**:`publish ship-report BEFORE emitting qa-result --status pass`(manual:before reporting PASS to the Lead)+ 原因一句话(pass 后 `closeQaRunner` 随时清理你,补发窗口不存在)。
4. **怎么发**:`flywheel-comm publish-report --html <file> --project <name> --issue <parent-issue-identifier> --title "Ship Report <FLY-XX> @ <head-sha7> r<round>"`。**HTML 先写到 worktree 外的持久路径**(如 `/tmp/flywheel-ship-reports/<issue>-<head-sha7>-r<round>.html`)——PASS 后 worktree 会被清理,不能让报告唯一副本陪葬。
5. **成功判定 = 解析 stdout JSON envelope,不是 exit 0**(R1#2):只有 `delivered === true` 且有 `messageId` 才算投递成功;`skipped:true`(kill switch)/ `publishOnly:true` / `delivered:false` / envelope 不可解析 / 非零退出 → 全部进兜底。exit 0 ≠ 成功。
6. **report identity + 幂等**(R1#4):报告页头、Discord title、兜底 payload 三处都固定携带 `{parent issue, 被测 PR head SHA, QA round, generated-at}`。形成 PASS 结论后**再 fetch/recheck head**(feedback_qa_fetch_head_before_pass 的既有规矩落到这里);同一 `(issue, head, round)` 的 qa-result 传输重试**复用**已投递的报告,不重发;head 漂移或新 QA round → **重新生成重新发布**,旧报告以旧 SHA 自明。reconcile 补发 ship-ready gate 无需 fresh report——对应同 `(head, round)` 的已投报告即可。
   **round 的 durable authority(R2#3)——round 不许只活在 agent 对话记忆里**:render-helper 维护 worktree 外、原子写的 sidecar `/tmp/flywheel-ship-reports/<issue>/state.json`,至少存 `{head, round, generatedAt, reportId, url, messageId, delivered}`。算法:进入 PASS 发布步骤先读 sidecar——同 head 且 `delivered:true` = 同一 verdict cycle 的重入/重试 → **复用** receipt 不重发;新 head 或明确的新 QA cycle(FAIL→复测 / founder kickback 重开)→ round+1 并重新生成;**delivery 成功后先持久化 sidecar,再发 verdict**。generalized DAG 的 node `attempt` 可作输入,但 auto-QA/三段式/manual 统一以 sidecar 为 fallback authority。
7. **内容规格**(Annie 亲定三块):① 怎么修 — 多张 **Mermaid** 图(病根→改了哪条路→数据流),渲染走 §4b capability ladder,founder 语言不堆术语;② **interactive** — 模板自带逐段留言框 + Ship/不 Ship 裁决区 + 一键复制(payload `SHIP-VERDICT:` + `## <section-key>`);③ QA 测了什么 — 固定 checklist:单测/集成数字 · 真机验证 · E2E/529 N-to-N(做了就贴 **529 thread link** + 预算内内嵌 GIF/关键帧截图)· 诚实边界(没测什么/为什么/何时补)。
8. **模板与自查**:从 `.flywheel/templates/ship-report-template.html` 复制填 slot,**按模板头部的填槽契约 escape 一切非自产内容**(§3);发前自查:`grep -c __CSP_NONCE__` ≥1 · `grep -c prefers-color-scheme` =0 · textarea 数 ≈ section 数 · 最终尺寸按 §4b 检查。
9. **兜底(never silently skip)**:publish/投递失败不阻塞 PASS,但必须执行**可运行的完整命令**:`flywheel-comm ask --lead <你的 Lead id,与你 baseline 注入的一致> --exec-id <你的 exec-id> --report "SHIP-REPORT publish-failed: <error> | url: <hosted-url-or-n/a> | local: <持久绝对路径> | issue: <FLY-XX> | head: <sha7> r<round>"`——publish 成功仅 deliver 失败时**必须带 envelope 里的 hosted URL**(已有 URL 丢掉=白白加大人工恢复成本);由 Lead 手动投递。静默跳过 = QA 未完。
10. **豁免消解**:此 artifact 是 Annie 直令(FLY-1463)对 `runner_no_direct_founder_publish` 默认的显式豁免——仅 ship-report 这一种物料由 QA 直发 issue thread,其他 founder 物料仍走 Lead。

## 3. D2 — 模板结构 + 安全填槽契约(R1#5)

```
<head> 无自写 CSP(injectHeadMeta 注入);<style> 内联:Apple-light(#f5f5f7/#1d1d1f 卡片),html{color-scheme:light only},颜色写死
<body>
  头部:FLY-XX 标题 + PR # + 被测 head SHA + QA round + generated-at + 一句话结论
  裁决区(页顶):radio ✅ Ship / ❌ 不 Ship + 说明 textarea    ← section-key: verdict
  §1 怎么修:一句话病根 → [SVG 图槽位 ×N] → 改动清单表        ← fix-approach / arch-graph
  §2 QA 测了什么:checklist 表(单测数/集成数/真机/529 N-to-N link+图槽/边界) ← qa-unit / qa-e2e-529 / qa-boundary
  每个 § 正下方:.cbox(引导句 + textarea data-k="<section-key>",localStorage 暂存)
  页尾:「一键复制我的裁决+全部批注」按钮 → SHIP-VERDICT payload
  <script nonce="__CSP_NONCE__"> addEventListener 绑定(无 inline onclick)
```

**安全填槽契约**(report-registry 的安全前提:generator 必须 escape untrusted content,nonce 不豁免内容注入——`report-registry.ts:51-61`):

- slot 分四类,模板头部注释逐槽标注类型:**text**(HTML-escape `& < > " '` 后进正文/attribute;issue 标题、PR diff 片段、测试输出、失败文本一律按 untrusted 处理)· **url**(仅 validated `https://`,进 `href` 前 escape)· **svg**(仅 QA 自产 mmdc 输出,填入前拒绝 `<script`、`on*=` 事件属性、外部引用;含任一 → 降级为 data-image 或 `<pre>`)· **data-image**(仅 `data:image/png|jpeg|gif;base64,` 前缀)。
- 正文内容**绝不拼进** nonced `<script>`;copy payload 由 DOM `value`/`textContent` 构造,不做 HTML 字符串拼接。
- localStorage key 前缀必须含 `location.pathname + 被测 head SHA`,隔离同一 fw-reports origin 下不同报告/不同 round 的批注(fixture 断言 A 报告的批注不会出现在 B)。
- 交付一个小而确定的 render-helper(`scripts/ship-report-fill.mjs`,纯函数:escape + slot 类型校验 + 尺寸检查),QA runner 用它填槽而不是手拼;hostile fixtures(`<`、引号、`</textarea>`、`__CSP_NONCE__` 字面量、Unicode)进测试。

## 4. D3 — 投递管道(唯一引擎改动,加法性,非 gate)

- `publish-report.ts`:新 `--issue <identifier>`(与 `--channel` 互斥,CLI 和 `publishReport()` 两层都报错);deliver body 加 `issueIdentifier`(不传 = byte-compat,同 FLY-929 `expectedDate` 先例)。
- `reports-route.ts` `/deliver`:边界先拒绝同时携带 `channelId` + `issueIdentifier` 的 body(400)。仅有 `issueIdentifier` 时经必注入的 `resolveIssueThread(identifier, projectName)` 回调解析;两者都缺 → 现行 generalChannel 行为逐字不变(reverse-compat)。
- **typed resolver(plugin.ts composition root,R1#1 + R2#1)**——**逐字复用 ship gate 自己的路由链**(`auto-qa-effects.ts:117-137` 同一条),返回 `{threadId, botToken}`,不做多余 Linear round-trip:
  1) parent session 必须存在(`store.getSessionByIdentifier(identifier)`;无 session → 404);canonicalize/验证 projectName(未知项目 → 400),并强制 `session.project_name === canonicalProject`(mismatch → 400,防跨项目误投);
  2) `resolveLeadForIssue(projects, canonicalProject, parseIssueLabels(session.issue_labels))` 得到**唯一 Lead**——与 gate 的 Lead 选择完全一致,不做 all-channel 扫描(扫描只能证明"项目某处有 thread",不能证明"是 gate 会选的 thread";两 Lead 共享 channel 时 token 还不唯一);
  3) 只查 `getChatThreadByIssue(session.issue_id, lead.chatChannel)`——canonical key 是 run-start 的 issue key,不是裸 Linear UUID(`tools.ts:820-842` "never the bare Linear UUID");无命中 → 404 `issue_thread_not_found`,绝不 fallback generalChannel;
  4) thread row 的非空 `lead_id` 与 resolved Lead 不一致 → fail-closed 拒绝,不猜;
  5) **发送 identity** = 该 Lead 的 `botToken ?? configuredGlobalBotToken`(gate 通知同款)——不沿用 route 现在的 infra/global token 盲发。issue 模式的 token 存在性检查移到 resolver 之后;旧 channel/general 模式 token 行为字节不变。
  这保证 report 与 gate **同 thread、同 sender identity**——report/gate 同一 founder 决策面正是本 issue 的目的。
- **状态码分层**:无 session/thread → 404 `issue_thread_not_found`;非法参数/项目不匹配/互斥冲突 → 400;缺 token 或 Discord/内部故障 → 5xx。CLI 把 4xx/5xx 原样进 envelope,runner 按 D1#5/#9 处理。

### 4b. Mermaid capability ladder + 尺寸验证(R1#6)

- 渲染链写实,不假装有第二个 renderer:**mmdc SVG**(本机 `/opt/homebrew/bin/mmdc` 11.12.0,发前 `command -v mmdc`)→ binary 尚可工作但 SVG 产出异常时 **mmdc PNG + data URI** → binary 不可用/两种都失败时 **`<pre>` mermaid 源码 + founder 语言文字流程**,绝不因图挂而不发报告。
- 尺寸检查在**所有图/data URI 填完之后**做:render-helper 用生产 `injectHeadMeta` 产出 hardened HTML 再量,断言 `< 512 KiB` 硬顶,**480 KiB 为操作阈值**——超了先删最大内嵌媒体(529 link 永远保留)再重量。

## 5. D4 — 测试架构(R1#7:文案守卫最小化,行为契约交给真测试)

- **shell sentinel**(`scripts/__tests__/test-qa-executor-ship-report-contract.sh`,ci.yml 挨着 1461 step ~line 370):只守 md 标题锚 · `you own it, not your Lead` · `BEFORE emitting qa-result` · manual 顺序锚 · `--issue` · `delivered === true` 判定锚 · 可执行 `ask --lead` 兜底锚 · `never silently skip` · 40k byte budget · 模板文件存在 · 模板侧 `__CSP_NONCE__`/`color-scheme:light only`/`SHIP-VERDICT`/`data-k=`/`location.pathname`/无 `prefers-color-scheme`/无 `onclick=`。
- **route/CLI vitest**:互斥(route+CLI 两层)· resolver(canonical identifier-vs-UUID / project mismatch / missing session / missing thread / missing token · **thread 只存在于另一 Lead channel 时必须 404** · **两 Lead 共享 channel 且 token 不同时不得按配置顺序猜 token** · **`thread.lead_id` 非空且与 resolved Lead 不一致必须拒绝** · **report resolver 与 gate 的 `AutoQaEffects` 路由对同一 session 得出同一 channel/token**)· 显式不 fallback generalChannel · absent-key byte-compat sentinel · kill-switch envelope(`skipped:true` 仍 exit 0 的现状锁定)。
- **sidecar/round vitest+fixtures**(R2#3):crash/re-entry 复用 · same-head transport retry 不重发 · new-head 重生成 · same-head-new-cycle 递增。
- **DOM/模板 vitest**(jsdom):section key 唯一且非空 · verdict radio · copy payload 含 `SHIP-VERDICT` + 各分区 · storage key 含 pathname+head(双报告互不串)· 无 inline handler · render-helper hostile fixtures(escape 四类槽)。
- **committed CSP mutation harness**(`scripts/qa-fly-1463-csp-verify.cjs`,本 design 阶段已实跑过同款):生产 `injectHeadMeta` + playwright-core headless——正常 nonce 全交互可用、去 nonce mutant 必须死(violation 原文捕获)。依赖本机 headless shell → **不进 Linux CI**,作为实现/QA 阶段必跑的真机步骤写进验收(生产=Mac、CI=Linux 的平台盲区,诚实分层)。
- **runtime reachability vitest**(§6):每个承诺覆盖的 QA 形态,断言最终注入的 system prompt / snapshot 含 mandate 唯一锚点。

## 6. Runtime reachability matrix + rollout(R1#3)

计划**只承诺以下经测试证明的形态**,不夸大:

| QA 形态 | 规则到达路径 | 证明方式 |
|---------|-------------|---------|
| auto-QA(FLY-579,sessionRole=qa) | Blueprint `readAgentFile` 读项目 `qa-executor.md` | Blueprint prompt 组装 vitest:断言 mandate 锚点在最终 prompt |
| 三段式 QA phase | 同上(role 注入) | 同上(phase 变体) |
| fresh schema-v2 DAG qa 节点 | admission 时 snapshot pin 项目 `qa-executor.md`(`workflow-run-snapshot.ts:343-407`,`workflow-menu.test.ts:279-307` 已有先例) | snapshot vitest:断言 pinned `node.agent` 含锚点 |
| manual dispatch(同 issue,qa/testing label) | 同 auto 路径 role 注入;parent identifier = 当前 issue | prompt vitest |
| **separate-issue manual QA** | parent identifier 无注入来源 → **不在 v1 承诺内**,md 写明"无 parent identifier 注入时按兜底报 Lead,不虚报覆盖" | md 锚点 |
| **schema-v1 QA node** | v1 materialization 不读 agent 文件(`workflow-run-snapshot.ts:279-340`)→ 见下方 **go/no-go preflight**(不是"登记后照常 ship") | 生产 binding/receipt 证据 |
| **已入场(pinned)的 in-flight run** | snapshot 在 admission 冻结,merge 不改已 pin 内容 → 见下方 **go/no-go preflight**;**验收必须用 merge 后新 spawn** | run/session 清单 + disposition |

**生效前 go/no-go preflight(R2#2 — 这是部署/宣告生效的硬前置,不是 engine gate)**:

1. **schema-v1 可达性**:ship 前必须以**生产 binding/receipt**(`workkind-cutover.ts` 的实际 cutover receipt / 生产 DB,不能只看 `.flywheel/config.yaml` 源码基线)+ `listActiveWorkflowRuns()`/session inventory,证明**没有可新入场的 schema-v1 gate-opening QA**。若仍可达,三选一才许继续:完成 binding cutover 使 v1 不可达;给 v1 补 QA role resolution;或取得 **Annie 对该明确残余路径的 scope exception**(founder 级,Lead 单方登记不够)。
2. **存量 pinned run**:对每个已 pin 旧 agent content 的 active QA session / DAG run,逐个选择 **drain 到终态** 或 **经 durable runner wake/instruction 注入 FLY-1463 义务并记录送达回执**——不允许"Lead 人工提醒"这类概率性兜底。
3. **产出物**:rollout checklist 列出 exact run/session 清单与每项 disposition;存在未处置项时**不得宣称 FLY-1463 已生效**。
4. **上游文档修正**:本 plan §6 取代 exploration/research 中"auto/三段式/DAG/manual 全覆盖"的旧说法(research.md §8 已同步改为指向本 matrix)。

## 7. 明确不做(边界)

- ❌ 引擎 gate/flag:Bridge 不校验"PASS 带没带 HTML",不阻塞任何 verdict/gate(Annie 铁律,1461 同招);`onQaResult` 与 workflow verdict authority 完全不读取报告状态。
- ❌ 真·callback 端点:CSP 无 connect-src + Bridge 不出公网;回传 = 结构化 copy-export 粘回 issue thread(验收 ①② 由此闭环),真端点 = v2 独立 issue。
- ❌ 运行时 mermaid.js(CDN/内嵌均否);❌ FAIL 时的 ship-report;❌ shipped 通用 `agents/qa-executor.md`(Flywheel-internal only);❌ notifyShipReady 卡片改动。

## 8. 实施顺序 + 验收

顺序:D2 模板+render-helper(先能手工渲染真验)→ D3 管道(TDD:resolver/route 测先行)→ D1 md → D4 守卫+reachability 测试 → 全仓 gate(`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 .sh)→ codex code review → PR。

验收(issue 原文,做完在**真 ship** 上跑一遍,用 merge 后新 spawn 的 QA):① Annie 在 HTML 留 comment → Lead 收到且能定位 section-key;② 勾"不 ship" → payload `SHIP-VERDICT: no` 到 Lead;③ mermaid(SVG)真渲染(至少一张真 mmdc SVG + 一条 forced-render-failure 走 `<pre>` fallback 的 fixture);④ 529 GIF/link 真可见。交互正确性:committed CSP mutation harness(生产 injectHeadMeta + playwright-core + 突变对照)+ hosted 真机段 Claude-in-Chrome;发布两个不同 path 的 fixture 确认 localStorage 互不串;一个接近 480 KiB 的边界 fixture 走"删最大媒体保 link"路径。
