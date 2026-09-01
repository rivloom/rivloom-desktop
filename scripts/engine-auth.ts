import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { engineBinary, engineEnv, importAuth } from '../server/engine.ts';
const source = process.argv[2];
if (source) console.log('已导入提供方（未显示密钥）：', importAuth(resolve(source)).join(', '));
else {
  const child = spawn(engineBinary(), ['auth', 'login'], {
    env: engineEnv(),
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code || 0));
}
