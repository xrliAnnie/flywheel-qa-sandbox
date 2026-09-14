"""Build the self-contained founder design page. Mermaid SVGs are local inputs."""
from pathlib import Path
from html import escape

root = Path(__file__).resolve().parent

def para(text):
    return "<p>" + escape(text) + "</p>"

def diagram(name, description):
    svg = root / (name + ".svg")
    if svg.exists():
        text = svg.read_text()
        text = text[text.index("<svg"):]
        return '<div class="diagram" role="img" aria-label="' + escape(description, quote=True) + '">' + text + "</div>"
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong>' + para("本机图形渲染进程被系统权限拒绝；已按标准参数重试。Mermaid 源图已随设计提交，当前不展示伪造流程图。") + "</div>"

def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>' + "".join("<th>"+escape(x)+"</th>" for x in headers) + "</tr></thead><tbody>" + "".join("<tr>"+"".join("<td>"+escape(x)+"</td>" for x in row)+"</tr>" for row in rows)+"</tbody></table></div>"

sections = [
("flow", "01 · 失败后，先留原因，再决定重试", para("恢复负责人，是重启后接手原任务的执行器。提交接管，是系统确认它已经接手的那一刻。每次失败先记下发生步骤与原因，再决定是否扣除失败额度。") + diagram("flow", "恢复、分类失败与有限重试流程") + para("接管成功后继续原任务和原线程。准备错误重试期间，通用僵尸检测会得到有限保护；僵尸检测是系统判断执行器是否已经停止工作的检查。")),
("model", "02 · 一件原任务，两种计数", para("恢复轮次，是连续认回原任务的一段过程。一次启动有自己的唯一编号；错误额度则按原因结算，两者分开记录。这样退回额度后，下一次启动仍是全新的尝试。") + diagram("model", "原任务、恢复轮次、启动编号与失败证据") + table(["记录", "用途"], [["原任务与原线程编号", "不因为一次准备失败而换身份"], ["每次启动编号", "只增不减，不复用；避免把新尝试误认成旧尝试"], ["普通失败额度", "最多两次；明确准备错误可退回暂占额度"], ["准备失败次数与截止时间", "最多三次失败，第一条起十五分钟；重启不清零"], ["最后失败证据", "错误类别、步骤、清理结果、扣数决定与证据编号"]])),
("policy", "03 · 哪些错误值得再等一次", table(["观察到的原因", "处理"], [["刚启动时，本地连接尚未准备好，且本轮进程已清理", "不扣普通失败额度；准备失败单独计数"], ["程序不存在、权限拒绝、启动资料不一致", "留下具体原因，照常扣数"], ["没有返回原因，或无法确认进程已清理", "标明缺失证据，照常扣数"], ["准备失败达到三次，或等待超过十五分钟", "明确失败，向 Lead 告警并带最后原因"]]) + para("三次包括第一次失败，最多再启动两次。十五分钟是固定窗口，先到任一上限就收口；维护繁忙或停机可能让实际尝试少于三次。维护服务在下一轮检查时处理。Lead 是接收结果并协调后续工作的负责人。Lead 已确认采用有界失败收口，不新增人工停驻状态。")),
("tradeoffs", "04 · 为什么这样取舍", table(["选择", "理由"], [["错误类别由代码产生点确定", "避免把错误文字里出现“连接”或“超时”误当成可免费重试"], ["失败记录与扣退额度一起保存", "突然重启也不会出现已经扣数却没有原因的半份记录"], ["保留启动资料与权限校验", "已有证据不足以支持放宽这些保护"], ["拒绝只改提示文字、无限重试", "前者仍会误耗预算，后者会永久困住任务"]])),
("evidence", "05 · 已知事实与未完成验收", para("已经确认：适配器是负责启动执行器并收集结果的代码。它算出了错误原因，却只写日志，没有完整带回调用者。演练中修后的具体底层日志已丢失，因此不能断言修后仍是“启动资料不匹配”。") + para("这个页面交付的是工程设计。后续必须在隔离演练环境证明：准备条件恢复后，同一原任务、同一线程重新接管成功；跨重启不延长重试窗口；永久错误和准备超限都留下可定位证据。日志变清晰本身不代表恢复成功。")),
("boundary", "06 · 这次设计的边界", para("覆盖错误回传、原子记账、凭据去重编号、有限的通用判死保护与演练证据读取。原子记账，指失败说明和扣退额度必须一起保存，不能只成功一半。凭据，是执行器向系统证明权限的临时钥匙。") + para("人工停止、完成回执、确认失效的旧进程仍按各自规则处理；不会靠刷新心跳伪装正常。历史失败任务不会自动复活。若新证据证明另一个启动问题，还需要记录具体根因并增量评审修复。")),
]

def comment(key, title):
    return '<label class="comment-label" for="comment-' + key + '">这节的意见</label><textarea id="comment-' + key + '" data-comment="' + key + '" data-title="' + escape(title, quote=True) + '" placeholder="在这里写意见，自动保存在当前浏览器" rows="3"></textarea>'

