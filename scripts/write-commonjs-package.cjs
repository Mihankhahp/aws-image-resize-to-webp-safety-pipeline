#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error(
    'Usage: node scripts/write-commonjs-package.cjs <lambda-asset-output-dir>',
  );
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
const pkgPath = path.join(outputDir, 'package.json');
let existingPkg = {};
if (fs.existsSync(pkgPath)) {
  try {
    existingPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    existingPkg = {};
  }
}

fs.writeFileSync(
  pkgPath,
  JSON.stringify({ ...existingPkg, private: true, type: 'commonjs' }, null, 2),
);
