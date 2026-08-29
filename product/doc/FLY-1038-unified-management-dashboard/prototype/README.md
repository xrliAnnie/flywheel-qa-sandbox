# FLY-1038 统一管理台 — 设计原型 (design prototype)

Issue: [FLY-1038](https://linear.app/studio/issue/FLY-1038) · 日期: 2026-07-13 · 基于: Annie 逐屏共创 (~45 轮反馈)

## 这是什么

一个**只读设计原型**,用来跟 Annie 收敛「统一管理台」的形态。**不是生产实现。**

- `dashboard.html` — 原型本体(单文件,自带样式 + 交互)
- `serve.mjs` — 本地静态服务(每次请求重读文件 → 改完刷新即可)
- `keepalive.sh` — 保活脚本(端口 9920)

跑起来:

    node serve.mjs        # → http://127.0.0.1:9920

## 已收敛的形态(Annie 逐屏确认)

- **实例**页:按 project 分组(字母序 + 搜索),真实层级(`sub` 挂在 tidal-echo 下),
  infra bot 单独归入 **Infra** 组。
- **模型**:三级级联 **公司 → 型号 → effort**,选项跟真实 registry 走;
  每个 Lead / 每个 DAG stage / 每个 cron 的模型都可改。
- **DAG 模板**:展示各 project 的角色与三段式(仅 flywheel 的 engineer 走三段式);
  角色卡带 **GitHub 链接**,可直接点进真实的 `.md`。
- **定时任务**:独立页;**星期多选钮 + 一天可多次**(`+ 加时间`),
  派生只读标签(每日 / 工作日 / 周末 / 自定义);每个可 enable/disable。
- **Feature Flags**:全部 flag 集中展示,统一 toggle,带中文说明,可按 project override。
- **统一提交流**:改动先进「待提交」栏 → 弹框逐条列出 `旧 → 新` → 确认提交。
  (原型**不落盘**。)

## ⚠️ 交付工程时的硬性要求(Annie 2026-07-13)

> 「前端最好能直接读取后端并显示所有的东西,不需要每次还要 LM 去告诉前端要改什么……
> 后端加了一个 cron job,前端就会显示出来了。不要到时候后端加了一个 cron job,
> 还得再想办法给它组织一下再给前端,这样不行。」

**生产实现必须:前端直读一个干净的后端 SSOT,自动反映真实状态(projects / Leads / DAG /
flags / cron)。没有任何 LM / agent 在回路里手工汇总数据喂给前端。**

后端新增一个 cron job / Lead / flag → 前端**自动**出现,无需任何人工重新整理。

本原型里的数据是**一次性扒出来的脚手架**,只用于表达形态 —— 它本身就证明了手工汇总
不可行:原型只扫了 `com.flywheel.*` 的 launchd plist,**漏掉了** personal-assistant
真实存在的 `com.xiaorongli.weee-weekly`(每周三 09:00),被 Annie 当场抓到。
手工汇总必然有遗漏、且会腐坏 —— 干净的自动发现 SSOT 才是正解。
