import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:net';

// Explicitly choose the IANA dynamic/private range; Windows' PORT=0 range is configurable.
export const AUTO_HTTP_PORT_MIN = 49152;
export const AUTO_HTTP_PORT_MAX = 65535;
export const HTTP_PORT_ATTEMPTS = 64;
// https://fetch.spec.whatwg.org/#port-blocking (2026-09-02).
const blockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

function validatePort(port: number) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('HTTP 端口必须是 0–65535 的整数；0 表示自动选择高位端口。');
  if (blockedPorts.has(port)) throw new Error(`HTTP 端口 ${port} 被浏览器禁止使用。`);
}

export function isBindConflict(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

// The optional function is a unit-test seam, not a production environment override.
export async function withHttpPort<T>(
  open: (port: number) => Promise<T>,
  port = 0,
  nextPort = () => randomInt(AUTO_HTTP_PORT_MIN, AUTO_HTTP_PORT_MAX + 1),
): Promise<T> {
  validatePort(port);
  if (port !== 0) return open(port);
  let lastError: unknown;
  for (let attempt = 0; attempt < HTTP_PORT_ATTEMPTS; attempt++) {
    const candidate = nextPort();
    validatePort(candidate);
    if (candidate < AUTO_HTTP_PORT_MIN) throw new Error('自动 HTTP 端口必须位于 49152–65535。');
    try {
      return await open(candidate);
    } catch (error) {
      if (!isBindConflict(error)) throw error;
      lastError = error;
    }
  }
  throw new Error('无法绑定 49152–65535 范围内的可用 HTTP 端口，请检查本机端口占用或保留情况。', {
    cause: lastError,
  });
}

export async function listenHttp(server: Server, host: string, port = 0, nextPort?: () => number) {
  if (server.listening) throw new Error('HTTP 服务已经在监听，不能重复分配端口。');
  return withHttpPort(
    async (candidate) => {
      await new Promise<void>((ok, fail) => {
        const cleanup = () => {
          server.off('error', onError);
          server.off('listening', onListening);
        };
        const onError = (error: Error) => {
          cleanup();
          fail(error);
        };
        const onListening = () => {
          cleanup();
          ok();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(candidate, host);
        } catch (error) {
          cleanup();
          fail(error);
        }
      });
      return candidate;
    },
    port,
    nextPort,
  );
}

// Probe only: the caller must still handle another process winning the subsequent bind.
export async function probeHttpPort(port: number) {
  const probe = createServer();
  await listenHttp(probe, '127.0.0.1', port);
  await new Promise<void>((ok, fail) => probe.close((error) => (error ? fail(error) : ok())));
}
