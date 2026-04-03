export interface SessionUser {
  sessionId: string;
  userId: string;
  userType: 'teacher' | 'student';
}
