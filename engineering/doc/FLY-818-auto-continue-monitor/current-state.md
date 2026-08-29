# FLY-818 系统健壮性追踪 — 现状一图看懂

Issue: FLY-818 (https://linear.app/geoforge3d/issue/FLY-818/infraepicrobustness-系统健壮性追踪-runner-完成idle-不上报-founder-lead-status-不准)
日期: 2026-07-04
基于: exploration.md / plan.md（同文件夹）

> 给 Annie 的现状说明：你问"这个系统的健壮性追踪现在长什么样"。一句话：**FLY-818 是一把伞（epic），治的是「runner 干着干着停了、没人接着干、也没人可靠告诉你」这个根问题，外加几处「系统以为的状态 ≠ 真实状态」的对不齐。** 下面这张图 = 伞下面拆了哪几块、每块现在到哪一步。

## 根问题（为什么要有这把伞）

Runner 是**回合制**的：干完一个回合，就停在命令行等下一句话 —— 但这时目标**还没做完**。于是两件坏事：

1. **没人接着让它干**（它就干等着，浪费）。
2. **没人可靠地告诉你它卡住了**（你不知道，直到你自己去看）。

再加上几处**对不齐**：系统显示的 Lead 状态 / QA 结论 / 配置改动 / 残留进程，跟真实情况有偏差。

## 一张图：伞下拆了什么 + 各自到哪一步

```mermaid
flowchart TD
    ROOT["🎯 FLY-818 系统健壮性追踪 (epic)<br/>根问题: runner 回合制 → 停着没人接 + 没人可靠告诉你<br/>+ 几处系统状态 ≠ 真实状态"]

    ROOT --> PR["📦 PR #434 (正在做的这个)<br/>代码全写完 · Codex 审查 2 轮 APPROVED · 现在等 QA + 你拍"]
    ROOT --> SUB["🧩 4 个小对不齐 (已拆成独立子 issue、先写计划、不塞进这个 PR)"]
    ROOT --> LATER["⏸️ 暂缓 / 关联"]

    PR --> A1["① 自动续跑<br/>runner 自己朝目标做到「该停的点/开 PR」,不再干等<br/>撞到要你/Lead 拍板的关口就停<br/>🔒 默认关 (先拿一个 runner 试,稳了再铺开)"]
    PR --> A2["② 真卡住 → 直接找你<br/>runner 真卡住 且 Lead 没在宽限期内处理<br/>→ 在「卡住的那个 issue 自己的 thread」里 @你<br/>✅ 默认开 (可一键关);刚从「发错频道」返工成「发对 thread」"]

    SUB --> C["C · Lead status 核实<br/>(现在被动显示、不核实 → 改成主动核实)"]
    SUB --> D["D · QA 结论回写 Linear"]
    SUB --> E["E · 配置改动也触发重启"]
    SUB --> F["F · 清理卡死残留的 runner / 窗口"]

    LATER --> M4["M4 · idle 噪音协同静音<br/>(只在①开启后才有意义,先搁着)"]
    LATER --> P793["跟 FLY-793 三段式流水线对接<br/>(按阶段给不同目标)"]

    A2 --> QAGATE["🧪 现在整个 PR 卡在这一步:<br/>独立真机 QA —— 造一个真卡住的 runner,<br/>验证它自己的 thread 里真的冒出 @你 的消息 + 不刷屏。<br/>QA 全绿 → 我拿给你拍 → 你批了才 ship"]

    classDef root fill:#1a365d,color:#fff,stroke:#0f2440,stroke-width:2px
    classDef done fill:#34c759,color:#fff,stroke:#2a9d47
    classDef hold fill:#ff9500,color:#fff,stroke:#c77400
    classDef todo fill:#8e8e93,color:#fff,stroke:#6d6d72
    class ROOT root
    class PR,A1,A2 done
    class QAGATE hold
    class SUB,C,D,E,F,LATER,M4,P793 todo
```

**图例**：🟢 代码完成/审查过 　🟠 现在卡在这（等 QA/你） 　⚪ 还没动（子 issue / 暂缓）

## 一句话现状

- **这个 PR（#434）里的两件事都写完了、Codex 审查两轮都通过、byte-compat（不碰现有行为）。** 现在**唯一没做完的一步 = 独立真机 QA**：真造一个卡住的 runner，看它自己的 issue thread 里是不是真冒出 @你 的提醒、且不刷屏。QA 绿了才拿给你拍板 ship。**在你拍之前绝不 ship。**
- **4 个小对不齐（C/D/E/F）已经拆成独立子 issue**，先写计划、单独做，**不塞进这个 PR**（避免这个 PR 越滚越大）。
- **①（自动续跑）默认是关的** —— 先拿一个 runner 小范围试、稳了再铺开，不会一上来就全队自动跑。
- **②（卡住找你）默认是开的** —— 因为「真卡住必须有人告诉你」是这把伞最初就要解决的痛点，关着等于没做；但只在「真卡住」这个少见情况才触发，风险低，且留了一键关。

## 走过的一段弯路（为什么②改了几版）

②「发到哪」你改了三次主意，我跟着返工了三次：DM → alert 告警频道 → **最终定稿：发到卡住那个 issue 自己的 thread**。最后这版其实最简单，因为代码库里早有一条现成的「往 issue thread @你」的管子（FLY-605 当初就把「发告警频道」这条路否决了），我复用它就行、没重造轮子。
