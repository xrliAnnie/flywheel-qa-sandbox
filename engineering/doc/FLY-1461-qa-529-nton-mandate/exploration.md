# FLY-1461 QA executor 硬规矩:Discord-capable 单必跑 529 房真 Discord N-to-N — 探索

Issue: FLY-1461 (https://linear.app/geoforge3d/issue/FLY-1461/qa-executor-md-关单前必须跑-529-房真-discord-n-to-ndiscord-capable-单自记忆不靠-lead)
日期: 2026-07-24
基于: 无(本单起点)

---

## 1. 问题(Annie 直令 2026-07-24)

把这条硬规矩**写进 QA executor 的 markdown**(QA runner 自己的指令),让每个 QA runner 自动做,不依赖 Lead 记忆:

> 凡能跑 Discord N-to-N 的单,QA 必须在 529 QA Room 跑真 Discord N-to-N,不跑不算 QA 完。

### 1.1 为什么现在要做

- **Lead 反复忘记**默认跑 529 N-to-N,总把 live e2e 说成"卡部署门"。
- 但 529 房(FLY-529)的存在目的就是:**不用部署生产也能跑真 Discord N-to-N**。把 live e2e 说成"要等部署/卡部署门"是错的——529 房把候选 PR head 部署进**隔离 slot**,不碰生产。
- **memory 对"必须每次跑"的规矩不可靠**(概率性检索,可能召回不到)。所以把它从"Lead 记得"移到"QA runner 自带指令"——写进 QA executor 的 agent 定义 md,runner spawn 时由 `Blueprint.readAgentFile` 现读进 prompt,每个 QA runner 自动就做。

### 1.2 Annie 的明确边界

- **不加引擎硬门**——只改 QA executor md(纯文档层规矩,不碰 Bridge/StateStore/gate 逻辑代码)。
- **Generic runner 即可,不用三段式**(本单就是改一个 markdown)。

---

## 2. 目标文件确认(审计结论)

Flywheel 自托管的 QA runner 运行时**真正加载**的文件:

```
.flywheel/agents/engineering/qa-executor.md
```

证据链:
- `.flywheel/config.yaml:166` → `agents.qa.agent_file: .flywheel/agents/engineering/qa-executor.md`
- `.flywheel/config.yaml:81-87` 说明 `qa` label 触发 FLY-579 auto-QA pipeline,spawn 独立 QA Runner,"The qa-executor agent is wired in agents.qa"。

**不是**根目录的 `agents/qa-executor.md`——那个是 header 写着 "shipped, project-agnostic" 的**默认版**,给**别的**项目(没自己声明 `qa` agent 的项目)用的。529 QA Room 是 Flywheel **内部专属设施**(别的项目没有 529 房),所以这条规矩只落在 Flywheel-specific 的 `.flywheel/agents/engineering/qa-executor.md`。

> 注:是否要同步改根目录 shipped 版,见 plan.md 的"范围决策"——初判**不改**,因为 529 房是 Flywheel 内部专属,写进 project-agnostic 版会对没有 529 房的下游项目产生误导指令。

---

## 3. 当前 qa-executor.md 里已有什么(可挂靠的锚点)

`.flywheel/agents/engineering/qa-executor.md` 现有 `## CRITICAL rules` 段(第 16-21 行),已经有一条:

> - **Real-machine E2E for user-facing flows** — Discord / Bridge / Lead behavior observed live (`feedback_qa_e2e_standards`); API-returns-200 is not a product pass. Browser surfaces → **Claude-in-Chrome**, not Playwright (`feedback_qa_must_use_claude_in_chrome`).

这条已经说了"user-facing flow 要真机 E2E、Discord 要 live 观察",但**没有**:
1. 点名 **529 QA Room** 是"不用部署生产就能跑真 Discord"的地方;
2. 给出 **Discord-capable 判据**(哪些单必须跑);
3. 明确**反模式**("绝不把 live e2e 写成卡部署门");
4. 明确**纯 config/无 Discord 面**单的诚实豁免话术。

FLY-1461 = 把这条 CRITICAL rule **升级/补强**成一条可自执行的硬规矩(而不是新造一段孤立文字)。

---

## 4. "Discord-capable" 判据(设计要点)

判据:**改动碰到以下任一面,即为 Discord-capable,QA 必须跑 529 房真 Discord N-to-N**:
- Discord **发送**(send / outbound message)
- **relay**(Runner↔Lead↔founder 转发)
- **render**(thread 标题 / badge / 置顶 header / 状态行渲染)
- **founder 交互**(approve / ship / gate 问答等 founder-side 动作)
- **roundtable**(#leads-roundtable 跨 Lead 参与 / auto-thread)
- **coordination**(多 Lead / 多 Runner 之间的 Discord 协调)

反向(**豁免**):纯 config / 无 Discord 面的单——**不默认跳过**,而是**明说**"无 N-to-N 面,已 X 验"(X = 该单实际用的验证方式,如单测/CI/隔离 harness),把豁免**写进 QA 报告**,而不是静默省略。

---

## 5. "真 Discord N-to-N" 是什么(机制概念)

从审计已知:
- **529 QA Room**(FLY-529)= 隔离测试房,有自己的 runs table + 隔离 channel + 独立 bridge,**零污染生产**。可 host ≥2 test lead。
- **"N-to-N"** = 隔离房里**多个真 bot(Lead/Runner)↔ 多个真 channel** 的真 Discord 交互(不是 mock、不是 API-200)。最强先例 FLY-944:"2 real Claude Leads in isolated 529 guild #test-core-mirror, zero prod config touched;test-2 @ test-3 → reply,test-3 @ test-2 → reply,no-@ → neither replies;Evidence: Discord REST + tmux panes + Claude-in-Chrome screenshot"。
- 机制三件(Annie 点名):
  1. `scripts/test-deploy.sh` —— 把候选 PR head 部署进隔离 529 slot(**不碰生产**);
  2. `scripts/qa-fly-907-real-discord-e2e.mjs` —— 真 Discord 模式范例(module-driven,real fetch + real bot token,建真 thread);
  3. **Claude-in-Chrome** 扮 founder 做 founder-side 动作(approve/ship/在 Discord 发消息)。

(精确的命令行用法、slot→channel 映射、driver 脚本 → research.md 补齐。)

---

## 6. 待 research.md 回答

1. `test-deploy.sh` 的 QA 面向用法(子命令/flag、部署候选 head 进哪个 slot、`--mode roundtable` / `--alerts` 怎么开)。
2. 529 房跑"真 Discord N-to-N"的实操 driver(注入真 Linear issue 触发真 runner、Claude-in-Chrome 扮 founder 的现成 recipe)。
3. 现有 lead-rules / executor md / doc 里关于"必须跑真 Discord""529 房"的先例措辞(复用语气术语)。
4. 相关 memory 参考文档索引(reference_529_*、reference_qa_*)。
