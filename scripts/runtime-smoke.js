#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const HEALTH_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 5000;

function showHelp() {
  console.log(`
Usage:
  node scripts/runtime-smoke.js <command>

Commands:
  docker  Build the local Docker image and verify the CLI, the panel health check,
          the non-root user and the data directory ownership.
  help    Show this help text.

Environment:
  RUNTIME_SMOKE_IMAGE  Use an existing image instead of building one (it is not removed afterwards).
  RUNTIME_SMOKE_ARCH   Expected image architecture, e.g. arm64; the image and the Node.js process
                       inside the container must both report it (an arm64 image runs under QEMU on amd64).
`.trim());
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function runCommand(command, args, { quiet = false } = {}) {
  if (!quiet) {
    console.log(`> ${formatCommand(command, args)}`);
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.error) {
    throw result.error;
  }

  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (combinedOutput && !quiet) {
    console.log(combinedOutput);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${formatCommand(command, args)}\n${combinedOutput}`);
  }

  return combinedOutput;
}

function assertHelpOutput(output, label) {
  const expectedTokens = ['src/cli.js run', 'help', 'SELENIUM_URL', 'PANEL_PORT'];
  const missing = expectedTokens.filter((token) => !output.includes(token));
  if (missing.length > 0) {
    throw new Error(`${label} output is missing: ${missing.join(', ')}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForHealthy(container) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let status = '';
  while (Date.now() < deadline) {
    status = runCommand('docker', ['inspect', '-f', '{{.State.Health.Status}}', container], { quiet: true });
    if (status === 'healthy') {
      return;
    }
    sleep(1000);
  }
  throw new Error(`Container did not become healthy (last status: ${status})`);
}

// 用 root 属主的数据目录启动面板容器，检查健康状态、运行用户、数据文件属主、初始密码与停止耗时
function runPanelSmoke(imageTag) {
  const container = `weread-runtime-smoke-${Date.now()}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weread-runtime-smoke-'));

  try {
    runCommand('docker', [
      'run', '-d', '--name', container,
      '--health-interval=2s', '--health-start-period=0s',
      '-v', `${dataDir}:/app/data`,
      imageTag,
    ]);
    waitForHealthy(container);

    const user = runCommand('docker', ['exec', container, 'stat', '-c', '%U', '/proc/1'], { quiet: true });
    if (user !== 'node') {
      throw new Error(`Panel process runs as ${user}, expected node`);
    }
    const owner = runCommand('docker', ['exec', container, 'stat', '-c', '%U %a', '/app/data/panel.json'], { quiet: true });
    if (owner !== 'node 600') {
      throw new Error(`panel.json owner/mode is "${owner}", expected "node 600"`);
    }
    const logs = runCommand('docker', ['logs', container], { quiet: true });
    if (!/面板初始密码：[A-Za-z0-9]{16}/.test(logs)) {
      throw new Error('Generated panel password was not printed to the container log');
    }

    const startedAt = Date.now();
    runCommand('docker', ['stop', container], { quiet: true });
    const stopMs = Date.now() - startedAt;
    if (stopMs > STOP_TIMEOUT_MS) {
      throw new Error(`docker stop took ${stopMs}ms; the panel should exit on SIGTERM`);
    }
    console.log(`Smoke passed: panel is healthy, runs as node, owns its data and stops in ${stopMs}ms.`);
  } finally {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'pipe' });
    // 容器内创建的文件属于 node 用户，用容器清理
    spawnSync('docker', ['run', '--rm', '--entrypoint', 'rm', '-v', `${dataDir}:/data`, imageTag, '-rf', '/data/panel.json', '/data/panel.log'], { stdio: 'pipe' });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function runDockerSmoke() {
  const prebuilt = process.env.RUNTIME_SMOKE_IMAGE;
  const imageTag = prebuilt || `weread-runtime-smoke:${Date.now()}`;

  try {
    if (!prebuilt) {
      runCommand('docker', ['build', '-t', imageTag, '.']);
    }
    const expectedArch = process.env.RUNTIME_SMOKE_ARCH;
    if (expectedArch) {
      const imageArch = runCommand('docker', ['image', 'inspect', '-f', '{{.Architecture}}', imageTag], { quiet: true });
      // 只取标准输出：在 QEMU 中运行其他架构的镜像时，docker 会在标准错误中打印平台不一致的警告
      const run = spawnSync('docker', ['run', '--rm', imageTag, 'node', '-p', 'process.arch'], { encoding: 'utf8', stdio: 'pipe' });
      const processArch = (run.stdout || '').trim();
      // Docker 与 Node.js 对 x86-64 的叫法不同
      const nodeArch = { amd64: 'x64' }[expectedArch] || expectedArch;
      if (imageArch !== expectedArch || processArch !== nodeArch) {
        throw new Error(`Expected ${expectedArch}, but the image is ${imageArch} and Node.js reports ${processArch}`);
      }
      console.log(`Smoke passed: image and Node.js process are ${expectedArch}.`);
    }
    const helpOutput = runCommand('docker', ['run', '--rm', imageTag, 'node', 'src/cli.js', 'help']);
    assertHelpOutput(helpOutput, 'docker run <image> node src/cli.js help');
    console.log('Smoke passed: Docker image entrypoint is runnable.');
    runPanelSmoke(imageTag);
  } finally {
    if (!prebuilt) {
      spawnSync('docker', ['image', 'rm', '-f', imageTag], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }
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
