# FLY-1508 design 节点 founder HTML 合同补互动格式规范 — 探索

Issue: FLY-1508 (https://linear.app/geoforge3d/issue/FLY-1508/基建小修-design-节点-founder-html-合同补格式规范-必须可互动逐节-comment-一键汇总复制)
日期: 2026-07-27
基于: 无

## 1. 问题是什么

Annie 在 FLY-1501 thread 的 founder 直令(2026-07-27):设计稿 HTML 要做成可互动——"每个地方都可以留 comments,然后也有个地方把我所有的 comments 整合起来,方便我 copy paste 给你","我肯定不希望只是这一轮是这样,我希望以后所有设计稿的 HTML 都是这样"。范围她也明确了:只到 design session("可能只是对 design session 有这个需求,每次做完发一个就可以了"),不做系统级泛化。

当前状态:在飞的 design runner 已由 Tadashi 口头指令逐个覆盖(临时),FLY-1501 的可互动版已交付并被 Annie 认可(参考成品 r/f5097a65)。本 issue 管的是**永久合同**——把互动格式写进 design 节点的 founder-HTML 产出合同文本,以后所有项目所有 design session 自动带上,不再依赖口头指令。

## 2. 改哪(codebase 审计结论)

**唯一改点**:`packages/edge-worker/src/Blueprint.ts` 里的 `founderDesignHtmlDeliveryLines()` 函数(约 737-760 行)。这是 design 节点 founder-HTML 合同的**单一来源**:

- 它在 `isDesignNodeCompletion` 为真时被注入 system prompt(`Blueprint.ts:1706-1721`);
- 覆盖全部三条 design 路径:三段式 generic text-design、三段式 mockup-first UI design(FLY-1059)、generalized workflow 的 design 节点(FLY-1307/1404)——三条路径共用这一个函数,改一处全生效;
- 现有合同已要求 5 项内容(一句话总结/核心流程图/数据模型/取舍/诚实边界)+ publish-report 发布 + `DESIGN-HTML ready:` 回报,缺的只是**互动层格式**。

**相关测试**(prompt-string 锚点断言,hermetic):

| 测试文件 | 现有锚点 |
|---|---|
| `Blueprint.fly793-phase-prompt.test.ts:109-119` | `Founder design HTML (MANDATORY)`、五项内容、`--publish-only`、`DESIGN-HTML ready:`;152 行反向锚(implement 不含) |
| `blueprint-designer-phase.test.ts:119-122,143` | mockup-first 与 generic 两路径都含合同 |
| `Blueprint.generalized-workflow.test.ts:130,186` | generalized design 节点含、非 design 节点不含 |

## 3. 支撑机制核实(不用新建任何东西)

**nonce 注入机制已存在且生效**(`packages/teamlead/src/bridge/report-registry.ts:52-67`):

- 报告生成方在 HTML 里写 `<script nonce="__CSP_NONCE__">`;
- `injectHeadMeta` 发布时铸造真 per-report nonce,替换所有占位符,并下发 `script-src 'nonce-…'` 的 CSP;
- 不带 nonce 占位符的 `<script>` 会被托管页 CSP 拦死(默认 CSP 是 `default-src 'none'` 无 script-src)——这正是 issue 里"缺 nonce 变回死页面"的机制根源;
- **安全契约(必须写进合同)**:inline 事件属性(`onclick=…`)不被 script nonce 覆盖,交互必须在 nonce script 内用 `addEventListener` 绑定。这是 report-registry 注释里明文写的陷阱,漏了会导致复制按钮被 CSP 拦掉、静默失效。

**参考成品已实测在线**(FLY-1501 可互动版,抓取核实):交互层 diff 确实极小——

- ~10 行 CSS(`.cmt` 输入区、`#cmt-panel` 汇总卡、`#cmt-copy` 按钮等);
- 一个底部汇总卡 div(实时预览 + 复制按钮 + 状态提示);
- 一段 IIFE script:遍历 `.card` 逐节挂 textarea(节标题取自 card 的 h2)、localStorage 按 per-page key 前缀自动保存(try/catch 包裹)、`collect()` 聚合非空 comment 带【节标题】、`navigator.clipboard.writeText` + `document.execCommand('copy')` 兜底。

## 4. 关键设计判断

### 4.1 合同文本必须自包含,不引用外部参考

- 托管 URL 7 天过期(`DEFAULT_RETENTION_MAX_AGE_MS`),不能当永久引用;
- FLY-1501 的 HTML 在其分支上、且是 flywheel 仓库路径——这份合同注入**所有项目**的 design session,repo 相对路径对其他项目无意义;
- 结论:合同文本用精确的格式条款自描述(照 issue 四条 + nonce/addEventListener 陷阱),任何 runner 不看参考也能做对。

### 4.2 加在合同的哪个位置

现有合同行序:标题 → 内容五项 → commit/push → publish → report → complete 时序。互动层是**HTML 形态要求**,插在内容五项之后、"Commit and push" 之前,作为一个连贯小节,不打断发布时序条款。

### 4.3 范围铁律(照 issue)

- 只改 `founderDesignHtmlDeliveryLines` 的合同文本 + 相应 prompt 断言测试;
- 不动 publish-report / report-registry(机制已在);
- 不动其它节点(implement/QA/单 session);
- 不建新机制、不加 config、不加 flag。

## 5. 待 Lead 确认的理解

1. 改点 = `founderDesignHtmlDeliveryLines` 一处,三条 design 路径自动全覆盖(含 mockup-first 和 generalized workflow),这是预期行为;
2. 合同文本自包含(不贴参考 URL/repo 路径),四条格式要求 + addEventListener/nonce 陷阱写死在合同里;
3. 验收 = prompt-string 断言(新锚点)+ 既有 Blueprint prompt 测试全绿 + Codex code review;
4. 本单走 generic 单 session(issue 明示勿三段式)——但当前 dispatch 是三段式 design 节点形态(本 session 即 design phase),按 dispatch 实际形态执行:design 完稿 → implement 节点做代码。
