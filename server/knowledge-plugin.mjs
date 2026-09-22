import { z } from 'zod';
import { contextHooks } from './context-plugin.mjs';
import { historyTools } from './history-plugin.mjs';

const url = process.env.RIVLOOM_KNOWLEDGE_BRIDGE_URL;
const token = process.env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN;
const contextURL = process.env.RIVLOOM_CONTEXT_BRIDGE_URL;
const contextToken = process.env.RIVLOOM_CONTEXT_BRIDGE_TOKEN;
delete process.env.RIVLOOM_KNOWLEDGE_BRIDGE_URL;
delete process.env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN;
delete process.env.RIVLOOM_CONTEXT_BRIDGE_URL;
delete process.env.RIVLOOM_CONTEXT_BRIDGE_TOKEN;

// Official OpenCode plugin interface. The bridge secret is never an argument or model-visible result.
export default async function RivloomKnowledgePlugin({ directory }) {
  if (!url || !token) return {};
  const request = (name, description, args) => ({
    description,
    args,
    async execute(input, context) {
      await context.ask({ permission: name, patterns: [input.id || input.category || '*'], always: [], metadata: {} });
      if (name === 'rivloom_knowledge_read' && input.materialize)
        await context.ask({ permission: 'edit', patterns: [`${context.directory}/.rivloom-knowledge/*`], always: [], metadata: {} });
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: context.abort ? AbortSignal.any([context.abort, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        body: JSON.stringify({ name, args: input, sessionID: context.sessionID, directory: context.directory }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'knowledge_request_failed');
      return JSON.stringify(result);
    },
  });
  return { ...contextHooks({ url: contextURL, token: contextToken, directory }), tool: {
    ...historyTools({ url: contextURL, token: contextToken }),
    rivloom_knowledge_search: request('rivloom_knowledge_search',
      'Find Skills or Wiki memory by purpose, name, or category across this Node and its Brains. Returns summaries only. Browse before loading; use offset for the next page.', {
        text: z.string().optional(), kind: z.enum(['skill', 'memory']).optional(), category: z.string().optional(),
        brainID: z.string().nullable().optional(), offset: z.number().optional(),
      }),
    rivloom_knowledge_read: request('rivloom_knowledge_read',
      'Read a discovered Skill or Wiki memory using its exact brainID (null for local), nodeID, id and revision. Results fit 32 KiB of JSON. Follow nextOffset with the same revision for remaining text; offsets are UTF-16 units, not fixed page sizes. Initially omit file and finish the instructions before supporting files. The main file also lists supporting files; follow nextManifestOffset as manifestOffset for more. materialize=true writes a verified Skill file into the current directory for ordinary approved tools, never installs or executes it.', {
        brainID: z.string().nullable(), nodeID: z.string(), id: z.string(), file: z.string().optional(), materialize: z.boolean().optional(),
        revision: z.string().optional(), offset: z.number().optional(), manifestOffset: z.number().optional(),
      }),
    rivloom_memory_save: request('rivloom_memory_save',
      'Save reusable sourced facts to local Wiki memory; do not persist temporary task requirements. No automatic sharing or user confirmation. For updates read first and pass id plus expectedRevision. Owner-confirmed session memories require the owner to replace or withdraw them. projectID is the current project UUID, or null for Node-wide memory when permitted. Never store secrets or invented personal facts.', {
        id: z.string().optional(), expectedRevision: z.string().optional(), name: z.string(), description: z.string(),
        category: z.string(), body: z.string(), projectID: z.string().nullable(),
      }),
  } };
}
