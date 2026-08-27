# FLY-2077 runbook + contact book 进仓 — 调研
Issue: FLY-2077 (https://linear.app/geoforge3d/issue/FLY-2077/2073册子-runbook-contact-book-进仓骨架-第一版底稿读者-infra-bot通用写法)
日期: 2026-08-27
基于: exploration.md

> 本修订只记录重做所需的事实输入。被 founder 打回的深手册、脚本守卫和会话 harness 调研已从交付中删除。

## Contact book 的输入

- `doc/architecture/infra-alerts-spec.md` 现有表回答「哪个 bot 修」，没有回答「需要人时找谁」。
- 全期 claims 账本出现过 63 类，不能用最近 7 天的 17 类估规模。
- 当前 TypeScript 枚举、shell 发射面和全期历史合在一起有 99 个已知唯一类别。第一版 contact book 用一张三列表覆盖它们，不再按责任域、provider 或多人层级拆表。
- 当前真实组织里，大多数类别找 Tadashi；绑定 runner 或 issue 的类别从工单/thread 取所属 Lead，权限和纯人类 quota 选择找 founder。

## 三个底稿类别的事实

| 类别 | 全期 claims 已出现 | log 入口应怎样写 |
|---|---:|---|
| `bridge_abnormal_exit` | 是 | 从 Bridge 服务启动配置取得 stdout/stderr log 位置，再用告警时间定位 |
| `mailbox_dead_letter` | 是 | 从信箱服务启动配置与当前项目 CommDB 配置取得投递证据 |
| `cmux_cleanup` | 是 | 从 cmux 同步任务的调度或启动配置取得 log 位置，再用告警里的对象和拒绝原因定位 |

这些入口都写「值从哪取」，不抄当前机器的路径。第一版只保留现象、log 入口、真实动作的最薄说明、恢复证据和联系人，不把一次事故扩成固定诊断树。

## 验收边界

- 结构验收：README、contact book、模板和三页底稿存在。
- 入册机制验收：拿一条真实告警，从识别新类别演到页面与 contact 行落位并留记录。
- 通用性验收：独立 QA 给不带本机上下文的 bot 告警文本与册子，bot 不需要口头提示。
- 变更边界：PR 只含 Markdown 文档；不改 CI、运行时、脚本或配置。
