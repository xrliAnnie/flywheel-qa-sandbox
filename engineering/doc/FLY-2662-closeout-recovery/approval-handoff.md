# FLY-2662 批准与交接 — 实施计划
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662)
日期: 2026-09-17
基于: plan.md

## 有效批准
- round3 gate: `0a1c10be-341d-47a3-8b1b-946fe82d48f6`。
- request: `e99102a5-9f07-435d-97ff-db4a5849b1c2`。
- effective `reviewVerdict=APPROVED`，raw `reviewerVerdict=APPROVED`；结构化完整回执在 evidence/review-round3.json。
- 送审设计内容提交 `23363330a`；进度提交 `5237a480d`。原送审plan SHA256: `459400b66d954433a57c090f1de764443dac88e5888fcdaa48e4bde4780804d0`。本次仅更新plan状态行指向批准证据，没有在审阅后追加设计行为。
- R1/R2阻塞项处置见review-disposition.md；不重开设计、不把批准冒充实现完成。

## Follow-ups（本轮3条MEDIUM，不阻断设计门）
| findingKey | 后继应验证/明确 | 处置 |
|---|---|---|
| native-peer-adapter-has-no-build-or-pack-precedent | 仓库尚无first-party native构建/分发先例；实施需明确产物策略、package files、pnpm build允许项和实际updater加载路径。plan的release-manifest是待建设要求，不能声称已有机制。 | 原始意见完整保留；已报告Lead决定拆分/跟进，不擅自拆掉主PR身份保护。 |
| peer-connection-timeout-vs-external-lookups | 现有broker默认15s不能直接当reclose预算；在真实Linear/GitHub慢或429下验证连接和重试能完成。 | 原始意见完整保留；交Lead/实施跟进，不改变本轮批准合同。 |
| env-only-pane-discovery-mechanism-unverified | 环境marker读取机制尚未真机证明，不能把ps空输出或pgrep无匹配当gone；实施需取得目标机可行性证据，做不到应向Lead提出受证据约束的修订。 | 原始意见完整保留；unknown继续拒绝，不能把设计通过当旧pending形状已修好。 |

以上三条与本单最初12组/15个findingKey区分；原15项实施要求仍见plan §7，不被这三条Follow-ups覆盖或减少。Lead批准的peer socket、主死结优先、允许只读形状重建和不合并2658边界均保持。

## 页面交付与验证
托管页面：https://fw-reports-42fba7.vercel.app/r/0901dfed11a9a83166b28ebdc126369b/

原页面已在23363330a提交推送后静默发布，publishOnly=true、messageId=null、delivered=false符合不发频道消息要求。HTTP200、nonce占位符清零、script/CSP nonce匹配、预期内容通过；第二次独立fetch逐字验证仅nonce、注入CSP和noindex元标签与原文件不同，零外部资产。原始回执见evidence/publish-receipt.json与hosted-verification.json。
9节批注的DOM/VM检查通过，含跨路径隔离、保存/恢复、XSS只写textContent、分段marker、剪贴板不存在和拒绝回退、storage异常。真实浏览器视觉/CSP执行未验；两张本地Mermaid图各失败两次，按合同标DIAGRAM PENDING LOCAL RENDER并保留源图。没有远端渲染或假流程图。

## 阶段边界与后续验收
- 当前全部变更仅限本issue文档目录。未实施产品代码、合并、部署、重启或操作生产收尾；本节点不派发后继。
- 实施/QA按plan的真实旧形状fixture与完整顺序验收；native peer必须目标Darwin真机证据。没有执行产品源码测试，不用页面DOM检查冒充产品回归。
- 部署后由Lead逐卡处理2519/2606/2608/2612/2619/2616/2598/2601并记录真实readbacks；设计门不代签。
- 完成命令前保存并推送本交接和进度；随后使用注入的phase_design_complete命令与park。命令是否成功以Bridge结构化回执为准，本文件不预签。
