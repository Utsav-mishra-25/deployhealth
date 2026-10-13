import { describe, expect, it } from 'vitest';
import { dependsOnNext, detectFrameworks, docsUrl } from '../src/pr-check/framework';

describe('dependsOnNext', () => {
  it('reads dependencies and devDependencies, nothing else', () => {
    expect(dependsOnNext(JSON.stringify({ dependencies: { next: '15.5.0' } }))).toBe(true);
    expect(dependsOnNext(JSON.stringify({ devDependencies: { next: '^15' } }))).toBe(true);
    expect(dependsOnNext(JSON.stringify({ peerDependencies: { next: '*' } }))).toBe(false);
    expect(dependsOnNext(JSON.stringify({ dependencies: { 'next-auth': '5' }, name: 'next' }))).toBe(false);
    expect(dependsOnNext(JSON.stringify({ dependencies: ['next'] }))).toBe(false);
  });

  it('never throws on what a repository holds', () => {
    for (const text of ['', '{', 'null', '"next"', '[1,2]', '{"dependencies": null}', '{"dependencies": {"__proto__": {"next": 1}}}']) {
      expect(() => dependsOnNext(text), text).not.toThrow();
      expect(dependsOnNext(text), text).toBe(false);
    }
  });
});

describe('detectFrameworks and the link', () => {
  const none = { headTree: [], headFiles: [], packageJsons: [] };

  it('finds each framework from its marker', () => {
    expect(detectFrameworks(none)).toEqual([]);
    expect(detectFrameworks({ ...none, headTree: ['artisan', 'app/Models/User.php'] })).toEqual(['laravel']);
    expect(detectFrameworks({ ...none, headFiles: [['src/main/kotlin/App.kt', 'import org.springframework.boot.runApplication']] })).toEqual(['spring-boot']);
    expect(detectFrameworks({ ...none, packageJsons: [['package.json', '{"dependencies":{"next":"15"}}']] })).toEqual(['nextjs']);
  });

  it('needs the marker in source, not in a .ts or config file', () => {
    expect(detectFrameworks({ ...none, headFiles: [['src/client.ts', "// org.springframework"]] })).toEqual([]);
    expect(detectFrameworks({ ...none, headTree: ['vendor/acme/artisan', 'docs/artisan.md'] })).toEqual([]);
  });

  it('lists several in a fixed order; the link is a stack page for exactly one, else /docs', () => {
    const both = detectFrameworks({ headTree: ['api/artisan'], headFiles: [], packageJsons: [['web/package.json', '{"dependencies":{"next":"15"}}']] });
    expect(both).toEqual(['nextjs', 'laravel']);
    expect(docsUrl(both)).toBe('https://deployhealth.dev/docs');
    expect(docsUrl([])).toBe('https://deployhealth.dev/docs');
    expect(docsUrl(['laravel'])).toBe('https://deployhealth.dev/docs/laravel');
  });
});
