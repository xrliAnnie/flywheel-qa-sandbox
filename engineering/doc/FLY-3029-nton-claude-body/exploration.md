# FLY-3029 N-to-N Claude 体探针 — 探索

Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: 无

> Linear MCP 本次会话连接失败(HTTP 401),issue 内容以派单文本为准;未能核对 Linear 上的最新评论。

## 1. 这张单是什么

FLY-3029 是一张**合成单**(synthetic issue:不是真实产品需求,而是为了测试派单/交卷链路而人工制造的任务)。它服务于 FLY-2919 的 QA:在 529 测试房里验证「N-to-N」调度下一个 **Claude 体**(Claude Code 执行体)的生命周期——

| 验收项(来自 issue) | 含义 |
|---|---|
| 死体当场终结并换体 | runner 真死了 → 立即终结并派新体 |
| 活体丢窗口不判死 | runner 活着但 tmux 窗口丢了 → 不误判为死 |
| 同一 thread 续干 | 换体/续跑都在同一个 Discord thread 里 |
| 交卷回 thread | PR/完成回执回到同一 thread |

这些验收项由 **FLY-2919 QA 按 driver receipt 判定**,不由本单的 runner 判定。本单 runner 的唯一职责是提供一个**可观测、可幂等重复的最小真实工作负载**:在沙箱仓 README.md 末尾追加一行 `FLY-2919 N-to-N claude-body probe`,提交、推送、按正常流程交卷。

## 2. 现状审计

- **仓库**:`origin` = `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`,与 issue 指定的沙箱仓一致。分支 `project-slot-1-FLY-3029`,基于 `1855f7a1a`。
- **README.md 现状**(3 行):两个空行 + `FLY-1375 land E2E marker 20260722T023540Z`,文件以换行符结尾。
- **先例**:README 已被同类 QA 单改过三次(FLY-124 `#24` append Hi、FLY-1286 `#58`、FLY-1375 `#64`),均为「追加一行 → PR → :cool: ship」路径。本单完全复用这一形态。
- **项目配置**:`.flywheel/config.yaml` 是 test-deploy 生成的沙箱配置(`doc_flow.enabled: true`,`default_department: engineering`),故文档落 `engineering/doc/FLY-3029-nton-claude-body/`。
- **运行环境事实**:本 runner 实际在 **test-slot-1**(`FLYWHEEL_PROJECT_NAME=test-slot-1`,Bridge `localhost:19871`),而 issue 文本写的是「529 测试房(slot 2,精确头 bfdea677)由 /tmp/fly2919-driver 派单」。派单本身是 Lead(flywheel-test-1)发起的合法 DAG 节点,故按派单执行;差异已上报 Lead(见 §6)。
- **生产禁令**:issue 明确「⛔生产不要派单、不要动它」。本环境是 QA slot,不是生产,不违反禁令。

## 3. 架构约束

- **只改一个文件**:README.md。不改代码、不改 config、不动其他 QA 标记行。
- **追加而非替换**:已有的 FLY-1375 标记行是别的 QA 的证据,必须保留。
- **换行安全**:先确认文件以 `\n` 结尾再追加,避免和上一行粘连(`FLY-1375 …ZFLY-2919 …`)。
- **幂等**:N-to-N QA 的场景里 runner 可能被终结换体、同一 thread 续干。新体重跑时若那一行已存在,不重复追加(`grep -qxF` 守卫)。
- **不自行 merge**:合成单也走 approve→ship 门;merge 授权归 founder/Lead,与生产规则一致。

## 4. 外部调研

跳过(Quick 档,纯仓内一行文本改动,无外部技术)。

## 5. 方案对比

### 方案 A:一次性追加一行(推荐)
- **核心**:`printf '%s\n' 'FLY-2919 N-to-N claude-body probe' >> README.md`,前置「末尾有换行」与「行不存在」两个守卫。
- **优点**:与 issue 文字逐字一致;与三次先例同形;换体重跑幂等;diff 恰 1 行,QA 一眼可验。
- **缺点**:探针没有时间戳,若同一 thread 反复重派,无法从 README 区分第几体;但 issue 明确要的就是这一行,区分靠 driver receipt,不靠 README。
- **改动文件**:README.md(+1 行)。

### 方案 B:追加带时间戳/exec-id 的行
- **核心**:`FLY-2919 N-to-N claude-body probe <exec-id> <ts>`,每体一行。
- **优点**:README 本身能证明「换体」发生过。
- **缺点**:**偏离 issue 逐字要求**;多次换体会堆多行,「同一 thread 续干」时新体反而应接着老体的分支而非再加一行;QA 判据在 driver receipt,README 不承担这个证明。
- **结论**:不采用。

### 推荐:方案 A
理由:issue 是合成单,内容越接近逐字越好;探针的价值全在链路而不在内容。

## 6. 澄清问题与假设(已以非阻塞 ask 报给 Lead)

- **Q1(环境)**:本 runner 在 slot 1 而非 issue 写的 slot 2。假设:以 Lead 派单为准继续;若 Lead 要求停,随时可停(设计阶段零副作用)。
- **Q2(逐字)**:追加行逐字为 `FLY-2919 N-to-N claude-body probe`,不加时间戳。假设:是。
- **Q3(幂等)**:换体重跑时已存在该行则跳过追加、直接走提交/交卷。假设:是。

以上均为非阻塞,不等回复即继续 research/plan;若 Lead 回复不同,在 plan 中修正。

## 7. 下一步

- [ ] research.md:核对 README 追加的具体命令、commit/PR 形态、交卷路由(`complete`)与 N-to-N 换体时的分支续接方式。
- [ ] plan.md:落成 implement 节点可逐步执行的步骤 + 验证证据清单。
- [ ] Codex design review → 设计 HTML → `complete --route phase_design_complete`。
