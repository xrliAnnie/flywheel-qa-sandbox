# FLY-1023 Buddy onboarding 全量 build — QA 报告(三段式 QA 阶段)

Issue: FLY-1023
日期: 2026-07-09
基于: plan.md · exploration.md · research.md · progress.md + 本分支已提交实现

> **裁决:PASS(有边界)** — 可 ship 的 hermetic + 手工验证面全绿;plan §4 的「真机/QA 段」(干净 VM + 真业务系统凭证)因结构性约束**不在本次 QA 覆盖内**,是 plan 早已单列的独立环节,不是缺陷(详见 §4)。

---

## 1. 被验对象

PR #523 `feat(FLY-1023): Buddy onboarding full build — one command to first output`,本分支 `flywheel-FLY-1023`。相对 main:**+4257 行 / 58 文件**,其中:

- **全新文件**:`scripts/flywheel-onboard.sh` · `flywheel-buddy.sh` · `flywheel-buddy-steps.sh` · `scripts/lib/agent-cli-providers/*` · `scripts/lib/buddy-connectors/*` · `scripts/lib/buddy-{connect,escalate,captain-preview}.sh` · `scripts/buddy/{persona,copy/*,brain-prompts/*}` · 全套 `scripts/__tests__/flywheel-buddy*.test.sh` + 文档。
- **唯一改动的 runtime 脚本**:`scripts/flywheel-setup.sh` —— 仅新增 `_fs_model_key_orchestrated` + 一个 `FLYWHEEL_AGENT_CLI_ORCHESTRATE=1` opt-in 分支;**不设该 env 时逐字走原 guided 路径**。
- **无任何 runtime TS 改动**;生产 fleet 零感知,不需要 Bridge 重启。

## 2. 跑了什么(证据)

### 2.1 Hermetic 测试套件(CI 会跑的全部 + 新增)

| 套件 | 结果 |
|---|---|
| `flywheel-buddy-steps.test.sh` | 11 passed, 0 failed |
| `agent-cli-provider-contract.test.sh` | 17 passed, 0 failed |
| `flywheel-onboard.test.sh` | 6 passed, 0 failed |
| `flywheel-buddy.test.sh` | 11 passed, 0 failed |
| `flywheel-buddy-github.test.sh` | 5 passed, 0 failed |
| `flywheel-buddy-captain.test.sh` | 10 passed, 0 failed |
| `flywheel-buddy-connect.test.sh` | 8 passed, 0 failed |
| `fleet-sanitize.test.sh`(含 M0 `scan_string_for_secrets`) | 36 passed, 0 failed |
| **`buddy-escalate.test.sh`(本 QA 新增)** | **4 passed, 0 failed** |
| **合计** | **108 passed, 0 failed** |

### 2.2 字节兼容守卫(独立复核 flywheel-setup.sh 未变)

`flywheel-setup.sh` 是唯一被碰的 runtime 脚本;独立跑 FLY-648 既有守卫套件确认交互模式行为未变:

| 套件 | 结果 |
|---|---|
| `flywheel-setup-engine.test.sh` | 9 passed |
| `flywheel-setup-poc.test.sh` | 8 passed |
| `flywheel-setup-resume-e2e.test.sh` | 4 passed(R4 = 零 answer-env 重跑是完全 no-op,若重问会 fail-loud) |

diff 复核:改动全部包在 `if [ "${FLYWHEEL_AGENT_CLI_ORCHESTRATE:-0}" = "1" ]` 之内,缺省分支 = 原函数体。**byte-compat 承诺成立**。

### 2.3 手工 real-behavior 验证(不靠已提交测试的自证,独立 driver 直驱生产脚本)

在临时 `$HOME` + 隔离 state dir + stub 二进制里,直接驱动 `flywheel-buddy-steps.sh` / `buddy-escalate.sh`:

1. **stdout 纪律**:fresh `status --json` 输出**恰好一行**、jq 可解析(`{"ok":true,"version":0,...}`)。
2. **state 白名单往返**:whitelisted key `first_task_summary` + 干净值 → `{"ok":true}`,读回正确。
3. **RED-LINE 秘密值拒收(独立复现)**:whitelisted key + `ghp_...` PAT → `secret_value_refused` exit 1;+ `token=lin_api_...` → 同样拒收。**秘密扫描真的会拦**,不是仅靠 key 名判断。
4. **journal 卫生**:写后 journal = **version 2**、权限 **600**、`scan_for_secrets` **exit 0(clean)**;写在假 `$HOME` 下,真 `~/.flywheel` **零触碰**(隔离成立)。
5. **M7 转人工秘密擦除(独立复现)**:hint 里塞 `ghp_...` → 摘要 hint 被替换成通用「details withheld…」句,**原始秘密不在摘要里**,摘要 `scan_for_secrets` clean,定位信息(where/error_code/cursor/doneSteps)完整保留,journal `escalated=true`;干净 hint 原样透传。

