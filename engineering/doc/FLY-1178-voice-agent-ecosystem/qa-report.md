# FLY-1178 语音 Agent 生态 deep research — QA 报告

Issue: FLY-1178 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: plan.md(验收纪律);findings.md;dr-report.md;research.md

> 三阶段 pipeline 的 QA 阶段独立验证记录。QA 与 implement 是**不同 session**——本报告
> 是对已提交交付物的独立复核,非自证。研究类 issue 零实现代码,验证对象 = 研究报告的
> **引用真实性**(Annie 红线「引用要真实可点,不许编造」)、五问覆盖、双栏格式、scope 合同。

## 0. QA 结论:round 1 FAIL(kickback)→ implement 已修 → round 2 re-verify PASS

**最终 PASS**(round 2 记录见 §11)。round 1 抓到一条引用红线错配并 kickback,implement 精确
修复,QA round 2 独立复核(curl + WebFetch 双证 + 回归不变式)确认修好,无回归、无新问题。
下文 §1-§10 保留 round 1 的完整验证记录(其中 §0 原始 FAIL 判据 + §9 修复指引已被 §11 的
round 2 结果取代)。

**round 1 原始判据(已解决,存档):** 绝大多数维度通过(36/36 URL 200、覆盖矩阵全格、双栏
26/26、scope 干净、结构一致),**但独立复核 + Codex code review 联合抓到一条触碰引用红线的
错配**:

- **HIGH(引用红线):F3.3 的 exact-quote 挂错 URL。** findings.md F3.3 把 raft 的原话
  「one agent is one session: a continuous identity that stays alive across days and
  tasks」标注在 `.../is-having-agents-in-the-room-meant-to-be-chaotic/`(chaos 文章),
  但 QA 独立 WebFetch 确认**这句话不在 chaos 文章里**,而是逐字出现在另一篇
  `.../introducing-raft-where-humans-and-agents-build-together/`。→ 点开 F3.3 的链接找
  不到这句原话,即「引用不可点验」,违反 Annie 红线。**附录 A F3.3 的 VERIFIED 状态因此
  不成立。**(注:quote 本身是 raft 真实原话,非凭空编造,只是 URL 归属错——但对读者等价
  于死引用,必须修对。)

按三阶段 QA 硬纪律(QA 不改 implement 产出,由 implementer 修),verdict = FAIL,详见 §9
修复指引。除此错配外,其余验收全过(§2-§7),修好即可 PASS。

## 1. 验证方法学

| 维度 | 验证手段 | 为什么这样验 |
|------|----------|--------------|
| 引用可点性 | 36 个 URL 独立 `curl -L`(跟随重定向记录终态码) | 附录 B 是 implement 阶段自报;QA 从零重跑,不信自报 |
| 引用内容支持性 | 承重 finding 的 exact-quote 用 WebFetch 打开原页比对 | **URL 可点 ≠ 内容支持论断**——这是「不许编造」最容易被绕过的一层 |
| 引用完整性 | 脚本核对附录 A 的 URL ⊆ 附录 B | 台账里的 claim 来源必须都进健康表,否则有未测 URL |
| 结构一致性 | 脚本核对正文 finding ID ↔ 附录 A 首列 | 每条承重论断必须有台账行,不能有正文无台账的裸论断 |
| 双栏完整性 | 脚本计数正文「技术形态:」vs「产品体验含义:」 | plan §5 硬格式:每条 finding 双栏齐 |
| 覆盖矩阵 | 对照 research.md §7 逐格核对 findings | 五问不能有格子缺失而被静默跳过 |
| scope 合同 | `git diff --name-only` 核对改动范围 | plan §8:仅限 FLY-1178 文档目录,不碰 packages/ |
| Codex code review | 对当前 head 起独立 Codex xhigh review | 第三方独立视角复核诚实性/引用/覆盖(结果见 §8) |

## 2. 引用可点性(Annie 红线)——独立 curl 复测:36/36 全 200

QA 从附录 B 抽出全部 36 个 resolved URL,用 `curl -L -s -o /dev/null --max-time 25 -w
"%{http_code}"`(跟随重定向、带常规 UA)逐个复测。**结果:36 个全部 200,零 DEAD。** 与
implement 阶段附录 B 自报一致。原始复测输出留 `evidence/qa-url-health-recheck.txt`。
(注:F3.3 修复会新增 introducing-raft URL,需并入附录 B 复测——见 §9。)

## 3. 引用内容支持性——WebFetch 抽查:5 条命中原话,第 6 条(F5b.1)命中且顺带暴露 F3.3 错配

DR 原文的引用是 ChatGPT 内部 `citeturn` 占位 token(无 resolved URL,详见 dr-report.md
「执行记录」),claim→URL 映射完全靠 M2 阶段离线用 WebSearch/WebFetch 逐条恢复+人工核验。
**引用真实性完全押在 M2 的恢复质量上**——QA 对最承重、最含 exact-quote 的 finding 独立
重开原页复核:

