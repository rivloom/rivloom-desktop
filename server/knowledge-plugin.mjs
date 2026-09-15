import { z } from 'zod';

const url = process.env.RIVLOOM_KNOWLEDGE_BRIDGE_URL;
const token = process.env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN;
delete process.env.RIVLOOM_KNOWLEDGE_BRIDGE_URL;
delete process.env.RIVLOOM_KNOWLEDGE_BRIDGE_TOKEN;

// Official OpenCode plugin interface. The bridge secret is never an argument or model-visible result.
export default async function RivloomKnowledgePlugin() {
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
  return { tool: {
    rivloom_knowledge_search: request('rivloom_knowledge_search',
      'Find Skills or Wiki memory by purpose, name, or category across this Node and its Brains. Returns summaries only. Browse before loading; use offset for the next page.', {
        text: z.string().optional(), kind: z.enum(['skill', 'memory']).optional(), category: z.string().optional(),
        brainID: z.string().nullable().optional(), offset: z.number().optional(),
      }),
    rivloom_knowledge_read: request('rivloom_knowledge_read',
      'Load a discovered Skill or memory using its exact brainID (null for local), nodeID and id. Initially omit file to read instructions and a supporting-file manifest. Fetch each needed supporting file separately. materialize=true writes that verified Skill file into the task working directory for ordinary approved tools to use. Never installs or executes scripts.', {
        brainID: z.string().nullable(), nodeID: z.string(), id: z.string(), file: z.string().optional(), materialize: z.boolean().optional(),
      }),
    rivloom_memory_save: request('rivloom_memory_save',
      'Save sourced facts to local progressive Wiki memory with a category such as People/Alice/Work or Projects/Website/Decisions. No automatic sharing. For updates read first and pass id plus expectedRevision. projectID is the current project UUID, or null for Node-wide memory when permitted. Never store secrets or invented personal facts.', {
        id: z.string().optional(), expectedRevision: z.string().optional(), name: z.string(), description: z.string(),
        category: z.string(), body: z.string(), projectID: z.string().nullable(),
      }),
  } };
}
