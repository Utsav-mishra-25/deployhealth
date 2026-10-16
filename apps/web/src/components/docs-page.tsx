import Link from 'next/link';
import { Fragment } from 'react';
import {
  ACTION_URL,
  ACTION_WORKFLOW,
  DOCS_SLUGS,
  DRY_RUN_COMMAND,
  PINNED_NPX,
  STACK_DOCS,
  type DocsExample,
  type DocsSection,
  type StackDoc,
} from '@/lib/docs-pages';
import { Breadcrumb } from './breadcrumb';
import { CodeBlock } from './code-block';

// The /docs pages: static server components rendered from lib/docs-pages.ts, no user data.

/** Prose with `backticks` as inline code. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] break-words text-gray-900">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function FileView({ path, code }: { path: string; code: string }) {
  return (
    <figure className="overflow-hidden rounded-lg border border-gray-200 bg-gray-950">
      <figcaption className="border-b border-gray-800 px-3 py-1.5 font-mono text-xs break-all text-gray-300">{path}</figcaption>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** An example's files, then what deployhealth reports for them: the reads, MISSING and UNUSED. */
export function ExampleView({ example }: { example: DocsExample }) {
  return (
    <div className="space-y-3" data-testid="docs-example" data-example={example.id}>
      <p className="text-sm text-gray-700">
        <Prose text={example.caption} />
      </p>
      <div className="space-y-2">
        {example.files.map((file) => (
          <FileView key={file.path} path={file.path} code={file.code} />
        ))}
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="docs-result">
        <p className="font-medium text-gray-900">What deployhealth reports</p>
        {example.reads.length === 0 ? (
          <p className="mt-1 text-gray-700">No reads.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {example.reads.map((read) => (
              <li key={`${read.name}:${read.file}:${read.line}`} className="break-words text-gray-700">
                <code className="font-mono text-gray-900">{read.name}</code>{' '}
                <span className="font-mono text-xs break-all text-gray-600">
                  {read.file}:{read.line}
                </span>{' '}
                · {read.optional ? 'optional (has a default)' : 'required'}
              </li>
            ))}
          </ul>
        )}
        {(example.missing.length > 0 || example.unused.length > 0) && (
          <p className="mt-2 text-gray-700">
            {example.missing.length > 0 && (
              <>
                <span className="font-semibold text-red-700">MISSING</span> {example.missing.join(', ')}
              </>
            )}
            {example.missing.length > 0 && example.unused.length > 0 && ' · '}
            {example.unused.length > 0 && (
              <>
                <span className="font-semibold text-amber-800">UNUSED</span> {example.unused.join(', ')}
              </>
            )}
          </p>
        )}
      </div>
      {example.note && (
        <p className="text-sm text-gray-600">
          <Prose text={example.note} />
        </p>
      )}
    </div>
  );
}

function SectionView({ section }: { section: DocsSection }) {
  return (
    <section aria-labelledby={section.id} className="space-y-4">
      <h2 id={section.id} className="text-lg font-semibold">
        {section.heading}
      </h2>
      {section.paragraphs?.map((p) => (
        <p key={p} className="text-sm leading-relaxed text-gray-700">
          <Prose text={p} />
        </p>
      ))}
      {section.items && (
        <ul className="space-y-1 text-sm leading-relaxed text-gray-700">
          {section.items.map((item) => (
            <li key={item} className="ml-5 list-disc">
              <Prose text={item} />
            </li>
          ))}
        </ul>
      )}
      {section.examples?.map((example) => (
        <ExampleView key={example.id} example={example} />
      ))}
    </section>
  );
}

/** How to turn it on, in the app's setup order: the App for pull requests (no token), then optionally the Action or the pinned CLI for deploys. */
export function SetupSection() {
  return (
    <section aria-labelledby="setup" className="space-y-4">
      <h2 id="setup" className="text-lg font-semibold">
        Set it up
      </h2>
      <div className="space-y-2 text-sm leading-relaxed text-gray-700">
        <h3 className="font-semibold text-gray-900">Pull request checks (GitHub App)</h3>
        <p>
          <Link href="/login" className="text-emerald-700 underline">
            Sign in with GitHub
          </Link>
          , install the deployhealth GitHub App on the repository (the first step of the checklist you see after signing in) and add
          a project for it (<Prose text="`owner/repo`" />). Every pull request that reads an env var no <Prose text="`.env.example`" />{' '}
          declares gets a comment and a check. No token, no secret, no workflow.
        </p>
      </div>
      <div className="space-y-2 text-sm leading-relaxed text-gray-700">
        <h3 className="font-semibold text-gray-900">Optional: deploy history (GitHub Action)</h3>
        <p>
          For deploy history and alerts that name the deploy, scan every push: in the project&apos;s settings, create its token and
          save it as the repository secret <Prose text="`DEPLOYHEALTH_TOKEN`" /> (a secret, not a variable). The settings page gives
          you a workflow that runs the CLI pinned to an exact version, <Prose text={`\`${PINNED_NPX}\``} />, which you can also run
          from any other CI.
        </p>
        <p>
          Or use the{' '}
          <a href={ACTION_URL} className="text-emerald-700 underline">
            deployhealth env check
          </a>{' '}
          Action:
        </p>
      </div>
      <CodeBlock code={ACTION_WORKFLOW} label=".github/workflows/deployhealth.yml" />
      <p className="text-sm text-gray-600">
        <Prose text="`@v1` follows the latest 1.x release and can move; pin a full commit SHA if you want it fixed. An npm version never changes once published." />
      </p>
    </section>
  );
}

/** The no-signup line. */
export function TryItSection() {
  return (
    <section aria-labelledby="try-it" className="space-y-3">
      <h2 id="try-it" className="text-lg font-semibold">
        Try it now, without signing up
      </h2>
      <p className="text-sm leading-relaxed text-gray-700">
        From your repository&apos;s root. It prints MISSING, UNUSED and MISMATCH with file and line in your terminal, and
        sends nothing:
      </p>
      <CodeBlock code={DRY_RUN_COMMAND} label="terminal" />
    </section>
  );
}

/** Links to the stack pages (all, or all but the current one). */
export function StackLinks({ except }: { except?: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-3">
      {DOCS_SLUGS.filter((slug) => slug !== except).map((slug) => {
        const doc = STACK_DOCS[slug];
        return (
          <li key={slug}>
            <Link href={`/docs/${slug}`} className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-emerald-700">
              <span className="font-semibold text-gray-900">{doc.stack}</span>
              <span className="mt-1 block text-sm text-gray-600">Catch a missing env var in {doc.stack}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function StackDocView({ doc }: { doc: StackDoc }) {
  return (
    <article className="mx-auto max-w-3xl space-y-10" data-testid="docs-page" data-stack={doc.slug}>
      <header className="space-y-4">
        <Breadcrumb items={[{ label: 'Docs', href: '/docs' }, { label: doc.stack }]} />
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{doc.h1}</h1>
        {doc.intro.map((p) => (
          <p key={p} className="leading-relaxed text-gray-700">
            <Prose text={p} />
          </p>
        ))}
      </header>
      {doc.sections.map((section) => (
        <SectionView key={section.id} section={section} />
      ))}
      <SetupSection />
      <TryItSection />
      <section aria-labelledby="other-stacks" className="space-y-3">
        <h2 id="other-stacks" className="text-lg font-semibold">
          Other stacks
        </h2>
        <StackLinks except={doc.slug} />
      </section>
    </article>
  );
}
