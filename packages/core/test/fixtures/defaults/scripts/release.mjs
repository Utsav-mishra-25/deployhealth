const channel = process.env.RELEASE_CHANNEL ?? 'stable';
const token = process.env.RELEASE_TOKEN;
const sha = process.env.GITHUB_SHA;
const version = process.env.npm_package_version;
export { channel, token, sha, version };
