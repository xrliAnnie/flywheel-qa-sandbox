#!/usr/bin/env python3
# Build the founder-facing design HTML with inlined pre-rendered SVGs.
import pathlib

d = pathlib.Path(__file__).parent
svg1 = (d / "d1-use-flow.svg").read_text()
svg2 = (d / "d2-selfheal-loop.svg").read_text()

SECTIONS = [
    ("s-summary", "一句话总结"),
    ("s-story", "出了什么事"),
    ("s-flow", "核心流程:切号先问「机器现在真正是谁」"),
    ("s-loop", "自愈闭环:你手工登录后,系统自动跟上"),
    ("s-model", "数据与结构模型"),
    ("s-tradeoff", "关键取舍与被否掉的方案"),
    ("s-boundary", "诚实边界:这个设计做什么、不做什么"),
]

def comment_block(sid: str, title: str) -> str:
    return f'''
    <div class="comment-box" data-sec="{sid}" data-title="{title}">
      <label>对这一节的意见(自动保存在你本机):</label>
      <textarea rows="2" placeholder="留空表示没意见"></textarea>
    </div>'''

html = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1756 切号自愈设计</title>
<style>
  body {{ background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,sans-serif; margin:0; }}
  .wrap {{ max-width:960px; margin:0 auto; padding:24px 16px 48px; }}
  h1 {{ font-size:26px; margin:8px 0 4px; }}
  .sub {{ color:#86868b; font-size:14px; margin-bottom:20px; }}
  .card {{ background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06); padding:18px 20px; margin:14px 0; border-left:4px solid #007aff; }}
  .card.red {{ border-left-color:#ff3b30; }}
  .card.green {{ border-left-color:#34c759; }}
  .card.amber {{ border-left-color:#ff9500; }}
  .card.purple {{ border-left-color:#af52de; }}
  h2 {{ font-size:18px; margin:0 0 10px; color:#1a365d; }}
  p, li {{ font-size:14px; line-height:1.65; }}
  .term {{ color:#86868b; }}
  .diagram {{ overflow-x:auto; background:#fff; }}
  .diagram svg {{ max-width:100%; height:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:13px; }}
  th, td {{ border:1px solid #e5e5ea; padding:6px 9px; text-align:left; line-height:1.5; }}
  th {{ background:#f5f5f7; color:#1a365d; }}
  code {{ font-family:'SF Mono',monospace; font-size:12px; background:#f5f5f7; padding:1px 4px; border-radius:4px; }}
  .comment-box {{ margin-top:12px; padding-top:10px; border-top:1px dashed #e5e5ea; }}
  .comment-box label {{ font-size:12px; color:#86868b; display:block; margin-bottom:4px; }}
  .comment-box textarea {{ width:100%; box-sizing:border-box; border:1px solid #d2d2d7; border-radius:8px; padding:8px; font-size:13px; font-family:inherit; resize:vertical; }}
  #summary-card {{ border-left-color:#af52de; }}
  #summary-out {{ white-space:pre-wrap; font-size:13px; background:#f5f5f7; border-radius:8px; padding:10px; min-height:40px; }}
  .btn {{ background:#007aff; color:#fff; border:none; border-radius:8px; padding:8px 16px; font-size:14px; cursor:pointer; margin-top:10px; }}
  .btn:active {{ opacity:.7; }}
  .copy-note {{ font-size:12px; color:#86868b; margin-left:10px; }}
  .pill {{ display:inline-block; font-size:12px; padding:2px 8px; border-radius:10px; margin-right:6px; }}
  .pill.ok {{ background:#e8f8ee; color:#1d7a3e; }}
  .pill.no {{ background:#fdeceb; color:#c0332b; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>FLY-1756 · 让 Lead 永远能替你切 Claude 账号</h1>
  <div class="sub">设计方案(Codex 评审 7 轮通过)· 2026-08-21 · 分支 flywheel-FLY-1756</div>

  <div class="card green" id="s-summary">
    <h2>一句话总结</h2>
    <p>以后切号先问「这台机器<b>现在真正登录的是谁</b>」——直接拿活凭据去 Anthropic 验明正身,而不是信本地那张会写错的标记纸;你手工登录后,后台每 10-20 分钟自动把号池和台账对齐。这样「你让 Lead 切号却被告知已过期」的死循环被拆掉,你不再需要手工切号。</p>
    {comment_block("s-summary", "一句话总结")}
  </div>

  <div class="card red" id="s-story">
    <h2>出了什么事(8-13 你遇到的场景)</h2>
    <p>你刚登录了 personal,让 Lead 切到 personal。机器其实<b>已经在 personal 上</b>,但工具只看 <code>.active</code> 标记<span class="term">(一个记录「当前用哪个号」的本地小文件)</span>,标记还写着 personal1,于是工具执行了一次「真换号」——去号池<span class="term">(每个账号的凭据备份仓库)</span>拿 personal 的旧副本准备覆盖机器。旧副本已经因为你的新登录而失效,保鲜检查(正确地)拒绝了它,结果就是你看到的「switch 不了,说它过期了」。</p>
    <p><b>两个病根</b>:① 切号只认标记、不认活凭据的真实身份;② 你手工登录只更新机器钥匙串<span class="term">(macOS Keychain,系统保管密码的地方)</span>,号池不知情,池里的副本就慢慢烂掉。两个都要修,缺一个都会复发。</p>
    {comment_block("s-story", "出了什么事")}
  </div>

  <div class="card" id="s-flow">
    <h2>核心流程:切号先问「机器现在真正是谁」</h2>
    <p>下图是修好后 <code>use B</code>(切到账号 B)的判定流。关键变化:第一步永远是拿活凭据做一次 <b>identity probe</b><span class="term">(向 Anthropic 官方接口问「这把钥匙属于哪个账号」,几秒钟)</span>;问不到就明确拒绝,绝不瞎猜、绝不乱写。</p>
    <div class="diagram">{svg1}</div>
    <p>如果目标号的池副本真的失效了,系统会<b>点名告诉你「哪个号需要你重新登录一次」</b>,而不是像现在这样在你要用的那一刻才莫名其妙失败。</p>
    {comment_block("s-flow", "核心流程")}
  </div>

  <div class="card" id="s-loop">
    <h2>自愈闭环:你手工登录后,系统自动跟上</h2>
    <p>你手工登录不再产生后遗症:后台守护进程每轮对一次账<span class="term">(比对机器钥匙串和号池里 active 位的「指纹」,即内容的数字摘要,零网络开销)</span>,发现有人动过就自动把新钥匙收进正确的池位、把标记纠正过来。</p>
    <div class="diagram">{svg2}</div>
    {comment_block("s-loop", "自愈闭环")}
  </div>

  <div class="card" id="s-model">
    <h2>数据与结构模型</h2>
    <table>
      <tr><th>部件</th><th>是什么</th><th>本次怎么改</th></tr>
      <tr><td>机器钥匙串(Keychain)</td><td>机器当前真正在用的那把钥匙,唯一的「事实」</td><td>成为身份判定的唯一权威;每次写入前反复核对没人动过(防你并发登录被覆盖)</td></tr>
      <tr><td>号池(5 个账号位)</td><td>每个账号的凭据备份 + 身份锚<span class="term">(记录「这个位子属于哪个邮箱」的不可变档案)</span></td><td>只允许「验明正身的活钥匙」存进对应的位子;方向永远是 机器→池,自愈绝不反向覆盖</td></tr>
      <tr><td><code>.active</code> 标记 / 台账</td><td>「当前用哪个号」的两份记录</td><td>降级为缓存:说错了就被自动纠正,再也不能左右切号决定</td></tr>
      <tr><td>新命令 <code>reconcile</code></td><td>「只对账修复、不切号」的独立入口</td><td>后台守护进程发现漂移时调它;修复全程fail-closed<span class="term">(证据不足就拒绝动手,宁可不做也不做错)</span></td></tr>
    </table>
    {comment_block("s-model", "数据与结构模型")}
  </div>

  <div class="card amber" id="s-tradeoff">
    <h2>关键取舍与被否掉的方案</h2>
    <ul>
      <li><b>否掉:后台定期「刷新」池里的备份来保鲜。</b>评审发现:当标记集体说错话时,后台可能把「其实正在用」的钥匙拿去刷新,两边同时轮换同一把钥匙会互相作废——正是 7 月 4 日全员被登出事故的同类。改为:活跃号靠「随时收录最新钥匙」保鲜(安全),久坐号只做<b>老化提醒</b>(「X 的备份 N 天没更新了,方便时重新登录一下」),不碰任何钥匙。</li>
      <li><b>否掉:探测失败时「退回老逻辑碰运气」。</b>那条路存在拿旧副本覆盖你新登录的可能。改为:证据不可得就明确拒绝(和现状一样切不了,但不会更糟,也绝不误伤)。</li>
      <li><b>保留:真失效的号依然拒绝切入。</b>保护不削弱——变化只是「失败得明明白白 + 提前点名」,而不是当场蒙圈。</li>
      <li><b>成本:</b>每次切号多一次几秒钟的身份询问(网络);切号本来就是低频动作,值得。</li>
    </ul>
    {comment_block("s-tradeoff", "关键取舍")}
  </div>

  <div class="card purple" id="s-boundary">
    <h2>诚实边界:做什么、不做什么</h2>
    <p><span class="pill ok">做到</span>你手工登录后 ≤20 分钟系统自动对齐;Lead 代切在「机器已在目标号」时直接成功且一个字节都不写;真失效的号提前点名让你补登录。</p>
    <p><span class="pill no">做不到</span>① 已经作废的钥匙救不回来——只能你重新登录一次(系统会点名是哪个号);② 两次连续变动发生在同一个 10-20 分钟窗口内时,中间那把钥匙可能来不及收录(极小概率,后果同上:点名补登录);③ 你在系统写钥匙的同一瞬间登录,存在理论上的微小竞争窗口——系统写前会反复核对,发现有人动过就立刻停手让你优先。</p>
    <p>实施分两个 PR(先手动命令、后后台守护),每个都有完整测试与独立 QA;上线走正常 founder 审批。</p>
    {comment_block("s-boundary", "诚实边界")}
  </div>

  <div class="card" id="summary-card">
    <h2>页面意见汇总</h2>
    <p class="term">下面自动汇总你在各节留下的意见;点按钮一键复制,贴回 Discord 给我们即可。</p>
    <div id="summary-out">(还没有意见)</div>
    <button class="btn" id="copy-btn">复制全部意见</button><span class="copy-note" id="copy-note"></span>
  </div>
</div>
<script nonce="__CSP_NONCE__">
(function () {{
  var MARKER = "【页面意见汇总】FLY-1756";
  var prefix;
  try {{ prefix = "fly1756-comments:" + location.pathname + ":"; }} catch (e) {{ prefix = "fly1756-comments:"; }}
  var boxes = Array.prototype.slice.call(document.querySelectorAll(".comment-box"));

  function loadVal(sec) {{
    try {{ return localStorage.getItem(prefix + sec) || ""; }} catch (e) {{ return ""; }}
  }}
  function saveVal(sec, v) {{
    try {{ localStorage.setItem(prefix + sec, v); }} catch (e) {{ /* storage unavailable */ }}
  }}

  function collect() {{
    var parts = [];
    boxes.forEach(function (box) {{
      var ta = box.querySelector("textarea");
      var v = (ta && ta.value ? ta.value : "").trim();
      if (v) parts.push("· " + box.getAttribute("data-title") + ":" + v);
    }});
    return parts;
  }}

  function chunkText(parts) {{
    var chunks = [], cur = MARKER;
    parts.forEach(function (p) {{
      if ((cur + "\\n" + p).length > 1800) {{ chunks.push(cur); cur = MARKER + "(续)"; }}
      cur += "\\n" + p;
    }});
    chunks.push(cur);
    return chunks;
  }}

  var out = document.getElementById("summary-out");
  function refresh() {{
    var parts = collect();
    if (parts.length === 0) {{ out.textContent = "(还没有意见)"; return; }}
    out.textContent = chunkText(parts).join("\\n\\n----(分段)----\\n\\n");
  }}

  boxes.forEach(function (box) {{
    var sec = box.getAttribute("data-sec");
    var ta = box.querySelector("textarea");
    if (!ta) return;
    ta.value = loadVal(sec);
    ta.addEventListener("input", function () {{ saveVal(sec, ta.value); refresh(); }});
  }});
  refresh();

  var note = document.getElementById("copy-note");
  function fallbackCopy(text) {{
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {{ ok = document.execCommand("copy"); }} catch (e) {{ ok = false; }}
    document.body.removeChild(ta);
    note.textContent = ok ? "已复制 ✅" : "复制失败,请手动全选上面文本 ❌";
  }}
  document.getElementById("copy-btn").addEventListener("click", function () {{
    var parts = collect();
    var text = parts.length === 0 ? MARKER + "\\n(无意见)" : chunkText(parts).join("\\n\\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(text).then(
        function () {{ note.textContent = "已复制 ✅"; }},
        function () {{ fallbackCopy(text); }}
      );
    }} else {{
      fallbackCopy(text);
    }}
  }});
}})();
</script>
</body>
</html>
'''

out = d / "founder-design-FLY-1756.html"
out.write_text(html)
print("written", out, len(html), "bytes")
