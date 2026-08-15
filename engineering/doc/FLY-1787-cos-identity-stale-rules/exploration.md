# FLY-1787 CoS identity.md 两处过期规则 — 探索

Issue: FLY-1787 (https://linear.app/geoforge3d/issue/FLY-1787/cos-identitymd-两处过期规则-dept-label-写-union-会让-issue-变成谁都派不了-路由-roster-漏了)
日期: 2026-08-15
基于: 无

## 问题是什么

`.lead/flywheel-cos-lead/identity.md`(Aunt Cass / CoS 的 agent 身份文件)里有两条规则,写成的时候系统只有一个部门 Lead(Tadashi)。Honey Lemon(`flywheel-product-lead`,dept label `Flywheel-Product`,canSpawnRunners=true)上线后,这两条规则没跟着更新,变成了两个**静默错误**(不报错、只做错事):

- **Bug 1(L61–71 Label-before-route)**:「路由已存在但缺 `Flywheel` label 的 issue → 读现有 labels 写 union 补上 `Flywheel`」。当 issue 已带**另一个部门标签**(如 `Flywheel-Product`)时,写 union 会造出**两个 dept label**,Bridge 判定 `issue_multiple_department_labels` → **谁都派不了**,且按 registry 原文要 Annie 出面减到一个。规则本意防 stall,实际制造 stall + 惊动 founder。
- **Bug 2(L36–49 Core Channel Routing + Roster)**:abstain 规则(规则 2)与 roster 表只认 Tadashi 一个 dept lead。一条只 @ Honey Lemon 的消息不触发规则 2,落到规则 3(default handler)→ **字面规则要求 CoS 替 HL 回答她自己的单**。

两处均为 Aunt Cass 本人在 2026-08-15 按规则执行时实测撞到(FLY-1782 预检 / Annie 发 `@HoneyLemon A`),不是推测。

## 为什么现在修

- 每次 CoS 新 session 都按这份文件字面执行。Aunt Cass 这次没做错靠的是她自己的 memory 笔记,换一个 session 就会犯。
- Bug 1 的后果不是小错:一张健康 issue 被打成双 dept label 后,`/api/runs/start` 对**所有** lead 都拒绝,修复路径要 founder 介入。
- 时间窗:identity.md 是 **boot 时**由 `claude-lead.sh` 从 repo 拷贝到 `~/.claude/agents/flywheel-cos-lead.md` 再经 `claude --agent` 加载的(boot-cached,非热加载)。合进 main 后要等下一班 Lead 重启才生效——今天(2026-08-15)有一班重启车,顺上就今天生效。

## 影响面(刻意收窄)

- **只改一个文件**:`.lead/flywheel-cos-lead/identity.md`(纯 prompt 文本,零 TypeScript / 零 shell 代码改动)。
- 部署链已核实(见 research.md):launch 时自动 `cp` repo → `~/.claude/agents/`,所以改 repo 这份即可,无需手动同步部署副本。
- 不碰 Bridge / registry 代码——`department-registry.ts` 的行为是**对的**,错的是 prompt 文件对它的描述。

## 成功判据

1. 按新规则字面执行,对一张已带 `Flywheel-Product` 的 issue 做路由预检,**不会**给它加 `Flywheel`,而是识别为 HL 的单。
2. 按新规则字面执行,#flywheel-core 里一条只 @ Honey Lemon(或只写 "Honey Lemon")的消息,CoS **沉默**。
3. 无 dept label 的 issue 照旧被补上 `Flywheel`(原规则要保护的正常路径不回退),且非 dept 标签全部保留。
4. 新增第三个 lead 时,bot-id @-mention 形态**无需改文件**即不误答(设计目标:消灭 id 形态的 staleness class,而不是把 roster 从 1 行改成 2 行等着下次再犯)。

## 打开的问题(带答案进 research)

- dept label 的判定集合到底是什么?(→ `classifyIssue` 只数 canSpawn 的 lead 的 label,见 research.md)
- CoS→Honey Lemon 的路由路径有没有既有契约可引用,还是要新发明?(→ HL 侧 identity.md 已写明,见 research.md)
- roster 要不要改成运行时从 `projects.json` 派生?(→ 拒绝,理由见 plan.md 取舍节)
