#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function showHelp() {
  console.log(`
Usage:
  node scripts/runtime-smoke.js <command>

Commands:
  docker  Build the local Docker image and verify the container CLI entrypoint.
  help    Show this help text.
`.trim());
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function runCommand(command, args) {
  console.log(`> ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.error) {
    throw result.error;
  }

  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (combinedOutput) {
    console.log(combinedOutput);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${formatCommand(command, args)}`);
  }

  return combinedOutput;
}

function assertHelpOutput(output, label) {
  const expectedTokens = ['src/cli.js run', 'help', 'SELENIUM_URL'];
  const missing = expectedTokens.filter((token) => !output.includes(token));
  if (missing.length > 0) {
    throw new Error(`${label} output is missing: ${missing.join(', ')}`);
  }
}

function runDockerSmoke() {
  const imageTag = `weread-runtime-smoke:${Date.now()}`;

  try {
    runCommand('docker', ['build', '-t', imageTag, '.']);
    const helpOutput = runCommand('docker', ['run', '--rm', imageTag, 'node', 'src/cli.js', 'help']);
    assertHelpOutput(helpOutput, 'docker run <image> node src/cli.js help');
    console.log('Smoke passed: Docker image entrypoint is runnable.');
  } finally {
    spawnSync('docker', ['image', 'rm', '-f', imageTag], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }
}

function main() {
  const command = process.argv[2] || 'help';

  switch (command) {
    case 'help':
      showHelp();
      return;
    case 'docker':
      runDockerSmoke();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
