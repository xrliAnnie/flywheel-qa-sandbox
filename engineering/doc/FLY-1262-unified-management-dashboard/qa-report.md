# FLY-1262 统一管理台 — QA 报告(独立 QA 段,三段式 QA phase)
Issue: FLY-1262 (https://linear.app/geoforge3d/issue/FLY-1262)
日期: 2026-07-15
基于: plan.md · exploration.md · research.md · PRD `product/doc/FLY-1038-unified-management-dashboard/prd.md` · 原型 `prototype/dashboard.html`

## 结论:**FAIL**(1 个 ship-blocker 的真机布局缺陷)

自动化测试全绿、SSOT 架构(§6.1–§6.4)真机可验证通过,但**默认落地页(实例页)在真实浏览器里整页不可见**——这是 PRD 形态的核心一半(模型级联 / DAG / cron),用户打开管理台看到的是错的页。纯 CSS 单点缺陷,内容与逻辑本身正确,修复量小但必须修。QA 判定 FAIL,退回 implement 段。

---

## 一、自动化验证(全部通过)

| 项 | 结果 |
|---|---|
| config 聚焦套件(model-registry / model-tiers / three-stage / flags ×3) | **66/66 通过** |
| teamlead 管理台套件(contract / topology / snapshot / dag / cron / writers / coordinator / section / ui / dom / §6 acceptance / qa-script) | **95/95 通过** |
| teamlead 回归套件(fleet-console / fleet-routes / capabilities / runner-routes / flag / workflow-template …) | **110/110 通过** |
| `scripts/qa-fly-1262-management-dashboard.mjs`(隔离模式) | §6.1/6.2/6.3/6.4 **四条 PASS** |
| typecheck(config + teamlead) | 通过 |
| build(config + teamlead) | 通过 |
| `git diff --check` | 干净 |
| lint(packages/config/src + packages/teamlead/src + scripts) | 0 error(13 warning,均非本 diff;`.pnpm-store`/`.flywheel/runs` 的报错是本机环境噪声,CI lint 绿) |
| 反手工静态哨兵(plan Task 12.3) | 两条均无匹配(通过) |

## 二、真机独立验证 —— SSOT / §6(通过)

用隔离 Bridge(worktree 内 `createBridgeApp` + 真 StateStore + 真 snapshot providers + 真 cron 扫描器;launchctl/plutil 打桩,**不碰真机任何 LaunchAgent**)在 loopback 端口起了一台真的管理台,Claude-in-Chrome 直连 + `/api/fleet/snapshot` 直读核对:

- **§6.1 一个干净聚合层**:`GET /api/fleet/snapshot` 返回 `schemaVersion:1`,一次带回 projects / leads / roles / dags / crons / **5 个 modelCatalog surface(cron/dispatch/lead/runner/workflow)** / **95 个 flag** / extensions。✅
- **§6.2 回路无 LM/手工汇总**:HTML 里无 `PROJECTS`/`VENDORS`/`FLAG_GROUPS` 名单、无真 project/lead/cron id、无 ingest 路径;数据全来自 provider 代码路径。✅
- **§6.3 后端新增自动出现(核心反例)**:注入的 **`com.xiaorongli.weee-weekly`(周三 09:00,`/bin/bash` argv0 + 项目脚本 argv1)——正是原型手工汇总漏掉、被 Annie 当场抓到的那条——被自动发现**;`com.adobe.updater`(未匹配)归 Unassigned 而非被吞;symlink plist 出可见 error;全部零 UI 改动即出现。✅
- **§6.4 统一提交流真落盘**:acceptance 集成测试驱动 HTTP stage→modal 服务端 canonical old/new→apply,实际写 YAML/DB/env/plist + launchctl 注入序列;stage 后改源 → apply 409 且原字节/行不变;混合运行时失败 → durable partial。✅
- **无密钥泄漏**:snapshot JSON 不含 `botToken`/`must-not-leak`/`SECRET_CANARY`/`api-secret`。✅

真机截屏另证:实例页(强制可见后,见下)项目分组正确(FLYWHEEL / SUB / TIDAL-ECHO,sub 挂 tidal-echo 下 · Infra/基础设施组 · 全局运行参数扩展 tab)、三级模型级联(公司→型号→effort,选项来自真 registry,Lead 的公司选择置灰=跨 provider 只读)、模型/DAG 模板/Cron 三 tab 齐备。**这些内容与逻辑都对——问题只在它默认不显示。**

## 三、🔴 Ship-blocker:实例页默认整页不可见(页面切换/布局缺陷)

### 现象(真机,确定性可复现)
打开管理台(默认 = 实例页,左导航"实例"高亮 `.active`),用户看到的却是 **Feature Flags 页的内容**;实例页(模型/DAG/cron——PRD 形态的核心)被压成高度 0、不可见。只有显式点"Feature Flags"再点回"实例"也无法恢复——实例页始终 0 高。

### 真机测量(Claude-in-Chrome,`getComputedStyle` + `offsetHeight`)
| nav 状态 | `#instancesPage` | `#flagsPage` |
|---|---|---|
| **实例 active(默认落地)** | active=true, display=grid, **offsetHeight=0** ❌ | active=false, display=**flex**, **offsetHeight=1964** ❌(应 none/0) |
| Feature Flags active | active=false, display=none, offsetHeight=0 ✅ | active=true, display=grid, offsetHeight=1964 ✅ |

即:Feature Flags 页**从不被隐藏**;实例页虽 `.active` 却塌成 0 高。

### 根因(单点,`packages/teamlead/src/bridge/fleet-console-html.ts` 内联 CSS)
```css
.workspace{... display:grid; grid-template-rows:minmax(0,1fr); ...}
.page{height:100%; display:none}          /* 特异度 (0,1,0) */
.page.active{display:grid}                /* (0,2,0) 显示 active 页 */
.detail,.flags-page{... display:flex ...} /* (0,1,0),但源码顺序更靠后 */
```
`.flags-page{display:flex}` 与 `.page{display:none}` 特异度相同,但**源码顺序在后 → 胜出**,于是 `#flagsPage` 永远 `display:flex`、从不被 `.page{display:none}` 隐藏。因为它一直参与 `.workspace` 的 grid,`grid-template-rows:minmax(0,1fr)` 只定义 1 行、两个 page 子项 → flags 落进隐式 auto 行、按整段内容高度(~1964px)撑满 → active 实例页所在的 `1fr` 行被挤成 **0 高**。一条选择器引发整条塌陷。

### 为什么自动化没抓到
jsdom/happy-dom 的**交互测试不做 CSS 布局**(`offsetHeight` 恒 0),既有 DOM 测试也从没断言两个 page 的**计算 display 互斥**。这正是必须真机 QA 的一类缺陷。

### 证据 & 隔离验证
- 现场注入一行 `.page:not(.active){display:none !important}` → 实例页立即 offsetHeight=1964 正常渲染、flags 隐藏 → 证明**纯 CSS display/布局缺陷,内容/数据/逻辑本身正确**。
- 影响的 PRD 条款:§5.1(两个独立页)、§5.2(模型级联)、§5.3(DAG tab)、§5.4(cron tab)、§5.7(填满窗口高度)——实例这半边整体不可用。

### 新增回归测试(RED,已提交本分支)
`packages/teamlead/src/__tests__/management-console-page-switch.test.ts`(happy-dom,`getComputedStyle` 解析真实 CSS 级联):
- "shows only the instances page when 实例 is the active nav(default landing)" → 现在 RED(flags 算出 `flex`,期望 `none`)
- "never displays both pages at once in either nav state" → 现在 RED(默认态显示 2 个页,期望 1)
- "shows only the flags page when Feature Flags is the active nav" → PASS(该态本就正确)

修复(让非 active 页真正隐藏,例如 `.page:not(.active){display:none}`,或把 `.flags-page` 的 `display:flex` 收进 `.page.active` 作用域并保留内部 flex 布局)后三条全绿。

## 四、给 implement 段的修复指引
1. 让非 active 的 page 一定被隐藏——`.flags-page`(和 `.detail` 无关,它是实例页内部子元素,别动)的 `display:flex` 不能盖过 `.page{display:none}`。最小改法:新增 `.page:not(.active){display:none}`(特异度 0,1,1 > 0,1,0,稳胜),或把 flags 页外壳的 flex 布局迁到只在 `.active` 时生效的选择器。
2. 顺带确认 `.page.active` 那半边不会被同样问题影响(修完让上面的回归测试三条全绿即可)。
3. 不需要动任何后端/SSOT/写回逻辑——那些真机已验证正确。

## 五、复现方式
- 回归测试(CI 可跑,推荐):`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/management-console-page-switch.test.ts`
- 真机复现(可选):QA 用隔离 harness 在 loopback 起 `createBridgeApp`(fleetConsole 接上全套 management providers,launchctl 打桩),Claude-in-Chrome 打开根路径即见默认页显示 Feature Flags 内容而非实例页(harness 源见 QA 会话 scratchpad `qa-console-harness.mts`,需放进 `packages/teamlead/` 以解析 workspace 依赖后 `node --import tsx` 运行)。
