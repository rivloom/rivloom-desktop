import { invoke } from '@tauri-apps/api/core';
import { desktop } from './desktop';
import type { CompletionSound } from '../shared/task-attention.ts';

const assets = {
  chime: new URL('./assets/sounds/chime.wav', import.meta.url).href,
  bell: new URL('./assets/sounds/bell.wav', import.meta.url).href,
  pulse: new URL('./assets/sounds/pulse.wav', import.meta.url).href,
};
let current: HTMLAudioElement | null = null;

/** Native playback also works with a minimized Windows WebView; assets never leave the app. */
export async function playCompletionSound(sound: CompletionSound) {
  if (desktop) {
    await invoke('play_completion_sound', { sound });
    return;
  }
  current?.pause();
  current = null;
  if (sound === 'off') return;
  const audio = new Audio(assets[sound]);
  current = audio;
  audio.onended = () => { if (current === audio) current = null; };
  try { await audio.play(); }
  catch (error) { if (current === audio) current = null; throw error; }
}
