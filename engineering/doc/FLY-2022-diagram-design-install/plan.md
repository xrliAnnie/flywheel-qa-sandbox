# FLY-2022 diagram-design 项目安装 — 实施计划
Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-%E5%AE%89%E8%A3%85%E8%BF%9B-flywheel-%E9%A1%B9%E7%9B%AE%E9%A1%B9%E7%9B%AE%E5%9F%9F%E5%AE%89%E8%A3%85-%E9%BB%98%E8%AE%A4%E9%85%8D%E7%BD%AE-%E7%9C%9F%E5%9B%BE%E9%AA%8C%E8%AF%81)
日期: 2026-08-24
基于: research.md

## 1. 交付边界

本单只改纯文件和验证面：

1. exact `flywheel-skills` PR #18 head `82737e5d…` 的 `.claude/skills/diagram-design/` 208-file project copy；
2. 根 `.diagram-design`，精确内容 `profile: default`；
3. 安装来源/完整性 shell 合同及 CI 明示接线；
4. 同题显式调用（权威 E2E）与不点名自然请求（discovery E2E）各自生成的自包含 HTML、PNG screenshot、FLY-2004 reference PNG、并排比较页和可审计 generation transcript；
5. full doc-flow 与最后一笔 `CLAUDE.md` milestone。

不提交 `.agents/skills/diagram-design` 重复副本、不提交含临时绝对路径的 `skills-lock.json`、不创建 `.codex/skills`、不写用户级/global skill/profile、不选定正式中文字体、不改 CSP/motion/template/role/runtime，不部署、不重启、不 merge。若 vendor 在 root marker 已有效时仍要求用户级 default snapshot，本单 fail-close 并走 Lead question gate，绝不以临时全局写入绕过。

## 2. TDD：安装合同 RED

先新增 `scripts/__tests__/fly2022-diagram-design-install.test.sh`，并在 `.github/workflows/ci.yml` 的 shell suite 明示调用；同步更新 `scripts/__tests__/ci-structure.test.sh` 所需的 exact census/顺序合同。测试在 skill/config 尚未落地时必须因缺 `.diagram-design` 和 `.claude/skills/diagram-design/SKILL.md` 而 RED，保留该失败输出为 TDD 证据。

测试锁定：

- `.diagram-design` bytes = `profile: default\n`；
- tracked skill files = 208；assets = 149、references = 53、scripts = 3，许可证两份都在；
- `SKILL.md` SHA-256 = `0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971`；
- commit/index 中该 subtree tree object = `8fe791a61ab857ae7994f90681cbd5db1ac5ee4b`；
- provenance upstream commit = `648c2a597839301e06df1e7434a08bde9f42eed3`，四条 limit + required QA E2E anchor 不丢；
- 本单没有 tracked `.agents/skills/diagram-design`、`.codex/skills/diagram-design`、`skills-lock.json`；
- `git ls-files .claude/skills` 的正集合必须恰好是这 208 条 `diagram-design` 路径；动态注入的其他 `.claude/skills/*` 不进入 index。

本地 GREEN 前 skill 被精确 force-add 后，测试从 index `git write-tree` 取 subtree；CI clean checkout 则可从 HEAD 取。测试不联网，避免远端漂移/凭据让 CI 不稳定。

## 3. GREEN：exact project install + default marker

1. 复用 research 隔离 source，先核 `git rev-parse HEAD == 82737e5d…`、source subtree object `8fe791…`、source `SKILL.md` SHA `0d4f3c…`。
2. 以 FLY-2015 已验的 `skills@1.5.10 ... --agent claude-code codex -y --copy` 产物为来源，只机械复制其中 `.claude/skills/diagram-design/` 到当前项目相同路径。不得从脏的 `/Users/xiaorongli/Dev/flyview-skills` 取字节。
3. 用 `apply_patch` 创建根 `.diagram-design` 一行 marker。
4. 只运行 `git add -f .claude/skills/diagram-design`；其他实现/测试/docs 走普通 `git add`。立即审计 index path list，拒绝任何动态 issue skill 混入。
5. 重跑 focused test GREEN；再跑 installed `self_check.py` 对 shipped template 作为安装后 smoke，并用 `python3 -m py_compile` 验三个 parser。

