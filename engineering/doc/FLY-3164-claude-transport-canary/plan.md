# FLY-3164 Claude 传输探针 — 实施计划
Issue: FLY-3164 (https://linear.app/geoforge3d/issue/FLY-3164/529-canary-fly2127-canary-7b7c4e0e-f5ee-4fc2-ac0a-544468dfb145-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 按 phase ownership 执行。Design node 只产文档 / 图 / Founder HTML / review / TURN 回执；只有下游 writer execution 在收到**发给它自己**、可核验的原生精确指令时才修改 `probe.txt`。禁止跨 execution 复制 marker;本 issue 任何 phase 都不建 PR、不 push marker commit、不 ship / merge / deploy、不跑测试套件、不派发后继节点。

**Goal:** 产出经批准的设计，诚实回执当前 Claude design execution 的 TURN,并定义一份下游可执行、可中断恢复、QA 可独立复核的 marker 追加合同。

**Architecture:** Execution 身份、TURN 收据、原生指令是三份独立证据。TURN 只授予当前 phase 写权；marker 字节只能来自 comm DB 中 `to_agent = writer execution`、`from_agent = 注入 Lead` 的 `instruction` 行的 `content`。设计证据与(可选的)本地 marker commit 属于不同 phase、不同生命周期、不同推送策略。

**Tech Stack:** UTF-8 纯文本、Git、`flywheel-comm`、Mermaid CLI(`mmdc`)、自包含 HTML/CSS/JS。

---

## 权限来源(谁授权了什么)

| 来源 | 原文要点 | 由此得出 |
|---|---|---|
| Issue 描述(全文) | “append requested marker lines to probe.txt, **commit locally**, and acknowledge native mail or TURN. No product implementation, shipping or deployment.” | marker commit 只在本地，不 push、不建 PR;不改产品代码；不 ship / deploy。Issue **没有**禁止推送设计文档。 |
| 本 node 注入的 design 合同(当前 execution,最高优先) | “Commit and push the required artifacts”;“Commit and push the final HTML with the design artifacts” | 设计文档 commit 并 push 到 feature 分支 `project-slot-5-FLY-3164`(绝不 push main、不建 PR)。 |
| `stage set design_review` / review gate(本 execution `f0635f3b-…`) | review 绑定已提交的 plan blob;`await-codex-gate` 校验 committed blob + 干净 Git 状态;上一条 execution `2cd673b2-…` 的批准不迁移 | plan 每次修改都要先 commit 再重新 `stage set design_review --plan`。 |
| 同家族先例 FLY-3122 / FLY-3125 | design node push 了设计分支，marker commit 保持本地 | 与上面一致。 |

所以“不 push”只约束 `probe.txt` 的 marker commit。若下游通用模板要求 push / PR 才能完成，那是 Task 3 Step 8 的能力不匹配路径，不是推送许可。

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3164-claude-transport-canary/exploration.md` | design | Create | 范围、事实、方案比较 |
| `engineering/doc/FLY-3164-claude-transport-canary/research.md` | design | Create | 证据、driver 边界、Claude 投递路径、来源核验与 QA 审计合同 |
| `engineering/doc/FLY-3164-claude-transport-canary/plan.md` | design | Create | phase-safe 执行合同(本文件) |
| `engineering/doc/FLY-3164-claude-transport-canary/core-flow.mmd` / `.svg` | design | Create | 核心流程图 source + 本地渲染 |
| `engineering/doc/FLY-3164-claude-transport-canary/data-model.mmd` / `.svg` | design | Create | 身份 / TURN / 指令 / 证据数据模型 source + 本地渲染 |
| `engineering/doc/FLY-3164-claude-transport-canary/founder-report.html` | design | Create | Founder 友好摘要 + 逐节评论层 |
| `engineering/doc/FLY-3164-claude-transport-canary/progress.md` | `flywheel-comm progress` | Update | restart-resilient 游标 |
| `.flywheel/runs/<exec>/codex/design-review.json` | design | Create(git-ignored) | Bridge gate 读取的批准结果 |
| `probe.txt` | writer(implement)only, conditional | Create / append only | 只保存绑定 writer execution 的精确 marker 行 |

## Task 1: Design artifacts(本 node)

**Must not modify:** `probe.txt`、任何 `packages/**` 或其他产品路径。

- [ ] **Step 1: 确认 design TURN**

  ```bash
  node "$FLYWHEEL_COMM_CLI" turn --exec-id "$FLYWHEEL_EXEC_ID"
  ```

  Expected: 以 `yours phase=design` 开头。`not-yours` = 等待，不写 worktree。

- [ ] **Step 2: 本地渲染两张 Mermaid 图(不同 svgId)**

  ```bash
  D=engineering/doc/FLY-3164-claude-transport-canary
  mmdc -i $D/core-flow.mmd  -o $D/core-flow.svg  -w 1000 -b white --svgId FLY-3164-d1
  mmdc -i $D/data-model.mmd -o $D/data-model.svg -w 1000 -b white --svgId FLY-3164-d2
  ```

  Expected: 两条命令 exit 0;SVG 内联进 HTML;无运行时 mermaid.js、无远程资源。失败则按标准参数重试一次，仍失败就放置 “DIAGRAM PENDING LOCAL RENDER” 占位并报告。

- [ ] **Step 3: 校验 scope 与 HTML 合同**

  ```bash
  test ! -e probe.txt
  git diff --check
  git status --short
  ```

  Expected: 变更只在本 issue 文档夹。HTML 静态检查：恰好一个 `<script nonce="__CSP_NONCE__">`、无 inline 事件属性、无 CSP meta、无外部依赖；每个 section/card 下有一个 textarea,localStorage key 前缀含 `location.pathname` 且 try/catch;汇总卡每个分块都以 `【页面意见汇总】FLY-3164` 开头(~1800 字符分块);复制在 clipboard API 缺失或 promise reject 时回退 `document.execCommand('copy')`;运行时写 DOM 只用 `textContent`/`value`。

- [ ] **Step 4: Commit + push design artifacts(feature 分支)**

  ```bash
  git add engineering/doc/FLY-3164-claude-transport-canary
  git diff --cached --check
  git diff --cached --name-only   # 只能是本文档夹
  git commit -m "docs(FLY-3164): design Claude transport canary"
  git push -u origin project-slot-5-FLY-3164
  ```

  Expected: fast-forward push 到 feature 分支;`probe.txt` 不在 commit 中。

- [ ] **Step 5: Design review**

  每次 plan 修改提交后重新运行 `stage set design_review --plan engineering/doc/FLY-3164-claude-transport-canary/plan.md`,读取打印的 reviewer。每次 codex-companion 调用都带 `--model <reviewer> --effort <effort>`;每轮结束、改任何文件之前运行 `review-round design --exec-id "$FLYWHEEL_EXEC_ID" --round <n> --verdict <APPROVED|CHANGES_REQUESTED> --thread <threadId> --turn <turnId> --findings …`。`CHANGES_REQUESTED` → 修文档、commit/push、重新 `stage set`、再审，直到有效 `APPROVED`。

- [ ] **Step 6: 写入批准结果并过 gate**

  按 Bridge 指令 schema 写 `.flywheel/runs/$FLYWHEEL_EXEC_ID/codex/design-review.json`(取值来自 APPROVED 轮的 `review-round` 收据与最后一次 `stage set` 的 requestId / blob),然后运行 `await-codex-gate design --exec-id "$FLYWHEEL_EXEC_ID"`,要求通过。本 node **不**运行 `stage set implement`。

## Task 2: 发布 Founder HTML 并只完成 design phase

- [ ] **Step 1: 发布已提交的 HTML**

  ```bash
  node "$FLYWHEEL_COMM_CLI" publish-report --html engineering/doc/FLY-3164-claude-transport-canary/founder-report.html --project test-slot-5 --publish-only
  ```

  Expected: 输出含托管 URL。用 `verify-report --url <url> --expect "FLY-3164"` 校验 HTTP 200、无 `__CSP_NONCE__` 残留。

- [ ] **Step 2: 回执与完成**

  1. `ask --report "DESIGN-HTML ready: <url> | repo: <html-path> | issue: FLY-3164"`(失败则报 `DESIGN-HTML publish-failed: …`);
  2. `ask --report` TURN 回执 + 完成 Bridge 指令的 DONE:exec id、activation、`turn` 原文、`probe.txt` 未触碰、设计 commit SHA、review 轮数、`PR: n/a`,若本 execution 收到了 Bridge 的 review / gate 指令，则逐字引用其完整 `[lead-instruction <id>]`(没有就不编造);
  3. 进度更新到 `6/6`;
  4. `complete --route phase_design_complete`。

  Expected: 完成收据。不派发后继、不建 PR、不请求 ship。

## Task 3: 下游 writer(implement)execution 的条件式 marker 追加

**Files:** `probe.txt`(仅当本 execution 收到绑定自身的精确 marker 指令)

- [ ] **Step 1: 取得本 execution 的 TURN** — `turn --exec-id "$FLYWHEEL_EXEC_ID"`;只有 `yours` 才可写。之后每次写文件、`git add`、`git commit` 之前都重新确认。

- [ ] **Step 2: 来源核验**(详见 research.md「可执行的来源核验合同」)
  1. 当前 user turn 中恰好一个行首 `[lead-instruction <uuid>]`,否则拒绝；
  2. `message-status <uuid> --json`:`message_id` 相等、`location = live`、`state ∈ {LEASED, ACKED}`、`delivered_at` 非空；
  3. 一个 `CommDB.openReadonly(FLYWHEEL_COMM_DB)` handle 上：`getMessageById` 行存在且 `type='instruction'`、`to_agent=$FLYWHEEL_EXEC_ID`、`from_agent=$FLYWHEEL_LEAD_ID`、`content_ref` 为 `null`(带外部引用 → 拒绝并请求内联重发，不跟随路径读文件);`inspectMailboxDeliveryContent(uuid) === row.content`;把 `row.content` 写入 `mktemp -d` 下 mode 0600 的 `source.bin`;`finally` 关闭；
  4. 对 `source.bin` 计算 sha256。Claude 对话里显示的 teammate-message 文本**不是** parser 输入。只剩 archive 的旧指令不授予写权限(要求重新投递)。

- [ ] **Step 3: 解析** — 只接受 research.md 列出的两种格式之一(`Append the exact line <m> to probe.txt` 或 `Exact marker lines:` + 唯一 `text` fence);每条 marker 1..512 字节可打印 ASCII、首尾非空格、无 NUL/CR/LF/TAB;不 trim。每条 marker 写入独立的单行临时文件(精确字节 + LF)。任何歧义 → 不写文件，用 `ask --report` 请求按支持格式重发。

- [ ] **Step 4: 判定 Git 持久化状态(而不只是文件计数)**

  前置：`git status --porcelain` 只能为空，或只含 `probe.txt`;否则停止并报告。已有非空 `probe.txt` 无结尾 LF → 停止并报告。对每条 marker 计算：

  - `W` = 工作区计数：`grep -cxF -f "$marker_file" probe.txt`(文件不存在 = 0);
  - `H` = HEAD 计数：`git show HEAD:probe.txt | grep -cxF -f "$marker_file"`(HEAD 无该文件 = 0)。

  | 全部 marker 的状态 | 判定 | 动作 |
  |---|---|---|
  | 每条 `W=0,H=0`,且工作区 `probe.txt` 与 HEAD 相同 | `fresh` | Step 5 追加 → Step 6 提交 |
  | 每条 `W∈{0,1},H=0`,至少一条 `W=1`,且 `git diff HEAD -- probe.txt`(新文件则整份内容)只新增本指令的 marker 行、无删除 | `appended_uncommitted`(上次在 commit 前中断) | 只为 `W=0` 的 marker 执行 Step 5,然后 Step 6 提交 |
  | 每条 `W=1,H=1`,且工作区与 HEAD 无差异 | `already_committed` | 不追加、不 commit;Step 7 定位并核验原 commit,回报 `already_present` / 新增 0 |
  | 任一计数 ≥2,或 `W=0,H=1`,或其他混合 / 无法归属的差异 | `integrity_error` / `insufficient_evidence` | 不写、不 commit,如实报告 |

- [ ] **Step 5: 追加并检查(仅 `fresh` / `appended_uncommitted`)**

  ```bash
  cat "$marker_file" >> probe.txt     # 每条 W=0 的 marker 各执行一次
  git diff --check -- probe.txt
  git add probe.txt
  git diff --cached --name-only       # 只能是 probe.txt
  git diff --cached --unified=0 -- probe.txt   # 只新增本指令 marker、无删除
  ```

- [ ] **Step 6: 本地 commit(仅当 staged delta 非空)**

  整个块用 `bash` 执行(不是 zsh),任何非零退出都立即停止，不生成成功回执：

  ```bash
  git diff --cached --quiet -- probe.txt
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "nothing staged"; exit 3; fi      # 无 delta:停止，回到 Step 4 重新分类
  if [ "$rc" -ne 1 ]; then echo "git diff failed rc=$rc"; exit 2; fi
  before=$(git rev-parse --verify 'HEAD^{commit}') || exit 2
  git commit -m "test(FLY-3164): record requested transport marker" || { echo "commit failed"; exit 2; }
  after=$(git rev-parse --verify 'HEAD^{commit}') || exit 2
  [ "$after" != "$before" ] || { echo "HEAD did not move"; exit 2; }
  [ "$(git rev-parse 'HEAD^')" = "$before" ] || { echo "unexpected parent"; exit 2; }
  [ "$(git show --format= --name-only HEAD)" = "probe.txt" ] || { echo "commit touches other paths"; exit 2; }
  echo "marker_sha=$after"
  ```

  只有整个块 exit 0 时,`marker_sha` 才是本次 marker commit;否则不得用 HEAD(可能是旧提交)作回执。不 push、不建 PR。

- [ ] **Step 7: `already_committed` 的原 commit 定位**

  按时间顺序遍历 `git log --reverse --format=%H -- probe.txt`,找到第一个满足“该 commit 中每条 marker 计数 = 1、其父 commit(或文件不存在)中计数 = 0”的 commit `C`(计数一律用 `grep -cxF -f "$marker_file"`,marker 不进 argv)。核验 `git show --format= --name-only C` 只有 `probe.txt`,且 `git diff C^ C -- probe.txt` 只新增本指令的 marker。找不到或不唯一 → `insufficient_evidence`,不得用当前 HEAD 冒充。

- [ ] **Step 8: 回执与路由不匹配**

  `ask --report "DONE: [lead-instruction <uuid>] state=<fresh|appended_uncommitted|already_present> markers=<n> appended=<k> | writer_exec=$FLYWHEEL_EXEC_ID | lead=$FLYWHEEL_LEAD_ID | source_sha256=<hash> | commits: <marker-sha> | PR: n/a"`(失败状态用对应关键词，不写 commit)。`implement` 的标准 route `needs_review` 需要 PR,而本 issue 只允许本地 commit:不得发明 `no_code` route、不得造空 commit 或 PR,在回执中写明 capability mismatch,启动注入的问题 watcher 并 park,由 workflow owner 决定 server 授权的 close / cancel / retemplate。

## Task 4: QA(若激活，只读审计)

QA 是另一个 execution,没有收到发给 writer 的指令，**不得**用自己的 `FLYWHEEL_EXEC_ID` 或当前 turn 重跑 Step 2。

- [ ] **Step 1: 确定预期身份** — writer execution id 取自 workflow 记录(`workflow_run_node` 中 `implement` 节点的 `execution_id`),并与 writer DONE 回执的发送者一致；Lead id、instruction id、`source_sha256`、marker commit SHA 取自该回执。任何缺失 → `unverifiable`。
- [ ] **Step 2: 投递收据** — `message-status <instruction_id> --json`:`message_id` 相等、`location ∈ {live, archived}`、`delivered_at` 非空(live 时 `state ∈ {LEASED, ACKED}`)。
- [ ] **Step 3: 指令行身份** — 只读打开 comm DB:live 用 `getMessageById`;已归档则用与 `MailboxQueue.archivedMailboxJson`(runtime `mailbox-queue.js:365`)相同的参数化查询读取归档快照 JSON(`mailbox_log` 中 `event='archived'` 的最新 `row_json`,否则 `mailbox_terminal_archive.mailbox_json`)。断言 `type='instruction'`、`to_agent = 预期 writer exec`、`from_agent = 预期 Lead`、`content_ref` 为空，并且 `sha256(content) = 回执中的 source_sha256`。
- [ ] **Step 4: 内容与 commit 一致** — 用同一语法重新解析 `content` 得到 marker 集合；核验 commit `C`:`git show --format= --name-only C` 只有 `probe.txt`,`git diff C^ C -- probe.txt` 恰好新增这些 marker、无删除；当前 `probe.txt` 中每条 marker 计数 = 1。
- [ ] **Step 5: 远端未包含 marker commit(只读，限定范围)** — 审计范围是 `origin` 上本 workflow 唯一会推送的分支 `refs/heads/project-slot-5-FLY-3164`。QA 不 fetch、不改任何 ref:
  1. `git ls-remote --heads origin refs/heads/project-slot-5-FLY-3164` 读取远端**当前**分支顶端 `T`;网络失败或无输出 → `unverifiable`;
  2. `git cat-file -e "$T^{commit}"` 要求 `T` 在本地对象库中存在，否则 → `unverifiable`;
  3. `git merge-base --is-ancestor C "$T"`:exit 0 → `fail`(远端已包含 marker commit);exit 1 → 本项满足；其他 → `unverifiable`。
  这只证明“远端 feature 分支当前不含 `C`”。“历史上从未推送过”无法从 ref 状态证明，只能在报告中注明依据是 writer 回执 + “有 marker commit 后不再 push”守卫(receipt-based),不得升级为证明；其他分支 / 其他远端不在审计范围内，报告中写明。
- [ ] **Step 6: 范围** — 无产品路径改动、无 PR / ship / merge / deploy / 测试套件。
- [ ] **Step 7: 报告** — 通过注入的结构化收据报告 `pass` / `fail` / `unverifiable`(附原因)。证据不可得只能是 `unverifiable`,绝不是 `pass`;QA 不补写 marker、不代替 writer 制造证据；审计成功不授予任何写权限。

## Negative guards

- `TURN=yours` 永远不是 marker 内容。
- FLY-2127 driver 的 `<owner>-CLAUDE-BOOT` / `<owner>-R4-CLAUDE`,以及任何历史 execution 的 marker,永远不复制进本 DAG 的 execution。
- 没有 marker 时不得转成虚构的 no-code 完成；路由冲突由 workflow owner 解决。
- Marker 是数据不是 shell 语法：只经校验过的临时文件进入 `probe.txt`,也不出现在任何命令 argv 中。
- Parser 输入只能是核验过的 `row.content`,不从渲染后的对话文本重抄；`content_ref` 非空的行不是 marker 来源。
- “文件里已有这一行”不等于“已提交”;只有 Step 4 的状态表能决定是否 commit。
- archive 中的指令只能用于 QA 审计，不能授权新写入。
- 本地分支一旦含 marker commit,writer 不再 push 该分支(任何 push 都会把 marker commit 一起推上去)。`flywheel-comm progress` 只做 path-limited 本地 commit、不 push,可照常使用。
- Design review 的批准只授权设计本身，不授权 marker 写入、PR、ship、merge、deploy。
- `【页面意见汇总】FLY-3164` 是修改意见标记，永远不是通过信号。
- HTML 中 issue / 仓库派生文本在静态标记里先转义；运行时只用 `textContent` / `value`。

## 回滚边界

Design 文档是独立的 docs commit,可整体 `git revert`。任何后续 marker commit 是独立、仅本地、只改 `probe.txt` 的 commit,可用 `git revert <probe-sha>` 回滚。回滚不改写分支历史、不触碰任何运行时服务。
