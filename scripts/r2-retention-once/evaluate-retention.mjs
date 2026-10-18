import assert from 'node:assert/strict';

const formalTag = /^(linux-)?v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([a-f0-9]{12})-([1-9]\d*)$/;
const formalObject = /^releases\/(linux\/)?((?:linux-)?v\d+\.\d+\.\d+-[a-f0-9]{12}-[1-9]\d*)\/(Rivloom_\d+\.\d+\.\d+_(?:x64-setup\.exe|linux_(?:x64|arm64)\.tar\.gz)|SHA256SUMS\.txt)$/;
const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return right[index] - left[index];
  return 0;
};

// Pure planning only. This module has no network access or storage mutation.
export function evaluateRetention({ inventory, releases, protectedKeys, evaluatedAt }) {
  const now = Date.parse(evaluatedAt), windowMs = 30 * 24 * 3600000;
  assert(Number.isFinite(now)); assert(Array.isArray(inventory)); assert(Array.isArray(releases));
  assert.equal(new Set(inventory.map(item => item.Key)).size, inventory.length, 'Duplicate object keys');
  const formal = releases.flatMap(release => {
    const match = formalTag.exec(release.tag_name ?? '');
    if (!match || release.draft || release.prerelease) return [];
    return [{ ...release, platform: match[1] ? 'linux' : 'windows', version: match[2], sourcePrefix: match[3] }];
  });
  assert.equal(new Set(formal.map(release => release.tag_name)).size, formal.length, 'Duplicate formal release tags');
  const latestThree = Object.fromEntries(['windows', 'linux'].map(platform => [platform,
    [...new Set(formal.filter(release => release.platform === platform && Number.isFinite(Date.parse(release.published_at)) && Date.parse(release.published_at) <= now).map(release => release.version))].sort(compareVersions).slice(0, 3)]));
  const protectedSet = new Set(protectedKeys);
  const objects = inventory.map(object => {
    assert.equal(typeof object.Key, 'string');
    const reasons = []; let decision = 'retain';
    const match = formalObject.exec(object.Key);
    const release = match && formal.find(item => item.tag_name === match[2]);
    if (protectedSet.has(object.Key)) reasons.push('Referenced by current download page, CLI entry or latest pointer');
    if (/^updates\/stable\/(latest|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.json$/.test(object.Key) || ['releases/latest.json', 'releases/linux/latest.json'].includes(object.Key)) reasons.push('Version metadata/current pointer: retain long term');
    if (release) {
      const published = Date.parse(release.published_at), modified = Date.parse(object.LastModified);
      if (latestThree[release.platform].includes(release.version)) reasons.push(`One of latest three formal ${release.platform} versions`);
      if (Number.isFinite(published) && published <= now && now - published <= windowMs) reasons.push('Formal release published within 30 days');
      if (Number.isFinite(modified) && modified <= now && now - modified <= windowMs) reasons.push('Object uploaded or modified within 30 days');
      const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset.name === match[3]) : [];
      const asset = assets.length === 1 ? assets[0] : null;
      const canonicalKey = `releases/${release.platform === 'linux' ? 'linux/' : ''}${release.tag_name}/${match[3]}`;
      const expectedName = match[3] === 'SHA256SUMS.txt' || (release.platform === 'linux'
        ? [`Rivloom_${release.version}_linux_x64.tar.gz`, `Rivloom_${release.version}_linux_arm64.tar.gz`].includes(match[3])
        : match[3] === `Rivloom_${release.version}_x64-setup.exe`);
      if (!asset || asset.size !== object.Size || !Number.isSafeInteger(object.Size) || object.Size <= 0 || !expectedName || object.Key !== canonicalKey) {
        decision = 'defer'; reasons.push('Formal asset path/identity/size requires review');
      }
      if (!Number.isFinite(published) || published > now || !Number.isFinite(modified) || modified > now) {
        decision = 'defer'; reasons.push('Missing/anomalous timestamp: preserve');
      }
      if (!/^[a-f0-9]{40}$/.test(release.target_commitish ?? '') || !release.target_commitish.startsWith(release.sourcePrefix)) {
        decision = 'defer'; reasons.push('Formal release source binding requires review');
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest ?? '') || !/^"[\x21\x23-\x7e]{1,128}"$/.test(object.ETag ?? '')) {
        decision = 'defer'; reasons.push('Formal asset digest or object ETag requires review');
      }
      if (!reasons.length) {
        decision = 'eligible'; reasons.push('Known formal asset outside newest three, older than 30 days and not referenced');
      }
      return { key: object.Key, bytes: object.Size, etag: object.ETag, lastModified: object.LastModified, releaseTag: release.tag_name, releasePublishedAt: release.published_at, releaseURL: release.html_url, formalAssetSHA256: asset?.digest?.replace(/^sha256:/, '') ?? null, sourceCommit: release.target_commitish, decision, reasons };
    }
    if (!reasons.length) { decision = 'defer'; reasons.push('Unknown path or no traceable formal release: preserve'); }
    return { key: object.Key, bytes: object.Size, etag: object.ETag, lastModified: object.LastModified, releaseTag: null, releasePublishedAt: null, releaseURL: null, decision, reasons };
  });
  for (const key of protectedSet) assert(objects.some(object => object.key === key), 'Missing protected current object: ' + key);
  const counts = Object.fromEntries(['retain', 'defer', 'eligible'].map(decision => [decision, objects.filter(object => object.decision === decision).length]));
  return { retentionEvaluatedAt: new Date(now).toISOString(), recentWindowDays: 30, latestThree, counts, objects };
}
