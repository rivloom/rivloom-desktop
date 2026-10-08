import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('./',import.meta.url);
const json=async name=>JSON.parse((await readFile(new URL(name,root),'utf8')).replace(/^\uFEFF/,''));
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputBytes=await readFile(new URL('verification-inputs.json',root));
const inputs=JSON.parse(inputBytes);
export const source=await json('release-source.json');
export const expectations={...inputs,commit:source.commit,sourceFiles:source.publicSourceFiles};
assert.equal(source.version,inputs.version);assert.equal(source.runtimeCore,inputs.runtimeCore);
assert.match(source.commit,/^(?!0{40}$)[a-f0-9]{40}$/);assert.match(source.tree,/^(?!0{40}$)[a-f0-9]{40}$/);
assert.equal(source.verificationInputsSHA256,sha(inputBytes));
assert(typeof source.checkout==='string'&&source.checkout);
assert(Array.isArray(inputs.notesIncludes)&&inputs.notesIncludes.length>0);
assert.equal(sha(await readFile(new URL('trust/updater.pub',root))),inputs.originalPublicKeySHA256);
assert(source.publicSourceFiles&&Object.keys(source.publicSourceFiles).length===3);
for(const [relative,digest] of Object.entries(source.publicSourceFiles)){
 assert.match(relative,/^public-source\/(?:download-record\.ts|updater-manifest\.ts|updater\.pub)$/);
 const info=await lstat(new URL(relative,root));assert(info.isFile()&&!info.isSymbolicLink());
 assert.equal(sha(await readFile(new URL(relative,root))),digest,'Bound public verifier input changed');
}
assert.equal(source.publicSourceFiles['public-source/updater.pub'],inputs.originalPublicKeySHA256);
