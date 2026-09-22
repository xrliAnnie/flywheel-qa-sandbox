# FLY-2693 重起设计节点交接核验
Issue: FLY-2693
日期: 2026-09-18
基于: plan.md, approval.md, progress.md at b8dd5ff53

## 结论

沿用 R2 APPROVED 设计，不重写、不重审。2026-09-18 实时 `check c92e5e08-9d27-49b6-a07f-0e18b23d9f1d` 返回有效 `reviewVerdict=APPROVED`，无 HIGH；当前 plan SHA256 仍为 `96d1d5ded7c195ac49888673378aeac98bd7ba045e6740134e53e98309211310`，与已批准快照一致。

最新 Lead 交接 `[lead-instruction 563a0d15-2987-4b47-a9e9-0ffa28ddba17]` 明确本节点只核验并交接。TURN 已核对为 design / epoch 5，execution `a103f146-ca92-4bf2-ae4d-964152d08057`，run `4a3e8759-7e53-434d-a64c-d108d5dd318c`。未改实现、未合并、未部署、未重启、未触碰 stash。

## 保留的实现游标与前置变化

- 继承远端与本地共同头 `b8dd5ff5358de343c9a3b098c3dd2ea061d15f33`，原 progress 为 implement 4/9；基础实现 `c6b01067aa52deb9c9ba5f66aa0e2d619c2784b7` 已在该历史内。此核验不宣称基础实现完成或测试通过。
- 原下一步为等待 FLY-2669 PR #1248 合入；GitHub 实时核验为 MERGED，2026-09-18T16:37:45Z，merge SHA `11bfba42337197afb8d0f766e7989b26c7485aac`。该等待条件已解除。
- 实现节点接手第一步：取得 TURN 后 fetch 并技术合并 origin/main，确认包含上述 merge SHA，复核最终告警 sender/kind/queue/固定页接口，再从 implement 4/9 继续聚焦 TDD。不得复制旧设计分支中的推测接口。
- 不运行本地全量 `pnpm test:packages:run`；不触碰 `stash@{0}`。不派发后继，由 DAG 控制器推进。

## 范围与验收完整性

| 要求 | 设计证据与交接状态 |
|---|---|
| 不能从仅失败日志推导零成功或其余均成功 | exploration / research 的纠正及未知清单保留；原 PID 最近一圈仍未证明 |
| 成功心跳及退出后可读 lastSuccess | plan §2–3；完整迭代、续租进展分开，持久源库、跨重启序号及故障记录保留 |
| 需求驱动健康 | plan §3：无需求无 PID 正常休眠；有需求未起、未 live、持续失败出声；unknown 不假绿 |
| 连续失败、恢复及再次失败 | plan §3、§6：required 下三次失败或 60 秒无进展；poll/session 分域恢复；同故障不刷屏、恢复熄灭、再坏再响 |
| 启动失败与 FLY-2669 通道 | research 启动消费者审计；plan §4–5 独立 voice kind、投递回执、固定页同源 |
| 2 秒超时依据 | plan 附录 B：保留默认值，采样与阶段诊断后再提调参；lease 安全边界保持 |
| 按需启动硬要求 | plan §7/附录 A：FLY-2701 承接生命周期；2693 不假定常驻 PID |
| 回归及真机验收 | plan §6 保留真实 run() 故障注入、变异体阳照、成功清计数、频道/页面恢复、≥60 秒 live 与 FLY-2655 独立门槛；均为后继实施/QA 工作 |

五项非阻断 advisory 继续逐项进入实现及 QA 的「已处理 / 不适用+理由 / follow-up」清单：digest 与 trigger 列精确同构；bootstrap spool 多实例隔离与非破坏读取；WAL checkpoint 边界；manual 未证明恢复事件的预算/老化；长期同一故障只告警一次的已知限制。完整原文仍在 review-r2.json / follow-ups.md。不得以本次收尾声称这些实现检查已通过。

## Founder HTML 复验与发布

