import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  LANGUAGES_DOC_URL,
  LANGUAGES_SENTENCE,
  listLabels,
  NO_SOURCE_FILES_LINE,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGES_AND,
  SUPPORTED_LANGUAGES_OR,
  supportedLanguageOf,
  UNREAD_LANGUAGES_TEXT,
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
  php: "getenv('X_VAR')",
  jvm: 'System.getenv("X_VAR")',
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
    for (const ext of ['.scala', '.groovy', '.rs', '.cs', '.ex', '.exs', '.swift', '.dart']) {
      expect(UNREAD_SOURCE_EXTENSIONS).toContain(ext);
    }
  });

  it('says the languages the same way everywhere', () => {
    expect(SUPPORTED_LANGUAGES_OR).toBe('JS/TS, Python, Go, Ruby, PHP or Java/Kotlin');
    expect(SUPPORTED_LANGUAGES_AND).toBe('JS/TS, Python, Go, Ruby, PHP and Java/Kotlin');
    expect(listLabels(['JS/TS'], 'or')).toBe('JS/TS');
    expect(listLabels(['JS/TS', 'Go'], 'and')).toBe('JS/TS and Go');
    expect(NO_SOURCE_FILES_LINE).toBe("No JS/TS, Python, Go, Ruby, PHP or Java/Kotlin source files found: deployhealth can't check this directory yet.");
  });

  it('classifies paths by extension, case-insensitively, without counting dotfiles as extensions', () => {
    expect(extensionOf('src/Main.JAVA')).toBe('.java');
    expect(extensionOf('a/.env')).toBe('');
    expect(extensionOf('Makefile')).toBe('');
    expect(supportedLanguageOf('web/app.tsx')?.label).toBe('JS/TS');
    expect(supportedLanguageOf('App.java')?.label).toBe('Java/Kotlin');
    expect(supportedLanguageOf('src/main.rs')).toBeUndefined();
    expect(unreadExtensionOf('src/main.rs')).toBe('.rs');
    expect(unreadExtensionOf('src/main/resources/application.properties')).toBeNull();
    expect(unreadExtensionOf('pom.xml')).toBeNull();
  });
});

describe('how messages name the languages not read', () => {
  it('says "other languages", next to the supported list, and links the docs index', () => {
    expect(UNREAD_LANGUAGES_TEXT).toBe('other languages');
    expect(LANGUAGES_SENTENCE).toBe(
      `Reads ${SUPPORTED_LANGUAGES_AND}. Other languages aren't read yet: on a repo in those, the pull request check and the CLI say they can't check it instead of passing it.`,
    );
    expect(LANGUAGES_DOC_URL).toBe('https://deployhealth.dev/docs');
  });
});

describe("the README's language line", () => {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it('opens Known limitations, before its first bullet, as the constant (and not the README itself)', () => {
    const limitations = readme.slice(readme.indexOf('## Known limitations'));
    expect(limitations.slice(0, limitations.indexOf('\n- ')).split('\n')).toContain(LANGUAGES_SENTENCE);
    expect(readme.slice(0, readme.indexOf('![')).split('\n')).not.toContain(LANGUAGES_SENTENCE);
  });

  it('is the first known limitation, with the CLI\'s own line', () => {
    const limitations = readme.slice(readme.indexOf('## Known limitations'));
    const first = limitations.slice(limitations.indexOf('\n- ') + 1, limitations.indexOf('\n- ', limitations.indexOf('\n- ') + 1));
    expect(first.startsWith(`- **Languages.** The scanner reads ${SUPPORTED_LANGUAGES_AND} source`)).toBe(true);
    expect(flat(first)).toContain(flat(NO_SOURCE_FILES_LINE));
  });
});
