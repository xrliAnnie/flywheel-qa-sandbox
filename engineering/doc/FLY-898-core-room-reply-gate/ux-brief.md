# FLY-898 core-room 回复纪律 — UX Brief（founder sign-off 用）

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: plan.md（Codex design review R2 APPROVED）
给谁签: Annie（founder-facing UX 变化，需她本人点头）

---

## 这是什么（Annie 你会看到/操作的变化）

你睡前说的：**所有项目的 core room，如果没 @ 任何人，就只有 CoS 回；其他 lead 只有被 @ 才回。**
这个 brief 就是把这句话落成每个 core room 的实际行为，请你确认下面「你会体验到的样子」对不对。

「core room」= 每个项目那个总频道（geoforge3d-core、flywheel core、tidal-echo core… 各项目一个）。
每个 core room 的 CoS = 那个把 core 当自己主频道的 lead（geoforge3d=Simba、flywheel=Aunt Cass、
tidal-echo=Triton、sub=Asha、growth=Mufasa）。

## 你在 core room 会看到的样子（改完之后）

| 你发的消息 | 谁会回 |
|---|---|
| 没 @ 任何人（一般问题 / 状态） | **只有该项目 CoS** 回，其他 lead 静默（根本收不到、不会跳出来插话） |
| `@某个 lead`（真的 @ 它） | **那个 lead** 回 |
| `@CoS` | CoS 回 |

其他都不变：各 lead 自己的部门频道、issue thread、roundtable —— 行为完全照旧。

## ⚠️ 一个需要你特别确认的收紧点（重要，别略过）

你原话是「点了它的名」。我们实现时把 core room 的「点名」**收紧成必须真的 @ 它**（Discord 里那个会
高亮、会 ping 的 @），**不认光打名字的文本**。

**意思是**：在 core room 里打「Peter 看一下」（只打名字、没真 @）→ **Peter 不会收到、不会回**；要找
Peter 必须真 `@Peter`。

**为什么这么收紧**：光匹配名字文本会误触发 —— 比如你说「刚 Peter 帮我搞了 X」（只是提到 Peter、并不是
叫他做事），旧做法会让 Peter 也跳出来回，正是你烦的那种「一堆 bot 抢着回」。真 @ 才是明确「我在叫你」的
信号。而且就算你只打了名字没 @，CoS 仍然会收到（core 里所有没-@ 的消息 CoS 都收），不会漏。

**如果你更想要「打名字也算叫它」**：也能做（放宽成名字也触发），但会带回上面那种偶发误触发。请你选：
- (默认) **只有真 @ 才触达非-CoS lead**（干净、不误触发，找人请真 @）；
- 或 **打名字也算**（更宽松，但偶尔会有 bot 因为名字被提到而多回一句）。

## 范围与安全

- 全项目统一、一处改全生效；未来新项目自动适用。
- 单 lead 的项目（如 joycon）没有「其他 lead」→ 不受影响，那个 lead 照常收所有消息。
- 这是影响所有项目的行为改动 → 上线前 hold 在你的 ship gate，你早上 review 点头才真正生效，绝不自动上。

## 需要你确认的

1. 上面「你会看到的样子」那张表 —— 对吗？
2. 那个收紧点 —— 接受「core 里找非-CoS lead 必须真 @」(默认)，还是要「打名字也算」？
