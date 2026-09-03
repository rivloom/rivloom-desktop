// Explicit test-only --import preload. Never bundled or loaded by the product.
import assert from 'node:assert/strict';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const testBase = resolve(dirname(fileURLToPath(import.meta.url)), '../.data/m34-service');
const dataRoot = resolve(process.env.RIVLOOM_DATA_DIR || '.');
assert(dataRoot.toLowerCase().startsWith((testBase + sep).toLowerCase()));
const offset = Number(process.env.RIVLOOM_TEST_CLOCK_OFFSET_MS);
assert(Number.isSafeInteger(offset) && Math.abs(offset) <= 60_000);
delete process.env.RIVLOOM_TEST_CLOCK_OFFSET_MS;

const NativeDate = Date;
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [target.now() + offset], newTarget);
  },
  apply() {
    return new NativeDate(NativeDate.now() + offset).toString();
  },
  get(target, property, receiver) {
    if (property === 'now') return () => NativeDate.now() + offset;
    return Reflect.get(target, property, receiver);
  },
});
console.log('RIVLOOM_TEST_CLOCK_OFFSET', offset, new Date().getTime() - NativeDate.now());
