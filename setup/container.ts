/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync } from 'child_process';
import path from 'path';

import { log } from '../src/log.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { runtime: string } {
  let runtime = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = 'nanoclaw-agent:latest';
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (!runtime) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: 'unknown',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'missing_runtime_flag',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Validate runtime availability
  if (runtime === 'apple-container' && !commandExists('container')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  if (runtime === 'docker') {
    if (!commandExists('docker')) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
    try {
      execSync('docker info', { stdio: 'ignore' });
    } catch {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  if (!['apple-container', 'docker'].includes(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const buildCmd =
    runtime === 'apple-container' ? 'container build' : 'docker build';
  const runCmd = runtime === 'apple-container' ? 'container' : 'docker';

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  // Keeps /setup and ./container/build.sh in sync — both read the same source.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional; absence is normal on a fresh checkout
  }

  // Build
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  try {
    const argsStr = buildArgs.length > 0 ? ' ' + buildArgs.join(' ') : '';
    execSync(`${buildCmd}${argsStr} -t ${image} .`, {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    log.info('Container build succeeded');
  } catch (err) {
    log.error('Container build failed', { err });
  }

  // Test
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | ${runCmd} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      log.info('Container test result', { testOk });
    } catch {
      log.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
