# FLY-2786 语音架构讨论页 — 实施计划
Issue: FLY-2786 (https://linear.app/geoforge3d/issue/FLY-2786/语音架构讨论页-founder-亲测语音延迟大漏听要一页可互动-html现在三种模式随身语音-rg-耳机模式-会议)
日期: 2026-09-22
基于: research.md

## 1. 交付物

一个自包含的可互动 HTML:`engineering/doc/FLY-2786-voice-architecture-review/founder-voice-architecture.html`,
用 `flywheel-comm publish-report --publish-only` 发布,URL 交 Lead 投递(runner 无投递权限)。
**本单不改任何代码、配置、服务;不开语音会话。**

## 2. 页面结构(自上而下)

| # | 区块 | 内容 | 互动 |
|---|---|---|---|
| 0 | 顶部结论 | 三句:今天慢在哪(实测 38s / 18s + 一段被丢弃)、9 月初为什么快、推荐方向(A,待她拍板) | — |
| 1 | 实测时间线 | 03:05Z 会话两句话的逐段耗时条形图(exploration §2.1 数据),标出「搬运 / 听懂 / Raya 想」三类颜色;漏听那段单列 | 意见框 |
| 2 | 现状图 ① 随身语音 rg | 14 跳流程图(exploration §2 表),每个箭头带 file:line 标签,串/并用实线/虚线,进程用泳道(Discord / 语音进程 / OpenAI / Bridge / Raya);每跳耗时:有实测写实测,否则写常量或「未测」 | 意见框 |
| 3 | 现状图 ② 耳机模式 | 如实画:打字口令 → 读 Discord 文字 → 本机 Edge-TTS;如实标「本机未部署」「桌面试运行版:念到 Mac 扬声器、不进语音房」「语音输入未接」;Bridge 接口存在(`voice-routes.ts:231-319`) | 意见框 |
| 4 | 现状图 ③ 会议模式 | 拆成「已验证共享:语音进程 + Bridge 外层」与「按 Lead 分叉:Raya(Codex sidecar,可引 rg 实测)/ Claude Lead(tmux 收件,全段未验证·未测)」两段 + 会前(meeting.json 起会)/会后(120s tick 派 Runner 写纪要)两段;单独一栏「会议的延迟来源」+「生产从未跑过 → 端到端未测,不与 rg 比快慢」 | 意见框 |
| 5 | 为什么变成这样 | 时间线:08-26 raya 自带脑子 → 09-08 她的 F1–F4 → 09-09 FLY-2446 → 09-22 FLY-2655;每个节点带 SHA/文档出处 | — |
| 6 | 方案图 A 前台快答 + 后台 Raya | 流程图(快路 / 交办路两条分支;快路的留痕行标「拟议·未验证」)+ 明写「要推翻的既有裁定」+ 五栏卡片:延迟预期、记忆能力来源、与 Lead 工作冲突、实现量、风险 | 单选(要 / 不要 / 要但改)+ 意见框 |
| 7 | 方案图 B 9 月初自带脑子 | 流程图(raya 仓 @f669d1b / @b1b5a64 引用)+ 同五栏 | 同上 |
| 8 | 方案图 C 只修管道(对照组) | 流程图(今天的路径,标出能删的等待)+ 同五栏 | 同上 |
| 9 | 她的三个问题 | Q1/Q2/Q3 各一卡:一句话答案 → 依据列表(file:line)→ 标注分「历史实证 / 生产实证 / 当前本机实证(带 as-of)/ 推断 / 未验证」 | 每问一个意见框 |
| 10 | 需要她拍板的事 | ① 是否允许前台自己回答(部分推翻她 09-08 的 F2/F3「每句进 mailbox 由 Lead 答」与 FLY-2655「不得独立回答」);② 前台答错/越权时怎么让她分辨;③ 会议是否要先用 Claude Lead 真跑一场 | 单选 + 意见框 |
| 11 | 复制我的回复 | 汇总所有单选与意见框为一段纯文本,一键复制;复制失败时显示可手选的文本框 | 按钮 |
| 12 | 诚实边界 | n=2 样本;9 月初无逐句留痕;会议未测;哪些是推断 | — |

## 3. 图的画法与标注规则

- **内联 SVG 手画**(发布 CSP 为 `default-src 'none'`、脚本只允许带 nonce 的内联脚本、禁止内联事件属性,`packages/teamlead/src/bridge/report-registry.ts:79-97,207`;不能用 Mermaid CDN)。
- 每个箭头都有一个编号圆点,点开(或悬停)显示「做什么 · 进程 · 串/并 · 耗时 · 依据 file:line」;同一内容在图下以表格重复一遍,保证截图和无脚本环境也能读。
- 读不到代码依据的箭头标「未验证」,耗时没有实测也没有常量的标「未测」。
- 实测数字一律注明来源(会话 id + 表/文件);参考值(/gemini 0.86s)标「另一条管线的参考值」。
- 颜色:按全局 HTML 规范(Apple 浅色,红=阻塞/丢弃,橙=等待/搬运,蓝=信息,绿=快路,紫=Lead 思考);同时给深色模式 token。

## 4. 互动实现

- 每区块一个 `<textarea data-k=…>`;方案/拍板项用 `<input type=radio>`。
- 一段 nonced 内联脚本(publish-report 自动补 nonce),`addEventListener` 绑定;`localStorage` 仅做草稿暂存,全部 try/catch,读不到也能正常用。
- 「复制我的回复」生成:`FLY-2786 语音架构 · 我的意见` + 每个已填项(区块标题 + 选项 + 意见),未填的跳过;`navigator.clipboard.writeText` 失败时退到选中文本框。
- 无外链资源、无字体外链、无图片外链。页面 < 512KiB(publish-report 上限)。

## 5. 验证(发布前 / 发布后)

1. 本地:用浏览器(Playwright 或 headless Chrome)实际打开,截图看每张图有没有叠字、溢出、黑块;320px 窄屏看一次;点「复制我的回复」看输出文本。
2. 自检脚本:扫 HTML 里所有箭头标签,确认每个都有 `file:line` 或「未验证」;抽 10 个 file:line 回仓 `sed -n` 核对。
3. `publish-report --publish-only` 拿 URL → `verify-report --url … --expect "复制我的回复"` 看 HTTP 200 + CSP 合规。
4. 把 URL、截图路径、验证结果写进 `ask --report` 交 Lead,并写明「runner 无投递权限,请 Lead 转投 FLY-2781 thread」。

## 6. 不做什么

- 不改 `packages/voice-*`、不改 `~/.flywheel` 下任何配置、不起/停/重启任何服务、不开语音会话、不跑付费探针。
- 不替她做决定:页面给推荐,但拍板项都留给她。
- 不在页面里写没有出处的数字。