## 3. 本 QA 新增的测试覆盖(补缺口)

**发现的真实缺口**:共享的 M7 转人工摘要库 `scripts/lib/buddy-escalate.sh` **没有专属单测** —— 它此前只经 Buddy shell 的 happy-ish 阶梯(flywheel-buddy D5)间接跑到,**没有任何测试断言「hint 里的凭证被替换」这条红线**。客户把凭证粘进报错信息、泄进支持摘要 = 安全事故,这条路径必须在库边界上有测试。

**新增 `scripts/__tests__/buddy-escalate.test.sh`(4 用例)** 并接入 CI:
- **BE1** hint 含秘密 → 被通用句替换、摘要 scan clean、定位信息保留、escalated 翻 true;
- **BE2** 干净 hint 原样透传(不过度脱敏);
- **BE3** belt-over-braces **fail-closed**:秘密落在**非-hint 字段**(where)时,belt 只能改写 hint、改不掉 where → 生成器**拒绝出摘要**(return 1、不落文件、不泄露),而不是硬出一个带秘密的摘要;
- **BE4** 缺参 → return 1、不落文件。

> BE3 的行为是我在写测试时用真实 driver **实测出来**的:一开始我预期它「捕获后仍出干净摘要」,结果它 return 1、什么都不写。读代码确认这是**有意的 fail-closed**(宁可不出摘要也绝不泄露),遂把测试改成锁定该正确契约。实践中 where/error_code 是内部 step id / 错误码,永不含用户自由文本,只有 hint 携带粘贴文本,所以这条 belt 是防御性兜底。

## 4. 明确未覆盖(plan §4 真机段 — 边界,非缺陷)

plan §4 明确把下述列为「implement 后、QA 阶段执行」的**真机段**,本次 QA **未覆盖**,原因是结构性约束而非遗漏:

| 未跑项 | 为什么本环境跑不了 |
|---|---|
| 干净 VM(linux/WSL2)+ macOS 一条 command 全流程 founder-run | 需要干净宿主机;**在本生产宿主上跑完整 bootstrap/provisioning 会写坏生产 `projects.json`**(家规:Runner 绝不 host 上跑 provisioning 测试),不能做。 |
| 真业务连接器(真 Shopify/Veeqo + Gmail app password)真 auth 实测 | 需要真实客户凭证 + 真店铺 / 邮箱,QA runner 无这些。 |
| ≤60s 北极星真机计时 | 依赖上一条的真连接器。(hermetic 侧 N6 已断言 stub 延迟注入下预算 3s ≤ 60s。) |
| M5-a Lead 启动合同真机(预览态 + 常驻态) | 同宿主污染约束;captain 测试已在 hermetic 隔离态覆盖门槛逻辑(P3/P4b/P6/H1/H2)。 |

**这不是新风险**:该 build 100% 是**当前 fleet 不调用的、休眠的客户机产品面脚本** + 一个 opt-in 关掉的单文件改动(byte-compat 已证)。ship 到 main 对生产的运行时风险≈0。真机段是「产品对真实客户可用」的验收,应由 **founder / 干净 VM** 跑一遍;建议在把 Buddy 真正推给第一个真实客户前,由 Annie 或干净 VM 走一遍 plan §4 ①②③④,并把 M5-a 真机结论回灌。

## 5. 观察(非阻塞)

- **O1 — M7 fail-closed 的下游体验**:`buddy_escalate` 在无法产出干净摘要时 return 1(见 BE3)。当前只有「秘密落在非-hint 字段」才触发,而那些字段实践中不含自由文本,所以不会真触发;但若未来有字段开始携带用户文本,需确认 shell 侧对 `buddy_escalate` 返回 1 有兜底话术(别让「转人工」这条路径静默失败)。列为 follow-up 观察,不阻塞本 ship。
- **O2 — CI 首启**:PR #523 的 `Build & Test` 此前显示 `None`(未触发)。本 QA 提交会推新 head,自然触发一次完整 CI;approve gate 绑定在新 head 上。

## 6. 裁决

**PASS(有 §4 真机边界)**。可 ship 的测试面(108 hermetic + 21 byte-compat 守卫 + 5 组手工红线复现)全绿;新增 escalate 红线单测补上唯一发现的覆盖缺口。生产零变化、byte-compat 已证,ship 风险≈0。真机段(plan §4)是 plan 早列的独立环节,留给 founder / 干净 VM 在面向真实客户前执行。
