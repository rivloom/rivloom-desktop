import { parseReleaseRecord } from './release-record.ts';
import {
  isReleaseCli,
  readReleaseJson,
  releaseArguments,
  verifyInstaller,
} from './release-files.ts';

export async function validateReleaseFile(
  recordPath: string,
  options: { artifactPath?: string; requirePublished?: boolean } = {},
) {
  const record = parseReleaseRecord(await readReleaseJson(recordPath), options);
  if (options.artifactPath) await verifyInstaller(record, options.artifactPath);
  return record;
}

if (isReleaseCli(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(' ') === '--help') {
      console.log(
        'node scripts/release-validate.ts --record <release.json> [--artifact <final-setup.exe>] [--require-published]\nChecks structure, cross-field consistency, and optional local bytes/hash. Does not verify signatures, fetch URLs, or authorize publication.',
      );
    } else {
      const flags = releaseArguments(
        process.argv.slice(2),
        ['--record', '--artifact', '--require-published'],
        ['--record'],
      );
      const record = await validateReleaseFile(flags.get('--record')!, {
        artifactPath: flags.get('--artifact'),
        requirePublished: flags.has('--require-published'),
      });
      console.log(
        JSON.stringify(
          {
            valid: true,
            status: record.status,
            identifier: record.product.identifier,
            version: record.version,
            artifactChecked: flags.has('--artifact'),
            signatureVerification: 'not performed',
            publicUrlCheck: 'syntax only; not fetched',
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
