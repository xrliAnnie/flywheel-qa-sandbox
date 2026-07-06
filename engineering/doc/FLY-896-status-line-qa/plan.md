# Plan: FLY-887 status-line 真机检查载具 — FLY-896 实施计划

Issue: FLY-896 (https://linear.app/geoforge3d/issue/FLY-896)
日期: 2026-07-05
基于: exploration.md、research.md(brainstorm gate 已批,Codex design review 按 FLY-895 先例 self-approve)

> **执行方**:本 pipeline 的 **Implement phase** 与 **QA phase** Runner(FLY-887 三段协议,共享分支 `project-slot-3-FLY-896` 单一 worktree)。执行由 Flywheel stages/gates 驱动;动 worktree 前 `turn --exec-id` 自查一律强制。

**Goal**:用最小 doc-only 载荷把三段 pipeline(含**一轮 deliberate FAIL→wake→fix→RE-TEST→PASS**,Lead 硬性要求)完整跑一遍,让外部观察者在 [FLY-896] thread 上核验 FLY-887 status-line 的全叙事。

**Architecture**:载荷 = 新建 `doc/qa/sandbox-notes.md`(entry 首版**刻意**缺句尾句号 = 确定性 FAIL 靶);QA 用结构性 `verify.sh` 把关。状态行本身由 Bridge 随 phase transition 自动驱动——**本仓两个 phase Runner 都看不到 Discord,Discord 侧核验属于外部 harness/founder**,不在本计划任务内。

**TDD 豁免**(gate 已批,doc-only 无运行时面);以 verify.sh 结构检查替代。**底线:改动最小;沙箱分支/PR 永不合回真分支;ship 由 founder/harness 批,不在 Runner 手里。**

---

## 预期 status-line 叙事(外部观察者对照表;词表/语义 = `phase-orchestrator.ts:110-159` ground truth)

| # | Pipeline 时刻 | 预期渲染 |
|---|---|---|
| 1 | Design 进行中 | `🎨design(active)·🔨implement(pending)·🧪qa(pending)` |
| 2 | Design park 后,Implement 进行中 | `🎨design(parked)·🔨implement(active)·🧪qa(pending)` |
| 3 | Implement needs_review + park,QA 进行中 | `🎨design(parked)·🔨implement(parked)·🧪qa(active)` |
| 4 | QA FAIL,implement 被 wake 修复中 | **与 #3 相同**——woken fix-in-progress 的 status 仍是 `awaiting_review` → 渲染 `parked`,这是 FLY-887 文档化的 cosmetic 取舍(`phase-orchestrator.ts:98-108`),**不是 bug** |
| 5 | fix 后 RE-TEST 复验中 | 与 #3 相同 |
| 6 | ship + finalize 后 | `🎨design(done)·🔨implement(done)·🧪qa(done)` |

单条消息 in-place edit(消息 id 持久于 `chat_threads`),挂主 chat thread,绝不落 per-role thread。

---

### Task 1(Implement phase): 创建载荷文件

**Files:** Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1: 写入文件(逐字;注意 run-log 条目刻意不带句尾句号——这是 QA round 1 的确定性 FAIL 靶,勿"顺手"补上)**

```markdown
# QA sandbox notes

Scratch fixture file for QA-sandbox E2E vehicles (FLY-202 / FLY-895 / FLY-896 lineage).
Sandbox branches only — never merged to real branches.

## E2E run log

- 2026-07-05 — FLY-896 slot-3 real-machine check of the FLY-887 founder-visibility status line (three-stage keep-alive)
```

- [ ] **Step 2: 单 commit + push**

```bash
git add doc/qa/sandbox-notes.md
git commit -m "docs(FLY-896): add E2E run log entry for FLY-887 status-line real-machine check"
git push -u origin project-slot-3-FLY-896
```

- [ ] **Step 3: 更新 progress ledger**(`flywheel-comm progress --phase implement --cursor 1/1`)

### Task 2(Implement phase): PR + 交接

- [ ] **Step 1: 开 PR 到 sandbox main**(body 含 `## Linear Issue` 节:FLY-896 + https://linear.app/geoforge3d/issue/FLY-896;标注 throwaway sandbox vehicle, never merge to real branches)
- [ ] **Step 2: 按 Runner 协议走 `stage set pr_created` → Codex code review(Bridge 自动触发)→ `gate approve_to_ship --no-block` + `complete --route needs_review`**(逐字命令以 Implement Runner 自己提示词里的 APPROVE GATE 块为准)
- [ ] **Step 3: park**(`park --reason "three-stage implement parked awaiting QA"`),STOP 等 wake;被 FIX wake 后先 `turn` 自查再动手

### Task 3(QA phase): round 1 — structural verify,预期 FAIL

**Files:** Create: `qa-fly896/verify.sh`(qa-fly<NNN> 目录先例:qa-fly294/qa-fly310)、`engineering/doc/FLY-896-status-line-qa/qa-report.md`

- [ ] **Step 1: 写 verify.sh(逐字)**

```bash
#!/bin/bash
# FLY-896 structural verify — doc/qa/sandbox-notes.md payload checks (FLY-895 precedent)
set -u
f="doc/qa/sandbox-notes.md"
pass=0; fail=0
check() { if [ "$2" -eq 0 ]; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }
[ -f "$f" ] && grep -q '^## E2E run log$' "$f"; check "file exists with '## E2E run log' section" $?
grep -q '^- 2026-07-05 — FLY-896 slot-3 real-machine check of the FLY-887 founder-visibility status line' "$f"; check "run-log entry present (date + issue + slot + subject)" $?
grep -q '^- 2026-07-05 — FLY-896 .*\.$' "$f"; check "run-log entry ends with terminal period (house bullet style)" $?
echo "---"
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED ($pass/$((pass+fail)))"; else echo "CHECKS FAILED ($fail/$((pass+fail)) failing)"; exit 1; fi
```

- [ ] **Step 2: 运行 `bash qa-fly896/verify.sh`,预期输出**:check 1-2 PASS、check 3 **FAIL**(缺句号)、exit 1
- [ ] **Step 3: 写 qa-report.md round 1 段(FAIL verdict + 三项 check 结果 + 被测 head sha),连同 verify.sh 一起 commit + push**(`test(FLY-896): QA round 1 — structural verify.sh + FAIL report (missing terminal period)`)
- [ ] **Step 4: `qa-result --status fail --summary "run-log entry missing terminal period (house style); see qa-fly896/verify.sh check 3"`,然后 park 等 RE-TEST wake。不跑 `complete`、不开 approve gate(FAIL 时禁止)**

### Task 4(Implement phase,被 FIX wake): 修复

- [ ] **Step 1: `turn --exec-id` 自查,`yours` 才动手;读分支上 QA 已 commit 的 findings**
- [ ] **Step 2: 单字符修复——run-log 条目句尾加 `.`**(`(three-stage keep-alive)` → `(three-stage keep-alive).`)
- [ ] **Step 3: `bash qa-fly896/verify.sh` 本地预检,预期 ALL CHECKS PASSED (3/3)**
- [ ] **Step 4: commit + push**(`fix(FLY-896): add terminal period to E2E run-log entry (QA round 1)`),按协议重过 Codex review → 重跑 `gate approve_to_ship --no-block` + `complete --route needs_review` → 重新 park

### Task 5(QA phase,被 RE-TEST wake): round 2 — 复验 PASS

- [ ] **Step 1: `turn` 自查;worktree 已在新 head(FLY-887 零 checkout 编舞),直接 `bash qa-fly896/verify.sh`,预期 ALL CHECKS PASSED (3/3)**
- [ ] **Step 2: qa-report.md 追加 round 2 段(RE-TEST PASS + fix 最小性确认:单字符 diff 无 scope creep),commit + push**(`docs(FLY-896): QA round 2 — RE-TEST confirms fix, status-line E2E cycle closed`)
- [ ] **Step 3: `qa-result --status pass` → 按 QA Runner 提示词走 approve gate 流;之后 ship/merge 全程 founder-gated(verify-approval 是唯一权威),Runner 绝不自 merge**

---

## 验收

1. 三段全链跑通:design park → implement 同 worktree 接手 → QA 同 worktree 验证 → **真实 FAIL→wake→fix→RE-TEST→PASS 一轮**(Lead 硬性要求)→ approve gate。
2. 外部观察者对照上表核验 [FLY-896] thread 状态行叙事(含 #4 的"渲染不变属预期"注记)。
3. 仓库侧净改动 = `doc/qa/sandbox-notes.md`(9 行)+ `qa-fly896/verify.sh` + qa-report.md + 本 doc folder——零产品代码。
