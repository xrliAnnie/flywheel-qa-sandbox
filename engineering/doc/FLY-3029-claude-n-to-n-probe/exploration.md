# FLY-3029 Claude N-to-N 探针 — 探索
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: 无

## 1. 任务本质

FLY-3029 是 FLY-2919 QA 的一次性合成任务，用来观察真实 Runner 在 N-to-N（一次任务跨多个阶段节点并回到同一讨论线程）流程里的存活、续跑和交卷行为。它不是产品需求，也不应被生产调度器派发。

任务的仓库侧效果故意极小：后续 implement 节点只需在 `xrliAnnie/flywheel-qa-sandbox` 根 `README.md` 末尾追加一行完全匹配的文本：

```text
FLY-2919 N-to-N claude-body probe
```

验收的主信号不是复杂业务行为，而是 FLY-2919 QA driver 的 receipt：死体应当被当场终结并换体，活体丢失窗口不应误判为死亡，同一 thread 应继续工作，交卷应回到原 thread。

## 2. 已知事实与假设

- 当前远端是 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`，因此写入目标确实是隔离沙箱，不是生产仓库。
- 当前设计 worktree 的基线为 `1855f7a1a`，而 issue 文本记录的 529 slot 2 精确头为 `bfdea677`。Lead 已在问题 `e54708b7-4322-417c-bf3e-933fc970e377` 明确：这是 QA test-slot 身份覆盖，继续授权的 slot 5 sandbox 当前头，不得 reset 或转向生产 slot 2。
- 根 `README.md` 当前为 44 bytes，内容以 LF 结尾；因此可以追加单独一行而不改写已有内容。
- 本节点只产出设计文档和 founder HTML，不修改 `README.md`、不创建 PR、不请求 ship、不合并。

## 3. 可选方案

### 方案 A：直接精确追加一行（推荐）

在 implement 阶段先检查目标行不存在，再用最小补丁追加一行；之后核对 diff、提交并推送当前 feature branch。

优点：变更面只有一个文件和一行，最接近合成探针的原始意图，driver receipt 的生命周期信号不会被额外工程活动干扰。缺点：没有可复用抽象，但这个任务明确不需要复用。

### 方案 B：增加专用脚本执行追加

新增脚本来检查并写入探针行，再执行脚本。

优点：可显式编码幂等性。缺点：为一次性夹具新增永久代码，扩大 diff、测试与 review 面，反而削弱探针的单一信号。

### 方案 C：修改 Runner / driver 工作流

把探针追加逻辑放进调度或 driver。

优点：可以把动作自动化。缺点：会把“被测路径”和“测试负载”耦合，无法区分生命周期缺陷与新工作流代码缺陷，并且越过本 issue 的明确边界。

## 4. 推荐方向

采用方案 A。实现保持一次、精确、可审计：只在目标行不存在时追加；如果目标行已经存在，停止并向 Lead 报告，不重复写入。提交前以 `git diff --check`、目标字面量计数和 README 尾部检查证明结果；提交后推送 feature branch，按 implement 节点的正常完成路由交卷。

## 5. 范围与负向守卫

### 在范围内

- 后续 implement 节点修改根 `README.md`。
- 精确追加指定文本一次。
- 提交、推送并按正常流程回报可追踪的 commit SHA。
- 为 QA 留下能关联 driver receipt、thread 和 commit 的证据。

### 不在范围内

- 不改 Flywheel 生产代码、Runner 逻辑、driver 或调度配置。
- 不把本合成任务投向生产。
- 不重置到 `bfdea677`，不强推，不合并 main。
- 不把“窗口消失”本身当作 Runner 死亡；这个判定属于 FLY-2919 QA driver。
- 不以 README 行存在替代 driver receipt；仓库 diff 只证明负载完成，不证明 N-to-N 生命周期验收通过。

## 6. 成功定义

设计阶段成功意味着：后续执行者知道只改哪个文件、写入什么精确文本、遇到已有文本或基线差异时如何 fail closed、如何验证并交卷；设计 review 给出有效 APPROVED。整个 FLY-2919 QA 的最终通过仍由 driver receipt 判定，而不是由本设计节点自行宣布。
