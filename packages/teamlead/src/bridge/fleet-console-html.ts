/**
 * FLY-247 inc2a WI-4: the Fleet console page (pixel baseline = mockup v3, which
 * Annie lgtm'd). Card-per-Lead (Apple-card / html-report-style palette), chip
 * dropdowns for backend + level, draft state, stage→confirm→apply, and SSE
 * 4-step progress. Unlike the mockup (a pure front-end simulation), this is wired
 * to the real backend:
 *
 *   GET  /api/fleet/snapshot   → render model (server computes capabilities)
 *   POST /api/fleet/stage      → canonical request + confirmToken
 *   POST /api/fleet/apply      → launching journal + detached engine
 *   GET  /api/fleet/progress   → SSE progress (durable journals)
 *
 * The UI hardcodes NO eligibility rules — backend chips are disabled with the
 * server-supplied `disabledReason` (FLY-264 / FLY-245); the level chip switches
 * only within the current backend's `tierOptions` (Codex = read-only).
 *
 * The embedded <script> uses string concatenation + dataset event-delegation
 * (no inline handlers, no nested quotes / template literals / `${}`) so it nests
 * cleanly inside this TS template literal.
 */
export function getFleetConsoleHtml(): string {
	return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flywheel Fleet</title>
<style>
  :root{--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;
    --purple:#af52de;--gray:#86868b;--navy:#1a365d;}
  *{box-sizing:border-box;margin:0;}
  body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;
    max-width:960px;margin:0 auto;padding:28px 20px 80px;}
  h1{font-size:1.5em;letter-spacing:-0.02em;}
  .sub{color:var(--gray);font-size:.9em;margin-top:4px;}
  .hint{background:#eaf3ff;color:#1d4f8f;border-radius:10px;padding:10px 14px;
    font-size:.85em;margin:16px 0 4px;line-height:1.5;}
  .err{background:#ffecec;color:#b00020;border-radius:10px;padding:10px 14px;
    font-size:.85em;margin:12px 0;display:none;}
  .applybar{position:sticky;top:10px;z-index:50;background:var(--navy);color:#fff;
    border-radius:14px;padding:13px 18px;display:none;align-items:center;gap:14px;
    box-shadow:0 6px 24px rgba(26,54,93,.35);margin:16px 0;}
  .applybar.show{display:flex;}
  .applybar .txt{font-size:.92em;}
  .applybar .cta{margin-left:auto;background:#fff;color:var(--navy);border:none;
    border-radius:9px;padding:9px 18px;font-weight:700;font-size:.9em;cursor:pointer;
    font-family:inherit;flex:none;}
  .applybar .discard{background:transparent;color:#bcd;border:none;font-size:.85em;
    cursor:pointer;font-family:inherit;flex:none;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px;margin-top:14px;}
  .card{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06);
    transition:outline-color .15s;outline:2px solid transparent;outline-offset:-2px;}
  .card.draft{outline-color:var(--blue);}
  .top{display:flex;align-items:center;gap:9px;}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--green);flex:none;}
  .dot.off{background:var(--red);}
  .dot.deg{background:var(--amber);}
  .dot.unk{background:var(--gray);}
  .name{font-size:1.12em;font-weight:700;}
  .proj{color:var(--gray);font-size:.83em;margin-left:auto;}
  .specs{display:flex;gap:8px;margin-top:13px;}
  .chip{flex:1;border-radius:10px;padding:8px 12px;background:#f7f7f9;cursor:pointer;
    position:relative;border:1.5px solid transparent;user-select:none;
    transition:border-color .12s,background .12s;}
  .chip:hover{border-color:#c9c9d2;}
  .chip.ro{cursor:default;}
  .chip.ro:hover{border-color:transparent;}
  .chip.changed{background:#eaf3ff;border-color:var(--blue);}
  .chip .lbl{font-size:.68em;color:var(--gray);text-transform:uppercase;letter-spacing:.05em;
    display:flex;align-items:center;}
  .chip .lbl .caret{margin-left:auto;color:var(--gray);font-size:1.1em;}
  .chip .val{font-weight:650;margin-top:1px;font-size:.95em;}
  .chip .val .old{color:var(--gray);text-decoration:line-through;font-weight:400;
    font-size:.84em;margin-right:5px;}
  .chip.changed .val .new{color:var(--blue);}
  .val-claude{color:var(--navy);}
  .val-codex{color:var(--purple);}
  .menu{position:absolute;top:calc(100% + 6px);left:0;min-width:100%;z-index:40;
    background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.16);padding:6px;display:none;}
  .menu.open{display:block;}
  .opt{padding:9px 12px;border-radius:8px;font-size:.9em;font-weight:600;cursor:pointer;
    display:flex;align-items:center;gap:8px;white-space:nowrap;}
  .opt:hover{background:#f2f2f7;}
  .opt.disabled{cursor:default;color:var(--gray);}
  .opt.disabled:hover{background:transparent;}
  .opt .check{width:16px;color:var(--blue);flex:none;}
  .opt .mini{font-size:.7em;font-weight:600;color:var(--amber);background:#fff3e0;
    padding:1px 7px;border-radius:20px;margin-left:auto;}
  .tag{font-size:.68em;padding:2px 8px;border-radius:20px;font-weight:600;}
  .tag.pend{background:#eaf3ff;color:var(--blue);}
  .tag.ext{background:#f2f2f7;color:var(--gray);}
  .cardfoot{margin-top:10px;min-height:18px;display:flex;gap:6px;}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:90;display:none;
    align-items:flex-start;justify-content:center;padding:60px 20px;}
  .overlay.open{display:flex;}
  .modal{background:#fff;border-radius:16px;padding:24px;max-width:480px;width:100%;
    box-shadow:0 10px 50px rgba(0,0,0,.25);}
  .modal h3{font-size:1.1em;}
  .change-list{margin:16px 0;}
  .change,.prog{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;
    background:#f7f7f9;margin-bottom:8px;font-size:.9em;}
  .change .who,.prog .who{font-weight:700;min-width:56px;}
  .change .what{color:var(--gray);font-size:.85em;min-width:34px;}
  .change .from{color:var(--gray);text-decoration:line-through;}
  .change .arr{color:var(--gray);}
  .change .to{font-weight:650;color:var(--blue);}
  .prog .st{margin-left:auto;font-size:.83em;font-weight:600;}
  .st-done{color:var(--green);}
  .st-doing{color:var(--blue);animation:pulse 1.1s infinite;}
  .st-wait{color:var(--gray);}
  .st-warn{color:var(--amber);}
  .st-error{color:var(--red);}
  @keyframes pulse{50%{opacity:.4;}}
  .warn{background:#fff8e6;border-radius:10px;padding:12px 14px;font-size:.85em;
    color:#6b5b1e;line-height:1.55;}
  .runbook{background:#ffecec;border-radius:10px;padding:12px 14px;font-size:.85em;
    color:#b00020;line-height:1.55;margin-top:8px;}
  .btns{display:flex;gap:10px;margin-top:18px;}
  .btn{flex:1;border:none;border-radius:10px;padding:12px;font-size:.95em;font-weight:600;
    cursor:pointer;font-family:inherit;}
  .btn.cancel{background:#f2f2f7;}
  .btn.go{background:var(--blue);color:#fff;}
</style>
</head>
<body>
<h1>Flywheel Fleet</h1>
<div class="sub">本机 · Lead 级别切换(Runner 将继承所属 Lead 的后端与级别 — 接线 = 下一期)</div>
<div class="hint">改任意卡片的「级别」chip → 看草稿态 → 顶部「应用 N 项更改」→ 确认框 → 逐项真生效(每个 Lead 重启约 15 秒,失败自动回滚该项)。后端切换本期置灰(见 chip 提示)。</div>
<div class="err" id="err"></div>
<div class="applybar" id="applybar">
  <span class="txt" id="applytxt">⏳ 0 项更改待应用</span>
  <button class="discard" id="discardBtn">放弃全部</button>
  <button class="cta" id="applyBtn">应用更改</button>
</div>
<div class="grid" id="grid"></div>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
(function(){
  var BACKEND_LABEL = { "claude-code":"Claude Code", "codex-app-server":"Codex" };
  var snapshot = null, original = {}, draft = {}, es = null;

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){
    return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":"&quot;"; }); }
  function el(id){ return document.getElementById(id); }
  function showError(msg){ var e=el("err"); e.textContent="⚠️ "+msg; e.style.display="block"; }
  function clearError(){ el("err").style.display="none"; }

  function leadByKey(key){
    for (var i=0;i<snapshot.leads.length;i++){ if(snapshot.leads[i].key===key) return snapshot.leads[i]; }
    return null;
  }
  function tierLabel(lead, id){
    for (var i=0;i<lead.tierOptions.length;i++){ if(lead.tierOptions[i].id===id) return lead.tierOptions[i].label; }
    return id===null ? "Account 默认" : id;
  }
  function isReadonlyTier(lead){
    if (lead.tierOptions.length <= 1) return true;
    for (var i=0;i<lead.tierOptions.length;i++){ if(!lead.tierOptions[i].readonly) return false; }
    return true;
  }
  function changesList(){
    var out=[];
    for (var i=0;i<snapshot.leads.length;i++){
      var l=snapshot.leads[i];
      if (draft[l.key] !== original[l.key]) out.push({ lead:l, fromId:original[l.key], toId:draft[l.key] });
    }
    return out;
  }
  function dotClass(online){
    return online==="online" ? "dot" : online==="offline" ? "dot off"
      : online==="degraded" ? "dot deg" : "dot unk";
  }

  function backendChipHtml(lead){
    var label = BACKEND_LABEL[lead.currentBackend] || lead.currentBackend;
    var cls = lead.currentBackend==="codex-app-server" ? "val-codex" : "val-claude";
    return '<div class="chip" data-key="'+esc(lead.key)+'" data-kind="backend">'
      + '<div class="lbl">后端<span class="caret">⌄</span></div>'
      + '<div class="val '+cls+'">'+esc(label)+'</div>'
      + '<div class="menu" id="menu-'+esc(lead.key)+'-backend"></div></div>';
  }
  function tierChipHtml(lead){
    var changed = draft[lead.key] !== original[lead.key];
    var ro = isReadonlyTier(lead);
    var oldLbl = tierLabel(lead, original[lead.key]);
    var newLbl = tierLabel(lead, draft[lead.key]);
    var val = changed
      ? '<span class="old">'+esc(oldLbl)+'</span><span class="new">'+esc(newLbl)+'</span>'
      : esc(newLbl);
    return '<div class="chip '+(changed?"changed":"")+(ro?" ro":"")+'" data-key="'+esc(lead.key)+'" data-kind="tier">'
      + '<div class="lbl">级别'+(ro?"":'<span class="caret">⌄</span>')+'</div>'
      + '<div class="val">'+val+'</div>'
      + '<div class="menu" id="menu-'+esc(lead.key)+'-tier"></div></div>';
  }

  function render(){
    var grid = el("grid");
    grid.innerHTML = snapshot.leads.map(function(l){
      var changed = draft[l.key] !== original[l.key];
      var foot = "";
      if (changed) foot += '<span class="tag pend">未应用</span>';
      if (l.backendSource==="explicit" || l.currentBackend==="codex-app-server") {
        if (l.backendSource!=="default" && l.currentBackend==="codex-app-server") foot += '<span class="tag ext">外部托管</span>';
      }
      return '<div class="card '+(changed?"draft":"")+'">'
        + '<div class="top"><span class="'+dotClass(l.online)+'"></span>'
        + '<span class="name">'+esc(l.displayName)+'</span>'
        + '<span class="proj">'+esc(l.projectName)+'</span></div>'
        + '<div class="specs">'+backendChipHtml(l)+tierChipHtml(l)+'</div>'
        + '<div class="cardfoot">'+foot+'</div></div>';
    }).join("");
    var n = changesList().length;
    var bar = el("applybar");
    bar.classList.toggle("show", n>0);
    el("applytxt").textContent = "⏳ "+n+" 项更改待应用";
    el("applyBtn").textContent = "应用 "+n+" 项更改";
  }

  function closeMenus(){
    var open = document.querySelectorAll(".menu.open");
    for (var i=0;i<open.length;i++) open[i].classList.remove("open");
  }
  function openMenu(key, kind){
    var lead = leadByKey(key);
    var menu = el("menu-"+key+"-"+kind);
    if (!menu) return;
    if (kind==="backend"){
      menu.innerHTML = lead.backendOptions.map(function(o){
        var isCurrent = o.backend===lead.currentBackend;
        var mini = o.disabledReason ? '<span class="mini">'+esc(o.disabledReason)+'</span>' : "";
        return '<div class="opt'+((!o.switchable&&!isCurrent)?" disabled":"")+'">'
          + '<span class="check">'+(isCurrent?"✓":"")+'</span>'
          + esc(BACKEND_LABEL[o.backend]||o.backend)+mini+'</div>';
      }).join("");
    } else {
      menu.innerHTML = lead.tierOptions.map(function(o,i){
        var selected = o.id===draft[key];
        var ro = !!o.readonly;
        return '<div class="opt'+(ro?" disabled":"")+'"'
          + (ro?"":' data-pick="'+esc(key)+'" data-idx="'+i+'"')+'>'
          + '<span class="check">'+(selected?"✓":"")+'</span>'+esc(o.label)+'</div>';
      }).join("");
    }
    menu.classList.add("open");
  }

  // Event delegation: chips toggle menus, tier options pick, modal/bar buttons act.
  document.addEventListener("click", function(ev){
    var t = ev.target;
    var pickEl = t.closest ? t.closest("[data-pick]") : null;
    if (pickEl){
      ev.stopPropagation();
      var k = pickEl.getAttribute("data-pick");
      var idx = parseInt(pickEl.getAttribute("data-idx"),10);
      var lead = leadByKey(k);
      draft[k] = lead.tierOptions[idx].id;
      closeMenus(); render();
      return;
    }
    var chip = t.closest ? t.closest(".chip") : null;
    if (chip && !chip.classList.contains("ro")){
      ev.stopPropagation();
      var key = chip.getAttribute("data-key");
      var kind = chip.getAttribute("data-kind");
      var wasOpen = el("menu-"+key+"-"+kind).classList.contains("open");
      closeMenus();
      if (!wasOpen) openMenu(key, kind);
      return;
    }
    closeMenus();
  });

  el("discardBtn").addEventListener("click", function(){
    for (var k in original) draft[k] = original[k];
    render();
  });
  el("applyBtn").addEventListener("click", openConfirm);

  function openConfirm(){
    var list = changesList();
    if (!list.length) return;
    var rows = list.map(function(c){
      return '<div class="change"><span class="who">'+esc(c.lead.displayName)+'</span>'
        + '<span class="what">级别</span>'
        + '<span class="from">'+esc(tierLabel(c.lead,c.fromId))+'</span>'
        + '<span class="arr">→</span>'
        + '<span class="to">'+esc(tierLabel(c.lead,c.toId))+'</span></div>';
    }).join("");
    el("modal").innerHTML = '<h3>应用 '+list.length+' 项更改?</h3>'
      + '<div class="change-list">'+rows+'</div>'
      + '<div class="warn">⚠️ 每个 Lead 会重启(约 15 秒,期间不响应)。逐个执行:自动备份当前配置,验证失败<b>自动回滚该项</b>,不影响已成功的。</div>'
      + '<div class="btns"><button class="btn cancel" id="cancelBtn">取消</button>'
      + '<button class="btn go" id="goBtn">确认应用</button></div>';
    el("overlay").classList.add("open");
    el("cancelBtn").addEventListener("click", closeModal);
    el("goBtn").addEventListener("click", function(){ runApply(list); });
  }
  function closeModal(){ el("overlay").classList.remove("open"); if(es){es.close();es=null;} }

  async function runApply(list){
    clearError();
    var changes = list.map(function(c){ return { key:c.lead.key, toModel:c.toId }; });
    var staged, applied;
    try {
      var r1 = await fetch("/api/fleet/stage", { method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify({changes:changes}) });
      if (!r1.ok){ var b1=await r1.json().catch(function(){return{};}); closeModal(); showError(b1.error||("stage 失败 "+r1.status)); return; }
      staged = await r1.json();
    } catch(e){ closeModal(); showError("stage 请求失败: "+e); return; }
    try {
      var r2 = await fetch("/api/fleet/apply", { method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ batch:staged.canonicalRequest, confirmToken:staged.confirmToken }) });
      if (r2.status!==202){ var b2=await r2.json().catch(function(){return{};}); closeModal(); showError(b2.error||("apply 失败 "+r2.status)); return; }
      applied = await r2.json();
    } catch(e){ closeModal(); showError("apply 请求失败: "+e); return; }
    watchProgress(applied.batchId, list);
  }

  function progRow(c, st){
    var cls = st.tone==="done"?"st-done":st.tone==="doing"?"st-doing"
      : st.tone==="warn"?"st-warn":st.tone==="error"?"st-error":"st-wait";
    return '<div class="prog"><span class="who">'+esc(c.lead.displayName)+'</span>'
      + '<span>级别 → '+esc(tierLabel(c.lead,c.toId))+'</span>'
      + '<span class="st '+cls+'">'+esc(st.label)+'</span></div>';
  }

  function watchProgress(batchId, list){
    var maxRank = {};      // key -> highest rank seen (monotonic, never regress)
    var lastView = {};     // key -> last KeyProgress
    function paint(batch){
      var keys = (batch && batch.keys) || [];
      var byKey = {};
      for (var i=0;i<keys.length;i++){
        var kp = keys[i];
        if (maxRank[kp.key]===undefined || kp.rank>=maxRank[kp.key]){ maxRank[kp.key]=kp.rank; lastView[kp.key]=kp; }
        byKey[kp.key] = lastView[kp.key] || kp;
      }
      var rows = list.map(function(c){
        var v = byKey[c.lead.key] || lastView[c.lead.key] || { label:"排队中", tone:"wait" };
        return progRow(c, v);
      }).join("");
      var head = "正在应用 "+list.length+" 项更改…";
      var foot = "";
      if (batch && batch.terminal){
        head = batch.batchTone==="done" ? "✓ "+batch.batchLabel
          : batch.batchTone==="error" ? "✗ "+batch.batchLabel : batch.batchLabel;
        var manual = false;
        for (var j=0;j<list.length;j++){ var lv=lastView[list[j].lead.key]; if(lv&&lv.manual) manual=true; }
        if (manual || batch.batchStatus==="recover-required"){
          foot += '<div class="runbook">⚠️ 有改动需人工处理(回滚冲突 / 需恢复)。请查 fleet recover runbook,勿假定已保原状。</div>';
        }
        foot += '<div class="btns"><button class="btn go" id="doneBtn">完成</button></div>';
      }
      el("modal").innerHTML = '<h3>'+esc(head)+'</h3><div class="change-list">'+rows+'</div>'+foot;
      var done = el("doneBtn");
      if (done) done.addEventListener("click", function(){ closeModal(); reload(); });
    }
    paint(null);
    if (es){ es.close(); es=null; }
    es = new EventSource("/api/fleet/progress");
    es.addEventListener("progress", function(m){
      var data; try { data = JSON.parse(m.data); } catch(e){ return; }
      var batch=null;
      for (var i=0;i<data.batches.length;i++){ if(data.batches[i].batchId===batchId){ batch=data.batches[i]; break; } }
      if (!batch) return;
      paint(batch);
      if (batch.terminal){ es.close(); es=null; }
    });
    es.onerror = function(){ /* SSE auto-reconnects; durable journal is the source of truth */ };
  }

  async function reload(){
    clearError();
    try {
      var r = await fetch("/api/fleet/snapshot");
      if (!r.ok){ showError("snapshot 失败 "+r.status); return; }
      snapshot = await r.json();
    } catch(e){ showError("snapshot 请求失败: "+e); return; }
    original = {}; draft = {};
    for (var i=0;i<snapshot.leads.length;i++){ var l=snapshot.leads[i]; original[l.key]=l.currentModelId; draft[l.key]=l.currentModelId; }
    render();
  }

  reload();
})();
</script>
</body>
</html>`;
}
