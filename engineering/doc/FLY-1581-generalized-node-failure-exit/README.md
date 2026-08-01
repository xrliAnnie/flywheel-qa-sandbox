# FLY-1581 generalized node 失败出口 — 目录指路

Issue: FLY-1581 (https://linear.app/geoforge3d/issue/FLY-1581)
日期: 2026-08-01
基于: 无(本文是目录指路牌,由 FLY-1590 落地时写)

## ⚠️ 首屏三件事

1. **`preserved-by-FLY-1590/` 里的 `plan.md` 描述的修复【尚未实施】。**
   它是给未来实施节点的**输入**,不是已完成工作的记录。同目录的 `progress.md`
   明写「零生产代码改动」。
2. **本目录只有一代内容 —— 就是 `preserved-by-FLY-1590/` 这一份。** 若你在别处
   见到同名的另一版 FLY-1581 文档,那是一次**未授权误派**的残留,不是替代品,
   **不要拿它跟这份比对**。裁定见 §3。
3. 落地经过与逐字保真证据见 `preserved-by-FLY-1590/LANDED-BY-FLY-1590.txt`。

## 1. `preserved-by-FLY-1590/` 是什么

FLY-1581 的**第一代**产出,2026-07-31 完成:

| 文件 | 行 | 内容 |
| -- | --: | -- |
| `exploration.md` | 107 | 缺陷复现链、引擎允许什么、方案取向 |
| `research.md` | 182 | 逐行证据:模板侧 / 引擎侧 / 409 怎么发生 / 三个 completion sink |
| `plan.md` | 407 | 9 节实施计划,含合同测试 + 真机验收 + 风险表 |
| `follow-ups.md` | 134 | F1–F4 四条可直接建单的草稿(**尚未建单**) |
| `progress.md` | 35 | 进度台账 |
| | **865** | Codex design review **10 轮 APPROVED** |

它一个字都没进过 git —— 产出它的 generalized 节点是 **no-write**,只能走
`complete --route no_code` 收工,DAG 据此跳过落地节点。2026-07-31 夜里
FLY-1578 / 1579 / 1580 / 1581 四单死于同一条链(根因已由 PR #748 修掉:
generic 节点原本 12 个能力位全 false)。

**FLY-1590 把它搬进 git**,逐字照抄 Lead 的 evidence 备份,SHA256 逐份核过。
搬运当天 00:53:59 源 worktree 被 reset,第一代那五份未跟踪文件从磁盘消失 ——
**那一刻 Lead 的备份是仅存的一份**,也是本目录内容的**唯一独立恢复来源**。
详见 `preserved-by-FLY-1590/LANDED-BY-FLY-1590.txt`。

## 2. 为什么放在子目录

FLY-1590 落地到一半时,`flywheel-FLY-1581` worktree 被重新 dispatch,另一个 runner
开始往**同一个 canonical 目录**写同名文件:

```
00:53:59  worktree 被 reset,第一代五份未跟踪文件从磁盘消失
00:58     该 worktree 被重新 dispatch,另一个 runner 开工
01:03 起  它在同一个目录写 exploration / research / plan / progress
          字节与第一代完全不同
```

⇒ 若第一代快照占用根目录的 `exploration.md` / `plan.md` 等文件名,两边若都合入
  main 会撞成 **add/add conflict**:git **拒绝自动合并**,必须人工 resolution,
  而 resolution 选错边就会丢掉这份 865 行、10 轮 APPROVED 的调研。

⇒ 故快照封存进 `preserved-by-FLY-1590/`,不占根目录文件名 —— 让这次取舍不必
  发生在 merge 现场。

## 3. 那批「第二代」内容不作数 —— 本目录只有一代

> **本节是 2026-08-01 的更正。** 本文早先版本把那批内容描述成一个平等的
> 「现役那一代」,并建议读者「实施前比对两代结论」。**那是错的,已推翻。**

Eng Lead 的裁定(逐字):

> 不并存 —— **只留 #750 里这一代。** 第二代是我用 `close_runner(done=true)` 推进
> FSM 招来的**误派产物,那次派工从来没有被授权过**。它没有实质提交,而且写的是和
> #750 同一批路径。**已让它停,不要把它的内容并进来。**
>
> 第一代基线在 #748 之前不影响文档价值 —— **它记录的是当时的事实,而事实没有变。**

⇒ **`preserved-by-FLY-1590/` 里的这一份就是 FLY-1581 的产出,没有第二份要比对。**
⇒ 若你在别处看到同名的另一版 FLY-1581 文档:那是未授权误派的残留,不是替代品。

## 4. 基线说明:#748 改了什么、没改什么

第一代做于 PR #748 **之前**(基线 `ab2ec6b2`)。逐条可核,别用模糊说法:

* **改了** —— `generic` 节点的 capability bits 与默认 `completion_route`
  (`packages/config/src/node-type-registry.ts:125-152`:与 `implement` 同形,
  route 由 `no_code` 变 `needs_review`)。这解决的是**产出落不了地**。
* **没改** —— `WorkflowCompletionRoute` 合法集仍是
  `phase_design_complete | needs_review | no_code`(同文件 `:10-13`),
  **`blocked` 依然不在其中**。

⇒ 这份调研的**核心命题**(generalized 节点没有「正常地失败」的出口)**在 #748
  之后依然成立**,它的 plan 未被取代。变化的是周边:节点现在有写权限了,所以
  文档里关于「no-write 契约」的那部分前提已过时。

> Eng Lead 对基线问题的裁定:「第一代基线在 #748 之前**不影响文档价值** ——
> 它记录的是**当时的事实,而事实没有变**。」
