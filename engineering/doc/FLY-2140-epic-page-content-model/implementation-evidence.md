# FLY-2140 Epic 页面内容模型与首版生成 — 实现证据
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02
基于: plan.md

> 当前口径提示：第 1–11 节记录的是 founder 二次返工前的历史实现与修复链，已被第 12 节和 `plan.md` 第 11 节覆盖；其中 `batch.v1`、`next.v1`、单 Epic 输入、整页版本读取均不再是现行行为。

## 1. 演练边界

- 生产 Bridge `/health` 在演练时仍报告旧构建 `63154c214a82ace4c2273c24e6e66cf0157af392`,尚无本分支路由。
- 因此按计划 M7.3 用本机临时 Bridge 实例演练:实例运行本分支代码,连接真实 `/Users/xiaorongli/.flywheel/teamlead.db`,只读真实 Linear,并只向 additive `epic_page` 写入一版。临时实例结束后已关闭。
- 线上 `projects.json` 的 `flywheel` 条目当时还没有 `linear` 字段。临时实例仅在内存里给 `flywheel` 配置 `{team:"FLY"}` 以执行边界检查;未改 registry、Linear issue、标签或关系。真实返回的 Epic team 为 `FLY`,project 为 `Flywheel`,labels 为 `["Flywheel"]`。
- 生成调用使用本分支构建出的 `flywheel-comm epic-page`;临时 bearer 只用于本机回环实例,未写入任何证据或提交。

## 2. 真 Linear + 真 StateStore 同时刻快照

- Linear 快照时间:`2026-09-03T04:53:20.251Z`。
- StateStore 物化/页面生成时间:`2026-09-03T04:53:20.560Z`。
- 首次真实 GraphQL 调用 `x-complexity: 137`;`children(includeArchived:false)`、嵌套 `first/pageInfo` 与 inverse `blocks` 方向均被真实 API 接受。该 Epic 只有一页,关系补页仍由 T8 mock 覆盖。
- 六格的 `ok` 全为 `true`;下表中的 `session` 是 `ledger_live_count/latest_count`,`attempt` 是 `count/open`,其余执行格是数组行数。

| 子单 | Linear state | 直接 blocked_by | batch | session | run | attempt | gates | carriers | land | 独立手算是否 next |
| --- | --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | --- |
| FLY-2144 | backlog | — | 1 | 1/1 | 1 | 1/true | 0 | 0 | 0 | 否:账面执行体存在 |
| FLY-2143 | backlog | FLY-2140:backlog; FLY-2141:backlog; FLY-2142:backlog | 3 | 0/0 | 0 | 0/false | 0 | 0 | 0 | 否:阻塞者未终态 |
| FLY-2142 | backlog | FLY-2140:backlog | 2 | 0/0 | 0 | 0/false | 0 | 0 | 0 | 否:阻塞者未终态 |
| FLY-2141 | backlog | FLY-2140:backlog | 2 | 0/0 | 0 | 0/false | 0 | 0 | 0 | 否:阻塞者未终态 |
| FLY-2140 | backlog | — | 1 | 1/1 | 1 | 1/true | 0 | 0 | 0 | 否:账面执行体存在 |

没有调用产品里的 `computeNext`:另用 `jq` 逐项执行 `static ∧ blockers released ∧ 六格 known ∧ ledger_live_count=0 ∧ run=[] ∧ attempt 非 open ∧ land=[]`,结果为:

```json
{"manual_next":[],"page_next":[],"equal":true}
```

这次真实数据还得到:

- `batches = {1:[FLY-2140,FLY-2144],2:[FLY-2141,FLY-2142],3:[FLY-2143]}`;
- `founder_items = []`;五张子单当时都没有 `founder-review` 标签;
- 五张子单都没有可抽取的验收标题,所以 `gaps` 明确列出五条 `no_acceptance_section`,没有把缺失内容猜成页面事实。

## 3. CLI、持久化与渲染结果

执行了:

```text
flywheel-comm epic-page generate --epic FLY-2108 --project flywheel --bridge-url <local>
flywheel-comm epic-page show --epic FLY-2108 --project flywheel --format json --bridge-url <local>
flywheel-comm epic-page show --epic FLY-2108 --project flywheel --format md --bridge-url <local>
flywheel-comm epic-page render --epic FLY-2108 --project flywheel --out /private/tmp/fly2140-epic.html --bridge-url <local>
```

四次 CLI stdout 均只有一行 JSON envelope。generate envelope:

```json
{"ok":true,"command":"generate","result":{"version":1,"generated_at":"2026-09-03T04:53:20.560Z","content_digest":"39bdadd16ea87d6ee2e07f8719e9c86d68c1ae927c49edb0040463f4f2ad6f08","item_count":5,"next_candidates":[]}}
```

真实库只读复核:

```text
version  generated_at                  content_digest
1        2026-09-03T04:53:20.560Z      39bdadd16ea87d6ee2e07f8719e9c86d68c1ae927c49edb0040463f4f2ad6f08
```

尺寸与完整性:

| 产物 | UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| canonical JSON(`epic_page.document`) | 26,887 | 内容 digest 另按“去时间戳 canonical JSON”计算,见上 |
| `show --format md` 正文 | 30,755 | `46580603aa99e42555e079d2cf308abd7ab1b345106684f40e701d050795b1fd` |
| `render` HTML | 54,192 | `138f7b3ab449186b0356d67eed9d0eafb45a0ee41f4bb9ae15f01dbcd83ae2ef` |

`render` 落盘后 CLI 回读逐字节相等。随后用既有 `publish-report --publish-only` 托管、没有 Discord 投递:

- 快照:https://fw-reports-a53de2.vercel.app/r/2cdff89613a8cb31e1d2632c62de7ec3/
- report id:`2cdff89613a8cb31e1d2632c62de7ec3`
- `delivered:false`,`publishOnly:true`

## 4. `show --format md` 原始正文

下面是上述 SHA-256 对应的完整 stderr 人读正文;同一正文也在 stdout 单行 envelope 的 `markdown` 字段内。

~~~~text
# Epic 执行页面: &#91;Epic&#93; Lead 拿到一份 Epic 页面之后,自己把它推到完

Epic: FLY-2108 · 生成时间: 2026-09-03T04:53:20.560Z · 不含已归档

<!-- cell:/header/title -->
**Epic 标题**
- 内容: &#91;Epic&#93; Lead 拿到一份 Epic 页面之后,自己把它推到完
- 出处: Linear · issue:f5b4d804-2551-4d4e-8a71-700d7b065c14 · title · https://linear.app/geoforge3d/issue/FLY-2108/epic-lead-拿到一份-epic-页面之后自己把它推到完
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-08-29T06:48:28.323Z (7085 分钟前)


<!-- cell:/header/url -->
**Epic 链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2108/epic-lead-拿到一份-epic-页面之后自己把它推到完
- 出处: Linear · issue:f5b4d804-2551-4d4e-8a71-700d7b065c14 · url · https://linear.app/geoforge3d/issue/FLY-2108/epic-lead-拿到一份-epic-页面之后自己把它推到完
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-08-29T06:48:28.323Z (7085 分钟前)


