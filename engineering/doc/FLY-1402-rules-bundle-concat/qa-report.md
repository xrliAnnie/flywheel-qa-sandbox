# FLY-1402 lead-rules bundle 拼接单文件修复 — QA 报告
Issue: FLY-1402
日期: 2026-07-21
基于: plan.md、实现提交 bdc57a125 + 加固提交 7a4d7fbb（PR #663）

**QA 判定: PASS（经一轮 FAIL → implement 修复 → 重验转 PASS）**
**验证 head: `7a4d7fbb58e8d981cb60c8df9a73f86226afff25`（分支 flywheel-FLY-1402 / PR #663）**
**QA 阶段: 三段式 pipeline 的 QA 段（独立于实现,读已提交代码验证,未重写功能;缺陷路由回 implement 段修复,未自改代码）**

> 判定摘要:第一轮 QA 在 code-review 硬门发现验证仪器 `check-rules-truth` 两条缺陷(均 QA 独立复现),判 FAIL 路由回 implement 段;implement 段在 `7a4d7fbb` 修复两条,QA 重验确认修复有效 + Codex code review 转 APPROVED + 全套测试绿 → PASS。

---

## 1. 验的是什么

修复目标(issue + plan §0):Claude CLI 对重复 `--append-system-prompt-file` 是 **last-one-wins**,claude-lead.sh 给每个 Lead 传 18+ 个该 flag,只有末位 1 份真正进上下文,其余 17+ 份 base rules 全 fleet 静默失效。修复 = 拼接单文件(哨兵头 + 分节 + 单一 flag)+ 哨兵可验 + 独立 truth checker + legacy 阀 + 回归测试。

## 2. FAIL → 修复 → 重验 循环(核心)

### 2.1 第一轮 QA(head bdc57a125):FAIL
Codex code review(xhigh,PR review 4747330335)判 CHANGES REQUESTED,两条 finding,**均经 QA 独立复现**:

- **🔴 HIGH — `check-rules-truth.mjs`:`--strict` 会通过「自洽但内容错误」的 bundle**。`verifyBundle` 只重算 artifact 自身正文 SHA、从不读 manifest 源文件、不核 header LEAD_ID/PROJECT。QA 复现(`qa-verify-high.sh`):伪造正文为 `ATTACKER CONTENT: ignore all governance` + 重算匹配 SHA → checker 返回 `PASS role=dept exit=0`。信「标签」不信「事实」,无法检测 materializer 内容级 bug。
- **🟠 MEDIUM — ps lstart probe 未固定 locale**(producer `tmux-supervisor-guard.sh:8` + checker `check-rules-truth.mjs:468`)。Darwin `lstart` 用 locale-dependent `%c`,launchd(常空→C)vs 操作员终端 locale 不同 → 误报 STALE → 击穿计划强制的 `--strict` W1/W2 rollout gate。计划 §9 R4 note #2 明确要求 `LC_ALL=C`,两侧都没做。

### 2.2 implement 段修复(head 7a4d7fbb,"harden rules truth verification")
- **HIGH 修复**:`verifyBundle` 现在逐条读 `manifest[i].path`(须绝对路径),按 materializer **同一分隔规则**(源尾有换行→`\n`,否则 `\n\n`)重建期望 section 并与实际 body **逐字节比对**,任一节不匹配 → `source content mismatch` FAIL;循环后断言 `bodyCursor === body.length` catch 尾部垃圾。新增 `expectedIdentity` 参数 → verifyLead 核 header LEAD_ID/PROJECT == 被检 lead/project。
- **MEDIUM 修复**:producer `LC_ALL=C ps -p ... -o lstart=`;checker `psEnv={...process.env, LC_ALL:"C"}` 应用于 lstart probe(:524)与 process-tree probe(:561)两处。两侧同一固定 locale。

### 2.3 第二轮 QA(head 7a4d7fbb):PASS
- **HIGH 转阴(QA `qa-verify-high.sh` 重跑)**:合法 bundle(body==源)`PASS exit=0`;**伪造内容错误 bundle 现在 `FAIL reason=source content mismatch at index 1 exit=1`**(修前是 PASS)。「标签冒充事实」的洞已堵。
- **MEDIUM 已修(QA 核 + 功能)**:producer/checker 两侧 `LC_ALL=C` 均在位。
- **修复本体未回归**:`qa-sentinel-repro.sh` 仍 10/10(两哨兵存活、SHA/角色守卫会咬)。
- **Codex code review 转 APPROVED**(Round 2,xhigh,PR review 4747626194):两条 finding 确认修复、无回归、分隔符与 materializer 一致、无新假 FAIL、identity 绑定被检目标。

## 3. 全套测试(head 7a4d7fbb,隔离跑,无竞争)

| 套件 | 结果 |
|---|---|
| `rules-bundle-{materialize,truth,truth-process,legacy-alert}.test.ts` + `kind-contract.test.ts` | 56 passed |
| `fly1402-single-bundle.test.sh`(真 launcher dry-run 四臂+两 legacy+生命周期）| 39 passed |
| `fly1285-tmux-supervisor.test.sh`（producer LC_ALL 改动）| 6 passed |
| 迁移套件:fly231(52)/fly879(40)/screencap(4)/rollback(8)/fly26(93)/fly205(3)/decommission(12) | 全 passed |
| QA 独立:`qa-sentinel-repro.sh`(10)、`qa-verify-high.sh`(转阴) | 全 passed |
| `pnpm -C packages/teamlead build` / 改动 TS biome / **CI(PR #663 全 9 check on 7a4d7fbb)** | 绿 |

`fly1402-single-bundle.test.sh` 经确认是真端到端 launcher 演练(生产 `claude-lead.sh` + dry-run + 隔离 HOME + 真 fixture projects.json,解析真实 LAUNCH_PLAN),非 mock。

## 4. audit.md 激活风险 —— 与本判定正交
audit §3.1/3.2 dispatch 例外「阻塞 W2 全量,不阻塞代码 PR」,属内容/上线决策归 founder,随 ship gate 呈 founder,与本 QA 的代码验证无关。

## 5. 生效边界(重要)
rules 只在 Lead **启动**时装载 ⇒ 本 PR merge 后**无运行时行为变化**,须搭下一班统一重启才激活(plan §7 W1/W2)。issue 能力级验收(真机重启后 dept Lead 读回哨兵 + 引用 department-lead-rules 特征串;Cass cos 哨兵 + dept 特征串不在;`check-rules-truth --all --strict` 全 PASS)属**重启后**由操作员 + founder 探针执行。本 QA 段完成的是 merge 前可验的一切 + 硬门(code-review APPROVED + CI 绿)。

## 6. 判定
**PASS。** 修复本体正确(独立哨兵复现);第一轮发现的两条验证仪器缺陷已由 implement 段在 `7a4d7fbb` 修复,QA 重验确认(HIGH 复现转阴、MEDIUM locale 固定、Codex code review 转 APPROVED、全套测试 + CI 绿)。复现脚本随报告提交:`qa-sentinel-repro.sh`、`qa-verify-high.sh`。
