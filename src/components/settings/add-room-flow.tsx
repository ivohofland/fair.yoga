'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Currency } from '@prisma/client';
import type { RoomCitySearchResult, RoomResult } from '@/lib/room-search';
import { RoomSearchStep } from './room-search-step';
import { RoomSettingsStep } from './room-settings-step';
import { RoomCreateStep } from './room-create-step';

type Step = 'search' | 'create' | 'settings';

/**
 * The create form's fields, owned by the router rather than by the step.
 *
 * They live here because the router does not unmount and the steps do:
 * `{step === 'create' && <RoomCreateStep />}` destroys the component's state
 * every time the teacher goes Back. On `main` all of this sat in one
 * never-unmounting component, so stepping back and forward preserved a
 * half-filled form; pushing it into the step silently traded that away, and
 * no test noticed because none steps backwards.
 *
 * Held as one object rather than eight `useState`s so the step takes one
 * value and one setter instead of sixteen props — the split's readability
 * goal without its state-loss cost. `createError` and `creating` stay inside
 * the step: they describe one in-flight submission, and losing them on Back
 * is correct.
 */
export interface NewRoomForm {
  venueName: string;
  roomName: string;
  floor: string;
  address: string;
  city: string;
  postcode: string;
  maxCapacity: string;
  equipmentChecks: Record<string, boolean>;
  notes: string;
  isPublic: boolean;
}

const EMPTY_ROOM_FORM: NewRoomForm = {
  venueName: '',
  roomName: '',
  floor: '',
  address: '',
  city: '',
  postcode: '',
  maxCapacity: '',
  equipmentChecks: {
    mats: false,
    blocks: false,
    straps: false,
    bolsters: false,
    blankets: false,
    cushions: false,
  },
  notes: '',
  isPublic: false,
};

/**
 * A router over the three steps. It owns only the state that crosses a step
 * boundary: `city` and `q` are typed in search, and `city` seeds the create
 * form's city unless the teacher has typed their own there; `selectedRoom` is
 * produced by search or create and consumed by settings, and `step` is its
 * own.
 *
 * #136's two request-body pins used to live here, when this file also built
 * both bodies. They moved with the literals they annotate — the room's to
 * `room-create-step.tsx`, the link's to `room-settings-step.tsx` — because a
 * pin in a file that no longer constructs the body compiles and certifies
 * nothing.
 */
export function AddRoomFlow({ currency }: { currency: Currency }) {
  const router = useRouter();

  // Shared across steps
  const [city, setCity] = useState('');
  const [q, setQ] = useState('');
  const [selectedRoom, setSelectedRoom] = useState<RoomResult | null>(null);
  const [step, setStep] = useState<Step>('search');

  // Survives a step change because the router does not unmount. `results`
  // matters as much as the form fields: the "create a new room" affordance
  // only renders once `results !== null`, so discarding it on Back strands
  // the teacher on a bare search form with no way forward but to re-run the
  // identical search.
  const [results, setResults] = useState<RoomCitySearchResult | null>(null);
  // The `q` that produced `results`, which the live field may have left behind.
  const [searchedQ, setSearchedQ] = useState('');
  // The city last copied into the create form, so a later search can replace
  // it while a city the teacher typed there themselves is left alone.
  const seededCity = useRef('');
  const [roomForm, setRoomForm] = useState<NewRoomForm>(EMPTY_ROOM_FORM);

  // ---- Render ----

  return (
    <div>
      {step === 'search' && (
        <RoomSearchStep
          city={city}
          q={q}
          results={results}
          searchedQ={searchedQ}
          onResultsChange={(r, searched) => { setResults(r); setSearchedQ(searched); }}
          onCityChange={setCity}
          onQChange={setQ}
          onSelect={(room) => { setSelectedRoom(room); setStep('settings'); }}
          onCreateNew={() => {
            // Seeds an empty form city, or one still holding the previous
            // seed; anything the teacher typed there survives Back and forward.
            const seed = city.trim();
            const previous = seededCity.current;
            seededCity.current = seed;
            setRoomForm((f) => (
              f.city.trim() === '' || f.city === previous ? { ...f, city: seed } : f
            ));
            setStep('create');
          }}
        />
      )}

      {step === 'create' && (
        <RoomCreateStep
          form={roomForm}
          onFormChange={setRoomForm}
          onCreated={(room) => { setSelectedRoom(room); setStep('settings'); }}
          onBack={() => setStep('search')}
        />
      )}

      {step === 'settings' && selectedRoom && (
        <RoomSettingsStep
          selectedRoom={selectedRoom}
          currency={currency}
          onSaved={() => router.push('/settings/rooms')}
          onBack={() => { setSelectedRoom(null); setStep('search'); }}
        />
      )}
    </div>
  );
}