| finding | 论断里的 exact-quote | 原页复核结果 |
|---------|---------------------|--------------|
| F1.1 | "cannot change after the session has already produced spoken audio" | ✅ 逐字命中(OpenAI Agents SDK realtime guide);handoff 支持亦确认 |
| F1.5 | "Audio input is not supported; it will simply be ignored and stripped from input" | ✅ 逐字命中(Anthropic OpenAI-SDK 兼容页);正文谨慎标为「反向信号」「非'不存在'的证明」,按 §7.1 作推断陈述 |
| F1.3 | "transitions happen transparently within the same run_live() event stream" | ✅ 命中——出自 part3(F1.3 引 part1·part3 双源,quote 在 part3);"current_agent = event.author"/task_completed 同页 |
| F4.5 | "bring your own OpenAI API key or run an entirely custom LLM server" | ✅ 逐字命中(ElevenLabs Custom LLM 页) |
| F4.4 | "Retell's stack runs around 600ms end-to-end" | ✅ 逐字命中(Retell blog);数字与措辞均未走样 |
| F5b.1 | raft chaos: Agent Inbox / Held Draft / perception empathy / action explicitness | ✅ 本轮 WebFetch chaos 文章确认四术语齐在该 URL,转述无走样——F5b.1 引用**正确** |

**F3.3 是我原始 6 条抽查之外的盲点,由 Codex review 抓出、经我 WebFetch 独立确认为错配**
(见 §0/§8/§9)。诚实修正我上一版报告:我此前对 raft 只抽查了 F5b.1(chaos 文章),未单独
核 F3.3 的 raft quote 归属——那正是错配所在。这条是本次 QA 的真实增益,也是我抽查覆盖的
教训(同一域名多篇文章要逐 quote 核 URL,不能因「都是 raft」就放过)。

## 4. 引用完整性 + 结构一致性——脚本核对(现状全过,修复后需回归)

- **附录 A URL ⊆ 附录 B**:附录 A 32 个唯一 URL 全部在附录 B 36 健康表内(差集为空)。
  (F3.3 修复新增 introducing-raft URL 后,需保持此不变式——见 §9。)
- **正文 finding ID = 附录 A 首列**:正文 §1-5 共 26 条 finding(F1.1–F5b.4),与附录 A
  26 行完全一致,无裸论断、无孤儿行。
- **双栏完整性**:正文 26 条 finding,「技术形态:」26 处、「产品体验含义:」26 处,齐全。

## 5. 覆盖矩阵(research.md §7)——逐格独立核对全 PASS

| 问 | 判据 | 独立核对 |
|----|------|----------|
| Q1 | OpenAI ✚ Google ✚ live 会话内 delegation UX | ✅ F1.1-F1.2 / F1.3-F1.4 / 每条带产品体验含义 |
| Q2 | 三类机制全出现 ✚ 2-3 组合 stack 命名案例 | ✅ F2.1/F2.2/F2.3/F2.4 |
| Q3 | 两轴(logical vs compute)区分 ✚ 三桶 | ✅ §3 标题即两轴;F3.1/F3.2/F3.3 三桶 |
| Q4 | 3-5 邻近案例 ✚ 逐案例 gap ✚ 三档结论 | ✅ F4.6 三例 + 逐例 gap + adjacent→blank |
| Q5a | 参与者形态有正面回答(含扫描过程) | ✅ F5a.1/F5a.2 |
| Q5b | raft 种子准确 ✚ ≥2 种子外机制 | ✅ F5b.1(raft)/F5b.2/F5b.3/F5b.4 |

**全格 PASS**(覆盖不受 F3.3 错配影响——F3.3 是引用归属问题,不是覆盖缺口)。

## 6. 其余验收项

- **Q5b → FLY-1179 标注**:F5b.1-F5b.4 每条 + §0 第 6 条均带「→ FLY-1179 设计输入」✅
- **§6 四条线映射**:表格 /gemini /eleven /gemini-advanced /glaw 各一行,各 ≥1 映射;
  明标「只给证据与 options,不替联席拍板」✅
- **scope 合同**:当前 PR head 全量 12 文件全在 `engineering/doc/FLY-1178-voice-agent-
  ecosystem/`,零文件在文档目录外,不碰 packages/ ✅
- **evidence 保全**:`evidence/dr-founder-export-raw.txt`(44KB,founder 亲手导出 verbatim)
  + `evidence/qa-url-health-recheck.txt`(本 QA 复测)在 ✅

## 7. QA 观察(不阻塞)

1. **导出路径偏差已如实记录**(dr-report.md 执行记录):标准 skill 导出因 claude-in-chrome
   合成点击无法路由进跨域 OOPIF iframe 而失效,最终 founder 亲手 ChatGPT 原生导出。归为
   不阻塞的环境 follow-up。对交付无影响:正文是 founder 导出逐字拷贝,引用由 M2 离线重建。
2. **URL 健康是时点快照**(2026-07-11);联席引用以当日为准。
3. **厂商自报数字未独立复测**:Retell ~600ms、Vapi ~800ms 均厂商口径,findings 已明标并
   列 §7,QA 未做延迟实测(超 research 类 scope)。

