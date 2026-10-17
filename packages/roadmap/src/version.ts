import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const PACKAGE_VERSION: string = require('../package.json').version as string;
