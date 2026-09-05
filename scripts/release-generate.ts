import { createCandidateRecord } from './release-record.ts';
import {
  isReleaseCli,
  measureInstaller,
  readReleaseJson,
  releaseArguments,
  writeCandidateRecord,
} from './release-files.ts';

export async function generateReleaseCandidate(
  metadataPath: string,
  installerPath: string,
  outputRoot: string,
) {
  const metadata = await readReleaseJson(metadataPath);
  const artifact = await measureInstaller(installerPath);
  const record = createCandidateRecord(metadata, artifact);
  const path = await writeCandidateRecord(record, outputRoot);
  return { path, record };
}

if (isReleaseCli(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(' ') === '--help') {
      console.log(
        'node scripts/release-generate.ts --metadata <candidate-metadata.json> --installer <final-setup.exe> --output-root <new-run-directory>\nOnly generates a local candidate. Does not sign, publish, upload, or generate updater/channel metadata.',
      );
    } else {
      const flags = releaseArguments(
        process.argv.slice(2),
        ['--metadata', '--installer', '--output-root'],
        ['--metadata', '--installer', '--output-root'],
      );
      const { path, record } = await generateReleaseCandidate(
        flags.get('--metadata')!,
        flags.get('--installer')!,
        flags.get('--output-root')!,
      );
      console.log(
        JSON.stringify(
          {
            path,
            status: record.status,
            identifier: record.product.identifier,
            version: record.version,
            bytes: record.artifact.bytes,
            sha256: record.artifact.sha256,
            signatureVerification: 'not performed',
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