## 8. Codex code review 结果(独立第三方)

对当前 head 起 Codex xhigh review(thread 019f5338),verdict = **CHANGES REQUESTED**:
- HIGH:F3.3 引用错配(与本 QA §0 一致,QA 已 WebFetch 独立确认)。
- MEDIUM:§0 摘要第 3 条把「未找到无限期常驻证据」写成「真常驻进程只出现在 live 会话
  期间」的排他事实——应软化为 absence-of-evidence 措辞(与 §3.3/§7.5 一致)。
- MEDIUM:(已在本轮修正)上一版 qa-report 宣称「6/6 本轮 WebFetch」但第 6 条实为 curl+
  设计阶段核对——现已真做 F5b.1 的 WebFetch,§3 如实更新。
- LOW:(已修正)文件数订正为当前 head 全量 12。
- 机械闭环项(26 finding ID / 附录 A-B URL 集合 / 双栏计数 / Q5b 标注 / docs-only scope)
  Codex 确认全过。
- (Codex 因本机 `api.github.com` 不可达未能发布 inline PR review,verdict 见其 stdout;
  不影响结论。)

## 9. 修复指引(交 implement 阶段;修好 push 新 head → wake QA re-verify)

**必修(HIGH,引用红线):**
1. findings.md F3.3(约 66 行):把「one agent is one session」这句的引用 URL 从
   `https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/`
   改为
   `https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/`
   (QA 已 WebFetch 确认原话逐字在此:"One agent is one session: a continuous identity
   that stays alive across days and tasks, not a fresh instance every time you talk to
   it.")。F3.3 里 Letta 那半句不动。
2. 附录 A F3.3 行:URL 同步(把 raft chaos 换成/或补 introducing-raft;该行承载的是
   「持久=状态而非进程」,quote 来源必须指向真出处)。
3. 附录 B 健康表:新增 introducing-raft URL 并 curl 复测(应 200);更新计数注(36→37)。

**建议(MEDIUM):**
4. §0 摘要第 3 条:「真·常驻进程(compute residency)只出现在 live 会话期间」→ 软化为
   「一手证据只见于 live 会话期间的会话级常驻,『无限期常驻』缺乏一手证据支持」之类,避免
   把 absence-of-evidence 讲成排他事实(与 §3.3/§7.5 口径一致)。

修复不涉及研究结论变动(F3.3 论点「无限期常驻=持久身份/状态而非温热进程」不变,只是把
支撑 quote 挂到真出处),是纯引用精度订正 + 一句措辞软化。

## 10. 判定

**(round 1) FAIL(kickback)。** 交付的研究实质与覆盖是扎实的(五问全覆盖、双栏齐、35/36
引用真实可点且内容支持、诚实纪律基本到位),但引用红线上有 F3.3 一条 exact-quote 挂错 URL,
对「引用真实可点」是硬伤,必须修对——一条点不到出处的引用不能进 Annie 联席底料包。修复极小
(换 URL + 加一条附录 B 复测 + 软化一句),按 §9 修好后 QA 将 re-verify → 预期转 PASS。

## 11. round 2 re-verify(implement 修复后 · head adcb1de2)

implement 阶段按 §9 精确修复(仅动 findings.md 一个文件):

| §9 项 | 修复 | QA round 2 独立复核 |
|-------|------|---------------------|
| HIGH F3.3 quote URL | chaos → `introducing-raft-where-humans-and-agents-build-together` + 补全整句 | ✅ 独立 WebFetch 确认「One agent is one session: a continuous identity that stays alive across days and tasks…」**逐字在 introducing-raft 页**;新 URL 独立 curl = **200** |
| 附录 A F3.3 行 | URL/来源同步 + 备注记录纠正 | ✅ 附录 A 33 唯一 URL 仍 ⊆ 附录 B(差集空);F3.3 已不再引 chaos(grep=0) |
| 附录 B 健康表 | 新增 introducing-raft(200)+ 计数 36→37 | ✅ 附录 B 37 行全 200 OK;计数注更新为 37/37 |
| MEDIUM §0 措辞 | 「只出现在 live 会话期间」→「在我们核验到的一手文档里…只见于 live 会话期间的会话级形态(见 §7.5)」 | ✅ 排他事实软化为 evidence-scoped 陈述,与 §3.3/§7.5 口径一致 |

**回归不变式全保持**:finding ID body=附录 A(26 完全一致)、双栏 26/26、附录 A⊆附录 B、
scope 仍 docs-only(fix 只动 findings.md)。修复未触碰任何研究结论,F3.3 论点(无限期常驻=
持久身份/状态而非温热进程)不变,只是把支撑 quote 挂到真出处。

**round 2 判定:PASS。** 引用红线错配已修复且经独立双证(curl 200 + WebFetch 逐字命中),
无回归、无新问题。findings.md 可作为 Annie + HL + Tadashi 联席讨论底料正文交付。
