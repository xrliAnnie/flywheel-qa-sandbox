/**
 * Flywheel management console.
 *
 * The page intentionally has one read boundary (the versioned management
 * snapshot) and one write boundary (stage -> server canonical confirmation ->
 * apply). Every project, role, DAG, cron, flag, model choice, and extension is
 * rendered from the snapshot; this file contains no copied fleet inventory.
 */

import { MANAGEMENT_SCHEMA_VERSION } from "./management-console-contract.js";

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
var ENG_NODE_TYPES=["design","implement","qa"];
var NODE_MIN=76;
var NODE_MAX=118;
var NODE_GAP_RATIO=.28;
var NODE_GRAPH_PADDING=12;
function templateKind(graph){
  if(!graph||!Array.isArray(graph.nodes)){return "product";}
  return graph.nodes.some(function(node){return ENG_NODE_TYPES.indexOf(node.type)>=0;})?"engineering":"product";
}
function maxChainLen(dags){
  return Math.max(1,(dags||[]).reduce(function(maximum,dag){
    return dag&&dag.graph&&Array.isArray(dag.graph.nodes)?Math.max(maximum,dag.graph.nodes.length):maximum;
  },0));
}
function nodeMetrics(maxChain,availW){
  var chain=Math.max(1,Math.floor(Number(maxChain)||1));
  var inner=Math.max(0,(Number(availW)||0)-NODE_GRAPH_PADDING*2);
  var fitted=Math.floor(inner/(chain+NODE_GAP_RATIO*(chain-1)));
  var NW=Math.min(NODE_MAX,Math.max(NODE_MIN,fitted));
  var GAP=Math.round(NW*NODE_GAP_RATIO);
  var perRow=chain;
  if(fitted<NODE_MIN){perRow=Math.max(1,Math.min(chain,Math.floor((inner+GAP)/(NW+GAP))));}
  return {NW:NW,GAP:GAP,perRow:perRow};
}
function flagDisplayValue(value){return typeof value==="boolean"?(value?"开":"关"):String(value);}
function flagReading(flag,current){
  var defaultText=flagDisplayValue(flag.default);
  if(current===null){return {state:"未知",text:"这个 flag 当前读不到值。",tone:"unknown",tail:"无法与默认比较(默认 "+defaultText+")"};}
  var currentText=flagDisplayValue(current);
  var same=stableUiValue(current)===stableUiValue(flag.default);
  var tail=same?"维持默认":"已偏离默认(默认 "+defaultText+")";
  if(flag.valueKind!=="bool"){
    return {state:currentText,text:"当前取值 "+currentText+"(默认 "+defaultText+")。这不是开关,是一个数值/枚举。",tone:same?"normal":"changed",tail:tail};
  }
  if(flag.onMeans===null){return {state:"读不到",text:"这条 flag 没有登记「打开代表什么」(registry 缺项),这里不猜。",tone:"unknown",tail:tail};}
  if(flag.onMeans==="disables"){
    return current?
      {state:"开",text:"这是一个【停用开关】,现在已经打开 —— 它管的那件事已经被停掉了。",tone:"changed",tail:tail}:
      {state:"关",text:"这是一个【停用开关】,现在没有打开 —— 它管的那件事照常在跑。",tone:"normal",tail:tail};
  }
  if(flag.polarity==="default_on"){
    return current?
      {state:"开",text:"这个功能正常运行中(默认就是开着的)。",tone:"normal",tail:tail}:
      {state:"关",text:"这个功能已经被关掉了 —— 默认是开着的,现在被关了。",tone:"changed",tail:tail};
  }
  if(flag.polarity==="opt_in"){
    return current?
      {state:"开",text:"这个功能已经启用 —— 默认是关着的,现在打开了。",tone:"changed",tail:tail}:
      {state:"关",text:"这个功能没有启用(默认就是关着的)。",tone:"normal",tail:tail};
  }
  return {state:"读不到",text:"这条 flag 没有登记「打开代表什么」(registry 缺项),这里不猜。",tone:"unknown",tail:tail};
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
:root{--ink:#202124;--muted:#777982;--line:#e4e6ec;--paper:#fff;--wash:#f7f8fb;--bg:#eef0f4;--blue:#5646d6;--blue-wash:#ecebfb;--green:#248a3d;--amber:#b35c00;--red:#c62828;--nav:#f7f8fb}
*{box-sizing:border-box}html,body{height:100vh;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);overflow:hidden;padding:18px;font-size:13px}
button,input,select{font:inherit}.window-frame{height:calc(100vh - 36px);min-height:0;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 48px rgba(38,43,61,.14),0 2px 8px rgba(38,43,61,.06);overflow:hidden;display:grid;grid-template-rows:34px minmax(0,1fr)}.window-chrome{background:#f6f6f8;border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 11px;color:var(--muted);font-size:11px}.traffic-lights{display:flex;gap:7px}.traffic-dot{width:11px;height:11px;border-radius:50%;display:block}.traffic-dot.red{background:#ff5f57}.traffic-dot.amber{background:#febc2e}.traffic-dot.green{background:#28c840}.chrome-title{font-weight:650;color:#565860}.source-health{justify-self:end;background:#fff;border:1px solid #e2e3e8;border-radius:999px;padding:3px 8px;white-space:nowrap}.app{display:grid;grid-template-columns:158px minmax(0,1fr);height:100%;min-height:0}.side{background:#f7f8fb;color:var(--ink);padding:16px 10px;display:flex;flex-direction:column;gap:4px;border-right:1px solid var(--line)}.brand{font-size:16px;font-weight:760;padding:2px 10px 15px;letter-spacing:-.01em}.brand small{display:block;color:var(--muted);font-size:10px;font-weight:550;margin-top:2px}.nav-button{position:relative;border:0;background:transparent;color:#62646d;text-align:left;padding:9px 10px 9px 14px;border-radius:8px;cursor:pointer;font-size:12px}.nav-button.active{background:#ecebfb;color:#5646d6;font-weight:700}.nav-button.active:before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--blue)}
.workspace{min-width:0;display:grid;grid-template-rows:minmax(0,1fr);overflow:hidden}.page{height:100%;display:none}.page.active{display:grid}.page:not(.active){display:none}.instances{grid-template-columns:210px minmax(0,1fr)}.project-rail{background:#fcfcfd;border-right:1px solid var(--line);padding:13px 11px;overflow:auto}.search{width:100%;border:1px solid #dfe1e7;border-radius:7px;padding:7px 9px;background:#fff;margin-bottom:10px;font-size:12px;outline:none}.search:focus{border-color:#9f96e8;box-shadow:0 0 0 2px rgba(86,70,214,.1)}.group-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#92949d;margin:13px 7px 5px}.project-button{width:100%;border:0;background:transparent;text-align:left;padding:8px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:7px;color:#45474f;font-size:12px}.project-button:hover{background:#f2f2f6}.project-button.active{background:var(--blue-wash);color:var(--blue);font-weight:650}.project-name{overflow:hidden;text-overflow:ellipsis}.badge{display:inline-block;padding:2px 6px;border-radius:20px;background:#eeeef2;color:#666872;font-size:10px;white-space:nowrap;font-weight:550}
.detail,.flags-page{min-width:0;overflow:auto;display:flex;flex-direction:column;background:#fff}.detail-inner,.flags-inner{padding:16px 19px 92px}.topline{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.topline h1{font-size:21px;line-height:1.2;letter-spacing:-.025em;margin:0 0 4px}.subtitle,.reason,.help,.empty{color:var(--muted);font-size:12px;line-height:1.45}.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:15px 0 14px;overflow:auto}.tab{border:0;background:transparent;padding:8px 10px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;color:#656771;font-size:12px}.tab.active{border-color:var(--blue);color:var(--blue);font-weight:700}.panel{display:none}.panel.active{display:block}.section-title{font-size:12px;text-transform:uppercase;letter-spacing:.055em;color:#70727b;margin:17px 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:9px}.cron-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:9px}.card{background:var(--paper);border:1px solid #e5e6eb;border-radius:9px;padding:11px 12px;box-shadow:0 1px 2px rgba(30,34,48,.025)}.card h3{font-size:13px;margin:0 0 3px}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.lead-list{border:1px solid #e5e6eb;border-radius:9px;overflow:hidden;background:#fff}.lead-row{display:grid;grid-template-columns:minmax(145px,.55fr) minmax(420px,1.45fr);gap:14px;align-items:center;padding:10px 12px;border-top:1px solid #ececf0}.lead-row:first-child{border-top:0}.lead-meta h3{font-size:13px;margin:0 0 2px}.lead-meta .inline{justify-content:space-between}.status{width:7px;height:7px;border-radius:50%;background:#8e8e93;flex:0 0 auto}.status.online{background:#34c759}.status.degraded{background:#ff9500}.status.offline{background:#ff3b30}.field{margin-top:9px}.lead-row .field{margin-top:0}.field label{display:block;color:var(--muted);font-size:10px;margin-bottom:4px}.field select,.field input{width:100%;min-width:0;border:1px solid #d7d8de;border-radius:7px;background-color:#fff;padding:6px 7px;color:#32343a}.field select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#858791 50%),linear-gradient(135deg,#858791 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-repeat:no-repeat;background-size:4px 4px;padding-right:28px}.field select:disabled,.field input:disabled{opacity:.58}.three{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr) minmax(0,.65fr);gap:7px}.lead-row .three{grid-template-columns:minmax(132px,.9fr) minmax(170px,1.2fr) minmax(96px,.65fr)}.grid .card .three{grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)}.grid .card .model-effort{grid-column:1/-1}.model-provider,.model-model,.model-effort{min-width:0}.role-error{color:var(--red);font-size:11px;line-height:1.45}.dag-flow{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:10px 0 4px}.dag-step{border:1px solid #dcdee5;border-radius:7px;background:#fff;padding:4px 8px;font-size:11px;font-weight:650}.dag-arrow{color:#a2a4ad}.dag-row{display:grid;grid-template-columns:minmax(88px,.2fr) minmax(0,1fr);gap:12px;align-items:center;border-top:1px dashed #e2e3e8;padding:6px 0}.dag-row strong{font-size:12px}.dag-row .field{min-width:0;margin:0}.dag-row .field>label{display:none}.day-row,.time-row,.inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.cron-card .day-row{gap:4px;flex-wrap:nowrap}.day{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:1px solid #d7d8de;background:#fff;border-radius:6px;padding:0;cursor:pointer;font-size:11px;font-weight:650}.day.on{background:var(--blue);border-color:var(--blue);color:#fff}.time-row{margin-top:6px}.time-row input{width:62px}.mini-button{border:1px solid #d7d8de;background:#fff;border-radius:6px;padding:4px 7px;cursor:pointer;font-size:11px}.toggle{border:1px solid #cbccd2;background:#f0f0f3;border-radius:20px;padding:4px 9px;cursor:pointer;font-size:11px}.toggle.on{background:#e4f6e8;color:#176f30;border-color:#b8ddc0}.toggle:disabled,.mini-button:disabled{opacity:.5;cursor:default}.warning{color:var(--amber);font-size:11px;margin-top:6px}.error{background:#ffebea;color:#9f1717;padding:8px 10px;border-radius:7px;margin:8px 0;font-size:12px;display:none}.error.show{display:block}.group-note{background:#f7f6ff;border:1px solid #e2def9;color:#625b8d;border-radius:8px;padding:9px 11px;margin:10px 0 12px;font-size:12px}
.lay{display:grid;gap:14px;align-items:start}.lay-v2{grid-template-columns:216px minmax(0,1fr)}.side-box{border:1px solid #e5e6eb;border-radius:10px;background:#fff;overflow:hidden}.side-h{padding:8px 11px;background:#f8f8fa;border-bottom:1px solid #e5e6eb;font-size:11px;font-weight:750;letter-spacing:.05em;color:#5a5c63}.ic-col{display:flex;flex-direction:column;gap:6px;padding:10px}.ic{display:flex;align-items:center;gap:9px;border:1px solid #e4e6ec;border-left:3px solid #c9cbd4;border-radius:9px;background:#fff;padding:8px 9px}.ic-t{min-width:0}.ic-n{display:block;font-size:12px;font-weight:700;color:#202124;line-height:1.25}.ic-f{display:block;margin-top:2px;font-size:9.5px;color:#8a8c96;font-family:"SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.ic-link{text-decoration:none;color:inherit;cursor:pointer}.ic-link:hover{filter:brightness(.985);box-shadow:0 1px 4px rgba(30,34,48,.12)}.ic-go{margin-left:auto;flex:none;font-size:11px;color:#5a5c63;opacity:.5}.ic-link:hover .ic-go{opacity:1}.seg{display:inline-flex;gap:2px;background:#eeeef2;border-radius:9px;padding:3px;margin-bottom:10px}.seg-b{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;border-radius:7px;padding:6px 13px;cursor:pointer;font-size:12.5px;color:#5a5c63}.seg-b.on{background:#fff;color:var(--ch,#5646d6);font-weight:700;box-shadow:0 1px 2px rgba(30,34,48,.12)}.seg-b .cdot{width:8px;height:8px;border-radius:3px;background:var(--ch,#5646d6);opacity:.45}.seg-b.on .cdot{opacity:1}.seg-b .ccount{font-size:10px;font-weight:700;color:#8a8c96;background:#f4f4f7;border-radius:999px;padding:1px 6px}.seg-b.on .ccount{background:#f0eefb;color:var(--ch,#5646d6)}.stack{display:flex;flex-direction:column;gap:10px}.squad{position:relative;border:1px solid #e5e6eb;border-left:3px solid var(--sq,#c9cbd4);border-radius:10px;background:#fff;padding:10px 11px}.squad-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px}.squad-h b{font-size:13px}.squad-sub{font-size:10.5px;color:#8a8c96;font-family:"SFMono-Regular",Consolas,monospace}.lay .dag-scroll{padding:6px 0 2px;position:relative;overflow-x:hidden}.dag-graphwrap{position:relative}.dag-graph{display:block}.dag-chips{position:absolute;inset:0;pointer-events:none}.dag-chip{position:absolute;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;border-radius:6px;border:1px solid #e4e6ec;background:#fff;padding:0 8px}.dag-chip .dc-n{font-size:12px;font-weight:600;line-height:1.2;color:#202124}.dag-chip .dc-f{font-size:9px;color:#767883;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-family:"SFMono-Regular",Consolas,monospace}.dag-chip.design{background:#f1efff;border-color:#d4cff7}.dag-chip.implement{background:#eef7ff;border-color:#c8e3f7}.dag-chip.qa{background:#eef9f1;border-color:#c8e8d1}.dag-chip.gate{background:#fff6e6;border-color:#f0dcb4}.dag-chip.land{background:#f7f8fb}.lay-note{background:#f2f0fd;border-radius:8px;padding:8px 11px;font-size:11.5px;color:#403699;margin-bottom:10px}.graph-warning{color:var(--amber);font-size:11px;margin:5px 0}
.flag-sum{display:flex;gap:16px;align-items:center;background:#f7f8fb;border:1px solid var(--line);border-radius:8px;padding:9px 14px;margin-top:12px;font-size:12.5px;flex-wrap:wrap}.flag-sum b{font-variant-numeric:tabular-nums}.flag-sum .ok{color:#1f9d4d}.flag-sum .ro{color:#86868b}.flag-legend{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-top:8px}.fl-t{font-size:12px;font-weight:600;margin-bottom:6px}.fl-i{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;margin:0 14px 3px 0;color:#3c3c43}.fl-i i{width:8px;height:8px;border-radius:2px;background:var(--lc);display:block}.fl-n{font-size:11px;color:#9a9aa2;margin-top:4px}.flag-head,.flag-row{display:grid;grid-template-columns:224px minmax(0,1fr) 232px 116px;gap:12px;align-items:center}.flag-head{padding:8px 4px 6px 12px;font-size:9px;font-weight:700;color:#9a9aa2;letter-spacing:.1em;text-transform:uppercase;border-bottom:2px solid var(--line);border-left:3px solid transparent}.flag-group{margin-top:10px;border:1px solid #e5e6eb;border-radius:9px;overflow:visible;background:#fff}.flag-group-title{display:flex;align-items:center;gap:7px;margin:0;padding:8px 10px;background:#f8f8fa;border-bottom:1px solid #e5e6eb;font-size:12px;font-weight:700}.flag-count{border:1px solid #e1e2e7;border-radius:999px;background:#fff;color:var(--muted);padding:1px 6px;font-size:10px;font-variant-numeric:tabular-nums}.flag-row{padding:9px 4px 9px 12px;border-bottom:1px solid #f0f0f4;border-left:3px solid var(--lc);position:relative}.flag-row.rw{background:#f4fbf6}.flag-name{font-family:"SFMono-Regular",Consolas,monospace;font-size:11px;font-weight:620;overflow-wrap:anywhere}.flag-copy{min-width:0}.flag-read{font-size:12.5px;line-height:1.45;color:#2c2d33}.flag-read[data-tone="changed"]{color:#8a4b00;font-weight:600}.flag-read[data-tone="unknown"]{color:#b3271e}.flag-tail{display:inline-block;margin-top:4px;font-size:10px;font-weight:650;border-radius:999px;padding:1px 7px;background:#f1f1f5;color:#6b6d76}.flag-copy .help{margin-top:5px;font-size:11px;color:#9a9aa2}.flag-global{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.flag-rw{font-size:10px;font-weight:700;color:#1f9d4d;background:#fff;border:1px solid #cfead9;border-radius:999px;padding:1px 7px}.lock-chip{font-size:10.5px;font-weight:600;color:var(--lc);background:#fff;border:1px solid var(--lc);border-radius:999px;padding:2px 9px;cursor:pointer;white-space:nowrap}.why-tip{position:absolute;left:12px;right:12px;top:calc(100% - 3px);background:#2b2b30;color:#fff;border-radius:8px;padding:9px 12px;z-index:30;box-shadow:0 6px 20px rgba(0,0,0,.22)}.wt-h{font-size:11.5px;font-weight:600}.wt-r{font-size:10.5px;opacity:.76;margin-top:5px;font-family:"SFMono-Regular",Consolas,monospace;word-break:break-word}.flag-ovs{text-align:right}.ov-pill{background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:10.5px;color:#3c3c43;cursor:pointer;font-weight:600}.ov-pill.open{background:#ecebfb;border-color:#d6d1f5;color:#5646d6}.ov-none{font-size:10.5px;color:#c8c8d0}.ov-body{display:none;padding:8px 12px 10px 240px;background:#fafafc;border-bottom:1px solid #f0f0f4}.ov-body.open{display:block}.ov-hint{font-size:11px;color:#b26a00;background:#fff6e6;border-radius:6px;padding:5px 9px;margin-bottom:6px}.flag-override{display:inline-flex;align-items:center;gap:5px;color:#8a5a00;font-size:10px;margin-right:14px}.flag-project{font-family:"SFMono-Regular",Consolas,monospace}.flag-switch{position:relative;width:36px;height:21px;display:inline-block;flex:none;border:0;border-radius:999px;background:#cfd1d7;padding:0;cursor:pointer;transition:background .15s}.flag-switch.on{background:#34c759}.flag-switch:after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.24);transition:transform .15s}.flag-switch.on:after{transform:translateX(15px)}.flag-switch:disabled{opacity:.55;cursor:default}.extension-row{display:grid;grid-template-columns:minmax(180px,1.4fr) minmax(160px,1fr);gap:14px;align-items:center;background:#fff;border:1px solid #e5e6eb;border-radius:9px;padding:11px 12px;margin-top:7px}.order-list{display:flex;flex-direction:column;gap:5px}.order-item{display:flex;align-items:center;justify-content:space-between;border:1px solid #ddd;border-radius:7px;padding:6px 8px}
.pending{position:sticky;bottom:0;z-index:20;margin-top:auto;background:#34304f;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:9px;box-shadow:0 -6px 20px rgba(0,0,0,.12)}.pending.hidden{display:none}.pending .summary{margin-right:auto}.primary,.secondary{border:0;border-radius:7px;padding:7px 11px;cursor:pointer;font-weight:650}.primary{background:#fff;color:#34304f}.secondary{background:transparent;color:#dedbef}.primary:disabled{opacity:.5;cursor:default}
.overlay{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.38);display:none;align-items:center;justify-content:center;padding:20px}.overlay.open{display:flex}.modal{background:#fff;border-radius:14px;width:min(700px,100%);max-height:85vh;overflow:auto;padding:22px}.modal h2{font-size:19px;margin:0}.change{background:var(--wash);border-radius:9px;padding:10px;margin-top:8px}.change-values{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:start;margin-top:6px}.value{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.old{text-decoration:line-through;color:var(--muted)}.consequence{color:var(--amber);font-size:12px;margin-top:6px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.modal-actions .primary{background:var(--blue);color:#fff}.ack{background:#fff6e8;color:#6f4200;padding:10px;border-radius:8px;margin-top:12px}.progress-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;border-top:1px solid #eee;padding:9px 0}.terminal-ok{color:var(--green)}.terminal-partial{color:var(--amber)}.terminal-failed{color:var(--red)}
@media(max-width:1050px){.lead-row{grid-template-columns:1fr}.three,.lead-row .three{grid-template-columns:1fr}.grid .card .model-effort{grid-column:auto}}
@media(max-width:780px){body{overflow:auto;padding:0}.window-frame{height:auto;min-height:100vh;border:0;border-radius:0}.window-chrome{position:sticky;top:0;z-index:40}.app{grid-template-columns:1fr;height:auto;min-height:calc(100vh - 34px)}.side{position:sticky;top:34px;z-index:30;flex-direction:row;padding:8px}.brand{padding:7px;margin-right:auto}.brand small{display:none}.instances{grid-template-columns:1fr}.project-rail{border-right:0;border-bottom:1px solid var(--line);max-height:250px}.page,.detail,.flags-page{height:auto;overflow:visible}.pending{position:sticky}.dag-row,.flag-row,.extension-row{grid-template-columns:1fr}.dag-row .three,.cron-grid .three{grid-template-columns:1fr}.flag-head{display:none}.ov-body{padding-left:12px}.cron-card .day-row{flex-wrap:wrap}}
</style>
</head>
<body>
<div class="window-frame">
<header class="window-chrome">
  <div class="traffic-lights" aria-hidden="true"><span class="traffic-dot red"></span><span class="traffic-dot amber"></span><span class="traffic-dot green"></span></div>
  <div class="chrome-title">Flywheel 管理台</div>
  <div class="source-health" id="sourceHealth">正在读取真实状态…</div>
</header>
<div class="app">
  <aside class="side">
    <div class="brand">Flywheel<small>MANAGEMENT</small></div>
    <button class="nav-button active" data-nav="instances">实例</button>
    <button class="nav-button" data-nav="flags">Feature Flags</button>
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
</div>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
`;

const MANAGEMENT_CONSOLE_APP = `
(function(){
  "use strict";
  var expectedSchemaVersion=${MANAGEMENT_SCHEMA_VERSION};
  var snapshot=null;
  var drafts={};
  var targetIndex={};
  var selectedProjectId="";
  var selectedGroupId="";
  var activeTab="model";
  var staged=null;
  var progressStream=null;
  var weekNames=["一","二","三","四","五","六","日"];
  var kindTab="product";
  var _availW=0;
  var _relayouting=false;
  var _resizeTimer=null;
  var DAG_RAIL=["#c2456f","#5646d6","#0d9488","#d97706"];

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
  function presentationGroupById(id){
    if(!snapshot){return null;}for(var i=0;i<snapshot.presentationGroups.length;i++){if(snapshot.presentationGroups[i].id===id){return snapshot.presentationGroups[i];}}return null;
  }
  function selectedPresentationGroup(){return presentationGroupById(selectedGroupId);}
  function derivedLeadIdMap(){
    var ids={};if(!snapshot){return ids;}snapshot.presentationGroups.forEach(function(group){if(group.derived){group.leadIds.forEach(function(id){ids[id]=true;});}});return ids;
  }
  function visibleProjectLeads(project){var derived=derivedLeadIdMap();return project.leads.filter(function(lead){return !derived[lead.id];});}
  function derivedGroupLabels(project){
    if(!snapshot){return [];}return snapshot.presentationGroups.filter(function(group){return group.derived&&group.projectIds.indexOf(project.id)>=0;}).map(function(group){return group.label;});
  }
  function groupLeads(group){
    var leads={};allProjects().forEach(function(project){project.leads.forEach(function(lead){leads[lead.id]=lead;});});
    return group.leadIds.map(function(id){return leads[id];}).filter(Boolean);
  }
  function firstProjectId(){return allProjects().length?allProjects()[0].id:(snapshot&&snapshot.unassignedCrons.length?"__unassigned__":"");}

  function requestJson(path,options){
    return fetch(path,options).then(function(response){return response.json().catch(function(){return {};}).then(function(body){if(!response.ok){throw new Error(body.error||("请求失败 "+response.status));}return body;});});
  }
  function load(){
    return requestJson("/api/fleet/snapshot").then(function(next){
      if(next.schemaVersion!==expectedSchemaVersion){throw new Error("管理台已更新,请刷新页面");}
      snapshot=next;
      rebuildIndex();
      if(selectedGroupId&&!presentationGroupById(selectedGroupId)){selectedGroupId="";}
      if(!selectedGroupId&&!projectById(selectedProjectId)&&selectedProjectId!=="__unassigned__"&&selectedProjectId!=="__extensions__"){selectedProjectId=firstProjectId();}
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
    snapshot.presentationGroups.filter(function(group){return !group.derived;}).forEach(function(group){
      var visible=group.projectIds.map(function(id){return projectsById[id];}).filter(function(project){return project&&project.name.toLowerCase().indexOf(query)>=0;});
      if(!visible.length){return;}
      html+='<div class="group-title">'+esc(group.label)+'</div>';
      visible.forEach(function(project){
        html+='<button class="project-button '+(!selectedGroupId&&project.id===selectedProjectId?'active':'')+'" data-project="'+esc(project.id)+'"><span class="project-name">'+esc(project.name)+'</span><span class="badge">'+visibleProjectLeads(project).length+' Lead</span></button>';
      });
    });
    var visibleGroups=snapshot.presentationGroups.filter(function(group){return group.derived&&group.label.toLowerCase().indexOf(query)>=0;});
    if(visibleGroups.length){
      html+='<div class="group-title">分组</div>';
      visibleGroups.forEach(function(group){html+='<button class="project-button '+(group.id===selectedGroupId?'active':'')+'" data-group="'+esc(group.id)+'"><span class="project-name">'+esc(group.label)+'</span><span class="badge">'+group.leadIds.length+' Lead</span></button>';});
    }
    var grouped={};
    snapshot.presentationGroups.filter(function(group){return !group.derived;}).forEach(function(group){group.projectIds.forEach(function(id){grouped[id]=true;});});
    var other=snapshot.projects.filter(function(project){return !grouped[project.id]&&project.name.toLowerCase().indexOf(query)>=0;});
    if(other.length){
      html+='<div class="group-title">其他</div>';
      other.forEach(function(project){html+='<button class="project-button '+(!selectedGroupId&&project.id===selectedProjectId?'active':'')+'" data-project="'+esc(project.id)+'"><span class="project-name">'+esc(project.name)+'</span><span class="badge">'+visibleProjectLeads(project).length+' Lead</span></button>';});
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
  function selectedModel(provider,value,canonicalModel){
    if(!provider){return null;}var id=canonicalModel||(value&&value.model);for(var i=0;i<provider.models.length;i++){if(provider.models[i].id===id){return provider.models[i];}}
    return null;
  }
  function option(id,label,chosen){return '<option value="'+esc(id)+'" '+(id===chosen?'selected':'')+'>'+esc(label)+'</option>';}
  function modelControl(managed,surface,label,providerLocked,selectionNullable){
    var value=effective(managed);var catalog=catalogFor(surface);var writableTarget=writable(managed);
    if(!catalog.providers.length){return '<div class="field"><label>'+esc(label)+'</label><div class="reason">真实 registry 在此层没有可用型号</div>'+capability(managed)+'</div>';}
    if(!value&&!selectionNullable){return '<div class="field"><label>'+esc(label)+'</label><div class="reason">当前真源没有声明具体模型</div>'+capability(managed)+'</div>';}
    var provider=value?selectedProvider(catalog,value):(providerLocked?catalog.providers[0]:null);
    var currentSpelling=managed.current&&managed.current.model;var displayCanonical=value&&value.model===currentSpelling?managed.canonicalModel:null;
    var model=value&&provider?selectedModel(provider,value,displayCanonical):null;
    var providers=(!providerLocked&&selectionNullable?'<option value="" '+(!provider?'selected':'')+'>账户默认</option>':'')+catalog.providers.map(function(item){return option(item.id,item.label,provider&&provider.id);}).join("");
    var retiredModel=value&&provider&&!model&&value.model?'<option value="'+esc(value.model)+'" selected>已退役 · '+esc(value.model)+'</option>':'';
    var models=(selectionNullable?'<option value="" '+(!value?'selected':'')+'>账户默认</option>':'')+retiredModel+(provider?provider.models.map(function(item){return option(item.id,item.label,model&&model.id);}).join(""):"");
    var efforts='<option value="" '+(!value||value.effort==null?'selected':'')+'>账户默认</option>'+(model?model.efforts.map(function(item){return option(item,item,value&&value.effort);}).join(""):"");
    var providerDisabled=providerLocked||!writableTarget?' disabled':'';
    var modelDisabled=!writableTarget||!provider?' disabled':'';
    var effortDisabled=!writableTarget||!model?' disabled':'';
    return '<div class="field" data-model-target="'+esc(managed.targetId)+'" data-model-nullable="'+(selectionNullable?'true':'false')+'"><label>'+esc(label)+'</label><div class="three"><select class="model-provider" data-model-part="provider" data-surface="'+esc(surface)+'"'+providerDisabled+'>'+providers+'</select><select class="model-model" data-model-part="model" data-surface="'+esc(surface)+'"'+modelDisabled+'>'+models+'</select><select class="model-effort" data-model-part="effort" data-surface="'+esc(surface)+'"'+effortDisabled+'>'+efforts+'</select></div>'+capability(managed)+'</div>';
  }
  function roleHref(role){
    var url=role&&role.sourceLink;
    return url&&String(url).indexOf("https://github.com/")===0?String(url):"";
  }
  function icCard(role){
    var body='<span class="ic-t"><span class="ic-n">'+esc(role.name)+'</span><span class="ic-f">'+esc(role.agentFile)+'</span>'+(role.error?'<span class="role-error">'+esc(role.error)+'</span>':'')+'</span>';
    var href=roleHref(role);
    if(!href){return '<div class="ic" data-role="'+esc(role.id)+'" title="后端没有给这个角色可验证的仓库链接">'+body+'</div>';}
    return '<a class="ic ic-link" data-role="'+esc(role.id)+'" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer" title="在 GitHub 上打开 '+esc(role.agentFile)+'">'+body+'<span class="ic-go">↗</span></a>';
  }
  function rosterBox(project){
    var roles=project.roles||[];
    var body=roles.length?roles.map(icCard).join(""):'<div class="empty">这个项目没有角色卡</div>';
    return '<div class="side-box"><div class="side-h">花名册 · '+roles.length+' 人</div><div class="ic-col">'+body+'</div></div>';
  }
  function renderLeadRows(leads,emptyMessage){
    if(!leads.length){return '<div class="empty">'+esc(emptyMessage||"未发现 Lead")+'</div>';}
    return '<div class="lead-list">'+leads.map(function(lead){return '<article class="lead-row"><div class="lead-meta"><div class="inline"><h3>'+esc(lead.displayName)+'</h3><span class="status '+esc(lead.online)+'"></span></div><div class="subtitle">'+esc(lead.department||lead.backend)+'</div></div>'+modelControl(lead.dispatch,"lead","公司 → 型号 → effort",true,true)+'</article>';}).join("")+'</div>';
  }
  function renderModelPanel(project){
    var leads=visibleProjectLeads(project);var labels=derivedGroupLabels(project);var groupedCount=project.leads.length-leads.length;
    var groupNote=labels.length?'<div class="group-note">该项目的 Lead 统一展示在 '+esc(labels.join(" / "))+'（'+groupedCount+' 个）</div>':"";
    var emptyMessage=labels.length?"项目没有未分组 Lead":"项目没有声明 Lead";
    var html='<div class="panel '+(activeTab==="model"?'active':'')+'" data-panel="model"><h2 class="section-title">Lead 模型</h2>'+groupNote+renderLeadRows(leads,emptyMessage)+'<h2 class="section-title">Runner 默认</h2>';
    html+=project.runnerDefault?'<div class="grid"><article class="card"><h3>'+esc(project.name)+'</h3>'+modelControl(project.runnerDefault.dispatch,"runner","公司 → 型号 → effort",false,true)+'</article></div>':'<div class="empty">项目没有声明 Runner 默认模型</div>';
    html+='</div>';return html;
  }
  function safeMarkerPart(value){return String(value).replace(/[^A-Za-z0-9_-]/g,"_");}
  function dagGraph(cardKey,templateId,graph,M){
    var nodes=graph.nodes||[];
    if(!nodes.length){return '<div class="reason">这个模板没有节点。</div>';}
    var NW=M.NW,GAP=M.GAP,per=Math.max(1,M.perRow),NH=46;
    var rows=Math.ceil(nodes.length/per),rowH=NH+22;
    function col(index){return index%per;}function row(index){return Math.floor(index/per);}
    function x(index){return NODE_GRAPH_PADDING+col(index)*(NW+GAP);}function y(index){return NODE_GRAPH_PADDING+row(index)*rowH;}
    function cx(index){return x(index)+NW/2;}function cy(index){return y(index)+NH/2;}
    var positions={};nodes.forEach(function(node,index){positions[node.id]={index:index,x:x(index),y:y(index)};});
    var cols=Math.min(nodes.length,per);
    var width=NODE_GRAPH_PADDING*2+cols*NW+(cols-1)*GAP;
    var loopDepth=graph.loops.length?(graph.loops.length*24+14):0;
    var baseBottom=NODE_GRAPH_PADDING+rows*rowH-22;
    var height=baseBottom+loopDepth+NODE_GRAPH_PADDING;
    var markerId="dm-"+safeMarkerPart(cardKey);
    var missing=0;
    var svg='<svg class="dag-graph" viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'" role="img"><defs><marker id="'+markerId+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#a6a6ad"></path></marker></defs>';
    graph.edges.forEach(function(edge){
      var from=positions[edge.from],to=positions[edge.to];if(!from||!to){missing++;return;}
      if(row(from.index)===row(to.index)){
        svg+='<line data-edge="'+esc(edge.id)+'" data-from="'+esc(edge.from)+'" data-to="'+esc(edge.to)+'" x1="'+(from.x+NW+4)+'" y1="'+cy(from.index)+'" x2="'+(to.x-6)+'" y2="'+cy(to.index)+'" stroke="#d8d8e0" stroke-width="1.5" marker-end="url(#'+markerId+')"></line>';
      }else{
        var fromBottom=from.y+NH;
        svg+='<path data-edge="'+esc(edge.id)+'" data-from="'+esc(edge.from)+'" data-to="'+esc(edge.to)+'" d="M '+cx(from.index)+' '+fromBottom+' C '+cx(from.index)+' '+(fromBottom+14)+', '+cx(to.index)+' '+(to.y-16)+', '+cx(to.index)+' '+(to.y-5)+'" fill="none" stroke="#d8d8e0" stroke-width="1.5" marker-end="url(#'+markerId+')"></path>';
      }
    });
    graph.loops.forEach(function(loop,index){
      var from=positions[loop.from],to=positions[loop.to];if(!from||!to){missing++;return;}
      var depth=baseBottom+12+index*24;
      svg+='<path data-loop="'+esc(loop.id)+'" data-from="'+esc(loop.from)+'" data-to="'+esc(loop.to)+'" d="M '+cx(from.index)+' '+(from.y+NH)+' C '+cx(from.index)+' '+depth+', '+cx(to.index)+' '+depth+', '+cx(to.index)+' '+(to.y+NH+2)+'" fill="none" stroke="#a6a6ad" stroke-width="1.3" marker-end="url(#'+markerId+')"></path>';
    });
    svg+='</svg><div class="dag-chips">';
    nodes.forEach(function(node,index){
      var subtitle=node.execution==="gate"?"人工审批":node.execution==="engine"?"引擎执行":node.type;
      svg+='<div class="dag-chip '+esc(node.type)+'" data-node="'+esc(templateId+"/"+node.id)+'" data-node-type="'+esc(node.type)+'" style="left:'+x(index)+'px;top:'+y(index)+'px;width:'+NW+'px;height:'+NH+'px"><span class="dc-n">'+esc(node.name)+'</span><span class="dc-f">'+esc(subtitle)+'</span></div>';
    });
    svg+='</div>';
    var warning=missing?'<div class="graph-warning">有 '+missing+' 条连线端点读不到</div>':"";
    return '<div class="dag-graphwrap" data-card="'+esc(cardKey)+'" style="width:'+width+'px;height:'+height+'px">'+svg+'</div>'+warning;
  }
  function squadCard(dag,index,M){
    var cardKey=safeMarkerPart(dag.id)+"-"+index;
    var html='<article class="squad" data-template="'+esc(dag.templateId)+'" style="--sq:'+DAG_RAIL[index%DAG_RAIL.length]+'"><div class="squad-h"><b>'+esc(dag.title)+'</b></div><div class="squad-sub">'+esc(dag.templateId)+' · revision '+esc(dag.revision)+'</div>';
    if(dag.error){html+='<div class="role-error">'+esc(dag.error)+'</div>';}
    if(dag.graph){html+='<div class="dag-scroll">'+dagGraph(cardKey,dag.templateId,dag.graph,M)+'</div>';}
    else{
      if(dag.nodes.length){html+='<div class="dag-flow">'+dag.nodes.map(function(node,index2){return (index2?'<span class="dag-arrow">→</span>':'')+'<span class="dag-step">'+esc(node.name)+'</span>';}).join("")+'</div>';}
      html+='<div class="reason">读不到这个模板的完整形状。</div>';
    }
    dag.nodes.forEach(function(node){
      var graphNode=null;if(dag.graph){for(var i=0;i<dag.graph.nodes.length;i++){if(dag.graph.nodes[i].id===node.nodeId){graphNode=dag.graph.nodes[i];break;}}}
      html+='<div class="dag-row"><strong>'+esc(graphNode?graphNode.name:node.name)+'</strong>'+modelControl(node.dispatch,"workflow","stage 模型",false,false)+'</div>';
    });
    return html+'</article>';
  }
  function splitByKind(project){
    var sides={product:[],engineering:[]};
    (project.dags||[]).forEach(function(dag){sides[templateKind(dag.graph)].push(dag);});
    return sides;
  }
  function dagColumns(project){
    var sides=splitByKind(project);if(!sides[kindTab]){kindTab="product";}
    var segment='<div class="seg"><button class="seg-b '+(kindTab==="product"?'on':'')+'" data-kind="product" style="--ch:#c2456f"><span class="cdot"></span>产品<span class="ccount">'+sides.product.length+'</span></button><button class="seg-b '+(kindTab==="engineering"?'on':'')+'" data-kind="engineering" style="--ch:#5646d6"><span class="cdot"></span>工程<span class="ccount">'+sides.engineering.length+'</span></button></div>';
    var metrics=nodeMetrics(maxChainLen(project.dags),_availW);var visible=sides[kindTab];
    return segment+'<div class="stack">'+(visible.length?visible.map(function(dag,index){return squadCard(dag,index,metrics);}).join(""):'<div class="empty">这一类下没有模板</div>')+'</div>';
  }
  function layNote(){return '<div class="lay-note" data-rule="eng-node-types">分类规则：模板里出现 '+ENG_NODE_TYPES.join(" / ")+' 类型的节点就归<b>工程</b>，否则归<b>产品</b> —— 规则从后端数据推，新模板自动归位。</div>';}
  function renderDagPanel(project){
    return '<div class="panel '+(activeTab==="dag"?'active':'')+'" data-panel="dag">'+layNote()+'<div class="lay lay-v2"><aside>'+rosterBox(project)+'</aside><div>'+dagColumns(project)+'</div></div></div>';
  }
  function timePad(value){return String(value).padStart(2,"0");}
  function scheduleEditor(managed){
    var schedule=effective(managed);if(!schedule){return '<div class="field"><label>星期与时间</label><div class="reason">launchd 真源无法解析为受管 weekly schedule</div>'+capability(managed)+'</div>';}
    var disabled=writable(managed)?"":" disabled";
    var days='<div class="day-row">'+weekNames.map(function(name,index){var day=index+1;return '<button class="day '+(schedule.days.indexOf(day)>=0?'on':'')+'" title="周'+name+'" aria-label="周'+name+'" data-schedule-action="day" data-day="'+day+'" data-target="'+esc(managed.targetId)+'"'+disabled+'>'+name+'</button>';}).join("")+'<span class="badge">'+esc(scheduleLabel(schedule.days))+'</span></div>';
    var removeDisabled=!writable(managed)||(schedule.times||[]).length<=1?' disabled':'';
    var times='<div>'+(schedule.times||[]).map(function(time,index){return '<div class="time-row"><input type="number" min="0" max="23" value="'+esc(timePad(time.hour))+'" data-schedule-action="hour" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+disabled+'><span>:</span><input type="number" min="0" max="59" value="'+esc(timePad(time.minute))+'" data-schedule-action="minute" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+disabled+'><button class="mini-button" data-schedule-action="remove" data-index="'+index+'" data-target="'+esc(managed.targetId)+'"'+removeDisabled+'>移除</button></div>';}).join("")+'</div>';
    return '<div class="field"><label>星期与时间</label>'+days+times+'<button class="mini-button" data-schedule-action="add" data-target="'+esc(managed.targetId)+'"'+disabled+'>增加时间</button>'+capability(managed)+'</div>';
  }
  function cronCard(cron){
    var enabled=effective(cron.enabled);var enabledLabel=enabled===null?'状态未知':enabled?'已启用':'已停用';var html='<article class="card cron-card"><div class="card-head"><div><h3>'+esc(cron.label)+'</h3><div class="subtitle">'+esc(cron.sourceHint)+'</div></div><button class="toggle '+(enabled===true?'on':'')+'" data-toggle-target="'+esc(cron.enabled.targetId)+'"'+(writable(cron.enabled)?'':' disabled')+'>'+enabledLabel+'</button></div>';
    html+='<div class="subtitle">launchd loaded：'+esc(cron.loaded===null?'未知':cron.loaded?'是':'否')+'</div>'+scheduleEditor(cron.schedule);
    if(cron.model){html+=modelControl(cron.model,"cron","任务模型",false,false);}
    cron.warnings.forEach(function(warning){html+='<div class="warning">'+esc(warning)+'</div>';});
    if(cron.error){html+='<div class="role-error">'+esc(cron.error)+'</div>';}
    return html+'</article>';
  }
  function renderCronPanel(project){
    var crons=project?project.crons:snapshot.unassignedCrons;var html='<div class="panel '+(activeTab==="cron"?'active':'')+'" data-panel="cron"><div class="cron-grid">';
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
  function renderGroupDetail(group){
    var leads=groupLeads(group);var html='<div class="topline"><div><h1>'+esc(group.label)+'</h1><div class="subtitle">'+leads.length+' 个 Lead · 按 dept 归组</div></div></div>';
    html+='<div class="group-note">这些仍是原 project 的 Lead；这里只是按 dept 归组，不是独立项目。</div><h2 class="section-title">Lead 模型</h2>';
    return html+renderLeadRows(leads,"该分组没有可显示的 Lead");
  }
  function relayoutDagIfNeeded(){
    if(_relayouting||activeTab!=="dag"){return;}
    var first=byId("detail").querySelector(".dag-scroll");
    var width=first?Math.floor(first.clientWidth):0;
    if(width>0&&width!==_availW){
      _availW=width;_relayouting=true;renderDetail();_relayouting=false;
    }
  }
  function renderDetail(){
    if(!snapshot){return;}var group=selectedPresentationGroup();var project=selectedProject();
    if(group){byId("detail").innerHTML=renderGroupDetail(group);return;}
    if(selectedProjectId==="__unassigned__"){activeTab="cron";byId("detail").innerHTML=renderUnassigned();return;}
    if(selectedProjectId==="__extensions__"){byId("detail").innerHTML=renderGlobalExtensions();return;}
    if(!project){byId("detail").innerHTML='<div class="empty">没有可显示的项目</div>';return;}
    var allowed=["model","dag","cron"];
    if(allowed.indexOf(activeTab)<0){activeTab="model";}
    var html='<div class="topline"><div><h1>'+esc(project.name)+'</h1><div class="subtitle">'+visibleProjectLeads(project).length+' 个可见 Lead · '+project.dags.length+' 个 DAG · '+project.crons.length+' 个 Cron</div></div></div>';
    if(project.error){html+='<div class="error show">'+esc(project.error)+'</div>';}
    html+='<div class="tabs"><button class="tab '+(activeTab==="model"?'active':'')+'" data-tab="model">模型</button><button class="tab '+(activeTab==="dag"?'active':'')+'" data-tab="dag">DAG 模板</button><button class="tab '+(activeTab==="cron"?'active':'')+'" data-tab="cron">Cron</button>';
    html+='</div>'+renderModelPanel(project)+renderDagPanel(project)+renderCronPanel(project);
    byId("detail").innerHTML=html;
    relayoutDagIfNeeded();
  }
  function renderFlagValue(managed,withReason){
    var tail=withReason===false?"":capability(managed);var value=effective(managed);
    if(typeof value==="boolean"){return '<button type="button" class="flag-switch '+(value?'on':'')+'" aria-label="'+(value?'开启':'关闭')+'" aria-pressed="'+(value?'true':'false')+'" data-toggle-target="'+esc(managed.targetId)+'"'+(writable(managed)?'':' disabled')+'></button>'+tail;}
    return '<span class="badge">'+esc(textValue(value))+'</span>'+tail;
  }
  var LOCK_KINDS=[
    {id:"workflow",test:/conversational change requires a separate workflow/,label:"要走另一条流程",hint:"这个开关能改，但入口不在这一页——要单独走一轮。",color:"#7a4bd0"},
    {id:"store",test:/owned by the SQLite flag store/,label:"归 flag store 管",hint:"值由另一个存储拥有，这一页不是它的入口。",color:"#2b6cb0"},
    {id:"project",test:/project-scoped flag has no global override/,label:"值按项目分别设",hint:"没有全局开关，值是一个项目一个。",color:"#b26a00"},
    {id:"cli",test:/use flywheel-comm feature-flags set/,label:"要用命令行改",hint:"这个值能改，但入口是命令行，不在这一页。",color:"#7a4bd0"},
    {id:"readonly",test:/read-?only/,label:"登记表里锁死",hint:"登记表把它标成只读，这一页改不了。",color:"#86868b"}
  ];
  function lockKind(reason){
    for(var i=0;i<LOCK_KINDS.length;i++){if(LOCK_KINDS[i].test.test(reason||"")){return LOCK_KINDS[i];}}
    if(reason){return {id:"unmapped",label:"没认出这条原因",hint:"后端给了原因，但这一页还没为它写对应的说法。点开看逐字原文。",color:"#b26a00"};}
    return {id:"unknown",label:"系统没有给原因",hint:"这条不可写，而且后端确实没有说明为什么。",color:"#d1382c"};
  }
  function renderFlags(){
    if(!snapshot){return;}var tally={},writableCount=0;
    snapshot.flags.forEach(function(flag){
      if(writable(flag.global)){writableCount++;}
      else{var kind=lockKind(flag.global&&flag.global.writeCapability&&flag.global.writeCapability.reason);tally[kind.id]=(tally[kind.id]||0)+1;}
    });
    var total=snapshot.flags.length,readOnlyCount=total-writableCount;
    var html='<div class="topline"><div><h1>Feature Flags</h1><div class="subtitle">一个 Flag 概念；每行直接说明打开代表什么。</div></div></div>';
    html+='<div class="flag-sum"><span><b>'+total+'</b> 个 flag</span><span class="ok">能在这页改 <b>'+writableCount+'</b></span><span class="ro">入口不在这页 <b>'+readOnlyCount+'</b></span></div>';
    if(readOnlyCount){
      var kindCount=Object.keys(tally).length;
      html+='<div class="flag-legend"><div class="fl-t">'+(kindCount>1?'「改不了」有 '+kindCount+' 种，不是一种：':'这一页改不了的原因：')+'</div>';
      LOCK_KINDS.forEach(function(kind){if(tally[kind.id]){html+='<span class="fl-i" style="--lc:'+kind.color+'"><i></i>'+esc(kind.label)+' <b>'+tally[kind.id]+'</b></span>';}});
      if(tally.unmapped){html+='<span class="fl-i" style="--lc:#b26a00"><i></i>没认出这条原因 <b>'+tally.unmapped+'</b></span>';}
      if(tally.unknown){html+='<span class="fl-i" style="--lc:#d1382c"><i></i>系统没有给原因 <b>'+tally.unknown+'</b></span>';}
      html+='<div class="fl-n">点「改不了」原因可以看到系统给的逐字原文。</div></div>';
    }
    var all=snapshot.flags.slice().sort(function(a,b){return a.name<b.name?-1:a.name>b.name?1:0;});
    html+='<section class="flag-group"><h2 class="flag-group-title"><span>Flag</span><span class="flag-count">'+all.length+'</span></h2><div class="flag-head"><span>开关名</span><span>它现在是什么状态</span><span>全局值 · 能不能在这里改</span><span>项目覆盖</span></div>';
    all.forEach(function(flag){
      var canWrite=writable(flag.global);var lock=canWrite?null:lockKind(flag.global&&flag.global.writeCapability&&flag.global.writeCapability.reason);var rd=flagReading(flag,effective(flag.global));
      var actualOverrides=flag.projectOverrides.filter(function(item){return item.via==="project_row";});
      html+='<article class="flag-row'+(canWrite?' rw':'')+'" data-flag="'+esc(flag.name)+'" style="--lc:'+(lock?lock.color:'#1f9d4d')+'"><div class="flag-name">'+esc(flag.name)+'</div>';
      html+='<div class="flag-copy"><div class="flag-read" data-tone="'+rd.tone+'" data-state="'+esc(rd.state)+'">'+esc(rd.text)+'</div><span class="flag-tail">'+esc(rd.tail)+'</span><div class="help">'+esc(flag.description)+'</div></div>';
      html+='<div class="flag-global">'+renderFlagValue(flag.global,false)+(canWrite?'<span class="flag-rw">可改</span>':'<button type="button" class="lock-chip" data-lock-why="'+esc((flag.global&&flag.global.writeCapability&&flag.global.writeCapability.reason)||"")+'" data-lock-hint="'+esc(lock.hint)+'">'+esc(lock.label)+'</button>')+'</div>';
      html+='<div class="flag-ovs">'+(actualOverrides.length?'<button type="button" class="ov-pill" data-ov-flag="'+esc(flag.name)+'">'+actualOverrides.length+' 个项目覆盖</button>':'<span class="ov-none">无覆盖</span>')+'</div></article>';
      if(actualOverrides.length){
        var overrideWritable=actualOverrides.filter(function(item){return writable(item.value);}).length;
        html+='<div class="ov-body" data-ov-body="'+esc(flag.name)+'"><div class="ov-hint">'+(overrideWritable?'其中 '+overrideWritable+' 个项目可以在这里改。':'这些覆盖在这一页上同样是只读的——能看到值，改不了。')+'</div>'+actualOverrides.map(function(item){return '<span class="flag-override"><span class="flag-project">'+esc(item.projectName)+'</span>'+renderFlagValue(item.value,false)+'</span>';}).join("")+'</div>';
      }
    });
    html+='</section>';
    byId("flags").innerHTML=html+(all.length?'':'<div class="empty">flag registry 当前为空</div>');
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
      if(managed.canonicalModel===select.value&&managed.current&&managed.current.model){value.model=managed.current.model;}
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
  function consequenceCopy(consequence){return consequence==="new-run"?"仅影响新 run；已物化 run 不变。载体错误需重启或重新物化。":consequence;}
  function showCanonical(result,message,forceAcknowledgement){
    staged=forceAcknowledgement?Object.assign({},result,{confirmationRequired:true,confirmToken:null}):result;result=staged;var batch=result.batch;var html='<h2>提交确认</h2><div class="help">以下内容来自 server canonical 预检；页面草稿不是落盘权威。</div>';
    if(message){html+='<div class="ack">'+esc(message)+'</div>';}
    batch.changes.forEach(function(change){html+='<div class="change"><strong>'+esc(change.targetId)+'</strong><div class="change-values"><div><div class="help">旧值 oldValue</div><div class="value old">'+esc(textValue(change.oldValue))+'</div></div><span>→</span><div><div class="help">新值 newValue</div><div class="value">'+esc(textValue(change.newValue))+'</div></div></div><div class="consequence">影响 consequence：'+esc(change.consequence)+' · '+esc(consequenceCopy(change.consequence))+'</div></div>';});
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
  byId("projectList").addEventListener("click",function(event){
    var groupButton=event.target.closest("[data-group]");if(groupButton){selectedGroupId=groupButton.dataset.group;selectedProjectId="";activeTab="model";renderAll();return;}
    var projectButton=event.target.closest("[data-project]");if(projectButton){selectedGroupId="";selectedProjectId=projectButton.dataset.project;activeTab=selectedProjectId==="__unassigned__"?"cron":selectedProjectId==="__extensions__"?"":"model";renderAll();}
  });
  byId("detail").addEventListener("click",function(event){
    var tab=event.target.closest("[data-tab]");if(tab){activeTab=tab.dataset.tab;renderDetail();return;}
    var kind=event.target.closest("[data-kind]");if(kind){kindTab=kind.dataset.kind;renderDetail();return;}
    delegate(event);
  });
  byId("detail").addEventListener("change",delegate);
  byId("flags").addEventListener("click",function(event){
    var lock=event.target.closest("[data-lock-why]");
    if(lock){
      var row=lock.closest(".flag-row"),existing=row.querySelector(".why-tip");if(existing){existing.remove();return;}
      var tip=document.createElement("div");tip.className="why-tip";tip.innerHTML='<div class="wt-h">'+esc(lock.dataset.lockHint)+'</div><div class="wt-r">系统原文：'+esc(lock.dataset.lockWhy||"系统没有给原因")+'</div>';row.appendChild(tip);return;
    }
    var pill=event.target.closest("[data-ov-flag]");
    if(pill){var body=document.querySelector('[data-ov-body="'+pill.dataset.ovFlag+'"]');if(body){pill.classList.toggle("open",body.classList.toggle("open"));}return;}
    delegate(event);
  });
  byId("flags").addEventListener("change",delegate);
  byId("stage").addEventListener("click",stageChanges);byId("flagStage").addEventListener("click",stageChanges);byId("discard").addEventListener("click",discard);byId("flagDiscard").addEventListener("click",discard);
  byId("overlay").addEventListener("click",function(event){if(event.target.id==="modalCancel"){byId("overlay").classList.remove("open");}if(event.target.id==="modalConfirm"){confirmCanonical();}if(event.target.id==="progressClose"){closeProgress();}});
  window.addEventListener("resize",function(){clearTimeout(_resizeTimer);_resizeTimer=setTimeout(function(){_availW=0;renderDetail();},80);});
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
