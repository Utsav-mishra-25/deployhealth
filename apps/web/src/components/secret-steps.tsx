import { SECRET_STEPS } from '@/lib/setup-copy';

/** Where to save the ingest token in GitHub. No hooks or state: renders on the server or in a client form. */
export function SecretSteps({ repo }: { repo?: string }) {
  return (
    <div className="mt-2 space-y-1 text-gray-600" data-testid="secret-steps">
      <p>
        In {repo ? <strong className="break-all">{repo}</strong> : 'the repository'}: <em>{SECRET_STEPS.path.join(' → ')}</em>, named{' '}
        <code className="font-mono font-semibold">{SECRET_STEPS.name}</code>.
      </p>
      <p>{SECRET_STEPS.notVariable}</p>
      <p>{SECRET_STEPS.notEnvironment}</p>
    </div>
  );
}
