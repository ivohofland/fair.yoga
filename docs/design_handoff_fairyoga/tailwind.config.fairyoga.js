/**
 * fair.yoga Tailwind preset.
 *
 * Two ways to use this:
 *
 * (A) As a preset (recommended):
 *     // tailwind.config.js
 *     module.exports = {
 *       presets: [require('./tailwind.config.fairyoga.js')],
 *       content: ['./app/**\/*.{ts,tsx}', './components/**\/*.{ts,tsx}'],
 *     };
 *
 * (B) Merged into theme.extend manually:
 *     const fy = require('./tailwind.config.fairyoga.js');
 *     module.exports = {
 *       content: [...],
 *       theme: { extend: { ...fy.theme.extend } },
 *     };
 *
 * Pair this with tokens.css imported from app/globals.css so the CSS variables
 * are defined; the utilities below resolve to those variables.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        fy: {
          teal:        'var(--fy-teal)',
          sand:        'var(--fy-sand)',
          cream:       'var(--fy-cream)',
          brown:       'var(--fy-brown)',
          gold:        'var(--fy-gold)',
          dark:        'var(--fy-dark)',
          border:      'var(--fy-border)',
          error:       'var(--fy-error)',
          'teal-light': 'var(--fy-teal-light)',
          'teal-soft': 'rgba(26, 86, 83, 0.10)',
        },
        // Semantic aliases
        fg: {
          DEFAULT: 'var(--fg1)',
          muted:   'var(--fg2)',
          accent:  'var(--fg-accent)',
          subtle:  'var(--fg-muted)',
          error:   'var(--fg-error)',
          onTeal:  'var(--fg-on-teal)',
        },
        bg: {
          page:    'var(--bg-page)',
          surface: 'var(--bg-surface)',
          input:   'var(--bg-input)',
          tint:    'var(--bg-tint)',
        },
      },
      fontFamily: {
        heading: ['Georgia', '"Times New Roman"', 'serif'],
        body:    ['"Atkinson Hyperlegible"', 'Arial', 'Helvetica', 'sans-serif'],
        mono:    ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // [size, lineHeight]
        xs:   ['12px', '1.5'],
        sm:   ['14px', '1.5'],
        base: ['16px', '1.65'],
        lg:   ['18px', '1.5'],
        xl:   ['20px', '1.2'],
        '2xl': ['24px', '1.2'],
        '3xl': ['30px', '1.1'],
        '4xl': ['36px', '1.1'],
        // Editorial moments
        pullquote: ['40px', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
        hero:      ['46px', { lineHeight: '1', letterSpacing: '-0.01em' }],
      },
      lineHeight: {
        tight:  '1.2',
        normal: '1.5',
        loose:  '1.65',
      },
      spacing: {
        1:  '4px',
        2:  '8px',
        3:  '12px',
        4:  '16px',
        5:  '20px',
        6:  '24px',
        8:  '32px',
        10: '40px',
        12: '48px',
        tap: '44px',
      },
      borderRadius: {
        none: '0',
        sm:   '4px',
        // The 8px "pay" radius — used ONLY on attendance + payment buttons.
        // Named explicitly to discourage accidental use.
        pay:  '8px',
        md:   '8px',
        lg:   '12px',
      },
      boxShadow: {
        none:  'none',
        focus: 'inset 0 0 0 1px var(--fy-brown)',
      },
      borderColor: {
        DEFAULT: 'var(--fy-border)',
        strong:  'var(--fy-teal)',
      },
      minHeight: {
        tap: '44px',
      },
      minWidth: {
        tap: '44px',
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        '.font-oldstyle': { fontFeatureSettings: '"onum" 1, "kern" 1' },
        '.font-tabular':  { fontFeatureSettings: '"tnum" 1, "lnum" 1, "kern" 1' },
        '.font-smallcaps': {
          fontVariantCaps: 'small-caps',
          fontFeatureSettings: '"smcp" 1',
          letterSpacing: '0.08em',
        },
      });
    },
  ],
};
