const fs = require('fs');
const path = require('path');

const root = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const pathsToRemove = ['dist', 'release', 'release-build'];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmSyncWithRetries(targetPath) {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      if (!error || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
      sleepSync(250 * attempt);
    }
  }
}

for (const relativePath of pathsToRemove) {
  const targetPath = path.join(root, relativePath);
  try {
    rmSyncWithRetries(targetPath);
  } catch (error) {
    const renamedPath = `${targetPath}.old.${Date.now()}`;
    try {
      fs.renameSync(targetPath, renamedPath);
      rmSyncWithRetries(renamedPath);
    } catch (renameError) {
      const code = (error && error.code) || (renameError && renameError.code) || 'UNKNOWN';
      process.stderr.write(
        `Failed to clean "${relativePath}" (${code}). Close any running app using it (including win-unpacked) and try again.\n`,
      );
      throw error;
    }
  }
}
