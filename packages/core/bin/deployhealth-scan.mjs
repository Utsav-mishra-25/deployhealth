#!/usr/bin/env node
// Committed launcher so pnpm can link the bin before the bundle exists (run `pnpm build` first).
import '../dist/deployhealth-scan.mjs';
