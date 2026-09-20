// Original Rivloom tones. Deterministic 44.1 kHz, mono PCM16 WAV, no external recordings.
import { mkdirSync, writeFileSync } from 'node:fs';
const directory = new URL('../src/assets/sounds/', import.meta.url);
mkdirSync(directory, { recursive: true });
const rate = 44100;
const note = (t, start, duration, frequency, gain, harmonics = false) => {
  const age = t - start;
  if (age < 0 || age >= duration) return 0;
  const envelope = Math.min(1, age / 0.012) * Math.exp(-5 * age / duration) * Math.min(1, (duration - age) / 0.04);
  const phase = 2 * Math.PI * frequency * age;
  return gain * envelope * (Math.sin(phase) + (harmonics ? 0.22 * Math.sin(phase * 2.01) + 0.08 * Math.sin(phase * 3.98) : 0));
};
const definitions = {
  chime: { duration: 0.8, sample: t => note(t, 0, 0.55, 660, 0.18) + note(t, 0.17, 0.58, 880, 0.16) },
  bell: { duration: 0.9, sample: t => note(t, 0, 0.85, 1046.5, 0.18, true) },
  pulse: { duration: 0.55, sample: t => note(t, 0, 0.22, 523.25, 0.2) + note(t, 0.19, 0.28, 659.25, 0.18) },
};
for (const [name, { duration, sample }] of Object.entries(definitions)) {
  const count = Math.round(rate * duration), bytes = count * 2, out = Buffer.alloc(44 + bytes);
  out.write('RIFF'); out.writeUInt32LE(36 + bytes, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(bytes, 40);
  for (let index = 0; index < count; index++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(index / rate))) * 32767), 44 + index * 2);
  writeFileSync(new URL(`${name}.wav`, directory), out);
}
