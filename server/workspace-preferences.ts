import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createHistorySchema } from './conversation-history.ts';
import { validConversationKey, validConversationTitle, type ConversationPreferences } from '../shared/conversation-preferences.ts';
import { maximumDirectoryAliases, validDirectoryAlias, validDirectoryKey, type DirectoryAliases } from '../shared/directory-aliases.ts';
import {
  defaultSidebarWidths,
  sidebarBounds,
  type SidebarWidths,
} from '../shared/sidebar-layout.ts';

const widthsSchema = z
  .object({
    history: z
      .number()
      .int()
      .min(sidebarBounds.history.min)
      .max(sidebarBounds.history.max)
      .nullable(),
    network: z
      .number()
      .int()
      .min(sidebarBounds.network.min)
      .max(sidebarBounds.network.max)
      .nullable(),
  })
  .strict();

const aliasKeySchema = z.string().refine(validDirectoryKey);
const aliasValueSchema = z.string().refine(validDirectoryAlias).transform((value) => value.trim());
const aliasesSchema = z.record(aliasKeySchema, aliasValueSchema).refine((value) => Object.keys(value).length <= maximumDirectoryAliases);
const aliasChangeSchema = z.object({ key: aliasKeySchema, alias: aliasValueSchema.nullable() }).strict();

export class WorkspacePreferenceError extends Error { readonly status = 404; }

export class WorkspacePreferences {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    createHistorySchema(db);
    db.exec('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS conversation_preferences(user_id TEXT NOT NULL, conversation_key TEXT NOT NULL, title TEXT, pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,conversation_key))');
  }

  conversationPreferences(userID: string): ConversationPreferences {
    return Object.fromEntries(this.db.prepare('SELECT conversation_key,title,pinned FROM conversation_preferences WHERE user_id=?').all(userID)
      .map((row) => [String(row.conversation_key), { ...(row.title ? { title: String(row.title) } : {}), pinned: row.pinned === 1 }]));
  }
  conversationDrafts(userID: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(`ui.drafts:${userID}`);
    return row ? String(row.value) : null;
  }
  saveConversationDrafts(userID: string, input: unknown): void {
    const { value } = z.object({ value: z.string().max(1_500_000) }).strict().parse(input);
    const parsed = z.preprocess((input) => { try { return JSON.parse(String(input)); } catch { return null; } },
      z.object({ version: z.literal(1), savedAt: z.number().int().nonnegative(), drafts: z.record(z.string(), z.unknown()) }).passthrough()).parse(value);
    const previous = this.conversationDrafts(userID);
    if (previous && Number(JSON.parse(previous).savedAt || 0) > parsed.savedAt) return;
    let removed = false;
    for (const row of this.db.prepare('SELECT DISTINCT conversation_key FROM conversation_retired WHERE permanent=1').all())
      if (Object.hasOwn(parsed.drafts, String(row.conversation_key))) { delete parsed.drafts[String(row.conversation_key)]; removed = true; }
    this.db.prepare('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`ui.drafts:${userID}`, removed ? JSON.stringify(parsed) : value);
  }
  draftsForConversations(keys: string[], others = false): unknown[] {
    return this.db.prepare("SELECT value FROM app_settings WHERE key LIKE 'ui.drafts:%'").all().flatMap((row) => {
      try { return Object.entries(JSON.parse(String(row.value)).drafts || {}).filter(([key]) => others ? !keys.includes(key) : keys.includes(key)).map(([, draft]) => draft); }
      catch { return []; }
    });
  }

  saveConversationPreference(userID: string, input: unknown, visibleKeys: string[]): void {
    const change = z.object({ key: z.string().refine(validConversationKey), title: z.string().refine(validConversationTitle).transform((v) => v.trim()).optional(),
      pinned: z.boolean().optional() }).strict().refine((value) => value.title !== undefined || value.pinned !== undefined).parse(input);
    if (!visibleKeys.includes(change.key)) throw new WorkspacePreferenceError('会话已不可用，请刷新后重试。');
    this.db.prepare('INSERT INTO conversation_preferences(user_id,conversation_key,title,pinned) VALUES (?,?,?,?) ON CONFLICT(user_id,conversation_key) DO UPDATE SET title=COALESCE(?,title),pinned=COALESCE(?,pinned)')
      .run(userID, change.key, change.title ?? null, Number(change.pinned ?? false), change.title ?? null, change.pinned === undefined ? null : Number(change.pinned));
  }

  forgetConversations(keys: string[]): void {
    const statement = this.db.prepare('DELETE FROM conversation_preferences WHERE conversation_key=?');
    for (const key of keys) statement.run(key);
    for (const row of this.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'ui.drafts:%'").all()) {
      const value = JSON.parse(String(row.value));
      if (!keys.some((key) => Object.hasOwn(value.drafts || {}, key))) continue;
      for (const key of keys) delete value.drafts[key];
      value.savedAt = Math.max(Date.now(), Number(value.savedAt || 0) + 1);
      this.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(value), String(row.key));
    }
  }

  directoryAliases(userID: string): DirectoryAliases {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(`ui.directory-aliases:${userID}`);
    try { return aliasesSchema.parse(JSON.parse(String(row?.value))); }
    catch { return {}; }
  }

  saveDirectoryAlias(userID: string, input: unknown): DirectoryAliases {
    const { key, alias } = aliasChangeSchema.parse(input);
    const aliases = this.directoryAliases(userID);
    if (alias === null) delete aliases[key]; else aliases[key] = alias;
    aliasesSchema.parse(aliases);
    this.db.prepare('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`ui.directory-aliases:${userID}`, JSON.stringify(aliases));
    return aliases;
  }

  sidebarWidths(userID: string): SidebarWidths {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key=?')
      .get(`ui.sidebar-widths:${userID}`);
    try {
      return widthsSchema.parse(JSON.parse(String(row?.value)));
    } catch {
      return defaultSidebarWidths();
    }
  }

  saveSidebarWidths(userID: string, input: unknown): SidebarWidths {
    const widths = widthsSchema.parse(input);
    this.db
      .prepare(
        'INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(`ui.sidebar-widths:${userID}`, JSON.stringify(widths));
    return widths;
  }
}
