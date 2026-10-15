#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

// Only linux/arm64 is published: this fork targets ARM64 boards (Raspberry Pi and
// similar). amd64 is deliberately not built, so a release cannot reintroduce it.
const DEFAULT_PUSH_PLATFORM = 'linux/arm64';

function printHelp() {
  console.log(`Usage:
  node scripts/docker-image.js <command> [options]

Commands:
  help                      Show this help message
  check                     Validate resolved Docker image config
  build                     Build the Docker image locally
  push                      Build and push the Docker image

Options:
  --image <name>            Target image name
                            default: docker.io/lonemoonspace/weread-challenge
  --tag <tag>               Primary tag
                            default: package.json version (${packageJson.version})
  --extra-tags <list>       Extra tags separated by commas
  --platform <platform>     Comma separated target platforms
                            default for build: host platform
                            default for push: ${DEFAULT_PUSH_PLATFORM}
  --dockerfile <path>       Dockerfile path
                            default: Dockerfile
  --context <path>          Docker build context
                            default: .

Examples:
  node scripts/docker-image.js check
  node scripts/docker-image.js build --tag latest
  node scripts/docker-image.js build --platform linux/arm64 --tag arm64-trial
  node scripts/docker-image.js push --tag ${packageJson.version}
  npm run docker:image:push -- --tag ${packageJson.version}
  npm run docker:image:push:dev

Notes:
  Only linux/arm64 is published: push defaults to "${DEFAULT_PUSH_PLATFORM}", so a
  release cannot quietly reintroduce another architecture or downgrade the
  published tags. Both commands go through docker buildx, and push builds and
  pushes every tag in a single invocation. build uses --load, which only supports
  a single platform. Building arm64 on an amd64 host needs QEMU/binfmt
  emulation; on ARM64 hardware or GitHub Actions it works out of the box.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return { command: 'help', options: {} };
  }

  const [commandToken, ...rest] = argv;
  const normalizedCommand = ['-h', '--help'].includes(commandToken)
    ? 'help'
    : commandToken;
  const commands = new Set(['help', 'check', 'build', 'push']);

  if (!commands.has(normalizedCommand)) {
    fail(`Unknown command: ${commandToken}`);
  }

  const options = {};
  const knownFlags = new Set([
    '--image',
    '--tag',
    '--extra-tags',
    '--platform',
    '--dockerfile',
    '--context'
  ]);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (['-h', '--help'].includes(token)) {
      return { command: 'help', options: {} };
    }
    if (!knownFlags.has(token)) {
      fail(`Unknown option: ${token}`);
    }
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for ${token}`);
    }
    options[token.slice(2)] = value;
    i += 1;
  }

  return { command: normalizedCommand, options };
}

function uniqueTags(tags) {
  return [...new Set(tags.filter(Boolean))];
}

function parsePlatforms(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveConfig(command, rawOptions) {
  const image = rawOptions.image || process.env.DOCKER_IMAGE || 'docker.io/lonemoonspace/weread-challenge';
  const tag = rawOptions.tag || process.env.DOCKER_TAG || packageJson.version;
  const extraTags = uniqueTags(
    (rawOptions['extra-tags'] || process.env.DOCKER_EXTRA_TAGS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const dockerfile = path.resolve(ROOT_DIR, rawOptions.dockerfile || process.env.DOCKERFILE || 'Dockerfile');
  const context = path.resolve(ROOT_DIR, rawOptions.context || process.env.DOCKER_CONTEXT || '.');
  // Only linux/arm64 is published. `check` reports the same default as `push` so
  // the validated configuration matches what a release would actually do; `build`
  // stays on the host platform so a local build needs no emulation.
  const defaultPlatform = command === 'build' ? '' : DEFAULT_PUSH_PLATFORM;
  const platform = rawOptions.platform || process.env.DOCKER_PLATFORM || defaultPlatform;

  if (!image) {
    fail('Docker image name is required');
  }
  if (!tag) {
    fail('Docker tag is required');
  }
  if (!fs.existsSync(dockerfile)) {
    fail(`Dockerfile not found: ${dockerfile}`);
  }
  if (!fs.existsSync(context)) {
    fail(`Docker build context not found: ${context}`);
  }

  return {
    image,
    tag,
    extraTags: extraTags.filter((item) => item !== tag),
    dockerfile,
    context,
    platform,
    platforms: [...new Set(parsePlatforms(platform))]
  };
}

function ensureDockerAvailable() {
  const result = spawnSync('docker', ['version'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.error) {
    fail(`Failed to run docker: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || 'docker version failed').trim());
  }
}

function ensureBuildxAvailable() {
  const result = spawnSync('docker', ['buildx', 'version'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.error) {
    fail(`Failed to run docker buildx: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || 'docker buildx version failed').trim());
  }
}

function buildxCommandArgs(config) {
  const args = ['buildx', 'build'];
  // Forward the normalised list: buildx splits on "," without trimming and
  // containerd rejects whitespace, so an untouched "linux/arm64, linux/amd64"
  // would only fail once it is inside buildx.
  if (config.platforms.length > 0) {
    args.push('--platform', config.platforms.join(','));
  }
  args.push('-f', config.dockerfile);
  config.buildTags.forEach((tag) => {
    args.push('-t', `${config.image}:${tag}`);
  });
  // Every tag is published from this one invocation, so all tags always carry
  // the same image rather than being pushed separately.
  args.push(config.command === 'push' ? '--push' : '--load');
  args.push(config.context);
  return args;
}

function printConfig(config) {
  console.log(`command: ${config.command}`);
  console.log(`image: ${config.image}`);
  console.log(`primary tag: ${config.tag}`);
  console.log(`extra tags: ${config.extraTags.length ? config.extraTags.join(', ') : '(none)'}`);
  console.log(`build tags: ${config.buildTags.join(', ')}`);
  console.log(`push tags: ${config.pushTags.length ? config.pushTags.join(', ') : '(none)'}`);
  console.log(`dockerfile: ${config.dockerfile}`);
  console.log(`context: ${config.context}`);
  console.log(`platform: ${config.platforms.length ? config.platforms.join(',') : '(host default)'}`);
}

function resolvePushTags(config) {
  if (config.command !== 'push') {
    return [];
  }
  const tags = [config.tag, ...config.extraTags];
  if (config.tag !== 'latest' && config.tag !== 'dev') {
    tags.push('latest');
  }
  return uniqueTags(tags);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });
  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help') {
    printHelp();
    return;
  }

  const config = resolveConfig(command, options);
  config.command = command;
  config.pushTags = resolvePushTags(config);
  config.buildTags = command === 'push' ? config.pushTags : uniqueTags([config.tag, ...config.extraTags]);

  // Validate the invocation before touching docker, so a bad platform request
  // reports the actual problem instead of "docker is not available".
  if (command === 'build' && config.platforms.length > 1) {
    fail(`build cannot --load a multi-platform image (${config.platform}); `
      + 'pass a single --platform for a local build, or use "push" to publish all platforms at once');
  }

  ensureDockerAvailable();
  // `check` only validates the resolved configuration and never builds, so it
  // must not start failing on Docker installs that lack the buildx plugin.
  if (command !== 'check') {
    ensureBuildxAvailable();
  }
  printConfig(config);

  if (command === 'check') {
    console.log('docker image config is valid');
    return;
  }

  const buildArgs = buildxCommandArgs(config);
  console.log(`running: docker ${buildArgs.join(' ')}`);
  runCommand('docker', buildArgs);
}

main();
