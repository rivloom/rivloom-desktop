import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
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

export class WorkspacePreferences {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
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
