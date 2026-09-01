import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db, user, users, id, requireThat } from './store.ts';
import { dataRoot } from './engine.ts';
import type { User } from '../shared/types.ts';
export type AuthRequest = Request & { user: User };
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function sameToken(left: string, right: string) {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}
export function passwordHash(password: string) {
  const salt = token();
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  const computed = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(expected, 'hex'), computed);
}
const setupPath = join(dataRoot, 'setup-code.txt');
if (!users().length && !existsSync(setupPath)) writeFileSync(setupPath, token(), { mode: 0o600 });
export function checkSetup(code: string) {
  requireThat(!users().length, 409, '已经初始化');
  requireThat(
    existsSync(setupPath) && hash(code) === hash(readFileSync(setupPath, 'utf8').trim()),
    403,
    '初始化码不正确',
  );
}
export function finishSetup() {
  if (existsSync(setupPath)) unlinkSync(setupPath);
}
export function createUser(username: string, name: string, password: string, owner = false) {
  requireThat(
    !db.prepare('SELECT id FROM users WHERE username=?').get(username),
    409,
    '用户名已存在',
  );
  const uid = id();
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(
    uid,
    username,
    name,
    Number(owner),
    passwordHash(password),
  );
  return user(uid)!;
}
export function login(res: Response, userID: string) {
  const value = token();
  const maxAge = 12 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(value), userID, Date.now() + maxAge);
  res.cookie('rivloom_session', value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    maxAge,
    path: '/',
  });
}
export function sessionToken(req: Request) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('rivloom_session='))
      ?.slice('rivloom_session='.length) || ''
  );
}
export function authenticated(req: Request, res: Response, next: NextFunction) {
  const session = db
    .prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?')
    .get(hash(sessionToken(req)), Date.now());
  if (!session) {
    res.status(401).json({ error: '请登录' });
    return;
  }
  const found = user(session.user_id as string);
  if (!found) {
    res.status(401).json({ error: '账号不存在' });
    return;
  }
  (req as AuthRequest).user = found;
  next();
}
const attempts = new Map<string, { count: number; until: number }>();
export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip || 'local';
  const at = Date.now();
  for (const [k, value] of attempts) if (value.until < at) attempts.delete(k);
  const bucket = attempts.get(key) || { count: 0, until: at + 60_000 };
  bucket.count++;
  attempts.set(key, bucket);
  if (bucket.count > 25) {
    res.status(429).json({ error: '尝试过于频繁，请一分钟后重试' });
    return;
  }
  next();
}
