import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AudiencePicker } from './audience-picker';
import { MAX_CUSTOM_AUDIENCE } from '@/lib/schemas';

function stubAudience(students: { id: string; displayName: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { students } }) }),
  );
}
const STUDENTS = [
  { id: 'a', displayName: 'Anna K.' },
  { id: 'b', displayName: 'Ben L.' },
  { id: 'c', displayName: 'Cleo M.' },
];

function manyStudents(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, displayName: `Student ${i}` }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AudiencePicker', () => {
  it('lists the audience and reports a ticked student', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={[]} onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Anna K.'));
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('unticks a selected student', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={['a', 'b']} onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Anna K.'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('filters by name without changing the selection', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={['a']} onChange={onChange} />);
    await screen.findByLabelText('Anna K.');
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'ben' } });
    expect(screen.queryByLabelText('Anna K.')).toBeNull();
    expect(screen.getByLabelText('Ben L.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects all shown students', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={[]} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Select all'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('selects only the filtered students and keeps earlier ticks', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={['a']} onChange={onChange} />);
    await screen.findByLabelText('Anna K.');
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Select all'));
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('clears the selection', async () => {
    stubAudience(STUDENTS);
    const onChange = vi.fn();
    render(<AudiencePicker selected={['a', 'b']} onChange={onChange} />);
    fireEvent.click(await screen.findByText('Clear'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('says how many are selected', async () => {
    stubAudience(STUDENTS);
    render(<AudiencePicker selected={['a', 'b']} onChange={vi.fn()} />);
    expect(await screen.findByText('2 selected')).toBeTruthy();
  });

  it('says so when the fetch fails instead of showing an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<AudiencePicker selected={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load your students. Try again.'));
  });

  it('logs and says so when the request itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<AudiencePicker selected={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(consoleError).toHaveBeenCalledWith('[audience-picker] request failed', expect.anything());
  });

  it('says when the teacher has no students to choose from', async () => {
    stubAudience([]);
    render(<AudiencePicker selected={[]} onChange={vi.fn()} />);
    expect(await screen.findByText(/No students to choose from/)).toBeTruthy();
  });

  describe('more students than one announcement can carry', () => {
    it('Select all stops at the limit and says so', async () => {
      stubAudience(manyStudents(MAX_CUSTOM_AUDIENCE + 20));
      const onChange = vi.fn();
      render(<AudiencePicker selected={[]} onChange={onChange} />);
      fireEvent.click(await screen.findByText('Select all'));
      const ids = onChange.mock.calls[0][0] as string[];
      expect(ids).toHaveLength(MAX_CUSTOM_AUDIENCE);
      expect(ids[0]).toBe('id-0');
      expect(ids[MAX_CUSTOM_AUDIENCE - 1]).toBe(`id-${MAX_CUSTOM_AUDIENCE - 1}`);
    });

    it('explains the limit once the selection reaches it, and blocks ticking another', async () => {
      stubAudience(manyStudents(MAX_CUSTOM_AUDIENCE + 20));
      const full = Array.from({ length: MAX_CUSTOM_AUDIENCE }, (_, i) => `id-${i}`);
      const onChange = vi.fn();
      render(<AudiencePicker selected={full} onChange={onChange} />);
      expect(await screen.findByText(/at most 500 students/)).toBeTruthy();
      const extra = screen.getByLabelText(`Student ${MAX_CUSTOM_AUDIENCE}`) as HTMLInputElement;
      expect(extra.disabled).toBe(true);
      fireEvent.click(extra);
      expect(onChange).not.toHaveBeenCalled();
      // A ticked student stays untickable-off.
      const ticked = screen.getByLabelText('Student 0') as HTMLInputElement;
      expect(ticked.disabled).toBe(false);
    });

    it('does not warn below the limit', async () => {
      stubAudience(manyStudents(MAX_CUSTOM_AUDIENCE + 20));
      render(<AudiencePicker selected={['id-0']} onChange={vi.fn()} />);
      await screen.findByLabelText('Student 0');
      expect(screen.queryByText(/at most 500 students/)).toBeNull();
    });
  });
});
