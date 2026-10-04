'use client';

import { useState, useSyncExternalStore } from 'react';
import type { RegistrationStatus } from '@prisma/client';
import { Icon } from '@/components/ui/icon';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import {
  EMPTY_OUTBOX,
  attendanceRequest,
  attendanceUrl,
  dismissRefused,
  enqueueAttendance,
  flushOutbox,
  getOutboxSnapshot,
  isAttendanceAnswer,
  subscribeOutbox,
  type AttendanceTarget,
} from '@/lib/attendance-outbox';

/** A registration this list can show: every status but `cancelled`. */
export type AttendanceStatus = Exclude<RegistrationStatus, 'cancelled'>;

export interface AttendanceItem {
  registrationId: string;
  studentName: string;
  status: AttendanceStatus;
}

interface AttendanceListProps {
  items: AttendanceItem[];
  /** True on a completed class: rows render read-only until the teacher opts
   *  into "Edit attendance". Defaults to `false` (check-in behaviour, always
   *  editable). */
  locked?: boolean;
  /** The signed-in account: whose outbox a tap is queued in. */
  owner: string;
  classId: string;
  /** The class as the sync block names it, formatted by the server. */
  classLabel: string;
  /** True when this page rendered the class `completed` — what the page
   *  showed, frozen at render like every prop here. Recorded on each queued
   *  mark, so a sync can tell a correction from a mark that landed after the
   *  class finished. */
  completed: boolean;
  /** Server epoch ms at which `items` was read: a confirmation older than this
   *  is already in `items`, or was overtaken by a later write. */
  renderedAt: number;
}

/**
 * A row's label, tethered to the compiler against `AttendanceStatus` so a
 * future member fails here rather than falling through to a wrong label.
 * `registered` reads "Not marked" rather than "No-show" — an untouched row is
 * not a recorded absence, and must not read as one (spec D5; #234).
 */