## 4. 真图双 E2E：先证明调用，再证明自然请求

### 4.1 生成前状态

记录：

- project installed SHA/tree/census；
- `~/.agents/.skill-lock.json` SHA；
- 四个用户级 diagram path 和 `~/.diagram-design/profiles/default.md` 是否存在；
- `.diagram-design` exact bytes；
- Claude Code version；
- project skill subtree 的完整 before hash，生成结束后必须逐字不变。

这里明确采用 installed `SKILL.md` §0 的 primary gate 作为本单解释：root `.diagram-design` 的 `profile: default` 直接选择 shipped built-in default，故不需要先创建 `~/.diagram-design/profiles/default.md`。这与 issue 的 FLY-2015 QA advisory 完全相同。前后都正向断言用户级 default 不存在且用户级 skill/lock 指纹不变；任何创建/改写尝试、或因缺 global snapshot 而拒绝，均是 vendor contract 冲突，不归因于安装失败，也不扩权修复：立即保存 transcript，用 `gate question --lead flywheel-eng-lead ... --no-block` 报告冲突并等待裁决。

提交两个同题 prompt：

- `evidence/explicit-request.md`：第一场、权威场，用自然语言明确要求 “use the installed `diagram-design` skill”，生成 `explicit-generated.html`；不用 `/diagram-design` slash prefix，因为 Claude Code `--print` 已实测不会为 slash prefix 产生可审计的 `Skill` event；
- `evidence/natural-request.md`：第二场、额外 discovery 场，全程不出现 skill 名，生成 `natural-generated.html`。

两场题材都严格复用 FLY-2004：超长 Linear issue description 的旧路径直接塞 tmux 命令导致 `command too long`，新路径先写本机临时文件、启动命令只带路径、窗口脚本读回、最终原文逐字一致。prompt 固定中文正文、自包含静态 HTML、正方形架构图、输出路径，并明令不得写项目外或用户级/global 文件。先跑显式场，防止“模型自己会画图”被误当成 project skill 可用；显式场通过后才跑自然场。

### 4.2 模型执行

从项目根分别运行全新的 Claude Code non-interactive session。任务专属 Node harness 直接 spawn `claude`，把 stdout 原样、stderr、退出码写进各自 evidence；prompt bytes 只通过 child stdin `.end(prompt)` 送入，不作为 positional argv。Claude Code 2.1.241 的 `--allowedTools` / `--disallowedTools` 都是 variadic；把 prompt 放在最后会被 option 吞掉并以 “Input must be provided” exit 1，所以 argv 中不得出现 prompt。关键参数：

```bash
claude -p --no-session-persistence --no-chrome \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits \
  --allowedTools 'Skill,Read,Write,Edit,Glob,Grep,Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)' \
  --disallowedTools 'WebFetch,WebSearch'
# harness: child.stdin.end(prompt)
```

不使用 `--disable-slash-commands`。`Skill` 明确在 allow-list；Bash 只放行 installed `self_check.py`，让 skill checklist 的该项可达。permission rule 使用已实测的 documented prefix form `Bash(<command>:*)`：在同一 binary 上 `Bash(echo probe:*)` 允许且实际执行 `echo probe ok`，RC=0。vendored subtree 不含其文档提到的 repo-level `scripts/verify-geometry.py`，所以 geometry/taste 由外层检查补足，不能把这个预知不可达项误报成安装 defect。

`Write` 必须在 allow-list 才能产图，且它本身没有 path constraint；因此 allow-list **不被表述为 global-write prevention**。当前 Runner 外层 filesystem sandbox 对 `~/.claude/session-env` 的实际写入已返回 EPERM，预计也覆盖未授权的 `~/.diagram-design`，但本单仍只把前后 fingerprint 当权威 fail-close 检测：若 user profile/lock/path 有任何变化，E2E FAIL、保存 transcript、走 Lead gate。若 session 因被拒工具而停住，结论是 sandbox/harness 与 vendor contract 冲突，不冒充 project discovery 缺陷。

