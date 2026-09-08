# FLY-2351 快照与磁盘护栏 — 调研
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: plan.md

## 设计验证记录

这份记录验证设计假设和交付页面，不表示生产功能已实现或 QA 通过。

### SQLite 小型探针

使用主仓已有 better-sqlite3，创建合成小库，启用 WAL，插入一行，另开 readonly/fileMustExist 连接并 BEGIN 后读取 page_count/page_size；原写连接再插一行；在只读事务连接上完成 backup。

结果：sourceRows=2，backupRows=1，reservedBytes=16384，actualBytes=16384，quickCheck=ok。源在备份读取事务之后的新写入没有扩大输出。全部探针文件在 finally 回收；未读取或复制生产数据库。本探针只支持固定读取事务可行性，完整容量/并发/ENOSPC 用例仍由实现和 QA 完成。

### 评论交互验证

命令（复用主仓已有 happy-dom，未安装新依赖）：

```sh
FLY2351_DOM_MODULE=/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/happy-dom@20.10.6/node_modules/happy-dom/lib/index.js node engineering/doc/FLY-2351-snapshot-disk-guard/verify-html.mjs
```

通过项：9 个 section 都有评论输入；input 保存与恢复；location.pathname 隔离；注入文本只能显示为文本；长评论分成 3 段且各段≤1800 Unicode 字符/重复正确首行标记；复制全部/逐段；正常 clipboard、promise rejection、API 缺失时 execCommand fallback；复制失败给手工路径；localStorage 拒绝后页面仍工作；唯一 nonced script、无 inline handler、无外部资源引用、无作者 CSP。

### 本地图形与浏览器限制

`flow.mmd`、`ownership.mmd` 都使用本机 mmdc；每张图初次和一次标准参数重试均失败。标准命令形状为 `mmdc -i <source> -o <output.svg> -w 1000 -b white --svgId FLY-2351-d1|d2`。

相同根因：Chromium `bootstrap_check_in ... Permission denied (1100)`。遵循任务 fallback：HTML 显示两个 `DIAGRAM PENDING LOCAL RENDER`，保留 Mermaid 源文件；未用远程图形服务，未伪造图形。没有生成 SVG，不能声称已完成 SVG/像素视觉验收。

浏览器工具 new_page 也返回 `MCP tool call requires approval, but approval policy is never`。因此真实浏览器视觉/交互检查未执行；DOM 验证不等于真实 CSP 浏览器运行。托管后仍需检查 HTTP、nonce 替换与 CSP，记录在下方。

## 正式审查与交付

- R1 question：`08b1d848-f68f-46db-8be9-fe083986f56e`；request：`9ba71167-1600-49a8-bc88-f3676e892748`，已受理，尚待 verdict。
- Lead 问题 `ec87d39f-aa63-49cb-b098-e96790a1077b`：已确认分组、2GB managed acquisition 边界及“映射不上的库一律不删”。已在 plan/research/HTML 反映并 report-back。
- HTML 已在提交 `c8203b08e` 后使用 publish-only 发布：<https://fw-reports-a53de2.vercel.app/r/57cec9a5c6673ec3c4e1037cd170e5d6/>；reportId=`57cec9a5c6673ec3c4e1037cd170e5d6`，messageId=null（未发频道消息）。已按 DESIGN-HTML ready 向 Lead 汇报，receipt=`0677164b-dce4-4d1f-ab3d-f9b08c64c227`。
- hosted fetch 检查：HTTP 200、残余 __CSP_NONCE__=false、singleScript=true、noncePresent=true、cspPresent=true、cspAuthorizesNonce=true、diagramPlaceholders=2、sections=9。检查的是实际托管响应，不以本地文件代替。实际浏览器运行仍受上述权限限制。
- 最终正式审查结果在完成前追加。