function statusLabel(status: AttendanceStatus): string {
  switch (status) {
    case 'attended':
      return 'Present';
    case 'late_cancel':
      return 'Late cancel';
    case 'no_show':
      return 'No-show';
    case 'registered':
      return 'Not marked';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The control is offered whatever the class status, and no prop gates it.
 *
 * The server refuses `late_cancel -> attended` while the class is still `open`
 * (see the WHERE in `api/registrations/[id]/route.ts`), and the obvious move is
 * to disable the control until then. But this page is a server component with
 * no `revalidate`, and check-in renders from T-15min, while
 * `autoTransitionToInProgress` flips the class up to 60s after the start. Every
 * prop is frozen at render: a control gated on the status would stay disabled,
 * under a tooltip saying "once the class has started", for the whole class for
 * a teacher who opened the page before it began. That trades a visible refusal
 * for a silent one, which is worse. `completed` is frozen too, deliberately: it
 * records what the page showed, and gates nothing.
 *
 * The server is the only thing that knows, so it judges each write when it
 * arrives and a refusal shows its reason on the row, or above the list for a
 * direct write. A tap never refreshes the page: offline, a failed refresh
 * becomes a hard reload mid check-in.
 *
 * Every tap is queued in the attendance outbox (`@/lib/attendance-outbox`) and
 * a sync replays it; a row shows, in order, its queued mark, else a status a
 * sync confirmed no earlier than this render's second (`confirmedAt` is the
 * server's `Date` header, whole seconds, so a tie goes to the confirmation),
 * else the status the direct-write fallback saved, else `items` (spec §3 of
 * docs/superpowers/specs/2026-10-04-offline-checkin-design.md).
 *
 * The fallback sits below the confirmation: a tap that falls back drops the
 * row's confirmation, so one present beside a fallback status was written
 * after it, by another tab's sync, and is the newer of the two.
 */
export function AttendanceList({
  items,
  locked = false,
  owner,
  classId,
  classLabel,
  completed,
  renderedAt,
}: AttendanceListProps) {
  // The server snapshot is empty, so the first render — the hydrating one
  // included — never reads storage.
  const outbox = useSyncExternalStore(
    subscribeOutbox,
    () => getOutboxSnapshot(owner),
    () => EMPTY_OUTBOX,
  );
  const queued = new Map(outbox.queued.map((entry) => [entry.registrationId, entry.target]));
  const refused = new Map(outbox.refused.map((entry) => [entry.registrationId, entry.message]));
  // Statuses the direct-write fallback saved, for when storage cannot queue.
  // A later queued mark for the row clears its entry here.
  const [direct, setDirect] = useState<Readonly<Record<string, AttendanceTarget>>>({});
  // Set only while a direct write is in flight.
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `locked` only sets where this starts — check-in opens editable, a
  // completed class opens read-only until the teacher's own "Edit
  // attendance" tap unlocks the row controls.
  const [editing, setEditing] = useState(!locked);

  const renderedSecond = Math.floor(renderedAt / 1000) * 1000;

  function displayedStatus(item: AttendanceItem): AttendanceStatus {
    const confirmation = outbox.confirmed[item.registrationId];
    return (
      queued.get(item.registrationId) ??
      (confirmation !== undefined && confirmation.confirmedAt >= renderedSecond ? confirmation.target : undefined) ??
      direct[item.registrationId] ??
      item.status
    );
  }

  async function toggleAttendance(item: AttendanceItem) {
    const { registrationId, studentName, status: originalStatus } = item;
    const currentStatus = displayedStatus(item);
    // A student who cancelled late is not a no-show — they told the teacher they
    // were not coming, and were charged for saying so. The only correction that
    // means anything for them is "they came after all", and it has to be
    // reversible: a plain attended/no_show toggle would destroy `late_cancel` on
    // the second tap with no way back, taking with it the caption their own
    // `/bookings` page shows them ("Cancelled after the deadline — this class is
    // still charged"). `updateRegistrationSchema` accepts `late_cancel`, so the
    // round trip is expressible.
    const newStatus: AttendanceTarget =
      originalStatus === 'late_cancel'
        ? currentStatus === 'attended'
          ? 'late_cancel'
          : 'attended'
        : currentStatus === 'attended'
          ? 'no_show'
          : 'attended';

    setError(null);
    const queuedAnswer = enqueueAttendance(owner, {
      registrationId,
      classId,
      classLabel,
      studentName,
      target: newStatus,
      knownCompleted: completed,
    });
    if (queuedAnswer === 'queued') {
      setDirect(({ [registrationId]: _dropped, ...rest }) => rest);
      void flushOutbox(owner);
      return;
    }

    // Storage cannot hold the mark, so write it now rather than queue it silently,
    // with the queued path's request and its test of the answer.
    const init = attendanceRequest(newStatus);
    setUpdating(registrationId);
    try {
      const response = await fetch(attendanceUrl(registrationId), init);

      if (response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        if (isAttendanceAnswer(body, registrationId, newStatus)) {
          setDirect((prev) => ({ ...prev, [registrationId]: newStatus }));
        } else {
          logRequestFailure(
            'attendance-list',
            { registrationId, newStatus, status: response.status },
            new Error('2xx without the matching body'),
          );
          setError("Couldn't confirm the change was saved. Check your connection and try again.");
        }
      } else {
        // The server's own words, not a generic retry prompt: resending the
        // same request rarely helps (spec §1).
        setError(await readErrorMessage(response, 'Could not update attendance.'));
      }
    } catch (err) {
      logRequestFailure('attendance-list', { registrationId, newStatus }, err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setUpdating(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-6">
        <h2 className="type-subtitle mb-3">Attendance</h2>
        <p className="type-body">No registered students.</p>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-3">Attendance</h2>

      {!editing && (
        <button
          type="button"
          data-offline-writable
          onClick={() => setEditing(true)}
          className="type-label text-teal mb-3"
        >
          Edit attendance
        </button>
      )}

      {editing && locked && (
        <p className="type-caption mb-3">
          Corrections update the record — the payment request already sent stays as it is.
        </p>
      )}

      {error && (
        <p role="alert" className="text-danger text-sm mb-3">
          {error}
        </p>
      )}

      <div>
        {items.map((item) => {
          const status = displayedStatus(item);
          const isAttended = status === 'attended';
          const isUpdating = updating === item.registrationId;
          const isQueued = queued.has(item.registrationId);
          const refusal = refused.get(item.registrationId);
          // A queued mark is never shown as saved.
          const label = isQueued ? 'Waiting to sync' : statusLabel(status);

          return (
            <div key={item.registrationId} className="py-2 border-b border-border last:border-b-0">
              <div className="flex items-center justify-between gap-4 min-h-12">
                {/* Large names + big checkboxes: one-handed use at the venue */}
                <span className="text-[17px] text-ink">{item.studentName}</span>

                <div className="flex items-center gap-3">
                  <span className="type-caption">{label}</span>
                  {editing && (
                    <button
                      type="button"
                      data-offline-writable
                      onClick={() => toggleAttendance(item)}
                      disabled={isUpdating}
                      className={`
                        w-11 h-11 rounded-field border-[1.5px] flex items-center justify-center
                        ${isAttended
                          ? 'bg-teal border-teal text-cream'
                          : 'bg-sand-soft border-border text-transparent'}
                        disabled:opacity-50 disabled:cursor-not-allowed
                        ${isUpdating ? 'opacity-50' : ''}
                      `}
                      aria-label={
                        item.status === 'late_cancel'
                          ? `${item.studentName} cancelled late — mark them ${isAttended ? 'cancelled again' : 'present'}`
                          : `Mark ${item.studentName} as ${isAttended ? 'no-show' : 'present'}`
                      }
                    >
                      {isAttended && <Icon name="check" size={22} />}
                    </button>
                  )}
                </div>
              </div>

              {/* A polite live region, mounted on every row so a screen reader
                  announces the text when it arrives: a refusal usually comes
                  from a background sync, not from the tap just made. */}
              <div className={refusal === undefined ? undefined : 'flex items-start justify-between gap-4 pb-1'}>
                <p role="status" className="text-danger text-sm">{refusal}</p>
                {refusal !== undefined && (
                  <button
                    type="button"
                    data-offline-writable
                    onClick={() => dismissRefused(owner, item.registrationId)}
                    aria-label={`Dismiss refused change for ${item.studentName}`}
                    className="type-label text-teal shrink-0"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
