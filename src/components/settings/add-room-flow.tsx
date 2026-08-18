'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RoomResult } from '@/lib/room-search';
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
  city: string;
  maxCapacity: string;
  equipmentChecks: Record<string, boolean>;
  notes: string;
  isPublic: boolean;
}

const EMPTY_ROOM_FORM: NewRoomForm = {
  venueName: '',
  roomName: '',
  floor: '',
  city: '',
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
 * boundary: `postcode`/`street` are typed in search and seed the create
 * form's address fields, `selectedRoom` is produced by search or create and
 * consumed by settings, and `step` is its own.
 *
 * #136's two request-body pins used to live here, when this file also built
 * both bodies. They moved with the literals they annotate — the room's to
 * `room-create-step.tsx`, the link's to `room-settings-step.tsx` — because a
 * pin in a file that no longer constructs the body compiles and certifies
 * nothing.
 */
export function AddRoomFlow() {
  const router = useRouter();

  // Shared across steps
  const [postcode, setPostcode] = useState('');
  const [street, setStreet] = useState('');
  const [selectedRoom, setSelectedRoom] = useState<RoomResult | null>(null);
  const [step, setStep] = useState<Step>('search');

  // Survives a step change because the router does not unmount. `results`
  // matters as much as the form fields: the "create a new room" affordance
  // only renders once `results !== null`, so discarding it on Back strands
  // the teacher on a bare search form with no way forward but to re-run the
  // identical search.
  const [results, setResults] = useState<RoomResult[] | null>(null);
  const [roomForm, setRoomForm] = useState<NewRoomForm>(EMPTY_ROOM_FORM);

  // ---- Render ----

  return (
    <div>
      {step === 'search' && (
        <RoomSearchStep
          postcode={postcode}
          street={street}
          results={results}
          onResultsChange={setResults}
          onPostcodeChange={setPostcode}
          onStreetChange={setStreet}
          onSelect={(room) => { setSelectedRoom(room); setStep('settings'); }}
          onCreateNew={() => setStep('create')}
        />
      )}

      {step === 'create' && (
        <RoomCreateStep
          postcode={postcode}
          street={street}
          form={roomForm}
          onFormChange={setRoomForm}
          onPostcodeChange={setPostcode}
          onStreetChange={setStreet}
          onCreated={(room) => { setSelectedRoom(room); setStep('settings'); }}
          onBack={() => setStep('search')}
        />
      )}

      {step === 'settings' && selectedRoom && (
        <RoomSettingsStep
          selectedRoom={selectedRoom}
          onSaved={() => router.push('/settings/rooms')}
          onBack={() => { setSelectedRoom(null); setStep('search'); }}
        />
      )}
    </div>
  );
}
