// All remote operations are metadata GETs. Does not retrieve the candidate archive.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {sourceContext,sourceUnchanged} from './fetch-candidate-evidence.mjs';
const base=import.meta.dirname;const [runID,artifactID]=process.argv.slice(2);assert(/^[1-9]\d{0,15}$/.test(runID??''));assert(/^[1-9]\d{0,15}$/.test(artifactID??''));
const context=await sourceContext(),source=context.source,repository='rivloom/rivloom-desktop';
await assert.rejects(lstat(join(base,'candidate-binding.json')),{code:'ENOENT'});
assert.equal(source.runs.windowsRelease,null);assert.equal(source.windowsArtifactID,null);
const get=p=>JSON.parse(execFileSync('gh',['api','--hostname','github.com','--method','GET',`repos/${repository}/${p}`],{windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:4*1024**2,stdio:['ignore','pipe','pipe']}));
const run=get(`actions/runs/${runID}`);assert.equal(run.id,Number(runID));assert.equal(run.head_branch,'main');assert.equal(run.repository.full_name,repository);assert.equal(run.head_repository.full_name,repository);assert.equal(run.path,'.github/workflows/windows-candidate.yml');assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');assert(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0);
assert(['workflow_run','workflow_dispatch','push'].includes(run.event));if(run.event!=='workflow_run')assert.equal(run.head_sha,source.commit);
const artifact=get(`actions/artifacts/${artifactID}`);assert.equal(artifact.id,Number(artifactID));assert.equal(artifact.name,`rivloom-candidate-${source.commit}-${runID}-${run.run_attempt}`);assert.equal(artifact.expired,false);assert.equal(artifact.workflow_run.id,run.id);assert.equal(artifact.workflow_run.repository_id,run.repository.id);assert.equal(artifact.workflow_run.head_repository_id,run.repository.id);assert.match(artifact.digest,/^sha256:[a-f0-9]{64}$/);assert(artifact.size_in_bytes>1000000&&artifact.size_in_bytes<=256*1024**2);
await sourceUnchanged(context);source.runs.windowsRelease=runID;source.windowsArtifactID=artifactID;
await writeFile(join(base,'candidate-binding.json'),JSON.stringify({status:'bound-awaiting-static-verification',at:new Date().toISOString(),commit:source.commit,runID,artifactID,runAttempt:run.run_attempt,event:run.event,metadataHeadSHA:run.head_sha,name:artifact.name,bytes:artifact.size_in_bytes,digest:artifact.digest,candidateArchiveDownloaded:false,compiledSourceProof:'Exact source-bearing artifact and original eight CI proofs must still pass verify-candidate.mjs'},null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'release-source.json'),JSON.stringify(source,null,2)+'\n');console.log(JSON.stringify({runID,artifactID,attempt:run.run_attempt,archiveDownloaded:false}));
