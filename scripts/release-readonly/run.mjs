// Read-only consumer of existing candidate/public bytes. No build or publication.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,copyFile,lstat,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateFixed} from './input-contract.mjs';
const base=import.meta.dirname,sha=b=>createHash('sha256').update(b).digest('hex'),json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const fixed=await json(join(base,'fixed-inputs.json')),frozen=await json(join(base,'frozen-methods.json')),[platform,requestedProduct]=process.argv.slice(2),product=resolve(requestedProduct||'');
const git=(...args)=>execFileSync('git',args,{cwd:product,windowsHide:true,maxBuffer:128*1024**2,stdio:['ignore','pipe','pipe']});
validateFixed(fixed);
const output=join(resolve(process.env.GITHUB_WORKSPACE),'test-results/readonly-consumer',platform),work=join(product,'.data/verification/independent-readonly-0131');await mkdir(output,{recursive:true});await mkdir(work,{recursive:true});
const report={schemaVersion:1,status:'running',at:new Date().toISOString(),platform,version:fixed.version,productCommit:fixed.productCommit,productTree:fixed.productTree,consumerCommit:process.env.GITHUB_SHA,workflowRunID:process.env.GITHUB_RUN_ID,workflowAttempt:process.env.GITHUB_RUN_ATTEMPT,controllerSHA256:sha(await readFile(new URL(import.meta.url))),fixedInputsSHA256:sha(await readFile(join(base,'fixed-inputs.json'))),frozenMethodsSHA256:sha(await readFile(join(base,'frozen-methods.json'))),producerBuildExecuted:false,publicationExecuted:false,storageMutations:0,methods:[]};let stage='frozen-methods';
let verifiedReaderNode=process.execPath;
function run(file,args=[]){execFileSync(verifiedReaderNode,[file,...args],{cwd:product,windowsHide:true,timeout:2_400_000,maxBuffer:32*1024**2,stdio:['ignore','pipe','pipe'],env:{...process.env}});console.log('Independent consumer completed '+stage);}
const api=p=>JSON.parse(execFileSync('gh',['api','--method','GET','repos/rivloom/rivloom-desktop/'+p],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024**2,stdio:['ignore','pipe','pipe']}));
function safeReason(value){
 return String(value).split(/[\r\n]/)[0].replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{const u=new URL(raw);u.search='';u.hash='';u.username='';u.password='';return ['downloads.rivloom.com','rivloom.com','api.github.com','nodejs.org','www.7-zip.org'].includes(u.hostname)?u.origin+u.pathname:'[external URL]';}catch{return '[URL]';}}).replace(/(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/gi,'[redacted]').replace(/(?:token|password|authorization|secret|sig|signature)\s*[=:]\s*[^\s,;]+/gi,'[redacted]').slice(0,320);
}
function diagnostics(error){
 const childText=String(error.stderr||'').slice(-16384),codes=['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','EACCES','ENOENT','unexpected_redirect','tool_redirect_limit'];
 const hints=codes.filter(code=>childText.includes(code)||error.code===code||error.cause?.code===code),pattern=childText+' '+String(error.message||'');const result={errorType:['AssertionError','Error','TypeError'].includes(error.name)?error.name:'Error',childExitCode:Number.isSafeInteger(error.status)?error.status:null,transportClass:hints.includes('unexpected_redirect')||hints.includes('tool_redirect_limit')?'unexpected_redirect':hints.some(c=>/TLS|CERT|VERIFY_LEAF/.test(c))||/\b(?:tls|ssl|x509|certificate)\b/i.test(pattern)?'tls':hints.some(c=>/TIMEOUT/.test(c))||/timed? ?out|timeout/i.test(pattern)?'timeout':hints.some(c=>/ECONN/.test(c))||/connection (?:reset|refused)/i.test(pattern)?'connection':hints.includes('EACCES')?'permission':hints.includes('ENOENT')?'missing-file-or-tool':'not-classified',safeCodes:hints};
 const reason=error.code==='ERR_ASSERTION'?error.message:childText.match(/AssertionError(?:\s*\[[^\]]*\])?:\s*([^\r\n]*)/)?.[1];if(reason)result.assertionReason=safeReason(reason);
 if(error.code==='ERR_ASSERTION')for(const name of ['actual','expected'])if(typeof error[name]==='number'||typeof error[name]==='boolean'||typeof error[name]==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(error[name]))result[name]=error[name];return result;
}
async function get(url,limit){const r=await fetch(url,{redirect:'error',headers:{'accept-encoding':'identity','cache-control':'no-cache'},signal:AbortSignal.timeout(240000)});assert.equal(r.status,200);const parts=[];let n=0;for await(const b of r.body){n+=b.length;assert(n<=limit);parts.push(Buffer.from(b));}return Buffer.concat(parts);}
async function getWindowsExtractor(tool){
 assert.equal(tool.version,'22.01');assert.equal(tool.fileName,'7z2201-x64.exe');assert.equal(tool.maximumBytes,8*1024**2);assert.equal(tool.maximumRedirects,4);assert.match(tool.installerSHA256,/^[a-f0-9]{64}$/);
 const accepted=u=>u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(u.hostname==='sourceforge.net'||u.hostname==='downloads.sourceforge.net'||/^[a-z0-9-]+\.dl\.sourceforge\.net$/.test(u.hostname));
 const fail=code=>Object.assign(new Error('Fixed Windows extractor request rejected'),{code});
 let url;try{url=new URL(tool.url)}catch{throw fail('unexpected_redirect')}
 if(!accepted(url))throw fail('unexpected_redirect');
 const signal=AbortSignal.timeout(240000);let redirects=0;
 for(;;){
  const response=await fetch(url,{redirect:'manual',headers:{'accept-encoding':'identity','cache-control':'no-cache'},signal});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();
   if(redirects++>=tool.maximumRedirects)throw fail('tool_redirect_limit');
   if(!location)throw fail('unexpected_redirect');
   try{url=new URL(location,url)}catch{throw fail('unexpected_redirect')}
   if(!accepted(url))throw fail('unexpected_redirect');
   continue;
  }
  if(response.status!==200){await response.body?.cancel();assert.equal(response.status,200,'Fixed extractor HTTP status');}
  const parts=[];let bytes=0;
  for await(const part of response.body){bytes+=part.length;assert(bytes<=tool.maximumBytes,'Fixed extractor exceeds 8 MiB');parts.push(Buffer.from(part));}
  const archive=Buffer.concat(parts);assert.equal(sha(archive),tool.installerSHA256,'Fixed 7-Zip installer SHA256 differs');return archive;
 }
}
try{
 stage='hosted-and-product-source-identity';assert.equal(platform,'windows');assert.equal(process.version,'v24.19.0');assert.equal(process.platform,platform==='windows'?'win32':'linux');assert.equal(process.arch,'x64');
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,'rivloom/rivloom-desktop');assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(process.env.GITHUB_REF,'refs/heads/'+fixed.consumerBranch);assert.match(process.env.EXPECTED_CONSUMER_COMMIT||'',/^[a-f0-9]{40}$/);assert.equal(process.env.GITHUB_SHA,process.env.EXPECTED_CONSUMER_COMMIT);
 assert.equal(git('rev-parse','HEAD').toString().trim(),fixed.productCommit);assert.equal(git('rev-parse','HEAD^{tree}').toString().trim(),fixed.productTree);assert.equal(git('status','--porcelain').toString().trim(),'');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:resolve(base,'../..'),encoding:'utf8',windowsHide:true}).trim(),process.env.EXPECTED_CONSUMER_COMMIT);
 stage='frozen-methods';
 assert.equal(frozen.controllerSHA256,sha(await readFile(new URL(import.meta.url))));assert.equal(frozen.contractSHA256,sha(await readFile(join(base,'input-contract.mjs'))));
 for(const row of frozen.files){assert.equal(sha(await readFile(join(base,row.path))),row.sha256);report.methods.push({path:row.path,beforeSHA256:row.beforeSHA256,sha256:row.sha256,environmentAdaptations:row.adaptations});}assert.equal(frozen.productCommit,fixed.productCommit);assert.equal(frozen.productTree,fixed.productTree);
 for(const row of fixed.criticalFiles)assert.equal(sha(Buffer.from(git('show',fixed.productCommit+':'+row.path).toString('utf8').replaceAll('\r\n','\n'))),row.canonicalSHA256);
 stage='live-same-source-ci';report.sameSourceGates=[];
 for(const [name,path,count] of [['windowsCI','ci.yml',3],['windowsServices','windows-services.yml',21],['lan','lan-regression.yml',2],['linux','linux-ci.yml',1]]){const r=api('actions/runs/'+fixed.runs[name]);assert.equal(r.head_sha,fixed.productCommit);assert.equal(r.head_branch,'main');assert.equal(r.path,'.github/workflows/'+path);assert.equal(r.event,'push');assert.equal(r.status,'completed');assert.equal(r.conclusion,'success');const jobs=api(`actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`);assert.equal(jobs.total_count,count);assert.equal(jobs.jobs.length,count);assert(jobs.jobs.every(j=>j.status==='completed'&&j.conclusion==='success'&&j.head_sha===fixed.productCommit));report.sameSourceGates.push({name,id:r.id,attempt:r.run_attempt,headSHA:r.head_sha,jobs:jobs.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion}))});}
 for(const target of ['windows']){await mkdir(join(work,target));for(const row of frozen.files.filter(r=>r.path.startsWith(target+'/')))await copyFile(join(base,row.path),join(work,row.path));}
 await writeFile(join(work,'acceptance-review-inputs.json'),JSON.stringify({criticalFiles:fixed.criticalFiles})+'\n');
 const source={version:fixed.version,commit:fixed.productCommit,tree:fixed.productTree,runtimeCore:fixed.runtimeCore,runs:fixed.runs,gates:'passed'};await writeFile(join(work,'release-source.json'),JSON.stringify(source)+'\n');
 if(platform==='windows'){
  stage='actual-fixed-reader-node';const setupNodeSHA256=sha(await readFile(process.execPath));assert.equal(setupNodeSHA256,fixed.windowsInputs.nodeSHA256,'Hosted reader Node binary differs from the original official pinned Windows binary');report.readerNode={version:process.version,setupNodeSHA256,officialPinnedBinarySHA256:fixed.windowsInputs.nodeSHA256,byteMatch:true};
  stage='original-pinned-extractor';const tools=join(work,'tools'),unpacked=join(tools,'7zip2201');await mkdir(tools);const archive=join(tools,fixed.windowsExtractorBootstrap.fileName);await writeFile(archive,await getWindowsExtractor(fixed.windowsExtractorBootstrap),{flag:'wx'});report.extractorBootstrap={version:fixed.windowsExtractorBootstrap.version,installerSHA256:sha(await readFile(archive)),maximumRedirects:fixed.windowsExtractorBootstrap.maximumRedirects,authorizationSent:false};
  execFileSync('C:/Program Files/7-Zip/7z.exe',['x','-y','-bsp0','-o'+unpacked,archive],{windowsHide:true,timeout:60000,maxBuffer:2*1024**2,stdio:['ignore','pipe','pipe']});
  const matches=[];async function find(p){for(const e of await readdir(p,{withFileTypes:true})){assert(!e.isSymbolicLink());const f=join(p,e.name);if(e.isDirectory())await find(f);else if(e.name.toLowerCase()==='7z.exe'&&sha(await readFile(f))===fixed.extractorSHA256)matches.push(f);}}await find(unpacked);assert.equal(matches.length,1);
  const win=join(work,'windows'),inputs={...fixed.windowsInputs,extractor:{path:matches[0],sha256:fixed.extractorSHA256}};await writeFile(join(win,'verification-inputs.json'),JSON.stringify(inputs,null,2)+'\n');await mkdir(join(win,'trust'));await writeFile(join(win,'trust/updater.pub'),git('show',fixed.productCommit+':src-tauri/updater.pub'));await writeFile(join(win,'prepared-bundle.json'),JSON.stringify({files:frozen.files.filter(r=>r.path.startsWith('windows/')).map(r=>({path:r.path.slice(8),sha256:r.sha256}))})+'\n');
  stage='source-binding';run(join(win,'bind-release-source.mjs'),[fixed.productCommit,product]);stage='candidate-binding';run(join(win,'bind-candidate.mjs'),[String(fixed.runs.windowsRelease),String(fixed.windowsArtifactID)]);stage='actual-reader-preflight';run(join(win,'preflight-windows-candidate.mjs'));stage='candidate-eight-proofs-static-and-fulltree';run(join(win,'verify-candidate.mjs'),[String(fixed.runs.windowsRelease),String(fixed.windowsArtifactID)]);
  const candidateRoot=join(win,`candidate-${fixed.runs.windowsRelease}-${fixed.windowsArtifactID}`),retrieval=await json(join(candidateRoot,'retrieval.json')),candidate=await json(join(candidateRoot,'candidate-verification.json'));
  assert.deepEqual({bytes:retrieval.artifact.bytes,sha256:retrieval.artifact.sha256},fixed.expectedWindowsArchive,'Candidate archive differs from the reviewed frozen artifact');assert.deepEqual({bytes:candidate.installer.bytes,sha256:candidate.installer.sha256},fixed.expectedWindowsInstaller,'Candidate installer differs from the reviewed public package');
  stage='public-full-get-and-original-key-package-signature';run(join(win,'verify-release.mjs'),['windows']);const publicProof=await json(join(win,'windows-public-verification.json'));assert.deepEqual({bytes:publicProof.bytes,sha256:publicProof.sha256},fixed.expectedWindowsInstaller,'Public package differs from the reviewed signed metadata');
  stage='actual-packaged-ui';run(join(win,'measure-packaged-ui.mjs'),[String(fixed.runs.windowsRelease),String(fixed.windowsArtifactID),'--complete-public']);const measured=await json(join(win,'packaged-ui-verification.json'));assert.equal(measured.dist.files,fixed.expectedFrontendFiles);assert.deepEqual(measured.dist.fileManifest.map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path)),fixed.expectedFrontend,'Actual packaged UI differs from the reviewed golden vector');report.frontendGoldenVectorSHA256=sha(JSON.stringify(fixed.expectedFrontend));report.frontendByteDifferences=0;
  for(const [from,to] of [['windows-public-verification.json','windows-public-verification.json'],['signed-update.json','signed-update.json'],['packaged-ui-verification.json','packaged-ui-verification.json'],[`candidate-${fixed.runs.windowsRelease}-${fixed.windowsArtifactID}/candidate-verification.json`,'candidate-verification.json'],[`candidate-${fixed.runs.windowsRelease}-${fixed.windowsArtifactID}/retrieval.json`,'candidate-retrieval.json'],['windows-candidate-preflight.json','windows-candidate-preflight.json']])await copyFile(join(win,from),join(output,to));report.extractorSHA256=sha(await readFile(matches[0]));report.frontendFiles=measured.dist.files;report.frontendComparison='Exact packaged frontend golden vector passed; root independently compares the same actual manifest';report.scope='Independent hosted Windows static/public consumer; original installation proof checked, no new installation or runtime execution.';
 }
 stage='source-stability';assert.equal(git('status','--porcelain').toString().trim(),'');assert.equal(git('rev-parse','HEAD').toString().trim(),fixed.productCommit);for(const r of frozen.files)assert.equal(sha(await readFile(join(base,r.path))),r.sha256);report.status='passed';report.finishedAt=new Date().toISOString();
}catch(error){report.status='failed';report.failedStage=stage;Object.assign(report,diagnostics(error));report.finishedAt=new Date().toISOString();process.exitCode=1;}
await writeFile(join(output,'consumer-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,platform,failedStage:report.failedStage,productCommit:fixed.productCommit,consumerCommit:report.consumerCommit,producerBuildExecuted:false,publicationExecuted:false,storageMutations:0}));
