import { CLI_NPM_PACKAGE, DOCS_STACK_SLUGS, PUBLISHED_CLI_VERSION, TOKEN_SECRET_NAME, type DocsStackSlug } from '@deployhealth/core/browser';

// The /docs pages: what deployhealth reads in each stack, written for people searching for the
// problem. Every code example lives here, with exactly what the scanner reports for it, and
// test/docs-pages.test.ts feeds each one to the scanner, so the pages can't drift from it.
// Prose uses `backticks` for inline code (rendered by components/docs-page.tsx). The dot in
// `process.env` and `import.meta.env` is written \u002e in these strings: they read the same, but
// this repository's own scan (pnpm scan:self) doesn't take the examples for reads of its own.

export const DOCS_SLUGS = DOCS_STACK_SLUGS;
export type DocsSlug = DocsStackSlug;

export interface DocsFile {
  /** Relative to the repository root, as the scanner reports it. */
  path: string;
  code: string;
}

/** One read the scanner reports: the name, where, and whether the code supplies a default. */
export interface DocsRead {
  name: string;
  file: string;
  line: number;
  optional?: true;
}

export interface DocsExample {
  id: string;
  /** One sentence above the files. */
  caption: string;
  files: DocsFile[];
  /** Every read the scanner reports for these files, in file then line order; nothing else. */
  reads: DocsRead[];
  /** The MISSING and UNUSED names it reports, sorted. */
  missing: string[];
  unused: string[];
  /** One sentence under the result. */
  note?: string;
}

export interface DocsSection {
  id: string;
  heading: string;
  paragraphs?: string[];
  items?: string[];
  examples?: DocsExample[];
}

export interface StackDoc {
  slug: DocsSlug;
  /** "Next.js", "Laravel", "Spring Boot". */
  stack: string;
  /** The <title>, under 60 characters. */
  title: string;
  /** The meta description, under 155 characters. */
  description: string;
  h1: string;
  intro: string[];
  sections: DocsSection[];
}

const code = (...lines: string[]) => `${lines.join('\n')}\n`;

/** The no-signup line: the latest CLI, nothing sent. */
export const DRY_RUN_COMMAND = `npx -y ${CLI_NPM_PACKAGE} --dry-run`;

/** The pinned line for deploy history from any CI, as the settings page gives it. */
export const PINNED_NPX = `npx --yes ${CLI_NPM_PACKAGE}@${PUBLISHED_CLI_VERSION}`;

/** The Action alternative: the deployhealth-action repository, at its v1 tag. */
export const ACTION_REF = 'Utsav-mishra-25/deployhealth-action@v1';
export const ACTION_URL = 'https://github.com/Utsav-mishra-25/deployhealth-action';

export const ACTION_WORKFLOW = code(
  '# .github/workflows/deployhealth.yml',
  'name: deployhealth',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  env-scan:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '        with:',
  '          persist-credentials: false',
  `      - uses: ${ACTION_REF}`,
  '        with:',
  `          token: \${{ secrets.${TOKEN_SECRET_NAME} }}`,
);

// ---------------------------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------------------------

