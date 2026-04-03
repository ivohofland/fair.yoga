'use client';

import { useState, type ReactNode } from 'react';

interface AccordionSection {
  id: string;
  label: string;
  children: ReactNode;
}

interface AccordionProps {
  sections: AccordionSection[];
  defaultOpen?: string;
}

export function Accordion({ sections, defaultOpen }: AccordionProps) {
  const [openId, setOpenId] = useState(defaultOpen ?? sections[0]?.id ?? '');

  return (
    <div>
      {sections.map((section) => {
        const isOpen = section.id === openId;
        return (
          <div key={section.id}>
            <button
              id={`heading-${section.id}`}
              onClick={() => setOpenId(isOpen ? '' : section.id)}
              aria-expanded={isOpen}
              aria-controls={`section-${section.id}`}
              className="w-full flex items-center justify-between py-4 text-left font-heading text-xl font-bold text-teal border-b border-border"
            >
              <span>{section.label}</span>
              <span className="text-brown text-sm">{isOpen ? '\u25BE' : '\u25B8'}</span>
            </button>
            <div
              id={`section-${section.id}`}
              role="region"
              aria-labelledby={`heading-${section.id}`}
              style={{ display: isOpen ? 'block' : 'none' }}
              className="py-4"
            >
              {section.children}
            </div>
          </div>
        );
      })}
    </div>
  );
}
