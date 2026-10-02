const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:320,height:580}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(fs.readFileSync(path.join(__dirname,'../figma-plugin/ui.html'),'utf8'));
 await page.evaluate(()=>{
   window.sent=[];window.addEventListener('message',e=>{if(e.data.pluginMessage)window.sent.push(e.data.pluginMessage);});
 });
 const event=async data=>page.evaluate(data=>window.postMessage({pluginMessage:data},'*'),data);
 await event({type:'preferences',autoApply:false,hasChoice:false});
 await page.locator('#consent').waitFor({state:'visible'});
 await page.locator('#allowRemember').click();
 await page.waitForFunction(()=>window.sent.some(m=>m.type==='save-preferences'&&m.autoApply));
 await event({type:'preferences',autoApply:true,hasChoice:true});
 await page.locator('#detailsPanel').waitFor({state:'hidden'});
 await page.waitForFunction(()=>window.sent.some(m=>m.type==='resize-panel'&&m.height===48));
 await page.evaluate(()=>receiveCommand({command:'create-design',requestId:'auto',params:{design:{name:'Test'}}}));
 await page.waitForFunction(()=>window.sent.some(m=>m.type==='bridge-command'&&m.requestId==='auto'));
 assert.equal(await page.locator('#approval').isVisible(),false);
 await event({type:'bridge-response',requestId:'auto',ok:true});
 await event({type:'preferences',autoApply:false,hasChoice:true});
 await page.evaluate(()=>receiveCommand({command:'create-design',requestId:'manual',params:{design:{name:'Test'}}}));
 await page.locator('#approval').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.sent.some(m=>m.type==='bridge-command'&&m.requestId==='manual')),false);
 await page.locator('#approveButton').click();
 await page.waitForFunction(()=>window.sent.some(m=>m.requestId==='manual'&&m.userApproved===true));
 await event({type:'bridge-response',requestId:'manual',ok:true});
 await event({type:'selection-snapshot',payload:{selectionCount:3,nodes:[{name:'Homepage / Hero'}]}});
 await page.evaluate(()=>{paired=true;setConnectionState('connected','Connected','Codex is ready','');});
 const out=path.join(__dirname,'../../docs/images');
 await page.setViewportSize({width:320,height:48});
 await page.screenshot({path:path.join(out,'figlink-compact.png')});
 await page.locator('#expandButton').click();
 await page.setViewportSize({width:320,height:320});
 await page.screenshot({path:path.join(out,'figlink-expanded.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.body.scrollWidth),320);
 assert.deepEqual(errors,[]);
 console.log('UI passed: consent, persisted mode, auto/manual writes, compact resize and 320px layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
