import { ImageResponse } from 'next/og';
import { BRAND_GREEN } from '@/lib/brand';
import { HERO, LANDING_METADATA } from '@/lib/marketing';

// The link preview: the landing headline on the brand background. Rendered once at build time,
// with the font that ships inside next/og (nothing is fetched).
export const alt = LANDING_METADATA.imageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: BRAND_GREEN }}>
      <div style={{ display: 'flex', fontSize: 44, fontWeight: 700, color: '#ffffff', letterSpacing: -1 }}>deployhealth</div>
      <div style={{ display: 'flex', fontSize: 72, lineHeight: 1.15, fontWeight: 700, color: '#ffffff', letterSpacing: -1.5 }}>{HERO.headline}</div>
      <div style={{ display: 'flex', fontSize: 30, color: '#ecfdf5' }}>Pull request checks, uptime, and alerts that name the deploy.</div>
    </div>,
    size,
  );
}
