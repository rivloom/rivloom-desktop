import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSearchPreview } from './conversation-search-preview.ts';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.data/verification/lan-repair-20260918'); await mkdir(output,{recursive:true});
let retries=0;
const preview = await startSearchPreview(resolve('dist'), async(req,res)=>{
  if(['/api/auth/desktop','/api/network/diagnostics/retry'].includes(req.url || '')){
    if(req.url?.endsWith('/retry')) retries++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return true;
  } return false;
});
preview.data.network.local!.port=55915;
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce'});
await context.route('**/*',(route:any)=>route.request().url().startsWith(preview.origin)?route.continue():route.abort());
const page=await context.newPage();page.setDefaultTimeout(15000);
const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(String(error)));
await page.addInitScript(()=>{
  const w=window as any; w.isTauri=true; w.lanCalls=[]; w.lanFailure=''; w.lanDelay=false;
  w.lanReport={checkedAt:new Date().toISOString(),program:'C:\\Test private user\\Rivloom\\runtime\\node.exe',runtimeExists:true,listener:'ready',profiles:[{name:'Public',tcp:'missing',udp:'missing',mdns:'missing'}],managedRuleCount:0,managedPublic:false};
  w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
    w.lanCalls.push({command,args});
    if(command==='desktop_info')return {version:'0.1.17',desktopToken:'synthetic',dataDirectory:'fixture',locale:'zh-CN'};
    if(command==='desktop_update_snapshot')return {phase:'disabled',currentVersion:'0.1.17',release:null,revision:0};
    if(command==='inspect_lan_firewall'){
      if(w.lanDelay)await new Promise((resolve)=>{w.releaseLanCheck=resolve;});
      if(w.lanFailure==='inspect')throw 'firewall_inspection_failed';
      return structuredClone(w.lanReport);
    }
    if(command==='repair_lan_firewall'){
      if(w.lanFailure)throw w.lanFailure;
      w.lanReport.profiles=w.lanReport.profiles.map((p:any)=>({...p,tcp:'allowed',udp:'allowed',mdns:'allowed'}));
      w.lanReport.managedPublic=args.allowPublic; w.lanReport.managedRuleCount=2;return;
    }
    return null;
  }};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{w.lanCopied=text;}}});
});
const checks:string[]=[];const check=(name:string)=>{checks.push(name);console.log('PASS',name);};
const panel=()=>page.getByRole('region',{name:'本机局域网连接'});
try{
  await page.goto(preview.origin);
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();
  await panel().getByText('缺少匹配的放行规则',{exact:false}).first().waitFor();
  const repair=()=>panel().getByRole('button',{name:'允许局域网连接并复测'});
  assert(await repair().isDisabled());
  assert.equal(await page.evaluate(()=>(window as any).lanCalls.filter((c:any)=>c.command==='repair_lan_firewall').length),0);
  await panel().getByRole('checkbox').check();assert(await repair().isEnabled());
  assert((await panel().getByRole('checkbox').boundingBox())!.width <= 24);
  check('First visit inspects without mutation and Public repair requires explicit selection');
  await page.screenshot({path:resolve(output,'lan-public-zh.png'),fullPage:true});
  await page.evaluate(()=>{(window as any).lanFailure='firewall_cancelled';});
  await repair().click();await panel().getByText('已取消系统授权，未执行本次修复。').waitFor();
  assert.equal(retries,0);assert(await repair().isDisabled());
  check('UAC cancellation does not retry network or claim success');
  await page.evaluate(()=>{(window as any).lanFailure='';});
  await panel().getByRole('button',{name:'检查网络权限'}).click();
  await repair().waitFor();await page.waitForFunction(()=>!(document.querySelector('.lan-connection .primary') as HTMLButtonElement)?.disabled);
  const peer=structuredClone(preview.data.network.paired![0]);peer.online=true;peer.verified=true;peer.trusted=false;peer.channelReady=false;
  preview.data.network.nearby=[peer];preview.flush();
  await repair().click();await panel().getByText(/复测已发现并验证 1 台设备/).waitFor();
  assert.equal(retries,1);assert(await repair().isDisabled());
  check('Successful native operation rechecks rules and discovery, and unpaired discovery is not called encrypted connection');
  await page.getByRole('button',{name:'复制摘要',exact:true}).click();
  const copied=await page.evaluate(()=>(window as any).lanCopied);
  assert(copied.includes('windows_network: observed'));assert(!copied.includes('private user'));assert(!copied.includes('node.exe'));
  await page.evaluate(()=>{(window as any).lanFailure='inspect';});
  await panel().getByRole('button',{name:'检查网络权限'}).click();await panel().getByText('以下为上次检查结果，当前配置尚未确认。').waitFor();
  await page.getByRole('button',{name:'复制摘要',exact:true}).click();
  assert((await page.evaluate(()=>(window as any).lanCopied)).includes('last_known'));
  check('Failed inspection labels old results and copied summaries exclude paths');
  await page.evaluate(()=>{(window as any).lanFailure='';(window as any).lanReport.profiles=[{name:'Private',tcp:'policy_blocked',udp:'block_rule',mdns:'allowed'}];});
  await panel().getByRole('button',{name:'检查网络权限'}).click();await panel().getByText(/检测到阻止规则或组织策略/).waitFor();assert(await repair().isDisabled());
  check('Policy and explicit blocks direct users to administrator without offering an ineffective repair');
  await page.setViewportSize({width:390,height:1300});await panel().screenshot({path:resolve(output,'lan-policy-narrow-zh.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2));
  await page.getByRole('combobox',{name:'界面语言'}).selectOption('en');
  await page.getByRole('region',{name:'LAN access on this computer'}).waitFor();
  await page.getByRole('region',{name:'LAN access on this computer'}).screenshot({path:resolve(output,'lan-policy-narrow-en.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2));
  check('Chinese and English layouts fit 390px without horizontal overflow');
  await page.getByRole('combobox',{name:'Interface language'}).selectOption('zh-CN');
  await page.setViewportSize({width:1280,height:1000});
  await page.evaluate(()=>{(window as any).lanDelay=true;});
  await panel().getByRole('button',{name:'检查网络权限'}).click();
  await page.locator('.diagnostic-target select').selectOption(peer.id);
  await page.evaluate(()=>{(window as any).releaseLanCheck?.();(window as any).lanDelay=false;});
  assert.equal(await panel().count(),0);
  check('A late native inspection cannot reappear over a selected remote device');
  preview.data.user.owner=false;preview.flush();await page.reload();
  await page.getByRole('button',{name:'连接诊断',exact:true}).click();assert.equal(await panel().count(),0);
  check('Non-owner view has no Windows configuration actions');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({status:'passed',checks,retries,errors},null,2));
}catch(error){await writeFile(resolve(output,'ui-failure.json'),JSON.stringify({error:String(error),checks,retries,errors},null,2));throw error;}
finally{await context.close();await browser.close();await preview.close();}
