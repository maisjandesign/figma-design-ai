import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const handlers = {};
const messages=[];
let savedPreferences;
const registry = new Map();
const make = (id, type='FRAME', parent=null) => {
  const n={id,name:id,type,parent,children:[],width:200,height:100,x:10,y:20,layoutMode:'HORIZONTAL',itemSpacing:16,
    getPluginData:()=>'', exportAsync:async settings=>new TextEncoder().encode(settings.format==='SVG'?'<svg/>':'png')};
  if (parent) parent.children.push(n);
  registry.set(id,n);return n;
};
const page=make('page','PAGE');
const root=make('root','FRAME',page);
let parent=root;
for(let i=0;i<1600;i++) parent=make(`deep-${i}`,'FRAME',parent);
const photo=make('photo','RECTANGLE',root);
photo.fills=[{type:'IMAGE',imageHash:'photo-hash',scaleMode:'CROP',imageTransform:[[1,0,.2],[0,1,0]]}];
const text=make('text','TEXT',root);
text.characters='Mixed text';
text.getStyledTextSegments=()=>[{start:0,end:5,characters:'Mixed',fontSize:32},{start:5,end:10,characters:' text',fontSize:16}];
const icon=make('icon','VECTOR',root);
const outside=make('outside','RECTANGLE',page);
const pageHandlers = new Map();
const testPage = (id,selection) => ({id,name:id,selection,
  on:(name,cb)=>{assert.equal(name,'nodechange');pageHandlers.set(id,cb);},
  off:(name,cb)=>{assert.equal(name,'nodechange');assert.equal(pageHandlers.get(id),cb);pageHandlers.delete(id);}});
const figma={mixed:Symbol('mixed'),showUI(){},currentPage:testPage('page',[root]),
  clientStorage:{getAsync:async()=>savedPreferences,setAsync:async(key,value)=>{savedPreferences=value;}},
  ui:{postMessage(message){messages.push(message);}},on:(name,cb)=>{if(name==='documentchange') throw new Error('Cannot register documentchange in incremental mode');handlers[name]=cb;},getNodeByIdAsync:async id=>registry.get(id),
  getImageByHash:()=>({getBytesAsync:async()=>new Uint8Array([137,80,78,71])})};
const context=vm.createContext({figma,__html__:'',setTimeout:()=>1,clearTimeout(){},Uint8Array,console});
vm.runInContext(await fs.readFile(new URL('../figma-plugin/code.js',import.meta.url),'utf8'),context);
const result = expression => vm.runInContext(expression,context);
const compact=result('serializeSelection({maxDepth:1,maxNodes:10})');
assert.equal(compact.truncated,true,'Depth truncation must be explicit');
figma.currentPage.selection=[photo,text];
assert.equal(result('serializeSelection({maxDepth:0,maxNodes:1})').truncated,true,'Selected roots must not disappear silently');
figma.currentPage.selection=[root];
const nodes=[];const assets=[];let cursor;let last;
do {
  context.opts={cursor,pageSize:73};
  last=await result('getDesignContext(opts)');
  assert(last.nodes.length<=73);
  nodes.push(...last.nodes);assets.push(...last.assets);cursor=last.nextCursor;
} while(cursor);
assert.equal(nodes.length,1604);
assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);
assert.equal(nodes.find(n=>n.id==='deep-1599').depth,1600);
assert.equal(nodes.find(n=>n.id==='text').textRuns.length,2);
assert.equal(nodes.find(n=>n.id==='photo').parentId,'root');
assert(assets.some(a=>a.imageHash==='photo-hash'));
assert(assets.some(a=>a.kind==='vector'&&a.nodeId==='icon'));
assert.equal(last.complete,true);
const first=await result('getDesignContext({pageSize:1})');
pageHandlers.get('page')();context.opts={cursor:first.nextCursor};
await assert.rejects(result('getDesignContext(opts)'),/changed/);
const next=await result('getDesignContext({pageSize:1})');
figma.currentPage.selection=[photo];context.opts={cursor:next.nextCursor};
await assert.rejects(result('getDesignContext(opts)'),/changed/);
figma.currentPage.selection=[root];
await assert.rejects(result('exportAsset({nodeId:"outside"})'),/not inside/);
await assert.rejects(result('exportAsset({nodeId:"photo",imageHash:"foreign"})'),/not used/);
const image=await result('exportAsset({nodeId:"photo",imageHash:"photo-hash"})');
assert.equal(image.source,'original-image');assert.equal(image.format,'PNG');
const svg=await result('exportAsset({nodeId:"icon",format:"SVG"})');
assert.equal(Buffer.from(svg.base64,'base64').toString(),'<svg/>');
assert.equal(figma.currentPage.selection[0],root,'Export must preserve selection');
const beforeSwitch=await result('getDesignContext({pageSize:1})');
figma.currentPage=testPage('page2',[root]);handlers.currentpagechange();
assert.equal(pageHandlers.has('page'),false,'Detach previous page observer');
assert.equal(pageHandlers.has('page2'),true,'Watch the new page');
context.opts={cursor:beforeSwitch.nextCursor};
await assert.rejects(result('getDesignContext(opts)'),/changed/);
const beforeStyle=await result('getDesignContext({pageSize:1})');
handlers.stylechange();context.opts={cursor:beforeStyle.nextCursor};
await assert.rejects(result('getDesignContext(opts)'),/changed/);
assert.equal(handlers.documentchange,undefined,'No global documentchange subscription');
await result('preferencesReady');
result('handleBridgeCommand = async () => ({executed:true})');
await result('respondToBridge({requestId:"blocked",command:"create-design"})');
assert.equal(messages.find(m=>m.requestId==='blocked').ok,false);
await result('respondToBridge({requestId:"approved",command:"create-design",userApproved:true})');
assert.equal(messages.find(m=>m.requestId==='approved').ok,true);
await figma.ui.onmessage({type:'save-preferences',autoApply:true});
assert.equal(savedPreferences.autoApply,true);
await result('respondToBridge({requestId:"automatic",command:"create-design"})');
assert.equal(messages.find(m=>m.requestId==='automatic').ok,true);
await figma.ui.onmessage({type:'save-preferences',autoApply:false});
await result('respondToBridge({requestId:"revoked",command:"create-design"})');
assert.equal(messages.find(m=>m.requestId==='revoked').ok,false);
console.log('Context tests passed: 1,604 nodes / 1,600 levels, pagination, mixed text, assets, invalidation and selection scope.');
