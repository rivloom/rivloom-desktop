import { parentPort, workerData } from 'node:worker_threads';
import { parseOffice } from './office-parser.ts';
try { parentPort!.postMessage({ document: await parseOffice(workerData.name, Buffer.from(workerData.bytes), workerData.options) }); }
catch (error) { const code = (error as Error).message; parentPort!.postMessage({ error: /^office_[a-z_]+$/.test(code) ? code : 'office_invalid' }); }
