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
import { APPLY_COMMAND_JS } from "./fleet-apply-command.js";

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
  .st-note{color:var(--blue);}
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
  h2.sec{font-size:1.02em;margin:26px 0 4px;letter-spacing:-0.01em;}
  .sec-note{color:var(--gray);font-weight:400;font-size:.78em;}
  .ffhint{color:var(--gray);font-size:.8em;margin:2px 0 10px;}
  .ffstatus{font-size:.8em;min-height:16px;margin:4px 0 8px;color:var(--green);}
  /* Apple cards, 4px left-border color-coding by category (html-report-style) */
  .cardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:8px;}
  .ffc{background:#fff;border-radius:12px;padding:13px 15px;box-shadow:0 1px 3px rgba(0,0,0,.06);
    border-left:4px solid var(--gray);}
  .ffc.feat{border-left-color:var(--blue);}
  .ffc.kill{border-left-color:var(--amber);}
  .ffc.gov{border-left-color:var(--purple);}
  /* FLY-709 P5 overflow fix: long keys wrap at natural points (NOT char-by-char),
     and the per-project state row wraps instead of running off the card. */
  .ffc-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;}
  .ffc-name{font-family:'SF Mono',monospace;font-size:.78em;color:var(--navy);font-weight:650;
    overflow-wrap:anywhere;word-break:normal;min-width:0;flex:1 1 auto;}
  .ffc-state{margin-left:auto;text-align:right;min-width:0;overflow-wrap:anywhere;line-height:1.8;}
  .ffc-desc{color:var(--gray);font-size:.78em;margin:6px 0 9px;line-height:1.45;}
  .ffc-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
  .ffc-btn{margin-left:auto;border:1px solid var(--blue);background:var(--blue);color:#fff;border-radius:8px;
    padding:4px 12px;font-size:.78em;font-weight:600;cursor:pointer;font-family:inherit;}
  .ffc-btn:disabled{opacity:.5;cursor:default;}
  .bdg{display:inline-block;padding:1px 8px;border-radius:20px;font-size:.7em;font-weight:600;white-space:nowrap;}
  .bdg.on{background:#e3f7ea;color:#248a3d;}
  .bdg.off{background:#f0f0f2;color:var(--gray);}
  .bdg.dim{background:#f0f0f2;color:var(--gray);}
  .bdg.err{background:#ffe5e3;color:#d70015;}
  .bdg.val{background:#e8f0fe;color:var(--navy);font-family:'SF Mono',monospace;}
  .bdg.cfeat{background:#e8f0fe;color:var(--blue);}
  .bdg.ckill{background:#fff3e0;color:#c66a00;}
  .bdg.cgov{background:#f3e8fe;color:#8944ab;}
  .bdg.eff{background:#f5f5f7;color:#48484a;}
  /* runner-default cards */
  .rdc{background:#fff;border-radius:12px;padding:13px 15px;box-shadow:0 1px 3px rgba(0,0,0,.06);
    border-left:4px solid var(--green);}
  .rdc-proj{font-weight:700;font-size:.98em;}
  .rdc-row{display:flex;gap:6px;margin-top:8px;font-size:.8em;align-items:center;}
  .rdc-k{color:var(--gray);min-width:52px;}
  .rdc-model{font-family:'SF Mono',monospace;color:var(--navy);}
  .rdc-dim{color:var(--gray);}
  .rdc-err{color:var(--red);font-size:.8em;margin-top:8px;}
  .rdsel{border:1px solid #d5d5da;border-radius:8px;background:#fff;color:#1d1d1f;
    font-family:inherit;font-size:.95em;padding:3px 6px;max-width:210px;}
  .rdc-btn{border:1px solid var(--navy);background:#fff;color:var(--navy);border-radius:8px;
    padding:4px 12px;font-size:.78em;font-weight:600;cursor:pointer;font-family:inherit;margin-top:10px;}
  .roadnote{color:var(--gray);font-size:.78em;margin:8px 0 0;line-height:1.5;}
  .tag.cut{background:#fff3e0;color:#c66a00;}
  .cmdta{width:100%;box-sizing:border-box;margin-top:12px;border:1px solid #d5d5da;border-radius:8px;
    padding:8px;font-family:'SF Mono',monospace;font-size:12px;background:#f7f7f9;color:#1d1d1f;resize:vertical;}
  .cta:disabled{opacity:.45;cursor:default;}
  /* FLY-709 P5: unified draft/confirm helpers */
  .rdc.draft{border-left-color:var(--blue);background:#f7faff;}
  .ffc.draft{background:#f7faff;}
  .ffc-ro{margin-left:auto;font-size:.74em;color:var(--gray);white-space:nowrap;}
  .ffc-btn.changed{background:#eaf3ff;border-color:var(--blue);color:var(--navy);}
  .ffc-btn .mini,.rdc .mini{font-size:.85em;color:var(--blue);font-weight:600;}
  .cgrp{margin:12px 0;}
  .cgrp-h{font-size:.82em;font-weight:700;color:#48484a;margin:8px 0 5px;}
  .pp{display:inline-flex;align-items:center;gap:3px;margin:2px 6px 2px 0;font-size:.92em;}
</style>
</head>
<body>
<h1>Flywheel Fleet</h1>
<div class="sub">本机 · Lead 级别切换(Runner 将继承所属 Lead 的后端与级别 — 接线 = 下一期)</div>
<div class="hint">在下面改 Lead 级别 / Runner 默认 / 热 flag —— 全部累加进顶部一个「应用 N 项修改」,一次统一提交(点确认前会按后果分组给你看:哪些重启 Lead、哪些只写配置、哪些立即热生效)。Lead 后端切换不能自动 apply —— 选了会生成「需人工 cutover」说明。Effort 降到 high/medium 省 token;Codex Lead 的 Effort 置灰(无 --effort 路径)。</div>
<div class="err" id="err"></div>
<div class="applybar" id="applybar">
  <span class="txt" id="applytxt">⏳ 0 项修改</span>
  <button class="discard" id="discardBtn">放弃全部</button>
  <button class="cta" id="applyBtn">应用修改</button>
</div>
<div class="grid" id="grid"></div>
<div class="roadnote">Antigravity / Kimi 目前仅支持 runner 层(见下方「Runner 默认」区的后端下拉);Lead 层的受管后端切换 = FLY-264 未做,选了变更会生成「需人工 cutover」说明而不是假装能切。</div>
<section id="runnerDefaults" style="display:none">
  <h2 class="sec">🤖 Runner 默认 <span class="sec-note">(per-项目 roles.runner · 下拉选目标 → 进顶部「应用 N 项修改」· 写项目配置,对新 run 生效)</span></h2>
  <div class="cardgrid" id="rdBody"></div>
</section>
<section id="cronSection" style="display:none">
  <h2 class="sec">⏰ Cron 每日任务模型 <span class="sec-note">(每日重复 issue 的 runner 模型 · 下拉选目标 → 复制命令)</span></h2>
  <div class="cardgrid" id="cronBody"></div>
</section>
<section id="ffSection" style="display:none">
  <h2 class="sec">🚩 Feature Flags <span class="sec-note">(可热切的 flag 点「草稿」进批量 · 治理门/重启型/dormant 只读)</span></h2>
  <div class="ffhint">可热切换的 flag 卡片里有「草稿」按钮 —— 点它进顶部「应用 N 项修改」一起提交(不再点一下立即切);其余只读 —— 状态一目了然。<a href="/api/fleet/flag-report.html" target="_blank" rel="noopener">整页/手机版</a></div>
  <div class="ffstatus" id="ffStatus"></div>
  <div id="ffBody"></div>
</section>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
${APPLY_COMMAND_JS}
</script>
<script>
(function(){
  var BACKEND_LABEL = { "claude-code":"Claude Code", "codex-app-server":"Codex" };
  var snapshot = null, original = {}, draft = {}, es = null;
  // FLY-671: effort is a second per-key dimension, tracked in parallel with model.
  var originalEffort = {}, draftEffort = {};
  // FLY-709 P4.1: backend is a third dimension — draftable, but a diff is NEVER
  // sent to stage/apply (manual cutover only; it feeds the copy text).
  var originalBackend = {}, draftBackend = {};
  // FLY-709 P5 (Annie's unified redesign): runner-default + direct-flag changes
  // are drafted into the SAME top counter as Lead changes, then one "应用 N 项
  // 修改" fans out per backend contract. No more per-runner copy command / flag
  // instant-toggle.
  var originalRunner = {}, draftRunner = {};   // proj -> {model,effort,backend} (null=default)
  var originalFlag = {}, draftFlag = {};        // direct flag name -> bool

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
  // FLY-671: effort-dimension mirrors of the tier helpers.
  function effortLabel(lead, id){
    var opts = lead.effortOptions || [];
    for (var i=0;i<opts.length;i++){ if(opts[i].id===id) return opts[i].label; }
    return id===null ? "默认" : id;
  }
  function isReadonlyEffort(lead){
    var opts = lead.effortOptions || [];
    if (opts.length <= 1) return true;
    for (var i=0;i<opts.length;i++){ if(!opts[i].readonly) return false; }
    return true;
  }
  function changesList(){
    var out=[];
    for (var i=0;i<snapshot.leads.length;i++){
      var l=snapshot.leads[i];
      var mc = draft[l.key] !== original[l.key];
      var ec = draftEffort[l.key] !== originalEffort[l.key];
      var bc = draftBackend[l.key] !== originalBackend[l.key];
      if (mc || ec || bc) out.push({ lead:l, modelChanged:mc, fromId:original[l.key], toId:draft[l.key],
        effortChanged:ec, fromEffort:originalEffort[l.key], toEffort:draftEffort[l.key],
        backendChanged:bc, fromBackend:originalBackend[l.key], toBackend:draftBackend[l.key] });
    }
    return out;
  }
  // FLY-709 P4.1 (Codex R1 #5): drafts split in two — only model/effort are
  // stage/apply-able; backend diffs are manual-cutover notes (copy text only).
  function applyableChanges(){
    return changesList().filter(function(c){ return c.modelChanged || c.effortChanged; });
  }
  // FLY-709 P5: runner-default diffs — one entry per project that has a change.
  function runnerChanges(){
    var out=[];
    var list=(snapshot&&snapshot.projectRunnerDefaults)||[];
    for (var i=0;i<list.length;i++){
      var r=list[i]; if(r.error) continue;
      var o=originalRunner[r.projectName]||{}, d=draftRunner[r.projectName]||{};
      var ch={}, any=false, dims=["backend","model","effort"];
      for (var k=0;k<dims.length;k++){ var dim=dims[k];
        var dv=(d[dim]===undefined?null:d[dim]), ov=(o[dim]===undefined?null:o[dim]);
        if (dv!==ov){ ch[dim]=dv; any=true; }
      }
      if (any) out.push({ kind:"runner", proj:r.projectName, change:ch });
    }
    return out;
  }
  // FLY-709 P5: direct-flag draft diffs — one entry per toggled flag.
  function flagChanges(){
    var out=[];
    var flags=(snapshot&&snapshot.featureFlags)||[];
    for (var i=0;i<flags.length;i++){ var f=flags[i];
      if (!ffIsDirect(f)) continue;
      if (draftFlag[f.name]!==undefined && draftFlag[f.name]!==originalFlag[f.name]){
        out.push({ kind:"flag", name:f.name, to:draftFlag[f.name], from:originalFlag[f.name],
          label:(f.envVar||f.name), desc:f.description });
      }
    }
    return out;
  }
  // FLY-709 P5: EVERYTHING the founder changed → the one shared counter.
  function allChanges(){
    var lead = changesList().map(function(c){ c.kind="lead"; return c; });
    return lead.concat(runnerChanges()).concat(flagChanges());
  }
  function dotClass(online){
    return online==="online" ? "dot" : online==="offline" ? "dot off"
      : online==="degraded" ? "dot deg" : "dot unk";
  }

  function backendChipHtml(lead){
    var changed = draftBackend[lead.key] !== originalBackend[lead.key];
    var oldLbl = BACKEND_LABEL[originalBackend[lead.key]] || originalBackend[lead.key];
    var newLbl = BACKEND_LABEL[draftBackend[lead.key]] || draftBackend[lead.key];
    var cls = draftBackend[lead.key]==="codex-app-server" ? "val-codex" : "val-claude";
    var val = changed
      ? '<span class="old">'+esc(oldLbl)+'</span><span class="new">'+esc(newLbl)+'</span>'
      : '<span class="'+cls+'">'+esc(newLbl)+'</span>';
    return '<div class="chip '+(changed?"changed":"")+'" data-key="'+esc(lead.key)+'" data-kind="backend">'
      + '<div class="lbl">后端<span class="caret">⌄</span></div>'
      + '<div class="val">'+val+'</div>'
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
  // FLY-671: effort chip — mirrors tierChipHtml on the effort dimension.
  function effortChipHtml(lead){
    var changed = draftEffort[lead.key] !== originalEffort[lead.key];
    var ro = isReadonlyEffort(lead);
    var oldLbl = effortLabel(lead, originalEffort[lead.key]);
    var newLbl = effortLabel(lead, draftEffort[lead.key]);
    var val = changed
      ? '<span class="old">'+esc(oldLbl)+'</span><span class="new">'+esc(newLbl)+'</span>'
      : esc(newLbl);
    return '<div class="chip '+(changed?"changed":"")+(ro?" ro":"")+'" data-key="'+esc(lead.key)+'" data-kind="effort">'
      + '<div class="lbl">Effort'+(ro?"":'<span class="caret">⌄</span>')+'</div>'
      + '<div class="val">'+val+'</div>'
      + '<div class="menu" id="menu-'+esc(lead.key)+'-effort"></div></div>';
  }

  function render(){
    var grid = el("grid");
    grid.innerHTML = snapshot.leads.map(function(l){
      var bc = draftBackend[l.key] !== originalBackend[l.key];
      var changed = (draft[l.key] !== original[l.key]) || (draftEffort[l.key] !== originalEffort[l.key]) || bc;
      var foot = "";
      if (changed) foot += '<span class="tag pend">未应用</span>';
      if (bc) foot += '<span class="tag cut">后端需人工 cutover</span>';
      if (l.backendSource==="explicit" || l.currentBackend==="codex-app-server") {
        if (l.backendSource!=="default" && l.currentBackend==="codex-app-server") foot += '<span class="tag ext">外部托管</span>';
      }
      return '<div class="card '+(changed?"draft":"")+'">'
        + '<div class="top"><span class="'+dotClass(l.online)+'"></span>'
        + '<span class="name">'+esc(l.displayName)+'</span>'
        + '<span class="proj">'+esc(l.projectName)+'</span></div>'
        + '<div class="specs">'+backendChipHtml(l)+tierChipHtml(l)+effortChipHtml(l)+'</div>'
        + '<div class="cardfoot">'+foot+'</div></div>';
    }).join("");
    updateApplyBar();
  }

  // FLY-709 P5: the ONE shared counter across lead + runner + direct-flag drafts.
  function updateApplyBar(){
    var all = allChanges();
    var n = all.length;
    var cutoverOnly = all.filter(function(c){
      return c.kind==="lead" && c.backendChanged && !c.modelChanged && !c.effortChanged;
    }).length;
    var bar = el("applybar");
    bar.classList.toggle("show", n>0);
    el("applytxt").textContent = "⏳ "+n+" 项修改"
      + (cutoverOnly>0?("(其中 "+cutoverOnly+" 项后端 = 仅生成 cutover 说明)"):"");
    el("applyBtn").textContent = "应用 "+n+" 项修改";
    el("applyBtn").disabled = n===0;
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
      // FLY-709 P4.1: both real Lead backends are selectable as a DRAFT — a
      // diff never reaches stage/apply; it only feeds the copy text as a
      // manual-cutover note (FLY-264 not built).
      menu.innerHTML = lead.backendOptions.map(function(o,i){
        var selected = o.backend===draftBackend[key];
        var mini = o.backend!==lead.currentBackend
          ? '<span class="mini">需人工 cutover</span>' : "";
        return '<div class="opt" data-pick="'+esc(key)+'" data-idx="'+i+'" data-dim="backend">'
          + '<span class="check">'+(selected?"✓":"")+'</span>'
          + esc(BACKEND_LABEL[o.backend]||o.backend)+mini+'</div>';
      }).join("");
    } else {
      // tier or effort — same menu shape, different option list + dimension.
      var opts = kind==="effort" ? (lead.effortOptions||[]) : lead.tierOptions;
      var cur  = kind==="effort" ? draftEffort[key] : draft[key];
      menu.innerHTML = opts.map(function(o,i){
        var selected = o.id===cur;
        var ro = !!o.readonly;
        return '<div class="opt'+(ro?" disabled":"")+'"'
          + (ro?"":' data-pick="'+esc(key)+'" data-idx="'+i+'" data-dim="'+esc(kind)+'"')+'>'
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
      var dim = pickEl.getAttribute("data-dim") || "tier";
      var lead = leadByKey(k);
      if (dim==="effort"){ draftEffort[k] = (lead.effortOptions||[])[idx].id; }
      else if (dim==="backend"){ draftBackend[k] = lead.backendOptions[idx].backend; }
      else { draft[k] = lead.tierOptions[idx].id; }
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
    for (var k2 in originalEffort) draftEffort[k2] = originalEffort[k2];
    for (var k3 in originalBackend) draftBackend[k3] = originalBackend[k3];
    // FLY-709 P5: discard runner + flag drafts too (deep copy back from original).
    draftRunner = {}; for (var rp in originalRunner){ draftRunner[rp] = { model:originalRunner[rp].model, effort:originalRunner[rp].effort, backend:originalRunner[rp].backend }; }
    draftFlag = {}; for (var fn in originalFlag){ draftFlag[fn] = originalFlag[fn]; }
    render(); renderRunnerDefaults(); renderFlagCards();
  });
  el("applyBtn").addEventListener("click", openConfirm);

  // FLY-709 P5: the localhost console applies the unified batch DIRECTLY; the
  // copy-to-Lead (phone) path stays on the separate hosted phone report
  // (feature-flag-report-html, Codex R1 #7). showCopyModal is still used by the
  // out-of-scope cron rows.
  function showCopyModal(title, text){
    el("modal").innerHTML = '<h3>'+esc(title)+'</h3>'
      + '<div class="ffhint">粘给任何一个 Lead 在本机执行(命令自带 --yes = 你亲手粘 = 明示授权)。</div>'
      + '<textarea id="cmdText" class="cmdta" readonly rows="6"></textarea>'
      + '<div class="btns"><button class="btn cancel" id="cancelBtn">关闭</button>'
      + '<button class="btn go" id="copyBtn2">复制</button></div>';
    el("overlay").classList.add("open");
    el("cmdText").value = text;
    el("cancelBtn").addEventListener("click", closeModal);
    el("copyBtn2").addEventListener("click", function(){
      var ta = el("cmdText"); ta.focus(); ta.select();
      var ok=false; try{ ok=document.execCommand("copy"); }catch(e){}
      if(!ok && navigator.clipboard) navigator.clipboard.writeText(ta.value);
      el("copyBtn2").textContent="已复制 ✓";
    });
  }

  // FLY-709 P5: unified confirm — every change grouped BY CONSEQUENCE so the
  // founder acts once but sees which changes restart production Leads vs which
  // are harmless config/hot writes.
  function openConfirm(){
    var all = allChanges();
    if (!all.length) return;
    var leadRestart = all.filter(function(c){ return c.kind==="lead" && (c.modelChanged||c.effortChanged); });
    var leadBackend = all.filter(function(c){ return c.kind==="lead" && c.backendChanged; });
    var runners = all.filter(function(c){ return c.kind==="runner"; });
    var flags = all.filter(function(c){ return c.kind==="flag"; });
    function grp(title, rows){ return rows.length ? '<div class="cgrp"><div class="cgrp-h">'+title+'</div>'+rows.join("")+'</div>' : ''; }
    var html = '<h3>应用 '+all.length+' 项修改?</h3>';
    html += grp('🔴 会重启 Lead(约 15 秒不响应)', leadRestart.map(function(c){
      var p=''; if(c.modelChanged)p+='级别 '+esc(tierLabel(c.lead,c.fromId))+'→'+esc(tierLabel(c.lead,c.toId))+' ';
      if(c.effortChanged)p+='Effort '+esc(effortLabel(c.lead,c.fromEffort))+'→'+esc(effortLabel(c.lead,c.toEffort));
      return '<div class="change"><span class="who">'+esc(c.lead.displayName)+'</span><span>'+p+'</span></div>'; }));
    html += grp('🟢 写项目配置(对新 run 生效,无重启)', runners.map(function(c){
      var parts=[]; for(var k in c.change){ parts.push(k+'→'+(c.change[k]===null?'默认':c.change[k])); }
      return '<div class="change"><span class="who">'+esc(c.proj)+'</span><span>'+esc(parts.join(' · '))+'</span></div>'; }));
    html += grp('⚡ 立即热生效(无重启)', flags.map(function(c){
      return '<div class="change"><span class="who">'+esc(c.label)+'</span><span>'+(c.from?"ON":"OFF")+' → '+(c.to?"ON":"OFF")+'</span></div>'; }));
    html += grp('📋 仅生成 cutover 说明(后端不自动改)', leadBackend.map(function(c){
      return '<div class="change"><span class="who">'+esc(c.lead.displayName)+'</span><span>后端 '+esc(BACKEND_LABEL[c.fromBackend]||c.fromBackend)+'→'+esc(BACKEND_LABEL[c.toBackend]||c.toBackend)+'(需人工 cutover)</span></div>'; }));
    html += '<div class="warn">每组按各自机制提交;逐项独立、某项失败不影响已成功项(可能部分成功)。</div>'
      + '<div class="btns"><button class="btn cancel" id="cancelBtn">取消</button>'
      + '<button class="btn go" id="goBtn">确认应用</button></div>';
    el("modal").innerHTML = html;
    el("overlay").classList.add("open");
    el("cancelBtn").addEventListener("click", closeModal);
    el("goBtn").addEventListener("click", function(){ runApplyUnified(leadRestart, runners, flags, leadBackend); });
  }
  function closeModal(){ el("overlay").classList.remove("open"); if(es){es.close();es=null;} }

  function fanoutRowHtml(r){
    return '<div class="prog"><span class="who">'+esc(r.who)+'</span><span>'+esc(r.what)+'</span>'
      + '<span class="st '+r.cls+'">'+esc(r.label)+'</span></div>';
  }
  // Shared stage→apply for the confirmToken routes (runner + flag; same shape).
  async function stageApplyGeneric(stageUrl, body, applyUrl){
    var s = await fetch(stageUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    var sb = await s.json().catch(function(){return{};});
    if (!s.ok) return { ok:false, code:s.status, error:(sb&&sb.error)||("stage "+s.status) };
    var a = await fetch(applyUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({canonical:sb.canonical,confirmToken:sb.confirmToken})});
    var ab = await a.json().catch(function(){return{};});
    if (!a.ok) return { ok:false, code:a.status, error:(ab&&ab.error)||("apply "+a.status) };
    return { ok:true, body:ab };
  }
  // FLY-709 P5: fan out by backend contract — runner (per project) + flag (per
  // direct flag) applied inline; the Lead group stays ONE existing batch (SSE).
  // Non-atomic + explicit: each item independent, partial success is surfaced.
  async function runApplyUnified(leadRestart, runners, flags, leadBackend){
    clearError();
    leadBackend = leadBackend || [];
    var results = [];
    // Number of changes that the console actually applies (or attempts to).
    // Lead-backend diffs are NOT applied here (manual cutover only, FLY-264
    // unbuilt) — they must never make an all-cutover submit read as "完成".
    var appliedCount = runners.length + flags.length + leadRestart.length;
    function paint(done){
      var rows = results.map(fanoutRowHtml).join("");
      var anyFail = results.some(function(r){ return r.cls==="st-error"||r.cls==="st-warn"; });
      var head = done
        ? (appliedCount===0 && leadBackend.length
            ? "📋 需人工 cutover（后端未自动切）"
            : ("完成"+(anyFail?"（部分成功）":"")))
        : "正在应用…";
      var foot = done ? '<div class="btns"><button class="btn go" id="doneBtn">完成</button></div>' : '';
      el("modal").innerHTML = '<h3>'+esc(head)+'</h3><div class="change-list">'+rows+'</div>'+foot;
      var d=el("doneBtn"); if(d) d.addEventListener("click", function(){ closeModal(); reload(); });
    }
    // Codex code review R1 #2: surface Lead-backend diffs as durable
    // manual-cutover result rows FIRST — the console does not switch backends,
    // so an all-backend submit must show the cutover note (not a bare "完成").
    for (var k=0;k<leadBackend.length;k++){ var lb=leadBackend[k];
      results.push({ who:lb.lead.displayName, what:"后端 cutover", cls:"st-note",
        label:"📋 需人工 cutover:"+(BACKEND_LABEL[lb.fromBackend]||lb.fromBackend)+"→"+(BACKEND_LABEL[lb.toBackend]||lb.toBackend)+"（控制台不自动切，见 fleet cutover runbook）" });
    }
    paint(false);
    for (var i=0;i<runners.length;i++){ var c=runners[i];
      var r = await stageApplyGeneric("/api/fleet/runner/stage", {project:c.proj, change:c.change}, "/api/fleet/runner/apply");
      results.push({ who:c.proj, what:"runner 默认", cls:r.ok?"st-done":(r.code===409?"st-warn":"st-error"),
        label:r.ok?"✓ 已写(新 run 生效)":(r.code===409?"⚠ 配置已变，请刷新重试":"✗ "+r.error) });
      paint(false);
    }
    for (var j=0;j<flags.length;j++){ var f=flags[j];
      var rf = await stageApplyGeneric("/api/fleet/flag/stage", {name:f.name, to:f.to}, "/api/fleet/flag/apply");
      results.push({ who:f.label, what:"flag", cls:rf.ok?"st-done":"st-error",
        label:rf.ok?("✓ 已切到 "+(f.to?"ON":"OFF")):("✗ "+rf.error) });
      paint(false);
    }
    if (leadRestart.length){
      var changes = leadRestart.map(function(c){ var ch={key:c.lead.key}; if(c.modelChanged)ch.toModel=c.toId; if(c.effortChanged)ch.toEffort=c.toEffort; return ch; });
      try {
        var r1 = await fetch("/api/fleet/stage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({changes:changes})});
        if(!r1.ok){ var b1=await r1.json().catch(function(){return{};}); results.push({who:"Lead 批量",what:"",cls:"st-error",label:"✗ "+(b1.error||("stage "+r1.status))}); paint(true); return; }
        var staged=await r1.json();
        var r2=await fetch("/api/fleet/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({batch:staged.canonicalRequest,confirmToken:staged.confirmToken})});
        if(r2.status!==202){ var b2=await r2.json().catch(function(){return{};}); results.push({who:"Lead 批量",what:"",cls:"st-error",label:"✗ "+(b2.error||("apply "+r2.status))}); paint(true); return; }
        var applied=await r2.json();
        watchProgress(applied.batchId, leadRestart, results.map(fanoutRowHtml).join(""));
        return;
      } catch(e){ results.push({who:"Lead 批量",what:"",cls:"st-error",label:"✗ "+e}); paint(true); return; }
    }
    paint(true);
  }

  function progRow(c, st){
    var cls = st.tone==="done"?"st-done":st.tone==="doing"?"st-doing"
      : st.tone==="warn"?"st-warn":st.tone==="error"?"st-error":"st-wait";
    var what = '';
    if (c.modelChanged) what += '级别 → '+esc(tierLabel(c.lead,c.toId));
    if (c.effortChanged) what += (what?' · ':'')+'Effort → '+esc(effortLabel(c.lead,c.toEffort));
    return '<div class="prog"><span class="who">'+esc(c.lead.displayName)+'</span>'
      + '<span>'+what+'</span>'
      + '<span class="st '+cls+'">'+esc(st.label)+'</span></div>';
  }

  function watchProgress(batchId, list, preRows){
    // FLY-709 P5: preRows = already-applied runner/flag fanout rows, shown above
    // the async Lead-batch progress so partial success stays visible.
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
      el("modal").innerHTML = '<h3>'+esc(head)+'</h3><div class="change-list">'+(preRows||"")+rows+'</div>'+foot;
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

  // FLY-709 P4.3: per-project runner DEFAULT (roles.runner) — dropdowns build
  // a "flywheel-comm runner-config apply" command (copy-paste; the writer on
  // the Lead's machine validates + hot-applies to NEW runs). No direct apply.
  function rdSelect(proj, kind, current, options, defLabel){
    var cur = current===null ? "__default__" : current;
    var html = '<option value="__default__"'+(cur==="__default__"?" selected":"")+'>'+esc(defLabel)+'</option>';
    for (var i=0;i<options.length;i++){
      html += '<option value="'+esc(options[i])+'"'+(cur===options[i]?" selected":"")+'>'+esc(options[i])+'</option>';
    }
    return '<select class="rdsel" data-rd-proj="'+esc(proj)+'" data-rd-kind="'+kind+'"'
      + ' data-rd-current="'+esc(cur)+'">'+html+'</select>';
  }
  // FLY-709 P5: a runner select bound to draftRunner (NOT a copy command).
  function rdOptions(proj, kind, options, defLabel){
    var d=draftRunner[proj]||{}; var cur=(d[kind]===undefined?null:d[kind]);
    var sel = cur===null ? "__default__" : cur;
    var html = '<option value="__default__"'+(sel==="__default__"?" selected":"")+'>'+esc(defLabel)+'</option>';
    for (var i=0;i<options.length;i++){
      html += '<option value="'+esc(options[i])+'"'+(sel===options[i]?" selected":"")+'>'+esc(options[i])+'</option>';
    }
    return '<select class="rdsel" data-rd-proj="'+esc(proj)+'" data-rd-kind="'+kind+'">'+html+'</select>';
  }
  function rdChanged(proj){
    var o=originalRunner[proj]||{}, d=draftRunner[proj]||{}, dims=["backend","model","effort"];
    for (var k=0;k<dims.length;k++){ var dim=dims[k];
      if ((d[dim]===undefined?null:d[dim])!==(o[dim]===undefined?null:o[dim])) return true; }
    return false;
  }
  function renderRunnerDefaults(){
    var sec = el("runnerDefaults");
    var list = (snapshot && snapshot.projectRunnerDefaults) || [];
    if (!list.length){ sec.style.display="none"; return; }
    var caps = (snapshot && snapshot.runnerCapabilities) || { backends:[], models:[], efforts:[] };
    el("rdBody").innerHTML = list.map(function(r){
      if (r.error){
        return '<div class="rdc"><div class="rdc-proj">'+esc(r.projectName)+'</div>'
          + '<div class="rdc-err">配置错误: '+esc(r.error)+'</div></div>';
      }
      var ch = rdChanged(r.projectName);
      return '<div class="rdc'+(ch?" draft":"")+'"><div class="rdc-proj">'+esc(r.projectName)
        + (ch?' <span class="tag pend">未应用</span>':'')+'</div>'
        + '<div class="rdc-row"><span class="rdc-k">后端</span>'+rdOptions(r.projectName,"backend",caps.backends,"默认 (claude-tmux)")+'</div>'
        + '<div class="rdc-row"><span class="rdc-k">模型</span>'+rdOptions(r.projectName,"model",caps.models,"账户默认")+'</div>'
        + '<div class="rdc-row"><span class="rdc-k">Effort</span>'+rdOptions(r.projectName,"effort",caps.efforts,"默认")+'</div></div>';
    }).join("");
    sec.style.display="block";
  }
  function rdDiff(proj){
    var change = {}, any=false;
    var sels = document.querySelectorAll('[data-rd-proj="'+proj+'"]');
    for (var i=0;i<sels.length;i++){
      var sel = sels[i];
      if (sel.value === sel.getAttribute("data-rd-current")) continue;
      change[sel.getAttribute("data-rd-kind")] = sel.value==="__default__" ? null : sel.value;
      any = true;
    }
    return any ? change : null;
  }

  // FLY-709 P4.4: cron (recurring-issue) model rows — model dropdown → copy
  // command with --cron <collection_id>. Same writer CLI, hot for new runs.
  function renderCronModels(){
    var sec = el("cronSection");
    var list = (snapshot && snapshot.cronModels) || [];
    if (!list.length){ sec.style.display="none"; return; }
    var caps = (snapshot && snapshot.runnerCapabilities) || { models:[] };
    el("cronBody").innerHTML = list.map(function(c,i){
      return '<div class="rdc"><div class="rdc-proj">'+esc(c.label)+' <span class="rdc-dim">('+esc(c.projectName)+' · '+esc(c.leadId)+')</span></div>'
        + '<div class="rdc-row"><span class="rdc-k">模型</span>'
        + rdSelect("cron:"+i, "model", c.model, caps.models, "默认(项目/账户)")+'</div>'
        + '<button type="button" class="rdc-btn" data-cron-copy="'+i+'">复制命令</button></div>';
    }).join("");
    sec.style.display="block";
  }

  // FLY-709 P5: runner-default dropdowns feed draftRunner (no per-row copy).
  // A change on a runner select (data-rd-proj not a cron row) updates the draft
  // + the shared top counter. Cron rows keep the copy-command flow (out of the
  // unified-batch scope — Annie's ask was runner defaults + flags).
  document.addEventListener("change", function(ev){
    var sel = ev.target;
    if (!sel || !sel.matches || !sel.matches("select.rdsel[data-rd-proj]")) return;
    var proj = sel.getAttribute("data-rd-proj");
    if (proj.indexOf("cron:")===0) return; // cron uses copy, not draft
    var kind = sel.getAttribute("data-rd-kind");
    if (!draftRunner[proj]) draftRunner[proj] = {};
    draftRunner[proj][kind] = sel.value==="__default__" ? null : sel.value;
    renderRunnerDefaults();
    updateApplyBar();
  });

  // Delegated copy handlers for the CRON rows (runner rows moved to draft above).
  document.addEventListener("click", function(ev){
    var t = ev.target;
    var cr = t.closest ? t.closest("[data-cron-copy]") : null;
    if (cr){
      ev.stopPropagation();
      var idx = parseInt(cr.getAttribute("data-cron-copy"),10);
      var row = (snapshot.cronModels||[])[idx];
      if (!row) return;
      var change = rdDiff("cron:"+idx);
      if (!change){ setFfStatus("该 cron 没有改动 —— 先在下拉里选目标模型。", true); return; }
      showCopyModal("复制给 Lead 执行(cron "+row.label+")",
        FleetCmd.runnerCommand(snapshot.commCliPath||"", row.projectName, change, row.collectionId));
      return;
    }
  });

  // FLY-709 ①: feature-flag view as native Apple cards (same grid as Lead cards),
  // 4px left-border color-coding by category. Direct-toggleable flags get an
  // in-card 切换 button → stage/apply (localhost). Governance/restart/dormant/
  // project flags render read-only.
  function readJson(r){ return r.json().then(function(b){ return {ok:r.ok,status:r.status,body:b}; }); }
  function setFfStatus(m,isErr){ var s=el("ffStatus"); if(!s)return; s.textContent=m; s.style.color=isErr?"#d70015":"#248a3d"; }
  function ffEff(f){
    if (f.source==="project_config") return "新 run 生效";
    var rt = f.readTimings||[];
    if (rt.indexOf("cli_invocation")>=0) return "命令级";
    var allCall = rt.length>0; for (var i=0;i<rt.length;i++){ if(rt[i]!=="call_time"){ allCall=false; break; } }
    return allCall ? "热生效" : "需重启";
  }
  function ffIsDirect(f){
    if (f.toggleable!=="direct"||f.scope!=="bridge_global"||f.source!=="env"||f.dormant) return false;
    var rt = f.readTimings||[]; if(!rt.length) return false;
    for (var i=0;i<rt.length;i++){ if(rt[i]!=="call_time") return false; }
    return true;
  }
  function ffBool(on){ return on ? '<span class="bdg on">ON</span>' : '<span class="bdg off">OFF</span>'; }
  function ffState(f){
    if (f.error) return '<span class="bdg err">⚠ '+esc(f.error)+'</span>';
    if (f.dormant) return '<span class="bdg dim">validated-only</span>';
    if (f.scope==="project"){
      var rows=f.effectiveByProject||[];
      if(!rows.length) return '<span class="bdg dim">no project</span>';
      return rows.map(function(p){
        var v;
        if(p.error!==undefined) v='<span class="bdg err">error</span>';
        else v = f.valueKind==="bool" ? ffBool(p.value===true) : '<span class="bdg val">'+esc(String(p.value==null?"":p.value))+'</span>';
        return '<span class="pp">'+esc(p.projectName)+': '+v+'</span>';
      }).join("");
    }
    if (f.valueKind==="bool") return ffBool(f.effective===true);
    return '<span class="bdg val">'+esc(String(f.effective==null?"":f.effective))+'</span>';
  }
  function ffCard(f){
    var cls = f.category==="governance_gate" ? "gov" : f.category==="kill_switch" ? "kill" : "feat";
    var catLbl = f.category==="kill_switch" ? "kill-switch" : f.category==="governance_gate" ? "治理门" : "feature";
    var catBdg = f.category==="governance_gate" ? "cgov" : f.category==="kill_switch" ? "ckill" : "cfeat";
    var name = esc(f.envVar||f.configKey||f.name);
    // FLY-709 P5: direct flags toggle into the shared DRAFT (no instant apply);
    // everything else (conversational=需重启 / 治理门 / dormant / value) is a
    // consistent read-only disabled control, not a special interaction.
    var ctl = "", drafted = false;
    if (ffIsDirect(f)){
      var cur = draftFlag[f.name]; if(cur===undefined) cur=(f.effective===true);
      drafted = (draftFlag[f.name]!==undefined && draftFlag[f.name]!==originalFlag[f.name]);
      ctl = '<button type="button" class="ffc-btn'+(drafted?" changed":"")+'" data-ff-draft data-ff-name="'+esc(f.name)+'">'
        + '草稿: '+(cur?"ON":"OFF")+(drafted?'<span class="mini"> 未应用</span>':'')+'</button>';
    } else {
      ctl = '<span class="ffc-ro" title="不可直接切换（改后需重启 / 治理门 / dormant / 值配置）">只读 🔒</span>';
    }
    return '<div class="ffc '+cls+(drafted?" draft":"")+'"><div class="ffc-head"><code class="ffc-name">'+name+'</code>'
      + '<span class="ffc-state">'+ffState(f)+'</span></div>'
      + '<div class="ffc-desc">'+esc(f.description||"")+'</div>'
      + '<div class="ffc-foot"><span class="bdg '+catBdg+'">'+esc(catLbl)+'</span>'
      + '<span class="bdg eff">'+esc(ffEff(f))+'</span>'+ctl+'</div></div>';
  }
  function renderFlagCards(){
    // Annie: one flat list, don't split into 3 categories. Cards keep their
    // left-border color + governance stays locked (ffCard renders no toggle).
    var sec = el("ffSection");
    var flags = (snapshot && snapshot.featureFlags) || [];
    if (!flags.length){ sec.style.display="none"; return; }
    el("ffBody").innerHTML = '<div class="cardgrid">'+flags.map(ffCard).join("")+'</div>';
    sec.style.display="block";
  }
  function refreshFlags(){
    return fetch("/api/fleet/snapshot").then(function(r){ return r.ok?r.json():null; })
      .then(function(s){ if(s&&snapshot){ snapshot.featureFlags=s.featureFlags; renderFlagCards(); } })
      .catch(function(){});
  }
  // FLY-709 P5: direct-flag toggle updates the shared DRAFT (no instant apply);
  // it lands in the top "应用 N 项修改" batch like everything else.
  document.addEventListener("click", function(ev){
    var t = ev.target;
    var btn = t.closest ? t.closest("[data-ff-draft]") : null;
    if (!btn) return;
    ev.stopPropagation();
    var name = btn.getAttribute("data-ff-name");
    var cur = draftFlag[name]; if(cur===undefined) cur = originalFlag[name];
    draftFlag[name] = !cur;
    renderFlagCards();
    updateApplyBar();
  });

  async function reload(){
    clearError();
    try {
      var r = await fetch("/api/fleet/snapshot");
      if (!r.ok){ showError("snapshot 失败 "+r.status); return; }
      snapshot = await r.json();
    } catch(e){ showError("snapshot 请求失败: "+e); return; }
    original = {}; draft = {}; originalEffort = {}; draftEffort = {};
    originalBackend = {}; draftBackend = {};
    for (var i=0;i<snapshot.leads.length;i++){
      var l=snapshot.leads[i];
      original[l.key]=l.currentModelId; draft[l.key]=l.currentModelId;
      originalEffort[l.key]=l.currentEffort; draftEffort[l.key]=l.currentEffort;
      originalBackend[l.key]=l.currentBackend; draftBackend[l.key]=l.currentBackend;
    }
    // FLY-709 P5: seed runner + direct-flag drafts from the fresh snapshot.
    originalRunner = {}; draftRunner = {};
    var rdl = snapshot.projectRunnerDefaults || [];
    for (var ri=0; ri<rdl.length; ri++){ var rr=rdl[ri]; if(rr.error) continue;
      var o = { model:(rr.model==null?null:rr.model), effort:(rr.effort==null?null:rr.effort), backend:(rr.backend==null?null:rr.backend) };
      originalRunner[rr.projectName]=o; draftRunner[rr.projectName]={ model:o.model, effort:o.effort, backend:o.backend };
    }
    originalFlag = {}; draftFlag = {};
    var ffl = snapshot.featureFlags || [];
    for (var fi=0; fi<ffl.length; fi++){ var ff=ffl[fi]; if(!ffIsDirect(ff)) continue;
      originalFlag[ff.name] = (ff.effective===true); draftFlag[ff.name] = (ff.effective===true);
    }
    render();
    renderRunnerDefaults();
    renderCronModels();
    renderFlagCards();
  }

  reload();
})();
</script>
</body>
</html>`;
}
