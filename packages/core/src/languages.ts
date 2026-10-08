// Browser-safe (no Node imports): the languages the scanner reads, and how every result names them.
// The App's check runs, the CLI, the web app and the README all take their wording from here.

export type LanguageId = 'javascript' | 'python' | 'go' | 'ruby' | 'php' | 'jvm';

export interface SupportedLanguage {
  id: LanguageId;
  /** How results name it: "JS/TS", "Python", … */
  label: string;
  /** Lowercase, with the dot. scanner.ts reads exactly these (test/languages.test.ts). */
  extensions: readonly string[];
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { id: 'javascript', label: 'JS/TS', extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] },
  { id: 'python', label: 'Python', extensions: ['.py'] },
  { id: 'go', label: 'Go', extensions: ['.go'] },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'] },
  // `.blade.php` templates included: their extension is `.php`.
  { id: 'php', label: 'PHP', extensions: ['.php'] },
  // `.kts` scripts; Gradle's *.gradle.kts build scripts are build tooling (test-paths.ts).
  { id: 'jvm', label: 'Java/Kotlin', extensions: ['.java', '.kt', '.kts'] },
];

/** "A, B, C or D" / "A, B, C and D" (no serial comma); one item alone, two joined by the word. */
export function listLabels(labels: readonly string[], word: 'or' | 'and'): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ${word} ${labels.at(-1)}`;
}

const LABELS = SUPPORTED_LANGUAGES.map((l) => l.label);
/** "JS/TS, Python, Go, Ruby, PHP or Java/Kotlin" */
export const SUPPORTED_LANGUAGES_OR = listLabels(LABELS, 'or');
/** "JS/TS, Python, Go, Ruby, PHP and Java/Kotlin" */
export const SUPPORTED_LANGUAGES_AND = listLabels(LABELS, 'and');

/**
 * Common source extensions the scanner does NOT read, lowercase. Used only to say what a repo
 * holds that wasn't read (counts by extension, never paths); never to scan.
 */
export const UNREAD_SOURCE_EXTENSIONS: readonly string[] = [
  '.scala',
  '.groovy',
  '.rs',
  '.cs',
  '.ex',
  '.exs',
  '.swift',
  '.dart',
  '.c',
  '.cpp',
  '.h',
  '.m',
  '.sh',
  '.lua',
  '.pl',
  '.r',
];

/** The languages people ask about first that aren't read yet, for messages. */
export const UNREAD_LANGUAGES_TEXT = 'Rust, C# and others';

/** The README section that says which languages are read (its "Languages" bullet comes first). */
export const LANGUAGES_DOC_URL = 'https://github.com/Utsav-mishra-25/deployhealth#known-limitations';

/** One line for the README's opening, the npm README and the landing page. */
export const LANGUAGES_SENTENCE =
  `Reads ${SUPPORTED_LANGUAGES_AND}. ${UNREAD_LANGUAGES_TEXT} aren't read yet: on a repo in those, the pull request ` +
  `check and the CLI say they can't check it instead of passing it.`;

/** What the CLI prints when a directory holds no source file it reads. */
export const NO_SOURCE_FILES_LINE = `No ${SUPPORTED_LANGUAGES_OR} source files found: deployhealth can't check this directory yet.`;

const BY_EXTENSION: ReadonlyMap<string, SupportedLanguage> = new Map(SUPPORTED_LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l] as const)));
const UNREAD: ReadonlySet<string> = new Set(UNREAD_SOURCE_EXTENSIONS);

/** The extension of a path's last segment, lowercase with the dot, or '' (`a/.env` has none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The supported language a path's extension belongs to, if any. */
export function supportedLanguageOf(path: string): SupportedLanguage | undefined {
  return BY_EXTENSION.get(extensionOf(path));
}

/** The unread source extension a path has (`.java`), or null. */
export function unreadExtensionOf(path: string): string | null {
  const ext = extensionOf(path);
  return UNREAD.has(ext) ? ext : null;
}