<!-- cell:/header/state -->
**Epic 状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:f5b4d804-2551-4d4e-8a71-700d7b065c14 · state · https://linear.app/geoforge3d/issue/FLY-2108/epic-lead-拿到一份-epic-页面之后自己把它推到完
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-08-29T06:48:28.323Z (7085 分钟前)


<!-- cell:/header/children -->
**子单集合**
- 内容: &#91;"FLY-2144","FLY-2143","FLY-2142","FLY-2141","FLY-2140"&#93;
- 出处: Linear · children:f5b4d804-2551-4d4e-8a71-700d7b065c14
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)


现在可以开始的 (未获 founder 裁定的默认规则 next.v1(PRD §8-2)): 无

## 要做的事

| 子单 | 标题 | 状态 | 批次 | 验收 | 找她 | 账面执行体 |

| --- | --- | --- | --- | --- | --- | --- |

| FLY-2144 | &#91;2108·E&#93; 派发判断的容量输入:quota + 机器内存当前值可读 · 附 dag-resolver 退役 | Backlog | 第 1 批 | 缺 | 否 | running/implement&#40;17036c9c&#41; |

| FLY-2143 | &#91;2108·D&#93; Epic 页面活化:事件+扫描双路更新,过期自报;卡住上页可见 | Backlog | 第 3 批 | 缺 | 否 | 无 |

| FLY-2142 | &#91;2108·C&#93; 依赖账本:初始批次 + 三类动态更新&#40;减法不许丢&#41; | Backlog | 第 2 批 | 缺 | 否 | 无 |

| FLY-2141 | &#91;2108·B&#93; Epic 残余扫描:巡检钟上补「回头看 Epic 还剩什么」+ 空位拉活 | Backlog | 第 2 批 | 缺 | 否 | 无 |

| FLY-2140 | &#91;2108·A&#93; Epic 页面:内容模型 + 首版生成&#40;每格带出处与时间戳&#41; | Backlog | 第 1 批 | 缺 | 否 | completed/design&#40;32a0afbd&#41; |

### 子单 FLY-2144
<!-- cell:/items/0/title -->
**标题**
- 内容: &#91;2108·E&#93; 派发判断的容量输入:quota + 机器内存当前值可读 · 附 dag-resolver 退役
- 出处: Linear · issue:a8ae21c7-956d-490c-9474-609151a18e2f · title · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/url -->
**链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 出处: Linear · issue:a8ae21c7-956d-490c-9474-609151a18e2f · url · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/state -->
**状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:a8ae21c7-956d-490c-9474-609151a18e2f · state · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/priority -->
**优先级**
- 内容: 0
- 出处: Linear · issue:a8ae21c7-956d-490c-9474-609151a18e2f · priority · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/blocked_by -->
**全部阻塞者**
- 内容: &#91;&#93;
- 出处: Linear · relation:a8ae21c7-956d-490c-9474-609151a18e2f · inverseRelations · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/batch -->
**所属批次**
- 内容: 1
- 出处: batch.v1 · 由 /items/0/blocked_by 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/0/acceptance -->
**验收原文**
- 内容: no_acceptance_section
- 出处: Linear · issue:a8ae21c7-956d-490c-9474-609151a18e2f · description · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/founder_named -->
**需要回来找她**
- 内容: false
- 出处: Linear · label:a8ae21c7-956d-490c-9474-609151a18e2f · labels · https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:38:40.565Z (134 分钟前)

