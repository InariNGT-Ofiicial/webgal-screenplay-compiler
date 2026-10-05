// Optional Playwright verification of a locally installed demo. No engine or browser is bundled.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHost } from '../src/host.mjs';
const dist=path.resolve(process.argv[2]??'webgal/dist'),out=path.resolve(process.argv[3]??'build/e2e');
const modulePath=process.env.PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(path.resolve(modulePath)).href:'playwright');
fs.mkdirSync(out,{recursive:true});
const service=createHost({dist,port:0}),address=await service.start();
let browser,page;const checks=[],errors=[],missing=[],optionalMissing=[];
const check=(name,pass,details)=>{checks.push({name,pass:!!pass,...(details?{details}:{})});if(!pass)throw Error(name);};
try {
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('response',r=>{if(r.status()>=400){const pathname=new URL(r.url()).pathname;(pathname==='/lib/live2d.min.js'||pathname==='/lib/live2dcubismcore.min.js'?optionalMissing:missing).push({status:r.status(),path:pathname});}});
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const enter=page.locator('.html-body__title-enter');if(await enter.count())await enter.click();
  const directButton=text=>page.locator('div,button,span').filter({hasText:text});
  const clickText=async text=>{
    const candidates=await directButton(text).elementHandles();
    for(const candidate of candidates){const match=await candidate.evaluate((e,wanted)=>[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()===wanted&&e.getClientRects().length>0,text);if(match){await candidate.click();return;}}
    throw Error('Missing native button '+text);
  };
  await page.waitForTimeout(1500);await clickText('开始游戏');
  await page.waitForFunction(async()=>{const response=await fetch('/api/stage');const state=await response.json();return window.releaseRuntime&&state.stage?.showText?.includes('欢迎来到');},{},{timeout:15000});
  await page.waitForTimeout(1200);await page.screenshot({path:path.join(out,'opening.png')});
  check('runtime observes official snapshots',await page.evaluate(()=>!!window.releaseRuntime));
  const runtime=()=>page.evaluate(()=>({checkpoints:window.releaseRuntime.checkpoints,errors:window.releaseRuntime.errors,step:window.releaseRuntime.step}));
  for(let i=0;i<100;i++){
    const state=await runtime();if(state.errors.length)throw Error(state.errors.join('\n'));
    if(state.checkpoints.length>=2)break;
    const saving=await page.evaluate(()=>document.documentElement.dataset.releaseAutoSaving==='true');
    if(!saving)await page.mouse.click(640,390);
    await page.waitForTimeout(saving?350:500);
  }
  const saved=await runtime();check('two chapters save through native menus',saved.checkpoints.length===2,saved);
  check('chapter autosaves use native slots one and two',saved.checkpoints.map(c=>c.slot).join(',')==='1,2');
  await clickText('存档');await page.waitForTimeout(1200);
  const slots=await page.locator('#Save_content_page_1 > div').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none').map(e=>({image:!!e.querySelector('img[alt="Save_img_preview"]'),text:e.textContent})));
  check('eight visible native save slots',slots.length===8);check('saved records have native preview images',slots[0].image&&slots[1].image);
  await page.screenshot({path:path.join(out,'native-saves.png')});await clickText('返回');
  await clickText('读档');await page.waitForTimeout(1000);await page.locator('#Load_content_page_1 > div').first().click();
  await page.waitForTimeout(1800);
  for(let i=0;i<60;i++){const state=await runtime();if(state.checkpoints.length>=3)break;await page.waitForTimeout(350);}
  const reloaded=await runtime();check('loading a checkpoint resumes and safely overwrites its native slot',reloaded.checkpoints.length>=3&&reloaded.checkpoints[2].overwrote,reloaded);
  const music=await page.locator('audio').evaluateAll(es=>es.map(e=>({src:e.currentSrc,paused:e.paused,time:e.currentTime})));
  check('native demo music plays after a real user gesture',music.some(e=>e.src.endsWith('/calm.wav')&&!e.paused&&e.time>0));
  check('no browser runtime errors',errors.length===0,errors);check('no missing runtime assets',missing.length===0,missing);
  await page.screenshot({path:path.join(out,'reloaded.png')});
  await page.close();page=await browser.newPage({viewport:{width:1280,height:720}});
  // Controlled failure at the integration's slot-click boundary. Rendering, storage
  // after retry, the UI and every trusted input event still use the real engine.
  await page.addInitScript(()=>{window.productionFixtureFailSave=true;const select=document.querySelector.bind(document);document.querySelector=function(selector){if(selector==='#Save_content_page_1'&&window.productionFixtureFailSave&&document.documentElement.dataset.releaseAutoSaving==='true')return {children:Array.from({length:8},()=>({querySelector:()=>null,click:()=>{throw Error('Expected fixture save failure');}}))};return select(selector);};});
  await page.goto(`http://127.0.0.1:${address.port}/`);
  if(await page.locator('.html-body__title-enter').count())await page.locator('.html-body__title-enter').click();
  await page.waitForTimeout(1200);await clickText('开始游戏');
  for(let i=0;i<80;i++){if(await page.locator('#productionSaveRetry').count())break;if(!await page.evaluate(()=>document.documentElement.dataset.releaseAutoSaving==='true'))await page.mouse.click(640,390);await page.waitForTimeout(350);}
  check('save failure exposes a retry control',await page.locator('#productionSaveRetry').isVisible());
  await page.mouse.click(640,390);await page.waitForTimeout(300);
  const blocked=await(await fetch(`http://127.0.0.1:${address.port}/api/stage`)).json();
  check('trusted input cannot skip a failed chapter save',blocked.stage.GameVar._vn_chapter===1&&blocked.stage.GameVar._release_checkpoint===1&&(await runtime()).checkpoints.length===0);
  await page.evaluate(()=>{window.productionFixtureFailSave=false;});await page.locator('#productionSaveRetry').click();
  await page.waitForFunction(()=>window.releaseRuntime.checkpoints.length===1,{},{timeout:15000});
  check('retry recovers by writing the real native save',await page.evaluate(()=>!document.documentElement.dataset.releaseSaveFailed&&!document.getElementById('productionSaveRetry')));
} catch(error) { errors.push(String(error));if(page){await page.screenshot({path:path.join(out,'failure.png')});fs.writeFileSync(path.join(out,'failure.html'),await page.content());const state=await(await fetch(`http://127.0.0.1:${address.port}/api/stage`)).json();fs.writeFileSync(path.join(out,'failure-state.json'),JSON.stringify({native:state,runtime:await page.evaluate(()=>window.releaseRuntime)},null,2));} }
finally { if(browser)await browser.close();await service.close();fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,missing,optionalMissing,pass:errors.length===0&&checks.length>0&&checks.every(c=>c.pass)},null,2)+'\n'); }
console.log(JSON.stringify({checks:checks.map(({name,pass})=>({name,pass})),errors,missing,optionalMissing}));if(errors.length||checks.some(c=>!c.pass))process.exitCode=1;
