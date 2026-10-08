// Offline only: verify source validator closure and prepared helper identities; no artifact request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parse} from '@babel/parser';
import {sourceContext,sourceUnchanged,checkout,digest,git} from './fetch-candidate-evidence.mjs';
import './expected-release.mjs';
const base=import.meta.dirname,context=await sourceContext();
assert.equal(process.versions.node,'24.19.0');
const prepared=JSON.parse(fs.readFileSync(base+'/prepared-bundle.json'));
for(const row of prepared.files){assert.equal(digest(fs.readFileSync(base+'/'+row.path)),row.sha256,'Prepared helper changed: '+row.path)}
for(const row of context.source.boundFiles)assert.equal(digest(fs.readFileSync(path.join(checkout,row.path))),row.sha256,'Bound source input changed');
const roots=['scripts/ci-release.ts','scripts/ci-desktop-install-smoke.ts','server/engine-artifact.ts'];
const queue=[...roots],seen=new Set(),modules=[],external=new Set(),dynamic=[];
while(queue.length){const relative=queue.shift();if(seen.has(relative))continue;seen.add(relative);assert(!path.isAbsolute(relative)&&!relative.startsWith('../'));
 const file=path.join(checkout,relative);assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());const bytes=fs.readFileSync(file);const committed=execFileSync('git',['-c',`safe.directory=${checkout}`,'show',context.source.commit+':'+relative],{cwd:checkout,windowsHide:true,maxBuffer:16*1024**2,stdio:['ignore','pipe','pipe']});
 assert.equal(bytes.toString('utf8').replaceAll('\r\n','\n'),committed.toString('utf8').replaceAll('\r\n','\n'),'Validator source differs from committed release');
 const imports=[];const add=(node,kind)=>node?.type==='StringLiteral'?imports.push(node.value):dynamic.push({file:relative,kind});
 function visit(node){if(!node||typeof node!=='object')return;if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)add(node.source,node.type);if(node.type==='ImportExpression')add(node.source,node.type);if(node.type==='TSImportType')add(node.source??node.argument,node.type);if(node.type==='TSExternalModuleReference')add(node.expression,node.type);if(node.type==='CallExpression'&&((node.callee?.type==='Identifier'&&node.callee.name==='require')||node.callee?.type==='Import'))add(node.arguments[0],node.type);for(const [key,value] of Object.entries(node))if(!['loc','start','end','comments','tokens'].includes(key)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value)}}
 if(relative.endsWith('.json'))JSON.parse(bytes);else visit(parse(bytes.toString('utf8'),{sourceType:'module',plugins:['typescript']}));
 for(const ref of new Set(imports)){if(ref.startsWith('.')){const resolved=path.relative(checkout,path.resolve(path.dirname(file),ref)).replaceAll('\\','/');assert(!resolved.startsWith('../'));queue.push(resolved)}else external.add(ref)}
 modules.push({path:relative,bytes:bytes.length,sha256:digest(bytes),gitSHA256:digest(committed),imports:[...new Set(imports)].sort()});
}
assert.deepEqual(dynamic,[],'Review dynamic validator imports before verification');
const inputs=JSON.parse(fs.readFileSync(base+'/verification-inputs.json'));assert.equal(digest(fs.readFileSync(inputs.extractor.path)),inputs.extractor.sha256);
await sourceUnchanged(context);const report={status:'preflight-passed-awaiting-candidate',at:new Date().toISOString(),commit:context.source.commit,version:context.source.version,checkout,sourceRecordSHA256:context.sourceSHA256,validatorModules:modules.sort((a,b)=>a.path.localeCompare(b.path)),externalImports:[...external].sort(),helperHashesVerified:true,extractorVerified:true,installerExecuted:false,runtimeExecuted:false,artifactDownloaded:false};
fs.writeFileSync(base+'/windows-candidate-preflight.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,validatorModules:modules.length,downloaded:false}));
