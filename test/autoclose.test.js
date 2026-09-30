const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { FIELD: F, STATUS: S, config } = require('../src/config');
const domain = require('../src/domain');
const cards = require('../src/cards');
const { TicketService } = require('../src/ticket-service');
const { createHandler } = require('../src/server');
const { FeishuApiError, FeishuTimeoutError } = require('../src/feishu');
const now = new Date('2026-09-22T06:00:00Z');
const sixHours = domain.CONFIRMATION_WAIT_MS;
function fields(extra = {}) { return { [F.status]: S.confirming, [F.version]: '3', [F.ticketNo]: 'IT-TEST', [F.resolution]: 'IT原处理结果', [F.completedAt]: now.getTime() - sixHours, [F.reporterMessageId]: 'om_reporter', [F.groupMessageId]: 'om_group', [F.reporterOpenId]: 'ou_reporter', ...extra }; }
function fixture(extra = {}) {
  let current = fields(extra);
  const writes = []; const messages = [];
  const repo = {
    get: async () => ({ record_id: 'rec_test', fields: {...current} }),
    listAll: async () => [await repo.get()],
    update: async (id, update) => { writes.push(update); current = {...current, ...update}; return repo.get(); },
    appendEvent: async () => {}
  };
  const feishu = { updateCard: async id => { messages.push(id); }, getMessage: async id => ({ message_id: id, msg_type: 'interactive', deleted: false, create_time: String(now.getTime()-sixHours), body: {content: JSON.stringify({title:'IT-TEST', elements:['故障已恢复','故障未恢复']})} }), sendCardToChat: async () => 'om_new_group', sendCardToUser: async () => 'om_new_user' };
  const service = new TicketService(repo, feishu); service.retryDelaysMs=[];
  // Fixed test clock otherwise falls outside the recent-closed notification window.
  service.sync = async () => ({failed: 0, errors: []});
  return {service, repo, feishu, writes, messages, current: () => current};
}

