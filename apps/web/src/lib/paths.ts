/**
 * Where a view's links point. The signed-in app and the public demo render the same views; only
 * the paths (and read-only mode) differ.
 */
export interface ViewPaths {
  clients: string;
  client: (slug: string) => string;
  project: (id: string) => string;
  handoff: (id: string) => string;
  handoffMarkdown: (id: string) => string;
  /** A client's monthly report; `month` is "YYYY-MM" (omitted: the current month). */
  clientReport: (slug: string, month?: string) => string;
}

export const APP_PATHS: ViewPaths = {
  clients: '/clients',
  client: (slug) => `/clients/${slug}`,
  project: (id) => `/projects/${id}`,
  handoff: (id) => `/projects/${id}/handoff`,
  handoffMarkdown: (id) => `/projects/${id}/handoff.md`,
  clientReport: (slug, month) => `/clients/${slug}/report${month ? `?month=${month}` : ''}`,
};

export const DEMO_PATHS: ViewPaths = {
  clients: '/demo',
  client: (slug) => `/demo/clients/${slug}`,
  project: (id) => `/demo/projects/${id}`,
  handoff: (id) => `/demo/projects/${id}/handoff`,
  handoffMarkdown: (id) => `/demo/projects/${id}/handoff.md`,
  clientReport: (slug, month) => `/demo/clients/${slug}/report${month ? `?month=${month}` : ''}`,
};
