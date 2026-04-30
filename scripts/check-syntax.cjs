#!/usr/bin/env node
const { readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const includeDirs = ['bin', 'lib', 'lambda', 'scripts'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'cdk.out' || entry === '.git')
        continue;
      walk(fullPath);
      continue;
    }

    if (/\.(js|cjs|mjs)$/.test(entry)) files.push(fullPath);
  }
}

for (const dir of includeDirs) walk(join(root, dir));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${relative(root, file)}`);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
