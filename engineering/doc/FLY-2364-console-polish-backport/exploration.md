# FLY-2364 管理台 8 条 polish 合回生产 — 探索

Issue: FLY-2364 (https://linear.app/geoforge3d/issue/FLY-2364/2356p0-把原型里已改好的-8-条-polish-合回生产管理台9876dag-节点中文-label-按-nodetype-取色)
日期: 2026-09-05
基于: 无

## 0. 一句话

issue 写的「生产 `:9876` 一字节没动」已经过时:FLY-2257(PR #1054,2026-09-03 合入,生产 Bridge 当前 build `79f6fc39b` 已包含)把原型的大部分内容落进了生产 `fleet-console-html.ts`。今天在 `:9876` 逐条实测,**8 条里 5 条已在生产,本单实做剩下的 4 处小改**(A3 的「有次数才写」、A4、B6、D),已做的 5 条只出证据不重做。Lead(Tadashi)2026-09-05 已同意这个范围。

## 1. 先核事实:三个地方各是什么状态

| 位置 | 状态 |
|---|---|
| 原型分支 `flywheel-FLY-2071`(PR #1030,标「请勿合并」) | `console-next-html.ts` 1155 行,是从 `fleet-console-html.ts` **527 行的旧基线**整份复制后改的;分支从 `f43d01cd4` 分出,之后没有再跟 `main` |
| `main` 的 `fleet-console-html.ts` | 712 行。自那个基线起被 4 个 PR 改过:FLY-2121(#984 节点显示名)、FLY-2238(#1025 模型权威)、**FLY-2257(#1054 DAG 图 / 花名册 / Flag 语义)**、#1080 |
| 生产 `:9876` | Bridge `buildSha=79f6fc39b`,包含上面全部 4 个 PR;`/console-next` 404(原型从没部署过,本来就不该有) |

⇒ `console-next-html.ts` 只存在于一条从未合入的分支上,`main` 上没有它。**「两份长期并存」这个风险在 `main` 上不存在**,要防的只是有人把它合进来。

## 2. 设计段要先定的那件事:合回还是取代

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 合回(选它)** | 把原型里还没落地的改动,按 `main` 当前代码的结构手工移进 `fleet-console-html.ts`;`console-next-html.ts` 永不进 `main` | 唯一可行。`main` 的文件已经吸收了原型 70% 以上的内容并继续演进(schema 版本握手、`canonicalModel`、`consequenceCopy`、`data-tone` 合同、去 `renderRoles`),原型文件缺这些 |
| B. 取代 | 用 `console-next-html.ts` 覆盖 `fleet-console-html.ts` 并删旧文件 | 否决:会把 FLY-2121 / FLY-2238 / FLY-2257 / #1080 落进生产的改动整体回退;原型还依赖两个只在原型服务上存在的只读口 `/api/console-next/templates`、`/api/console-next/flagmeta`(生产 Bridge 没有,而且 FLY-2257 测试明写禁止出现这两个路径);原型 `post()` 被改成拒绝写入 |
| C. 两份并存 | 挂 `/console-next` 路由 | issue 明令禁止 |

## 3. 逐条对账(今天 `:9876` 实测,1600×1000,console/pageerror 均为 0)

三栏是 Lead 要求 QA 按栏验收的口径:**FLY-2257 已做 / 本单做 / FLY-2257 明写不做但本单做**。

| # | 条目 | `:9876` 今日实测 | 归属 | 本单动作 |
|---|---|---|---|---|
| A1 | 节点用后端中文 label,无则退回 id | 9 个工程节点名全是中文(设计(工程)/实现/QA 验证/创始人门/合入);「founder gate」英文 0 处 | **2257 已做**(label 退回逻辑在后端 `workflowNodeDisplayLabel`:`label → 历史映射 → id`) | 只出证据 |
| A2 | 按 `node.type` 取色 | 工程页 design/implement/qa 三种边框色两两不同(`rgb(212,207,247)` / `rgb(200,227,247)` / `rgb(200,232,209)`),产品页 generic 为白底灰边,合计 4 种 | **2257 已做**(CSS `.dag-chip.<type>`) | 只出证据。说明:「同屏 4 种」在生产上是**跨产品/工程两个分页**各量一次得到的,不是一屏 |
| A3 | 删「不限次」;后端给了次数才写 | 「不限次」0 处 ✅;但回环线上**没有任何文字**(4 条 loop path,0 个 text) | **半做**:编造文案已删;「有次数才写次数」没有载体 | **本单做**:给回环加后端拥有的显示名,`maxIterations` 是数字才追加「×N」 |
| A4 | 标出「模板绑定」的模型 | `.bind-tag` 0 个 | **2257 §8 明写不做** | **本单做** |
| A5 | 说明只写一次、写给 founder | 区块顶部 `.lay-note` 1 条;每卡下方 `.reason` 0 条;不再提 schema 版本 / role 字段 | **2257 已做** | 只出证据;那一行文案不动(FLY-2257 测试锁了 `lay-note` + `ENG_NODE_TYPES`) |
| B6 | 项目栏去掉与项目同名的分组标题 | 分组标题 **8 个**(6 个与项目同名 + 分组 + 基础设施) | **2257 §8 明写不做** | **本单做**:预期 8 → 2 |
| C7 | flag 原因分类读旁边的 reason | 「系统没有给原因」可见 0 处、「没认出这条原因」0 处;23 个 flag 全部落进「归 flag store 管 13 / 要用命令行改 10」 | **2257 已做**(`read-?only` 正则 + 两种兜底拆开) | 只出证据 |
| C8 | CLI 原文 / 列名 / 「四种」去重 | CLI 原文可见 0 处(只在 10 个 `data-lock-why` 属性里,点开才看);表头 4 列,「类别」0 处;「四种」0 处,顶部动态写「有 2 种」 | **2257 已做** | 只出证据 |
| D | 模型页列头 + 「另有 N 个 Lead 归在…」措辞 | `.lead-head` 0 个,「公司 → 型号 → effort」在 3 个 Lead 行各印一遍;说明仍是「该项目的 Lead 统一展示在 Infra(2 个)」 | 2257 没提(它只做四个改动区) | **本单做** |

对照表其余数字:DAG 有图 ✅(工程页 9 个节点方块、4 条回环 path、卡内 `scrollWidth == clientWidth` 不横滚);Flags 页高 **2214px = 2.21 屏**(23 个 flag);报错 0。

## 4. 一条验收数字对不上,要先说清

对照表写「Flags 页高 ≤ 1.7 屏」,今天是 2.21 屏。原因不是重复文案(重复项全部已清零),而是 FLY-2257 按 founder 2026-09-02 的定义给每行加了「它现在是什么状态」一句和「维持默认 / 已偏离默认」标签,每行约 96px;1.7 屏那个数是 09-01 还没有这句时量的,flag 也从 21 涨到 23。要压回 1.7 屏只能删每行的状态句或说明行,那是把 founder 定的东西删掉,超出 polish。

⇒ 本单默认:**该项改写为「可见 CLI 原文 0 处 + 页高按实际行数如实报数」,不动 Flags 行结构**。已作为非阻塞问题报给 Lead(question `5f911c4f`),Lead 若要压行高再加一个 chunk。

## 5. 边界(founder 2026-09-01 定,本单沿用)

- S1–S5 结构性问题一条不碰。
- 不加板块、不加功能、不加写路径、不加路由、不加 flag。
- 后端只允许**追加一个只读字段**(回环显示名,见 research §3),不改 schema 版本(纯追加,老页面忽略、新页面缺省退回 id)。
- 原型分支 `flywheel-FLY-2071` / PR #1030 的去留不归本单。

## 6. 复测尺子的可用性(设计段已跑通)

- Playwright MCP 在 runner 环境不可用(socket 目录 109 字节超限,已知坑),改用全局 `~/.npm-global/lib/node_modules/playwright`(1.58.1)+ 本机 `chromium_headless_shell-1234`,`TMPDIR=/tmp/fly2364` 缩短路径后可稳定跑。
- 尺子脚本已写好并产出上表全部数字(`evidence/ruler.mjs`,只发 GET;任何非 GET 请求都计为失败)。
- FLY-2257 留下的 `evidence/harness.mjs` 能用 `dist` 里的 `getFleetConsoleHtml()` + 内存 snapshot 起一个 `127.0.0.1:18857` 只读服务,合入前可以在它上面复测;合入部署后再在 `:9876` 上复测一次进 ship report。