原 HTML 字节未改，SHA256 `39afaad3d3753692eb660fcc83daa3dd6e92586c27f9f95c2b73704f21bdbdf8`；已在继承分支提交并推送。

- 原发布与总结 report ID `d7caf001-da79-481e-a5d8-40098dce7e08` / `97249b49-2e48-4ce1-b8c2-c41348bc5594` 的实时 message-status 均为 ACKED。
- 本次按新节点交接要求重新 silent publish：reportId `9fb3f8b727525150b819cafe4e5820c0`，publishOnly=true、messageId=null、delivered=false（未发频道消息）。
- URL：https://fw-reports-42fba7.vercel.app/r/9fb3f8b727525150b819cafe4e5820c0/
- `verify-founder-html.mjs` 静态与 Node VM 检查通过：11 个评论输入、路径隔离存储、异常处理、汇总 marker、1800 字符分片、剪贴板成功/失败/缺失降级。
- 新托管 URL 实测 HTTP 200；nonce 占位清零、CSP 匹配、脚本与已提交源一致、11 个评论输入、零外部资源。
- 图表维持明确 `DIAGRAM PENDING LOCAL RENDER`；两图各两次本地 mmdc 失败证据和 Mermaid 原稿保留。没有浏览器视觉验证或生产语音验收结论。

本次仅复核既有合同和更新依赖状态，没有新增可复用判断；runner memory 不新增条目。完成路由仍为 `phase_design_complete`，之后 park 等待控制器唤醒，保持 issue goal 存活。

## 2026-09-18 再次设计派发：当前交付未完成（覆盖上文旧交接状态）

Execution `bc671b1d-2373-47b6-a1fc-f408eddbbae0` / run `b8c293f0-6968-4f33-8df7-e7e6aea2a7cb`，实时 TURN design epoch 9。继承 PR #1265 头 `b4301b136ca6c15de4031d23eb87653b58ac7fb3`；本地与远端一致，工作树原先干净。

- 原 progress 必须保留供实现节点续跑：**implement 8/9，Fix remaining five HIGH review findings with TDD; rerun review**。这是当前继承游标，不是上文旧 implement 4/9。设计节点未修改实现，未把实现审查问题当成已解决。
- 实时 check R2 仍为 effective APPROVED；plan / HTML 摘要与上文冻结版本一致。静态及 Node VM 评论验证再次通过。没有重开设计或重审；五项 advisory 继续按上文逐项交接。
- FLY-2669 PR #1248 实时仍为 MERGED；本次不做实现同步或重跑旧实现测试。
- 本次 silent publish **失败**：HTTP 502 / report publishing failed；没有新 URL。旧托管 URL `/r/9fb3f8b727525150b819cafe4e5820c0/` 实时 verify-report 也 HTTP 502，独立 GET 正文为 `Report storage unavailable`。旧版 delivery-evidence.json 是历史成功，不是当前托管验证。
- 已发 mandatory DESIGN-HTML publish-failed 报告 `f6b90737-bd7c-4250-82c1-f937b73f691d`；待 Lead 问题 `45f82aa4-d410-43af-bc60-52d9047d97d9` 明确交付服务恢复路径或门禁处置。
- 当前 **未运行 phase_design_complete**：等待托管交付恢复或明确处置，不能以旧 HTTP 200 冒充本次通过。新证据见 redispatch-current-evidence.json。
- 无新增可复用判断；不新增 runner memory。图表仍明确本地渲染未完成，生产心跳/真实告警/恢复/≥60 秒 live 均不是本次设计验收成果。

### 最新 Lead 接续指令与备份只读核验

`[lead-instruction 53300756-6bd3-441a-8ef2-bbd2370b9ecb]` 要求从 implement 8/9 的剩余 9/9 继续，先核对 WIP 备份。已 fetch `origin/backup/FLY-2693-wip-stash-20260918`，SHA `498df4b5bc6ee7cae217ce43b3b643b035361e8f`，为基于 b4301b136 的三父 stash 备份；11 个 tracked 文件，835 插入/111 删除；第三父无 untracked 文件。含 StateStore、health projector/helper、sender 与相应测试修订。未恢复、未执行这些 WIP 测试，不声称可直接验收。

