/** Public release data contract. This module has no filesystem, network or signing side effects. */
import { z } from 'zod';

export const releaseRecordSchemaVersion = 1;
export const releaseIdentities = {
  desktop: 'com.rivloom.desktop',
  'conversation-preview': 'com.rivloom.conversationpreview',
} as const;

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const releaseVersionSchema = z
  .string()
  .max(100)
  .regex(semverPattern, 'Expected strict SemVer');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const versions = z
  .array(releaseVersionSchema)
  .max(100)
  .refine(unique, 'Duplicate application version');
const formatVersions = z
  .array(z.number().int().nonnegative())
  .max(100)
  .refine(unique, 'Duplicate format version');
const timestamp = z
  .string()
  .max(24)
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const date = new Date(value);
    return (
      Number.isFinite(date.getTime()) &&
      [date.toISOString(), date.toISOString().replace('.000Z', 'Z')].includes(value)
    );
  }, 'Expected an actual UTC ISO timestamp');

/** No credentials, redirects encoded in a query, local hosts, development or example domains. */
export function isPublicReleaseUrl(value: string) {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.port &&
      value === url.href &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) &&
      !/^[\d.]+$/.test(host) &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host) &&
      !/(?:^|\.)example\.(?:com|net|org)$/.test(host) &&
      !/(?:^|\.)r2\.dev$/.test(host)
    );
  } catch {
    return false;
  }
}
const publicUrl = z
  .string()
  .refine(
    isPublicReleaseUrl,
    'Expected a canonical public HTTPS URL without credentials, query or fragment',
  );

const productSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('desktop'), identifier: z.literal(releaseIdentities.desktop) })
    .strict(),
  z
    .object({
      kind: z.literal('conversation-preview'),
      identifier: z.literal(releaseIdentities['conversation-preview']),
    })
    .strict(),
]);
const sourceSchema = z
  .object({
    commit: z
      .string()
      .regex(/^(?!0{40}$)[0-9a-f]{40}$/, 'Expected a full nonzero Git SHA-1 commit'),
    workingTree: z.enum(['clean', 'dirty']),
  })
  .strict();
const notesSchema = z
  .object({
    summary: text(500),
    changes: z.array(text(2000)).min(1).max(100),
    knownIssues: z.array(text(2000)).max(100),
    url: publicUrl.nullable(),
  })
  .strict();
const compatibilitySchema = z
  .object({
    windows: z
      .object({
        versions: z
          .array(z.enum(['10', '11']))
          .min(1)
          .max(2)
          .refine(unique, 'Duplicate Windows version'),
        architecture: z.literal('x86_64'),
        installMode: z.literal('currentUser'),
        webview2: z.literal('required'),
      })
      .strict(),
    upgradeFrom: versions,
    node: z
      .object({
        protocolVersion: z.number().int().positive(),
        requiredCapabilities: z
          .array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/))
          .max(100)
          .refine(unique, 'Duplicate capability'),
        testedAppVersions: versions,
      })
      .strict(),
    data: z
      .object({
        writtenVersion: z.number().int().nonnegative(),
        readableVersions: formatVersions,
        migratableFromVersions: formatVersions,
      })
      .strict(),
    automaticDowngrade: z.literal(false),
  })
  .strict();
const verificationSchema = z
  .object({
    artifactSha256: sha256,
    checkedAt: timestamp,
    tool: text(200),
  })
  .strict();
const authenticodeSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('not-verified'),
      publisher: z.null(),
      timestamped: z.null(),
      verification: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unsigned'),
      publisher: z.null(),
      timestamped: z.null(),
      verification: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('verified'),
      publisher: text(500),
      timestamped: z.boolean(),
      verification: verificationSchema,
    })
    .strict(),
]);
const signatureText = z
  .string()
  .min(40)
  .max(8192)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    'Expected signature file content as base64, not a URL or placeholder',
  );
const updaterSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('not-configured'),
      signature: z.null(),
      publicKeyFingerprint: z.null(),
      verification: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('not-verified'),
      signature: signatureText,
      publicKeyFingerprint: sha256,
      verification: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('verified'),
      signature: signatureText,
      publicKeyFingerprint: sha256,
      verification: verificationSchema,
    })
    .strict(),
]);
const metadataShape = {
  product: productSchema,
  channel: z.enum(['stable', 'beta', 'preview']),
  version: releaseVersionSchema,
  source: sourceSchema,
  notes: notesSchema,
  compatibility: compatibilitySchema,
};
type IdentityMetadata = {
  product: z.infer<typeof productSchema>;
  channel: 'stable' | 'beta' | 'preview';
  version: string;
  compatibility: z.infer<typeof compatibilitySchema>;
};
function metadataConsistency(value: IdentityMetadata, context: z.RefinementCtx) {
  const issue = (path: string[], message: string) =>
    context.addIssue({ code: 'custom', path, message });
  if ((value.product.kind === 'conversation-preview') !== (value.channel === 'preview'))
    issue(
      ['channel'],
      'Preview identity is exclusive to preview; desktop identity is exclusive to stable/beta',
    );
  const prerelease = semverPattern.exec(value.version)?.[4];
  if (value.channel === 'stable' && prerelease)
    issue(['version'], 'Stable must not use a prerelease version');
  if (value.channel === 'beta' && (!prerelease || prerelease.split('.')[0] !== 'beta'))
    issue(['version'], 'Beta requires an explicit -beta prerelease version');
  if (!value.compatibility.data.readableVersions.includes(value.compatibility.data.writtenVersion))
    issue(
      ['compatibility', 'data', 'readableVersions'],
      'The written data format must be readable',
    );
  if (
    value.compatibility.data.migratableFromVersions.some(
      (version) => version >= value.compatibility.data.writtenVersion,
    )
  )
    issue(
      ['compatibility', 'data', 'migratableFromVersions'],
      'Migration sources must precede the written format',
    );
}
export const candidateMetadataSchema = z
  .object(metadataShape)
  .strict()
  .superRefine(metadataConsistency);
