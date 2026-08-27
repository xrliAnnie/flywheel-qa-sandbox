# FLY-2077 runbook + contact book 进仓 — 探索
Issue: FLY-2077 (https://linear.app/geoforge3d/issue/FLY-2077/2073册子-runbook-contact-book-进仓骨架-第一版底稿读者-infra-bot通用写法)
日期: 2026-08-27
基于: 无

> 2026-08-27 修订：founder 打回第一版成品手册方案，并确认 Lead 提出的「能长出册子的系统」重做方向。本文件只保留重做后仍有效的边界，旧方案不再是实现依据。

## 目标

在 `doc/oncall/` 放一套持续入册的约定：一个告警或病根类别一本薄 runbook，一张「类别 → 找谁」contact book，以及负责入册、回填和抽验的 README。

## 已锁边界

- 读者是 Infra bot；主路径是从 log 还原，不依赖本机上下文。
- 机器特有值只写来源，不写解析后的路径、账号或主机名。
- 不固定判断步骤，不增加自动检查、生成器、状态探针或其他代码。
- contact book 如实反映当前近乎单点的组织，大多数类别直接找 Tadashi。
- 第一版只给 `bridge_abnormal_exit`、`mailbox_dead_letter`、`cmux_cleanup` 三页薄底稿。
- 新告警类别上线前必须在册；README 定规则，FLY-2076 执行。

## 结构

```text
doc/oncall/
├── README.md
├── contact-book.md
└── runbooks/
    ├── _template.md
    ├── bridge_abnormal_exit.md
    ├── mailbox_dead_letter.md
    └── cmux_cleanup.md
```
