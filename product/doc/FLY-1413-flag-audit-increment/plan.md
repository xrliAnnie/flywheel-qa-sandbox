# FLY-1413 新增开关补审 — 实施计划

Issue: FLY-1413 (https://linear.app/geoforge3d/issue/FLY-1413/flag治理清存量-55-个新增开关补审-逐条圈选留清动态化像-fly-1136-那批)
日期: 2026-07-22
基于: research.md

## 0. 交付物清单

全部落在 `product/doc/FLY-1413-flag-audit-increment/`,随分支走 PR。**零生产代码改动**(`packages/` / `scripts/` 一行不碰)。

| 文件 | 内容 | 性质 |
|---|---|---|
| `exploration.md` / `research.md` / `plan.md` | 过程文档 | 已完成 |
| `extract.mjs` | 从 registry + 生产配置抽机器事实 | 复用 FLY-1136,加 runtime-hard-off / dead-by-dependency / processOwners 三样 |
| `baseline-fly1136.json` | 钉住的 103 条基线名单 | 决定审计范围;extract 用 `git show` 回验它没被改过 |
| `snapshot.json` | 148 flag 的机器事实 + 增量集合 | 生成物,可复现 |
| `evidence-bridge-health.json` | 活 Bridge `/health` 的 `retiring[]` 抓屏(带时间) | 死壳判定的旁证,落盘可复核 |
| `flags-data.js` | 62 条人话判断 + 建议桶 | **本单主要人工产出** |
| `build-html.mjs` | 拼装 + 硬门 + 渲染 | 复用 FLY-1136,改三桶 + 分组排序 + 完整 doc |
| `flag-audit.html` | Annie 逐条圈选页 | 生成物 |

## 1. Step 1 — extract.mjs 加三张覆盖表

**为什么必须加**:不加的话 `park_watch` 会被报成「ON(默认)」,而运行时它恒关(research §3)。现状写反了,整张表就废了。

照抄 FLY-1136 `ACTIVATION_OVERRIDES` 的可复核写法,新增:

```js
// ① 运行时政策硬关:env 值无法复活的巷道。每条必须带取证点。
const RUNTIME_HARD_OFF = {
  checkpoint_watchdog:       { reason, evidence },
  legacy_delivery_watchdogs: { reason, evidence },
  park_watch:                { reason, evidence },
};
// ② 自己没被硬关、但唯一消费者接在死巷道后面。`chain` 是从读点追到根的链路,
//    强制必填 —— 写不出链条就 throw(第一轮我对 delivery_ack 只看描述就归错了桶)。
const DEAD_BY_DEPENDENCY = {
  park_watch_cadence:   { via: "park_watch",                chain: "…" },
  delivery_ack:         { via: "legacy_delivery_watchdogs", chain: "…" },
  // …共 10 条
};
// ③ 读它的是哪个进程(Codex R1 HIGH-2)。控制台的秒切只改跑着的 Bridge 自己的
//    process.env,所以 Runner / 守护进程 / CLI / shell 里的 call-time 读点
//    不会因为「改个分类」就变热。按路径前缀派生,最长前缀优先。
const PROCESS_OWNER_BY_PREFIX = [ … ];
```

- 三张表加载时都断言 flag 名存在于 registry 名字集合,写错名字 → `throw`。
- `DEAD_BY_DEPENDENCY` 额外断言 `via` 必须真的在 `RUNTIME_HARD_OFF` 里、且 `chain` 非空。
- 覆盖表**只加字段,不改 `configured` 原值** —— 两个事实并排放,读者能看到「配置说开着 / 运行时其实关着」这个差异本身。
- 基线 `baseline-fly1136.json` 用 `git show dc62daac:<原路径>` **回验**;对不上直接 throw(基线一改,审计范围就变)。git 取不到时(分支没 fetch)记 `verifiedAgainstGit:false` 并 warn,不假装验过。
- 写完 snapshot 后用 `pnpm exec biome format --write` + 一次 `check` **回验**,让重跑 extract 之后 `pnpm lint` 仍然是绿的(裸 `JSON.stringify` 不满足仓库格式化规则;注意不能用 `npx biome`,在本 worktree 它会静默什么都不做)。

## 2. Step 2 — flags-data.js:62 条人话

每条的结构(和 FLY-1136 同构,`bucketSuggest` 换成本单三桶):

```js
{
  name: "park_watch",
  group: "clear",                    // 排版分组
  bucketSuggest: "clear",            // clear | dynamize | keep | unknown
  kind: "bool",                      // bool | knob | enum —— 决定给哪几个选项
  plain: {
    on:  "开着=……",                  // 人话,非工程黑话
    off: "关了=……",
    why: "为啥现在这状态=……",         // 读不出就写 UNKNOWN + 要问谁
  },
  leadOpinion: "……",                 // 可选
  premise: "……",                     // 可选:选「清」的前提条件
  deadKnob: true,                    // 可选:旋钮但喂死巷道 → 恢复「清」选项
}
```

**硬规矩**:
- 「为什么是这个状态」读不出来的**写 UNKNOWN 并写清要问谁**,不编。已知 2 条(`cmux_linked_view` 读不出原因;`quota_daemon_cutover` 退役条件没取证)。
- 人话三句里不出现 `call_time` / `object_construction` / `admission` 这类词;技术细节放「改了怎么才生效」那一列和注册表原文。
- `flags-data.js` **绝不复制机器事实**。`kind` 看似人工字段,其实是 registry 的 `valueKind`,所以由门 3c 强制两者一致(Codex R1 MEDIUM-1)。

### 建议桶分配(62 条,互斥划分)

分两层,别混:**分组**(排版用,互斥划分)和**建议**(每条的预选值)。**两者各有一道断言**(Codex R1 MEDIUM-1:只断言分组会让建议悄悄漂,而建议才是 founder 真正据以行动的数字)。

| 排版分组 | 数量 | 说明 |
|---|---|---|
| `clear` | 14 | 13 个死壳(research §3)+ `quota_daemon_cutover` |
| `dynamize_f`(读点已就位) | 14 | research §4 F 组 |
| `dynamize_e`(要改读点) | 9 | 含 `cmux_linked_view` |
| `dynamize_knob`(数值) | 3 | 4 个签收旋钮已因死壳判定移进 `clear` |
| `keep_*` | 22 | 已可秒切 15 + 治理门 2 + per-project 1 + 已按次生效 2 + QA 专用 1 + 路径配置 1 |

| 预选建议 | 数量 | 与分组不一致的地方 |
|---|---|---|
| 清 | 13 | |
| 动态化 | 25 | |
| 留 | 22 | |
| 不确定 | 2 | `cmux_linked_view`(在 dynamize_e 组)· `quota_daemon_cutover`(在 clear 组)|
| 合计 | **62** | |

另加 4 条未登记变量单列一节,不计入 62 —— 页面共 **66** 张卡。

13 个「清」的依据是 research §3 的死壳取证,**每条都带一条从读点追到 hard-off 根的链**(写不出链条 extract 就 throw)。`quota_daemon_cutover` 虽然排在 clear 组,但**预选「不确定」**:它自己写明的退役条件(稳定 ≥1 周)我没取证,不给 founder 一个前提没验过的预选结论。

「留」里有 3 个要写清限定:`workflow_template_dispatch` / `workflow_claims_write` / `workflow_claims_read` 都是 opt-in 却已在生产打开,按「已全量 → 清」的定义像清理对象;但它们是 FLY-1344 明确交给 founder 控制的 DAG 杆,而 v2 那半(`workflow_generalized_templates`)还关着 = **上线在半途**。现在退休开关等于在上线中途把方向盘拆了。→ 建议**留**,并在卡片写明「DAG v2 上线收尾后转清」。

## 3. Step 3 — build-html.mjs

在 FLY-1136 版基础上改五处:

1. **三桶选项,按类型给不同选项集**(Tadashi 要求):
   - `kind: "bool"` → 留 / 清 / 动态化 / 不确定
   - `kind: "knob"`(数值+路径)→ 留(继续可调) / 动态化(免重启可调) / 不确定 —— **不给「清」**
   - `kind: "enum"` → 除三桶外,额外给「定一个赢家、其余删」
   - 例外 `deadKnob: true`:旋钮但喂的是死巷道,**给「清」**并在卡片标 💀。
2. **按建议桶分组排序**,每组开头一句「这组我为什么这么建议」。组内按「生产被显式设过的排前面」排。
3. **多一节:4 个未登记变量**(research §5),不计入 62,而且**按三类给不同选项**:内部运维杆问「转正吗」,刻意不登记的接缝**不提供「补登记」**(Codex R1 HIGH-3)。
4. **输出完整 doc**:`<!DOCTYPE html><html lang="zh-CN">…</html>`。FLY-1136 那版是裸 `<head>` 开头,发布会 400。
5. **决定绑事实版本**(Codex R1 HIGH-6):`注册表哈希 + 基线 commit + 条数` 拼成一个版本串,写进 localStorage 键和导出 markdown 抬头 —— 重出一版旧勾不串,下游执行单能核对。

硬门 10 道:

| # | 门 | 说明 |
|---|---|---|
| 1 | flags-data 名字唯一 | 复用 |
| 2 | **名字集合 === `snapshot.newSinceBaseline`** | 不是「=== 整个 registry」——本单审的是增量(Codex R1 BLOCKER-1) |
| 3 | 分组计数 === 声明划分 | 复用 |
| 3b | **建议桶计数 === 声明划分** | 新增:建议才是 founder 据以行动的数字 |
| 3c | **`kind` === registry 的 `valueKind`** | 新增:防机器事实被手抄跑偏 |
| 3d | **snapshot 判定为死的,必须建议「清」** | 新增:死开关绝不能显示成「留」或「动态化」 |
| 4 | registry 内容哈希 === snapshot 记的 | 复用 |
| 5 | 内联 `<script>` 能 parse | 复用(用 `vm.Script` 只编译不产生可调用体) |
| 6 | **每个 `<script>` 都带 `nonce="__CSP_NONCE__"`** | 新增 |
| 7 | **`prefers-color-scheme` 计数 === 0** | 新增 |
| 8 | **输出是完整 doc** | 新增 |
| 9 | **卡片数 === 62 + 4** | 新增 |
| 10 | **事实版本占位符已替换且真值在页内** | 新增:静默没替换 = HIGH-6 白做 |

门 6/7 把「发布前手跑 grep」这条一直靠人记的规矩**变成构建期自动失败** —— 这条规矩已经漏过两次(FLY-1045、FLY-1311),不该再靠记忆。

交互沿用 FLY-1136 已验证的那套:按建议**预选** + 只有她点过才算「已过目」+ 每条 textarea + `localStorage` 自动存 + 底部一键复制 markdown + 下载 `.md`。导出里没过目的标「未过目」。

## 4. Step 4 — 自验(交给 Lead 之前)

| 检查 | 做法 | 通过标准 |
|---|---|---|
| 管线可复现 | 重跑 `extract.mjs` + `build-html.mjs` | 两次产物**除 `capturedAt` 那一行外逐字节相同**(比较前把该行规范化掉);snapshot 的 `registryContentSha256` 不变 |
| 硬门真的会失败 | 阳性对照:逐门制造一次违例各跑一次,**用 `$?` 直接取 node 的退出码**(别经管道,`head` 会吞掉它) | 每门 exit≠0 且打印对应门名;**跑完还原并比对** |
| 覆盖率 | 门 9 已自动化 | 66 张卡 |
| 无密钥 | **诚实口径(Codex R2/R3 两次纠正)**:布尔型按语义折算成 true/false,不落原值;但 `value` / `enum` 型**原样落进 snapshot,而且会显示在页面上**(在审的 62 条里就有 —— 比如 `skill_framework_mode` 显示 `split`,数值旋钮显示秒数,`delivery_secret_path` 显示默认路径)。**没有做脱敏**,理由是这些不是凭据。真正的保证是:extract 只读 `FLYWHEEL_*` 键、只序列化 registry 已声明的字段,不碰任何 token/secret 类变量;交付前再人工扫一遍现值 | snapshot 与 HTML 内无真实凭据 |
| 浅色 + nonce | 门 6/7 已自动化,再手跑一次 grep 复核 | 计数符合 |
| 无外链 | `grep -oE "https?://[^\"']+"` | 页面零外部资源(CSP 友好) |
| 真机渲染 + 交互 | 本地 http 起页,用浏览器验:预选、"已过目"计数只在点击后增、旋钮无「清」、死旋钮有「清」、漂移三类选项不同、导出 markdown 分桶正确且带事实版本 | 全部符合 |
| 全仓 lint | `pnpm lint` | exit 0(仅剩仓库既有的 17 条 warning) |

## 5. Step 5 — 交付

1. commit 到分支 `flywheel-FLY-1413`,开 PR。
2. 走 `codex:rescue` 设计评审(本文件)与代码评审(生成器 + 数据文件)。
3. **不 publish、不直投 Annie**:把 `flag-audit.html` 的路径 + 自验结果经 `flywheel-comm ask` 交给 Lead;由 Lead review → publish → 投进 FLY-1413 thread → 陪 Annie 圈。
4. Annie 圈完 → 按桶拆执行单(删除单独成单、隔离审,像 FLY-1240–1243)。**本单不下删除结论、不改任何 flag。**

## 6. 风险与明说的限制

| 风险 | 处理 |
|---|---|
| 审计期间 registry 又涨了 | 门 4(内容哈希)会直接失败,强制重跑 extract。**这是特性不是障碍**:总数从 138(7-21)涨到 148(7-22),两天 +10,交付当天很可能再变。导出的决定带事实版本,下游能核对。 |
| 把「注册表分类是 readonly」误读成「技术上做不到」 | research §4 区分了 F 组(分类问题)与 E 组(真读点问题),并额外用 🔌 标出跨进程那 12 个 —— 那些改分类也不会热。 |
| 死壳判断错了会误删 | 13 条每条都有**终点取证**(调用点恒 undefined / 返回类型写死 `false` / 与式左半恒假),外加落盘的活 Bridge `/health` 旁证。而且本单**不执行删除**,只出建议;真删走独立执行单 + 独立 QA。 |
| **同根因下漏扫其他分支**(本单真实发生过) | 第一轮只追了 `park_watch` 就以为覆盖完,`delivery_ack` 那 6 条按注册表描述归了错桶,Codex 设计评审抓出来。现在 `DEAD_BY_DEPENDENCY` 每条**强制带链**,门 3d 再兜一层:snapshot 判死的必须建议「清」。 |
| 「配置值」被当成「运行时活值」 | 卡片那栏改叫「配置里写的值」,页面顶部醒目写明两者可能不一致(research §8.1)。 |
| 62 条人话质量参差 | 注册表的 `description` / `note` 多数写得挺细,人话以它为底改写;读不出的标 UNKNOWN 而不是硬凑。 |
| 我没独立验证运行时行为 | 卡片统一标「运行未独立验证」(死壳那 13 条除外,它们有取证)。工程事实以 Tadashi 为准。 |
