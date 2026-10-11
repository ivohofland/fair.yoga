/**
 * What a teacher reads when they try to move a class that already has
 * bookings. The edit form and the class PUT route both show it; this module
 * imports nothing, so the client form can too.
 */
export const BOOKED_SCHEDULE_FIXED_MESSAGE =
  'This class has bookings, so its date and time are fixed. To change them, cancel it and create a new one.';
