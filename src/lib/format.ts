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

/** Compact relative time for notification rows: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(date: Date): string {
  const diffMinutes = Math.floor((Date.now() - new Date(date).getTime()) / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
