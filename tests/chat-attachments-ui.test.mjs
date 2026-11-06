import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatAttachments, appendAttachmentSummary } from '../public/chat-attachments.js';

class Element {
  constructor(tag = 'div') { Object.assign(this, {tagName:tag,children:[],listeners:{},disabled:false,hidden:false,value:'',style:{},dataset:{}}); this.classList={toggle:(name,value)=>{this[name]=value;}}; }
  addEventListener(name, callback) {this.listeners[name]=callback;}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children=nodes;}
  setAttribute(name,value) {this[name]=value;}
  click() {return this.listeners.click?.();}
  set textContent(value) {this.text=value;this.children=[];}
  get textContent() {return (this.text??'')+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_) {assert.fail('Attachments must remain literal DOM text');}
}
const meta = (file,id='11111111-1111-4111-8111-111111111111')=>({id,name:file.name,mimeType:file.type||'text/plain',size:file.size,kind:file.type.startsWith('image/')?'image':'text'});
function fixture(t) {
  const previous={document:globalThis.document,fetch:globalThis.fetch};
  const ids=Object.fromEntries(['chat-attach','chat-attachment-input','chat-attachment-list','chat-attachment-status','message-input','sitecad-chat-panel'].map(id=>[id,new Element()]));
  globalThis.document={getElementById:id=>{assert.ok(ids[id],id);return ids[id];},createElement:tag=>new Element(tag)};
  let busy=false,chatId='22222222-2222-4222-8222-222222222222'; const calls=[],pending=[],errors=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({ok:true,data:{attachments:init.body.getAll('files').map(file=>meta(file))}});};
  const ui=createChatAttachments({isBusy:()=>busy,getChatId:()=>chatId,onChange(){},onPending:value=>pending.push(value),notify:message=>errors.push(message)});ui.update({desktop:true});
  t.after(()=>{ui.clear();Object.assign(globalThis,previous);});
  return {ids,ui,calls,pending,errors,setBusy:value=>{busy=value;ui.sync();},setChat:value=>{chatId=value;ui.clear();}};
}

test('file picker uploads selected files locally, exposes IDs, thumbnail and remove control',async t=>{
  const {ids,ui,calls,pending}=fixture(t);
  let picked=0;ids['chat-attachment-input'].click=()=>picked++;
  ids['chat-attach'].click();assert.equal(picked,1);
  const file=new File(['png bytes'],'screen.png',{type:'image/png'});
  ids['chat-attachment-input'].files=[file];await ids['chat-attachment-input'].listeners.change();
  assert.equal(calls[0].url,'/api/desktop/chat/attachments');assert.equal(calls[0].init.method,'POST');
  assert.equal(calls[0].init.body.get('chatId'),'22222222-2222-4222-8222-222222222222');
  assert.deepEqual(ui.ids(),['11111111-1111-4111-8111-111111111111']);assert.equal(ui.metadata()[0].name,'screen.png');
  assert.deepEqual(pending,[true,false]);assert.equal(ids['chat-attachment-input'].value,'');
  const row=ids['chat-attachment-list'].children[0];assert.equal(row.children[0].tagName,'img');
  await row.children.at(-1).click();assert.equal(ui.ids().length,0);
});

