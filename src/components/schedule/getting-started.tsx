import Link from 'next/link';
import { Icon } from '@/components/ui/icon';

interface GettingStartedProps {
  hasBankDetails: boolean;
  hasRoom: boolean;
  hasClass: boolean;
}

interface Step {
  label: string;
  detail: string;
  href: string;
  done: boolean;
}

/**
 * Inline onboarding: a quiet checklist on the Schedule tab that retires
 * itself once the teacher is set up. No overlay, no tour — the app is
 * the tour.
 */
export function GettingStarted({ hasBankDetails, hasRoom, hasClass }: GettingStartedProps) {
  const steps: Step[] = [
    {
      label: 'Add your bank details',
      detail: 'Students see them when it’s time to pay',
      href: '/settings/profile',
      done: hasBankDetails,
    },
    {
      label: 'Add a room',
      detail: 'Where you teach, and what it costs you',
      href: '/settings/rooms/new',
      done: hasRoom,
    },
    {
      label: 'Create your first class',
      detail: 'Set your rates once — pricing does the rest',
      href: '/class/new',
      done: hasClass,
    },
  ];

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Getting started</h2>
      <p className="type-caption mt-0.5 mb-2">
        Three steps and your booking page is ready to share.
      </p>
      <div>
        {steps.map((step) => (
          <Link
            key={step.href}
            href={step.href}
            className="flex items-center gap-3 min-h-12 py-2 border-b border-border last:border-b-0 no-underline"
          >
            <span
              className={`flex items-center justify-center w-6 h-6 rounded-full shrink-0 ${
                step.done ? 'bg-teal text-cream' : 'border-[1.5px] border-border'
              }`}
            >
              {step.done && <Icon name="check" size={14} />}
            </span>
            <span className="flex-1 min-w-0">
              <span className={`block text-base ${step.done ? 'text-brown' : 'text-ink'}`}>
                {step.label}
              </span>
              {!step.done && <span className="type-caption">{step.detail}</span>}
            </span>
            {!step.done && <Icon name="chevron-right" size={18} className="text-brown-light" />}
          </Link>
        ))}
      </div>
    </div>
  );
}
