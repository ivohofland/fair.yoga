'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RoomResult } from '@/lib/room-search';
import { RoomSearchStep } from './room-search-step';
import { RoomSettingsStep } from './room-settings-step';
import { RoomCreateStep } from './room-create-step';

type Step = 'search' | 'create' | 'settings';

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

  // ---- Render ----

  return (
    <div>
      {step === 'search' && (
        <RoomSearchStep
          postcode={postcode}
          street={street}
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
