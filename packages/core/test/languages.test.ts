import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  LANGUAGES_SENTENCE,
  listLabels,
  NO_SOURCE_FILES_LINE,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGES_AND,
  SUPPORTED_LANGUAGES_OR,
  supportedLanguageOf,
  UNREAD_SOURCE_EXTENSIONS,
  unreadExtensionOf,
} from '../src/languages';
import { LANGUAGE_BY_EXTENSION, languageForFile, scanSource, SCANNED_EXTENSIONS } from '../src/scanner';

const ENV = ['process', 'env'].join('.');
/** One read per language, in that language's syntax. */
const SAMPLE: Record<string, string> = {
  javascript: `${ENV}.X_VAR`,
  python: 'os.getenv("X_VAR")',
  go: 'os.Getenv("X_VAR")',
  ruby: 'ENV["X_VAR"]',
};

describe('the supported languages constant', () => {
  it('names exactly the extensions scanner.ts reads, and the scanner reads each one in that language', () => {
    const fromConstant = SUPPORTED_LANGUAGES.flatMap((l) => l.extensions).sort();
    expect([...SCANNED_EXTENSIONS].sort()).toEqual(fromConstant);
    for (const language of SUPPORTED_LANGUAGES) {
      for (const ext of language.extensions) {
        expect(LANGUAGE_BY_EXTENSION[ext]).toBe(language.id);
        expect(languageForFile(`src/a${ext}`)).toBe(language.id);
        expect(scanSource(SAMPLE[language.id]!, language.id, `a${ext}`).map((r) => r.name)).toEqual(['X_VAR']);
      }
    }
  });

  it('keeps the unread list disjoint from what the scanner reads', () => {
    for (const ext of UNREAD_SOURCE_EXTENSIONS) {
      expect(SCANNED_EXTENSIONS.has(ext)).toBe(false);
      expect(languageForFile(`a${ext}`)).toBeUndefined();
    }
    for (const ext of ['.java', '.kt', '.kts', '.scala', '.groovy', '.properties', '.php', '.rs', '.cs', '.ex', '.exs', '.swift', '.dart']) {
      expect(UNREAD_SOURCE_EXTENSIONS).toContain(ext);
    }
  });

  it('says the languages the same way everywhere', () => {
    expect(SUPPORTED_LANGUAGES_OR).toBe('JS/TS, Python, Go or Ruby');
    expect(SUPPORTED_LANGUAGES_AND).toBe('JS/TS, Python, Go and Ruby');
    expect(listLabels(['JS/TS'], 'or')).toBe('JS/TS');
    expect(listLabels(['JS/TS', 'Go'], 'and')).toBe('JS/TS and Go');
    expect(NO_SOURCE_FILES_LINE).toBe("No JS/TS, Python, Go or Ruby source files found: deployhealth can't check this directory yet.");
  });

  it('classifies paths by extension, case-insensitively, without counting dotfiles as extensions', () => {
    expect(extensionOf('src/Main.JAVA')).toBe('.java');
    expect(extensionOf('a/.env')).toBe('');
    expect(extensionOf('Makefile')).toBe('');
    expect(supportedLanguageOf('web/app.tsx')?.label).toBe('JS/TS');
    expect(supportedLanguageOf('App.java')).toBeUndefined();
    expect(unreadExtensionOf('src/main/resources/application.properties')).toBe('.properties');
    expect(unreadExtensionOf('pom.xml')).toBeNull();
  });
});

describe("the README's language line", () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it('opens the README, before the first screenshot, as the constant', () => {
    const opening = readme.slice(0, readme.indexOf('!['));
    expect(opening.split('\n')).toContain(LANGUAGES_SENTENCE);
  });

  it('is the first known limitation, with the CLI\'s own line', () => {
    const limitations = readme.slice(readme.indexOf('## Known limitations'));
    const first = limitations.slice(limitations.indexOf('\n- ') + 1, limitations.indexOf('\n- ', limitations.indexOf('\n- ') + 1));
    expect(first.startsWith(`- **Languages.** The scanner reads ${SUPPORTED_LANGUAGES_AND} source`)).toBe(true);
    expect(flat(first)).toContain(flat(NO_SOURCE_FILES_LINE));
  });
});