cards = "".join('<section class="card" aria-labelledby="title-' + key + '"><h2 id="title-' + key + '">' + escape(title) + "</h2>" + body + comment(key, title) + "</section>" for key,title,body in sections)
page = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2505 · 让恢复失败说清原因</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.7 -apple-system,system-ui,sans-serif}main{max-width:960px;margin:auto;padding:36px 20px 60px}.eyebrow{color:#007aff;font-weight:650;letter-spacing:.08em}h1{font-size:clamp(30px,5vw,46px);line-height:1.2;letter-spacing:-.03em;margin:12px 0 20px}h2{font-size:23px;line-height:1.4;margin:0 0 18px}p{margin:12px 0}.intro{font-size:20px;max-width:740px}.meta{font-size:14px;color:#68686d}.card{background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #007aff;padding:28px;margin:24px 0}.pending{background:#fff8ec;border:1px solid #f2d7aa;border-radius:10px;padding:22px;color:#775000}.pending strong{font-size:15px}.pending p{font-size:14px}.diagram{overflow:auto}.diagram svg{max-width:100%;height:auto}.comment-label{display:block;margin:24px 0 7px;font-size:14px;font-weight:650;color:#68686d}textarea{display:block;width:100%;resize:vertical;border:1px solid #d2d2d7;border-radius:9px;padding:12px;font:inherit;background:#fbfbfd;color:#1d1d1f}textarea:focus{outline:3px solid #b6d8ff;border-color:#007aff}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px;text-align:left}th{background:#f5f5f7;color:#68686d}th,td{padding:12px;border-bottom:1px solid #e7e7eb;vertical-align:top}th:first-child,td:first-child{width:38%}button{border:0;border-radius:9px;background:#007aff;color:white;font:inherit;padding:10px 18px;cursor:pointer;margin:8px 8px 8px 0}button:focus{outline:3px solid #a4cdff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 -apple-system,system-ui,sans-serif;background:#f5f5f7;padding:16px;border-radius:9px}.notice{color:#68686d;font-size:14px}#copy-status{min-height:1.7em}@media(max-width:600px){main{padding:24px 12px 36px}.card{padding:20px 16px}th,td{padding:9px;font-size:14px}h2{font-size:21px}}
</style></head><body><main><header><div class="eyebrow">FLY-2505 · 工程设计</div><h1>让恢复失败说清原因</h1><p class="intro">每次认回失败都留下可定位的原因，让明确的启动准备错误获得有限重试机会。</p><p class="meta">2026-09-10 · 设计方案，实施与真机验收待后续节点完成</p></header>
''' + cards + '''<section class="card" aria-labelledby="summary-title"><h2 id="summary-title">07 · 页面意见汇总</h2><p class="notice">意见只保存在当前浏览器。复制后发回讨论串即可；这个汇总标记表示修改意见，不表示批准。长意见会分段，每段均带任务标记。</p>
''' + comment("summary-note", "07 · 页面意见汇总") + r'''<div id="comment-summary" aria-live="polite"></div><button id="copy-all" type="button">复制全部意见</button><p id="copy-status" class="notice" role="status"></p></section></main>
<script nonce="__CSP_NONCE__">
(() => {
  "use strict";
  const marker = "【页面意见汇总】FLY-2505";
  const prefix = "flywheel-comments:" + location.pathname + ":FLY-2505:";
  const inputs = Array.from(document.querySelectorAll("textarea[data-comment]"));
  const container = document.getElementById("comment-summary");
  const status = document.getElementById("copy-status");
  let chunks = [];
  async function copy(text) {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      status.textContent = "已复制，可粘贴到讨论串。";
      return;
    } catch (_) {
      const temp = document.createElement("textarea");
      temp.value = text;
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.focus(); temp.select();
      try {
        if (!document.execCommand("copy")) throw new Error("copy refused");
        status.textContent = "已复制，可粘贴到讨论串。";
      } catch (_) { status.textContent = "自动复制未成功，请选择上方文字手动复制。"; }
      finally { temp.remove(); }
    }
  }
  function refresh() {
    const entries = inputs.filter(el => el.value.trim()).map(el => "【" + el.dataset.title + "】\n" + el.value.trim());
    const body = entries.join("\n\n");
    const points = Array.from(body);
    const capacity = 1800 - Array.from(marker).length - 1;
    chunks = [];
    for (let offset = 0; offset < points.length; offset += capacity) chunks.push(marker + "\n" + points.slice(offset, offset + capacity).join(""));
    container.replaceChildren();
    if (!chunks.length) {
      const p = document.createElement("p"); p.className = "notice"; p.textContent = "还没有意见。"; container.appendChild(p); return;
    }
    chunks.forEach((text, index) => {
      const pre = document.createElement("pre"); pre.textContent = text; container.appendChild(pre);
      const button = document.createElement("button"); button.type = "button"; button.textContent = "复制第 " + (index + 1) + " 段";
      button.addEventListener("click", () => { void copy(text); }); container.appendChild(button);
    });
  }
  inputs.forEach(el => {
    try { el.value = localStorage.getItem(prefix + el.dataset.comment) || ""; } catch (_) {}
    el.addEventListener("input", () => {
      try { localStorage.setItem(prefix + el.dataset.comment, el.value); }
      catch (_) { status.textContent = "浏览器未允许保存，当前意见仍可复制。"; }
      refresh();
    });
  });
  document.getElementById("copy-all").addEventListener("click", () => {
    if (chunks.length) void copy(chunks.join("\n\n"));
    else status.textContent = "请先填写意见。";
  });
  refresh();
})();
</script></body></html>
'''
(root / "design.html").write_text(page)
print("design.html bytes:", len(page.encode()))
