import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
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
    db.exec('CREATE TABLE IF NOT EXISTS conversation_preferences(user_id TEXT NOT NULL, conversation_key TEXT NOT NULL, title TEXT, pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,conversation_key))');
  }

  conversationPreferences(userID: string): ConversationPreferences {
    return Object.fromEntries(this.db.prepare('SELECT conversation_key,title,pinned FROM conversation_preferences WHERE user_id=?').all(userID)
      .map((row) => [String(row.conversation_key), { ...(row.title ? { title: String(row.title) } : {}), pinned: row.pinned === 1 }]));
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