在安装前已用完全相同的 stdin + stream-json instrument 做正控：Claude Code 2.1.241 收到 “Explicitly use the installed mermaid skill” 后 RC=0，JSONL 出现 `tool_use.name="Skill"`、`input.skill="mermaid"`，随后有 `Launching skill: mermaid` tool result。故 diagram-design 显式场使用的 signal 不是未经证明的假设。

权威显式场必须同时满足：

1. JSONL 中至少一条 `tool_use.name == "Skill"` 且 input 的 skill 正是 `diagram-design`；harness 自动解析并把命中的 event index/摘要写进 `explicit-generation-evidence.json`；
2. exit 0、目标 HTML 存在、无 branding 问答、skill 自检通过；
3. 生成前后 installed subtree 与用户级指纹不变。

自然场独立标注为 discovery experiment：同样保存 raw JSONL、退出码和生成物，并报告是否出现 `Skill(diagram-design)` event。它必须做到“不点名、不卡配色、生成真图”；若未调用 skill 或输出掉档，如实判自然触发 FAIL，不用显式场冒充它通过，也不反过来抹掉显式场的安装调用证据。

### 4.3 图形与中文验证

生成后：

1. `python3 .claude/skills/diagram-design/scripts/self_check.py <generated.html>`；
2. 静态检查 `<svg role="img" aria-labelledby=...>`、first-child title/desc、1080×1080 viewBox、CJK fallback、无 script/motion；
3. 本机已确认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 可执行（设计时版本 `151.0.7922.172`）；直接用其 headless CLI、独立临时 profile、`--virtual-time-budget=2000`、1080×1080 viewport 与 2× scale 截图，不依赖仓库不存在的 Playwright，也不安装系统包；
4. 用同一个 Chrome 的 `--remote-debugging-port=0` 启动临时实例，从 stderr 解析 DevTools websocket endpoint；用 `.node-version` Node 22 内建 global `WebSocket` 直连 CDP（零新增 dependency），在 `document.fonts.ready` 后取得 `getComputedStyle(...).fontFamily`、中文 text bounding boxes、SVG/client overflow 与 console/page exceptions；记录 Chrome/version/command、PNG dimensions/hash。这里测得的是浏览器 computed fallback stack 和真实几何/栅格效果，不把 CSS stack 第一项误称为 OS 实际 glyph face；正式字体方案仍留给 Annie；
5. 重核用户级/global 指纹与生成前逐字一致。

## 5. FLY-2004 同题视觉比较

把 FLY-2004 权威 B 臂 PNG 机械复制为 `evidence/reference-fly2004-arm-b.png`，同时记录原路径和 SHA。生成 `evidence/comparison.html` 及 screenshot，将 reference/new 两张以同等视觉尺寸并排。

评估矩阵不拿“有文件”当 PASS：

| 维度 | 不掉档门槛 |
|---|---|
| 信息层级 | 起点、失败旧路、成功新路、最终逐字一致都能一眼定位 |
| 布局/留白 | 没有线缆团、节点拥挤、legend 入侵内容区；阅读顺序稳定 |
| 配色 | 原厂浅色皮；橙色只承担 1–2 个焦点，旧路弱化但仍可读 |
| 连线 | 正交/圆角、虚实语义明确、无 overlap、箭头/label 可追踪 |
| 中文 | 正文无乱码/截断/重叠，PNG 正常尺寸下可读 |
| 完成度 | 与 FLY-2004 B 臂同属可直接交付档，而非 Mermaid 默认皮或 AI 卡片拼盘 |

`generation-evidence.md` 分别给出显式场、自然场逐项 PASS/FAIL 和 CJK fallback 栅格观察。若任一关键项掉档，先按 skill taste gate 通过新 model/session 重生成或明确 FAIL；不手工把旧 B 臂复制成“自动生成结果”，也不直接修改生成 HTML 冒充模型结果。

## 6. 验证与提交

