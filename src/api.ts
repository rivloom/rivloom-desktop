import { t } from '../shared/i18n.ts';
import { workflowError } from '../shared/workflow-errors.ts';
import type { NodeNetwork } from '../shared/types';
import { validQueueConfirmation, type QueueConfirmation } from '../shared/queue-backlog.ts';

export type CreatedNodeTaskResponse = NodeNetwork & { createdTaskID: string };

export class ApiError extends Error {
  readonly status: number;
  readonly queueConfirmation?: QueueConfirmation;

  constructor(message: string, status: number, queueConfirmation?: QueueConfirmation) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.queueConfirmation = queueConfirmation;
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  options: { timeoutMilliseconds?: number } = {},
): Promise<T> {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? (body === undefined ? 15_000 : undefined);
  const controller = timeoutMilliseconds ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMilliseconds) : null;
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        workflowError(data.error) || t('请求失败'),
        response.status,
        response.status === 409 && validQueueConfirmation(data.queueConfirmation)
          ? data.queueConfirmation
          : undefined,
      );
    return data;
  } catch (error) {
    if (controller?.signal.aborted)
      throw new Error(t('请求超时，结果尚未确认。请重试确认同一次请求。'));
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
