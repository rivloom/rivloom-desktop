import type { PermissionRequest } from '@opencode-ai/sdk/v2';

type Feed = { revision: number; pending: Map<string, PermissionRequest> };

/** Compatibility for the official 1.18.25 list encoder rejecting optional metadata.
 * Only live, official permission events can supply a fallback request. No inference,
 * synthetic request IDs, automatic replies, or persistence across feed disconnects.
 */
export class EnginePermissionEvents {
  private feeds = new Map<string, Feed>();
  open(directory: string) { const feed: Feed = { revision: 0, pending: new Map() }; this.feeds.set(directory, feed); return feed; }
  close(directory: string, expected?: Feed) { if (!expected || this.feeds.get(directory) === expected) this.feeds.delete(directory); }
  clear() { this.feeds.clear(); }
  asked(directory: string, request: PermissionRequest, expected?: Feed) {
    const feed = this.feeds.get(directory); if (!feed || expected && expected !== feed) return;
    // A bounded fallback must fail closed if it cannot retain the complete live feed.
    if (feed.pending.size >= 256 && !feed.pending.has(request.id)) { this.close(directory); return; }
    feed.pending.set(request.id, structuredClone(request)); feed.revision++;
  }
  replied(directory: string, requestID: string, expected?: Feed) {
    const feed = this.feeds.get(directory); if (!feed || expected && expected !== feed) return;
    feed.pending.delete(requestID); feed.revision++;
  }
  async read(directory: string, sessionID: string, list: () => Promise<PermissionRequest[]>): Promise<PermissionRequest[]> {
    const started = this.feeds.get(directory); const revision = started?.revision;
    try {
      const requests = await list();
      // Do not overwrite a newer event with a list request that began before it.
      if (started && this.feeds.get(directory) === started && started.revision === revision) {
        if (requests.length > 256) this.close(directory);
        else { started.pending = new Map(requests.map((request) => [request.id, structuredClone(request)])); started.revision++; }
      }
      return requests.filter((request) => request.sessionID === sessionID);
    } catch (error) {
      const live = this.feeds.get(directory);
      const requests = live === started ? [...(live?.pending.values() || [])].filter((request) => request.sessionID === sessionID) : [];
      if (!requests.length) throw error;
      return structuredClone(requests);
    }
  }
}
