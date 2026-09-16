import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountNameSchema, providerIDSchema } from '../shared/model-providers.ts';

export const accountIDSchema = z
  .string()
  .regex(/^rivloom-account-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const accountSchema = z.object({
  id: accountIDSchema,
  providerID: providerIDSchema,
  name: accountNameSchema,
});
export type ProviderAccount = z.infer<typeof accountSchema>;
export class ProviderAccountError extends Error {}
const stateSchema = z.object({
  accounts: z.array(accountSchema).max(32),
  aliases: z.record(providerIDSchema, accountNameSchema),
});

/** Only routing identities and display names. Credentials stay in the official engine. */
export class ProviderAccountStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  private read() {
    const file = join(this.root, 'rivloom-accounts.json');
    return existsSync(file)
      ? stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : { accounts: [], aliases: {} };
  }
  private write(state: z.infer<typeof stateSchema>) {
    const data = stateSchema.parse(state);
    mkdirSync(this.root, { recursive: true });
    const file = join(this.root, 'rivloom-accounts.json'),
      temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  }
  list() {
    return this.read().accounts;
  }
  get(id: string) {
    return this.list().find((a) => a.id === id);
  }
  alias(id: string) {
    return this.read().aliases[id];
  }
  create(providerID: string, name: string) {
    providerIDSchema.parse(providerID);
    if (providerID.startsWith('rivloom-account-'))
      throw new ProviderAccountError('Invalid source provider.');
    const state = this.read();
    if (state.accounts.length >= 32)
      throw new ProviderAccountError(
        'Account limit reached. Remove an unused account before adding another.',
      );
    const account = accountSchema.parse({
      id: `rivloom-account-${randomUUID()}`,
      providerID,
      name,
    });
    this.unique(state, providerID, account.name);
    state.accounts.push(account);
    this.write(state);
    return account;
  }
  private unique(
    state: z.infer<typeof stateSchema>,
    providerID: string,
    name: string,
    except?: string,
  ) {
    const folded = name.toLowerCase();
    if (
      state.accounts.some(
        (a) => a.id !== except && a.providerID === providerID && a.name.toLowerCase() === folded,
      ) ||
      (except !== providerID && state.aliases[providerID]?.toLowerCase() === folded)
    )
      throw new ProviderAccountError('An account with this name already exists for this provider.');
  }
  rename(id: string, name: string, providerID?: string) {
    name = accountNameSchema.parse(name);
    const state = this.read(),
      account = state.accounts.find((a) => a.id === id);
    if (!account && (!providerID || id !== providerID || id.startsWith('rivloom-account-')))
      throw new ProviderAccountError('Account not found.');
    this.unique(state, account?.providerID || providerID!, name, id);
    if (account) account.name = name;
    else state.aliases[providerID!] = name;
    this.write(state);
  }
  remove(id: string) {
    const state = this.read();
    state.accounts = state.accounts.filter((a) => a.id !== id);
    delete state.aliases[id];
    this.write(state);
  }
  directory(id: string) {
    return join(this.root, 'accounts', accountIDSchema.parse(id));
  }
  resolveModel(model: string) {
    const [id, ...parts] = model.split('/');
    const account = this.get(id);
    if (id.startsWith('rivloom-account-') && !account)
      throw new ProviderAccountError('Model account is no longer connected.');
    return {
      accountID: account?.id || '',
      providerID: account?.providerID || id,
      modelID: parts.join('/'),
    };
  }
}
