import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanFiles, scanProject, selectTreeFiles, type ScanResult } from '../src/scan';
import { scanSource } from '../src/scanner';

// Java, Kotlin and Spring (Phase 5): every read and default form, Spring config placeholders,
// relaxed binding (counts as used / doesn't), the paths never read, and a scope without Spring.
// Build output and wrapper directories are written into a temp copy at test time.
const FIXTURE = fileURLToPath(new URL('./fixtures/spring/', import.meta.url));
const JS_ENV = ['process', 'env'].join('.');

const DECOYS: Record<string, string> = {
  // Maven's target/ (beside pom.xml) and wrapper, Gradle's build/, target/ and cache.
  'target/classes/application.properties': 'secret.key=${TARGET_SECRET}\n',
  'target/generated-sources/Gen.java': 'class Gen { String v = System.getenv("TARGET_GEN"); }\n',
  '.mvn/wrapper/MavenWrapperDownloader.java': 'class W { String u = System.getenv("MVNW_USERNAME"); }\n',
  'gradle-app/build/resources/main/application.yml': 'a: ${BUILD_SECRET}\n',
  'gradle-app/target/Out.java': 'class Out { String v = System.getenv("GRADLE_TARGET"); }\n',
  'gradle-app/.gradle/8.5/Cache.java': 'class C { String v = System.getenv("GRADLE_CACHE"); }\n',
  // A build/ with no Gradle file beside it is ordinary code.
  'web/build/tasks.ts': `export const b = ${JS_ENV}.WEB_BUILD;\n`,
  // src/test/ is a test directory: read only to see what it uses.
  'src/test/java/com/example/AppTest.java': 'class AppTest { String v = System.getenv("UNUSED_JVM_IN_TEST"); }\n',
};
const NEVER_SEEN = ['TARGET_SECRET', 'TARGET_GEN', 'MVNW_USERNAME', 'BUILD_SECRET', 'GRADLE_TARGET', 'GRADLE_CACHE', 'KT_INTERPOLATED', 'COMMENTED_OUT', 'BANG_COMMENT', 'TEST_PROFILE_ONLY', 'KT_UNESCAPED'];

