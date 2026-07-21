# FLY-1395 Prompt/技能装配层 model-agnostic 化 — QA 报告

Issue: FLY-1395 (https://linear.app/geoforge3d/issue/FLY-1395)
日期: 2026-07-20
基于: plan.md, research.md, exploration.md

**判定: PASS** — 三段式 QA 阶段(独立验证 implement 阶段在本分支 `flywheel-FLY-1395`
committed 的实现,PR #658 OPEN,head `6b58961607`)。

---

## 1. 验的是什么(对照 plan §验收标准 4 条 + 红线 4 条)

改动本质:把 prompt/技能装配从 `backend==="claude-tmux"` 硬门,改为后端无关的能力表
`BACKEND_SKILL_ASSEMBLY`(claude/codex=native,agy/kimi=none)。codex-tmux 成为**首个新增
的真装配后端**:B/C 臂经 per-runner `CODEX_HOME` 的 config.toml `[[skills.config]]` disable
块 + `$CODEX_HOME/skills/matt-skills:<name>/` vendor 副本落地;A 臂零追加(字节兼容)。

---

## 2. 真机进程级铁证(验收 #1 — 等价 Claude 侧 argv)

`scripts/qa-fly-1395-codex-mode-visibility.sh`(真 codex-cli **0.144.6**,school profile,
隔离 CODEX_HOME,零全局污染)—— **12 passed / 0 failed**,完整输出留档
`qa-evidence-codex-visibility.txt`。

真 codex 进程「Available skills 目录」行为问答(阳性对照 A 先行):

| 臂 | 真进程响应 | config.toml 静态铁证 | skills 目录 |
|---|---|---|---|
| **A** superpowers | `SUPERPOWERS=YES MATT=NO` | 零 FLY-1395 managed 块 | 无 matt 目录 |
| **B** matt | `SUPERPOWERS=NO MATT=YES` | 14 条 `superpowers:*` disable | 6 个 `matt-skills:*` 副本 |
| **C** bare | `SUPERPOWERS=NO MATT=NO` | 14 条 `superpowers:*` disable | 无 matt 目录 |

- 阳性对照 A=`SUPERPOWERS:YES` 证明「尺子有效」(codex 确实能看到 superpowers),故 B/C 的
  `NO` 是真隐藏,不是查询语义漏了。
- oracle 步骤(`--strict-config -c 'skills.config=[]'`)通过 = codex 未版本漂移(research R1)。
- 一趟扫描生成 14 条 disable 名单,via 记录与 adapter apply 用同一份(无 TOCTOU)。

## 3. 单元 / 集成层(验收 #2/#3/#4 + 红线)

剥离 memory 记录的污染 env(`FLYWHEEL_RUNNER_BACKEND=codex` / `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`)后:

| 套件 | 结果 | 覆盖点 |
|---|---|---|
| config 全量 | **527/527** | 能力表 key 集合 === EXECUTOR_BACKENDS(新后端未声明即红) |
| claude-runner `codex-home.test.ts` | **47/47**(+1 我新增) | disable 块字节渲染 / A 臂 byte-identical / 注入名拒绝 / matt 幂等 / 重供给为 bare 清 stale / matt 失败零残留 |
| claude-runner `CodexTmuxAdapter.test.ts` | **59/59** | 三字段透传;absent=现状调用 |
| edge-worker `Blueprint.*`(全 22 文件) | **234/234** | codex via=hash/override/sticky/inherited 保真(非 noop_backend);probe 失败 fail-closed 回 A;A 臂无 probe |
| edge-worker `Blueprint.fly1395-off-sentinel` | **2/2** | 默认 env 零装配 + **突变**(bare 触发所有尺子) |

关键断言(实读,非空过绿):
- **验收 #2 跨后端同臂**:`Blueprint.fly1356 "one inherited arm applies backend-native
  assembly in Claude design and Codex implement"` —— 同一 inherited matt 臂,design(claude)得
  plugin 效果、implement(codex)得 disable 名单 + vendor 源,mode 一致。
- **验收 #3 四观测量可分组**:codex 行现记真实 `skillFrameworkMode` + via(off-sentinel 突变
  证 codex envelope 落 `bare/forced`),不再是掩盖暴露的 `noop_backend`。
- **验收 #4 意图级 + agy/kimi noop**:off-sentinel 绿 + `"none-capability backend never reads
  variants (noop_backend)"` 测试。
- **红线 #1 字节兼容**:off-sentinel + `codex-home` A 臂 `renderCodexHomeConfig` 逐字节断言。
- **红线 #2 fail-closed**:probe 抛错 → `fallback_superpowers`;matt vendor 缺失 → throw → 回 A。
- **红线 #4 零机器全局状态**:装配只落 per-runner CODEX_HOME;QA 脚本断言从不写
  `~/.agents/skills` / `~/.codex`。
- **安全**:`superpowers:bad"\nenabled = true` TOML 注入形 skill 名被 `CODEX_SKILL_NAME_RE` 拒绝。

## 4. Lint

`biome 2.1.4`(仓库版,非 npx)`check` 全 12 个变更 ts/js 文件 + 6 个源文件 → **No fixes applied**。

## 5. 全套件失败甄别 —— 全部环境性/pre-existing,非本单回归

claude-runner 全量套件出现 8 个失败,**全部落在 FLY-1395 未触碰的文件**(本单在 claude-runner
只改 `CodexTmuxAdapter.ts` + `codex-home.ts`):

| 文件 | 失败 | 甄别(已取证) |
|---|---|---|
| `codex-daemon-runtime.test.ts` ×4 | `assertSocketPathFitsSunLen` | runner 的 `TMPDIR` 在 `~/.flywheel/runner-state/.../browser-tmp` 极长 → unix socket 超 sun_len;`TMPDIR=/tmp` 隔离重跑 **43/43 全绿** |
| `scaffold-prune.real-tmux.test.ts` ×2 | real tmux | 并发高 load flake;隔离重跑 **4/4 全绿** |
| `claude-profile.test.ts` ×1 | group/world-readable 权限位 | 已知本机 flake;在 base commit `deee41d9b`(**不含 FLY-1395**)上**红得一模一样** = pre-existing |

> 本单触碰文件的测试全绿(codex-home 47、CodexTmuxAdapter 59)。

## 6. QA 增值:vendored-skill drift guard(新增测试)

**发现的覆盖缺口**:所有 matt 臂测试用合成 fixture(`makeMattSkillsSource` 保证 frontmatter
`name:` == 目录名,`namespaceMattSkill` 不变式恒满足),**没有一个针对真 `vendor/matt-skills/skills/`**
跑 production 代码。若上游 matt-skills 同步改了某 SKILL.md 的 `name:` 字段(或增删/改目录),
matt 臂会在**生产 codex implement runner 供给时抛错**,而全部 fixture 测试仍绿。

新增 `codex-home.test.ts` → `"FLY-1395 provisions the matt arm from the REAL vendored skills
(drift guard)"`:对真 git-tracked vendor 跑 `provisionCodexHome({mode:"matt"})`,断言 6 个
`matt-skills:<name>/SKILL.md` 装成 + frontmatter 命名空间化;vendor 缺失 = fail-loud(非静默跳过)。

**突变验证(证明非空过绿)**:把真 `vendor/.../tdd/SKILL.md` 的 name 改为 `renamed-by-upstream`
→ `provisionCodexHome` 抛 `matt skill tdd frontmatter name must be tdd`。→ 真 drift 会在 CI 红,
不必等真 Codex runner。

## 7. 残余项(不阻塞)

- plan §验收 #2 提的「529 房全链 E2E」(design claude + implement codex 同单同臂)属验收级
  full-pipeline;本 QA 以**真 codex 进程铁证 + 单元级跨后端 inherited 断言**覆盖其机制(臂解析/
  sticky/override 链自 1356 起后端无关且已 E2E),判定充分。真 529 房全链留后续可选加强。
- 固定模型脚注(issue scope 3):四观测量臂间直接对比 conditional on `DEFAULT_PHASE_DISPATCH`
  固定配置,已入 runbook;配置变更时抽查复验。

## 8. Codex code review(硬门,plan 未豁免)— CHANGES REQUESTED

QA(ship executor)对 head c4063d347 跑 Codex code review(xhigh / gpt-5.6-sol)。verdict =
**CHANGES REQUESTED**(2 HIGH + 1 MEDIUM)。QA 逐条独立核实:

| # | Codex 评级 | QA 裁定 | 依据 |
|---|---|---|---|
| 1 凭证残留 | HIGH | **CONFIRMED 真回归** | `codex-home.ts:576` 先写 config.toml(含活 GH_TOKEN),`:605` 才做 fallible 递归 `cpSync`;`accessSync` 只验 SKILL.md 可读、cpSync 复制整目录 → 目录内不可读子文件使 provisionCodexHome 在写凭证**后**抛错。该调用在 `CodexTmuxAdapter.ts:399`,**位于 scrub try/finally 之外**(:395-398 注释自证)→ home 带活 token 残留不被 scrub。破坏 FLY-1188(`codex-home.ts:516-518`)/ Codex M4d HIGH-5 刻意建立的零残留不变式。触发面:仅 matt(B)臂 + cpSync 失败(git-tracked vendor 近零概率),但属安全不变式回归,修复 trivial(~5 行)。 |
| 2 prompt byte-compat | HIGH | **REBUT 非缺陷** | 翻译头文案(`Blueprint.ts:2364`)= plan Task 4 明确「默认模式下**有意**的 prompt 文本变更」,修正 S1/S4 证伪的「no Skill tool」错误陈述;OFF sentinel 有意白名单排除(Task 7)。在红线#1 范围(spawn args/CODEX_HOME 渲染/envelope)之外。回退会给已获 skill 的 codex runner 重新灌错误陈述。 |
| 3 probe 未验 frontmatter | MEDIUM | **CONFIRMED 应修** | `Blueprint.ts:303` probe 只验 6 个 SKILL.md 可读、未验 frontmatter name==dir;漂移时 probe 通过(记 matt 归因)→ provision 的 namespaceMattSkill 才抛错 = 硬失败,而非红线#2 的 graceful `fallback_superpowers`。probe 应镜像 provision 前置条件。低运行时概率(CI drift-guard 已在 build 期抓 frontmatter 漂移)。 |

Codex 沙箱 `gh` 无网络/auth → review 未发到 GitHub;QA 代发 verdict + triage 至 PR #658
(issuecomment-5029092577)。

## 9. 结论

**行为/机制层 PASS**:4 条验收 + 4 条红线(plan 定义范围内)均有真机 + 单元 + 集成三层证据;
lint 绿;全套件失败全甄别为环境性/pre-existing;新增 drift guard 突变自证。

**但 ship gate 未过**:Codex 硬门发现真 HIGH(凭证残留回归)+ 真 MEDIUM(probe 未 fail-closed)。
QA 作为独立验证者**不自改生产代码再自批**(安全改动尤忌)→ 路由实现相位修 Finding 1+3,
QA 再独立复验。**qa-result = FAIL(code-review kickback);approve gate 未开。**
