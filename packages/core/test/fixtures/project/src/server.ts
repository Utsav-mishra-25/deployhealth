const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env["API_KEY"];
const port = process.env['PORT'];
const logLevel = process.env?.LOG_LEVEL;
const region = process.env[`AWS_REGION`];
const mode = process.env.NODE_ENV;
export const config = { databaseUrl, apiKey, port, logLevel, region, mode };