export type CandidateMetadata = z.infer<typeof candidateMetadataSchema>;

const artifactSchema = z
  .object({
    format: z.literal('nsis'),
    fileName: z
      .string()
      .max(180)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._ +()-]*\.exe$/,
        'Expected a plain .exe filename without path separators',
      ),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256,
    url: publicUrl.nullable(),
  })
  .strict();
export function immutableReleaseDirectory(
  product: IdentityMetadata['product'],
  channel: IdentityMetadata['channel'],
  version: string,
) {
  return `/releases/${product.identifier}/${channel}/${encodeURIComponent(version)}/`;
}
export const releaseRecordSchema = z
  .object({
    schemaVersion: z.literal(releaseRecordSchemaVersion),
    kind: z.literal('rivloom-windows-release'),
    status: z.enum(['candidate', 'published']),
    ...metadataShape,
    platform: z.literal('windows-x86_64'),
    publishedAt: timestamp.nullable(),
    artifact: artifactSchema,
    signatures: z
      .object({ authenticode: authenticodeSchema, tauriUpdater: updaterSchema })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    metadataConsistency(value, context);
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (value.status === 'candidate') {
      if (value.publishedAt !== null || value.artifact.url !== null)
        issue(['status'], 'Candidates cannot carry a publication date or public download URL');
    } else {
      if (!value.publishedAt || !value.artifact.url)
        issue(['status'], 'Published records require publishedAt and a public download URL');
      if (value.source.workingTree !== 'clean')
        issue(['source', 'workingTree'], 'Published records require a clean source commit');
      if (value.artifact.url && isPublicReleaseUrl(value.artifact.url)) {
        const required =
          immutableReleaseDirectory(value.product, value.channel, value.version) +
          encodeURIComponent(value.artifact.fileName);
        if (new URL(value.artifact.url).pathname !== required)
          issue(
            ['artifact', 'url'],
            `Download URL must use immutable identity/channel/version path ${required}`,
          );
      }
      if (
        value.channel === 'stable' &&
        (value.signatures.authenticode.status !== 'verified' ||
          !value.signatures.authenticode.timestamped)
      )
        issue(
          ['signatures', 'authenticode'],
          'Published stable requires recorded Authenticode verification with timestamp',
        );
    }
    for (const [name, signature] of Object.entries(value.signatures)) {
      if (
        signature.status === 'verified' &&
        signature.verification.artifactSha256 !== value.artifact.sha256
      )
        issue(
          ['signatures', name, 'verification'],
          'Signature verification must refer to the final installer hash',
        );
      if (
        signature.status === 'verified' &&
        value.publishedAt &&
        Date.parse(signature.verification.checkedAt) > Date.parse(value.publishedAt)
      )
        issue(
          ['signatures', name, 'verification', 'checkedAt'],
          'Signature verification must precede publication',
        );
    }
    if (
      value.product.kind === 'conversation-preview' &&
      value.signatures.tauriUpdater.status !== 'not-configured'
    )
      issue(
        ['signatures', 'tauriUpdater'],
        'Preview records do not join the formal updater channel',
      );
  });
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export function parseReleaseRecord(
  value: unknown,
  options: { requirePublished?: boolean } = {},
): ReleaseRecord {
  const record = releaseRecordSchema.parse(value);
  if (options.requirePublished && record.status !== 'published')
    throw new Error('A candidate is not a published download record');
  return record;
}

/** Candidates contain measured bytes/hash, but no assertion of publication or signature verification. */
export function createCandidateRecord(
  metadata: unknown,
  artifact: Omit<ReleaseRecord['artifact'], 'format' | 'url'>,
): ReleaseRecord {
  return parseReleaseRecord({
    schemaVersion: releaseRecordSchemaVersion,
    kind: 'rivloom-windows-release',
    status: 'candidate',
    ...candidateMetadataSchema.parse(metadata),
    platform: 'windows-x86_64',
    publishedAt: null,
    artifact: { ...artifact, format: 'nsis', url: null },
    signatures: {
      authenticode: {
        status: 'not-verified',
        publisher: null,
        timestamped: null,
        verification: null,
      },
      tauriUpdater: {
        status: 'not-configured',
        signature: null,
        publicKeyFingerprint: null,
        verification: null,
      },
    },
  });
}
