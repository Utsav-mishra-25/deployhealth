import { Fragment } from 'react';

export interface SectionLink {
  /** The section's id on the page. */
  id: string;
  label: string;
}

/**
 * The project page's sections, in page order (findings, deploys, pull requests, endpoints): only
 * those it renders. Findings and deploys need a scan; pull requests need checks, or checks on.
 */
export function projectSectionLinks({ scanned, prChecks }: { scanned: boolean; prChecks: boolean }): SectionLink[] {
  return [
    ...(scanned
      ? [
          { id: 'findings', label: 'Findings' },
          { id: 'deploys', label: 'Deploys' },
        ]
      : []),
    ...(prChecks ? [{ id: 'pull-requests', label: 'Pull requests' }] : []),
    { id: 'endpoints', label: 'Endpoints' },
  ];
}

/** "Findings · Deploys · Pull requests · Endpoints": links to the page's sections, in page order; none for fewer than two. */
export function SectionLinks({ links }: { links: SectionLink[] }) {
  if (links.length < 2) return null;
  return (
    <nav aria-label="On this page" className="text-sm text-gray-500 print:hidden" data-testid="section-links">
      {links.map((link, i) => (
        <Fragment key={link.id}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <a href={`#${link.id}`} className="font-medium text-emerald-700 hover:underline">
            {link.label}
          </a>
        </Fragment>
      ))}
    </nav>
  );
}
