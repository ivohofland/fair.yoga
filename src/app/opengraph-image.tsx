import { ImageResponse } from 'next/og';

// The preview card every page shares, a teacher's included: cream ground, the
// wordmark, one line of what it is. Colours are globals.css's tokens, written
// out because the image renders outside the stylesheet.
export const alt = 'fair.yoga — a free booking system for independent yoga teachers';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 96px',
          backgroundColor: '#F7F4EF',
          color: '#6B5B4E',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 120, fontWeight: 700, color: '#2D2D2D' }}>
          fair<span style={{ color: '#1A5653', fontSize: 148 }}>.</span>yoga
        </div>
        <div style={{ display: 'flex', marginTop: 32, fontSize: 44, lineHeight: 1.3, maxWidth: 920 }}>
          A free booking system for independent yoga teachers. Sliding scale or donation.
        </div>
      </div>
    ),
    size,
  );
}
