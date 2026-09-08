export type SidebarSide = 'history' | 'network';
export type SidebarWidths = Record<SidebarSide, number | null>;
export const defaultSidebarWidths = (): SidebarWidths => ({ history: null, network: null });
export const sidebarBounds = {
  history: { min: 200, max: 480 },
  network: { min: 205, max: 480 },
} as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function sidebarLayout(width: number, hasNetwork: boolean, saved: SidebarWidths) {
  // Below 741px CSS uses a drawer and a bottom rail instead of desktop columns.
  const availableWidth = Math.max(741, Math.floor(width));
  const minimumCenter = availableWidth > 1180 ? 340 : availableWidth > 900 ? 300 : 280;
  const defaultHistory =
    availableWidth > 1180 ? 252 : hasNetwork ? (availableWidth > 900 ? 218 : 200) : 226;
  const defaultNetwork = availableWidth > 1180 ? 280 : availableWidth > 900 ? 244 : 205;
  let history = clamp(
    saved.history ?? defaultHistory,
    sidebarBounds.history.min,
    sidebarBounds.history.max,
  );
  let network = hasNetwork
    ? clamp(saved.network ?? defaultNetwork, sidebarBounds.network.min, sidebarBounds.network.max)
    : 0;
  const space = availableWidth - minimumCenter;
  if (history + network > space) {
    const minimumNetwork = hasNetwork ? sidebarBounds.network.min : 0;
    const extra = history + network - sidebarBounds.history.min - minimumNetwork;
    const ratio = (space - sidebarBounds.history.min - minimumNetwork) / extra;
    history = Math.round(sidebarBounds.history.min + (history - sidebarBounds.history.min) * ratio);
    network = hasNetwork ? space - history : 0;
  }
  return {
    history,
    network,
    hasNetwork,
    minimumCenter,
    historyMax: Math.min(sidebarBounds.history.max, space - network),
    networkMax: Math.min(sidebarBounds.network.max, space - history),
  };
}

export function resizeSidebar(
  layout: ReturnType<typeof sidebarLayout>,
  saved: SidebarWidths,
  side: SidebarSide,
  width: number,
): SidebarWidths {
  return {
    history: layout.history,
    network: layout.hasNetwork ? layout.network : saved.network,
    [side]: Math.round(clamp(width, sidebarBounds[side].min, layout[`${side}Max`])),
  };
}
