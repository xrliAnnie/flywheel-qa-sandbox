/**
 * Flywheel management console.
 *
 * The page intentionally has one read boundary (the versioned management
 * snapshot) and one write boundary (stage -> server canonical confirmation ->
 * apply). Every project, role, DAG, cron, flag, model choice, and extension is
 * rendered from the snapshot; this file contains no copied fleet inventory.
 */

export const MANAGEMENT_CONSOLE_STATE_JS = `
function stableUiValue(value){
  if(Array.isArray(value)){return "["+value.map(stableUiValue).join(",")+"]";}
  if(value&&typeof value==="object"){
    return "{"+Object.keys(value).sort().map(function(key){
      return JSON.stringify(key)+":"+stableUiValue(value[key]);
    }).join(",")+"}";
  }
  return JSON.stringify(value);
}
function scheduleLabel(days){
  var normalized=Array.from(new Set(days)).sort(function(a,b){return a-b;});
  var key=normalized.join(",");
  if(key==="1,2,3,4,5,6,7"){return "每日";}
  if(key==="1,2,3,4,5"){return "工作日";}
  if(key==="6,7"){return "周末";}
  return "自定义";
}
function toggleScheduleDay(days,day){
  var next=Array.from(new Set(days)).sort(function(a,b){return a-b;});
  var index=next.indexOf(day);
  if(index>=0){
    if(next.length===1){return next;}
    next.splice(index,1);
  }else{
    next.push(day);
    next.sort(function(a,b){return a-b;});
  }
  return next;
}
function isValidTime(hour,minute){
  return Number.isInteger(hour)&&Number.isInteger(minute)&&hour>=0&&hour<=23&&minute>=0&&minute<=59;
}
function normalizeTimes(times){
  var seen={};
  var valid=[];
  times.forEach(function(time){
    var hour=Number(time.hour);
    var minute=Number(time.minute);
    var key=hour+":"+minute;
    if(isValidTime(hour,minute)&&!seen[key]){
      seen[key]=true;
      valid.push({hour:hour,minute:minute});
    }
  });
  valid.sort(function(a,b){return a.hour-b.hour||a.minute-b.minute;});
  return valid;
}
function nextScheduleTime(times){
  var used={};
  normalizeTimes(times).forEach(function(time){used[time.hour+":"+time.minute]=true;});
  var preferred=[{hour:9,minute:0},{hour:17,minute:0}];
  for(var i=0;i<preferred.length;i++){
    var candidate=preferred[i];if(!used[candidate.hour+":"+candidate.minute]){return candidate;}
  }
  for(var hour=0;hour<24;hour++){
    for(var minute=0;minute<60;minute+=30){if(!used[hour+":"+minute]){return {hour:hour,minute:minute};}}
  }
  return null;
}
function shouldHandleScheduleEvent(action,eventType){
  return (eventType==="click"&&(action==="day"||action==="add"||action==="remove"))||
    (eventType==="change"&&(action==="hour"||action==="minute"));
}
function updateDraft(drafts,targetId,desiredValue,currentValue,observedRevision){
  if(stableUiValue(desiredValue)===stableUiValue(currentValue)){
    delete drafts[targetId];
    return;
  }
  drafts[targetId]={targetId:targetId,desiredValue:desiredValue,observedRevision:observedRevision};
}
`;

