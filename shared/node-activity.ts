import type { NodeModelActivitySnapshot } from './node-model-activity.ts';
import type { OperationActivity } from './operation-activity.ts';

/** Owner-only activity for work executed on this Node. */
export type NodeActivitySnapshot = {
  models: NodeModelActivitySnapshot;
  knowledge: OperationActivity[];
};
