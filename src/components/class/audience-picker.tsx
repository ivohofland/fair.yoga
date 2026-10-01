'use client';

import { useEffect, useRef, useState } from 'react';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import type { AnnouncementAudienceResponse } from '@/lib/api-types';
import { MAX_CUSTOM_AUDIENCE } from '@/lib/schemas';
import { Input } from '@/components/ui/input';

type AudienceStudent = AnnouncementAudienceResponse['students'][number];

export type AudienceLoadStatus = 'loading' | 'ready' | 'failed';

interface AudiencePickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Told every time the list starts loading, arrives, or fails to. */
  onLoadStateChange?: (status: AudienceLoadStatus) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; students: AudienceStudent[] };

const LOAD_FAILED = 'Could not load your students.';

export function AudiencePicker({ selected, onChange, onLoadStateChange }: AudiencePickerProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [unticked, setUnticked] = useState(0);
  // The load effect runs once per attempt but must prune against the
  // selection and callbacks current when the list arrives.
  const latest = useRef({ selected, onChange, onLoadStateChange });
  useEffect(() => {
    latest.current = { selected, onChange, onLoadStateChange };
  });

  useEffect(() => {
    latest.current.onLoadStateChange?.(load.status);
  }, [load.status]);

  useEffect(() => {
    let cancelled = false;
    async function fetchAudience() {
      try {
        const res = await fetch('/api/announcements/audience');
        if (!res.ok) {
          const message = await readErrorMessage(res, LOAD_FAILED);
          logRequestFailure(
            'audience-picker',
            { status: res.status },
            new Error(`audience request answered ${res.status}`),
          );
          if (!cancelled) setLoad({ status: 'failed', message });
          return;
        }
        const json = (await res.json()) as { data: AnnouncementAudienceResponse };
        if (cancelled) return;
        const present = new Set(json.data.students.map((s) => s.id));
        const kept = latest.current.selected.filter((id) => present.has(id));
        const removed = latest.current.selected.length - kept.length;
        if (removed > 0) latest.current.onChange(kept);
        setUnticked(removed);
        setLoad({ status: 'ready', students: json.data.students });
      } catch (err) {
        logRequestFailure('audience-picker', {}, err);
        if (!cancelled) setLoad({ status: 'failed', message: LOAD_FAILED });
      }
    }
    void fetchAudience();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function retry() {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }

  if (load.status === 'loading') {
    return <p className="type-caption">Loading your students…</p>;
  }
  if (load.status === 'failed') {
    return (
      <div className="flex items-center gap-4">
        <p role="alert" className="text-sm text-danger">
          {load.message}
        </p>
        <button type="button" onClick={retry} className="type-label text-teal min-h-11">
          Try again
        </button>
      </div>
    );
  }

  const untickedNotice =
    unticked > 0 ? (
      <p role="status" className="type-caption">
        {unticked === 1
          ? "1 student you'd chosen is no longer in your audience and was unticked."
          : `${unticked} students you'd chosen are no longer in your audience and were unticked.`}
      </p>
    ) : null;

  if (load.students.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {untickedNotice}
        <p className="type-caption">
          No students to choose from yet — students appear here once they have booked with you.
        </p>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = load.students.filter((s) => s.displayName.toLowerCase().includes(needle));
  const atLimit = selected.length >= MAX_CUSTOM_AUDIENCE;

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else if (!atLimit) {
      onChange([...selected, id]);
    }
  }

  function selectAllShown() {
    const added = shown.map((s) => s.id).filter((id) => !selected.includes(id));
    onChange([...selected, ...added].slice(0, MAX_CUSTOM_AUDIENCE));
  }

  return (
    <div className="flex flex-col gap-3">
      {untickedNotice}
      <Input
        type="search"
        label="Search students"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex items-center gap-4">
        <button type="button" onClick={selectAllShown} className="type-label text-teal min-h-11">
          Select all
        </button>
        <button type="button" onClick={() => onChange([])} className="type-label text-teal min-h-11">
          Clear
        </button>
        <span className="type-caption">{selected.length} selected</span>
      </div>
      {atLimit && (
        <p role="status" className="type-caption">
          One announcement can go to at most {MAX_CUSTOM_AUDIENCE} students. Clear some to choose others.
        </p>
      )}
      <ul className="flex flex-col max-h-[320px] overflow-y-auto border border-border rounded-card">
        {shown.map((s) => {
          const checked = selected.includes(s.id);
          return (
            <li key={s.id} className="border-b border-border last:border-b-0">
              <label className="flex items-center gap-3 min-h-14 px-4 type-body">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atLimit}
                  onChange={() => toggle(s.id)}
                  className="h-5 w-5 accent-teal"
                />
                {s.displayName}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
