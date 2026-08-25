# FLY-2034 Belle 完整 Lead 席位 — 实施计划
Issue: FLY-2034 (https://linear.app/geoforge3d/issue/FLY-2034/belle接入-belle-完整-lead-席位自有代码仓产出归档-flywheel-派工席位定时任务-skill-化随后)
日期: 2026-08-24
基于: research.md(v2,已折入 Codex design review R1 修正)

## 0. 一句话

给 Belle 建自有仓(远端 `xrliAnnie/belle-workspace`,本地**原地 git 化**
`~/Dev/personal-assistant`,projectName/projectRoot 都不动),仓里立 skills + archive
(每周台账)+ MEMORY 结构与 `.flywheel` 派工配置;席位翻转 = projects.json 配置 +
**一处 flywheel 运行时规则文案更新**(无 TypeScript/机制改动);全部 live 动作
(含 identity 合并与原子 cutover + 立即 Bridge 重启)单列 founder-gated checklist;
最后从她席位真派一个工人生成菜单归档,按可证伪证据链验收。

> 实施期 Founder 裁定（2026-08-24）：LEARN 不使用原计划中的 `life` label，改建并
> 使用 `personal-assistant` label。Implement 已按授权创建该 label；cutover 必须把
> Belle 的 `match.labels` 同步从 `life` 改成 `personal-assistant`。以下历史论证中
> “复用 life”均由本裁定取代。

## 1. 目标 / 非目标

**目标**(= 验收①②③):
1. 仓建好且结构齐(scaffold main 推到新 private 仓)。
2. 接入文档含她侧配置步骤清单(cutover checklist,逐字命令 + 回滚)。
3. cutover 后从 Belle 席位派工人跑通"生成一份菜单"并归档(QA 节点,证据链见 §D4)。

**非目标**(明确不做):
- 存量定时任务(meal-prep/weee-weekly 等)的 skill 化迁移(issue ③,随用随做)。
- 执行她的 launcher/plist/manifest/projects.json/identity 变更(边界:founder/Belle 侧照清单执行)。
- 提交她的存量私人文件(入库范围由 checklist 的 disposition 矩阵 + 她们侧决定)。
- 改 flywheel 任何 **TypeScript/Shell 机制代码**(R1 修正:此前"零代码"表述过宽——
  `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md` 的 Belle roster 行是
  **运行时规则内容**,必须随本单更新,见 D2;除此以外零 packages 改动)。
- 新 Linear team / Linear project（继续复用 LEARN；唯一新增 label 已获 Founder 明确授权）。
- 动 belle/ 旧 daemon 残留与三个 launchd plist;改 WorktreeManager 的 worktree 落点
  (sibling 目录是 FLY-95 生产行为,本单不碰)。

## 2. 交付物

### D1. 新仓 scaffold(implement runner 独立完成,不碰她活体目录)

前置(幂等 preflight,R1#7):`gh repo view xrliAnnie/belle-workspace` —— 不存在才
`gh repo create --private`;已存在则校验 owner/visibility/default branch/是否为空,
**非空仓拒绝覆盖并上报**。在 runner 自己的 clone 里构建并 push `main`:

```
README.md                    # 重写:折入现有 README 全部内容 + 仓名≠目录名说明 + 结构导览
CLAUDE.md                    # 重写:折入现有硬规则(绝不花钱/必写日志/护栏/浏览器规则)+ Runner 边界
.gitignore                   # 折入现有 + 补 .mcp.json / scratchpad/ / tmp/ / belle/(整个目录,R2#3:
                             #   里面有 plist/start.sh/.bak 等机器残留,不止 *.log)/
                             #   BELLE-WRITE-TEST.txt / .claude/settings.local.json / worktrees/
MEMORY.md                    # 记忆索引(一行一条,细节进 memory/ 主题文件)
memory/README.md             # 主题文件写法约定(memory/ 已存在,只补约定)
.claude/skills/README.md     # skill 约定:canonical 位置(Claude Code 唯一发现路径,R1#2)
.claude/skills/meal-menu/SKILL.md  # 样例 skill:生成一周菜单(素材=tasks/meal-prep/PREFERENCES.md 的约定)
skills                       # → 顶层相对 symlink 指向 .claude/skills(founder 浏览面;
                             #   canonical 放发现路径侧,零发现风险——取舍见 §4)
archive/README.md            # 归档约定:archive/<task>/<YYYY-MM-DD>-<slug>.md
archive/weekly/README.md     # 每周台账约定:archive/weekly/<YYYY-Www>.md,一行一条可 grep
.flywheel/config.yaml        # research §3(project: personal-assistant / LEARN / life 执行体 / doc_flow)
.flywheel/agents/life/life-executor.md   # research §4(仿 reflection-executor)
.flywheel/menus/ic-roster.yaml           # R2#1:generic: .flywheel/agents/life/life-executor.md
.flywheel/menus/adoption.yaml            # R2#1:belle-lead: [generic](照 flywheel 自己的两文件模板)
.lead/belle-lead/identity-dispatch-addendum.proposed.md  # identity 升级稿(合并入 live 是 checklist 显式步骤,见 D3-4)
doc/life/README.md           # doc-flow 落点(department=life)
```

结构断言(RED 先行,进 doc folder qa/ 子目录的检查脚本):
- **冲突面 = root-relative path 精确交集**(R1#6:不许按 basename 算——live 与 scaffold
  都有 `SKILL.md` basename)。断言交集恰为 `{README.md, CLAUDE.md, .gitignore}`;
  scaffold 的 `.claude/skills/meal-menu/` 与 live 已有的
  `.claude/skills/{meal-prep,weee-weekly}` 无路径交集。
- 三个冲突文件的 scaffold 版**逐条目折入**现有版内容(条目级核对清单,不是"看起来像")。
- 无秘密/token/机器绝对路径;symlink `skills` 必须是**相对**链接。
- `.flywheel/config.yaml` 用真实 ConfigLoader 解析通过(R1 已验候选版可解析,提交版复验)。
- [R2#1] menu 链路真实校验(不止 ConfigLoader):对 scaffold exact root 跑
  `loadProjectMenuConfig` + `resolveLeadMenus("belle-lead")`,并用当前 published
  `tpl_generic_menu` 真 materialize 一份 workflow snapshot,断言 execute 节点内嵌的
  agent 就是 life-executor 的内容/digest。roster/agent 文件缺失必须 RED——
  **generalized `role: generic` 节点不走 `default_agent`、没有 shipped-generic 回落**
  (`workflow-run-snapshot.ts:462` 无条件 `resolveMenuAgentFile`,亲核属实)。
- skill 双面验证:在 clone 里确认 `.claude/skills/meal-menu/SKILL.md` 真实存在、
  顶层 `skills/meal-menu/SKILL.md` 经 symlink 可读;implement 期在一个真实 claude session
  里确认 meal-menu 出现在 skill 发现列表(discovery 证据,不是"文件在")。

### D2. flywheel 仓 PR

- 本 doc folder(exploration/research/plan/design HTML/onboarding.md 接入文档 + qa/ 检查脚本)。
- **`packages/teamlead/lead-rules-base/cross-dept-channel-rules.md`**(R1#1):
  第 64 行 roster 将 Belle 从 "Life Assistant (non-eng companion)" 改为
  "Life Assistant (life dept Lead)";第 68 行注记从 "Mufasa and Belle are companion Leads
  … own no Runners and no code" 收窄为仅 Mufasa。跑 `lead-rules-bundle` 相关测试
  (现有测试未点名 Belle,预期零红;红了如实修)。
- **生效时序注意**:该文案随 flywheel main 部署,而 Belle 翻转在 founder cutover 窗口——
  两者之间存在短暂"roster 已改、Belle 还是 companion"或反之的窗口。roster 是描述性
  参照(mention 路由表),两个方向的短窗都无行为危害;在 PR body 写明此判断。

### D3. founder/Belle 侧 cutover checklist(接入文档核心;逐字命令 + 失败处理 + 回滚)

R1#3 修正:cutover 定义为**一个短维护窗**(建议选 Belle 无在飞派工、founder 在场的
时段),不再"翻配置等班车"。Bridge 对 projects.json 只在 boot 时读取——翻转后必须
**立即重启 Bridge**,否则新 Lead/旧 Bridge split-brain 最长半天。

[R2#2] **前置条件(维护窗开始前必须已满足)**:本单 flywheel PR(含 cross-dept
roster 修正)已 merge 且已随班车/部署落到生产——checklist 提供核验命令:
`git -C ~/Dev/flywheel merge-base --is-ancestor <PR merge SHA> <deployed SHA>`
(deployed SHA 从 `~/.flywheel/deployed-sha` 读)+ 在 deployed blob 里 grep Belle
roster 两行。**未满足就不开维护窗**(否则重启后的 Bridge/Belle 仍加载旧 roster)。

[R2#3] **备份目录**:一切 `.bak` 放仓外 `~/.flywheel/backups/fly2034/`
(0700;逐文件记录 sha256 + 原 mode/owner),不落在 repo 工作区里
(`.lead/` 已预填 commit,仓内 .bak 会被误提交或卡"无未落格路径"验收)。步骤:

1. **连接目录**(可提前做,不动配置):按 research §2.1 配方——三个冲突文件
   **先记 digest/mode 再挪进仓外备份目录** `~/.flywheel/backups/fly2034/pre-repo/`
   (R3#3:不在 repo 里留 `.bak`)+ `git init` + `remote add` +
   `checkout -b main origin/main`;从仓外 diff 三件与仓版——
   **用 cutover 当天的 live bytes 重跑折入核对**(implement 期快照不作数,R1#6);
   备份不删,全程留证。
2. **存量内容 disposition 矩阵**(R1#6,fail-closed):checklist 附一张
   逐 root-relative 路径的表,live 目录每个现有路径必须落一格:
   `commit | ignore(.gitignore 已覆盖) | keep-untracked(显式登记) | 移出仓外`。
   预填(她们侧可改):tasks/、BELLE.md、memory/、.lead/、.claude/skills/ → commit
   (tasks/ 先扫嵌套 `.env`/凭据/机器路径,命中改 ignore 或脱敏);
   .mcp.json、scratchpad/、tmp/、belle/、BELLE-WRITE-TEST.txt、
   .claude/settings.local.json → ignore;**禁止 `git add -A`**;
   完成判据 = `git status` 中不存在"未落格"路径。
3. **翻转前基线证据**(给 QA 用,R1#4):记录 Bridge 当前进程启动时间/PID;
   保存 projects.json 备份 `projects.json.pre-fly2034.bak`;
   (可选)从 Belle 频道试派一次,预期被 canSpawnRunners:false 拒绝——留下"翻转前不能派"的对照。
4. **identity 合并**(R1#1,显式步骤,不再只交付 proposed 文件):
   `cp .lead/belle-lead/identity.md ~/.flywheel/backups/fly2034/identity.md.bak`
   (仓外,R2#3)→ 记录 `BASELINE_SHA=$(git rev-parse HEAD)` → 按 addendum 把
   "不开 Runner/不碰代码"段替换为派工职责段(addendum 里给出精确 before/after
   diff)→ 她们侧过目 diff → commit + push → [R3#1] 记录
   `IDENTITY_CHANGE_SHA=$(git rev-parse HEAD)`(回滚要 revert 的是**这次修改**,
   不是 baseline)。
5. **projects.json 原子翻转**:备份到 `~/.flywheel/backups/fly2034/` →
   [R2#3] 临时文件**必须建在 `~/.flywheel/` 同目录**(跨文件系统的 `mv` 不原子)
   且先 `chmod 600` → 编辑(删 `"companion": true`;`"canSpawnRunners": true`;
   加 `"projectRepo": "xrliAnnie/belle-workspace"`、
   `"memoryAllowedUsers": ["annie", "belle-lead", "personal-assistant"]`；
   Belle `match.labels` 从 `["life"]` 改成 `["personal-assistant"]`，同时显式保留
   既有 `"department": "life"`，防 label 改名让 doc-flow/agent department 漂移)→
   `jq .` 语法校验 → 用仓里附带的一次性脚本跑真实 `parseAndValidateProjects`
   (全量校验,防一处笔误拖垮其他项目)→ `diff` 确认只有预期行变化 →
   `mv` 原子替换 → **复验替换后文件 mode=0600、owner 不变**。
5b. **live 配置终验**(R2#2,重启 Bridge 前的硬门):对 exact live
   `~/Dev/personal-assistant/.flywheel/config.yaml` 跑真实 ConfigLoader;对 exact
   live menus 跑 `loadProjectMenuConfig` + `resolveLeadMenus("belle-lead")` +
   `tpl_generic_menu` snapshot materialize(与 D1 同一脚本,指向 live root)——
   implement 期对 scaffold 的校验不作数,cutover 当天 live 漂移一票否决。
6. **manifest + Belle 重启**:`materialize-lead-manifests.sh`(对既有 manifest 预期
   no-op——companion/canSpawnRunners 不入 manifest;**不要 `--force`**,R1#3)→
   `flywheel-daemon.sh install personal-assistant-belle-lead`(v2-only,绝不手编 plist)。
7. **Bridge 立即重启**:founder 本人执行 `scripts/request-restart.sh` 投紧急票
   (FLY-1959 合法路径:founder 单次明确授权;本 cutover 清单即该授权的载体)——
   不等 00:00/12:00 班车。[R2#2] **票被受理 ≠ 部署完成**(updater 异步收敛
   origin/main 后才全舰重启):等 updater 完成回执/日志 + `~/.flywheel/deployed-sha`
   更新,核验 target SHA 包含前置条件里的 PR merge SHA,再确认新 Bridge PID、
   `/health`、Belle 新 PID 与实际加载的 rules bundle。
8. **验证步**(每条给命令;R1#4 修正——不再用"六条 menu binding 存在"当证据,
   它们在翻转前就已存在,先验绿):
   - Belle startup log 出现 dept 角色行(非 "skipping engineering-governance" 行);
   - Belle 真回话且接得上 cutover 前的上下文(记忆延续);
   - Bridge 重启时间戳 > projects.json mtime(证明读到的是新快照);
   - `git -C ~/Dev/personal-assistant status` 无未落格路径、`origin/main` 同步。
9. **回滚**(任一步失败即走;R2#3 对称化):
   - projects.json:从 `~/.flywheel/backups/fly2034/` 恢复(校验 sha256)+ 复验 0600;
   - identity([R3#1] 修正 Git 语义——`git revert <baseline>` 会反向应用 baseline
     那次提交本身,撤销错对象):
     `git revert --no-edit "$IDENTITY_CHANGE_SHA" && git push`,随后
     `git diff --exit-code "$BASELINE_SHA" HEAD -- .lead/belle-lead/identity.md`
     证明 identity 内容恢复到 baseline(只 `cp` 回本地会让远端 main 留着新
     identity,不对称);
   - 重启 Bridge(同紧急票)→ 重启 Belle → 验证她以 companion 角色回话;
   - flywheel main 的 roster 两行**不回滚**:回滚后出现"配置 companion、roster 写
     dept Lead"的反向描述错配,与 R1#1 判断同理属描述性短窗、无行为危害;若回滚
     成为长期状态,由 Lead 决定是否出一个 revert PR(checklist 写明此暂态处置)。
   git 化本身无需回滚(不影响运行)。

### D4. QA 节点(验收②,cutover 后;证据链按 R1#4/#5 重写)

**"generic 工人"的验收定义**(锁死,防歧义;R2#1 修正):issue 原话"默认
generic/docs 执行体"指**非代码 docs 型执行体**。本验收 = `taskCategory: generic` →
`tpl_generic_menu` workflow;其 execute 节点带 `role: generic`,**经她仓
`.flywheel/menus/ic-roster.yaml` 解析为 life-executor**(D1 交付该映射)。
此路径**没有** `default_agent` 参与、**没有** shipped-generic 回落——roster/agent
文件缺失 = snapshot materialize 失败 = RED。(`default_agent: life` 仍保留,服务
非 generalized 的项目级 dispatch,不是本验收的选择依据。)

流程:建/复用一张带 `personal-assistant` label 的 LEARN issue("生成本周菜单",素材=
tasks/meal-prep/PREFERENCES.md)→ **由 Belle 在她频道真实派工**(不是 QA 裸 POST
`/api/runs/start`)。证据链(每条独立可证伪):

1. **派工归属**:Belle pane/session transcript 里出现真实 dispatch 动作(工具调用),
   与 Bridge 收到的 run-start 时间吻合——排除"QA 伪造 leadId 裸 POST"(R1#4)。
2. **新快照**:Bridge 进程启动时间 > cutover 的 projects.json mtime(承接 D3-8)。
3. **workflow 形态**(R2#4 机械化,防空跑通过):snapshot 断言**恰 1 个
   executable 节点 + founder gate + 既定 land/closeout 形态**(generic shape 不是
   "单节点"——它还含 gate 与 land);execute 节点内嵌 agent = life-executor
   digest;首发 execute attempt=1。
3b. **幂等主动重放**(R2#4;[R3#2] 确定性配方——Bridge 只在窄窗允许 replay:
   原 start reservation 仍是 current node、对应 attempt 处于 admitted|running、
   activation 存活;进 founder gate 后同 key 会返 STALE_START_RESPONSE):
   - Belle 的真实派工是 keyless(payload 不含 idempotencyKey,Bridge 生成
     `wf2-auto-*` 且 response 不回传)→ QA 在首次 200 后**立即**从 StateStore
     的 start reservation 行读出生成的 key;
   - 趁 StateStore 证明 execute attempt=1 仍 current 且 admitted|running 时,
     用同 body/auth/key 重放一次,断言第二次 200 返回同一 run/execution;
   - **归属边界**:这次重放是 QA 的幂等故障注入 POST,不算(也不污染)
     证据 1 的"Belle 真实派工"归属;
   - 跑完全生命周期后再断言:全程恰一个 worktree、一个 PR、一套归档文件。
4. **worktree 落点**(R1#5 修正):**不硬编码路径**。读 StateStore 持久化的
   `worktree_path`(生产真相;FLY-95 形态 = `~/Dev/personal-assistant-<ISSUE>` sibling
   目录,不是 `<projectRoot>/worktrees/`),再 `git -C ~/Dev/personal-assistant worktree
   list --porcelain` 交叉核对归属与 HEAD。
5. **skill 证据**:runner transcript 中真实读取/调用 meal-menu skill 的记录
  (不是"产物长得像")。
6. **产出与归档**:PR 含 `archive/meal-menu/<date>-menu.md` + `archive/weekly/<YYYY-Www>.md`
   台账行;founder `:cool:` merge 后用 `git show <merge-sha>:<path>` 在 merge 提交上
   验证两个文件真实入库(R1#4);grep 台账命中(可查询性)。

## 3. 实施顺序(implement 节点)

1. RED 先行:D1 结构断言脚本(root-relative 交集/折入完整性/无秘密/symlink 相对性/
   ConfigLoader 解析)先红。
2. Linear 只读核对发现 `life` 缺失 → 问 Founder；按裁定创建并回读确认
   `personal-assistant` label，再将其锁进 scaffold 与 cutover verifier。
3. `gh repo view` preflight → create(仅当不存在)→ scaffold push(D1)+
   skill discovery 实测。
4. flywheel 仓 PR(D2:docs + cross-dept roster 行 + checklist 终稿 + 一次性
   parseAndValidateProjects 校验脚本)。
5. 报 Tadashi:仓 URL + checklist 位置 + "cutover 等 founder 维护窗" 状态,不空等。

## 4. 风险与对策

| 风险 | 对策 |
|------|------|
| 坏 config.yaml 把项目踢出 Bridge runtime(FLY-371 事故类) | ConfigLoader 真实解析:R1 已验候选版,提交版在结构断言里复验 |
| projects.json 一处笔误拖垮全部项目 | cutover 用临时文件 + jq + 真实 parseAndValidateProjects + diff + 原子 mv(D3-5) |
| 新 Lead/旧 Bridge split-brain(R1#3) | cutover = 短维护窗,翻转后立即 founder 紧急票重启 Bridge;回滚脚本对称 |
| identity 与新权限自相矛盾(R1#1) | identity 合并是 checklist 显式步骤(备份+diff+过目);roster 文案随 D2 更新 |
| 顶层 skills/ 不被发现(R1#2) | canonical 放 `.claude/skills/`(唯一发现路径),顶层 `skills` 只是浏览 symlink;implement 期做 discovery 实测。**取舍**:若 founder 更在意 GitHub 网页端浏览体验(symlink 在网页端显示为链接文件),可反转方向(canonical 顶层 + `.claude/skills/<name>` symlink),但那需要先证明 skill 发现跟随 symlink——默认不赌 |
| 误提交私人/运行时文件 或 永远达不成"status 干净"(R1#6) | disposition 矩阵逐路径落格,fail-closed,禁 add -A,tasks/ 扫嵌套凭据 |
| memoryAllowedUsers 误解(R1#7) | 修正:缺失**不会**挡 spawn,只是不注入 recall;补上是为记忆连续性,不是解锁派工 |
| 翻 companion 后她人设走味 | identity 升级稿保留 persona 全文只叠加职责;验证步含"真回话+记忆延续" |
| QA 卡 founder 时窗 | implement 完成即报;QA 在 cutover 窗后跑,设计明示依赖 |

## 5. 明确不改的东西(scope 声明)

flywheel packages **机制代码**零改动(唯一内容改动 = cross-dept-channel-rules.md
roster 行);她的三个 launchd plist、belle/ 退役残留、tasks/ 现有内容、
.claude/settings.local.json 全部不动;WorktreeManager sibling 落点不动;
merge/ship founder-gated 契约不动;Discord bot/channel/token 不动。
