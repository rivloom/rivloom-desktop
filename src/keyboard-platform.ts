type KeyboardPlatformHints = {
  platform?: string;
  userAgentData?: { platform?: string };
};

/** Use the client keyboard platform, not the device executing a remote task. */
export function primaryShortcut(keys: string, hints: KeyboardPlatformHints = typeof navigator === 'undefined' ? {} : navigator): string {
  const platform = hints.userAgentData?.platform?.trim() || hints.platform || '';
  const modifier = /^(Mac|iPhone|iPad|iPod)/i.test(platform) ? '⌘' : 'Ctrl';
  return `${modifier} + ${keys}`;
}
