// Only these reconstructed values may leave the engine startup error boundary.
// In particular, SDK errors can contain provider configuration, URLs and credentials.
const kinds = [
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
  'AbortError', 'TimeoutError', 'UnknownError', 'SystemError', 'ResolveMessage', 'BuildMessage',
  'ConfigInvalidError', 'ConfigJsonError', 'ConfigFrontmatterError', 'ConfigDirectoryTypoError', 'ConfigRemoteAuthError',
  'InvalidRequestError', 'UnauthorizedError', 'ForbiddenError', 'ConflictError', 'UpstreamError', 'ServiceUnavailableError',
  'NotFoundError', 'ProviderNotFoundError', 'ModelNotFoundError', 'ProviderAuthError', 'APIError', 'ServeError',
] as const;
const codes = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS',
  'EINVAL', 'EIO', 'ENOEXEC', 'E2BIG', 'EBADF', 'EPIPE', 'ENOMEM', 'EADDRINUSE', 'EADDRNOTAVAIL',
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT',
  'ABORT_ERR', 'ERR_ABORTED', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_UNSUPPORTED_DIR_IMPORT', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_DLOPEN_FAILED',
  'ERR_INVALID_MODULE_SPECIFIER', 'ERR_INVALID_PACKAGE_CONFIG', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
] as const;
const markerRules = [
  ['startup-timeout', /^OpenCode 启动超时$/],
  ['engine-exit', /^OpenCode 退出 \((?:null|-?\d+)\):/],
  ['engine-version', /^引擎版本不匹配/],
  ['listener-address', /^OpenCode 返回了非预期监听地址/],
  ['bind-conflict', /^OpenCode 启动时 HTTP 端口 \d+ 已不可用/],
  ['shutdown-unproven', /Owned OpenCode process tree did not exit cleanly|启动失败的 OpenCode 子进程未及时退出/],
  ['runtime-missing', /^Rivloom runtime missing\./],
  ['plugin-dependency', /knowledge_plugin_dependency_(?:missing|invalid)|background dependency install failed|plugin dependenc/i],
  ['unsafe-directory', /^knowledge_unsafe_directory$/],
  ['module-resolution', /cannot find (?:module|package)|could not resolve|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i],
  ['timeout', /\b(?:timed out|timeout|TimeoutError)\b/i],
  ['fetch-failed', /\bfetch failed\b/i],
  ['network', /connection refused|connection reset|socket hang up|network error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i],
  ['permission', /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i],
  ['configuration', /Config(?:Invalid|Json|Frontmatter|DirectoryTypo|RemoteAuth)Error|invalid configuration/i],
  ['plugin-load', /failed to (?:load|resolve|import) plugin/i],
  ['database', /SQLITE_(?:ERROR|BUSY|LOCKED|CANTOPEN|CORRUPT)|database is locked|unable to open database/i],
] as const;

export type EngineStartupPhase = 'start-engine' | 'providers';
export type EngineStartupDiagnostic = {
  phase: EngineStartupPhase;
  kind: typeof kinds[number] | 'unknown';
  code?: typeof codes[number];
  httpStatus?: number;
  markers: (typeof markerRules[number][0])[];
  engineAssigned?: boolean;
  hostRunning?: boolean;
};

function read(value: object, key: string): unknown {
  try { return (value as Record<string, unknown>)[key]; }
  catch { return undefined; }
}

function known<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  // No coercion: a hostile toString, constructor or toJSON is never called.
  return typeof value === 'string' ? allowed.find(item => item === value) : undefined;
}

export function summarizeEngineStartupFailure(error: unknown, phase: EngineStartupPhase): EngineStartupDiagnostic {
  const result: EngineStartupDiagnostic = { phase: phase === 'providers' ? 'providers' : 'start-engine', kind: 'unknown', markers: [] };
  const pending: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  const inspectMessage = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const message = raw.slice(0, 8192);
    for (const [marker, pattern] of markerRules) {
      if (result.markers.length === 8) break;
      if (!result.markers.includes(marker) && pattern.test(message)) result.markers.push(marker);
    }
  };
  // Root, cause/data, then their cause/data: at most three levels and seven objects.
  for (let index = 0; index < pending.length && index < 7; index++) {
    const { value, depth } = pending[index];
    // The SDK can throw a non-JSON HTTP response body as a string.
    if (typeof value === 'string') { inspectMessage(value); continue; }
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const field of ['name', '_tag', 'type']) {
      const kind = known(read(value, field), kinds);
      if (kind && (result.kind === 'unknown' || result.kind === 'Error')) result.kind = kind;
    }
    const code = known(read(value, 'code'), codes);
    if (!result.code && code) result.code = code;
    for (const field of ['status', 'statusCode', 'httpStatus']) {
      const status = read(value, field);
      if (result.httpStatus === undefined && typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        result.httpStatus = status;
    }
    inspectMessage(read(value, 'message'));
    if (depth < 2) {
      pending.push({ value: read(value, 'cause'), depth: depth + 1 }, { value: read(value, 'data'), depth: depth + 1 });
    }
  }
  return result;
}

/** Revalidate an API receipt without trusting its fields, getters or serialization. */
export function parseEngineStartupDiagnostic(value: unknown): EngineStartupDiagnostic | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const fields = Object.getOwnPropertyDescriptors(value);
    const allowed = ['phase', 'kind', 'code', 'httpStatus', 'markers', 'engineAssigned', 'hostRunning'];
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(fields[key], 'value')) return;
    }
    const phase = fields.phase?.value, rawKind = fields.kind?.value;
    if (phase !== 'start-engine' && phase !== 'providers') return;
    const kind = rawKind === 'unknown' ? 'unknown' : known(rawKind, kinds);
    if (!kind) return;
    const rawMarkers = fields.markers?.value;
    if (!Array.isArray(rawMarkers)) return;
    const entries = Object.getOwnPropertyDescriptors(rawMarkers as object);
    const length = entries.length?.value;
    if (!Number.isInteger(length) || length < 0 || length > 8 || Reflect.ownKeys(entries).length !== length + 1) return;
    const markers: EngineStartupDiagnostic['markers'] = [];
    const allowedMarkers = markerRules.map(([marker]) => marker);
    for (let index = 0; index < length; index++) {
      if (!entries[index] || !Object.hasOwn(entries[index], 'value')) return;
      const marker = known(entries[index].value, allowedMarkers);
      if (!marker || markers.includes(marker)) return;
      markers.push(marker);
    }
    const result: EngineStartupDiagnostic = { phase, kind, markers };
    if (fields.code) {
      const code = known(fields.code.value, codes);
      if (!code) return;
      result.code = code;
    }
    if (fields.httpStatus) {
      const status = fields.httpStatus.value;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return;
      result.httpStatus = status;
    }
    if (fields.engineAssigned || fields.hostRunning) {
      const assigned = fields.engineAssigned?.value, running = fields.hostRunning?.value;
      if (typeof assigned !== 'boolean' || typeof running !== 'boolean' || running && !assigned) return;
      result.engineAssigned = assigned; result.hostRunning = running;
    }
    return result;
  } catch { return undefined; }
}
