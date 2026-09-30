import { ImageResponse } from 'next/og';
import { BRAND_GREEN } from '@/lib/brand';
import { landingAlertMessage } from '@/lib/landing';

// The link preview: the demo's alert on the brand background. Rendered once at build time, with the
// font that ships inside next/og (nothing is fetched).
export const alt = landingAlertMessage();
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: BRAND_GREEN }}>
      <div style={{ display: 'flex', fontSize: 44, fontWeight: 700, color: '#ffffff', letterSpacing: -1 }}>deployhealth</div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: '36px 44px',
          borderRadius: 20,
          background: '#fef2f2',
          border: '3px solid #fecaca',
        }}
      >
        <div style={{ display: 'flex', fontSize: 50, lineHeight: 1.3, fontWeight: 600, color: '#991b1b' }}>{landingAlertMessage()}</div>
      </div>
      <div style={{ display: 'flex', fontSize: 30, color: '#ecfdf5' }}>Env checks on every push, uptime, and alerts that name the deploy.</div>
    </div>,
    size,
  );
}