注入角色和当前 TURN 均为 design，禁止实现；已向 Lead 问题 `1616ce87-2d09-485c-9cad-bf9a04875b9e` 请求协调 9/9 实现接续与 phase authority。后续节点应先读该答复，取得其有效 TURN 后再决定恢复/验证备份，保持同分支与 PR #1265，禁止全量测试、不得绕过 409 drain receipt。

## 2026-09-18 23:25Z Lead 裁定：允许设计交接（当前有效）

已消费问题 `45f82aa4-d410-43af-bc60-52d9047d97d9` 与 `1616ce87-2d09-485c-9cad-bf9a04875b9e` 的答复，并消费三个报告答复：`78cddfe0-93a1-4ca1-bffc-db7e8f2f98c3`、`f6b90737-bd7c-4250-82c1-f937b73f691d`、`5fbd55d9-7743-4797-a72c-ab7a996b2b62`。

- **交付处置**：Lead 确认 Vercel Blob `limits-exceeded-suspended` 是宿主问题，要求停止重试。HTML 已提交推送，保留 **DESIGN-HTML publish-failed** 即可执行 `phase_design_complete` 并 park；不把托管故障卡在设计阶段。没有新托管或送达证明。托管恢复后由 Lead 单独通知 publish-only + report，届时不写分支。该裁定明确取代上文等待交付恢复才完成的暂定做法。
- **阶段处置**：本次激活明确为 eng_design，只做设计交接；不重设计、不写实现、不应用 WIP。剩余 9/9、备份 `498df4b5` 和五项 HIGH 修复由 Lead 转交控制器创建的实现节点。当前 Runner 不派发后继。
- 当前 plan/html 原摘要不变，R2 APPROVED 与评论静态/VM检查凭据保留。实机 heartbeat/告警/恢复/live 验收仍归后继 QA，不被此设计交接替代。
- 本轮没有新增可复用判断，不新增 runner memory；已有索引 92 行 / 19,995 bytes，未超 160 行 / 20,000 bytes 限制。

提交本记录、推进 progress、推送原分支并向 Lead 报告后，执行准确 completion 路由，再 park。最终完成凭据以 CLI/服务端回执为准，不在此预称命令成功。

## 当前设计再派发交接（execution 4097085a）

本节覆盖前文旧激活的当前状态，旧记录保留为历史。核验时间见 `redispatch-4097085a-evidence.json`。TURN 为 design epoch 14 / run `d6b8a817-6024-40e6-ae11-ef9da5e84f35`，execution `4097085a-de3e-4fbf-8dfd-384eb19aa638`。继承 PR #1265 远端头 `d8d9e8865fa545288bdc86d05454fa9a2ab8d78e`，工作树原先干净。

