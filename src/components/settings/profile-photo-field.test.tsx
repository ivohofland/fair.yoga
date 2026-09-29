import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProfilePhotoField } from './profile-photo-field';
import { MAX_PHOTO_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';
import { routerRefresh } from '../../../tests/setup/components';

const fetchMock = vi.fn();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderField(photoId: string | null = null) {
  vi.stubGlobal('fetch', fetchMock);
  render(<ProfilePhotoField teacherId="t1" firstName="Visual" lastName="Teacher" photoId={photoId} />);
  return screen.getByLabelText('Profile photo', { selector: 'input' }) as HTMLInputElement;
}

function choose(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ProfilePhotoField', () => {
  it('uploads the chosen file as multipart and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { photoId: 'p1' } }), { status: 200 }));
    const input = renderField();
    choose(input, new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/photo');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('photo')).toBeInstanceOf(File);
  });

  it('refuses a file over the limit without a request', async () => {
    const input = renderField();
    const big = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' });
    choose(input, big);
    expect(await screen.findByRole('alert')).toHaveTextContent(PHOTO_MESSAGES['too-large']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server\'s message on a refusal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: PHOTO_MESSAGES['not-an-image'] } }), { status: 400 }));
    choose(renderField(), new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(PHOTO_MESSAGES['not-an-image']);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic message on a non-JSON error (a proxy page)', async () => {
    fetchMock.mockResolvedValue(new Response('<html>413</html>', { status: 413 }));
    choose(renderField(), new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t upload that photo. Try again.');
  });

  it('removes the photo and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { photoId: null } }), { status: 200 }));
    renderField('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE');
  });

  it('offers Remove only when a photo exists, and names the upload button by state', () => {
    renderField(null);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
  });
});
