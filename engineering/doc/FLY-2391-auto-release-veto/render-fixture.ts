import {mkdirSync, writeFileSync} from 'node:fs';
import {renderDigestHtml} from '../../../packages/teamlead/src/bridge/digest-service.ts';
const cycle={cycleId:'fixture-cycle',releaseId:'fixture-release',slotDate:'2026-09-15',version:'1.2.3',cancelReason:null,windowOpenedAt:1789484400000,deadlineAt:1789506000000,origin:'automatic',results:[]};
const html=renderDigestHtml({date:'2026-09-15',projects:[],shippedCount:0,completedNotLiveCount:0},{customerRelease:{observedAt:1789491600000,accounting:{sourceEvents:5,linear:{delivered:4,pending:1},github:{delivered:3,pending:2},consistent:false},cyclesTruncated:false,cycles:[{...cycle,state:'window_open'},{...cycle,cycleId:'fixture-unknown',version:'1.2.2',state:'commit_unknown'},{...cycle,cycleId:'fixture-manual',version:'1.2.1',state:'cancelled',origin:'manual_intake'}],missedSlots:[{weekStart:'2026-09-07',reason:'unknown'}]}});
mkdirSync('/private/tmp/fly2391-visual', {recursive:true});
writeFileSync('/private/tmp/fly2391-visual/digest.html',html.replace('<body>','<body><p style="text-align:center">本地测试夹具 · 非发布收据</p>'));
