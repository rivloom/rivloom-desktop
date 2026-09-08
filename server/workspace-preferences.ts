import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
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

export class WorkspacePreferences {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
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
