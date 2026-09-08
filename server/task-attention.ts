import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  collectAttention,
  type AttentionSnapshot,
  type NotificationPreferences,
} from '../shared/task-attention.ts';
import type { Bootstrap } from '../shared/types.ts';

export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    quietUntil: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** User-scoped storage is independent of the desktop's randomly allocated loopback port. */
export class TaskAttentionStore {
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS task_attention_preferences (user_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_attention_observations (user_id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  preferences(userID: string): NotificationPreferences {
    const row = this.db
      .prepare('SELECT body FROM task_attention_preferences WHERE user_id=?')
      .get(userID);
    try {
      return row
        ? notificationPreferencesSchema.parse(JSON.parse(String(row.body)))
        : { enabled: true, quietUntil: null };
    } catch {
      return { enabled: false, quietUntil: null };
    }
  }
  savePreferences(userID: string, value: unknown) {
    const prefs = notificationPreferencesSchema.parse(value);
    if (prefs.quietUntil !== null)
      z.number()
        .max(this.now() + 24 * 60 * 60_000, '免打扰最长可设置 24 小时。')
        .parse(prefs.quietUntil);
    this.db
      .prepare(
        `INSERT INTO task_attention_preferences VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET body=excluded.body`,
      )
      .run(userID, JSON.stringify(prefs));
    return prefs;
  }
  check(data: Bootstrap): AttentionSnapshot {
    const { items, events, observations } = collectAttention(data);
    const row = this.db
      .prepare('SELECT body FROM task_attention_observations WHERE user_id=?')
      .get(data.user.id);
    let previous: Record<string, string> | null = null;
    if (row) {
      try {
        previous = JSON.parse(String(row.body));
      } catch {
        /* baseline on corruption */
      }
    }
    const prefs = this.preferences(data.user.id);
    const enabled = prefs.enabled && (prefs.quietUntil === null || prefs.quietUntil <= this.now());
    // Track current phases too: review -> running -> review is a new event in the same session.
    const snapshot = Object.fromEntries(
      observations.slice(0, 10_000).map((o) => [o.conversationKey, o.fingerprint]),
    );
    const notifications =
      previous && enabled
        ? events.filter(
            (event) =>
              Object.hasOwn(snapshot, event.conversationKey) &&
              previous![event.conversationKey] !== event.fingerprint,
          )
        : [];
    const body = JSON.stringify(snapshot);
    if (row?.body !== body)
      this.db
        .prepare(
          `INSERT INTO task_attention_observations VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET body=excluded.body`,
        )
        .run(data.user.id, body);
    return {
      items,
      notifications,
      preferences: prefs,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}
