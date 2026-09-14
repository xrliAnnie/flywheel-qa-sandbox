# FLY-2505 设计期验证 — 调研
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505/病根-重启后-reown-的-recovery-owner-在-commit-前失败且不留原因resulttext-空-只剩通用文案两次即)
日期: 2026-09-10
基于: plan.md

## 实际完成

基线源码 d964e9fca，全部改动局限本 issue 文档目录。依赖按锁文件安装，pnpm-lock.yaml 未改。未运行 live DB/slot/服务操作。

| 验证 | 结果 |
|---|---|
| teamlead：StateStore.codex-recovery、execution-mutation-lease、codex-session-reown、codex-recovery-context、run-infra-codex-recovery | 5 files / 66 tests PASS |
| claude-runner：CodexTmuxAdapter、codex-daemon-adapter-helpers、codex-daemon-runtime、codex-daemon-goal-runtime | 4 files / 246 tests PASS |
| Node：qa-fly-2456-observe、report-pair、verdict | 77 tests PASS |
| HTML DOM 检查（临时 happy-dom 脚本） | 7/7 section 有评论；pathname storage、聚合、长文分段 marker/≤1800 code points、恶意文字不解释为 markup、clipboard 正常/拒绝/缺失降级、storage 拒绝下可使用均 PASS |
| HTML 静态约束 | 单一 script、精确 nonce placeholder、无 inline handlers、无自设 CSP、无外部脚本/样式 PASS |
| 工作树范围 | 本 issue doc 之外无 tracked changes |

第一次 DOM 校验发现 Python 模板把 JavaScript 字符串中的换行转义展开，导致脚本语法错误；已改 raw string 重新生成，复测全部通过。这是设计交付页面修正，不是引擎实现。

## Mermaid 本地渲染

两张源图 flow.mmd / model.mmd 各执行一次，并按指定标准 flags 重试一次：
mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2505-d1|FLY-2505-d2。

四次均被本机沙箱拒绝 Chromium bootstrap：
MachPortRendezvousServer ... Permission denied (1100)。

按本节点明确允许的失败交付合同，保留 Mermaid 源文件，HTML 显示 DIAGRAM PENDING LOCAL RENDER。未生成 SVG、未声称图已渲染、未用 CSS 盒箭头或远程服务替代。本地实际浏览器视觉检查同样未完成；DOM 测试不能替代视觉证据。

## 安装与构建限制

初始 node_modules 不存在；offline install 缺少缓存 tarball，正常 pnpm install --frozen-lockfile 成功。
最初借用旧文档的“构建除 teamlead 外全部包”命令在无关 voice-codex 包失败，因为其引用未构建的 teamlead dist；有关依赖包已构建，以上 389 项定向测试通过。计划已将依赖构建命令修正为仅构建 teamlead 的传递依赖，避免构建下游 voice 包。

## 未被证明的内容

上述是既有行为的基线测试，尚未实现计划新增的诊断/结算/deferral，也没有新恢复行为或真实同体恢复的 PASS。正式 review 回执和 hosted HTML 校验在完成后追加。

## R1 修订验证

修正后的 teamlead 传递依赖构建命令已实际完成，exit 0。R1 后重新生成页面并运行同一 DOM 验证，全部通过；页面明确“3次与15分钟先到即止，可能只获得较少尝试”。浏览器连接工具 list_pages 在300秒后返回调用超时；未把该超时当成浏览器已经终止，也未重启浏览器。视觉检查仍未获证。

## 最终设计评审

R2 有效 reviewVerdict=APPROVED，request c242aa9a-3dc8-457d-8653-35ce61035056，reviewed head 9e184e8fd。三项 advisory 仅记录在 plan/review，未修复；批准后未改变 HTML 内容。

## 托管页面验证

- URL: https://fw-reports-a53de2.vercel.app/r/c60fb77b66c917f6d68e0aa562fb3a9a/
- reportId: c60fb77b66c917f6d68e0aa562fb3a9a
- publishOnly=true；messageId=null；未向频道发消息。
- curl 实测 HTTP 200；nonce placeholder 已替换，脚本 nonce 与 CSP 相符；仅一个 inline script、七处 data-comment、location.pathname 隔离键和规定汇总 marker 均存在；无外部代码资源。
- 托管 HTML SHA-256: bc84cff42f83b6373c1c7e13f53609342da4f7be35d8d5ed7e0e718cb7a108e5。
- 交互行为由前述 DOM 测试验证；托管校验覆盖 HTTP/内容/CSP 配对，不将其声称为实际浏览器视觉验收。
- 本机 Mermaid 渲染受限的两处明确占位仍保留，源图随 branch 提交。
