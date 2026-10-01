# FLY-3164 Claude 传输探针 — 实施计划
Issue: FLY-3164 (https://linear.app/geoforge3d/issue/FLY-3164/529-canary-fly2127-canary-7b7c4e0e-f5ee-4fc2-ac0a-544468dfb145-claude)
日期: 2026-10-01
基于: research.md

> **For agentic workers:** 按 phase ownership 执行。Design node 只产文档 / 图 / Founder HTML / review / TURN 回执；只有下游 execution 在收到**发给它自己**、可核验的原生精确指令时才修改 `probe.txt`。禁止跨 execution 复制 marker;本 issue 任何 phase 都不建 PR、不 push marker commit、不 ship / merge / deploy、不跑测试套件、不派发后继节点。

**Goal:** 产出经批准的设计，诚实回执当前 Claude design execution 的 TURN,并定义一份下游可执行、QA 可复核的 marker 追加合同。

**Architecture:** Execution 身份、TURN 收据、原生指令是三份独立证据。TURN 只授予当前 phase 写权；marker 字节只能来自 comm DB 中 `to_agent = 当前 execution`、`from_agent = 注入 Lead` 的 `instruction` 行的 `row.content`。设计证据与(可选的)本地 marker commit 属于不同 phase、不同生命周期。

**Tech Stack:** UTF-8 纯文本、Git、`flywheel-comm`、Mermaid CLI(`mmdc`)、自包含 HTML/CSS/JS。

---

## 文件矩阵

| 路径 | Owner phase | 动作 | 单一职责 |
|---|---|---|---|
| `engineering/doc/FLY-3164-claude-transport-canary/exploration.md` | design | Create | 范围、事实、方案比较 |
| `engineering/doc/FLY-3164-claude-transport-canary/research.md` | design | Create | 证据、driver 边界、Claude 投递路径、来源核验合同 |
| `engineering/doc/FLY-3164-claude-transport-canary/plan.md` | design | Create | phase-safe 执行合同(本文件) |
| `engineering/doc/FLY-3164-claude-transport-canary/core-flow.mmd` / `.svg` | design | Create | 核心流程图 source + 本地渲染 |
| `engineering/doc/FLY-3164-claude-transport-canary/data-model.mmd` / `.svg` | design | Create | 身份 / TURN / 指令 / 证据数据模型 source + 本地渲染 |
| `engineering/doc/FLY-3164-claude-transport-canary/founder-report.html` | design | Create | Founder 友好摘要 + 逐节评论层 |
| `engineering/doc/FLY-3164-claude-transport-canary/progress.md` | `flywheel-comm progress` | Update | restart-resilient 游标 |
| `probe.txt` | implement only, conditional | Create / append only | 只保存绑定当前 writer execution 的精确 marker 行 |

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

- [ ] **Step 4: Commit + push design artifacts**

  ```bash
  git add engineering/doc/FLY-3164-claude-transport-canary
  git diff --cached --check
  git diff --cached --name-only   # 只能是本文档夹
  git commit -m "docs(FLY-3164): design Claude transport canary"
  git push -u origin project-slot-5-FLY-3164
  ```

  Expected: fast-forward push;`probe.txt` 不在 commit 中。

- [ ] **Step 5: Design review**

  运行 `stage set design_review --plan engineering/doc/FLY-3164-claude-transport-canary/plan.md`,按其打印的 review 流程执行；每次 codex-companion 调用都带 Bridge 给出的 reviewer `--model/--effort`,每轮结束立刻 `review-round design --exec-id "$FLYWHEEL_EXEC_ID" --round <n> --verdict <APPROVED|CHANGES_REQUESTED> --thread <codexThreadId>`。`CHANGES_REQUESTED` → 修文档、重新 commit/push、再审，直到有效 `APPROVED`。

## Task 2: 发布 Founder HTML 并只完成 design phase

- [ ] **Step 1: 发布已提交的 HTML**

  ```bash
  node "$FLYWHEEL_COMM_CLI" publish-report --html engineering/doc/FLY-3164-claude-transport-canary/founder-report.html --project test-slot-5 --publish-only
  ```

  Expected: 输出含托管 URL。用 `verify-report --url <url> --expect "FLY-3164"` 校验 HTTP 200、无 `__CSP_NONCE__` 残留。

- [ ] **Step 2: 回执与完成**

  1. `ask --report "DESIGN-HTML ready: <url> | repo: <html-path> | issue: FLY-3164"`(失败则报 `DESIGN-HTML publish-failed: …`);
  2. `ask --report` TURN 回执：exec id、activation、`turn` 原文、`probe.txt` 未触碰、设计 commit SHA、`PR: n/a`;
  3. 进度更新到 `6/6`;
  4. `complete --route phase_design_complete`。

  Expected: 完成收据。不派发后继、不建 PR、不请求 ship。

## Task 3: 下游 implement execution 的条件式 marker 追加

**Files:** `probe.txt`(仅当本 execution 收到绑定自身的精确 marker 指令)

- [ ] **Step 1: 取得本 execution 的 TURN** — `turn --exec-id "$FLYWHEEL_EXEC_ID"`;只有 `yours` 才可写。

- [ ] **Step 2: 来源核验**(详见 research.md「可执行的来源核验合同」)
  1. 当前 user turn 中恰好一个行首 `[lead-instruction <uuid>]`,否则拒绝；
  2. `message-status <uuid> --json`:`message_id` 相等、`location ∈ {live, archived}`、`state ∈ {LEASED, ACKED}`、`delivered_at` 非空；
  3. 一个 `CommDB.openReadonly(FLYWHEEL_COMM_DB)` handle 上：`getMessageById` 行存在且 `type='instruction'`、`to_agent=$FLYWHEEL_EXEC_ID`、`from_agent=$FLYWHEEL_LEAD_ID`;`inspectMailboxDeliveryContent(uuid) === row.content`;把 `row.content` 写入 `mktemp -d` 下 mode 0600 的 `source.bin`;`finally` 关闭；
  4. 对 `source.bin` 计算 sha256。Claude 对话里显示的 teammate-message 文本**不是** parser 输入。

- [ ] **Step 3: 解析** — 只接受 research.md 列出的两种格式之一(`Append the exact line <m> to probe.txt` 或 `Exact marker lines:` + 唯一 `text` fence);每条 marker 1..512 字节可打印 ASCII、首尾非空格、无 NUL/CR/LF/TAB;不 trim。任何歧义 → 不写文件，用 `ask --report` 请求按支持格式重发。

- [ ] **Step 4: 幂等检查** — 每条 marker 写入独立的单行临时文件；`grep -cxF -f "$marker_file" probe.txt`:0 追加 / 1 跳过 / ≥2 integrity error;已有非空文件无结尾 LF → 拒绝。

- [ ] **Step 5: 追加并检查 staged bytes**

  ```bash
  cat "$marker_file" >> probe.txt
  git diff --check -- probe.txt
  git add probe.txt
  git diff --cached --name-only       # 只能是 probe.txt
  git diff --cached --unified=0 -- probe.txt   # 只有新增、无删除
  ```

- [ ] **Step 6: 本地 commit 与如实回执**

  ```bash
  git commit -m "test(FLY-3164): record requested transport marker"
  git show --format= --name-only HEAD   # 只能是 probe.txt
  ```

  `ask --report "DONE: [lead-instruction <uuid>] appended <n> marker(s) | source sha256 <hash> | commits: <sha> | PR: n/a"`。不 push、不建 PR、不 ship。

- [ ] **Step 7: 无 marker / 路由不匹配** — `implement` 的标准 route `needs_review` 需要 PR,而本 issue 禁止 PR。无论有无 marker commit,都不得发明 `no_code` route、不得造空 commit 或 PR:用结构化回执报告“结果 + capability mismatch”,启动注入的问题 watcher 并 park,由 workflow owner 决定 server 授权的 close / cancel / retemplate。

## Task 4: QA(若激活，只读)

- [ ] marker 字节来自 writer execution 自己的 instruction 行(复跑 Step 2 的断言，比较 `source.bin` 哈希);
- [ ] 每条 marker 在 `probe.txt` 中恰好出现一次；marker commit 只改 `probe.txt`;
- [ ] 无产品路径改动、无 push / PR / ship / merge / deploy / 测试套件；
- [ ] 通过注入的结构化收据报告，不补写 marker、不代替 writer 制造证据。

## Negative guards

- `TURN=yours` 永远不是 marker 内容。
- FLY-2127 driver 的 `<owner>-CLAUDE-BOOT` / `<owner>-R4-CLAUDE`,以及任何历史 execution 的 marker,永远不复制进本 DAG 的 execution。
- 没有 marker 时不得转成虚构的 no-code 完成；路由冲突由 workflow owner 解决。
- Marker 是数据不是 shell 语法：只经校验过的临时文件进入 `probe.txt`。
- Parser 输入只能是核验过的 `row.content`,不从渲染后的对话文本重抄。
- Design review 的批准只授权设计本身，不授权 marker 写入、PR、ship、merge、deploy。
- `【页面意见汇总】FLY-3164` 是修改意见标记，永远不是通过信号。
- HTML 中 issue / 仓库派生文本在静态标记里先转义；运行时只用 `textContent` / `value`。

## 回滚边界

Design 文档是独立的 docs commit,可整体 `git revert`。任何后续 marker commit 是独立、仅本地、只改 `probe.txt` 的 commit,可用 `git revert <probe-sha>` 回滚。回滚不改写分支历史、不触碰任何运行时服务。
