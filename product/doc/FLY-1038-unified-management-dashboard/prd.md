# PRD · Flywheel 统一管理台 (Unified Management Dashboard)

Issue: [FLY-1038](https://linear.app/geoforge3d/issue/FLY-1038) · 日期: 2026-07-13 · 作者: Honey Lemon (Product Lead)
基于: Annie 逐屏共创(~45 轮反馈,2026-07-12/13)· 已收敛的交互原型见 `./prototype/`

> **状态: 设计已收敛,Annie 确认可以进入交付。** 本 PRD = 收敛后的形态定义;`prototype/` = 可运行的设计原型(表达形态,非生产实现)。
> **交付 = 一个 backlog 工程 task 交 Tadashi 队列跟进(不急,不用马上推)。**

---

## 1. Problem

Flywheel 的实例配置散落在各处:每个 project 的 Lead 模型、DAG 各阶段模型、cron 任务、feature flags,都要去翻 config 文件 / 代码 / launchd plist 才能看到和改。**没有一个地方能一眼看全「这台机器现在到底在跑什么、每个环节用的什么模型、什么时候跑」,更没有一个地方能安全地改。**

Annie 要的是**一个统一的管理台**:一屏看全所有 project 的实例配置,并且能直接改(模型 / cron 时间 / flag 开关),改动集中确认后再落盘。

## 2. Users

- **主用户 = Annie**(founder):日常要看全局状态、调某个环节的模型、开关某个 flag、改某个 cron 的时间。
- 次要:各 Lead(将来可能自助查看自己 project 的配置)。

## 3. Goals

1. **一屏看全**:所有 project 的实例配置(Lead / DAG / cron / flags)集中在一个管理台。
2. **能安全地改**:模型、cron 时间、flag 开关都可改;改动进统一「待提交」流,确认后落盘。
3. **真实**:显示的是**真实系统状态**,不是编的示例数据。
4. **可扩展**:后端新增一个 cron / Lead / flag,管理台**自动**显示出来,无需任何人工重整。

## 4. Non-goals

- 不做真正的响应式(窄屏 / 手机 reflow)—— 交付时工程侧考虑,原型只需填满窗口。
- 不做权限系统 / 多用户(当前只有 Annie 一个用户)。
- 不做 PM 验收(未来 FLY-830)。

## 5. Requirements —— 收敛后的形态

> 每一条都在 `prototype/dashboard.html` 里可交互验证过。原型是形态的 SSOT,本节是文字规格。

### 5.1 结构:两个主页 + 按 project 分组
- 左侧导航两项:**实例** / **Feature Flags**。头部干净(`◆ Flywheel 管理台` + 右上「只读原型」pill),无冗余 meta。
- 实例页按 **project 分组**(字母序 + 搜索框)。真实层级:`sub` 挂在 `tidal-echo` 下。
- **infra bot 单独归入 Infra 组**(dept 组,不算某个 project 下)。

### 5.2 模型 tab —— 三级级联(公司 → 型号 → effort)
- **先选公司**(Anthropic / Google / …)→ **再选型号**(如 Opus 4.8 1M)→ **再选 effort**。
- 选项必须跟**真实 registry** 走(不是编的)。effort 跟着型号走。
- **每个可改的地方都能改**:每个 Lead 的模型、**每个 DAG stage 的模型**、**每个 cron 的模型**。

### 5.3 DAG 模板 tab
- 显示各 project 的角色与三段式。**注意:三段式(design→implement→qa)目前只有 flywheel 的 engineer 在用**;其他 project 用单文件角色。
- **角色卡带 GitHub 链接** → 直接点进真实的 `.md` agent 文件。
- 这里也是**调每个 stage 模型**的地方(承接 5.2)。

### 5.4 定时任务 tab —— cron 选择器
- 真实来源 = launchd plist + 脚本路径,逐个在 `launchctl list` 里核过是否真在调度。
- **星期 = 7 个多选钮**[一..日],任意组合(至少留 1 天);旁边**只读派生标签**:全选→每日 / 一~五→工作日 / 六日→周末 / 其余→自定义。
- **时间 = 一天可多次**:默认一行 [时]:[分],「+ 加时间」加行,多行时每行可删。
- 每个 cron 可 **enable/disable**;有 LLM 的可改模型。
- 语义 schedule = [星期集合] × [时间列表],映射到多个 `StartCalendarInterval`。

### 5.5 Feature Flags 页
- **全部 flag 集中展示**(不是散在各处)。每个 flag 带**中文说明**(它是做什么的)。
- 状态统一成 **toggle**(不要 on 一个锁、off 一个锁、enforce 又一个锁的混乱)。
- 可**按 project override**。

### 5.6 统一提交流
- 任何改动 → 进底部**「待提交」栏** → 点「提交改动」→ **弹框逐条列出 旧值 → 新值** → 确认提交 / 放弃。
- 「放弃」完整复原到真实原值。
- (原型**不落盘**;生产落盘见 §6。)

### 5.7 布局
- 管理台**填满窗口高度**,不留大片空白;「待提交」栏贴在管理台底部(不吊在窗口最下方脱节)。

---

## 6. ⚠️ 交付工程时的硬性要求(Annie 2026-07-13)—— 必须写进 build task

> 「前端最好能直接读取后端并显示所有的东西,不需要每次还要 LM 去告诉前端要改什么……
> 后端加了一个 cron job,前端就会显示出来了。不要到时候后端加了一个 cron job,
> 还得再想办法给它组织一下再给前端,这样不行。」

**生产实现的核心架构约束:**
1. **前端直读一个干净的后端 SSOT**,自动反映真实状态(projects / Leads / DAG / flags / cron)。
2. **回路里没有任何 LM / agent 手工汇总数据喂给前端。**
3. 后端新增一个 cron / Lead / flag → 前端**自动**出现,无需任何人工重新整理。
4. **写回**(改模型 / cron / flag)= §5.6 的统一提交流真正落盘到对应的 config / registry / plist,带确认。

**为什么这是硬要求(有实证):** 原型的数据是**一次性扒出来的脚手架**,只用于表达形态。它本身就证明了手工汇总不可行 —— 原型只扫了 `com.flywheel.*` 的 launchd plist,**漏掉了** personal-assistant 真实存在的 `com.xiaorongli.weee-weekly`(每周三 09:00),被 Annie 当场抓到。手工汇总必然有遗漏、且会腐坏;干净的自动发现 SSOT 才是正解。

## 7. Success metrics

| 指标 | 现状 | 目标 |
|---|---|---|
| 看全一台机器的实例配置 | 翻 N 个文件 / 代码 / plist | **一屏** |
| 改一个模型 / cron / flag | 手改 config + 重启 | **UI 改 + 确认提交** |
| 后端新增 cron/Lead/flag 到前端可见 | 需人工重整 | **自动出现,零人工** |
| 显示的数据真实性 | — | **100% 来自真实 SSOT,无编造** |

## 8. Open questions(交付时定)

1. SSOT 的具体形态:一个新的聚合 API,还是前端分别读 config/registry/launchctl?(倾向:后端一个干净的聚合层。)
2. 写回的落盘边界:哪些改动直接落盘,哪些要走额外确认(安全相关 flag)?
3. cron 写回到 launchd 的机制(生成 plist + `launchctl` reload)。

## 9. 交付 —— build issue

本 PRD → 一个 **backlog 工程 task**(`Flywheel` 标签 → Tadashi 队列),不急,Tadashi 后续跟进。
Build task 必须把 §6 的 SSOT 硬要求作为**核心验收标准**,并引用本 PRD + `prototype/` 作为形态基准。

**PM 验收 = 未来 FLY-830,现在不做。**
