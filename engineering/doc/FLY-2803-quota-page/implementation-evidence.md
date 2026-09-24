# FLY-2803 额度页页面改版 — 实现证据
Issue: FLY-2803 (https://linear.app/geoforge3d/issue/FLY-2803/额度页页面-页面一张单改完spec-e1-e19呈现改版分组排序在用号染绿进度条时间格式-订阅到期显示与手填记确认人时间-e19)
日期: 2026-09-23
基于: plan.md

## 当前边界

本文件记录 implement 节点的脱敏 fixture 与本机定向验证，不代表生产部署、真实账号读取、独立 QA 或全量 CI 已通过。截图输入只含别名和合成数值；没有登录、刷新凭据、写生产 state、重启 Bridge、派发 QA 或合并。

FLY-2807 PR #1301 已于 2026-09-23 22:49:10Z 合入 main。本分支按 Lead 指令以 merge（非 rebase）接入，并在冲突处同时保留 #1301 的真实读数/降级语义和本单页面投影。页面 GET 现把 Claude detail snapshot 的订阅状态接给 renderer；没有重做 #1301 数据层。

## #1301 集成的 TDD 证据

先新增两个失败断言，再做最小接线：

- 已取消账号的可见单元格仍显示“已取消”，但保留经过校验的 `weeklyReset.rawInstant` 供页面层排序；RED 后由 `canceledCell(rawInstant)` 变绿。
- route fixture 中 detail snapshot 的 `subscription: "canceled"` 必须渲染为“已取消 · 日期待确认”；RED 后仅在 GET 组装 `machineSubscriptions` 并传给 renderer，未改探针或降级逻辑。

相关 6 个测试文件共 106 tests 通过；#1301 指名的 4 个 probe/store/snapshot 文件共 58 tests 通过；账号选择阴性回归 24 tests 通过。

## Code review 后的中等项收口

首轮精确头 review 已通过，但留下 3 个非阻塞 MEDIUM advisory。为让实现和锁定计划的
失败路径/身份绑定完全一致，本分支在开 PR 前仍将它们全部收口，并先用 3 个失败测试
固定行为：

- provider 级读取失败原因现在在对应表内显示，保持 HTML escape，并且不会因此删除表、账号或卡片。
- 订阅手填身份解析失败现在触发只含账号别名与错误码的安全日志；页面仍返回未知状态，不泄露 identity key。
- Codex 手填确认只有在当前 profile 身份与已存 quota reading 身份一致时才可采用；旧 reading 没有身份字段时保留兼容，明确不一致则降级为未知。

这 3 个 review 回归测试连同原有点名集共 11 files / 191 tests 通过。

## QA attempt 1：E5 分组间隔返工

QA 在精确头 `2b660eb11` 的生产 Chromium 中量到相邻分组间距为 0px；原实现依赖
`tbody::before` 伪元素，属于浏览器间行为不一致的死合同。先把浏览器尺子收紧为
必须存在真实 `tbody.quota-group-spacer`、每个相邻分组恰好一个 spacer、且 computed
height 大于 0；旧实现得到 `FAIL: group_spacing`。随后做最小修复：相邻分组之间输出
一个 `aria-hidden` 的单格 spacer tbody，并把高度固定为权威 mockup 的 10px。

单测现在对三组数据断言恰有两个结构 spacer，并固定 10px CSS 合同。更新后的浏览器
量测在 Claude 和 Codex 各覆盖 available→full、full→unavailable，共 4 个间隔，全部为
10px；对应 4 个 spacer 也都是 10px 且各只有一个 cell。active+full 与
active+unknown 的 Claude/Codex 行仍然全部单元格为绿底，左轨、绿点和在用标均保留。

本次返工只处理 QA 唯一 blocker E5。Codex 来源副标、充值卡部署后复核及取消文案
一致性均由 QA/Lead 明确列为非阻塞 follow-up，本单没有扩展范围。QA attempt 1 的旧头
虽曾取得 full CI OK，但已被本次代码变更失效；implement 没有为新头请求 full CI，
新精确头的全量验证仍由 QA retest 所有。

## 新旧同夹具浏览器对照

同一份 `fixture.json` 同时交给 `origin/main` 的旧 renderer 与本分支 renderer。`render-fixtures.mjs` 从 git ref 读取旧源码并用 TypeScript `transpileModule` 生成临时模块，不复制或改写生产数据。`browser-ruler.mjs` 使用 Playwright 1.58.1 与本机 Chromium Headless Shell 1234；每个页面使用独立一次性浏览器，避免宿主长驻 browser。

- [改前与改后并排](evidence/baseline-vs-candidate.png)
- [改后宽屏](evidence/candidate-1440.png)
- [改后 390px](evidence/candidate-390.png)
- [在用且周额度 100%](evidence/candidate-active-full.png)
- [在用且本轮读数不可用](evidence/candidate-active-unknown.png)
- 结构化结果：`evidence/browser-metrics.json`；输入/HTML/head：`evidence/render-manifest.json`

浏览器尺子结果为 `PASS: browser visual contract`：两张 provider 表；仅未知组显示“本轮读数不可用”；footer/source meta/recovery 均为 0；390px 两个 table-wrap 都可横向滚动；console error、page error、证据目录外请求均为 0。active+full 与 active+unknown 两个页面都各有 Claude/Codex 两条 active 行，每个 `td` 的 computed background 均为 `rgb(227, 244, 236)`，并各有绿点、在用标和左轨。

QA 返工后的结构量测还固定了 4 个相邻分组间隔：Claude/Codex 各两处，视觉间距和
spacer computed height 均为 10px；因此证据不再依赖 `tbody::before` 的浏览器实现差异。

2026-09-23 在 #1301 合入后重生同一套浅色证据；旧侧 baseline 已换成当时的 `origin/main`，并人工查看并排图、在用且读不到图和 390px 图。新版没有暗色输出；在用且读不到仍是整行绿底，打满维度仍为红字/红条且不覆盖在用绿底。

首次截图发现原生 progress 的 100% 填充仍为绿色；加入 WebKit/Firefox progress value 明确红色规则并重跑后，满格文字与条均为红色，active 行底色仍为绿色。该修复有单测固定 CSS 合同，截图作像素回读。

## 除点名外无元素消失

| 旧页面元素 | 改后 | 依据 |
|---|---|---|
| 账号别名 | 保留 | 两表首列与截图 |
| 订阅档位 | 保留 | 账号下第二行；business 明示机器值/20x 待确认 |
| Codex token 状态 | 保留 | 独立列；真实吊销不改写 |
| 周重置日 | 保留 | `MM/DD 周几 HH:mm` |
| 5h reset | 两表保留 | `MM/DD 周几 HH:mm` |
| 周用量 | 保留并增强 | 数字+条；100% 维度红色 |
| Fable 周用量 | Claude 保留并增强 | 数字+条；独立于周分组 |
| 充值卡/兑换卡 | 保留 | 多行、不读到时仍显示原因 |
| 订阅到期 | 保留 | active 空白；canceled 日期/待确认；unknown |
| 既有错误原因 | 保留 | 账号格/卡片格可见，不给整行灰底 |

授权删除项仅为 spec 点名的顶部两行灰字、格内来源/读取时间、两表后 footer/legend/差异、Codex credits 余额、恢复文字和行级合成“打满”。

## E19 阴性控制

- 页面投影测试对同一 rows 分别替换 5x、20x、unknown，group/order 完全一致；active、5h、Fable、stale、旧 sortAt 也不改变排序。
- `SelectInput` 仍只有 scope/currentName/now/models/preferredOrder/verifiedAt/excludeNames/eligibilityOverrides，不含 subscriptionTier、rateLimitTier 或 planType。
- 生产源码 import 审计中，新 page/manual 模块只被 page renderer、Bridge GET 和手填 CLI 消费；account-heal selector 与 codex-quota 轮转模块没有 import。
- 新模块没有给 `retiresAt` 赋值。页面 GET 只读 manual 文件；唯一写盘函数位于显式 `install` CLI 路径。

## Consumer sweep

按每个生产改动文件的完整路径、文件名、父目录分别执行了 `git grep -lF`，并用实际 ESM import 名（`.js`）补充精确消费者扫描：

- `account-quota-page.js`：只命中 page 单测与 `account-quota-view.ts`；均保留并验证。
- `account-quota-view.js`：命中 page/view 单测、`account-quota-page.ts`、`hook-payload.ts` 与 `plugin.ts`；均由定向测试或 `vitest related` 覆盖。
- `account-subscription-manual.js`：命中 page/manual/CLI 单测、page、CLI 与 plugin；均保留并验证。
- `account-subscription-manual-cli.js`：只命中 CLI 单测；已验证。
- `plugin.ts` 完整路径命中 3 个结构测试、1 个 child-process inventory 和本单 research；`plugin.ts` 文件名的其余 69 个命中是对同名 Bridge 入口的既有结构/路径文字，不是本单新增消费者。它们未加入手选小集，但 `vitest related` 实际扩到 135 个测试文件并全部通过。
- `package.json` 与 `packages/teamlead` 属通用文件名/目录：在限定的 teamlead/FLY-2803/product-spec 范围分别有 33/61 个文字命中，都是打包、路径或文档引用，不消费新增 bin。新增 bin 由 CLI 单测和 affected build 验证。
- `.ts` 全路径/文件名扫描只额外命中 FLY-2803 计划、证据脚本及 FLY-2777 权威文档；它们是审计/证据，不是运行时消费者。
- E5 返工再次扫描 `account-quota-page.ts` 的完整路径、文件名、父目录和实际 ESM
  `account-quota-page.js`：运行时命中仍只有 page test、`account-quota-view.ts` 与
  `plugin.ts`，全部保留并由点名测试/related 覆盖；`.ts` 文件名的两个命中只是本单
  plan/evidence。父目录是通用 Bridge 路径，990 个既有命中均为同目录代码、测试或
  文档路径引用，不是 E5 spacer 的新增消费者，故不逐一加入点名集。
- `browser-ruler.mjs` 的完整路径和文件名均只命中本证据文档；evidence 父目录另命中
  milestone。两者都是复现/索引文档，不是生产消费者，保留但不另跑运行时测试。

E19 额外运行时审计：page/manual 模块在 `account-heal`、`codex-quota` 和 workflow selector 中零 import；`SelectInput` 仍只有 scope/currentName/now/models/preferredOrder/verifiedAt/excludeNames/eligibilityOverrides。档位只在 view/page 展示，不进入选择、轮转或自动决策。

## 本机验证结果

- 11 个页面/手填/route/patrol/probe/selector 定向文件：191 tests passed（含 code review 后 3 个新增失败路径/身份绑定测试）。
- 4 个 #1301 probe/store/snapshot 定向文件：58 tests passed。
- `account-candidate-selector.test.ts`：24 tests passed。
- `vitest related`（5 个 TypeScript 生产模块）：因 Bridge 依赖图扩大到 135 files / 1697 tests，全部通过。
- `pnpm --filter "flywheel-teamlead..." build`：13 个 affected package/dependency build 通过。
- task 文件的 Biome check：0 errors；`plugin.ts` 保留 2 个本单外既有 `useConst` warning。
- `pnpm lint`：通过，0 errors / 26 warnings；warnings 均为仓库既有项，未越权清理。
- QA E5 返工点名测试：`account-quota-page.test.ts` 17/17 通过，含真实 spacer 数量和
  10px CSS 断言；浏览器尺子先红后绿，最终 4/4 分组间隔和 4/4 结构 spacer 均为 10px。
- QA E5 返工 changed-TS `vitest related account-quota-page.ts --run`：133 files /
  1681 tests 全部通过；affected package/dependency build 仍为 13 个包并通过。
- QA E5 返工后 `pnpm lint` 再次通过（0 errors / 26 个既有 warnings），
  `git diff --check` 通过。
- 未请求 full CI；implement handoff 没有冻结精确头，按角色合同由 QA 在冻结头请求全量。

## 可复现命令

```bash
pnpm --filter "flywheel-teamlead..." build
node engineering/doc/FLY-2803-quota-page/evidence/render-fixtures.mjs
mkdir -p /tmp/fly2803
TMPDIR=/tmp/fly2803 node engineering/doc/FLY-2803-quota-page/evidence/browser-ruler.mjs
```

这里不把本机验证或视觉 fixture 称作全量 CI、生产验证或独立 QA；code review 与 PR 结果在最终 handoff 记录。
