# FLY-1463 Ship-gate 交付 interactive ship-report HTML — 调研

Issue: FLY-1463 (https://linear.app/geoforge3d/issue/FLY-1463/机制founder-可见-ship-gate-交付-interactive-ship-report-html-qa-pass-时随-gate)
日期: 2026-07-24
基于: exploration.md

> **2026-08-09 更正:** 本文保留当时调研；其 HTML ship / 不 ship 裁决及 `SHIP-VERDICT` 回传设计已废止。现行批准只认 ship 卡片上的 founder ✅ reaction 或卡片 thread 内 founder 直接回复。

## 1. FLY-1461 前例形态(逐文件对齐)

commit `e4cdd75f`(PR #699)的完整交付形态 = 本 issue 的模板:

| 交付件 | FLY-1461 | FLY-1463 对应 |
|--------|----------|--------------|
| 硬规则 | `.flywheel/agents/engineering/qa-executor.md` 新 self-owned section | 同文件再加一节 "QA PASS → ship-report HTML"(现 6,650 bytes,40k budget 余量充足) |
| CI 守卫 | `scripts/__tests__/test-qa-executor-529-nton-contract.sh`(grep sentinel + `assert_max_bytes` 40000) | 新 `test-qa-executor-ship-report-contract.sh`,同款断言函数,`ci.yml` 相邻接线(现 line 363/370 两个 executor contract step) |
| 引擎 | 零改动 | **一处加法性投递管道**(见 §3,唯一差异,不是 gate) |
| 文档 | `engineering/doc/FLY-1461-*/` 三件套 | 本文件夹 |

守卫测试可直接复用的断言函数:`assert_contains`(grep -qF,needle 不带反引号——FLY-372 zsh 坑)、`assert_max_bytes`(bytes 严于 chars 的哨兵)、`assert_file_exists`。

## 2. PASS 时序链(代码级确认)

`flywheel-comm qa-result --status pass --target-exec <parent>`(`qa-result.ts`,retry+fail-close marker)→ Bridge `event-route.ts`(`event_type === "qa_result"`)→ `AutoQaCoordinator.onQaResult`(`auto-qa-coordinator.ts:1486-1509`):

1. `setAutoQaStatus(…, "passed")`
2. `notifyShipReady({session: parent})` — **唯一 founder-facing 发射点**,发到 **parent issue thread**(不是 QA issue thread,不是 alert channel)
3. `safeStampIssueStage(parent, "approve")` — thread 标 ⏳待批
4. `closeQaRunner(…)` — **立即清理 QA runner**(cmux workspace + tmux + Terminal tab + archive)

推论(设计的硬时序,写进 md 规则):

- **publish 必须先于 `qa-result pass`**——pass 之后 runner 随时被杀,补发窗口不存在。
- publish 先行还天然保证 Discord thread 里 HTML 消息排在 ship-ready 卡之前,"gate 和 HTML 一起到"零引擎协调。
- FAIL 分支(`awaiting_retest`,founder 不被通知)**不要求** ship-report——报告交回实现 runner 走修复环;只有"将开 founder gate 的 PASS"触发义务。fix-loop 复测后最终 PASS 时照常必发(此时 diff/证据都是最新一轮的)。
- qa-executor.md 现行 §Reporting 的"PASS 后 release 资源 + STOP,不要 complete"保持不变——新义务插在"确认 PASS 结论"与"emit qa-result"之间。

## 3. 投递缺口与方案比较(runner → parent issue thread)

### 现状能力矩阵

| 路径 | 能到 parent thread? | 缺什么 |
|------|--------------------|--------|
| `publish-report --channel <id>` → `/api/reports/deliver` | 能,但要 raw thread id | QA runner 没有 thread id(`QaContext` 只有 `parentIssueIdentifier`);不传 channel 会落 `generalChannel`(违反 founder-html-into-thread 规矩) |
| `/api/chat-threads/send`(issueIdentifier 解析) | 能解析 thread | 要 `channelId`+`leadId`(runner 没有)、纯文本无截图卡、挂 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` flag |
| 让 Lead 转发 | 能 | 概率性投递 = 本 issue 要治的病;且加时延,gate 与 HTML 解耦 |
| spawn 时把 thread id 注入 QA prompt | 能 | thread 在 spawn→PASS 间可能被归档/重建(FLY-369 archive cascade),快照 stale;且同样是引擎改动,通用性更差 |

### 选定:`publish-report --issue <identifier>`(加法性,deliver 时服务端现查)

- CLI:`publish-report` 增加 `--issue <FLY-XX>`(与 `--channel` 互斥,二选一);body 加 `issueIdentifier` 字段,不传则 byte-compat(JSON.stringify 丢 undefined,同 FLY-929 `expectedDate` 先例)。
- Bridge `/api/reports/deliver`(`reports-route.ts:306`):有 `issueIdentifier` 时,复用 `/chat-threads/send` 的解析链(`isLinearUuid` → Linear identifier→UUID → `StateStore.getChatThreadByIssue(issueId, chatChannel)`,FLY-270 canonical key)。`ReportsRouterOptions` 需注入 thread 解析回调(现只有 `projects`,没有 store——用回调注入避免 route 层直接抱 StateStore,test seam 同款)。
- **fail-closed**:解析不到 thread → 4xx 错误返回 runner,**绝不静默 fallback 到 generalChannel**;runner 的 md 规则里写兜底动作(§4)。
- 为什么这不违背"不加引擎门":引擎在这里只是**送信**(和 FLY-203 publish-report 本身同类),从不校验"PASS 有没有带 HTML"、从不阻塞任何 verdict/gate。义务 100% 在 qa-executor.md(概率性 runner 合规 + 确定性 CI 文本守卫,与 1461 同一诚实边界)。

### 兜底链(写进 md)

publish 失败(Bridge down / thread 解析失败 / 512KB 超限修不掉)→ **不阻塞 PASS**(QA 结论本身是真的,ship 不能被报告基建绑架),但必须:① `flywheel-comm ask` 向 Lead 报 `SHIP-REPORT publish-failed: <error> + 本地路径/URL`,由 Lead 手动投递;② qa-result 照发。静默跳过 = 违规(与 529 N-to-N 的 "never silently skip" 同款措辞,CI 守卫锚定)。

## 4. HTML 物理约束与内容预算(512KB 硬顶)

`MAX_HTML_SIZE = 512KiB` 双侧同 cap(`publish-report.ts:51` / `reports-route.ts:52`)。CSP(`report-registry.ts:48-68`):`default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:;`

| 项 | 约束 | 预算策略 |
|----|------|---------|
| 交互 JS | 内联 `<script nonce="__CSP_NONCE__">` + `addEventListener`,禁 inline onclick(nonce 不覆盖) | ~5-10KB,模板固定 |
| Mermaid 图 | 无运行时渲染可能(无外链 JS、mermaid.min.js ~2.5MB 爆顶) | **生成时预渲染**:mmdc(`/opt/homebrew/bin/mmdc`,本机 brew 在装)→ inline SVG(通常每图 5-30KB);mmdc 挂了 → PNG data URI;再挂 → 缩进代码块 + 文字流程,**绝不因图挂而不发报告** |
| 截图 | 外链被 `img-src data:` 拦 → 只能 data URI | 每张压缩 JPEG/PNG ≤ 60KB,2-4 张关键帧 |
| 529 GIF | 同上,GIF 通常 MB 级 | **预算内才内嵌**(全文 ≤ 480KB 自查线,给 nonce 注入留余量):装不下就内嵌关键帧截图 + **529 thread link 永远保留**(链接零成本,Annie 至少能点进去) |
| 深色设备 | Annie 手机深色模式 | `html{color-scheme:light only}` + 颜色写死;`grep prefers-color-scheme` 必须 =0(FLY-1378) |

自查清单(写进 md,发前必跑):`grep -c __CSP_NONCE__` ≥1 · `grep -c prefers-color-scheme` =0 · textarea 数 ≈ section 数(FLY-353 逐段 inline 标准) · `wc -c` < 491,520(480KB)。

## 5. 交互回传:copy-export payload 格式(定案)

复用已被 Annie 真机验收的 FLY-349/1045/1318 模式(`.cbox` 逐段留言 + localStorage 暂存 + 一键复制),新增 **ship 裁决区**。payload 设计为机器可解析:

```
SHIP-VERDICT: yes | no
VERDICT-NOTE: <裁决说明,可空>
## <section-key>
<该区域批注>
## <section-key-2>
…
```

- section-key = 模板固定 slug(`fix-approach` / `arch-graph` / `qa-unit` / `qa-e2e-529` / `qa-boundary` …),Lead/runner 收到粘贴文本即可定位区域(验收 ①)。
- `SHIP-VERDICT: no` = 打回信号(验收 ②);粘贴目标 = 同一个 issue thread(gate 卡所在,零寻路成本)。
- 真·callback 端点(hosted 页 fetch 直达 Lead)判定为 v2:CSP 无 `connect-src` + Bridge 不出公网,需要 Vercel serverless 收件箱 + Bridge 轮询 + 防滥用鉴权,是独立立项的 infra;copy-export 已满足本 issue 全部验收项。

### 交互正确性的验证配方(给下游 QA 节点)

`reference_verify_nonce_html_under_real_csp`(FLY-1318 实跑):必须用生产 `injectHeadMeta`(`packages/teamlead/dist/bridge/report-registry.js`)加真 CSP 起本地服务验,**裸开文件 = 空过绿测**;首选 playwright-core headless 断言式 harness(能抓 CSP violation 原文),并做**突变对照**(拿掉 nonce 的 mutant 必须表现为按钮无反应,否则尺子坏了)。

## 6. 内容来源(QA runner 手里都有)

| 报告区块 | 来源 |
|----------|------|
| 怎么修(mermaid 多图:病根→改动路径→数据流) | PR diff(worktree 内 `git diff`)+ 实现方 `engineering/doc/FLY-XX-*/plan.md`/design 文档 + issue 描述 |
| 单测/集成数字 | QA 自己跑的 `pnpm test:packages:run` 等输出 |
| 真机验证 / E2E / 529 N-to-N | QA 自己的 529 房 run:thread link、Claude-in-Chrome 截图、gif_creator 产物 |
| 诚实边界 | QA 报告固有栏目(什么没测/为什么/何时补),与 529 规则的显式豁免声明同款纪律 |

## 7. 模板放置

整套 HTML 模板(Apple-light 卡片 + 逐段 cbox + ship 裁决区 + copy-export JS + nonce script 字面量)约 8-15KB,塞进 qa-executor.md 会烧掉 1/3 byte budget 且难维护 → **模板落 repo 文件 `.flywheel/templates/ship-report-template.html`**(与 agent md 同住 `.flywheel/`,随 worktree 分发,QA runner 直接 `cp` 后填 slot),md 只放指针 + slot 说明 + 自查清单。CI 守卫同时锚定 md 与模板文件的关键不变量。

## 8. 适用范围界定

- 触发条件写为**"你的 PASS 将打开 founder ship gate"**。~~覆盖 auto-QA、三段式/DAG、manual 三种形态~~ **(修正,被 plan.md §6 取代)**:实际覆盖范围以 plan.md §6 的 runtime reachability matrix 为准——auto-QA / 三段式 / fresh schema-v2 DAG / manual-same-issue 经测试证明;separate-issue manual 与 schema-v1 不在 v1 承诺内,schema-v1 可达性与存量 pinned run 走 plan.md §6 的 go/no-go preflight。
- 附带项目无关性:`.flywheel/agents/` 是 Flywheel-internal 文件(FLY-1461 同款 scope 声明),shipped 通用 `agents/qa-executor.md` 不动。
