/**
 * What sharing a room costs, in one place, for both callers — the create step
 * and the share confirm. One definition so the two cannot drift.
 *
 * Cost first, reassurance second. The reassurance is true and load-bearing:
 * once shared, the room detail page swaps EditRoomForm for
 * EditTeacherRoomForm, so `capacityOverride`, `rentalRate` and
 * `equipmentNotes` become independently editable rather than mirrored from
 * the room's own fields.
 */
export function PublicRoomNotice() {
  return (
    <div className="bg-sand-soft border border-border rounded-card p-4 flex flex-col gap-2">
      <p className="text-ink text-sm font-semibold">Sharing a room is permanent.</p>
      <p className="text-brown text-sm">
        Other teachers can find this room and use it for their own classes. Its venue,
        address, capacity and props can no longer be changed or deleted — by you or by
        anyone else.
      </p>
      <p className="text-brown text-sm">
        Your rate, your capacity and your notes stay private to you, and stay editable.
      </p>
    </div>
  );
}
