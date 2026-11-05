import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticSkillBackground } from '../lib/skill-background.mjs';

test('background uses only recent actual user requests and labels unknown evidence',()=>{
  const result=automaticSkillBackground({messages:[{role:'user',text:'old'},null,{role:'assistant',text:'unsupported claim'},...['one','two','latest'].map(text=>({role:'user',text}))],name:'rebar',description:'직경 대조',updating:true});
  assert.equal(result.examplePrompt,'latest');
  assert.doesNotMatch(result.situation,/old|unsupported claim/);
  assert.match(result.changeReason,/기존 스킬 수정/);
  assert.match(result.problem,/미확인/);
  assert.match(result.expectedResult,/미확인/);
});
test('missing records are marked without questions and automatic fields stay bounded',()=>{
  const empty=automaticSkillBackground();
  assert.match(empty.examplePrompt,/미기록/);
  assert.match(empty.changeReason,/스킬 생성·공유/);
  const large=automaticSkillBackground({messages:[{role:'user',text:'x'.repeat(10000)}]});
  for(const value of Object.values(large))assert.ok(value.length<=4000);
});
test('automatic background removes credentials and contact addresses from quoted requests',()=>{
  const secrets=['sk-test-FAKE-CREDENTIAL-NOT-REAL','short-private-value','Bearer access-token','A'.repeat(40),'private@example.test'];
  const result=automaticSkillBackground({messages:[{role:'user',text:`API key: ${secrets[0]}\nTOKEN=${secrets[1]}\n${secrets[2]}\n${secrets[3]}\n${secrets[4]}`},{role:'user',text:'철근량 검토 절차를 스킬로 만들어줘'}]});
  for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.examplePrompt,'철근량 검토 절차를 스킬로 만들어줘');
  assert.match(result.situation,/비공개 값 제거/);
});
