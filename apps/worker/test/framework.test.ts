import { describe, expect, it } from 'vitest';
import { detectFrameworks, docsUrl } from '../src/pr-check/framework';

describe('detectFrameworks and the link', () => {
  const none = { headTree: [], headFiles: [] };

  it('finds each framework from its marker', () => {
    expect(detectFrameworks(none)).toEqual([]);
    expect(detectFrameworks({ ...none, headTree: ['artisan', 'app/Models/User.php'] })).toEqual(['laravel']);
    expect(detectFrameworks({ ...none, headFiles: [['src/main/kotlin/App.kt', 'import org.springframework.boot.runApplication']] })).toEqual(['spring-boot']);
    for (const name of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'apps/web/next.config.ts']) {
      expect(detectFrameworks({ ...none, headTree: [name] }), name).toEqual(['nextjs']);
    }
  });

  it("needs the marker itself, outside vendored, build and test paths", () => {
    for (const path of ['next.config.example.js', 'next.config.mts', 'next.config.json', 'node_modules/x/next.config.js', '.next/next.config.js', 'tests/next.config.js', 'vendor/acme/artisan', 'docs/artisan.md']) {
      expect(detectFrameworks({ ...none, headTree: [path] }), path).toEqual([]);
    }
    expect(detectFrameworks({ ...none, headFiles: [['src/client.ts', '// org.springframework']] })).toEqual([]);
  });

  it('lists several in a fixed order; the link is a stack page for exactly one, else /docs', () => {
    const both = detectFrameworks({ headTree: ['api/artisan', 'web/next.config.ts'], headFiles: [] });
    expect(both).toEqual(['nextjs', 'laravel']);
    expect(docsUrl(both)).toBe('https://deployhealth.dev/docs');
    expect(docsUrl([])).toBe('https://deployhealth.dev/docs');
    expect(docsUrl(['laravel'])).toBe('https://deployhealth.dev/docs/laravel');
  });
});
