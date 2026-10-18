// Pure validation. No filesystem, network, subprocess or publication operations.
import assert from 'node:assert/strict';
const commit=/^(?!0{40}$)[a-f0-9]{40}$/;
const digest=/^[a-f0-9]{64}$/;
const numericID=value=>/^[1-9]\d{0,15}$/.test(String(value))&&Number.isSafeInteger(Number(value));
const regularPath=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!value.startsWith('/')&&!value.includes('\\')&&!value.includes(':')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
export function missingInputs(fixed){
 const missing=[];
 for(const name of ['productCommit','productTree','trackedFiles','windowsArtifactID','expectedWindowsArchive','expectedWindowsInstaller','expectedFrontendFiles'])if(fixed[name]===null||fixed[name]===undefined)missing.push(name);
 for(const name of ['windowsCI','windowsServices','lan','linux','windowsRelease'])if(!fixed.runs?.[name])missing.push('runs.'+name);
 for(const name of ['criticalFiles','expectedFrontend'])if(!Array.isArray(fixed[name])||fixed[name].length===0)missing.push(name);
 return missing;
}
export function validateFixed(fixed){
 assert.deepEqual(missingInputs(fixed),[],'Official source, successful runs, candidate artifact and new frontend inputs must be bound before execution');
 assert.equal(fixed.schemaVersion,1);assert.equal(fixed.status,'frozen-for-independent-consumer');
 assert.equal(fixed.version,'0.1.31');assert.equal(fixed.previousVersion,'0.1.30');
 assert.match(fixed.consumerBranch,/^codex\/release-readonly-0131-[a-z0-9-]+$/);
 assert.match(fixed.productCommit,commit);assert.match(fixed.productTree,commit);assert.match(fixed.runtimeCore,commit);
 assert(Number.isSafeInteger(fixed.trackedFiles)&&fixed.trackedFiles>300);
 assert(numericID(fixed.windowsArtifactID));
 for(const id of Object.values(fixed.runs))assert(numericID(id));
 assert.deepEqual(Object.keys(fixed.runs).sort(),['lan','linux','windowsCI','windowsRelease','windowsServices']);
 for(const name of ['expectedWindowsArchive','expectedWindowsInstaller']){const value=fixed[name];assert(Number.isSafeInteger(value.bytes)&&value.bytes>1_000_000&&value.bytes<=256*1024**2);assert.match(value.sha256,digest);}
 assert(Number.isSafeInteger(fixed.expectedFrontendFiles)&&fixed.expectedFrontendFiles>0&&fixed.expectedFrontendFiles<1000);
 assert.equal(fixed.expectedFrontendFiles,fixed.expectedFrontend.length);
 assert.equal(new Set(fixed.expectedFrontend.map(row=>row.path)).size,fixed.expectedFrontend.length);
 assert(fixed.expectedFrontend.some(row=>row.path==='index.html'));
 for(const row of fixed.expectedFrontend){assert(regularPath(row.path));assert(Number.isSafeInteger(row.bytes)&&row.bytes>0);assert.match(row.sha256,digest);}
 assert.equal(new Set(fixed.criticalFiles.map(row=>row.path)).size,fixed.criticalFiles.length);
 for(const row of fixed.criticalFiles){assert(regularPath(row.path));assert.match(row.canonicalSHA256,digest);}
 for(const required of ['src/desktop-update.tsx','src/app-version.ts','shared/locales/en.json','shared/locales/zh-CN.json','scripts/ci-candidate-readiness.ts'])assert(fixed.criticalFiles.some(row=>row.path===required),'Missing reviewed current change: '+required);
 const inputs=fixed.windowsInputs;assert.equal(inputs.version,fixed.version);assert.equal(inputs.previousVersion,fixed.previousVersion);assert.equal(inputs.runtimeCore,fixed.runtimeCore);
 assert.equal(fixed.nodeVersion,'24.19.0');assert.equal(inputs.nodeVersion,fixed.nodeVersion);assert.equal(inputs.packageVersion,'1.18.33');
 assert.equal(inputs.originalPublicKeySHA256,'0bdeb1bda7c41f5c3318cb4b0a36d45a310e720ebbf17da2012e1f27de5515c1');
 assert.equal(inputs.nodeSHA256,'3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237');
 assert.match(inputs.nodeLicenseSHA256,digest);assert.equal(inputs.reviewedEngineSource.commit,fixed.runtimeCore);
 assert(Array.isArray(inputs.notesIncludes)&&inputs.notesIncludes.includes(fixed.version)&&inputs.notesIncludes.every(value=>typeof value==='string'&&value.length>0));
 assert.equal(fixed.extractorSHA256,'254cf6411d38903b2440819f7e0a847f0cfee7f8096cfad9e90fea62f42b0c23');
 assert.equal(fixed.windowsExtractorBootstrap.installerSHA256,'b055fee85472921575071464a97a79540e489c1c3a14b9bdfbdbab60e17f36e4');
 return fixed;
}
