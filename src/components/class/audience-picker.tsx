'use client';

import { useEffect, useState } from 'react';
import { logRequestFailure } from '@/lib/client-errors';
import { MAX_CUSTOM_AUDIENCE } from '@/lib/schemas';
import { Input } from '@/components/ui/input';

interface AudienceStudent {
  id: string;
  displayName: string;
}

interface AudiencePickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; students: AudienceStudent[] };

// Ids are sent back exactly as the endpoint listed them.
export function AudiencePicker({ selected, onChange }: AudiencePickerProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchAudience() {
      try {
        const res = await fetch('/api/announcements/audience');
        if (!res.ok) {
          if (!cancelled) setLoad({ status: 'failed' });
          return;
        }
        const json = (await res.json()) as { data: { students: AudienceStudent[] } };
        if (!cancelled) setLoad({ status: 'ready', students: json.data.students });
      } catch (err) {
        logRequestFailure('audience-picker', {}, err);
        if (!cancelled) setLoad({ status: 'failed' });
      }
    }
    void fetchAudience();
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.status === 'loading') {
    return <p className="type-caption">Loading your students…</p>;
  }
  if (load.status === 'failed') {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load your students. Try again.
      </p>
    );
  }
  if (load.students.length === 0) {
    return (
      <p className="type-caption">
        No students to choose from yet — students appear here once they have booked with you.
      </p>
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
      <Input
        type="search"
        label="Search students"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex items-center gap-4">
        <button type="button" onClick={selectAllShown} className="type-label text-teal">
          Select all
        </button>
        <button type="button" onClick={() => onChange([])} className="type-label text-teal">
          Clear
        </button>
        <span className="type-caption">{selected.length} selected</span>
      </div>
      {atLimit && (
        <p className="type-caption">
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
