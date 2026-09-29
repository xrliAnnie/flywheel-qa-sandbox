# FLY-3029 N-to-N QA 探针 — 探索
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: 无

## 1. 任务本质

FLY-3029 是 FLY-2919 QA 的一次性合成任务，用来观察真实 Claude Runner 在 N-to-N（同一任务跨多个阶段节点）流程中的存活、续跑与交卷行为。它不是生产功能，也不得被生产调度器派发。

仓库侧负载故意保持极小：后续 implement 节点只在 `xrliAnnie/flywheel-qa-sandbox` 根 `README.md` 末尾追加一行完全匹配的文本：

```text
FLY-2919 N-to-N claude-body probe
```

最终生命周期验收不由这行文本单独决定，而由 FLY-2919 QA driver receipt 判断：死体当场终结并换体、活体丢窗口不判死、同一 thread 续干、交卷回原 thread。

## 2. 已核事实与待确认身份

- 当前 origin 是 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`，目标确为隔离沙箱。
- 当前 design worktree 是 `project-slot-3-FLY-3029`，HEAD 与 `origin/main` 均为 `1855f7a1a`。
- issue 正文写明原始台架是 slot 2、精确头 `bfdea677`；这与当前受编排 worktree 身份不同。design 节点不会 reset、转向别的槽或写生产仓，已把该差异作为非阻塞问题交给 Lead；在回复前继续完成不依赖该裁决的设计。
- 根 `README.md` 当前 44 bytes，以 LF 结尾，目标 literal 为零命中。
- 本节点只产出设计文档和 founder HTML，不修改 `README.md`、不创建 PR、不请求 ship、不合并。

## 3. 方案比较

### 方案 A：直接精确追加一行（推荐）

implement 阶段先验证目标行不存在，再以最小补丁追加；随后核对 diff、提交并推送当前授权 feature branch。

优点是只有一个文件和一行，最接近合成 probe 的原始意图，不会用额外工程活动污染 driver 的生命周期信号。缺点是没有可复用抽象，但一次性夹具不需要抽象。

### 方案 B：新增专用脚本

新增脚本检查并写入 probe 行。

优点是可以显式编码幂等性；缺点是为一次性夹具增加永久代码、测试和 review 面，扩大失败来源。

### 方案 C：修改 Runner 或 driver

把追加动作固化进调度或 QA driver。

优点是自动化；缺点是把被测生命周期与测试负载耦合，越过本 issue 的明确范围，也可能触碰生产路径。

## 4. 推荐设计

采用方案 A。实现保持一次、精确、可审计：先证明 `origin/main` 没有目标行；当前分支没有时追加一次，已有时只允许从可信的前一 body 单行 diff 或 probe commit 续跑；来源不明或重复出现时 fail closed。验证分为 literal、单文件 diff、commit/push 与 driver receipt 四层，互不替代。

## 5. 范围与负向守卫

### 在范围内

- 后续 implement 节点修改根 `README.md`。
- 精确追加指定文本一次。
- 提交、推送，并回报可追踪的真实 commit SHA。
- 留下可关联 driver receipt、thread 和 commit 的证据。

### 不在范围内

- 不改 Flywheel 生产代码、Runner 逻辑、driver 或调度配置。
- 不把本合成任务投向生产。
- 不为匹配 issue 中的历史头而 reset、rebase 或 force push。
- 不把窗口消失本身当作 Runner 死亡；该判断属于 FLY-2919 driver。
- 不以 README 行存在替代 driver receipt。

## 6. 成功定义

设计阶段成功意味着：后续执行者清楚只改哪个文件、精确写入什么、如何处理重复或续跑状态、怎样验证与交卷，并取得有效的 design-review APPROVED。整个 FLY-2919 QA 是否通过，仍只由 driver receipt 判定。
