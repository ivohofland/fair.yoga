import { redirect } from 'next/navigation';

// The schedule IS the home base — preserved as a redirect for deep links.
export default function SchedulePage() {
  redirect('/');
}