const MANAGEMENT_CONSOLE_HEAD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flywheel 管理台</title>
<style>
:root{--ink:#1d1d1f;--muted:#6e6e73;--line:#dedee3;--paper:#fff;--wash:#f5f5f7;--blue:#1267d6;--blue-wash:#eaf3ff;--green:#248a3d;--amber:#b35c00;--red:#c62828;--nav:#15233d}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--wash);overflow:hidden}
button,input,select{font:inherit}.app{display:grid;grid-template-columns:210px minmax(0,1fr);height:100vh}.side{background:var(--nav);color:#fff;padding:24px 14px;display:flex;flex-direction:column;gap:8px}.brand{font-size:20px;font-weight:750;padding:0 10px 20px}.nav-button{border:0;background:transparent;color:#b8c2d3;text-align:left;padding:11px 12px;border-radius:9px;cursor:pointer}.nav-button.active{background:#fff;color:var(--nav);font-weight:700}.source-health{margin-top:auto;color:#aebbd0;font-size:12px;line-height:1.5;padding:10px}
.workspace{min-width:0;display:grid;grid-template-rows:minmax(0,1fr);overflow:hidden}.page{height:100%;display:none}.page.active{display:grid}.page:not(.active){display:none}.instances{grid-template-columns:280px minmax(0,1fr)}.project-rail{background:#fff;border-right:1px solid var(--line);padding:18px;overflow:auto}.search{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 11px;background:var(--wash);margin-bottom:16px}.group-title{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:15px 7px 6px}.project-button{width:100%;border:0;background:transparent;text-align:left;padding:10px;border-radius:9px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}.project-button.active{background:var(--blue-wash);color:#064d9f}.project-name{overflow:hidden;text-overflow:ellipsis}.badge{display:inline-block;padding:2px 7px;border-radius:20px;background:#ececf1;color:#555;font-size:11px;white-space:nowrap}
.detail,.flags-page{min-width:0;overflow:auto;display:flex;flex-direction:column}.detail-inner,.flags-inner{padding:24px 28px 110px}.topline{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.topline h1{font-size:24px;margin:0}.subtitle,.reason,.help,.empty{color:var(--muted);font-size:13px;line-height:1.5}.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:22px 0 18px;overflow:auto}.tab{border:0;background:transparent;padding:10px 13px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}.tab.active{border-color:var(--blue);color:#064d9f;font-weight:700}.panel{display:none}.panel.active{display:block}.section-title{font-size:15px;margin:22px 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.card{background:var(--paper);border:1px solid #e5e5ea;border-radius:12px;padding:15px;box-shadow:0 1px 2px rgba(0,0,0,.035)}.card h3{font-size:15px;margin:0 0 5px}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.status{width:8px;height:8px;border-radius:50%;margin-top:6px;background:#8e8e93}.status.online{background:#34c759}.status.degraded{background:#ff9500}.status.offline{background:#ff3b30}.field{margin-top:11px}.field label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.field select,.field input{width:100%;border:1px solid #d1d1d6;border-radius:8px;background:#fff;padding:7px 8px}.field select:disabled,.field input:disabled{opacity:.55}.three{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:7px}.role-link{color:var(--blue);text-decoration:none}.role-error{color:var(--red);font-size:12px}.dag-row{border-top:1px solid #ececf0;padding-top:11px;margin-top:11px}.day-row,.time-row,.inline{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.day{border:1px solid #d1d1d6;background:#fff;border-radius:7px;padding:5px 8px;cursor:pointer}.day.on{background:var(--blue);border-color:var(--blue);color:#fff}.time-row{margin-top:7px}.time-row input{width:68px}.mini-button{border:1px solid #d1d1d6;background:#fff;border-radius:7px;padding:5px 8px;cursor:pointer}.toggle{border:1px solid #c8c8cc;background:#eee;border-radius:20px;padding:4px 10px;cursor:pointer}.toggle.on{background:#dcf4e3;color:#176f30;border-color:#a8d9b5}.toggle:disabled,.mini-button:disabled{opacity:.5;cursor:default}.warning{color:var(--amber);font-size:12px;margin-top:7px}.error{background:#ffebea;color:#9f1717;padding:9px 11px;border-radius:8px;margin:10px 0;font-size:13px;display:none}.error.show{display:block}
.flag-group{margin-top:20px}.flag-row,.extension-row{display:grid;grid-template-columns:minmax(180px,1.4fr) minmax(160px,1fr);gap:16px;align-items:center;background:#fff;border:1px solid #e5e5ea;border-radius:11px;padding:13px;margin-top:8px}.flag-name{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.override{border-top:1px solid #eee;margin-top:8px;padding-top:8px}.order-list{display:flex;flex-direction:column;gap:5px}.order-item{display:flex;align-items:center;justify-content:space-between;border:1px solid #ddd;border-radius:7px;padding:6px 8px}
.pending{position:sticky;bottom:0;z-index:20;margin-top:auto;background:#172c4e;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:10px;box-shadow:0 -6px 20px rgba(0,0,0,.16)}.pending.hidden{display:none}.pending .summary{margin-right:auto}.primary,.secondary{border:0;border-radius:8px;padding:8px 13px;cursor:pointer;font-weight:650}.primary{background:#fff;color:#172c4e}.secondary{background:transparent;color:#c8d6eb}.primary:disabled{opacity:.5;cursor:default}
.overlay{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.38);display:none;align-items:center;justify-content:center;padding:20px}.overlay.open{display:flex}.modal{background:#fff;border-radius:14px;width:min(700px,100%);max-height:85vh;overflow:auto;padding:22px}.modal h2{font-size:19px;margin:0}.change{background:var(--wash);border-radius:9px;padding:10px;margin-top:8px}.change-values{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:start;margin-top:6px}.value{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.old{text-decoration:line-through;color:var(--muted)}.consequence{color:var(--amber);font-size:12px;margin-top:6px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.modal-actions .primary{background:var(--blue);color:#fff}.ack{background:#fff6e8;color:#6f4200;padding:10px;border-radius:8px;margin-top:12px}.progress-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;border-top:1px solid #eee;padding:9px 0}.terminal-ok{color:var(--green)}.terminal-partial{color:var(--amber)}.terminal-failed{color:var(--red)}
@media(max-width:780px){body{overflow:auto}.app{grid-template-columns:1fr;height:auto;min-height:100vh}.side{position:sticky;top:0;z-index:30;flex-direction:row;padding:10px}.brand{padding:8px;margin-right:auto}.source-health{display:none}.instances{grid-template-columns:1fr}.project-rail{border-right:0;border-bottom:1px solid var(--line);max-height:250px}.page,.detail,.flags-page{height:auto;overflow:visible}.pending{position:sticky}.three{grid-template-columns:1fr}.flag-row,.extension-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">Flywheel</div>
    <button class="nav-button active" data-nav="instances">实例</button>
    <button class="nav-button" data-nav="flags">Feature Flags</button>
    <div class="source-health" id="sourceHealth">正在读取真实状态…</div>
  </aside>
  <main class="workspace">
    <section class="page instances active" id="instancesPage">
      <aside class="project-rail">
        <input class="search" id="projectSearch" type="search" placeholder="搜索项目">
        <div id="projectList"></div>
      </aside>
      <div class="detail">
        <div class="detail-inner" id="detail"></div>
        <div class="pending hidden" id="pendingBar">
          <div class="summary" id="pendingSummary">0 项待提交</div>
          <button class="secondary" id="discard">放弃</button>
          <button class="primary" id="stage">检查并提交</button>
        </div>
      </div>
    </section>
    <section class="page flags-page" id="flagsPage">
      <div class="flags-inner" id="flags"></div>
      <div class="pending hidden" id="flagPendingBar">
        <div class="summary" id="flagPendingSummary">0 项待提交</div>
        <button class="secondary" id="flagDiscard">放弃</button>
        <button class="primary" id="flagStage">检查并提交</button>
      </div>
    </section>
  </main>
</div>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
`;

const MANAGEMENT_CONSOLE_APP = `
(function(){
  "use strict";
  var snapshot=null;
  var drafts={};
  var targetIndex={};
  var selectedProjectId="";
  var activeTab="model";
  var staged=null;
  var progressStream=null;
  var weekNames=["一","二","三","四","五","六","日"];

  function byId(id){return document.getElementById(id);}
  function esc(value){return String(value==null?"":value).replace(/[&<>\"]/g,function(char){return char==="&"?"&amp;":char==="<"?"&lt;":char===">"?"&gt;":"&quot;";});}
  function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
  function textValue(value){if(value===null){return "未设置";}if(typeof value==="object"){return stableUiValue(value);}return String(value);}
  function effective(managed){var draft=drafts[managed.targetId];return draft?draft.desiredValue:managed.current;}
  function writable(managed){return managed&&managed.writeCapability&&managed.writeCapability.writable;}
  function setDraft(managed,desired){
    if(!writable(managed)){return;}
    updateDraft(drafts,managed.targetId,desired,managed.current,managed.source.revision);
    renderAll();
  }
  function register(managed){if(managed&&managed.targetId){targetIndex[managed.targetId]=managed;}}
  function registerCron(cron){register(cron.schedule);register(cron.enabled);if(cron.model){register(cron.model);}}
  function rebuildIndex(){
    targetIndex={};
    snapshot.projects.forEach(function(project){
      project.leads.forEach(function(lead){register(lead.dispatch);});
      if(project.runnerDefault){register(project.runnerDefault.dispatch);}
      project.dags.forEach(function(dag){dag.nodes.forEach(function(node){register(node.dispatch);});});
      project.crons.forEach(registerCron);
    });
    snapshot.unassignedCrons.forEach(registerCron);
    snapshot.flags.forEach(function(flag){register(flag.global);flag.projectOverrides.forEach(function(item){register(item.value);});});
    snapshot.extensions.forEach(function(section){section.fields.forEach(function(field){register(field.value);});});
  }
  function allProjects(){return snapshot?snapshot.projects:[];}
  function projectById(id){for(var i=0;i<allProjects().length;i++){if(allProjects()[i].id===id){return allProjects()[i];}}return null;}
  function selectedProject(){return projectById(selectedProjectId);}
  function firstProjectId(){return allProjects().length?allProjects()[0].id:(snapshot&&snapshot.unassignedCrons.length?"__unassigned__":"");}

  function requestJson(path,options){
    return fetch(path,options).then(function(response){return response.json().catch(function(){return {};}).then(function(body){if(!response.ok){throw new Error(body.error||("请求失败 "+response.status));}return body;});});
  }
  function load(){
    return requestJson("/api/fleet/snapshot").then(function(next){
      snapshot=next;
      rebuildIndex();
      if(!projectById(selectedProjectId)&&selectedProjectId!=="__unassigned__"&&selectedProjectId!=="__extensions__"){selectedProjectId=firstProjectId();}
      renderAll();
    }).catch(showGlobalError);
  }
  function showGlobalError(error){
    var detail=byId("detail");
    detail.innerHTML='<div class="error show">'+esc(error&&error.message?error.message:error)+'</div>';
  }

  function renderHealth(){
    if(!snapshot){return;}
    var failed=snapshot.sources.filter(function(source){return !source.ok;});
    byId("sourceHealth").textContent=failed.length?(failed.length+" 个真源异常"):(snapshot.sources.length+" 个真源已同步");
  }
  function renderProjectList(){
    if(!snapshot){return;}
    var query=byId("projectSearch").value.trim().toLowerCase();
    var projectsById={};
    snapshot.projects.forEach(function(project){projectsById[project.id]=project;});
    var html="";
    snapshot.presentationGroups.forEach(function(group){
      var visible=group.projectIds.map(function(id){return projectsById[id];}).filter(function(project){return project&&project.name.toLowerCase().indexOf(query)>=0;});
      if(!visible.length){return;}
      html+='<div class="group-title">'+esc(group.label)+(group.derived?' <span class="badge">自动</span>':'')+'</div>';
      visible.forEach(function(project){
        html+='<button class="project-button '+(project.id===selectedProjectId?'active':'')+'" data-project="'+esc(project.id)+'"><span class="project-name">'+esc(project.name)+'</span><span class="badge">'+project.leads.length+' Lead</span></button>';
      });
    });
    var grouped={};
    snapshot.presentationGroups.forEach(function(group){group.projectIds.forEach(function(id){grouped[id]=true;});});
    var other=snapshot.projects.filter(function(project){return !grouped[project.id]&&project.name.toLowerCase().indexOf(query)>=0;});
    if(other.length){
      html+='<div class="group-title">其他</div>';
      other.forEach(function(project){html+='<button class="project-button '+(project.id===selectedProjectId?'active':'')+'" data-project="'+esc(project.id)+'"><span class="project-name">'+esc(project.name)+'</span></button>';});
    }
    if(snapshot.unassignedCrons.length&&"未归属 Cron".toLowerCase().indexOf(query)>=0){html+='<div class="group-title">基础设施</div><button class="project-button '+(selectedProjectId==="__unassigned__"?'active':'')+'" data-project="__unassigned__"><span class="project-name">未归属 Cron</span><span class="badge">'+snapshot.unassignedCrons.length+'</span></button>';}
    if(snapshot.extensions.length&&"全局运行参数".toLowerCase().indexOf(query)>=0){html+='<div class="group-title">全局</div><button class="project-button '+(selectedProjectId==="__extensions__"?'active':'')+'" data-project="__extensions__"><span class="project-name">全局运行参数</span><span class="badge">'+snapshot.extensions.length+' tab</span></button>';}
    byId("projectList").innerHTML=html||'<div class="empty">没有匹配项目</div>';
  }
  function capability(managed){
    if(writable(managed)){return "";}
    return '<div class="reason">只读：'+esc(managed.writeCapability.reason||"后端未开放写入")+'</div>';
  }
  function catalogFor(surface){return snapshot.modelCatalog[surface]||{providers:[]};}
  function defaultSelection(surface){
    var catalog=catalogFor(surface);var provider=catalog.providers[0];var model=provider&&provider.models[0];
    return provider&&model?{provider:provider.id,model:model.id,effort:null}:null;
  }
  function selectedProvider(catalog,value){
    var id=value&&value.provider;for(var i=0;i<catalog.providers.length;i++){if(catalog.providers[i].id===id){return catalog.providers[i];}}
    return catalog.providers[0]||null;
  }
  function selectedModel(provider,value){
    if(!provider){return null;}var id=value&&value.model;for(var i=0;i<provider.models.length;i++){if(provider.models[i].id===id){return provider.models[i];}}
    return null;
  }
  function option(id,label,chosen){return '<option value="'+esc(id)+'" '+(id===chosen?'selected':'')+'>'+esc(label)+'</option>';}
  function modelControl(managed,surface,label,providerLocked,selectionNullable){
    var value=effective(managed);var catalog=catalogFor(surface);var writableTarget=writable(managed);
    if(!catalog.providers.length){return '<div class="field"><label>'+esc(label)+'</label><div class="reason">真实 registry 在此层没有可用型号</div>'+capability(managed)+'</div>';}
    if(!value&&!selectionNullable){return '<div class="field"><label>'+esc(label)+'</label><div class="reason">当前真源没有声明具体模型</div>'+capability(managed)+'</div>';}
    var provider=value?selectedProvider(catalog,value):(providerLocked?catalog.providers[0]:null);
    var model=value&&provider?selectedModel(provider,value):null;
    var providers=(!providerLocked&&selectionNullable?'<option value="" '+(!provider?'selected':'')+'>账户默认</option>':'')+catalog.providers.map(function(item){return option(item.id,item.label,provider&&provider.id);}).join("");
    var retiredModel=value&&provider&&!model&&value.model?'<option value="'+esc(value.model)+'" selected>已退役 · '+esc(value.model)+'</option>':'';
    var models=(selectionNullable?'<option value="" '+(!value?'selected':'')+'>账户默认</option>':'')+retiredModel+(provider?provider.models.map(function(item){return option(item.id,item.label,model&&model.id);}).join(""):"");
    var efforts='<option value="" '+(!value||value.effort==null?'selected':'')+'>账户默认</option>'+(model?model.efforts.map(function(item){return option(item,item,value&&value.effort);}).join(""):"");
    var providerDisabled=providerLocked||!writableTarget?' disabled':'';
    var modelDisabled=!writableTarget||!provider?' disabled':'';
    var effortDisabled=!writableTarget||!model?' disabled':'';
    return '<div class="field" data-model-target="'+esc(managed.targetId)+'" data-model-nullable="'+(selectionNullable?'true':'false')+'"><label>'+esc(label)+'</label><div class="three"><select data-model-part="provider" data-surface="'+esc(surface)+'"'+providerDisabled+'>'+providers+'</select><select data-model-part="model" data-surface="'+esc(surface)+'"'+modelDisabled+'>'+models+'</select><select data-model-part="effort" data-surface="'+esc(surface)+'"'+effortDisabled+'>'+efforts+'</select></div>'+capability(managed)+'</div>';
  }
  function renderRoles(project){
    if(!project.roles.length){return '<div class="empty">未发现角色卡</div>';}
    return '<div class="grid">'+project.roles.map(function(role){
      var link="";
      if(role.sourceLink&&role.sourceLink.indexOf("https://github.com/")===0){link='<a class="role-link" href="'+esc(role.sourceLink)+'" target="_blank" rel="noopener noreferrer">查看 GitHub</a>';}
      var diagnostic=role.error?'<div class="role-error">'+esc(role.error)+'</div>':(!link?'<div class="role-error">没有可验证的仓库链接</div>':'');
      return '<article class="card"><div class="card-head"><div><h3>'+esc(role.name)+'</h3><div class="subtitle">'+esc(role.department||role.agentFile)+'</div></div>'+link+'</div>'+diagnostic+'</article>';
    }).join("")+'</div>';
  }
  function renderModelPanel(project){
    var html='<div class="panel '+(activeTab==="model"?'active':'')+'" data-panel="model"><h2 class="section-title">Lead 模型</h2><div class="grid">';
    html+=project.leads.map(function(lead){return '<article class="card"><div class="card-head"><div><h3>'+esc(lead.displayName)+'</h3><div class="subtitle">'+esc(lead.department||lead.backend)+'</div></div><span class="status '+esc(lead.online)+'"></span></div>'+modelControl(lead.dispatch,"lead","公司 → 型号 → effort",true,true)+'</article>';}).join("");
    html+='</div><h2 class="section-title">Runner 默认</h2>';
    html+=project.runnerDefault?'<div class="grid"><article class="card"><h3>'+esc(project.name)+'</h3>'+modelControl(project.runnerDefault.dispatch,"runner","公司 → 型号 → effort",false,true)+'</article></div>':'<div class="empty">项目没有声明 Runner 默认模型</div>';
    html+='</div>';return html;
  }
  function renderDagPanel(project){
    var html='<div class="panel '+(activeTab==="dag"?'active':'')+'" data-panel="dag"><h2 class="section-title">角色卡</h2>'+renderRoles(project)+'<h2 class="section-title">DAG 模板</h2>';
    if(!project.dags.length){html+='<div class="empty">未发现 DAG 模板</div>';}
    project.dags.forEach(function(dag){
      html+='<article class="card"><div class="card-head"><div><h3>'+esc(dag.title)+'</h3><div class="subtitle">'+esc(dag.templateId)+' · revision '+esc(dag.revision)+'</div></div></div>';
      if(dag.error){html+='<div class="role-error">'+esc(dag.error)+'</div>';}
      dag.nodes.forEach(function(node){html+='<div class="dag-row"><strong>'+esc(node.name)+'</strong>'+modelControl(node.dispatch,"workflow","stage 模型",false,false)+'</div>';});
      html+='</article>';
    });
    return html+'</div>';
  }
  function timePad(value){return String(value).padStart(2,"0");}
  function scheduleEditor(managed){
    var schedule=effective(managed);if(!schedule){return '<div class="field"><label>星期与时间</label><div class="reason">launchd 真源无法解析为受管 weekly schedule</div>'+capability(managed)+'</div>';}
    var disabled=writable(managed)?"":" disabled";
    var days='<div class="day-row">'+weekNames.map(function(name,index){var day=index+1;return '<button class="day '+(schedule.days.indexOf(day)>=0?'on':'')+'" data-schedule-action="day" data-day="'+day+'" data-target="'+esc(managed.targetId)+'"'+disabled+'>周'+name+'</button>';}).join("")+'<span class="badge">'+esc(scheduleLabel(schedule.days))+'</span></div>';
    var removeDisabled=!writable(managed)||(schedule.times||[]).length<=1?' disabled':'';
    var times='<div>'+(schedule.times||[]).map(function(time,index){return '<div class="time-row"><input type="number" min="0" max="23" value="'+esc(timePad(time.hour))+'" data-schedule-action="hour" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+disabled+'><span>:</span><input type="number" min="0" max="59" value="'+esc(timePad(time.minute))+'" data-schedule-action="minute" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+disabled+'><button class="mini-button" data-schedule-action="remove" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+removeDisabled+'>移除</button></div>';}).join("")+'</div>';
    return '<div class="field"><label>星期与时间</label>'+days+times+'<button class="mini-button" data-schedule-action="add" data-target="'+esc(managed.targetId)+'"'+disabled+'>增加时间</button>'+capability(managed)+'</div>';
  }
  function cronCard(cron){
    var enabled=effective(cron.enabled);var enabledLabel=enabled===null?'状态未知':enabled?'已启用':'已停用';var html='<article class="card"><div class="card-head"><div><h3>'+esc(cron.label)+'</h3><div class="subtitle">'+esc(cron.sourceHint)+'</div></div><button class="toggle '+(enabled===true?'on':'')+'" data-toggle-target="'+esc(cron.enabled.targetId)+'"'+(writable(cron.enabled)?'':' disabled')+'>'+enabledLabel+'</button></div>';
    html+='<div class="subtitle">launchd loaded：'+esc(cron.loaded===null?'未知':cron.loaded?'是':'否')+'</div>'+scheduleEditor(cron.schedule);
    if(cron.model){html+=modelControl(cron.model,"cron","任务模型",false,false);}
    cron.warnings.forEach(function(warning){html+='<div class="warning">'+esc(warning)+'</div>';});
    if(cron.error){html+='<div class="role-error">'+esc(cron.error)+'</div>';}
    return html+'</article>';
  }
  function renderCronPanel(project){
    var crons=project?project.crons:snapshot.unassignedCrons;var html='<div class="panel '+(activeTab==="cron"?'active':'')+'" data-panel="cron"><div class="grid">';
    html+=crons.map(cronCard).join("");return html+(crons.length?'':'<div class="empty">未发现 Cron</div>')+'</div></div>';
  }
  function fieldControl(field){
    var managed=field.value;var value=effective(managed);var disabled=writable(managed)?"":" disabled";var control="";
    if(field.kind==="boolean"){control='<button class="toggle '+(value?'on':'')+'" data-toggle-target="'+esc(managed.targetId)+'"'+disabled+'>'+(value?'开启':'关闭')+'</button>';}
    if(field.kind==="number"){control='<input type="number" value="'+esc(value)+'" data-extension-target="'+esc(managed.targetId)+'" data-extension-kind="number"'+disabled+'>';}
    if(field.kind==="select"){control='<select data-extension-target="'+esc(managed.targetId)+'" data-extension-kind="select"'+disabled+'>'+(field.options||[]).map(function(item){return option(item.id,item.label,value);}).join("")+'</select>';}
    if(field.kind==="order_list"){
      control='<div class="order-list">'+(value||[]).map(function(id,index){var match=(field.options||[]).filter(function(item){return item.id===id;})[0];return '<div class="order-item"><span>'+esc(match?match.label:id)+'</span><span><button class="mini-button" data-order-target="'+esc(managed.targetId)+'" data-order-index="'+index+'" data-order-move="-1"'+(index===0?' disabled':disabled)+'>↑</button><button class="mini-button" data-order-target="'+esc(managed.targetId)+'" data-order-index="'+index+'" data-order-move="1"'+(index===(value.length-1)?' disabled':disabled)+'>↓</button></span></div>';}).join("")+'</div>';
    }
    return '<div>'+control+capability(managed)+'</div>';
  }
  function renderExtensionPanel(section){
    var html='<div class="panel '+(activeTab==="extension-"+section.id?'active':'')+'" data-panel="extension-'+esc(section.id)+'">';
    section.fields.forEach(function(field){html+='<div class="extension-row"><div><strong>'+esc(field.label)+'</strong><div class="help">'+esc(field.help||"")+'</div></div>'+fieldControl(field)+'</div>';});
    return html+'</div>';
  }
  function renderUnassigned(){
    return '<div class="topline"><div><h1>未归属 Cron</h1><div class="subtitle">从 launchd 真源自动发现，未映射到任何项目</div></div></div><div class="tabs"><button class="tab active" data-tab="cron">Cron</button></div>'+renderCronPanel(null);
  }
  function renderGlobalExtensions(){
    if(!snapshot.extensions.length){return '<div class="topline"><div><h1>全局运行参数</h1></div></div><div class="empty">尚未注册运行参数 provider</div>';}
    var allowed=snapshot.extensions.map(function(section){return "extension-"+section.id;});
    if(allowed.indexOf(activeTab)<0){activeTab=allowed[0];}
    var html='<div class="topline"><div><h1>全局运行参数</h1><div class="subtitle">全局真源；不随左侧项目切换</div></div></div><div class="tabs">';
    snapshot.extensions.forEach(function(section){html+='<button class="tab '+(activeTab==="extension-"+section.id?'active':'')+'" data-tab="extension-'+esc(section.id)+'">'+esc(section.label)+'</button>';});
    html+='</div>';snapshot.extensions.forEach(function(section){html+=renderExtensionPanel(section);});return html;
  }
  function renderDetail(){
    if(!snapshot){return;}var project=selectedProject();
    if(selectedProjectId==="__unassigned__"){activeTab="cron";byId("detail").innerHTML=renderUnassigned();return;}
    if(selectedProjectId==="__extensions__"){byId("detail").innerHTML=renderGlobalExtensions();return;}
    if(!project){byId("detail").innerHTML='<div class="empty">没有可显示的项目</div>';return;}
    var allowed=["model","dag","cron"];
    if(allowed.indexOf(activeTab)<0){activeTab="model";}
    var html='<div class="topline"><div><h1>'+esc(project.name)+'</h1><div class="subtitle">'+esc(project.presentationGroup)+' · 真源 revision '+esc(project.sourceRevision)+'</div></div></div>';
    if(project.error){html+='<div class="error show">'+esc(project.error)+'</div>';}
    html+='<div class="tabs"><button class="tab '+(activeTab==="model"?'active':'')+'" data-tab="model">模型</button><button class="tab '+(activeTab==="dag"?'active':'')+'" data-tab="dag">DAG 模板</button><button class="tab '+(activeTab==="cron"?'active':'')+'" data-tab="cron">Cron</button>';
    html+='</div>'+renderModelPanel(project)+renderDagPanel(project)+renderCronPanel(project);
    byId("detail").innerHTML=html;
  }
  function renderFlagValue(managed){
    var value=effective(managed);if(typeof value==="boolean"){return '<button class="toggle '+(value?'on':'')+'" data-toggle-target="'+esc(managed.targetId)+'"'+(writable(managed)?'':' disabled')+'>'+(value?'开启':'关闭')+'</button>'+capability(managed);}
    return '<span class="badge">'+esc(textValue(value))+'</span>'+capability(managed);
  }
  function renderFlags(){
	if(!snapshot){return;}var groups={};
	snapshot.flags.forEach(function(flag){(groups[flag.category]||(groups[flag.category]=[])).push(flag);});
	var html='<div class="topline"><div><h1>Feature Flags</h1><div class="subtitle">全部集中展示；全局值与 per-project override 使用同一提交流</div></div></div>';
    Object.keys(groups).sort().forEach(function(category){
      html+='<section class="flag-group"><h2 class="section-title">'+esc(category)+'</h2>';
      groups[category].forEach(function(flag){
        html+='<article class="flag-row"><div><div class="flag-name">'+esc(flag.name)+'</div><div class="help">'+esc(flag.description)+'</div>';
        flag.projectOverrides.forEach(function(item){html+='<div class="override"><strong>'+esc(item.projectName)+'</strong><div class="help">项目覆盖</div>'+renderFlagValue(item.value)+'</div>';});
        html+='</div><div><div class="help">全局值</div>'+renderFlagValue(flag.global)+'</div></article>';
      });html+='</section>';
    });
    byId("flags").innerHTML=html+(snapshot.flags.length?'':'<div class="empty">flag registry 当前为空</div>');
  }
  function renderPending(){
    var count=Object.keys(drafts).length;[byId("pendingBar"),byId("flagPendingBar")].forEach(function(bar){bar.classList.toggle("hidden",count===0);});
    byId("pendingSummary").textContent=count+" 项待提交";byId("flagPendingSummary").textContent=count+" 项待提交";
  }
  function renderAll(){renderHealth();renderProjectList();renderDetail();renderFlags();renderPending();}

  function handleModelChange(select){
    var holder=select.closest("[data-model-target]");var managed=targetIndex[holder.dataset.modelTarget];if(!managed||!writable(managed)){return;}
    var surface=select.dataset.surface;var current=clone(effective(managed));var catalog=catalogFor(surface);var part=select.dataset.modelPart;
    if((part==="provider"||part==="model")&&!select.value){if(holder.dataset.modelNullable==="true"){setDraft(managed,null);}return;}
    var value=current||defaultSelection(surface);if(!value){return;}value[part]=select.value||null;
    if(part==="provider"){
      var provider=selectedProvider(catalog,value);var model=provider&&provider.models[0];if(!model){return;}value.model=model.id;value.effort=null;
    }else if(part==="model"){
      value.effort=null;
    }
    setDraft(managed,value);
  }
  function handleSchedule(element){
    var managed=targetIndex[element.dataset.target];if(!managed||!writable(managed)){return;}var schedule=clone(effective(managed));if(!schedule){return;}var action=element.dataset.scheduleAction;var index=Number(element.dataset.index);
    if(action==="day"){schedule.days=toggleScheduleDay(schedule.days,Number(element.dataset.day));}
    if(action==="add"){var added=nextScheduleTime(schedule.times);if(!added){return;}schedule.times=normalizeTimes(schedule.times.concat([added]));}
    if(action==="remove"){if(schedule.times.length<=1){return;}schedule.times.splice(index,1);schedule.times=normalizeTimes(schedule.times);}
    if(action==="hour"||action==="minute"){
      var next=Number(element.value);var time=schedule.times[index];var hour=action==="hour"?next:Number(time.hour);var minute=action==="minute"?next:Number(time.minute);
      if(!isValidTime(hour,minute)){element.setCustomValidity("请输入有效时间");element.reportValidity();return;}
      element.setCustomValidity("");time.hour=hour;time.minute=minute;schedule.times=normalizeTimes(schedule.times);
    }
    schedule.label=scheduleLabel(schedule.days);setDraft(managed,schedule);
  }
  function handleOrder(button){
    var managed=targetIndex[button.dataset.orderTarget];if(!managed||!writable(managed)){return;}var value=clone(effective(managed));var index=Number(button.dataset.orderIndex);var destination=index+Number(button.dataset.orderMove);if(destination<0||destination>=value.length){return;}var moved=value.splice(index,1)[0];value.splice(destination,0,moved);setDraft(managed,value);
  }
  function delegate(event){
	var model=event.target.closest("[data-model-part]");if(model&&event.type==="change"){handleModelChange(model);return;}
    var schedule=event.target.closest("[data-schedule-action]");if(schedule){if(shouldHandleScheduleEvent(schedule.dataset.scheduleAction,event.type)){handleSchedule(schedule);}return;}
    var toggle=event.target.closest("[data-toggle-target]");if(toggle&&event.type==="click"){var managed=targetIndex[toggle.dataset.toggleTarget];if(managed){setDraft(managed,!effective(managed));}return;}
    var extension=event.target.closest("[data-extension-target]");if(extension&&event.type==="change"){var field=targetIndex[extension.dataset.extensionTarget];setDraft(field,extension.dataset.extensionKind==="number"?Number(extension.value):extension.value);return;}
    var order=event.target.closest("[data-order-target]");if(order&&event.type==="click"){handleOrder(order);}
  }

  function post(path,body){return requestJson(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
  function canonicalKey(batch){return stableUiValue(batch.changes.map(function(change){return {targetId:change.targetId,oldValue:change.oldValue,newValue:change.newValue,consequence:change.consequence};}));}
  function showCanonical(result,message,forceAcknowledgement){
    staged=forceAcknowledgement?Object.assign({},result,{confirmationRequired:true,confirmToken:null}):result;result=staged;var batch=result.batch;var html='<h2>提交确认</h2><div class="help">以下内容来自 server canonical 预检；页面草稿不是落盘权威。</div>';
    if(message){html+='<div class="ack">'+esc(message)+'</div>';}
    batch.changes.forEach(function(change){html+='<div class="change"><strong>'+esc(change.targetId)+'</strong><div class="change-values"><div><div class="help">旧值 oldValue</div><div class="value old">'+esc(textValue(change.oldValue))+'</div></div><span>→</span><div><div class="help">新值 newValue</div><div class="value">'+esc(textValue(change.newValue))+'</div></div></div><div class="consequence">影响 consequence：'+esc(change.consequence)+'</div></div>';});
    batch.noOps.forEach(function(change){html+='<div class="change"><strong>'+esc(change.targetId)+'</strong><span class="badge">无变化</span></div>';});
    if(result.confirmationRequired&&!result.confirmToken){html+='<label class="ack"><input type="checkbox" id="ack"> 我理解 reload / restart 等高风险影响</label>';}
    html+='<div class="modal-actions"><button class="secondary" id="modalCancel">返回修改</button><button class="primary" id="modalConfirm">'+(result.confirmationRequired&&!result.confirmToken?'确认影响并重新预检':'确认落盘')+'</button></div>';
    byId("modal").innerHTML=html;byId("overlay").classList.add("open");
  }
  function stageChanges(){
    var changes=Object.keys(drafts).sort().map(function(id){return drafts[id];});if(!changes.length){return;}
    post("/api/fleet/changes/stage",{changes:changes}).then(function(result){showCanonical(result);}).catch(showModalError);
  }
  function confirmCanonical(){
    if(!staged){return;}
    if(staged.confirmationRequired&&!staged.confirmToken){
      var ack=byId("ack");if(!ack||!ack.checked){showModalError(new Error("请先确认高风险影响"));return;}
      var previous=canonicalKey(staged.batch);var changes=Object.keys(drafts).sort().map(function(id){return drafts[id];});
      post("/api/fleet/changes/stage",{changes:changes,acknowledged:true}).then(function(result){
        if(!result.confirmToken){throw new Error("后端未签发确认令牌");}
        if(canonicalKey(result.batch)!==previous){showCanonical(result,"真源在确认期间发生变化，请重新核对旧值与新值。",result.batch.acknowledgementRequired);return;}
        staged=result;applyCanonical();
      }).catch(showModalError);return;
    }
    applyCanonical();
  }
  function applyCanonical(){
    if(!staged||!staged.confirmToken){return;}
    var batch=staged.batch;post("/api/fleet/changes/apply",{batch:batch,confirmToken:staged.confirmToken,acknowledged:true}).then(function(result){renderProgress(result);if(result.status==="running"){watchProgress(result.batchId);}else{finishProgress(result);}}).catch(showModalError);
  }
  function statusLabel(status){var labels={pending:"等待",applying:"写入中",accepted:"后台执行",applied:"已落盘",no_op:"无变化",rejected:"失败",rolled_back:"已回滚",partial:"部分完成"};return labels[status]||status;}
  function renderProgress(progress){
    var html='<h2>落盘进度</h2><div class="help">batch '+esc(progress.batchId)+'</div>';
    (progress.items||[]).forEach(function(item){html+='<div class="progress-item"><div><strong>'+esc(item.targetId)+'</strong>'+(item.reason?'<div class="reason">'+esc(item.reason)+'</div>':'')+'</div><span>'+esc(statusLabel(item.status))+'</span></div>';});
    html+='<div id="terminalMessage"></div><div class="modal-actions"><button class="primary" id="progressClose" disabled>完成</button></div>';byId("modal").innerHTML=html;
  }
  function finishProgress(progress){
    renderProgress(progress);var terminal=byId("terminalMessage");var close=byId("progressClose");
    if(progress.status==="applied"){terminal.className="terminal-ok";terminal.textContent="已成功落盘";}
    else if(progress.status==="partially-applied"){terminal.className="terminal-partial";terminal.textContent="部分成功：请查看每项状态与回滚结果";}
    else{terminal.className="terminal-failed";terminal.textContent="提交失败：未成功项保持可诊断状态";}
    close.disabled=false;if(progressStream){progressStream.close();progressStream=null;}
  }
  function watchProgress(batchId){
    if(progressStream){progressStream.close();}progressStream=new EventSource("/api/fleet/progress");
    progressStream.addEventListener("progress",function(event){try{var body=JSON.parse(event.data);var list=body.managementBatches||[];for(var i=0;i<list.length;i++){if(list[i].batchId===batchId){renderProgress(list[i]);if(list[i].terminal){finishProgress(list[i]);}break;}}}catch(error){showModalError(error);}});
    progressStream.onerror=function(){var terminal=byId("terminalMessage");if(terminal){terminal.className="terminal-partial";terminal.textContent="进度连接中断，正在自动重连";}};
  }
  function showModalError(error){
    var message=error&&error.message?error.message:String(error);var existing=byId("modal").innerHTML;byId("modal").innerHTML='<div class="error show">'+esc(message)+'</div>'+existing;byId("overlay").classList.add("open");
  }
  function discard(){drafts={};staged=null;byId("overlay").classList.remove("open");load();}
  function closeProgress(){drafts={};staged=null;byId("overlay").classList.remove("open");load();}

  document.querySelectorAll(".nav-button").forEach(function(button){button.addEventListener("click",function(){document.querySelectorAll(".nav-button").forEach(function(item){item.classList.toggle("active",item===button);});byId("instancesPage").classList.toggle("active",button.dataset.nav==="instances");byId("flagsPage").classList.toggle("active",button.dataset.nav==="flags");});});
  byId("projectSearch").addEventListener("input",renderProjectList);
  byId("projectList").addEventListener("click",function(event){var button=event.target.closest("[data-project]");if(button){selectedProjectId=button.dataset.project;activeTab=selectedProjectId==="__unassigned__"?"cron":selectedProjectId==="__extensions__"?"":"model";renderAll();}});
  byId("detail").addEventListener("click",function(event){var tab=event.target.closest("[data-tab]");if(tab){activeTab=tab.dataset.tab;renderDetail();return;}delegate(event);});
  byId("detail").addEventListener("change",delegate);byId("flags").addEventListener("click",delegate);byId("flags").addEventListener("change",delegate);
  byId("stage").addEventListener("click",stageChanges);byId("flagStage").addEventListener("click",stageChanges);byId("discard").addEventListener("click",discard);byId("flagDiscard").addEventListener("click",discard);
  byId("overlay").addEventListener("click",function(event){if(event.target.id==="modalCancel"){byId("overlay").classList.remove("open");}if(event.target.id==="modalConfirm"){confirmCanonical();}if(event.target.id==="progressClose"){closeProgress();}});
  load();
})();
</script>
</body>
</html>`;

export function getFleetConsoleHtml(): string {
	return (
		MANAGEMENT_CONSOLE_HEAD +
		MANAGEMENT_CONSOLE_STATE_JS +
		MANAGEMENT_CONSOLE_APP
	);
}
