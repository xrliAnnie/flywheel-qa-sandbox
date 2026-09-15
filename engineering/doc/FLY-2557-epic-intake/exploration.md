# FLY-2557 Epic 自动入口 — 探索
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: 无

## 目标与授权
Founder 把无 parent、命中项目 department label 的 Epic 设为 In Progress，就是让该项目 Lead 开始拆解和按容量推进的入口。Bridge 负责可靠通知、显示与读数，Lead 负责判断、拆子单、写依赖账本及 Epic thread 回帖。Epic 外的工作仍需 founder approve；合并和部署授权不变。

本轮仅设计：探索、调研、实施计划、正式设计评审及静默发布 founder HTML。TURN=design，epoch=1，activation=activation:6e76e8b9-4193-44c2-b3c0-4f385968403c:f7b658b8-74cb-4566-952f-65ffea1e6563:eng_design:1。基线 f31b75af9；工作树开始时干净。

## 已知缺口
- `linear-epic-query.ts` 的 activeScopeFilter 限制 `children.length > 0`，未拆解 Epic 被排除。
- `runner-patrol-rules.md` §0.9 已有容量拉活，§0.10 已有固定页新鲜度，§7 已有 dependency add/remove/discover；缺 §0.11 intake 处理。
- 同一次 started 状态修改不能用每轮本机时间作为事件身份，否则重扫和重启重复通知。
- 需要核实 Linear startedAt 是否表示每次重新开始；不能凭字段名假设。

## 候选路径
| 路径 | 判断 |
|---|---|
| 复用已验证的 Linear issue webhook 入站 | 若确有 Bridge 可用、认证完整的通道，优先使用；不能把另一服务 agent session webhook 当成现成 issue 入口 |
| 复用 Epic 页 Linear 扫描及现有调度 | 未有可用入站时采用；必须补全真实转换历史，处理扫描间快速往返与重启，不能只比较相邻快照 |
| 新 timer、独立 Epic 查询和自动创建子单 | 拒绝：重复生成器、平行时钟、越过 Lead 的判断职责 |

## 调研问题
1. 当前 Bridge 的事件入站、Epic 扫描周期、生成器和 lead_events ACK 机制在哪里？
2. Linear 转换时间与历史如何形成 `epic_intake:<issueId>:<startedAt>`？首次上线怎样处理已 started？
3. 项目绑定、department label 与 Lead 选择怎样保持唯一，避免跨项目和默认误投？
4. 空 Epic 如何进入固定页、ready.v1 与 patrol，不被误报为已完成或可拉活的子单？
5. 事务、重复投递、ACK 后 Lead 未拆完、半成品子单如何恢复？
6. FLY-2553 页面形状是否已在本分支；如何保持接口兼容而不重做页面？

## 验收保持原范围
隔离测试项目、测试频道和测试 Epic：进入 started 后 60 秒内恰一事件且 Lead ACK；重复 started 不重复，无 label / 有 parent 不投；每次重入 started 独立一次；Done/Canceled 不投；跨项目路由；一个巡检周期内拆解、账本核对、回帖；固定页未拆解卡态、fixture 与实机证据。设计期不制造这些运行证据。
