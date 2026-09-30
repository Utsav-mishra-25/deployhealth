export const config = {
  apiKey: process.env.API_KEY,
  db: process.env.PROD_DB_URL,
  devToken: process.env.DEV_TOKEN,
  oauthSecret: process.env.GITHUB_CLIENT_SECRET,
  host: process.env.VERCEL_URL,
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  missing: process.env.MISSING_ONE,
};
