# FLY-1402 lead-rules bundle 拼接单文件修复 — 探索

Issue: FLY-1402 (https://linear.app/geoforge3d/issue/FLY-1402/p1装载链-lead-rules-bundle-全-fleet-静默失效-cli-append-system-prompt-file-为)
日期: 2026-07-21
基于: 无

## 1. 问题陈述

`claude-lead.sh` 给每个 Claude Lead 传最多 ~18-21 个 `--append-system-prompt-file` flag,但 claude CLI 对该 flag 是 **last-one-wins** — 只有 argv 里最后一份文件真正进入上下文,其余全部静默丢弃,零报错。全 fleet 所有 Claude Lead 的 base governance rules(founder-only-authority / department-lead-rules / cos-lead-rules / runner-messaging 等)一直是装饰品。

证据(issue 中已实证,2026-07-21 00:30-00:36 PDT):
1. **哨兵实验(决定性)**:两个各含唯一哨兵串的文件各挂一个 flag → `claude -p` 自省:第一个=不在,最后一个=在。
2. argv 物证:活 Lead 进程(flywheel-cos-lead pid 12962)argv 含全部 18 个 flag — launcher 意图正确,CLI 层丢弃。
3. 双 Lead 自省一致:Tadashi 与 Cass 的可见上下文均只含末位文件内容。
4. 行为一直「看起来对」:全靠 identity 文档 + memory + 项目层 prompt 撑着。

## 2. 代码审计发现

### 2.1 病灶定位:仅 claude-lead.sh 一处

`packages/teamlead/scripts/claude-lead.sh` 有 **24 处** `CLAUDE_ARGS+=(--append-system-prompt-file …)`(行 2093-2525),按角色臂互斥,单个 Lead 实际收到的 flag 数:

| 角色臂 | 追加的文件(按 argv 顺序) | 实际生效(末位) |
|---|---|---|
| **dept**(非 cos 非 companion 非 external) | inbox-ack-rule → department-lead-rules(BASE) → runner-messaging¹ → executor-routing → model-routing → stuck-runner-remanage → runner-reengage → runner-patrol → doc-flow → auto-qa-pipeline → default-enable-policy → xiaohongshu-memory → founder-local-time → founder-only-authority → founder-ux² → founder-html-delivery → cross-dept → discord-reply-contract → common-rules(项目) → department-lead-rules(项目) → **screencapture-l3-skill** | screencapture-l3-skill.md |
| **cos** | inbox-ack-rule → cos-lead-rules(BASE) → founder-local-time → founder-only-authority → founder-ux² → founder-html-delivery → cross-dept → discord-reply-contract → common-rules(项目) → **screencapture-l3-skill** | screencapture-l3-skill.md |
| **companion**(Belle 等 Claude companion) | companion-safety-contract → founder-local-time → cross-dept → **discord-reply-contract**(companion 跳过 screencap;若项目有 .lead/shared 则 common-rules 垫后) | discord-reply-contract.md |
| **external**(Anna) | (inbox-ack¹) → **external-agent-contract**(其余全跳过) | external-agent-contract.md |

¹ 条件加载(INBOX_MCP_ENABLED / comm backend);² FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1 才加载,默认关。

**严重性细分**:
- dept/cos:全部 governance(founder-only-authority、FLY-162 Reply Discipline、Action Gate、auto-QA pipeline、executor/model routing…)从未进上下文。
- **companion(Belle):companion-safety-contract.md — 它「唯一的硬行为边界」— 从未进上下文**。launcher 对该文件缺失是 fail-STOP 级别对待,但装了也白装。这是本 bug 里安全等级最高的一条。
- external(Anna):contract 恰好是末位(常见配置下几乎唯一一份)→ 大概率实际生效,受影响最小。

### 2.2 不受影响的调用面(已逐一核实)

| 调用面 | 用法 | 结论 |
|---|---|---|
| Runner(`TmuxAdapter.ts:808-833`) | 把整个 assembled prompt 写成**一个** `append-system-prompt.md` 传**一个** flag(FLY-154 就是为绕 tmux argv 限制) | ✅ 早已是正确模式,本修复的现成先例 |
| Codex Lead(`codex-lead-runtime.ts:627`) | `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` CSV → 逐个读文件 → **拼接**成一份 baseInstructions | ✅ 不经 CLI flag,天然正确 |
| voice-core 两个 Brain / `agent-cli-providers/claude.sh` | 各只传 1 个 flag(identity/persona 单文件) | ✅ 单文件无叠加 |
| `AntigravityTmuxAdapter` / `KimiTmuxAdapter` | 不用该 flag | ✅ |

### 2.3 已有基建:lead-rules-bundle.sh(FLY-350)

`packages/teamlead/scripts/lead-rules-bundle.sh` 的 `compute_lead_rule_bundle <role>` 已经是「按角色臂算 BASE 规则有序清单」的共享 resolver(codex-lead.sh 在用),并有 `lead-rules-bundle.test.ts` parity 测试把 resolver 输出与 claude-lead.sh 的引用顺序绑定(anti-drift)。

但它**只覆盖 BASE 项目无关层的子集**:不含 inbox-ack-rule、founder-ux(env-gated)、discord-reply-contract、default-enable-policy、screencapture skill、项目层 common-rules/department-lead-rules、external contract。claude-lead.sh 的内联选择逻辑仍是 Claude 路径的 single source of truth。

### 2.4 相关但不属本单代码的事实

- flywheel-cos-lead plist 缺 `FLYWHEEL_LEAD_ROLE=cos`(`IS_COS_ROLE` 判定 = env `FLYWHEEL_LEAD_ROLE=cos` 或字面 `LEAD_ID="cos-lead"`;生产 LEAD_ID=flywheel-cos-lead 不匹配)→ Cass 走错臂。文件已手工改,搭下次统一重启生效。本单的 check-rules-truth 角色臂检查以后能**自动暴露**这类错配。
- FLY-1393 的 check-flag-truth 哲学参照物是 `packages/config/src/feature-flags/truth.ts`:声明 ≠ 事实,拿运行时真相比对。

## 3. 修复方向(brainstorm 结论)

### 方案 A(选定):最小侵入 — 收集数组 + 拼接单文件

保留 claude-lead.sh 全部现有条件选择逻辑(哪个角色装哪份、env 门、fail-STOP 语义都不动),只把「装载动作」从 24 处 `CLAUDE_ARGS+=(--append-system-prompt-file X)` 改为 `rules_bundle_add X`(累积进数组 + 原 log 行保留);全部条件走完后,一个共享 materializer 函数把数组拼成**一份** per-Lead bundle 文件(原子写:temp + mv),挂**单一** `--append-system-prompt-file`。

bundle 结构:
```
# Flywheel Lead Rules Bundle (FLY-1402)
RULES_BUNDLE_SHA=<sha256(正文)> FILES=<n>
ROLE=<cos|dept|companion|external> LEAD_ID=<id> PROJECT=<name>
MANIFEST:
  1. <layer>/<basename>(全路径注释)
  ...
(探针指令:被问到 rules bundle 哨兵时,逐字引用上面 RULES_BUNDLE_SHA 行)

═══ RULE SOURCE [1/n]: <path> ═══
<原文件内容 verbatim>
═══ RULE SOURCE [2/n]: <path> ═══
...
```

- SHA 对正文(分节区)计算,头部可嵌;`FILES=<n>` 与 MANIFEST 行数一致。
- MANIFEST 用 layer 标注区分同名文件(base/department-lead-rules.md vs project/department-lead-rules.md)。
- 落盘路径:`${HOME}/.flywheel/lead-rules-bundle/${PROJECT_NAME}-${LEAD_ID}.md`(命名对齐 SESSION_ID_FILE 防跨项目碰撞)。

### 方案 B(否决):Claude 路径改走 lead-rules-bundle.sh resolver 统一选集

把选择逻辑也收进 resolver。否决理由:resolver 只覆盖 BASE 子集,claude-lead.sh 还有 env-gated / 项目层 / inbox / screencap / external 六类额外源,全部搬进 resolver 是大重构,风险面和测试迁移量数倍于 A,且 parity 测试已经防 drift。P1 修复优先止血;统一化留 follow-up。

### 哨兵可验 + check-rules-truth

- **仪器化验证**(issue 要求的校准仪器):重启后问 Lead 读回哨兵行 → 与磁盘 bundle 头逐字比对。bundle 内置一行探针指令让读回确定化。
- **check-rules-truth 脚本**(与 check-flag-truth 同哲学):对每个有 manifest 的 Lead,(a) 重算 SHA 验 bundle 完整性;(b) 活进程 argv 恰含一个 `--append-system-prompt-file` 且指向该 bundle;(c) 角色臂断言:cos bundle 必含 cos-lead-rules 必不含 department-lead-rules,dept 反之,companion 必含 safety-contract。不复制launcher 全部条件逻辑(那会造第二份 drift 源),只查关键不变量。

### 装载链回归测试(哨兵实验固化)

两个各含唯一哨兵串的临时文件 → 经拼接路径 → 断言**两串都在**输出 bundle 里、顺序保持、头部 SHA/FILES 正确。防 CLI 语义再变时静默复发(单文件模式下无论 CLI 怎么变,内容都在)。

## 4. 影响面与风险

1. **测试迁移(实现期主要工作量)**:7 个现有测试断言 argv 含特定 `--append-system-prompt-file <file>`:fly231-companion-launch-plan / fly879-external-launch-plan / rollback-args-gate / screencap-skill-gate / decommission-legacy-companion-daemon / test-fly205-doc-flow-lead / test-fly26-rules-split。断言需迁移为「argv 恰含一个 bundle flag + bundle 内容含/不含对应分节」。这是**故意的非字节兼容**(修 bug 本身),argv sentinel 更新按 LEGITIMATE RETARGET 处理并在 PR 里逐个说明。
2. **parity 测试(lead-rules-bundle.test.ts)**:锚定的是 `BASE_X="${BASE_RULES_DIR}/file.md"` 路径赋值行,这些不动 → 预计零改动或极小改动。
3. **上下文成本**:规则真装进去后每个 Lead 系统 prompt 增大(dept 全集约几十 KB)。这是 bug 修好后的**应然成本**,不是回归;若 token 压力显著,精简规则文本是独立 follow-up。
4. **行为变化**:Lead 第一次真正读到这批规则,行为会变(更守规,也可能暴露规则文本间互相矛盾处)。ship 后首周观察窗注意。
5. **回滚阀**:留 `FLYWHEEL_LEAD_RULES_BUNDLE=legacy` env 逃生口回到旧多-flag 行为(已知劣化但运行了很久的状态),防拼接路径意外炸 fleet。默认 bundle ON(FLY-707 default-enable + 本来就是 bug 修复)。
6. **生效方式**:rules 只在 Lead 启动装载 ⇒ ship 后搭下一班统一重启(明早三单激活重启),零额外 blink。重启后逐 Lead 哨兵探针验证(含 Cass cos 臂阴性对照)。

## 5. 开放问题(带到 design review)

- external(Anna)是否也走 bundle?倾向**走**(全 fleet 统一可验),bundle 头是内部元数据文本,不构成内部信息泄漏(不含 channel id/token);若 review 认为 external 单文件面要绝对最小,可让 external 臂保持直传单文件、豁免哨兵。
- 逃生阀名字与语义(`legacy` vs `0`)以及是否值得留 — 拼接是 cat 级简单操作,阀的价值主要是心理安全。
