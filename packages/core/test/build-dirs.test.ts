import { describe, expect, it } from 'vitest';
import { inContextualSkipDir, isContextualSkip, treeMarkers } from '../src/build-dirs';
import { passesTreeRules } from '../src/scan';

describe('build output known by its context', () => {
  it('skips bootstrap/cache and public/build at any depth, but not cache/ or build/ elsewhere', () => {
    const none = treeMarkers([]);
    expect(inContextualSkipDir('bootstrap/cache/config.php', none)).toBe(true);
    expect(inContextualSkipDir('apps/api/bootstrap/cache/packages.php', none)).toBe(true);
    expect(inContextualSkipDir('public/build/assets/app.js', none)).toBe(true);
    expect(inContextualSkipDir('src/cache/redis.ts', none)).toBe(false);
    expect(inContextualSkipDir('build/webpack.config.js', none)).toBe(false);
    expect(inContextualSkipDir('bootstrap/app.php', none)).toBe(false);
  });

  it("skips storage/ only beside Laravel's artisan, at the same level", () => {
    const tree = ['backend/artisan', 'backend/storage/framework/views/a.php', 'storage/index.ts', 'backend/app/storage/Disk.php'];
    const markers = treeMarkers(tree);
    expect(inContextualSkipDir('backend/storage/framework/views/a.php', markers)).toBe(true);
    expect(inContextualSkipDir('storage/index.ts', markers)).toBe(false);
    expect(inContextualSkipDir('backend/app/storage/Disk.php', markers)).toBe(false);
    expect(inContextualSkipDir('artisan', treeMarkers(['artisan']))).toBe(false);
    expect(inContextualSkipDir('storage/logs/x.php', treeMarkers(['artisan']))).toBe(true);
  });

  it('passesTreeRules applies them; without the markers, storage/ passes', () => {
    const markers = treeMarkers(['artisan']);
    expect(passesTreeRules('storage/x.php', { markers })).toBe(false);
    expect(passesTreeRules('storage/x.php')).toBe(true);
    expect(passesTreeRules('bootstrap/cache/x.php')).toBe(false);
    expect(passesTreeRules('.phpunit.cache/x.php')).toBe(false);
  });

  it('isContextualSkip is what the directory walk asks', () => {
    expect(isContextualSkip('', 'storage', (f) => f === 'artisan')).toBe(true);
    expect(isContextualSkip('', 'storage', () => false)).toBe(false);
    expect(isContextualSkip('bootstrap', 'cache', () => false)).toBe(true);
  });
});