<!-- cell:/items/0/session -->
**会话账面事实**
- 内容: {"latest":&#91;{"branch":null,"execution_id8":"17036c9c","role":"implement","status":"running"}&#93;,"ledger_live_count":1}
- 出处: sessions · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:48:24Z (5 分钟前)

<!-- cell:/items/0/run -->
**工作流账面事实**
- 内容: &#91;{"current_node_id":"implement","current_node_label":"实现","label_source":"manifest","run_id":"f12e1576-a278-4cf3-ad3b-ca042cd33074","status":"active","template_id":"tpl_code"}&#93;
- 出处: workflow_run · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:25:17Z (148 分钟前)

<!-- cell:/items/0/attempt -->
**节点尝试账面事实**
- 内容: &#91;{"attempt":1,"ledger_open":true,"state":"running"}&#93;
- 出处: workflow_run_node · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T03:50:06Z (63 分钟前)

<!-- cell:/items/0/gates -->
**审批门事实**
- 内容: &#91;&#93;
- 出处: workflow_gate_holder · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/0/carriers -->
**交付载体事实**
- 内容: &#91;&#93;
- 出处: workflow_carrier_delivery · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/0/land -->
**落地事实**
- 内容: &#91;&#93;
- 出处: land_operation · {"issue_id":"a8ae21c7-956d-490c-9474-609151a18e2f","issue_identifier":"FLY-2144"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


### 子单 FLY-2143
<!-- cell:/items/1/title -->
**标题**
- 内容: &#91;2108·D&#93; Epic 页面活化:事件+扫描双路更新,过期自报;卡住上页可见
- 出处: Linear · issue:1f327c8f-0afb-4589-880b-eddc34eea20b · title · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/url -->
**链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 出处: Linear · issue:1f327c8f-0afb-4589-880b-eddc34eea20b · url · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/state -->
**状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:1f327c8f-0afb-4589-880b-eddc34eea20b · state · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/priority -->
**优先级**
- 内容: 0
- 出处: Linear · issue:1f327c8f-0afb-4589-880b-eddc34eea20b · priority · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/blocked_by -->
**全部阻塞者**
- 内容: &#91;{"blocker_state_type":"backlog","identifier":"FLY-2140","sibling":true},{"blocker_state_type":"backlog","identifier":"FLY-2141","sibling":true},{"blocker_state_type":"backlog","identifier":"FLY-2142","sibling":true}&#93;
- 出处: Linear · relation:1f327c8f-0afb-4589-880b-eddc34eea20b · inverseRelations · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/batch -->
**所属批次**
- 内容: 3
- 出处: batch.v1 · 由 /items/1/blocked_by 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/acceptance -->
**验收原文**
- 内容: no_acceptance_section
- 出处: Linear · issue:1f327c8f-0afb-4589-880b-eddc34eea20b · description · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/founder_named -->
**需要回来找她**
- 内容: false
- 出处: Linear · label:1f327c8f-0afb-4589-880b-eddc34eea20b · labels · https://linear.app/geoforge3d/issue/FLY-2143/2108d-epic-页面活化事件扫描双路更新过期自报卡住上页可见
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:38.839Z (137 分钟前)

<!-- cell:/items/1/session -->
**会话账面事实**
- 内容: {"latest":&#91;&#93;,"ledger_live_count":0}
- 出处: sessions · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/run -->
**工作流账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/attempt -->
**节点尝试账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run_node · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/gates -->
**审批门事实**
- 内容: &#91;&#93;
- 出处: workflow_gate_holder · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/carriers -->
**交付载体事实**
- 内容: &#91;&#93;
- 出处: workflow_carrier_delivery · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/1/land -->
**落地事实**
- 内容: &#91;&#93;
- 出处: land_operation · {"issue_id":"1f327c8f-0afb-4589-880b-eddc34eea20b","issue_identifier":"FLY-2143"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


### 子单 FLY-2142
<!-- cell:/items/2/title -->
**标题**
- 内容: &#91;2108·C&#93; 依赖账本:初始批次 + 三类动态更新&#40;减法不许丢&#41;
- 出处: Linear · issue:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · title · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/url -->
**链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 出处: Linear · issue:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · url · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/state -->
**状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · state · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/priority -->
**优先级**
- 内容: 0
- 出处: Linear · issue:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · priority · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/blocked_by -->
**全部阻塞者**
- 内容: &#91;{"blocker_state_type":"backlog","identifier":"FLY-2140","sibling":true}&#93;
- 出处: Linear · relation:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · inverseRelations · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/batch -->
**所属批次**
- 内容: 2
- 出处: batch.v1 · 由 /items/2/blocked_by 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/acceptance -->
**验收原文**
- 内容: no_acceptance_section
- 出处: Linear · issue:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · description · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/founder_named -->
**需要回来找她**
- 内容: false
- 出处: Linear · label:184c63ad-d3ce-4005-bf11-c2ec40754ca6 · labels · https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:26.378Z (138 分钟前)

<!-- cell:/items/2/session -->
**会话账面事实**
- 内容: {"latest":&#91;&#93;,"ledger_live_count":0}
- 出处: sessions · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/run -->
**工作流账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/attempt -->
**节点尝试账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run_node · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/gates -->
**审批门事实**
- 内容: &#91;&#93;
- 出处: workflow_gate_holder · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/carriers -->
**交付载体事实**
- 内容: &#91;&#93;
- 出处: workflow_carrier_delivery · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/2/land -->
**落地事实**
- 内容: &#91;&#93;
- 出处: land_operation · {"issue_id":"184c63ad-d3ce-4005-bf11-c2ec40754ca6","issue_identifier":"FLY-2142"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


### 子单 FLY-2141
<!-- cell:/items/3/title -->
**标题**
- 内容: &#91;2108·B&#93; Epic 残余扫描:巡检钟上补「回头看 Epic 还剩什么」+ 空位拉活
- 出处: Linear · issue:b7241e67-b666-458c-891e-ef83510e4d37 · title · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/url -->
**链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 出处: Linear · issue:b7241e67-b666-458c-891e-ef83510e4d37 · url · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/state -->
**状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:b7241e67-b666-458c-891e-ef83510e4d37 · state · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/priority -->
**优先级**
- 内容: 0
- 出处: Linear · issue:b7241e67-b666-458c-891e-ef83510e4d37 · priority · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/blocked_by -->
**全部阻塞者**
- 内容: &#91;{"blocker_state_type":"backlog","identifier":"FLY-2140","sibling":true}&#93;
- 出处: Linear · relation:b7241e67-b666-458c-891e-ef83510e4d37 · inverseRelations · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/batch -->
**所属批次**
- 内容: 2
- 出处: batch.v1 · 由 /items/3/blocked_by 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/acceptance -->
**验收原文**
- 内容: no_acceptance_section
- 出处: Linear · issue:b7241e67-b666-458c-891e-ef83510e4d37 · description · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/founder_named -->
**需要回来找她**
- 内容: false
- 出处: Linear · label:b7241e67-b666-458c-891e-ef83510e4d37 · labels · https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:35:24.967Z (138 分钟前)

<!-- cell:/items/3/session -->
**会话账面事实**
- 内容: {"latest":&#91;&#93;,"ledger_live_count":0}
- 出处: sessions · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/run -->
**工作流账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/attempt -->
**节点尝试账面事实**
- 内容: &#91;&#93;
- 出处: workflow_run_node · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/gates -->
**审批门事实**
- 内容: &#91;&#93;
- 出处: workflow_gate_holder · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/carriers -->
**交付载体事实**
- 内容: &#91;&#93;
- 出处: workflow_carrier_delivery · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/3/land -->
**落地事实**
- 内容: &#91;&#93;
- 出处: land_operation · {"issue_id":"b7241e67-b666-458c-891e-ef83510e4d37","issue_identifier":"FLY-2141"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


### 子单 FLY-2140
<!-- cell:/items/4/title -->
**标题**
- 内容: &#91;2108·A&#93; Epic 页面:内容模型 + 首版生成&#40;每格带出处与时间戳&#41;
- 出处: Linear · issue:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · title · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/url -->
**链接**
- 内容: https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 出处: Linear · issue:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · url · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/state -->
**状态**
- 内容: {"name":"Backlog","type":"backlog"}
- 出处: Linear · issue:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · state · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/priority -->
**优先级**
- 内容: 0
- 出处: Linear · issue:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · priority · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/blocked_by -->
**全部阻塞者**
- 内容: &#91;&#93;
- 出处: Linear · relation:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · inverseRelations · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/batch -->
**所属批次**
- 内容: 1
- 出处: batch.v1 · 由 /items/4/blocked_by 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/4/acceptance -->
**验收原文**
- 内容: no_acceptance_section
- 出处: Linear · issue:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · description · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/founder_named -->
**需要回来找她**
- 内容: false
- 出处: Linear · label:09b7c3de-f813-4fa3-a542-e9cca96cfca7 · labels · https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳
- 看到它的时间: 2026-09-03T04:53:20.251Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:02:32.015Z (51 分钟前)

<!-- cell:/items/4/session -->
**会话账面事实**
- 内容: {"latest":&#91;{"branch":null,"execution_id8":"32a0afbd","role":"design","status":"completed"}&#93;,"ledger_live_count":1}
- 出处: sessions · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:32:45Z (20 分钟前)

<!-- cell:/items/4/run -->
**工作流账面事实**
- 内容: &#91;{"current_node_id":"implement","current_node_label":"实现","label_source":"manifest","run_id":"5d59f82a-d3b5-4225-936b-7aced2426e24","status":"active","template_id":"tpl_code"}&#93;
- 出处: workflow_run · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T02:25:04Z (148 分钟前)

<!-- cell:/items/4/attempt -->
**节点尝试账面事实**
- 内容: &#91;{"attempt":1,"ledger_open":true,"state":"running"}&#93;
- 出处: workflow_run_node · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)
- 来源更新时间: 2026-09-03T04:01:57Z (51 分钟前)

<!-- cell:/items/4/gates -->
**审批门事实**
- 内容: &#91;&#93;
- 出处: workflow_gate_holder · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/4/carriers -->
**交付载体事实**
- 内容: &#91;&#93;
- 出处: workflow_carrier_delivery · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

<!-- cell:/items/4/land -->
**落地事实**
- 内容: &#91;&#93;
- 出处: land_operation · {"issue_id":"09b7c3de-f813-4fa3-a542-e9cca96cfca7","issue_identifier":"FLY-2140"}
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


## 它们的先后(批次)

<!-- cell:/batches -->
**批次集合**
- 内容: &#91;{"batch":1,"items":&#91;"FLY-2140","FLY-2144"&#93;},{"batch":2,"items":&#91;"FLY-2141","FLY-2142"&#93;},{"batch":3,"items":&#91;"FLY-2143"&#93;}&#93;
- 出处: batch.v1 · 由 /items/0/batch, /items/0/priority, /items/1/batch, /items/1/priority, /items/2/batch, /items/2/priority, /items/3/batch, /items/3/priority, /items/4/batch, /items/4/priority 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


## 每件做完算什么样

未获 founder 裁定的默认规则 done.v1(PRD §8-3)

<!-- cell:/done_definition -->
**做完定义**
- 内容: {"terminal_state":"completed"}
- 出处: done.v1 · 由 &#91;&#93; 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


## 这个 Epic 里要回来找她的

0 件(标签 founder-review 当前无命中)

<!-- cell:/founder_items -->
**回来找她的子单**
- 内容: &#91;&#93;
- 出处: founder.v1 · 由 /items/0/founder_named, /items/1/founder_named, /items/2/founder_named, /items/3/founder_named, /items/4/founder_named 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


## 现在可以开始的(默认规则 next.v1,未获 founder 裁定)

未获 founder 裁定的默认规则 next.v1(PRD §8-2)

账面状态,不代表进程一定活着

<!-- cell:/next_candidates -->
**默认下一批候选**
- 内容: &#91;&#93;
- 出处: next.v1 · 由 /items/0/state, /items/0/blocked_by, /items/0/batch, /items/0/priority, /items/0/session, /items/0/run, /items/0/attempt, /items/0/gates, /items/0/carriers, /items/0/land, /items/1/state, /items/1/blocked_by, /items/1/batch, /items/1/priority, /items/1/session, /items/1/run, /items/1/attempt, /items/1/gates, /items/1/carriers, /items/1/land, /items/2/state, /items/2/blocked_by, /items/2/batch, /items/2/priority, /items/2/session, /items/2/run, /items/2/attempt, /items/2/gates, /items/2/carriers, /items/2/land, /items/3/state, /items/3/blocked_by, /items/3/batch, /items/3/priority, /items/3/session, /items/3/run, /items/3/attempt, /items/3/gates, /items/3/carriers, /items/3/land, /items/4/state, /items/4/blocked_by, /items/4/batch, /items/4/priority, /items/4/session, /items/4/run, /items/4/attempt, /items/4/gates, /items/4/carriers, /items/4/land 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)


## 缺什么、缺在哪

<!-- cell:/gaps -->
**缺口集合**
- 内容: &#91;{"face":"done","item":"FLY-2144","reason":"no_acceptance_section"},{"face":"done","item":"FLY-2143","reason":"no_acceptance_section"},{"face":"done","item":"FLY-2142","reason":"no_acceptance_section"},{"face":"done","item":"FLY-2141","reason":"no_acceptance_section"},{"face":"done","item":"FLY-2140","reason":"no_acceptance_section"}&#93;
- 出处: gaps.v1 · 由 /items/0/title, /items/0/batch, /items/0/acceptance, /items/0/founder_named, /items/1/title, /items/1/batch, /items/1/acceptance, /items/1/founder_named, /items/2/title, /items/2/batch, /items/2/acceptance, /items/2/founder_named, /items/3/title, /items/3/batch, /items/3/acceptance, /items/3/founder_named, /items/4/title, /items/4/batch, /items/4/acceptance, /items/4/founder_named 推出
- 看到它的时间: 2026-09-03T04:53:20.560Z (0 分钟前)

~~~~

## 5. 200 子单体积标定

用 200 张中性 `EPX-*` synthetic 子单(每张一条验收、链式依赖、六格已知空值)走真实 `generateEpicPage`、schema guard、canonical serializer 与 HTML renderer:

```json
{"childCount":200,"canonicalBytes":743702,"htmlBytes":1476637,"selectedLimit":1507328}
```

批准公式为 `ceil((canonicalBytes × 2) / 65536) × 65536`,因此:

- `743,702 × 2 = 1,487,404`;
- 向上取 64KB 倍数 = `1,507,328` bytes(`23 × 65,536`);
- `EPIC_PAGE_MAX_DOCUMENT_BYTES` 已由临时 1MB 值调整为 `1_507_328`,并有精确单测;
- 200 子单 HTML 为 1,476,637 bytes,超过 publish-report 的 512KB 托管上限,证明 `render` stderr 警示必须保留。文档生成上限与托管上限是两个独立合同。

## 6. StateStore 真实形状与迁移证据

真实 SQLite 的 `sqlite_schema`:

```sql
CREATE TABLE epic_page (
  project_name TEXT NOT NULL,
  epic_issue_id TEXT NOT NULL,
  epic_identifier TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  generated_at TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','event','scan')),
  content_digest TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_name, epic_issue_id, version)
);
CREATE INDEX idx_epic_page_latest
  ON epic_page(project_name, epic_issue_id, version DESC);
```

`CREATE ... IF NOT EXISTS` 在 SQLite 存入 `sqlite_schema` 时会正规化掉 `IF NOT EXISTS`;其余列、约束、主键和索引与 research §6.1 一致。

真实全库 issue key 分布:

| 来源 | identifier-like | UUID-like | other |
| --- | ---: | ---: | ---: |
| `workflow_run.issue_id` | 503 | 1 | 0 |
| `land_operation.issue_id` | 207 | 0 | 0 |
| `sessions.issue_id` | 2,649 | 138 | 1 |

`SELECT issue_id ... LIMIT 20` 的 workflow_run 与 land_operation 样本均为 `FLY-*` identifier;sessions 样本同时保有 `issue_id` 与 `issue_identifier`。全库确实同时存在 identifier 与 UUID,双别名参数化查询不是假设性兼容。

真实时间抽样:

- `workflow_run.created_at` 最近 5 行均为 SQLite `YYYY-MM-DD HH:MM:SS`;
- `sessions.last_activity_at` 最近 5 行包含 `YYYY-MM-DD HH:MM:SS` 与带毫秒的 `YYYY-MM-DD HH:MM:SS.sss`;
- 真实 FLY-2108 演练的投影全部通过 RFC3339 schema guard,证明 `strftime` 可吃这些生产格式。

真实 workflow snapshots 分布为 v1 36 行、v2 409 行。分别取一行交给 `parseWorkflowRunSnapshot` 均成功,都返回 4 个 `manifest.nodes`;这两份样本的可选 `label` 均为空。全库 v2 有 49 行的第一个 node 带 label;真实 FLY-2140/2144 演练已把 manifest label 投影成页面显示标签。

## 7. 挂载、安全与静态范围门

- 用 `createBridgeApp` 真实栈探测同一个 GET:无 `apiToken` 时 404(路由未挂载),有 token 配置但无 Authorization 时 401。
- `plugin.ts` 相对钉住的 main 只增加 9 行,全部是 import 与条件挂载。
- 通用主语门:

```text
rg -n 'FLY-2108|flywheel-eng-lead' packages/teamlead/src/epic-page packages/teamlead/src/bridge/epic-page-route.ts packages/teamlead/src/bridge/linear-epic-query.ts packages/flywheel-comm/src/commands/epic-page.ts
# 0 matches
```

- HTML 的 DOM/markup 测试逐一覆盖 9 个根 Cell 与每张子单 14 个 Cell、动态文本转义、Linear URL allowlist、responsive CSS。尝试在本机加载 Chromium 截图时被宿主 macOS sandbox 的 MachPort rendezvous 拒绝;QuickLook 也在 sandbox 初始化阶段失败。因此没有伪造截图,可视结果由上述托管快照、完整 HTML 和 executable markup assertions 共同交付。

## 8. 仓库验证

最终门禁于 2026-09-02 执行。lint 与 build 通过;测试的原样命令在当前 macOS sandbox 被真实 Terminal.app 用例截停,后续 package 以 package 级和改动路径级命令继续覆盖。没有新增 `scripts/__tests__/*.test.sh`。

```text
$ pnpm lint
Checked 2746 files in 4s. No fixes applied.
Found 14 warnings.
exit 0

$ pnpm -r build
Scope: 22 of 23 workspace projects
...
packages/teamlead build: Done
exit 0

$ pnpm test:packages:run
packages/core test:run: Test Files  1 failed | 19 passed (20)
packages/core test:run: Tests  2 failed | 219 passed (221)
packages/core test:run: FAIL test/tmux-viewer.macos.test.ts
packages/core test:run: Connection Invalid error for service com.apple.hiservices-xpcservice
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL
exit 1
```

原样测试命令的两个失败都要求可写的 Terminal.app Apple Events/XPC 会话;当前 sandbox 拒绝该宿主能力,递归 runner 因 first-fail 没有继续到 Teamlead。为区分环境与代码,使用临时 PATH 仅让 `which osascript` 返回“不可用”后再跑同一命令;Core 结果为 219 passed / 3 skipped。临时 shim 已删除,未进入 Git。该续跑在 `flywheel-comm` 的 ProofShot 锁文件遇到 21 个级联 `ELOCK_TIMEOUT` 后再次 first-fail;同一失败文件随即独立复跑为 39/39 通过。

Teamlead 全包另行原样执行:

```text
$ pnpm --filter flywheel-teamlead test:run
Test Files  11 failed | 772 passed (783)
Tests  26 failed | 10216 passed | 6 skipped (10248)
Errors  1 error
Duration 340.72s
exit 1
```

该轮在宿主高负载下触发 Vitest worker RPC timeout,失败主体是 5s/10s/20s 的真实 shell、git、tmux 集成超时;另有 tmux 3.6a 明确拒绝测试构造的 `SCRATCH\\tTAB` 窗口名。FLY-2140 的模型、生成、渲染、Linear 查询、路由、StateStore、保留策略测试均通过。全仓首轮曾准确抓到新增 `epic_page` 未进入 FLY-2006 fail-closed schema registry;修复后该表归入 `protectedCurrentOrReference`（页面写入路径自己按每 Epic 最近 20 版剪枝）。

最终改动路径稳定复验:

```text
$ pnpm exec vitest run <12 个 Teamlead FLY-2140/集成测试文件>
Test Files  12 passed (12)
Tests  123 passed (123)
exit 0

$ pnpm exec vitest run src/commands/__tests__/epic-page.test.ts
Test Files  1 passed (1)
Tests  8 passed (8)
exit 0

$ pnpm --filter flywheel-teamlead exec vitest run \
    src/__tests__/fly-2006-database-retention-sweep.test.ts \
    src/__tests__/statestore-epic-page.test.ts
Test Files  2 passed (2)
Tests  28 passed (28)
exit 0

$ pnpm --filter flywheel-comm exec vitest run src/__tests__/visual-capture.test.ts
Test Files  1 passed (1)
Tests  39 passed (39)
exit 0
```

## 9. founder 卡片版返工（2026-09-03 08:48 PT）

返工基线是托管页 `e5a270f61a0a1e44374190864f418c41`；样板是 Lead 计划页 v69 `c5a9ef08d755591f2a5cd50b9b81be90`。基线每张子单展开 14 个 Cell 网格，样板的核心则是一件事一张短卡、四行上下文。新 HTML 保留同一份 `EpicPage` 权威文档，调整为：

- 首屏：Epic 总览、批次顺序、「现在可以开始的」、完成规则、founder 项、缺口；
- 主体：按 `batches` 分组，每张子单一张卡；标题为 identifier · title · state；
- 卡内：「是什么」= Linear title；「为什么」= 从全部 sibling `blocked_by` 反向推出的解锁关系；「做完你看到」= acceptance 原文的至多 240 Unicode code point 展示，缺失显示「缺验收」；依赖写成「做 X 之前先做 Y」；
- 卡底：Linear 链接 + `observed_at` + `source_updated_at` 一行小字；全部 14 Cell 的精确出处与时间保留在同一 footer 的原生折叠详情；
- 所有 derived 展示继续写规则号、完整 `from` 路径和「未获 founder 裁定的默认规则」；没有新 flag。

TDD 原始摘要：

```text
RED  pnpm exec vitest run src/epic-page/__tests__/render.test.ts
Test Files  1 failed (1)
Tests  3 failed | 7 passed (10)
失败原因：旧 HTML 仍有 <table>/cell-grid，无 card-meta，无「Epic 总览」。

GREEN pnpm exec vitest run src/epic-page/__tests__/render.test.ts
Test Files  1 passed (1)
Tests  10 passed (10)
```

相关范围与静态门：

```text
$ pnpm exec vitest run src/epic-page/__tests__ \
    src/bridge/__tests__/epic-page-route.test.ts \
    src/bridge/__tests__/linear-epic-query.test.ts \
    src/__tests__/statestore-epic-page.test.ts
Test Files  10 passed (10)
Tests  112 passed (112)

$ pnpm exec biome check src/epic-page/render-html.ts \
    src/epic-page/labels.ts src/epic-page/__tests__/render.test.ts
Checked 3 files. No fixes applied.

$ pnpm exec tsc --noEmit
exit 0
```

生成的中性 fixture HTML：48,076 bytes；5 张子单对应 5 张 `item-card`；零 `<table>`；零 `cell-grid`。尝试用 Playwright Chromium 做 980px 全页截图，浏览器在导航前被宿主拒绝：

```text
FATAL: base/apple/mach_port_rendezvous_mac.cc:155
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)
```

因此没有把截图标成通过；结构与内容密度由上述 DOM 断言、精确 HTML 与相关范围测试证明，视觉截图留给具备浏览器宿主能力的独立 QA。

真实 FLY-2108 最新 `epic_page` 文档经新 renderer 生成 60,337-byte HTML，5 张子单对应 5 张卡，已用 `publish-report --publish-only` 发布新快照：

https://fw-reports-a53de2.vercel.app/r/cf881d9d36a0e7c133ae628cf1482ace/

本地 HTML SHA-256 为 `a3ed34e106bb1ba586b01006678eb2bd14b52fb2c7d58907a8a79d6bac6966b1`。托管页会注入 CSP nonce / noindex 元数据，因此托管响应整体 digest 不应与本地原文相等；回读托管页仍精确包含 5 个 `item-card`。

## 10. 卡片版全仓门

```text
$ pnpm lint
Checked 2757 files. No fixes applied.
Found 14 warnings.
exit 0

$ pnpm -r build
Scope: 22 of 23 workspace projects
packages/teamlead build: Done
exit 0

$ pnpm test:packages:run
packages/core test:run: Test Files 1 failed | 19 passed (20)
packages/core test:run: Tests 2 failed | 219 passed (221)
两条失败均为 test/tmux-viewer.macos.test.ts 的真实 Terminal.app Apple Events；
宿主返回 Connection Invalid / osascript syntax error，recursive first-fail 截停。
```

同一 package gate 的并发运行中，`packages/config` 的 symlink 拒绝用例一度因临时目标 `EEXIST` 失败；单文件立即复跑为 21/21 通过，说明不是本分支行为回归。卡片版未新增任何 `scripts/__tests__/*.test.sh`。Linux GitHub CI 与新一轮 exact-head code review 仍是最终提交头门禁。

## 11. implement@6：qa@5 两项返工

顶部路径墙按严格 TDD 收口：

```text
RED  pnpm exec vitest run src/epic-page/__tests__/render.test.ts --reporter=dot
Test Files  1 failed (1)
Tests  1 failed | 10 passed (11)
失败点：/batches 的 summary 是完整 batch.v1 + /items/N/field 路径串，而非短 summary。

GREEN pnpm exec vitest run src/epic-page/__tests__/render.test.ts --reporter=dot
Test Files  1 passed (1)
Tests  11 passed (11)

$ pnpm exec tsc --noEmit --pretty false
exit 0
```

随后从真实 `/Users/xiaorongli/.flywheel/teamlead.db` 只读取得 `flywheel / FLY-2108` 最新 `epic_page.document`，用本分支 renderer 生成 60,352-byte HTML。逐格对账结果：

```text
Cell 79
observed_at 缺失 0
出处锚点(url > table > rule > kind)缺失 0
source_updated_at 缺失 0
Linear 出处链接 6
5 个派生总览 summary：均为「1 格出处与时间」，均无 /items/；折叠体均保留 rule/path
```

文本出现次数由 qa@5 的「看到它的时间」89 降为 84，恰好少掉五个旧 summary 的重复时间；79 个 Cell 的折叠体时间逐格零缺失。「来源更新时间」为 49，未低于 qa@5 的 47。换言之，返工删除的是折叠标题里的重复展示，不是任何 Cell 证据。

`publish-report --publish-only` 在 11:06 PT 与 11:08 PT 两次都返回 `publish failed (502): report publishing failed`；同期既有卡片页与 qa@5 页均为 HTTP 200。Lead 回答 `4ae71008-52a4-4fb0-b4e1-66468f0d2572` 确认真因是 Vercel 当日部署配额 100/100 用尽，在 2026-09-04 18:10Z 前不能新发，并明确要求停止重试。ProofShot Chrome 与隔离安装的 Playwright WebKit 都在当前 runner 的 macOS 进程沙箱启动阶段退出，因此 PR body 附精确 DOM 对账并引用 qa@5 托管页作基线，不伪写新 hosted URL。

随后 Lead instruction `d9605b53-bc6c-4119-956c-d657975b502d` 提供同位置靶图 `~/.flywheel/artifacts/fly2140/epic-page-card-ac1d4b93.{html,png}`，并要求 implement 自己截本地对照。当前 head HTML 已保存为同目录的 `epic-page-card-83edede36.html`；1200×1700 对照 PNG 保存为 `epic-page-card-83edede36.png`，并复制进本目录作为 [PR 可见截图](./epic-page-card-83edede36.png)。截图使用不依赖浏览器进程的 WeasyPrint 69 headless HTML renderer；capture-only stylesheet 只设定 1200×1700 画布并补齐 print UA 对 closed `<details>` 的隐藏行为，未进入产品代码。本人逐像素目视结论：旧靶图顶部五卡被路径铺满；新图五卡都只剩短「1 格出处与时间」入口，随后直接进入批次分组；子单卡的「是什么 / 为什么 / 做完你看到 / 依赖·批次」、状态、账面执行体、找她与底部「出处链接 · 看到它的时间 · 来源更新时间 · 14 格出处与时间」均可读。

路径墙 DOM 对账（summary 文本字符数）：

| Cell | qa@5 旧 summary | implement@6 新 summary | 新 summary `/items/` | 折叠体 `from` 对账 |
|---|---:|---:|---:|---:|
| `/next_candidates` | 927 | 8 | 0 | 50/50 |
| `/gaps` | 952 | 8 | 0 | 20/20 |
| `/batches` | 243 | 8 | 0 | 10/10 |
| `/founder_items` | 190 | 8 | 0 | 5/5 |
| `/done_definition` | 71 | 8 | 0 | 0/0 |

五个折叠体都存在 `audit-cell` 与 `rule-note`；新 summary 合计 40 字符，旧值合计约 2,383 字符。`done.v1` 的 `from` 按合同为空数组，仍在折叠体显示规则与默认规则声明。

性能边界同步落在 `implementation-notes.md` 与 PR body：当前实现为每子单同步 N 读；今天 5–30 张约 7–40ms；约 200 张、约 2.4 万条 session 相关行时约 1.4s，会明显痛；异步/批量化由 FLY-2143 承接。Markdown 原始 HTML 不转义、当前只由终端消费的边界也如实记录，本轮依正式 Lead 冻结范围不扩代码。

implement@6 本地全仓门：

```text
$ pnpm lint
Checked 2757 files. No fixes applied.
Found 14 warnings.
exit 0

$ pnpm -r build
Scope: 22 of 23 workspace projects
packages/teamlead build: Done
exit 0

$ pnpm test:packages:run
packages/core: 1 failed | 19 passed files; 2 failed | 219 passed tests
两项仍是 test/tmux-viewer.macos.test.ts 的真实 Terminal.app Apple Events，
宿主返回 Connection Invalid / osascript syntax error；recursive first-fail 截停。

$ pnpm exec vitest run src/epic-page/__tests__ \
    src/bridge/__tests__/epic-page-route.test.ts \
    src/bridge/__tests__/linear-epic-query.test.ts \
    src/__tests__/statestore-epic-page.test.ts
Test Files 10 passed (10)
Tests 113 passed (113)
```

本分支相对 `origin/main` 没有新增 `scripts/__tests__/*.test.sh`。最终提交头仍由 GitHub Linux CI 与 fresh exact-head cross-family code review 门禁。

## 12. founder 二次返工：取消批次，Linear 实时算 ready

2026-09-03 founder 明确取消「批次」模型。经 Lead 两次裁定后，当前实现以 Linear 为唯一排程事实源：范围是绑定边界内全部 `state.type=started`、有子单的顶层父单子树，并要求其中存在标题含「日常」的常驻父单；展示时过滤 Backlog 子单。没有活动父单、没有日常父单、父单在遍历中不可读或分页无法证明完整时均显式失败，不回退到整个 Linear Project。

现行 `ready.v1` 只做实时计算，不落库：候选必须在范围内、未完成且未取消、不是 Backlog，并且所有 `blocked_by` 的 Linear 状态都严格为 `completed`；最后只按 Linear priority `1 → 4 → 0`、再按 identifier 排序。账面 session/run/attempt/land 不再改变 ready 顺序。依赖卡面改成「等谁 / 谁在等我」，两侧都显示 issue 编号与标题；反向「谁在等我」由全部 `blocked_by` Cell 按 `dependents.v1` 推导并写出完整输入路径。

页面仍保留一单一卡：编号、标题、状态、是什么、为什么、做完你看到、执行上下文、founder 标记，以及卡底一行来源链接、观察时间、来源更新时间。14 个 item Cell 的完整审计信息仍在卡底原生 `<details>` 中。顶部顺序固定为「现在可以开始的」→「当前执行范围」→ founder/done/gaps → 子单卡；产品 HTML 中不再出现批次分组、批次徽章或 `data-batch`。

持久化边界同时收窄：`epic_page` 只作为 write-only render receipt，主键为 `(project_name, version)`，只存生成时间、触发方式、source digest，以及每个 Linear/StateStore 来源的 path/provenance/observed_at/source_updated_at。它不存页面 value、`ready_items`、next、batch 或任意计算顺序；路由没有读取回执的代码路径，JSON/Markdown/HTML 每次都重新查询 Linear。旧整页表启动时在单事务内提取来源为新回执，成功后删除 legacy 表；坏迁移会整体回滚。存储入口递归拒绝计算顺序字段和指向 `/ready_items` 等计算结果的来源路径。

TDD 与回归证据：

- StateStore 回执先得到旧三列主键红灯；实现后新库写入/20 版裁剪、文件库重启、旧整页表迁移、计算顺序字段与路径拒绝全部通过。
- 路由先得到「无 Epic 输入返回 `invalid_epic`」红灯；实现后只接受 `projectName` 与 `format`，旧 `epic`/`version` 选项显式返回 `unsupported_option`，三种格式各自重新 fetch，19/19 通过。
- Linear scope 用 Backlog blocker 先得到 `inScope:true` 红灯；修正后 Backlog 已排除于范围，6/6 覆盖递归子树、三层分页、缺日常、父单消失与不完整分页。
- Epic Page 模型/规则/生成/渲染/转义/演练、StateStore、路由、Linear scope 联合为 10 files / 100 tests；CLI 为 1 file / 8 tests，全部通过。`flywheel-teamlead` 与 `flywheel-comm` TypeScript 全包检查均通过。

fixture 产品 HTML `/private/tmp/fly2140-ready.html` 为 50,617 bytes，静态核验为 5 张 `item-card`、5 个依赖块、2 个 ready pill、2 个 active-root pill、零 `<table>`、零 `data-batch`、零「批次」。Chromium 截图再次被 macOS MachPort rendezvous 以 1100 拒绝；临时下载到 `/private/tmp` 的 WebKit 也在启动时收到 Abort trap 6；临时安装的 WeasyPrint 69 因宿主缺 `libpango-1.0` 无法启动。因此本轮没有伪造新的截图，视觉证明限定为已人工核对的产品 HTML/CSS 与上述可执行结构断言。仓库内旧 PNG 仅是第 11 节历史基线，不代表当前无批次页面。

全仓精确 `pnpm lint` 已执行，但被本分支未修改的既有文件挡住：`doc/engineer/research/new/FLY-1547-e2e`、`doc/engineer/research/new/FLY-1563-e2e`、`scripts/qa-fly-2007-phase0-*` 等。当前变更的 24 个可处理文件单独执行 Biome 为零诊断；`StateStore.ts` 因仓库配置的 1 MiB 上限由 Biome 跳过，但 TypeScript 与相关执行测试覆盖通过。

## 13. 当前头的精确仓库门

在实现提交 `9fca0f39a` 与证据提交 `6aa8963fe` 后执行了角色要求的原样命令：

| 命令 | 结果 | 与本任务的关系 |
| --- | --- | --- |
| `pnpm lint` | exit 1 | 9 errors / 14 warnings 均来自本分支未修改的 FLY-1547/1563/2007 等既有文件；本次 24 个可处理文件单独 Biome 零诊断。 |
| `pnpm -r build` | exit 0 | 22/23 workspace package 完整构建通过，含 teamlead 与 flywheel-comm。 |
| `pnpm test:packages:run` | exit 1 | recursive first-fail 在 core 两条真实 Terminal.app Apple Events 用例失败；同轮 config 枚举在全仓并发下超过 5 秒。两类均不触及本次文件。 |
| 新 `scripts/__tests__/*.test.sh` | 无 | 相对 `origin/main` 没有新增 shell test。 |

为避免 recursive first-fail 掩盖本次改动，另跑的 10 个 teamlead 相关测试文件为 100/100，通过；flywheel-comm Epic Page CLI 为 8/8，通过；两个受影响 package 的 typecheck 均 exit 0。额外的 flywheel-comm 全包并发运行里，本次 CLI 仍为 8/8，但该包其它真实 Git/进程组/E2E 用例出现 5–30 秒宿主时限失败，和全仓门中的宿主约束一致。最终 Linux 全量结论以本提交头的 GitHub CI 为准。

## 14. 接任 implement 节点的 exact-head 复核

2026-09-03T22:39:04Z，接任节点在干净且已推送的 `a33125fe663e6d92bb53c131f80e9a13aba2ea24` 上重新核对 founder 六项纠偏与 PR #1044。该头的 GitHub CI 已完成且全部成功：Quick Gate、teamlead 三组单测、heavy/light 单测、四组 shell suites、NPM payload 与最终 `CI OK` 均为 `SUCCESS`。

Lead 因宿主当前高负载明确要求只跑受影响的定向测试，接任节点据此没有重复启动本机全仓并发门，而是重新执行以下精确范围：

```text
$ pnpm --filter flywheel-teamlead exec vitest run \
    src/epic-page/__tests__/model.test.ts \
    src/epic-page/__tests__/rules.test.ts \
    src/epic-page/__tests__/generate.test.ts \
    src/epic-page/__tests__/drill.test.ts \
    src/epic-page/__tests__/render.test.ts \
    src/epic-page/__tests__/escape.test.ts \
    src/epic-page/__tests__/labels.test.ts \
    src/bridge/__tests__/linear-epic-query.test.ts \
    src/bridge/__tests__/epic-page-route.test.ts \
    src/__tests__/statestore-epic-page.test.ts
Test Files  10 passed (10)
Tests  100 passed (100)
exit 0

$ pnpm --filter flywheel-comm exec vitest run \
    src/commands/__tests__/epic-page.test.ts
Test Files  1 passed (1)
Tests  8 passed (8)
exit 0
```

复核结论限定到可执行证据：生产模型无 `batch` / `batches` / `batch.v1`；`ready.v1` 只读 Linear state、priority 与 `blocked_by`；active started 顶层父单子树必须包含「日常」且过滤 Backlog；每张卡同时展示「等谁 / 谁在等我」；所有 Cell 保留 provenance 与 `observed_at`；`epic_page` 只写 source-only receipt，route 不从它回读页面。下一道门是这个文档提交后的 fresh exact-head cross-family code review 与新头 CI。

## 15. code review 阻断修复：合法 Linear children filter

精确头 `2268138e203342dcafe1bc538c1687406919389e` 的 cross-family code review（request `d016ef68-59f4-432e-90f2-195b85d68a5b`）返回 `CHANGES_REQUESTED`。唯一 HIGH finding `linear-scope-filter-invalid-children-null` 指出 ActiveScopeRoots 的 `children: { null: false }` 不属于 Linear `IssueCollectionFilter`，真实 GraphQL 变量校验会拒绝请求。

本地安装的 `@linear/sdk` 声明核对结果：`IssueCollectionFilter.children` 的类型仍是 `IssueCollectionFilter`，该类型有 `length?: NumberComparator` 而没有 `null`；`NumberComparator` 明确支持 `gt`。按 TDD 先把现有 filter 形状断言改为 `children: { length: { gt: 0 } }`，得到 1/6 红灯，diff 精确显示 received `null:false` / expected `length.gt:0`；生产 filter 做同一处最小修改后，该文件 6/6 变绿。

随后使用当前环境的真实 `LINEAR_API_KEY`，向 Linear 提交与生产 ActiveScopeRoots 相同的 `$filter: IssueFilter!` 查询和修正后的输入。网络请求 exit 0，返回 `{"schemaAccepted":true,"rootCount":0,"hasNextPage":false}`；这证明修正后的输入已通过真实服务端 schema coercion。`rootCount:0` 是执行时 Linear 中没有同时满足 started、顶层、有子单的根单，不被写成完整页面生成成功。第一次 `tsx -e` 尝试在本地 CJS 转换阶段因 top-level await 被拒，未发出网络请求；改成 async IIFE 后才得到上述真实响应。

修复后的定向验证：

```text
$ pnpm --filter flywheel-teamlead exec vitest run \
    src/epic-page/__tests__/model.test.ts \
    src/epic-page/__tests__/rules.test.ts \
    src/epic-page/__tests__/generate.test.ts \
    src/epic-page/__tests__/drill.test.ts \
    src/epic-page/__tests__/render.test.ts \
    src/epic-page/__tests__/escape.test.ts \
    src/epic-page/__tests__/labels.test.ts \
    src/bridge/__tests__/linear-epic-query.test.ts \
    src/bridge/__tests__/epic-page-route.test.ts \
    src/__tests__/statestore-epic-page.test.ts
Test Files  10 passed (10)
Tests  100 passed (100)
exit 0

$ pnpm --filter flywheel-teamlead typecheck
exit 0
```

同轮 MEDIUM/LOW findings（空验收标题、Markdown destination 健壮性、dependents 非空断言）按 review policy 属于 advisory，不改变本轮 HIGH 阻断修复的锁定范围；已保留给 Lead 评估后续任务。

## 16. Lead 裁决后的三项审查返工

Lead 随后把三项 advisory 裁入本单。本轮保持 pinned `plan.md` 不变，并逐项重新执行 RED → GREEN：

- 空验收：先新增「验收标题存在、正文只有空白」用例，现实现返回 `{ text: "", truncated: false }`，得到 rules 1/18 预期红灯；在 trim 后增加空字符串守卫，回归为 18/18。既有 `computeGaps` 用例继续证明 `acceptance.value = null` 会产生 `no_acceptance_section` 缺口。
- Markdown link destination：先把 Linear URL 改为含括号的 `a(b)-title`，新用例期望 CommonMark 角括号目标，现实现输出裸 `(...)`，得到 render 1/11 预期红灯；`markdownLink` 最小改为 `(<...>)` 后回归为 11/11。
- Linear filter 编译期约束：先给 `activeScopeFilter` 加上 type-only `LinearDocument.IssueFilter` 返回类型，再以先前错误的 `children: { null: false }` 做 mutation RED。`pnpm --filter flywheel-teamlead typecheck` 精确报 `TS2353: 'null' does not exist in type 'IssueCollectionFilter'`；恢复 `children: { length: { gt: 0 } }` 后 typecheck exit 0。无效 filter 只用于 RED 证明，未保留在工作树。

返工后的低负载定向回归（遵循 Lead 不跑整包的机器负载指示）：

```text
$ pnpm --filter flywheel-teamlead exec vitest run \
    src/bridge/__tests__/linear-epic-query.test.ts \
    src/epic-page/__tests__/rules.test.ts \
    src/epic-page/__tests__/render.test.ts \
    src/epic-page/__tests__/generate.test.ts
Test Files  4 passed (4)
Tests  49 passed (49)
exit 0

$ pnpm --filter flywheel-teamlead typecheck
exit 0

$ pnpm exec biome check <5 changed TypeScript files>
Checked 5 files. No fixes applied.
exit 0
```

`ready.v1` 的既有定向测试仍覆盖空 blocker 与全部 blocker 已 `completed` 均 ready、任一 blocker 未完成则不 ready。可选的 dependents 非空断言没有在本轮强改：当前生成器先从非空 Linear snapshot 字段构造 title/url/state Cell，若要移除断言，必须新增「内部构造 invariant 被破坏时抛错还是丢弃 dependent」的模型语义与失败路径，已超出 Lead 所说的“顺手改”边界；此处与 PR body 都显式记录该处置。

## 17. Lead instruction 7cdf：规模边界与生产前置条件

QA 的 60-item 页面超过 512 KiB 后，代码追踪定位到 `dependents.v1` 的 O(n²) 来源串：生成器给每一张卡的 `blocks.provenance.from` 都写入全体 N 个 `/items/N/blocked_by` 路径，HTML 又在卡面与折叠审计中重复渲染。无依赖的 60-item 合成页稳定复现为 770,804 bytes。

按 Lead 明确允许的边界，`dependents.v1.from` 改为只列真正产生该 dependent 的 `blocked_by` Cell 路径；值、依赖方向、排序、ready 判据与时间戳均不变。先新增 60-item `≤ 512 * 1024` 回归得到 770,804 > 524,288 的预期红灯；最小修复后该用例转绿。原 golden 测试也先因旧的全路径断言红灯，再收紧为真正参与 EPX-1 下游推导的精确路径 `/items/1`、`/items/2`、`/items/3`，generate + render 为 26/26。

同一无依赖形状的修复后量测：

| 子单数 | HTML bytes | `dependents.v1.from` 路径总数 | 托管结论 |
| ---: | ---: | ---: | --- |
| 60 | 457,364 | 0 | 低于 512 KiB，可进入 publish-report |
| 200 | 1,513,873 | 0 | 高于 512 KiB，保留 CLI 的明确超限警示 |

格式化后的最终定向门为 4 files / 50 tests 全绿，`flywheel-teamlead` typecheck exit 0，7 个变更 TypeScript 文件的 Biome check 零诊断，`git diff --check` exit 0。

生产 Linear 的显式前置条件：截至 2026-09-03，真实 ActiveScopeRoots 查询虽然已通过 schema coercion，但返回 0 个符合条件的根单，因此生产今天不能生成页面。操作者必须先把目标 Epic 拖到 **In Progress**（Linear `state.type=started`），并在同一绑定范围建立一个标题含「日常」且有子单的 started 顶层父单；两项满足后才有可生成的 active scope。该限制同步写入 PR body 与最终 milestone，不把 `rootCount:0` 误写成页面生成成功。