let root: string;
let project: ScanResult;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dh-spring-'));
  await cp(FIXTURE, root, { recursive: true });
  for (const [path, text] of Object.entries(DECOYS)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  project = await scanProject(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Distinct names of one kind in one scope: MISSING by its reference's scope, UNUSED by the scope's .env.example. */
const names = (result: ScanResult, kind: 'missing' | 'unused', scope = '') => {
  const scopeOf = new Map(result.references.map((r) => [`${r.file}:${r.line}:${r.name}`, r.scope]));
  const inScope = (f: ScanResult['findings'][number]) =>
    kind === 'missing' ? scopeOf.get(`${f.file}:${f.line}:${f.var_name}`) === scope : f.env_file === `${scope ? `${scope}/` : ''}.env.example`;
  return [...new Set(result.findings.filter((f) => f.kind === kind && inScope(f)).map((f) => f.var_name))].sort();
};
const optional = (result: ScanResult, scope = '') =>
  result.variables
    .filter((v) => v.scope === scope && v.optional)
    .map((v) => v.var_name)
    .sort();

describe('a Spring Boot app', () => {
  it('reads System.getenv, its map forms, @Value and config placeholders', () => {
    const syntaxOf = (name: string) => project.references.find((r) => r.name === name)?.syntax;
    expect(syntaxOf('PAYMENTS_URL')).toBe('System.getenv');
    expect(syntaxOf('API_TOKEN')).toBe('System.getenv');
    expect(syntaxOf('KT_MAP')).toBe('System.getenv');
    expect(syntaxOf('STRIPE_KEY')).toBe('@Value');
    expect(syntaxOf('KT_VALUE')).toBe('@Value');
    expect(syntaxOf('DATABASE_URL')).toBe('${…}');
    expect(project.references.find((r) => r.name === 'DATABASE_URL')).toMatchObject({ file: 'src/main/resources/application.properties', line: 1 });
  });

  it('a default makes a read optional: getOrDefault, Optional.orElse, Kotlin ?:, ${X:d} and a placeholder inside a default', () => {
    expect(optional(project)).toEqual(['CURRENCY', 'INNER', 'KT_SECRET', 'OUTER', 'REGION', 'REGION_OVERRIDE', 'TIMEOUT']);
  });

  it("MISSING: required reads; null, error(…) and Kotlin's ?: error are no default", () => {
    expect(names(project, 'missing')).toEqual(['API_TOKEN', 'BLOCK_REF', 'KT_MAP', 'KT_REQUIRED', 'KT_VALUE', 'NULL_DEFAULT', 'STRIPE_KEY', 'WEB_BUILD']);
  });

  it('relaxed binding counts Spring Boot prefixes, config keys and @ConfigurationProperties prefixes as used', () => {
    // SPRING_DATASOURCE_USERNAME, SERVER_PORT (prefixes), MAIL_HOST and CACHE_TTLSECONDS (keys),
    // APP_MAIL_SENDER (@ConfigurationProperties), TEST_ONLY_JVM (an *IT.java): none UNUSED.
    expect(names(project, 'unused')).toEqual(['NOTES_FAKE', 'UNUSED_JVM']);
  });

  it('never makes a reference or MISSING from relaxed binding', () => {
    const read = new Set(project.references.map((r) => r.name));
    for (const name of ['SPRING_DATASOURCE_USERNAME', 'SERVER_PORT', 'MAIL_HOST', 'CACHE_TTLSECONDS', 'APP_MAIL_SENDER']) expect(read.has(name), name).toBe(false);
  });

  it('never reads target/ beside pom.xml, build/ or target/ beside a Gradle file, .mvn, .gradle, comments, Kotlin interpolation or test profiles', () => {
    const seen = new Set([...project.references.map((r) => r.name), ...project.findings.map((f) => f.var_name)]);
    for (const name of NEVER_SEEN) expect(seen.has(name), name).toBe(false);
    expect(project.references.some((r) => r.name === 'TARGET_TS' && r.file === 'web/src/target/index.ts')).toBe(true);
    expect(project.references.some((r) => r.name.includes('.'))).toBe(false);
  });
});

describe('a scope without Spring (Gradle, plain Java)', () => {
  it('relaxed binding is off: SPRING_* is UNUSED; .kts build scripts are read', () => {
    expect(names(project, 'unused', 'gradle-app')).toEqual(['SPRING_PROFILES_ACTIVE']);
    expect(names(project, 'missing', 'gradle-app')).toEqual(['PLAIN_VAR']);
    expect(optional(project, 'gradle-app')).toEqual(['SIGNING_KEY']);
  });
});

describe('a Java directory with no env file', () => {
  it('lists its variables and scope, never MISSING', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dh-java-noenv-'));
    await writeFile(join(dir, 'App.java'), 'class App { String a = System.getenv("NO_FILE_VAR"); }\n');
    const result = await scanProject(dir);
    expect(result.envScopes).toEqual([{ scope: '', env_files: [] }]);
    expect(result.variables).toEqual([{ var_name: 'NO_FILE_VAR', scope: '', defined_in: [] }]);
    expect(result.findings).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("Spring config alone isn't source: a directory with only application.yml can't be checked", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dh-spring-only-'));
    await writeFile(join(dir, 'application.yml'), 'a: ${ONLY_YAML}\n');
    await writeFile(join(dir, '.env.example'), 'ONLY_YAML=\nLEFTOVER=\n');
    const result = await scanProject(dir);
    expect(result.sourceFiles).toBe(0);
    expect(result.references.map((r) => r.name)).toEqual(['ONLY_YAML']);
    expect(result.findings.filter((f) => f.kind === 'unused')).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

/** Every file under `dir`, POSIX paths (like a git tree that committed everything). */
async function allFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await allFiles(dir, path)));
    else out.push(path);
  }
  return out;
}

describe('the GitHub App sees the same thing from the tree', () => {
  it('selects the same files (never fetching build output) and finds the same results', async () => {
    const tree = await allFiles(root);
    const selected = selectTreeFiles(tree);
    expect(selected).toContain('src/main/resources/application.yml');
    expect(selected.some((p) => p.startsWith('target/') || p.startsWith('.mvn/') || p.startsWith('gradle-app/build/') || p.startsWith('gradle-app/target/') || p.startsWith('gradle-app/.gradle/'))).toBe(false);
    expect(selected).toContain('web/build/tasks.ts');
    const files = new Map(await Promise.all(selected.map(async (p) => [p, await readFile(join(root, p), 'utf8')] as const)));
    const fromTree = await scanFiles(files);
    // The App never fetches test files, so the variable only an *IT.java reads is UNUSED there.
    const testOnly = (f: ScanResult['findings'][number]) => f.kind === 'unused' && f.var_name === 'TEST_ONLY_JVM';
    expect(fromTree.findings.filter((f) => !testOnly(f))).toEqual(project.findings);
    expect(fromTree.findings.filter(testOnly)).toHaveLength(1);
    expect(fromTree.variables).toEqual(project.variables);
  });
});

describe('scanSource for Java and Kotlin, line by line', () => {
  const read = (line: string, file = 'A.java') => scanSource(line, 'jvm', file).map((r) => `${r.name}${r.hasDefault ? '?' : ''}`);

  it('each read form', () => {
    expect(read('System.getenv("A"); System.getenv().get("B"); System.getenv()["C"]; System.getenv().getOrDefault("D", "x");')).toEqual(['A', 'B', 'C', 'D?']);
    expect(read('System.getenv(\'A\'); System.getenv(name); getenv("B"); System.getProperty("C");')).toEqual([]);
  });

  it('each default form', () => {
    expect(read('System.getenv("A") ?: "x"', 'a.kt')).toEqual(['A?']);
    expect(read('System.getenv("A") ?: return', 'a.kt')).toEqual(['A?']);
    for (const required of ['null', 'throw IllegalStateException()', 'error("A")', 'TODO()', 'requireNotNull(x)']) {
      expect(read(`System.getenv("A") ?: ${required}`, 'a.kt'), required).toEqual(['A']);
    }
    expect(read('Optional.ofNullable(System.getenv("A")).orElse("x")')).toEqual(['A?']);
    expect(read('Optional.ofNullable(System.getenv("A")).orElseGet(() -> "x")')).toEqual(['A?']);
    expect(read('Optional.ofNullable(System.getenv("A")).orElse(null)')).toEqual(['A']);
    expect(read('System.getenv().getOrDefault("A", null)')).toEqual(['A']);
  });

  it('@Value placeholders: env names only, Kotlin needs \\${', () => {
    expect(read('@Value("${A}") @Value("${B:x}") @Value("${server.port}") @Value("${C:${D}}")')).toEqual(['A', 'B?', 'C?', 'D?']);
    expect(read('@Value(value = "jdbc:${HOST}/${DB:app}")')).toEqual(['HOST', 'DB?']);
    expect(read('@Value("\\${A}") @Value("${B}")', 'a.kt')).toEqual(['A']);
    expect(read('String s = "${NOT_A_VALUE}";')).toEqual([]);
  });
});
