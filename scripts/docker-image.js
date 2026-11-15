#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

// Both linux/amd64 and linux/arm64 are published. The release workflow builds each
// architecture on a native runner and pushes it by digest (--digest-file), then merges
// the digests into one multi-arch manifest; a manual "push" without --platform builds
// both at once (the non-native one through QEMU/binfmt emulation).
const DEFAULT_PUSH_PLATFORM = 'linux/amd64,linux/arm64';

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
                            default: docker.io/lonemoonspace/weread-assistant
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
  --digest-file <path>      push only: push a single platform by digest, without
                            tags, and write the digest (sha256:...) to this file;
                            the release workflow merges the per-arch digests

Examples:
  node scripts/docker-image.js check
  node scripts/docker-image.js build --tag latest
  node scripts/docker-image.js build --platform linux/arm64 --tag arm64-trial
  node scripts/docker-image.js push --tag ${packageJson.version}
  node scripts/docker-image.js push --platform linux/arm64 --digest-file digest.txt
  npm run docker:image:push -- --tag ${packageJson.version}
  npm run docker:image:push:dev

Notes:
  linux/amd64 and linux/arm64 are published: push defaults to
  "${DEFAULT_PUSH_PLATFORM}", and pushes every tag in a single invocation so all
  tags carry the same multi-arch image. Both commands go through docker buildx.
  build uses --load, which only supports a single platform. Building the
  non-native architecture needs QEMU/binfmt emulation; the release workflow
  instead builds each architecture on a native runner with --digest-file.`);
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
    '--context',
    '--digest-file'
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
  const image = rawOptions.image || process.env.DOCKER_IMAGE || 'docker.io/lonemoonspace/weread-assistant';
  const tag = rawOptions.tag || process.env.DOCKER_TAG || packageJson.version;
  const extraTags = uniqueTags(
    (rawOptions['extra-tags'] || process.env.DOCKER_EXTRA_TAGS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const dockerfile = path.resolve(ROOT_DIR, rawOptions.dockerfile || process.env.DOCKERFILE || 'Dockerfile');
  const context = path.resolve(ROOT_DIR, rawOptions.context || process.env.DOCKER_CONTEXT || '.');
  // `check` reports the same default as `push` so the validated configuration
  // matches what a release would actually do; `build` stays on the host platform
  // so a local build needs no emulation.
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
    platforms: [...new Set(parsePlatforms(platform))],
    digestFile: rawOptions['digest-file'] ? path.resolve(process.cwd(), rawOptions['digest-file']) : ''
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

// The commit the image is built from, recorded as an OCI label: DOCKER_REVISION when
// set, otherwise the checked-out commit; left out when git is unavailable.
function resolveRevision() {
  if (process.env.DOCKER_REVISION) {
    return process.env.DOCKER_REVISION;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0 ? result.stdout.trim() : '';
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
  if (!config.digestFile) {
    config.buildTags.forEach((tag) => {
      args.push('-t', `${config.image}:${tag}`);
    });
  }
  args.push('--label', `org.opencontainers.image.version=${config.tag}`);
  if (config.revision) {
    args.push('--label', `org.opencontainers.image.revision=${config.revision}`);
  }
  if (config.digestFile) {
    // One platform, pushed by digest only; the tags are attached when the
    // per-arch digests are merged into a manifest list (docker buildx imagetools create)
    args.push('--output', `type=image,name=${config.image},push-by-digest=true,name-canonical=true,push=true`);
    args.push('--metadata-file', config.metadataFile);
  } else {
    // Every tag is published from this one invocation, so all tags always carry
    // the same image rather than being pushed separately.
    args.push(config.command === 'push' ? '--push' : '--load');
  }
  args.push(config.context);
  return args;
}

function printConfig(config) {
  console.log(`command: ${config.command}`);
  console.log(`image: ${config.image}`);
  console.log(`primary tag: ${config.tag}`);
  console.log(`extra tags: ${config.extraTags.length ? config.extraTags.join(', ') : '(none)'}`);
  console.log(`build tags: ${config.buildTags.join(', ')}`);
  console.log(`push tags: ${config.digestFile ? '(by digest)' : config.pushTags.length ? config.pushTags.join(', ') : '(none)'}`);
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
  if (config.digestFile && (command !== 'push' || config.platforms.length !== 1)) {
    fail('--digest-file only works with push and a single --platform');
  }
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

  config.revision = resolveRevision();
  if (config.digestFile) {
    config.metadataFile = `${config.digestFile}.metadata.json`;
  }
  const buildArgs = buildxCommandArgs(config);
  console.log(`running: docker ${buildArgs.join(' ')}`);
  runCommand('docker', buildArgs);
  if (config.digestFile) {
    const digest = JSON.parse(fs.readFileSync(config.metadataFile, 'utf8'))['containerimage.digest'];
    if (!/^sha256:[0-9a-f]{64}$/.test(digest || '')) {
      fail(`buildx did not report an image digest (${config.metadataFile})`);
    }
    fs.writeFileSync(config.digestFile, `${digest}\n`);
    fs.rmSync(config.metadataFile, { force: true });
    console.log(`pushed ${config.image}@${digest}`);
  }
}

main();
