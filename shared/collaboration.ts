/** One extension family: legacy handshakes permit at most twelve capabilities. */
export const collaborationCapability = 'collaboration-v1';
export const nodeIDPattern = /^[A-Za-z0-9_-]{32}$/;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const digestPattern = /^[a-f0-9]{64}$/;
export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
export const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\u0000');
export const integer = (value: unknown, max: number, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export const nodeID = (value: unknown): value is string => typeof value === 'string' && nodeIDPattern.test(value);
export const uuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export const digest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function uniqueStrings(value: unknown, max: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((v) => text(v, length)) &&
    new Set(value).size === value.length;
}
export type CollaborationRequest = {
  type: 'collaboration-request'; requestID: string; operation: string; payload: unknown;
};
export type CollaborationResponse = {
  type: 'collaboration-response'; requestID: string; ok: boolean; payload: unknown; error: string | null;
};
export function validCollaborationRequest(value: unknown): value is CollaborationRequest {
  return record(value) && keys(value, ['type', 'requestID', 'operation', 'payload']) &&
    value.type === 'collaboration-request' && uuid(value.requestID) &&
    ['catalog-head', 'catalog-page', 'catalog-delta', 'resource-query', 'resource-prepare',
      'resource-chunk', 'execution-context', 'execution-outcome', 'execution-files', 'execution-retry-check', 'execution-history', 'knowledge'].includes(String(value.operation));
}
export function validCollaborationResponse(value: unknown): value is CollaborationResponse {
  return record(value) && keys(value, ['type', 'requestID', 'ok', 'payload', 'error']) &&
    value.type === 'collaboration-response' && uuid(value.requestID) && typeof value.ok === 'boolean' &&
    (value.ok ? value.error === null : value.payload === null && text(value.error, 300));
}