test('six elapsed hours closes exactly at the boundary and preserves IT resolution', () => {
  assert.equal(domain.autoClose(fields(), new Date(now.getTime()-1)), null);
  const update = domain.autoClose(fields(), now);
  assert.equal(update[F.status], S.closed);
  assert.equal(update[F.version], 4);
  assert.equal(update[F.closedType], '超时自动关闭');
  assert.equal(update[F.closedAt], now.getTime());
  assert.ok(!(F.resolution in update));
});
test('missing, invalid, future completion times and non-confirming states never close', () => {
  for (const time of [undefined, null, 'bad-time', Infinity, now.getTime()+1]) assert.equal(domain.autoClose(fields({[F.completedAt]: time}), now), null);
  for (const status of [S.pending,S.processing,S.closed]) assert.equal(domain.autoClose(fields({[F.status]:status}),now),null);
});
test('complete stamps this cycle; reopen clears timestamp and closure type; manual confirmation remains distinct', () => {
  const actor={open_id:'ou_it'}; const roles={itOpenIds:['ou_it'],adminOpenIds:[]};
  const update=domain.complete(fields({[F.status]:S.processing}),actor,{version:3,resolution:'修好'},roles,now);
  assert.equal(update[F.completedAt],now.getTime());
  const reopen=domain.reporterReopen(fields(),{open_id:'ou_reporter'},{version:3});
  assert.equal(reopen[F.completedAt],null);
  assert.equal(reopen[F.closedType],'');
  assert.equal(domain.reporterConfirm(fields(),{open_id:'ou_reporter'},{version:3},now)[F.closedType],'用户确认关闭');
});
test('cards show the six-hour rule and distinguish automatic closure from user confirmation',()=>{
  assert.match(JSON.stringify(cards.reporterConfirmation('rec_test',fields())),/6 小时/);
  assert.match(JSON.stringify(cards.confirming('rec_test',fields())),/2026-09-22 14:00:00/);
  const closed={...fields(),...domain.autoClose(fields(),now)};
  assert.equal(domain.closureType(closed),'超时自动关闭');
  assert.match(JSON.stringify(cards.closed('rec_test',closed)),/默认工单已处理完毕/);
  assert.match(JSON.stringify(cards.closed('rec_test',closed)),/IT原处理结果/);
});
test('repeat jobs close only once, preserving result and recording time source',async()=>{
  const f=fixture(); const first=await f.service.autoCloseDue({now});
  assert.equal(first.closed,1); assert.equal(first.details[0].timeSource,'completed_at');
  assert.equal((await f.service.autoCloseDue({now})).closed,0);
  assert.equal(f.writes.length,1); assert.equal(f.current()[F.resolution],'IT原处理结果');
});
test('fresh user feedback wins over the scan snapshot',async()=>{
  const f=fixture(); const records=await f.repo.listAll();
  await f.repo.update('rec_test',{[F.status]:S.processing,[F.version]:4,[F.completedAt]:null});
  const result=await f.service.autoCloseDue({records,now});
  assert.equal(result.changed,1); assert.equal(result.closed,0); assert.equal(f.writes.length,1);
});
test('matching legacy confirmation message gives a conservative bound, never a fabricated completion time',async()=>{
  const f=fixture({[F.completedAt]:null}); const result=await f.service.autoCloseDue({now});
  assert.equal(result.closed,1); assert.equal(result.details[0].timeSource,'confirmation_message_upper_bound');
  assert.equal(f.current()[F.completedAt],null);
});
test('legacy message identity, content, deleted state and rework cycle are checked',async()=>{
  for(const override of [{message_id:'wrong'},{deleted:true},{msg_type:'text'},{body:{content:'other ticket'}},{create_time:'invalid'}]) {
    const f=fixture({[F.completedAt]:null}); const get=f.feishu.getMessage;
    f.feishu.getMessage=async id=>({...await get(id),...override});
    assert.equal((await f.service.autoCloseDue({now})).closed,0); assert.equal(f.writes.length,0);
  }
  const f=fixture({[F.completedAt]:null,[F.version]:5,[F.reworkCount]:1});
  assert.equal((await f.service.autoCloseDue({now})).missingTime,1);
});
test('lost close acknowledgement is read back without retrying the write',async()=>{
  const f=fixture(); const update=f.repo.update;
  f.repo.update=async(...args)=>{await update(...args);throw new FeishuTimeoutError();};
  assert.equal((await f.service.autoCloseDue({now})).closed,1); assert.equal(f.writes.length,1);
});
test('ambiguous close is not announced and blocks same-instance repeated writes',async()=>{
  const f=fixture(); let count=0;
  f.repo.update=async()=>{count++;throw new FeishuTimeoutError();};
  assert.equal((await f.service.autoCloseDue({now})).failed,1);
  assert.equal((await f.service.autoCloseDue({now})).busy,1); assert.equal(count,1);
});
test('notification failure does not undo automatic closure',async()=>{
  const f=fixture(); f.service.sync=async()=>{throw new Error('unavailable');};
  const result=await f.service.autoCloseDue({now});
  assert.equal(result.closed,1); assert.equal(result.notificationFailed,1); assert.equal(f.current()[F.status],S.closed);
});
test('automatic and manual actions share the same per-record lock',async()=>{
  const f=fixture(); let release; const get=f.repo.get;
  f.repo.get=()=>new Promise(resolve=>{release=async()=>resolve(await get());});
  const task=f.service.autoCloseDue({records:[{record_id:'rec_test',fields:fields()}],now});
  await assert.rejects(f.service.action('reporter_reopen','rec_test',{open_id:'ou_reporter'},{version:3}),{code:'ACTION_IN_PROGRESS'});
  f.repo.get=get; await release(); await task; assert.equal(f.writes.length,1);
});
test('only automatically closed expired cards can be replaced; permission errors never resend',async()=>{
  for(const code of [230031,230013]){
    const f=fixture({[F.status]:S.closed,[F.closedType]:'超时自动关闭'}); const rec=await f.repo.get();
    f.feishu.updateCard=async()=>{throw new FeishuApiError(400,{code});};
    const result={repaired:0};
    if(code===230031){await f.service.refreshCard(rec,F.groupMessageId,cards.closed('rec_test',rec.fields),'close',result);assert.equal(f.current()[F.groupMessageId],'om_new_group');}
    else await assert.rejects(f.service.refreshCard(rec,F.groupMessageId,{},'close',result),{apiCode:230013});
  }
});
test('existing SLA schedule runs auto close and the manual endpoint stays authenticated',async()=>{
  const f=fixture(); let ran=0;
  f.service.autoCloseDue=async()=>{ran++;return {closed:0};};
  await f.service.checkSla(); assert.equal(ran,1);
  const saved=config.internalJobToken;config.internalJobToken='test-job-token';
  try{
    const handler=createHandler(f.service);
    for(const [auth,status] of [['',401],['Bearer test-job-token',200]]){
      const req=Readable.from([]);req.method='POST';req.url='/jobs/auto-close';req.headers={authorization:auth};
      assert.equal((await handler(req)).status,status);
    }
    assert.equal(ran,2);
  }finally{config.internalJobToken=saved;}
});

test('verified record-history exception requires matching record, ticket and cycle', async()=>{
  const f=fixture({[F.completedAt]:null,[F.ticketNo]:'IT-TEST-LEGACY',[F.reporterMessageId]:'om_test_legacy'});
  f.service.legacyBounds={rec_test_legacy:{ticketNo:'IT-TEST-LEGACY',version:3,reporterMessageId:'om_test_legacy',completedBefore:'2026-09-11T23:59:59+08:00',source:'record_history_day_upper_bound'}};
  f.feishu.getMessage=async()=>{throw new Error('permission unavailable');};
  const record={record_id:'rec_test_legacy',fields:f.current()};
  const bound=await f.service.legacyCompletionBound(record);
  assert.equal(bound.source,'record_history_day_upper_bound');
  assert.equal(bound.date.toISOString(),'2026-09-11T15:59:59.000Z');
  record.fields={...record.fields,[F.version]:5};
  assert.equal(await f.service.legacyCompletionBound(record),null);
});

test('large batches are bounded and remaining candidates are reported',async()=>{
  const f=fixture(); const records=Array.from({length:8},(_,i)=>({record_id:`rec_${i}`,fields:fields()}));
  f.repo.get=async id=>({record_id:id,fields:fields()});
  f.repo.update=async(id,update)=>({record_id:id,fields:{...fields(),...update}});
  const result=await f.service.autoCloseDue({records,now});
  assert.equal(result.closed,5); assert.equal(result.deferred,3);
});
