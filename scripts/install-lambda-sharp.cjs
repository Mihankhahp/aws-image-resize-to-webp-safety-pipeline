#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error(
    'Usage: node scripts/install-lambda-sharp.cjs <lambda-asset-output-dir>',
  );
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

// The handler is bundled as CommonJS. This file must exist after npm install too,
// otherwise a copied root package.json with "type":"module" can make Lambda treat
// index.js as ESM and crash on module.exports.
function writeCommonJsPackage() {
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
    JSON.stringify(
      { ...existingPkg, private: true, type: 'commonjs' },
      null,
      2,
    ),
  );
}

writeCommonJsPackage();

console.log(`Installing Lambda-compatible sharp into ${outputDir}`);

const npmArgs = [
  'install',
  'sharp@0.33.5',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  '--include=optional',
  '--os=linux',
  '--cpu=x64',
  '--libc=glibc',
];

try {
  if (process.platform === 'win32') {
    // Avoid spawnSync npm.cmd issues on Windows by going through cmd.exe and cwd.
    execFileSync('cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`], {
      cwd: outputDir,
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    execFileSync('npm', npmArgs, { cwd: outputDir, stdio: 'inherit' });
  }

  // Re-write after npm install because npm may modify package.json.
  writeCommonJsPackage();
} catch (error) {
  console.error('\nFailed to install sharp for Lambda.');
  console.error('Make sure Node.js 22 and npm are installed, then retry:');
  console.error(
    '  Remove-Item -Recurse -Force cdk.out -ErrorAction SilentlyContinue',
  );
  console.error('  npm install');
  console.error('  npx cdk synth');
  throw error;
}
