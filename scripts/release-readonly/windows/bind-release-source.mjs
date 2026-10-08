// Offline source binding only. No network, build, install or payload execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const base=import.meta.dirname;
const [commit,requestedCheckout]=process.argv.slice(2);assert.match(commit??'',/^(?!0{40}$)[a-f0-9]{40}$/);assert(path.isAbsolute(requestedCheckout??''));
const checkout=path.resolve(requestedCheckout);assert.notEqual(checkout,path.resolve('C:/project/rivloom-opencode'),'Use an isolated clean official release checkout');
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${checkout}`,...args],{cwd:checkout,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:16*1024**2,stdio:['ignore','pipe','pipe']}).trim();
function regular(file){let current=path.parse(path.resolve(file)).root;for(const part of path.resolve(file).slice(current.length).split(path.sep)){current=path.join(current,part);assert(!fs.lstatSync(current).isSymbolicLink(),'Linked source/evidence ancestor refused')};assert(fs.lstatSync(file).isFile());}
const inputsBytes=fs.readFileSync(base+'/verification-inputs.json');const inputs=JSON.parse(inputsBytes);
assert.equal(process.versions.node,inputs.nodeVersion);assert.equal(git('rev-parse','HEAD'),commit);assert.equal(git('status','--porcelain','--untracked-files=normal'),'');
const app=JSON.parse(fs.readFileSync(checkout+'/package.json'));const lock=JSON.parse(fs.readFileSync(checkout+'/package-lock.json'));const tauri=JSON.parse(fs.readFileSync(checkout+'/src-tauri/tauri.conf.json'));
assert.equal(app.version,inputs.version);assert.equal(lock.version,inputs.version);assert.equal(lock.packages[''].version,inputs.version);assert.equal(tauri.version,inputs.version);assert.equal(tauri.identifier,'com.rivloom.desktop');
for(const name of ['@opencode-ai/sdk','@opencode-ai/plugin']){assert.equal(app.dependencies[name],inputs.packageVersion);assert.equal(lock.packages['node_modules/'+name].version,inputs.packageVersion)}
assert.deepEqual(JSON.parse(fs.readFileSync(checkout+'/shared/engine-source.json')),inputs.reviewedEngineSource);
regular(checkout+'/src-tauri/updater.pub');assert.equal(sha(fs.readFileSync(checkout+'/src-tauri/updater.pub')),inputs.originalPublicKeySHA256);
assert(!fs.existsSync(base+'/release-source.json'));assert(!fs.existsSync(base+'/public-source'),'Never overwrite a previous binding');
const review=JSON.parse(fs.readFileSync(path.resolve(base,'../acceptance-review-inputs.json')));
for(const row of review.criticalFiles){const bytes=fs.readFileSync(path.join(checkout,row.path));assert.equal(sha(Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n'))),row.canonicalSHA256,'Release source is missing reviewed bug fixes: '+row.path);}
const inputPaths=['package.json','package-lock.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','shared/engine-source.json','scripts/download-record.ts','scripts/updater-manifest.ts','src-tauri/updater.pub',...review.criticalFiles.map(row=>row.path)];
const boundFiles=[];
for(const relative of inputPaths){const file=path.join(checkout,relative);regular(file);const bytes=fs.readFileSync(file);const blob=execFileSync('git',['-c',`safe.directory=${checkout}`,'show',commit+':'+relative],{cwd:checkout,windowsHide:true,maxBuffer:16*1024**2,stdio:['ignore','pipe','pipe']});assert.equal(bytes.toString('utf8').replaceAll('\r\n','\n'),blob.toString('utf8').replaceAll('\r\n','\n'));boundFiles.push({path:relative,bytes:bytes.length,sha256:sha(bytes),gitSHA256:sha(blob)})}
fs.mkdirSync(base+'/public-source');const publicSourceFiles={};
for(const [from,to] of [['scripts/download-record.ts','download-record.ts'],['scripts/updater-manifest.ts','updater-manifest.ts'],['src-tauri/updater.pub','updater.pub']]){const bytes=fs.readFileSync(path.join(checkout,from));fs.writeFileSync(base+'/public-source/'+to,bytes,{flag:'wx'});publicSourceFiles['public-source/'+to]=sha(bytes)}
assert.equal(git('status','--porcelain','--untracked-files=normal'),'');assert.equal(git('rev-parse','HEAD'),commit);
const source={version:inputs.version,commit,tree:git('rev-parse','HEAD^{tree}'),checkout,runtimeCore:inputs.runtimeCore,runs:{windowsRelease:null},windowsArtifactID:null,verificationInputsSHA256:sha(inputsBytes),publicSourceFiles,boundFiles,preparedAt:new Date().toISOString(),binding:'Offline exact clean release source; cloud candidate and public package remain pending'};
fs.writeFileSync(base+'/release-source.json',JSON.stringify(source,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'source-bound-awaiting-candidate',commit,version:source.version,files:boundFiles.length,downloaded:false}));
