# FLY-1159 /gemini-advanced 语音接线（route A）— QA 报告

Issue: FLY-1159 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: plan.md（§2 QA 阶段合同）+ 本分支已提交实现（PR #554）

> QA session（三段式管线 QA 阶段）独立验证 implement 阶段已提交并过 Codex 两轮
> code review 的实现。**未重做实现**。报告分三栏诚实划界:机器已验 ✅ / layer (b)
> 合成深链 = Lead(Tadashi)裁决 skip ✅（书面判断,§2）/ 声学闭环留 founder ⏳。

## 0. 被验对象

| 项 | 值 |
|----|-----|
| PR | #554（base=main,OPEN） |
| 验证 head | 当前 PR #554 head（= 本地 HEAD;Codex code-review.json 与 CI 均绑同一 head） |
| 实现改动面 | packages/voice-bridge/{assistant/advanced.ts(新),assistant/config.ts,assistant/wiring.ts,cli.ts,package.json} + pnpm-lock.yaml |
| QA 增量 | packages/voice-bridge/src/__tests__/qa-fly1159-injection.test.ts（新,4 测）+ 本报告 + progress.md |
| 上游审查 | design review 4 轮 APPROVED;code review 2 轮 APPROVED(product 冻结 head 9aa634f6);均有 JSON 记录。QA head 因加了测试/文档已重跑 Codex 增量 review |
| GitHub CI | 绿（product 冻结 head Build & Test pass;QA head 同验） |

## 1. 机器已验 ✅

### 1.1 全套测试 + 零回归

- `pnpm --filter flywheel-voice-bridge test` → **全绿**（implement head 336/336;
  加 QA 4 测后 340/340;既有 322 零回归）。
- 三包 tsc build 零错:flywheel-voice-core / flywheel-gemini-agent / flywheel-voice-bridge。
- **新 QA 测试文件过 biome 2.1.4(repo pinned)= 0 error / 0 warning**。全仓 `pnpm lint`
  本地 exit 1 仅两个与本 PR 无关的来源:①一个本地 **gitignored** 产物
  `.flywheel/runs/.../land-status.json`(implement 阶段运行时文件,不在 git、CI checkout
  里没有,故 CI 不受影响)②teamlead 测试若干 pre-existing unused-suppression warning
  (非本 PR 触碰的文件)。GitHub CI 在本 head **Build & Test pass**。

### 1.2 层 (a) 注入面 — extraTools 真 seam（QA 新增,mutation 证明）

> 缺口:14 个 implement 测试覆盖 delegate 工具自身行为,但**未覆盖** wiring.ts 把
> delegate 挂进 Live extraTools 的注入面。QA 补 `qa-fly1159-injection.test.ts`。

**不是复刻表达式,是驱动真 factory**:测试用 `wireAssistantMode`（不注入
createConversation）跑**真** `makeRealConversationFactory`,只把 voice-core 的
`GeminiLiveBackend.createConversation` 换成 spy 捕获产线真正交给 Live backend 的
extraTools;wiring 组装全程真实。

| 场景 | 断言 | 结果 |
|------|------|------|
| advanced 在场 | Live backend 实收 = `[lookup_issue, board_snapshot, delegate_task]`（恰 3;深层 6 工具 registry 留在 delegate 内部,不展开进 Live extraTools,Codex R1 tool-count 修正） | ✅ |
| advanced 缺席 | Live backend 实收 = 恰好 base 2 `[lookup_issue, board_snapshot]`（字节兼容） | ✅ |

**Mutation 证明是真 guard**:临时把 wiring.ts `return advancedTool ? [...base,
advancedTool] : base` 改成 `return base` → 「advanced 在场」测试**如期 FAIL**
（缺 delegate_task）→ 立即 `git checkout` 还原。证明测试真的会抓 wiring 回归,
非镜像假绿。

### 1.3 层 (a) 启动保护 — cli.ts fail-fast（QA 新增）

| 场景 | 断言 | 结果 |
|------|------|------|
| advanced 配置 + 深层 agent env 不全 + 真 factory 路径 | 守护进程**启动即死**,报错含 founder 面修复指引「huddle.assistant.advanced is configured but the deep agent env is incomplete」（不是首次 /gemini-advanced 才炸）；断言精确到 advanced 专属文案,证明是 advanced 预检触发,非既有 GEMINI_API_KEY 守卫误触 | ✅ |
| staged-QA seam(注入 createConversation) | **跳过** advanced 预检(cli.ts:114 `!createConversation` 守卫) | ✅ |

### 1.4 delegate 深链行为（implement 14 测,QA 复核逻辑）

以 `_test.runSession` 注入覆盖:即时 ACK(含任务 id);完成口播含结果 + 任务 id;
非完成 terminal 诚实报 reason(不假成功);**完成文字保底无条件送达**(Codex R1
回归验证:speak 桩置空仍必须看到 sendText 送达);抛异常 speak 被 contained;
半配置 env → buildAdvancedDelegateTool 抛错含 FLYWHEEL_GEMINI_AGENT 指引;
**binding 抵达 session**(测试断言 `{projectName, leadId, deptLabel}` 传进 runSession
—— 即 dispatch 绑定→引擎的交接已单测覆盖)。

