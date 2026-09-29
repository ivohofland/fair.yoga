import { logRequestFailure } from './client-errors';

export type MarkReadOutcome = 'marked' | 'unauthorized' | 'failed';

export async function postMarkRead(id: string): Promise<MarkReadOutcome> {
  try {
    const res = await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    if (res.ok) return 'marked';
    if (res.status === 401) return 'unauthorized';
    console.error('[mark-read] refused', { id, status: res.status });
    return 'failed';
  } catch (err) {
    logRequestFailure('mark-read', { id }, err);
    return 'failed';
  }
}
