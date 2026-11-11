/** The queue/device rail stays out of the way while idle unless the user explicitly opens it. */
export type RailPreference = 'auto' | 'open' | 'closed';

export function activeQueueCount(entries?: readonly { state: string }[] | null): number {
  return entries?.filter((entry) => entry.state !== 'ended').length ?? 0;
}

export function railExpanded(available: boolean, preference: RailPreference, _activeCount: number): boolean {
  if (!available) return false;
  if (preference === 'auto') return false;
  return preference === 'open';
}

export function toggledRailPreference(expanded: boolean): RailPreference {
  return expanded ? 'closed' : 'open';
}
