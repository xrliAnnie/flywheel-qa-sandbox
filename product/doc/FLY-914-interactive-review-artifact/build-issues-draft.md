# FLY-914 Build issues 草案(草拟,未 file)— 交 Tadashi 队列

Issue: FLY-914 (https://linear.app/geoforge3d/issue/FLY-914/interactive-html-review-artifact-google-doc-style-inline-comments)
日期: 2026-07-06
基于: prd.md

> 状态:**已 file = FLY-930/931/932/933**(Annie green-light 2026-07-06)。
>
> **⚠️ 更新(2026-07-06,Annie 又简化 round-trip)= 剪贴板复制,不做 serverless relay。** 影响:
> - **#2(FLY-931 relay)→ 降级 backlog**(v1 不做;自动回流以后再做)。
> - **#3(FLY-932)回流从『全部发送→relay』改为『复制全部批注(段落原文全文+评论 配对到剪贴板)』**。
> - **#1(FLY-930)v1 CSP 无需 connect-src**(复制不 POST);只需 nonce script-src。
> - 已 file 的 Linear issue **待 Annie 试顺 demo 后再调整**(Honey 指示,避免反复)。下面 #1–#4 原文保留作 relay 版参考,以本 banner 为准。

---

## #1 [infra] 交互 artifact 托管:Vercel 放开 CSP(nonce script-src)

**为什么**:现 report 管线在页面注入 `default-src 'none'`(`packages/teamlead/src/bridge/report-registry.ts`),无 `script-src` → 浏览器拒执行内联 JS → 交互 artifact 死页(FLY-915 + 本 issue 实证 = Annie「点了没反应/导出拿不到」真根因)。

**做法(Cass 关卡①已定原则,code 结构归 Tadashi)**:
- **静态 report 那条严格 CSP 一个字不动**;交互 artifact 走一条**显式 opt-in 的 publish 模式/flag**(绝不让宽 CSP 泄漏到普通报告)。
- 该模式注入的 CSP(**v1 = 剪贴板复制、不 POST → 无需 `connect-src`**):
```
default-src 'none'; script-src 'nonce-<RANDOM>'; style-src 'unsafe-inline'; img-src data:;
```
- (`connect-src <RELAY_ORIGIN>` 仅**自动回流 backlog**(#2/FLY-931)才加;v1 不用。)
- 页内 `<script>` 打匹配 `nonce="<RANDOM>"`。
- **「新 flag」vs「`report-registry.ts` 加可选 nonce」= code 结构选择,Tadashi 定**(他 owns report-registry + 安全 posture);build#1 只带约束「静态严格不变 + 交互走显式 nonce 模式」。
**安全硬验收(Cass 签)**:
- `nonce` = 服务端发布时 **crypto 随机、每页一个、绝不复用**;`script` **绝不用 `unsafe-inline`**(只 nonce 白名单)。
- (**仅自动回流 backlog / FLY-931 适用**,v1 无 connect-src)`connect-src` **写死那个具体 relay origin、禁用 `*`**(页面只能 POST 到已知 relay,不能往别处 exfiltrate)。
- 页内不嵌任何 secret(PRD §6:token/密码/PII 一律不进页)。
**关卡①状态**:✅ Cass 已给全架构方向(见上);code-level 具体进本 issue 让 Tadashi 定,不再 round-trip Cass。
**验收**:用此模式发布一个交互 artifact,其 JS 在托管 URL 上真跑(点选/留言 handler 生效)+ 无 CSP violation;普通静态报告 CSP 字节不变(reverse-compat sentinel)。

## #2 [infra] 自动回流 relay(独立 standalone serverless)— **backlog / FLY-931,v1 不做**

> **v1 不做**:Annie 拍板改简 = 剪贴板复制(见 #3),不建 serverless relay。本节保留作**自动回流(FLY-931 backlog)**的参考设计,以后要「一键自动发回 Discord」再做。

**为什么**:静态页要把批注**自动**送回,需公网入口;Bridge 是控制面(localhost by design),**不开公网 ingress**。

**做什么**:一个**独立 Vercel serverless function**(与 Bridge 隔离),收:
```json
POST { "issue":"FLY-XX", "artifact":"...", "thread_id":"<discord channel/thread>",
       "submit_token":"<per-artifact>", "annotations":[ {"anchor":"...","comment":"..."} ] }
```
→ 服务端用 Discord webhook(secret 在 function env)把结构化批注 **POST 回该 artifact 的 Discord thread**(格式:逐条 锚点→批注,人可读)。
- artifact 页在 publish 时被注入 `thread_id` + `submit_token`。
- 可选:relay 同时写 CommDB / 触发 `runner_question`(= R-C,仅当 runner 需程序化消费时;先不做)。
**安全(Cass/Tadashi 签)= 签名回传防伪(Annie 定)**:relay **HTTPS-only** + `submit_token` / HMAC 签名校验(防伪造批注)+ **rate-limit** + **origin allowlist**(只接受我们 artifact 的域)+ payload size cap + 注入过滤。payload 只含锚点文本+批注文本(不含 secret)。
**验收**:hosted artifact 的『全部发送』把结构化消息投进正确 thread;错 origin / 错 token / 超限 全拒。

## #3 [skill] 交互审阅件渲染 + A 批注 UI

**输入**:任意交付物内容(markdown / HTML 段落)+ issue/thread 元数据。
**做什么**:
- 渲染成 **Apple 浅色段落块**,每段一个稳定 id(= A 的锚点;无需词级 token 化)。
- A 批注 UI(**以已 self-QA 的 `mockups/authoring-A-interactive.html` 为 UX 基准**):点段落→高亮+底部评论框(保存后自动收起);批注托盘(编辑/删除);段落角标计数;**『复制全部批注』→ 每条=段落原文全文+评论 配对复制到剪贴板 + 复制成功反馈**(v1 = 纯浏览器 `navigator.clipboard`,不 POST;自动 POST relay = #2/FLY-931 backlog)。
- 复用 `packages/teamlead/src/bridge/xhs-review-*.ts` 的批注 UI 结构。
- 产物 = 自包含 HTML(内联 JS 带 #1 的 nonce 占位),经 #1 托管发布。
**验收**:真机端到端 —— 点段→评论框→多条→编辑/删除→**复制全部批注(段落原文全文+评论 配对到剪贴板,非整页)**,Annie 粘给发起方即有完整上下文。

## #4 [skill] 全局调用入口(一条命令)

**做什么**:一个全局 Flywheel skill,让任何 Lead/runner 一条命令:
```
<cmd> --content <file> --issue <FLY-XX> --thread <channelId> [--title ...]
```
→ 渲染(#3)→ 发布到放开 CSP 的 Vercel(#1)→ 一条 Discord 消息(标题+链接)投进**对应 issue thread**(不发 core/general;复用 publish-report 的 Discord-post + 截图能力)。
**验收**:任一 Lead/runner 一条命令 → Annie 在对的 thread 收到能真点的可批注链接。

## Backlog(不进 v1 — Annie 拍板 v1 只做段落级)
- **finer granularity(句级 / 跨段 / 划选)**:给『段里某一句』或『跨两段』留 comment(原型 `authoring-v2-interactive.html` 点句+两手柄代码可复用)。
- 多轮:段落 id 稳定映射 + 旧批注迁移 + open/addressed 状态。

## 边界
- PM 验收 = 未来 FLY-830,不在本批。
- 本 PRD/原型不含 production code;上述 #1–#4 = eng 实现(Tadashi 队列)。
