import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewUntilAccepted} from '../server/services/reviewerLoop.js';
test('rejected code returns to programmer and is reviewed again',async()=>{
  const result=await reviewUntilAccepted({initial:1,validate:()=>[],review:async n=>({approved:n===2,issues:n===2?[]:['fix']}),repair:async()=>2});
  assert.equal(result.candidate,2);assert.equal(result.events.filter(e=>e.stage==='review').length,2);
});
test('structural errors are repaired before reviewer is called',async()=>{
  let reviews=0;
  const result=await reviewUntilAccepted({initial:0,validate:n=>n?[]:['invalid JSON'],review:async()=>{reviews++;return {approved:true,issues:[]};},repair:async()=>1});
  assert.equal(result.candidate,1);assert.equal(reviews,1);
});
test('bounded rejection exits without delivering an approved candidate',async()=>{
  let repairs=0;
  await assert.rejects(()=>reviewUntilAccepted({initial:1,maxIterations:2,validate:()=>[],review:async()=>({approved:false,issues:['bug']}),repair:async n=>{repairs++;return n;}}),/2 tentativas/);
  assert.equal(repairs,1);
});
test('cancel interrupts an outstanding reviewer',async()=>{
  const abort=new AbortController();
  const pending=reviewUntilAccepted({initial:1,validate:()=>[],review:()=>new Promise(()=>{}),repair:async()=>2,signal:abort.signal});
  abort.abort();await assert.rejects(()=>pending);
});
test('malformed review cannot silently approve',async()=>{
  await assert.rejects(()=>reviewUntilAccepted({initial:1,validate:()=>[],review:async()=>({approved:'yes',issues:[]} as any),repair:async()=>2}),/inválido/);
});