- 继承实现游标 **implement 9/9**；原 progress 全文已保存到本次 evidence，不能退回旧 4/9、8/9 或重复恢复 WIP。原下一步是 packaging smoke 26/26 后提交测试修复、刷新 milestone、push 并续精确头 review；日志和 PR 已含这些提交，但本节点不声称最终 code review/CI/QA 已通过。设计收尾新增文档提交后，后继需核对新的精确头。
- 实时 `check` R2 仍为 effective **APPROVED**；冻结 plan 与 HTML 摘要均与审批快照相同。沿用 exploration/research/plan/approval 与现有实现处置，不重写、不重审设计。
- 实时读取交付问题 `45f82aa4-d410-43af-bc60-52d9047d97d9`、阶段问题 `1616ce87-2d09-485c-9cad-bf9a04875b9e`：Lead 仍要求停止托管重试，保留 publish-failed 即可 phase_design_complete 并 park；只做设计交接，控制器拥有后继派发。未新发 publish、未把旧 HTTP 200 当当前可用证据。当前 execution 的 publish-failed report 为 `81b29a20-9b4b-4660-ac69-d7053263fdcb`。
- `verify-founder-html.mjs` 静态及 Node VM 复验 PASS：11 评论区、路径隔离、存储失败、按标题汇总、1800 字符分片、剪贴板三路径及单一 nonce script。本地 Mermaid 渲染失败的既有证据和源保留，页面明确 `DIAGRAM PENDING LOCAL RENDER`。无浏览器视觉或当前托管验证结论。
- 上文需求闭包表与五项 design advisory 仍适用；最新实现 disposition 见 follow-ups.md。特别保留 R3 非阻断 `heartbeat-stale-never-produced`、`demand-source-degradation-never-reaches-health-source`、manual 老化和跨 root spool 隔离的未完成边界；设计 APPROVED 不证明这些实现要求已通过。继承 PR 对聚焦测试的描述只作实现方证据，本次未重跑或扩展实现测试。
- 运行中成功记录、持久 lastSuccess、需求下缺进程/未 live/连续失败的真实告警、恢复熄灭、再次故障再响、FLY-2655 独立验收及 ≥60 秒 live 仍需后继 QA；FLY-2701 承接按需生命周期。没有生产改动或通话可用声明。
- 本次仅核验既有合同，没有新增可复用判断，不新增 memory。索引 92 行 / 19,995 bytes。完成命令前会提交推送本次交接与 progress；最终完成及 park 以 CLI/服务端回执为准。

## 当前设计再派发交接（execution 225b9ad5，2026-09-20）

本节覆盖前文旧激活状态，旧记录保留为历史。核验细节见 `redispatch-225b9ad5-evidence.json`。TURN 为 design epoch 22 / run `e3953013-ab39-420d-af22-914cca1404b8`。继承 PR #1265 远端头 `d1a0777e3`，工作树原先干净。

- 继承实现游标 **implement 9/9**（原文已保存进 evidence）。PR #1265 OPEN / MERGEABLE，精确头 CI 14/15 绿，唯一红项是 Script Tests 3/5 的 FLY-1870 容量线（1021s > 1020s，断言 121/0 失败），PR 正文记录 Lead 已批准为仅容量例外、债务归 FLY-2755。本节点未重跑实现测试，不声称 code review / CI / QA 已过。
- 实时 `check` R2 仍为 effective **APPROVED**，plan SHA256 不变（96d1d5de…）。不重写、不重审设计；exploration / research / plan / approval / follow-ups 全部沿用。
- **本次新增**：mmdc 本机渲染这次成功（前三次激活均被 MachPort 沙箱拒绝，见 diagram-render.json 的 priorFailure）。两张 Mermaid 图以 `--svgId FLY-2693-d1 / d2` 渲染为自包含 SVG，替换 founder HTML 里的两个 `DIAGRAM PENDING LOCAL RENDER` 占位；正文、分区、评论脚本未改。`verify-founder-html.mjs` 静态 + Node VM 复验 PASS；headless Chrome 截图确认两图与中文标签正常显示。HTML 新 SHA256 `7577de71…`，提交 `5fd2215fe` 已推送。
- 托管交付这次成功：publish-only reportId `b43542ecb5d46e66592abd1a847724ce`，URL https://fw-reports-356a6d.vercel.app/r/b43542ecb5d46e66592abd1a847724ce/ ；实测 HTTP 200、nonce 与 CSP 头一致、0 占位、2 SVG、单 script、11 评论区、0 外部资源。已按合同以 DESIGN-HTML ready 报告 Lead（report `49110741-514a-4c07-9229-f19828c97c19`），未发频道消息。旧域名 `fw-reports-42fba7` 的历史 URL 仍 502，不再引用。
- 五项 design advisory 与 R3 code-review follow-up 的处置以 follow-ups.md 与 PR 正文为准；生产心跳、真实告警、恢复熄灭、再次故障再响、FLY-2655 独立验收与 ≥60 秒 live 仍归后继 QA。FLY-2701 承接按需生命周期。无生产或实现改动。
- 完成路由 `phase_design_complete`，之后 park；最终完成以 CLI/服务端回执为准。
