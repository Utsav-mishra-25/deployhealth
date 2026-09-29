/**
 * Where a view's links point. The signed-in app and the public demo render the same views; only
 * the paths (and read-only mode) differ.
 */
export interface ViewPaths {
  clients: string;
  client: (slug: string) => string;
  project: (id: string) => string;
}

export const APP_PATHS: ViewPaths = {
  clients: '/clients',
  client: (slug) => `/clients/${slug}`,
  project: (id) => `/projects/${id}`,
};

export const DEMO_PATHS: ViewPaths = {
  clients: '/demo',
  client: (slug) => `/demo/clients/${slug}`,
  project: (id) => `/demo/projects/${id}`,
};