### 1.5 零新增权威面合同

- `bash scripts/gemini-agent-guard.sh` → **ALL GATES GREEN**（reserved endpoints /
  imports / credentials / 6-tool registry）。ship 意愿仍止于 request_ship_approval。

## 2. layer (b) 合成深链（隔离 venue）— Lead 裁决 skip ✅（书面判断消解）

plan §2.2 层 (b) 原设想:从 build 产物直接调 `buildAdvancedDelegateTool(...)` 真
runSession 路径,对 `~/.flywheel/gemini-agent-test` 隔离 scoped Bridge 半区合成跑。
QA 把是否投入执行升级 Lead(Tadashi,ask 27bd8c1e),**Tadashi 裁决 skip**,理由
(书面判断,非无声跳过):

1. **最强理由 —— 技术上做不到真语音段(Tadashi 原话)**:route A 的耳朵 = Gemini
   Live STT,**合成音喂不进去**(与 /glaw 同一现实)。即便重建 venue、让 sender-bot
   推合成 WAV,也测不了"说话→转写→派活"那段;真正的 voice→delegate→engine→口播
   端到端**只能靠 Annie 真声**,而那正是**验收测试本身**(§3)。layer (b) 合成 venue
   恰好覆盖不了本改动最需要验的那段。
2. venue 已死(bridgePid 82919 / daemonPid 83187 / stackPid 82903 全 DEAD,端口
   64865 未监听),且是 FLY-1060 **定制搭建**、**无一键 bring-up 脚本**;重建 = 重造
   定制基建 + 真 Linear(Ops-Test)/真 Discord 副作用,性价比极低。
3. layer (b) 真跑复验的深层引擎 = FLY-1018/967/1065,**已合并且 Annie 已验收**
   (FLY-1065 merged #535,FLY-967 shipped);FLY-1159 新代码仅语音注入 + 播报层,
   其"注入真抵达 Live backend"(§1.2 真 seam + mutation)与"binding→引擎交接"
   (§1.4 单测断言 `{projectName, leadId, deptLabel}` 传进 runSession)已机器验证。

**结论(Tadashi)**:机器层(真 factory + mutation)+ Annie 真声 E2E = 完整覆盖;
layer (b) 合成 venue 是"低值且技术上做不到"的那部分,skip 是书面判断,非能力缺口。

## 3. 声学闭环 ⏳（founder,merge 前;能力边界）

Gemini Live STT 无法接收合成音(brainstorm gate 已定的能力边界),故"Annie 在 VC
说一句 → 真转写 → 口头『已受理』→ 异步深跑 → 完成口播 + 频道文字落地"的全声学
闭环 = Annie 真机测(founder signoff)。**这也是本改动真正的端到端 E2E** —— founder
的真声测会真正走通声学 + 深跑 + landing 全链。

### Annie 真机测试指引（机器栏 §1 全绿 + layer(b) 决策落定后再上）

前置:staged venue 从 PR #554 分支 worktree 起 voice-bridge(assistant 配置带
advanced 段;deptLabel=Ops-Test;GEMINI_API_KEY 复用现 key;scoped Bridge token;
测试 bot=TEST_BOT_TOKEN_1)。步骤:

1. 进 VC,对 /gemini 助手说一句需要深查/建票的话(如「帮我建个测试票,标题叫
   FLY-1159 语音派活验证」)。
2. **听**:应立即口头收到「已受理,任务 <id>」。
3. **等**:深任务异步跑(几十秒到一两分钟)。
4. **听 + 看**:完成时口播结果摘要(长结果截断 + 「详情见文字记录」),且语音频道
   文字区收到**完整**文字落地。
5. 判断口播是否自然、文字是否完整、延迟是否可接受。

在 QA 的 approve gate 上二选一回复:满意 → **approved**(QA 只认 verify-approval
`{"approved": true}` 才 ship);不满意 → **changes requested**(转 feedback
kickback → implement 修)。

## 4. 结论

**机器已验栏(§1)全绿 → QA verdict = PASS(机器层)**:全套测试 340/340 + 真 seam
注入(mutation 证明能抓 wiring 回归)+ cli fail-fast + delegate 单测(含 binding→
runSession)+ build/lint(新文件 0 error 0 warning)/CI/gemini-agent-guard,且零新增
权威面。无回归。

**layer (b)(§2)= Lead(Tadashi)裁决 skip**(书面判断:合成音喂不进 Gemini STT →
合成 venue 覆盖不了真语音段 + venue 死 + 引擎已 Annie 验收)。**声学闭环(§3)= Annie
真声 E2E = 本改动真正的验收测试**,标 ⏳。

**ship 姿态(Tadashi 指令)**:出 verdict(真声栏 ⏳)→ 开 QA final approve gate
(held / --no-block)→ **停在 founder ship gate,不 ship**。Annie 真声测 + 在该
bound gate 上明确 approved → verify-approval `{"approved": true}` → 才 merge。
ship 形态 = merge-to-main-only,不重启生产 Bridge(生产未配 advanced 段,merge 后
行为字节不变)。
