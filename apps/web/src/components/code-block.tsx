import { CopyButton } from './copy-button';

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-950">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <span className="font-mono text-xs text-gray-400">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
