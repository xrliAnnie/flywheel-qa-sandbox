# FLY-1367 PR #641 拍板页真机验收 — QA 报告

Issue: FLY-1367 (https://linear.app/geoforge3d/issue/FLY-1367/qa-fly-1342-真机验收-pr-641-拍板页founder-brief-可用性-三把-head-锁内容正确性)
日期: 2026-07-18
基于: 无(独立验收 PR #641 @ 2f71bd5b4771c6178b95e62c76e0980cd40e50e1)

## 结论:PASS

被测对象 = PR #641 head **2f71bd5b4771c6178b95e62c76e0980cd40e50e1**(开工前 fetch、报 PASS 前再 fetch,两次一致,verdict 绑的就是要 ship 的那一笔)。QA 全程未改任何实现代码(worktree clean)。

## 1. 真机可用性(托管 URL,真 CSP)

不看本地文件 —— 走 Bridge 的 `/api/reports/publish` 真发布,在真实托管页上验(裸开本地 HTML 会空过绿测)。

发布 URL:`https://fw-reports-a53de2.vercel.app/r/fccc023d122cd933ba54b3f1e7241752/`
(只调 publish、**没有**调 deliver —— founder 投递是 Lead 的活,没往 Annie 的 Discord 发任何消息)

真实下发的 CSP:`default-src 'none'; script-src 'nonce-408d33cbe97534fc909fa57120b75f98'; style-src 'unsafe-inline'; img-src data:;`
`__CSP_NONCE__` 占位符已被真 nonce 替换(服务端 HTML 中残留数 = 0),`<script nonce>` 与 CSP 中的 nonce 逐字一致,`noindex` 在位。

**脚本确实在真 CSP 下执行了(行为铁证,非"没报错")**:点 D1 建之后,右上计数器从 `0 / 7 已选择` 变成 `1 / 7 已选择`。这个数字只有 nonced 脚本里的 `updateProgress()` 跑起来才会变;CSP 若拦了脚本它会一直停在 0/7。

| 验证项 | 手法 | 结果 |
|---|---|---|
| D1–D7 建/不建 | 逐项点击,两个值都测 | 计数 1→7 逐格递增,7 项全部可选 ✅ |
| 无预选 | 首屏检查 | 7 项全空,Annie 必须自己拍 ✅ |
| 评论框 | 真键盘输入中文(含全角标点) | 正确落 localStorage ✅ |
| 刷新恢复 | 整页 reload | radio + 评论 + 计数全恢复,状态显示「已恢复本浏览器记录」 ✅ |
| 存储隔离 | 读 storageKey | `flywheel:founder-brief:/r/<token>/` 按路径隔离,不同报告不串 ✅ |
| 复制 Markdown | 真鼠标点击 → **`pbpaste` 直接回读系统剪贴板** | 剪贴板真的拿到了正文(逐字含我敲进去的评论 + 导出时间 `2026/7/18 11:46:20` + D1–D7 七段)✅ |
| 下载 Markdown | 真点击 + 查磁盘 | 真落盘 795 B,内容与所选逐项一致 ✅ |
| 清空(拒绝) | confirm 存根 = false | 什么都没清,选择与评论完好 ✅ |
| 清空(接受) | confirm 存根 = true | 计数归 0、radio 清空、localStorage 移除 ✅ |
| 页面报错 | console 读取 | 零报错;并用 `console.error` 阳性对照证明读取器确实在工作 ✅ |

导出的回执正文(磁盘原件,存 scratchpad/evidence/):标题、导出时间、"实施范围必须回到 FLY-1342 continuation 或显式实施子单"的诚实声明、D1–D7 七段各带「决定 / 评论」,未选的如实写「未选择」。

关于 `blob:` 下载:在 `default-src 'none'` 下最有可能被拦的就是它 —— 实测未被拦,文件真到了磁盘。

### 复制这一项的证据口径(Codex code review 提出后补强)

初稿我拿页面状态文字「Markdown 已复制」当复制成功的证据 —— **这个推断不成立,已改**。看实现:

```js
} catch {
  fallbackCopy(markdown);      // execCommand 的返回值没被检查
  setStatus('Markdown 已复制'); // 无论成没成都写成功文案
}
```

`fallbackCopy` 里 `document.execCommand('copy')` 的返回值被丢弃,catch 分支又无条件写成功文案。所以这句提示是**消息**,不是**效果**。这正是本仓栽过的「success message ≠ effect」。

改用**直接回读系统剪贴板**(`pbpaste`,绕开页面自述):剪贴板确实拿到了 `buildMarkdown()` 的完整正文,逐字含我当时敲进 D1 的评论、导出时间 `2026/7/18 11:46:20`、D1–D7 七段;同一状态下载到磁盘的文件(`11:46:41`)内容一致,互为佐证。**该证据成立的条件是标签页可见且处于活动状态**(= Annie 的真实使用姿态)。

### 由此发现的两件事(都非阻塞,不改 PASS)

1. **成功提示与实际结果不挂钩**(#641 的小瑕疵):`writeText` 被拒时会落进 catch,`fallbackCopy` 若也失败仍然显示「Markdown 已复制」。对 Annie 的实际影响很小(可见标签页下复制本来就成功),但按本 issue「证据不动被证物」的同一精神,提示文案不该无条件报成功。建议进 ship 后 fix-commit 清单,不建议为它卡 ship。
2. **文档不可见时复制会静默卡住**(环境侧,非 founder 路径):`document.visibilityState === 'hidden'` 时 Chrome 不让剪贴板写入,`await navigator.clipboard.writeText` 一直不 settle,连状态文字都不出现。我在后台标签页里复现了这个,**但这不是 Annie 的使用条件**,故不计入产品缺陷。也因此,我无法在本轮(浏览器窗口非前台)重新演示一次剪贴板回读 —— 上面引用的是标签页活动时的那次真实回读,不是新跑的。这点如实说明,不含糊。

**一个说明**:「清空」按钮调 `window.confirm`。浏览器模态框会卡死自动化会话,所以我把 `confirm` 存根成固定返回值来测两条分支,没有去点真实弹窗。弹窗本身是浏览器原生行为,对 Annie 就是一次正常确认,不是缺陷。

## 2. 内容正确性(对照 plan.md)

| plan 条款 | 页面表述 | 判定 |
|---|---|---|
| §0 证据不动被证物 | 首屏「一句话原则:证据不动被证物;修复永远允许」 | 一致 |
| §1 三重绑定 subject 全是 PR head | 三把锁卡片:`review → target_head_sha` / `qa → target_head_sha` / `approval → pr_head_sha` | 一致 |
| §2.2 修复 commit 永远允许 + implement_done 后有界重验 | 流程图「修复 push → 实现完成 → 增量复审 → 独立重验 → 重新请拍板」;D2 拟议明写「新 head 在 implement_done 后自动增量复审与重验」 | 一致 |
| §2.2 迭代上限 + 超限升级 | 「每条回头路和整条任务都有次数上限;超过上限就 hold 并升级给人」 | 一致 |
| §2.2 founder 红线:只作废、永不迁移 | 锁 3「head 变化时旧批准作废,拍板永不自动迁移」;并说明两把技术锁 fresh 后才发一次 delta,中间 fix head 不打扰 | 一致 |
| §2.3 违例只定性/告警,绝不 force-push | D3 拟议「其他变化进入 hold、告警并留下可审计收据」 | 一致 |
| §2.4 doc-only 逐 head,不认扩展名 | 「每个 head 单独生成判定收据…旧 head 的豁免不能漂到新 head」;判据写的是文件清单+内容与风险规则,没有"按 .md 判" | 一致 |
| §4 D1–D7 七项 | 七张卡与 §4 逐项对应(写面契约 / 有界重验 / 违例告警 / 档A / 档B / 档C / 过渡包) | 一致 |
| §4 诚实标注 | 七项全挂「拟建,拍板后开工」,各带 现在 / 拟议 / 生效依赖 三块;并有「本页不是上线证明」 | 一致 |
| §4 不带上游票号 | 全页只出现 FLY-1342(当前单),无其他票号 | 一致 |

另:全文 0 处「已实施 / 已上线 / 立即实施」类措辞。

**两处非阻塞小瑕(不影响 Annie 的任何一项决策,不建议为此卡 ship)**
1. 锁卡 1 写「修复 push 后…新 head 自动进入增量复审」,省略了 plan 里的 implement_done 前置(自动复审是在实现完成捕获之后,不是每次 push)。同页流程图和 D2 的表述都是准确的,整页读下来不会被误导。
2. D3 的「生效依赖」把 DAG transition uid 列为违例检测依赖;plan 里 transition uid 是 §2.2 的迭代计数机制,§2.3 的检测挂点是 capture 校验 / onQaResult / USE-time / sweep。属归因偏松,不是行为描述错误。

## 3. 契约测试

`node --test founder-brief.contract.test.mjs` → 1 passed / 0 failed。

绿测本身要能证伪才算数,所以做了 6 个突变对照,**全部转红**:预勾选 radio、注入内联 `onchange`、加外链 CDN、删掉一个 textarea、破坏 nonce 占位符、把 localStorage 换成 sessionStorage。说明这份契约测试是真尺子,不是空过。

## 4. verdict 落库(诚实说明其效力边界)

`flywheel-comm qa-result --status pass --pr-head 2f71bd5b4…` 已发出。CLI 打印「delivered」,但 delivered ≠ recorded,所以查了库:

- `session_events` 有真行:event_id `f1185cb6-2444-4710-b6cf-3f7f78a6adbb`,`status=pass`,`prHeadSha=2f71bd5b4771c6178b95e62c76e0980cd40e50e1`,`targetExecutionId=deb1b5af…` ✅ 事件确实持久化了,且绑的是对的 head。
- `auto_qa_record` **没有**对应行。原因:FLY-1342 当初根本没被登记进 auto-QA(manual-spawn 被 invalid_parent 拒),AutoQaCoordinator 没有记录可翻。

**所以:这条 verdict 是可审计的留痕,但它不会自动放行任何 founder 通知。** FLY-1342 的 ship gate 事实上由 Tadashi 拿这份报告来把,和本单派工时的定位一致。别把它当成"自动门已放行"。

## 5. 证据留存

- 托管页(可复验,unguessable + noindex):见上方 URL
- 导出回执原件:`scratchpad/evidence/FLY-1342-founder-decisions.md`
- 突变对照产物:`scratchpad/mut/`
