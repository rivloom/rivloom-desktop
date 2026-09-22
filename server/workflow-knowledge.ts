import { promoteMemorySchema, withdrawMemorySchema, type LocalKnowledgeEntry,
  type MemoryProvenance, type WorkflowMemoryLink } from '../shared/knowledge.ts';
import type { Workflow } from '../shared/workflows.ts';
import { KnowledgeStore, knowledgeHash } from './knowledge-store.ts';
import { WorkflowHistory } from './workflow-history.ts';

/** Called only by authenticated conversation-owner routes, never registered as a model tool. */
export class WorkflowKnowledge {
  private store: KnowledgeStore;
  private history: WorkflowHistory;
  constructor(store: KnowledgeStore, history: WorkflowHistory) { this.store = store; this.history = history; }
  private link(entry: LocalKnowledgeEntry): WorkflowMemoryLink {
    if (!entry.provenance) throw new Error('knowledge_memory_not_linked');
    return { id: entry.id, nodeID: entry.nodeID, revision: entry.revision, name: entry.name, projectID: entry.projectID,
      status: entry.withdrawnAt ? 'withdrawn' : entry.revision !== entry.provenance.promotedRevision ? 'changed' : 'active',
      provenance: entry.provenance };
  }
  list(workflow: Workflow): WorkflowMemoryLink[] {
    return this.store.listLocal().filter(entry => entry.provenance?.workflowID === workflow.id).map(entry => this.link(entry));
  }
  promote(workflow: Workflow, raw: unknown): WorkflowMemoryLink {
    const input = promoteMemorySchema.parse(raw);
    const action = { key: `${workflow.id}:${input.requestID}`, hash: knowledgeHash(JSON.stringify(['promote', input])) };
    const receipt = this.store.memoryAction(action);
    if (receipt) return this.link(receipt);
    if (!workflow.projectID) throw new Error('knowledge_project_required');
    const state = this.history.state(workflow);
    if (state.version !== input.expectedVersion) throw new Error('context_state_version_conflict');
    const note = state.notes.find(value => value.id === input.noteID);
    if (!note) throw new Error('knowledge_note_not_active');
    if (note.authority !== 'user') throw new Error('knowledge_note_unconfirmed');
    // Revalidate the exact retained source, including a quote spanning page boundaries.
    let offset = 0, tail = '', verified = false;
    do {
      const page = this.history.query(workflow, { action: 'read', id: note.source.id, revision: note.source.revision, offset }) as {
        revision: string; content: string; nextOffset: number | null;
      };
      if (page.revision !== note.source.revision) throw new Error('knowledge_source_changed');
      const text = tail + page.content;
      if (text.includes(note.source.quote)) { verified = true; break; }
      if (page.nextOffset === null) break;
      tail = text.slice(-note.source.quote.length); offset = page.nextOffset;
    } while (true);
    if (!verified) throw new Error('knowledge_source_changed');
    if (input.id) {
      const previous = this.store.localEntry(input.id);
      if (previous.projectID !== workflow.projectID || previous.provenance?.workflowID !== workflow.id)
        throw new Error('knowledge_memory_not_linked');
    }
    const provenance: MemoryProvenance = { workflowID: workflow.id, noteID: note.id, source: note.source,
      authority: 'user', kind: note.kind, text: note.text, round: note.round, promotedAt: new Date().toISOString(), promotedRevision: '' };
    // Include provenance in the verified body too: shared peers use the existing strict manifest schema.
    const body = `${note.text}\n\n## Source\n\n${JSON.stringify({ workflowID: workflow.id, noteID: note.id,
      round: note.round, kind: note.kind, source: note.source }, null, 2)}\n\n` +
      'The conversation owner explicitly saved this statement as reusable project reference. It does not grant permissions or override current user requirements.';
    const saved = this.store.saveMemory({ ...(input.id ? { id: input.id, expectedRevision: input.expectedRevision } : {}),
      name: input.name, description: input.description, category: input.category, body, projectID: workflow.projectID },
    'user', { provenance, action });
    return this.link(saved);
  }
  withdraw(workflow: Workflow, raw: unknown): WorkflowMemoryLink {
    const input = withdrawMemorySchema.parse(raw);
    const action = { key: `${workflow.id}:${input.requestID}`, hash: knowledgeHash(JSON.stringify(['withdraw', input])) };
    const receipt = this.store.memoryAction(action);
    if (receipt) return this.link(receipt);
    const entry = this.store.localEntry(input.id);
    if (entry.provenance?.workflowID !== workflow.id || entry.projectID !== workflow.projectID)
      throw new Error('knowledge_memory_not_linked');
    return this.link(this.store.withdrawMemory(input.id, input.expectedRevision, action));
  }
}