按风险分层运行：

1. focused FLY-2022 shell test + `shellcheck`；该 test 接在 CI `script-tests-2` 的 FLY-2015 step 后，设计基线该 shard 实测 11m36s，距 17min tripwire 约 5m24s；focused 首次 GREEN 后记录实际 wall time，目标 <1s、硬上限 30s，超限则不接线并先拆慢项；
2. `scripts/__tests__/ci-structure.test.sh` 和 FLY-2015 role test；
3. installed parser compile、`self_check.py`、evidence integrity/Chrome headless screenshot checks；
4. 正向检查 `git ls-files .claude/skills` 恰为 208 条目标路径，并重核 tracked skill subtree 未被 model 的 profile verbs/customization 改写；root marker 让正常 profile 操作只读 shipped style，未来 customization 必须走用户 profile library，绝不直接编辑 tracked `references/style-guide.md`；
5. `pnpm lint`；
6. `pnpm -r build`；
7. `pnpm test:packages:run`；
8. 新增的所有 `scripts/__tests__/*.test.sh`。

宿主全量门若撞既有 GUI、固定 deadline 或 root-owned cache，保留原 aggregate 结果，以任务专属 cache/串行 focused rerun 归因，不伪报原门全绿。运行 full package suite 前先更新 progress ledger；遵守宿主负载纪律，若明显危及生产 Bridge 则用 CI/隔离策略，不扩大为生产服务操作。

提交分三层：

- 实现合同 RED→GREEN + project install/config；
- 真图 evidence + docs finalization；
- `CLAUDE.md` milestone 作为 PR 最后一笔 commit（不取新 Flywheel version，因为无 runtime/package 产物）；该 row 与 PR body 都必须保留运行规则：customize via `~/.diagram-design/profiles/`, never edit the tracked installed copy，避免未提交的 `references/style-guide.md` 变脏后触发 restart preflight fail-close。

每次 meaningful step 更新 `progress.md`；提交前查 inbox 并审计 git status/index。

## 7. Request-driven code review 与 PR handoff

实现/验证 exact HEAD 后：

1. `stage set code_review`；
2. `gate review_code --lead flywheel-eng-lead --exec-id 398d... --no-block "Code review requested for FLY-2022 ..."`，捕获新 questionId；
3. `request-review --type code --question-id <id>`；
4. 跨 turns 轮询 `check <id>`。CHANGES_REQUESTED 则修 blocking finding、push 新 head、开全新 gate/request；APPROVED advisories 另用 `ask --report` 转 Lead。
5. review 通过后 push feature branch，开 non-draft PR（base `main`），PR body 列 exact companion pin、SKILL SHA/tree、default marker、自然触发、全局零变化、真图比较、测试结果与留待 Annie 决定的中文字体。
6. 本节点不请求 ship approval、不 merge、不 dispatch QA/review successor。PR 创建后运行 `complete --route needs_review --pr <number>`。

## 8. 验收矩阵

| Issue 要求 | 权威完成证据 |
|---|---|
| 项目域 exact-SHA 安装 | tracked `.claude/skills/diagram-design/` 208 files；tree `8fe791…`；`SKILL.md` SHA `0d4f3c…`；companion head receipt |
| 默认配置 | root marker exact bytes test；显式与自然 session 都零 branding question；global default 前后不存在 |
| 真图成功 | 显式 transcript 的 `Skill(diagram-design)` event + 双 session exit/result、generated self-contained HTML、`self_check.py`、Chrome PNG receipt |
| 不掉认可档 | 显式/自然两图与 FLY-2004 B 臂同题并排 comparison + 六维 verdict |
| 中文可读 | Chrome 151 screenshot/CDP font+geometry receipt；computed fallback 与实际栅格观感如实记录，不虚构物理 glyph face |
| 不锁字体方案 | docs/PR 明写观察值，不改 global/profile/CSP/font package |
| 无全局污染 | install/generation 前后用户级 lock/path/profile 指纹一致 |
| 工程交接 | focused/full gates、code review APPROVED、PR、`complete --route needs_review` |
