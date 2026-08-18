'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createRoomSchema, createTeacherRoomSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import type { RoomResult } from '@/lib/room-search';
import { RoomSearchStep } from './room-search-step';
import { RoomSettingsStep } from './room-settings-step';
import { RoomCreateStep } from './room-create-step';

type Step = 'search' | 'create' | 'settings';

/**
 * #136. This form's two enumerations of its request bodies — one for the new
 * room, one for the teacher-room link. Nothing previously checked either
 * against its schema.
 */
interface NewRoomValues {
  venueName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  roomName: string;
  maxCapacity: number;
  equipment: string[];
  notes: string | null;
  isPublic: boolean;
}

interface NewTeacherRoomValues {
  roomId: string;
  capacityOverride: number;
  rentalRate: number;
  equipmentNotes: string | null;
}

type CreateRoomWire = z.infer<typeof createRoomSchema>;
type CreateTeacherRoomWire = z.infer<typeof createTeacherRoomSchema>;

/**
 * #136. Two bodies, two endpoints, four pins — this form creates a room and
 * then attaches the teacher to it, and the two payloads have nothing in
 * common. Each is pinned to its own schema in both directions.
 */
const _roomCoversCreate: NoneOf<Exclude<keyof CreateRoomWire, keyof NewRoomValues>> = true;
const _roomHasNoExtras: NoneOf<Exclude<keyof NewRoomValues, keyof CreateRoomWire>> = true;
const _linkCoversCreate: NoneOf<Exclude<keyof CreateTeacherRoomWire, keyof NewTeacherRoomValues>> = true;
const _linkHasNoExtras: NoneOf<Exclude<keyof NewTeacherRoomValues, keyof CreateTeacherRoomWire>> = true;
void _roomCoversCreate;
void _roomHasNoExtras;
void _linkCoversCreate;
void _linkHasNoExtras;

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
