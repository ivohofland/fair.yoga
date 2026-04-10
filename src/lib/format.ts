export function formatRoomLocation(roomName: string, venueName: string): string {
  return roomName ? `${roomName} at ${venueName}` : venueName;
}

export function formatStudentName(firstName: string, lastName: string, shareFullName = false): string {
  if (shareFullName) {
    return `${firstName}${lastName ? ` ${lastName}` : ''}`.trim();
  }
  const lastInitial = lastName.length > 0 ? lastName[0] : '';
  return `${firstName} ${lastInitial ? lastInitial.toLowerCase() + '.' : ''}`.trim();
}