const nextjs: StackDoc = {
  slug: 'nextjs',
  stack: 'Next.js',
  title: 'Catch missing env vars in Next.js · deployhealth',
  description:
    'Find env vars your Next.js app reads that .env.example doesn’t declare, on every pull request. Which process\u002eenv reads count, defaults, skips, limits.',
  h1: 'How to catch a missing env var in Next.js before it reaches production',
  intro: [
    'A Next.js app that reads `process\u002eenv.STRIPE_SECRET_KEY` builds and deploys without it, then fails on the first request that needs it. A `NEXT_PUBLIC_` variable is worse: Next.js inlines it at build time, so a missing one ships as `undefined` in the browser.',
    'deployhealth compares the variables your code reads with the ones your env files declare, on every pull request and every push, and names each gap with its file and line. It reads names and line numbers only, never values.',
  ],
  sections: [
    {
      id: 'reads',
      heading: 'What deployhealth reads in a Next.js app',
      paragraphs: [
        'In `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` and `.cts` files, on one line each:',
      ],
      items: [
        '`process\u002eenv.NAME` and `process\u002eenv?.NAME`',
        '`process\u002eenv["NAME"]`, with any quotes',
        '`import.meta\u002eenv.NAME`',
        'destructuring: `const { A, B: alias, C = "x" } = process\u002eenv`',
        'client components’ `NEXT_PUBLIC_` reads, like any other',
      ],
      examples: [
        {
          id: 'nextjs-reads',
          caption: 'A route handler, a client component and a database module, with a .env.example that declares three variables:',
          files: [
            { path: '.env.example', code: code('DATABASE_URL=', 'STRIPE_SECRET_KEY=', 'NEXT_PUBLIC_POSTHOG_KEY=') },
            {
              path: 'app/api/checkout/route.ts',
              code: code(
                "import Stripe from 'stripe';",
                '',
                'const stripe = new Stripe(process\u002eenv.STRIPE_SECRET_KEY!);',
                "const webhookSecret = process\u002eenv['STRIPE_WEBHOOK_SECRET'];",
              ),
            },
            { path: 'app/providers.tsx', code: code("'use client';", '', 'export const posthogKey = process\u002eenv.NEXT_PUBLIC_POSTHOG_KEY;') },
            { path: 'lib/db.ts', code: code("export const { DATABASE_URL, DB_POOL_SIZE = '10' } = process\u002eenv;") },
          ],
          reads: [
            { name: 'STRIPE_SECRET_KEY', file: 'app/api/checkout/route.ts', line: 3 },
            { name: 'STRIPE_WEBHOOK_SECRET', file: 'app/api/checkout/route.ts', line: 4 },
            { name: 'NEXT_PUBLIC_POSTHOG_KEY', file: 'app/providers.tsx', line: 3 },
            { name: 'DATABASE_URL', file: 'lib/db.ts', line: 1 },
            { name: 'DB_POOL_SIZE', file: 'lib/db.ts', line: 1, optional: true },
          ],
          missing: ['STRIPE_WEBHOOK_SECRET'],
          unused: [],
          note: 'In a monorepo, each directory with its own env files (say `apps/web`) is checked against its own `.env.example`.',
        },
      ],
    },
    {
      id: 'defaults',
      heading: 'Defaults and OPTIONAL',
      paragraphs: [
        'A read with a fallback on the same line, `?? "x"` or `|| "x"` (or a default in destructuring), can’t be MISSING: when no env file declares it, the scan lists it as OPTIONAL instead (`--show-optional` prints each one). A fallback of `undefined` or `null` isn’t a default.',
      ],
      examples: [
        {
          id: 'nextjs-defaults',
          caption: 'Three fallbacks, one of which isn’t:',
          files: [
            { path: '.env.example', code: code('NEXT_PUBLIC_SITE_URL=') },
            {
              path: 'lib/config.ts',
              code: code(
                'export const config = {',
                '  siteUrl: process\u002eenv.NEXT_PUBLIC_SITE_URL,',
                "  region: process\u002eenv.AWS_REGION ?? 'us-east-1',",
                "  logLevel: process\u002eenv.LOG_LEVEL || 'info',",
                '  sentryDsn: process\u002eenv.SENTRY_DSN ?? undefined,',
                '};',
              ),
            },
          ],
          reads: [
            { name: 'NEXT_PUBLIC_SITE_URL', file: 'lib/config.ts', line: 2 },
            { name: 'AWS_REGION', file: 'lib/config.ts', line: 3, optional: true },
            { name: 'LOG_LEVEL', file: 'lib/config.ts', line: 4, optional: true },
            { name: 'SENTRY_DSN', file: 'lib/config.ts', line: 5 },
          ],
          missing: ['SENTRY_DSN'],
          unused: [],
        },
      ],
    },
    {
      id: 'skips',
      heading: 'What it skips',
      items: [
        'build output and vendored code: `node_modules/`, `.next/`, `out/`, `dist/`, `.vercel/`, `.turbo/`, `coverage/` and the like, minified `*.min.js` files, and any source file over 512 KB',
        'tests and test tooling: `*.test.*`, `*.spec.*`, `__tests__/`, `e2e/`, `playwright/`, `cypress/`, `__mocks__/` and runner configs (`--include-tests` reads them)',
        'names the platform provides: `NODE_ENV`, `NEXT_RUNTIME`, `CI`, `VERCEL_*`, `NEXT_PUBLIC_VERCEL_*` and GitHub Actions’ own variables (`--no-default-ignore` checks them too)',
      ],
      examples: [
        {
          id: 'nextjs-skips',
          caption: 'Only the read in lib/ counts here:',
          files: [
            { path: '.env.example', code: code('DATABASE_URL=') },
            { path: '.next/server/chunks/app.js', code: code('const id = process\u002eenv.BUILD_CACHE_ID;') },
            { path: 'app/page.test.tsx', code: code('const token = process\u002eenv.TEST_ONLY_TOKEN;') },
            { path: 'lib/db.ts', code: code('export const url = process\u002eenv.DATABASE_URL;') },
            {
              path: 'middleware.ts',
              code: code("export const isProd = process\u002eenv.NODE_ENV === 'production';", 'export const preview = process\u002eenv.VERCEL_URL;'),
            },
          ],
          reads: [{ name: 'DATABASE_URL', file: 'lib/db.ts', line: 1 }],
          missing: [],
          unused: [],
          note: 'The CLI still reads test files to see which declared variables they use, so a variable only tests read isn’t reported UNUSED.',
        },
      ],
    },
    {
      id: 'limits',
      heading: 'Known limits',
      items: [
        'A read split across lines, or with a computed name (`process\u002eenv[key]`), isn’t seen.',
        'A variable set only in your hosting platform’s settings is MISSING until an env file declares it: list it in `.env.example`, with an empty value.',
        'MISMATCH compares `.env` with `.env.example` only; `.env.local` and `.env.production` count as declaring a variable, but aren’t compared.',
      ],
      examples: [
        {
          id: 'nextjs-dynamic',
          caption: 'A computed name reads nothing:',
          files: [{ path: 'lib/flags.ts', code: code('export const flag = (key: string) => process\u002eenv[key];') }],
          reads: [],
          missing: [],
          unused: [],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Laravel
// ---------------------------------------------------------------------------------------------

const laravel: StackDoc = {
  slug: 'laravel',
  stack: 'Laravel',
  title: 'Catch missing env vars in Laravel · deployhealth',
  description:
    'Find env() reads your Laravel app makes that .env.example doesn’t declare, on every pull request: read forms, defaults, framework names, skips and limits.',
  h1: 'How to catch a missing env var in Laravel before it reaches production',
  intro: [
    '`env(\'STRIPE_SECRET\')` returns `null` when the variable isn’t set, so a Laravel app usually boots without it and fails later, on the request that needs it, or after `php artisan config:cache` bakes the `null` in.',
    'deployhealth compares the variables your code and config read with the ones your env files declare, on every pull request and every push, and names each gap with its file and line. It reads names and line numbers only, never values.',
  ],
  sections: [
    {
      id: 'reads',
      heading: 'What deployhealth reads in a Laravel app',
      paragraphs: ['In `.php` files, Blade templates included, on one line each:'],
      items: [
        '`env(\'NAME\')` and `\\env(\'NAME\')`, but not `->env()`, `::env()` or `$env()`',
        '`Env::get(\'NAME\')`',
        '`getenv(\'NAME\')` (a second argument is getenv’s local-only flag, not a default)',
        '`$_ENV[\'NAME\']`',
        '`$_SERVER[\'NAME\']` only marks a declared name as used: it holds request data too, so it’s never a read or MISSING',
      ],
      examples: [
        {
          id: 'laravel-reads',
          caption: 'A config file and a service class, with a .env.example that declares three variables:',
          files: [
            { path: '.env.example', code: code('APP_KEY=', 'STRIPE_KEY=', 'STRIPE_SECRET=') },
            { path: 'app/Services/Maps.php', code: code('<?php', '', 'namespace App\\Services;', '', 'use Illuminate\\Support\\Env;', '', 'class Maps', '{', "    public string $key;", '', '    public function __construct()', '    {', "        $this->key = Env::get('MAPS_API_KEY');", '    }', '}') },
            { path: 'artisan', code: code('#!/usr/bin/env php', '<?php') },
            {
              path: 'config/services.php',
              code: code(
                '<?php',
                '',
                'return [',
                "    'stripe' => [",
                "        'key' => env('STRIPE_KEY'),",
                "        'secret' => env('STRIPE_SECRET'),",
                "        'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),",
                '    ],',
                '];',
              ),
            },
          ],
          reads: [
            { name: 'MAPS_API_KEY', file: 'app/Services/Maps.php', line: 13 },
            { name: 'STRIPE_KEY', file: 'config/services.php', line: 5 },
            { name: 'STRIPE_SECRET', file: 'config/services.php', line: 6 },
            { name: 'STRIPE_WEBHOOK_SECRET', file: 'config/services.php', line: 7 },
          ],
          missing: ['MAPS_API_KEY', 'STRIPE_WEBHOOK_SECRET'],
          unused: [],
          note: '`APP_KEY` isn’t UNUSED though nothing here reads it: in a directory with an `artisan` file, Laravel’s own names count as used (below).',
        },
      ],
    },
    {
      id: 'defaults',
      heading: 'Defaults, OPTIONAL and Laravel’s own variables',
      paragraphs: [
        'A default on the same line means the read can’t be MISSING; when no env file declares it, the scan lists it as OPTIONAL. Defaults are `env(\'NAME\', \'x\')`, `Env::get(\'NAME\', \'x\')`, `env(\'NAME\') ?? \'x\'` or `?: \'x\'`, `getenv(\'NAME\') ?: \'x\'` (not `??`: getenv returns false) and `$_ENV[\'NAME\'] ?? \'x\'`. `null` isn’t a default, and neither is `?: throw …`.',
        'In a directory with an `artisan` file, the variables Laravel’s framework and skeleton config read (`DB_URL`, `REDIS_HOST`, `MAIL_MAILER` and the rest of that list) are never MISSING and never UNUSED: Laravel reads them with `null` meaning “not set”. `APP_KEY` is the exception, because Laravel won’t boot without it.',
      ],
      examples: [
        {
          id: 'laravel-defaults',
          caption: 'Defaults, a framework name and APP_KEY, with an empty .env.example:',
          files: [
            { path: '.env.example', code: code('# Copy to .env and fill in.') },
            { path: 'artisan', code: code('#!/usr/bin/env php', '<?php') },
            {
              path: 'config/app.php',
              code: code(
                '<?php',
                '',
                'return [',
                "    'key' => env('APP_KEY'),",
                "    'timezone' => env('APP_TIMEZONE', 'UTC'),",
                "    'maps_key' => env('MAPS_API_KEY') ?? null,",
                "    'region' => getenv('AWS_REGION') ?: 'eu-west-1',",
                "    'database_url' => env('DB_URL'),",
                '];',
              ),
            },
          ],
          reads: [
            { name: 'APP_KEY', file: 'config/app.php', line: 4 },
            { name: 'APP_TIMEZONE', file: 'config/app.php', line: 5, optional: true },
            { name: 'MAPS_API_KEY', file: 'config/app.php', line: 6 },
            { name: 'AWS_REGION', file: 'config/app.php', line: 7, optional: true },
            { name: 'DB_URL', file: 'config/app.php', line: 8, optional: true },
          ],
          missing: ['APP_KEY', 'MAPS_API_KEY'],
          unused: [],
        },
      ],
    },
    {
      id: 'skips',
      heading: 'What it skips',
      items: [
        '`vendor/`, and beside `artisan`: `storage/`, `bootstrap/cache/` and `public/build/`. Laravel’s cached config can hold values, so those are never opened.',
        'tests and test tooling: `tests/`, `*Test.php`, `phpunit.xml` and `.phpunit.cache` (`--include-tests` reads the tests)',
        'names the platform provides, such as `CI` and GitHub Actions’ own variables (`--no-default-ignore` checks them too)',
      ],
      examples: [
        {
          id: 'laravel-skips',
          caption: 'Only the read in config/ counts here:',
          files: [
            { path: '.env.example', code: code('STRIPE_KEY=') },
            { path: 'artisan', code: code('#!/usr/bin/env php', '<?php') },
            { path: 'bootstrap/cache/config.php', code: code('<?php', "return ['key' => env('CACHED_ONLY')];") },
            { path: 'config/services.php', code: code('<?php', "return ['stripe' => env('STRIPE_KEY')];") },
            { path: 'tests/Feature/CheckoutTest.php', code: code('<?php', "$token = env('TEST_ONLY_TOKEN');") },
            { path: 'vendor/acme/sdk/src/Client.php', code: code('<?php', "$key = getenv('VENDOR_KEY');") },
          ],
          reads: [{ name: 'STRIPE_KEY', file: 'config/services.php', line: 2 }],
          missing: [],
          unused: [],
        },
      ],
    },
    {
      id: 'limits',
      heading: 'Known limits',
      items: [
        'A call split across lines, or with a computed name (`env($name)`), isn’t seen.',
        '`%env()%` is read in Symfony’s `config/**/*.yaml`, but not in PHP or XML config.',
        'A name only a Composer package’s unpublished config reads shows as UNUSED: deployhealth doesn’t read `vendor/`. Leave it out of the report with `--ignore NAME`.',
      ],
      examples: [
        {
          id: 'laravel-dynamic',
          caption: 'A computed name reads nothing:',
          files: [{ path: 'app/Support/Flags.php', code: code('<?php', '', 'function flag(string $name): ?string', '{', '    return env($name);', '}') }],
          reads: [],
          missing: [],
          unused: [],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Spring Boot
// ---------------------------------------------------------------------------------------------

const springBoot: StackDoc = {
  slug: 'spring-boot',
  stack: 'Spring Boot',
  title: 'Catch missing env vars in Spring Boot · deployhealth',
  description:
    'Find ${VAR} placeholders and System.getenv reads in your Spring Boot app that .env.example doesn’t declare, on every pull request. Defaults, skips, limits.',
  h1: 'How to catch a missing env var in Spring Boot before it reaches production',
  intro: [
    'Spring Boot refuses to start when a `${DATABASE_URL}` placeholder has no value, but only on the machine that’s missing it, and that’s often production.',
    'deployhealth compares the variables your code and `application.yml` read with the ones your env files declare, on every pull request and every push, and names each gap with its file and line. It reads names and line numbers only, never values.',
  ],
  sections: [
    {
      id: 'reads',
      heading: 'What deployhealth reads in a Spring Boot app',
      paragraphs: ['In `.java`, `.kt` and `.kts` files, and in `application*` and `bootstrap*` `.properties`, `.yml` and `.yaml` files at any depth, on one line each:'],
      items: [
        '`${NAME}` placeholders in that config, for UPPER_SNAKE names only (`${server.port}` is a property, not an env var)',
        '`@Value("${NAME}")` in Java, and `@Value("\\${NAME}")` in Kotlin (a bare `${…}` is Kotlin string interpolation)',
        '`System.getenv("NAME")`, `System.getenv().get("NAME")` and Kotlin’s `System.getenv()["NAME"]`',
      ],
      examples: [
        {
          id: 'spring-reads',
          caption: 'Config, a Java class and a Kotlin one, with a .env.example that declares three variables:',
          files: [
            { path: '.env.example', code: code('DATABASE_URL=', 'DB_PASSWORD=', 'STRIPE_API_KEY=') },
            {
              path: 'src/main/java/com/acme/billing/StripeConfig.java',
              code: code(
                'package com.acme.billing;',
                '',
                'import org.springframework.beans.factory.annotation.Value;',
                'import org.springframework.context.annotation.Configuration;',
                '',
                '@Configuration',
                'public class StripeConfig {',
                '    @Value("${STRIPE_API_KEY}") private String apiKey;',
                '',
                '    private final String redisUrl = System.getenv("REDIS_URL");',
                '}',
              ),
            },
            {
              path: 'src/main/kotlin/com/acme/Search.kt',
              code: code('package com.acme', '', 'val searchUrl: String? = System.getenv()["SEARCH_URL"]'),
            },
            {
              path: 'src/main/resources/application.yml',
              code: code('spring:', '  datasource:', '    url: ${DATABASE_URL}', '    password: ${DB_PASSWORD}'),
            },
          ],
          reads: [
            { name: 'STRIPE_API_KEY', file: 'src/main/java/com/acme/billing/StripeConfig.java', line: 8 },
            { name: 'REDIS_URL', file: 'src/main/java/com/acme/billing/StripeConfig.java', line: 10 },
            { name: 'SEARCH_URL', file: 'src/main/kotlin/com/acme/Search.kt', line: 3 },
            { name: 'DATABASE_URL', file: 'src/main/resources/application.yml', line: 3 },
            { name: 'DB_PASSWORD', file: 'src/main/resources/application.yml', line: 4 },
          ],
          missing: ['REDIS_URL', 'SEARCH_URL'],
          unused: [],
        },
      ],
    },
    {
      id: 'defaults',
      heading: 'Defaults, OPTIONAL and relaxed binding',
      paragraphs: [
        'A default means the read can’t be MISSING; when no env file declares it, the scan lists it as OPTIONAL. Defaults are `${NAME:default}` (and a placeholder inside another’s default), `System.getenv().getOrDefault("NAME", "x")`, Kotlin’s `?: "x"` and `Optional.ofNullable(…).orElse("x")` on the same line. `null` isn’t a default, and neither are `?: throw`, `error(…)` or `requireNotNull`.',
        'Spring also binds env vars to properties without a placeholder (relaxed binding). In a directory where some Java or Kotlin source mentions `org.springframework`, a declared name counts as used, never UNUSED, when it’s the env form of a key your config sets (`cache.ttl-seconds` → `CACHE_TTLSECONDS`), starts with `SPRING_`, `SERVER_`, `MANAGEMENT_` or `LOGGING_`, or starts with the env form of a `@ConfigurationProperties` prefix. Those are never reads, so they’re never MISSING either.',
      ],
      examples: [
        {
          id: 'spring-defaults',
          caption: 'Defaults and relaxed binding together; only OLD_FEATURE_FLAG is reported:',
          files: [
            { path: '.env.example', code: code('APP_MAIL_HOST=', 'CACHE_TTLSECONDS=', 'OLD_FEATURE_FLAG=', 'SPRING_PROFILES_ACTIVE=') },
            {
              path: 'src/main/java/com/acme/mail/MailProperties.java',
              code: code(
                'package com.acme.mail;',
                '',
                'import org.springframework.boot.context.properties.ConfigurationProperties;',
                '',
                '@ConfigurationProperties(prefix = "app.mail")',
                'public record MailProperties(String host, String from) {',
                '    static final String REGION = System.getenv().getOrDefault("MAIL_REGION", "eu");',
                '}',
              ),
            },
            {
              path: 'src/main/kotlin/com/acme/Logging.kt',
              code: code('package com.acme', '', 'val logLevel: String = System.getenv("LOG_LEVEL") ?: "info"'),
            },
            {
              path: 'src/main/resources/application.yml',
              code: code('app:', '  mail:', '    from: ${MAIL_FROM:noreply@acme.example}', 'cache:', '  ttl-seconds: 300'),
            },
          ],
          reads: [
            { name: 'MAIL_REGION', file: 'src/main/java/com/acme/mail/MailProperties.java', line: 7, optional: true },
            { name: 'LOG_LEVEL', file: 'src/main/kotlin/com/acme/Logging.kt', line: 3, optional: true },
            { name: 'MAIL_FROM', file: 'src/main/resources/application.yml', line: 3, optional: true },
          ],
          missing: [],
          unused: ['OLD_FEATURE_FLAG'],
        },
      ],
    },
    {
      id: 'skips',
      heading: 'What it skips',
      items: [
        'build output: `target/` beside a `pom.xml` or Gradle build file, `build/` beside a Gradle build file, and `.gradle/` and `.mvn/` anywhere',
        'tests and test tooling: `src/test/`, `*Test.java`, `*Tests.kt`, `*IT.java`, `application-test.yml` (`--include-tests` reads them)',
        'Gradle’s `*.gradle.kts` build scripts: their env reads are CI and publishing secrets that don’t belong in `.env.example`',
      ],
      examples: [
        {
          id: 'spring-skips',
          caption: 'Only the placeholder in application.yml counts here:',
          files: [
            { path: '.env.example', code: code('DATABASE_URL=') },
            { path: 'build.gradle.kts', code: code('val signingKey: String? = System.getenv("SIGNING_KEY")') },
            {
              path: 'build/generated/Config.java',
              code: code('import org.springframework.context.annotation.Configuration;', 'class Generated { String url = System.getenv("GENERATED_URL"); }'),
            },
            { path: 'src/main/resources/application.yml', code: code('spring:', '  datasource:', '    url: ${DATABASE_URL}') },
            { path: 'src/test/resources/application-test.yml', code: code('spring:', '  datasource:', '    url: ${TEST_DATABASE_URL}') },
          ],
          reads: [{ name: 'DATABASE_URL', file: 'src/main/resources/application.yml', line: 3 }],
          missing: [],
          unused: [],
        },
      ],
    },
    {
      id: 'limits',
      heading: 'Known limits',
      items: [
        'A placeholder or read split across lines, or a computed name (`System.getenv(name)`), isn’t seen.',
        'Properties set only on the platform, profiles activated only there, a `@ConfigurationProperties` prefix held in a constant, and keys inside YAML list items aren’t known to relaxed binding.',
        'Rule (b) of relaxed binding can hide a genuinely unused `SERVER_…` name. Groovy’s `build.gradle` isn’t read.',
      ],
      examples: [
        {
          id: 'spring-dynamic',
          caption: 'A computed name reads nothing:',
          files: [
            {
              path: 'src/main/java/com/acme/Flags.java',
              code: code('package com.acme;', '', 'class Flags {', '    static String flag(String name) { return System.getenv(name); }', '}'),
            },
          ],
          reads: [],
          missing: [],
          unused: [],
        },
      ],
    },
  ],
};

export const STACK_DOCS: Readonly<Record<DocsSlug, StackDoc>> = { nextjs, laravel, 'spring-boot': springBoot };

/** /docs: what deployhealth checks, the languages, and the three stack pages. */
export const DOCS_INDEX = {
  title: 'Docs: catch missing env vars early · deployhealth',
  description:
    'How deployhealth catches env vars your code reads that .env.example doesn’t declare, for Next.js, Laravel and Spring Boot: read forms, defaults, limits.',
  h1: 'Catch missing env vars before they reach production',
  intro: [
    'deployhealth compares the variables your code reads with the ones your env files declare. On every pull request, the GitHub App comments when the change reads an env var no `.env.example` declares; on every push, the scan records MISSING, UNUSED and MISMATCH per deploy, so an alert can name the deploy that broke things.',
    'It reports names, file paths and line numbers only, never values.',
  ],
} as const;
