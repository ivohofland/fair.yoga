export type MarkReadOutcome = 'marked' | 'session-expired' | 'failed';

export async function postMarkRead(id: string): Promise<MarkReadOutcome> {
  try {
    const res = await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    if (res.ok) return 'marked';
    return res.status === 401 ? 'session-expired' : 'failed';
  } catch {
    return 'failed';
  }
}
