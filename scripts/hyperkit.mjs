// This downloads hyperkit, builds it, and puts the binary in the right place.

import fs from 'fs';
import os from 'os';
import process from 'process';
import childProcess from 'child_process';
import path from 'path';

// The version of hyperkit to build
const ver = 'v0.20210107';

/**
 * Build the Hyperkit binary.
 * @param workPath {string} The directory to work in; must be empty.
 * @returns {string} The executable in the work directory.
 */
async function buildHyperkit(workPath) {
  // Using git and make to build the binary is intentional. There is no binary
  // download available from the project. Minikube checks the hyperkit version
  // so the correct version information needs to be included in the binary. Make
  // is used by the project to build a binary and it assumes the project was
  // retrieved via git and that git metadata for the version is available. The
  // Makefile uses git to retrieve the version and the sha (which is used for an
  // internal assertion).
  await spawn('git', 'clone', '--depth', '1', '--branch', ver, 'https://github.com/moby/hyperkit.git', workPath);
  await spawn('make', '-C', workPath);
  const outPath = path.resolve(workPath, 'build', 'hyperkit');

  await fs.promises.chmod(outPath, 0o755);

  return outPath;
}

/**
 * Build the docker-machine driver binary.
 * @param workPath {string} The directory to work in; must be empty.
 * @returns {string} The executable in the work directory.
 */
async function buildDockerMachineDriver(workPath) {
  const project = 'docker-machine-driver-hyperkit';
  const version = 'v2.0.0-alpha.3';
  const url = `https://github.com/rancher-sandbox/${ project }/releases/download/${ version }/${ project }`;
  const outPath = path.join(workPath, project);

  await spawn('curl', '-Lo', outPath, url);
  // Setting the permissions for the docker-machine driver requires sudo; ensure
  // that we get it to print out a prompt so the user doesn't get confused.
  await spawn('sudo', '--prompt=Sudo privileges required to set docker-machine driver suid:',
    '/bin/sh', '-xc', `chown root:wheel '${ outPath }' && chmod u+s,a+x '${ outPath }'`);

  return outPath;
}

function getScriptFn(url) {
  return async function(workPath) {
    const outPath = path.join(workPath, 'script');

    await spawn('curl', '-Lo', outPath, url);
    await fs.promises.chmod(outPath, 0o755);

    return outPath;
  };
}

/**
 * Check if a file exists, and if not, build it.
 * @param destPath {string} The output executable.
 * @param fn {(workDir: string) => Promise<string>} A function to build it, returning the built artifact.
 * @param mode {number} File mode required.
 */
async function buildIfNotAccess(destPath, fn, mode = fs.constants.X_OK) {
  try {
    await fs.promises.access(destPath, fs.constants.X_OK);

    return;
  } catch (ex) {
    // The output must be rebuilt.
  }
  const tmpDirPrefix = path.join(os.tmpdir(), `${ path.basename(destPath, '.exe') }-`);
  const workDir = await fs.promises.mkdtemp(tmpDirPrefix);

  try {
    const outPath = await fn(workDir);

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.rename(outPath, destPath);
  } finally {
    try {
      await fs.promises.rm(workDir, { recursive: true });
    } catch (err) {
      console.error(err);
      // Allow the failure here.
    }
  }
}

/**
 * Spawn a command, with all output going to the controlling terminal; raise an
 * exception if it returns a non-zero exit code.
 */
async function spawn(command, ...args) {
  const options = { stdio: 'inherit' };

  if (args.concat().pop() instanceof Object) {
    Object.assign(options, args.pop());
  }
  const child = childProcess.spawn(command, args, options);

  return await new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (signal && signal !== 'SIGTERM') {
        reject(new Error(`${ command } exited with signal ${ signal }`));
      } else if (code > 0) {
        reject(new Error(`${ command } exited with code ${ code }`));
      } else {
        resolve();
      }
    });
    child.on('error', reject);
  });
}

async function run() {
  // This is _not_ parallel, so that we can read the outputs easier (especially
  // since building the docker machine driver requires sudo).
  await buildIfNotAccess(
    path.resolve(process.cwd(), 'resources', os.platform(), 'hyperkit'),
    buildHyperkit);
  await buildIfNotAccess(
    path.resolve(process.cwd(), 'resources', os.platform(), 'docker-machine-driver-hyperkit'),
    buildDockerMachineDriver);
  await buildIfNotAccess(
    path.resolve(process.cwd(), 'resources', os.platform(), 'run-k3s'),
    getScriptFn('https://github.com/jandubois/tinyk3s/raw/v0.1/run-k3s'));
  await buildIfNotAccess(
    path.resolve(process.cwd(), 'resources', os.platform(), 'kubeconfig'),
    getScriptFn('https://github.com/jandubois/tinyk3s/raw/v0.1/kubeconfig'));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