test('screenshot paste and file drop upload while normal text paste is untouched',async t=>{
  const {ids,calls}=fixture(t);let prevented=0;
  await ids['message-input'].listeners.paste({clipboardData:{files:[],items:[]},preventDefault(){prevented++;}});assert.equal(prevented,0);
  const image=new File(['image'],'pasted.png',{type:'image/png'});
  await ids['message-input'].listeners.paste({clipboardData:{files:[image]},preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(calls.length,1);
  await ids['sitecad-chat-panel'].listeners.drop({dataTransfer:{files:[new File(['a,b'],'quantity.csv',{type:'text/csv'})]},preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.equal(calls.length,2);
});

test('invalid and oversized files never upload; active turns refuse drops and preserve normal text',async t=>{
  const {ids,calls,errors,setBusy}=fixture(t);
  await ids['sitecad-chat-panel'].listeners.drop({dataTransfer:{files:[new File(['MZ'],'app.exe')]},preventDefault(){}});
  assert.equal(calls.length,0);assert.match(errors.at(-1),/지원|PNG/);
  ids['chat-attachment-input'].files=[new File([new Uint8Array(5*1024*1024+1)],'large.png',{type:'image/png'})];await ids['chat-attachment-input'].listeners.change();
  assert.equal(calls.length,0);assert.match(errors.at(-1),/5MB/);
  setBusy(true);await ids['sitecad-chat-panel'].listeners.drop({dataTransfer:{files:[new File(['ok'],'a.txt')]},preventDefault(){}});
  assert.equal(calls.length,0);assert.equal(ids['chat-attach'].disabled,true);
});

test('upload errors keep failed chips with retry and chat switches clear stale files',async t=>{
  const {ids,ui,calls,setChat}=fixture(t);globalThis.fetch=async()=>Response.json({ok:false,error:'첨부 저장 실패'},{status:400});
  ids['chat-attachment-input'].files=[new File(['text'],'notes.txt',{type:'text/plain'})];await ids['chat-attachment-input'].listeners.change();
  assert.equal(ui.ids().length,0);assert.match(ids['chat-attachment-list'].textContent,/실패/);
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({ok:true,data:{attachments:[meta(init.body.get('files'))]}});};
  await ids['chat-attachment-list'].children[0].children.find(node=>node.textContent==='다시 올리기').click();
  assert.equal(ui.ids().length,1);setChat('33333333-3333-4333-8333-333333333333');assert.equal(ui.ids().length,0);assert.equal(ids['chat-attachment-list'].children.length,0);
});

test('message attachment metadata stays literal and never trusts remote URLs',()=>{
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
  try {const article=new Element();appendAttachmentSummary(article,[{name:'<img src=x onerror=bad>.pdf',size:1024,mimeType:'application/pdf',url:'https://evil.test'}]);assert.match(article.textContent,/<img src=x onerror=bad>\.pdf/);assert.equal(article.children[0].children[0].tagName,'li');assert.equal(article.children[0].children[0].href,undefined);}finally{globalThis.document=previous;}
});

test('drag feedback handles file transfers and clears on leave without intercepting plain text',async t=>{
  const {ids,setBusy}=fixture(t);const panel=ids['sitecad-chat-panel'];let prevented=0;
  panel.listeners.dragover({dataTransfer:{types:['text/plain']},preventDefault(){prevented++;}});assert.equal(prevented,0);
  const transfer={types:['Files']};panel.listeners.dragenter({dataTransfer:transfer,preventDefault(){prevented++;}});
  assert.equal(panel['attachment-dragover'],true);assert.equal(transfer.dropEffect,'copy');
  panel.listeners.dragleave({relatedTarget:null});assert.equal(panel['attachment-dragover'],false);
  setBusy(true);panel.listeners.dragover({dataTransfer:transfer,preventDefault(){prevented++;}});assert.equal(transfer.dropEffect,'none');
});

test('count, aggregate size and per-format limits fail before reading or uploading files',async t=>{
  const {ids,calls,errors}=fixture(t);
  for(const files of [Array.from({length:5},()=>new File(['x'],'a.txt')),Array.from({length:3},()=>({name:'a.pdf',size:10*1024*1024})),[{name:'a.pdf',size:10*1024*1024+1}],[{name:'a.txt',size:1024*1024+1}],[{name:'a.txt',size:0}]]){
    ids['chat-attachment-input'].files=files;await ids['chat-attachment-input'].listeners.change();
  }
  assert.equal(calls.length,0);assert.equal(errors.length,5);
});

test('a late upload cannot add files to another chat and malformed metadata is rejected',async t=>{
  const {ids,ui,setChat,errors}=fixture(t);let respond;
  globalThis.fetch=()=>new Promise(resolve=>{respond=resolve;});
  const file=new File(['x'],'a.txt',{type:'text/plain'});ids['chat-attachment-input'].files=[file];
  const pending=ids['chat-attachment-input'].listeners.change();setChat('33333333-3333-4333-8333-333333333333');
  respond(Response.json({ok:true,data:{attachments:[meta(file)]}}));await pending;assert.equal(ui.hasFiles(),false);
  globalThis.fetch=async()=>Response.json({ok:true,data:{attachments:[{...meta(file),id:'../../private'}]}});
  ids['chat-attachment-input'].files=[file];await ids['chat-attachment-input'].listeners.change();assert.equal(ui.ids().length,0);assert.match(errors.at(-1),/결과/);
});

test('bounded upload timeout unlocks controls and retains a retryable file',async t=>{
  const {ids,ui,errors}=fixture(t);const original=globalThis.AbortSignal;
  globalThis.AbortSignal={any:signals=>original.any(signals),timeout:milliseconds=>{assert.equal(milliseconds,90000);return original.abort(new DOMException('timeout','TimeoutError'));}};
  t.after(()=>{globalThis.AbortSignal=original;});
  globalThis.fetch=async(url,init)=>{assert.equal(init.signal.aborted,true);throw init.signal.reason;};
  ids['chat-attachment-input'].files=[new File(['x'],'a.txt')];await ids['chat-attachment-input'].listeners.change();
  assert.equal(ids['chat-attach'].disabled,false);assert.equal(ui.ids().length,0);assert.match(errors.at(-1),/시간이 초과/);
  assert.match(ids['chat-attachment-list'].textContent,/다시 올리기/);
});
