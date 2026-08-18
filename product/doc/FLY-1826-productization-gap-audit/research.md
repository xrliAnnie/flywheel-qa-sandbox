# Research: 审计方法、证据来源、以及哪些结论会过期

Issue: FLY-1826 (https://linear.app/geoforge3d/issue/FLY-1826)
日期: 2026-08-17
基于: `exploration.md`(问题定义)· `findings.md`(证据总账,三轮全部)· 代码审计基线 `13a19c157`(main,2026-08-16)

> **本文是给「三个月后接着做的人」写的。**
> 它不重复结论(结论在 `findings.md`),它回答两件事:
> **① 每条结论是怎么得出来的、怎么重跑一遍;② 哪些结论会随时间失效、失效了怎么重新核。**
> 第 ② 节是本文的重点 —— 本单的很多数字是 **as-of 值**,三个月后必然不同。

---

## 1. 方法论:每条结论都要可证伪

派单人自己把他的猜测标成了猜测(「我怀疑是容器关闭,但这是我的猜测,请证实或推翻」),
所以本单从一开始就按「可证伪」写:**每条结论附文件行号 / issue 号 / 可复跑的命令;推断与实测分开标注**。

三档标记贯穿全部产物:

| 标记 | 含义 |
|---|---|
| **实测** | 我跑了命令/探针,有输出 |
| **静态推断** | 只读代码得出,**未真机验证**,附证伪方式 |
| **无法查证** | 缺权限/缺真机,已列进「交给 Annie 和 Tadashi」清单 |

## 2. 四条证据链,逐条给复跑方法

### 2.1 Linear 账面(issue 树与状态)

用 Linear MCP 读,不看 issue 自述、看 `stateHistory` 和 `attachments`:

- `get_issue FLY-648 --includeRelations` → 拿 attachments(关它的 PR)+ completedAt
- `list_issues --parentId FLY-648` → 拿真实子任务状态(**这一步是关键**:648 的子任务里 6/8 未完成)
- 真正交付的那条线**不在 648 下面**,靠关键词搜到:`list_issues --query "产品化"` / `--query "payload beta release 发布 流水线 分发"`

**教训(值得复用)**:按 EPIC 的 children 翻会漏掉整条线。**先按关键词全库搜一遍,再看树。**

### 2.2 代码审计(闭包扫描 —— 本单方法论上最有价值的一段)

问题:「新改动会不会打破已有系统」不能靠逐个 commit 读,204 个 commit 读不完。
做法三步:

1. **确定回归窗口**:分发层激活日 = **2026-07-18**(FLY-1323 关单 13:46 → npm 首发 13:47 → 同日最后一次 beta 成功 12:23)。
2. **机械导出「客户路径表面」**:从 `scripts/package-onboard-files.allow`(125 行显式白名单)导出 payload 实发的 **57 个具名脚本**。
3. **双向闭包扫描**:
   - 正向:这 57 个引用的 `~/.flywheel/bin/*.sh`,哪些不在 payload 里;
   - 反向:这 57 个 `source`/调用的同级脚本,哪些不在 payload 里。
4. **逐条去调用点核实是硬失败还是有守卫** —— **这一步排掉了 3 条误报**,不做这步那个「6」不可信。

复跑(命令在 `findings.md` §2.1 的取证栏里有完整版;骨架):

```
awk '/^scripts\//{print}' scripts/package-onboard-files.allow | sed 's|^scripts/||' | grep -v '\*' | sort
# 然后对每个文件 grep 它引用的 ~/.flywheel/bin/*.sh 和 $SCRIPT_DIR/*.sh,与白名单求差集
# 差集里的每一条,都要打开调用点看:有没有 [ -x ] 守卫 / 是不是被 packaged 分支显式禁用
```

**排掉的 3 条误报,写下来是为了让计数可信**:
`restart-services.sh` / `flywheel-daemon.sh`(`packaged/bootstrap-services.sh:4-12` 明确写明 packaged 路径 DISABLED 且有替代)·
`sync-gbrain-docs.sh`(`daily-standup.sh:110` 有 `[[ -x ]]` 守卫 + 非致命注释)。

### 2.3 线上活性探测(只读,三处)

```
curl -s https://registry.npmjs.org/@flywheel-ai/onboard            # npm 薄壳是否已发布 + 发布时间
curl -s -o /dev/null -w '%{http_code}\n' \
  https://flywheel-onboard-endpoint.xrliannie-b.workers.dev/manifest   # 401 = 端点活着且鉴权在工作
gh run list -R xrliAnnie/flywheel --workflow payload-beta-release.yml -L 300 --json conclusion,createdAt
gh run list -R xrliAnnie/flywheel --workflow payload-promote.yml -L 5   # 空 = 客户通道从未切过
gh variable list -R xrliAnnie/flywheel; gh secret list -R xrliAnnie/flywheel
```

### 2.4 权威文档(形态陈述的出处)

形态的每一条都必须能指到这两份之一,否则标成「事实如此·待确认」或「没定」:

- `product/doc/FLY-911-product-positioning/positioning.md`(152 行,v1 final)—— 定位、beachhead、核心 job、不服务谁、信任四件事、六道保障
- `engineering/doc/FLY-910-onboarding/prd.md`(292 行,v3,Codex design review APPROVED)—— 用户、部署模型(MVP 自托管 / V2 managed)、体验铁律、北极星、§12 的 BI-0…BI-8

### 2.5 交付物自身的验证(founder HTML)

发布后、开 founder_review 之前:

- **量高度**(≤6000px,超了 Discord 预览图会崩)——headless Chromium,脚本见记忆 `reference_founder_html_must_be_measured_before_delivery`
- **验交互**:radio/textarea 进汇总、reload 后仍在、**复制失败路径不谎报**(必须同时打断 `navigator.clipboard` 和 `document.execCommand`,只断前者会回落成功、那条用例就安静地不再测该测的东西)

---

## 3. ⚠️ 会过期的结论 —— 三个月后接手请先核这一节

**本单大量数字是 as-of 值。下表每条给「怎么重新核」。核完再用,不要直接引用。**

| 结论 | as-of 值(2026-08-17) | 会不会变 | 怎么重新核 |
|---|---|---|---|
| Beta 发版连败次数 | 118(我取证时)→ 119(HL 复核时) | **一直在涨**,除非被修 | `gh run list --workflow payload-beta-release.yml -L 300 --json conclusion` 数 failure |
| 最后一次成功发版 | 2026-07-18T12:23:20Z | 修好后会变 | 同上,取最后一个 success 的 createdAt |
| 客户通道从未 promote | `payload-promote.yml` 运行次数 = 0 | 一旦跑过就变 | `gh run list --workflow payload-promote.yml` |
| 「客户通道指针是空的」 | **间接推断**,三条旁证 | 随时可能被改 | **需要 license key 直接读 manifest**,我没有(见 plan §4) |
| npm 薄壳版本 | `@flywheel-ai/onboard@0.1.0`,2026-07-18 | 会发新版 | `curl -s https://registry.npmjs.org/@flywheel-ai/onboard` |
| FLY-1582 状态 | **Canceled**(Annie 2026-08-14 裁「暂时不用修」) | 可能被改判 | `get_issue FLY-1582` |
| FLY-1143 状态 | Backlog,零开工 | 可能开工 | `get_issue FLY-1143` |
| 8 张新单状态 | FLY-1835…1842 全 Backlog,未派工 | 会变 | `list_issues --query "产品化·X"` |
| **N-1…N-6 六条闭包洞** | 全部成立 | **可能已被修** | 按 §2.2 重跑一遍闭包扫描;或直接核对应单是否 Done |
| 所有文件行号 | 锚在 `13a19c157` | **必然漂移** | 用 `git log -S'<那段字符串>'` 重新定位,别信行号 |
| PRD/定位文档内容 | FLY-910 v3 / FLY-911 v1 | 会 iterate | 直接读文件头的版本与日期 |

**特别提醒两条**:

1. **行号一律会漂。** 本单所有 `file:line` 都锚在 `13a19c157`。重新定位用内容搜,例如
   `git log -S'requires the launchd-native v2 body carrier' -- packages/teamlead/scripts/claude-lead.sh`。
2. **「6 条闭包洞」这个数字本身是方法产出,不是常量。** 重跑扫描可能得到不同的数 —— 那正是它该有的行为。
   要判断「有没有变好」,看的是**根因单 FLY-1835(打包闭包门)有没有落地**,而不是数字大小。

---

## 4. 本单查不到、必须别人查的(原样搬到 plan.md §4,此处只记为什么查不到)

| 要查什么 | 为什么我查不到 |
|---|---|
| 发布台账(`releaseLedger`/`releaseOps`)在端点上的实际内容 —— **发版失败的根因十有八九在这里** | 需要 ops-admin capability token,按运维手册只在 Annie 手里 |
| customer-release 通道指针到底是不是 null | 需要 license key |
| N-1…N-6 的真机确认 | 需要干净 HOME 跑非 dry-run,有干扰生产 fleet 的风险;边界属 FLY-1322 |
| 今天本地还能不能打出 payload | 在生产机上跑重型构建有压垮风险(全量 vitest 曾把 load 顶到 88) |

**没有「只有 Annie 知道」这一类** —— 唯一像的那件(FLY-1582 为什么被关)她的原话已在该单评论里,已当事实记录。

---

## 5. 复用价值(与本单结论无关,但值得下一个人拿走)

1. **按 EPIC children 翻会漏整条线** —— 先全库关键词搜再看树(§2.1)。
2. **「新改动有没有打破 X」用闭包扫描,不要逐 commit 读** —— 定窗口 → 机械导出被测表面 → 双向求差 → 逐条去调用点核实(§2.2)。
3. **计数类结论必须公布被排除的误报**,否则那个数不可信(本单 6 真 3 假)。
4. **护栏可能停在被测对象的上游** —— 本单根因就是这个:e2e 把入口脚本换成了假的、合同测试走 dry-run 而 dry-run 跳过所有硬门。
   查一个「为什么这坑没被发现」时,**先看护栏测的是不是它声称测的那个东西**。
