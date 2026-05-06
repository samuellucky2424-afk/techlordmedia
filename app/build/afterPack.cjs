const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

const NATIVE_ARTIFACTS = [
  'surevideotool_cam_pipe_publisher.exe',
  'surevideotool_cam_registrar.exe',
  'SurevideotoolVirtualCamera.dll',
  'SurevideotoolVirtualCameraMF.dll'
];

const BUILD_CONFIGS = [
  'Release',
  'RelWithDebInfo',
  'Debug'
];

function getNativeBuildRoots(appDir) {
  const roots = [];

  if (process.env.SUREVIDEOTOOL_NATIVE_BUILD_DIR) {
    roots.push(path.resolve(appDir, process.env.SUREVIDEOTOOL_NATIVE_BUILD_DIR));
  }

  roots.push(path.resolve(appDir, '..', 'native-camera', 'build'));
  roots.push(path.resolve(appDir, '..', '..', 'build'));

  return [...new Set(roots)];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveNativeArtifacts(appDir) {
  const nativeBuildRoots = getNativeBuildRoots(appDir);

  for (const nativeBuildRoot of nativeBuildRoots) {
    const candidateDirectories = [
      nativeBuildRoot,
      ...BUILD_CONFIGS.map((buildConfig) => path.join(nativeBuildRoot, buildConfig))
    ];

    for (const candidateDirectory of candidateDirectories) {
      const resolvedArtifacts = {};
      let allFound = true;

      for (const artifactName of NATIVE_ARTIFACTS) {
        const candidatePath = path.join(candidateDirectory, artifactName);
        if (!(await fileExists(candidatePath))) {
          allFound = false;
          break;
        }

        resolvedArtifacts[artifactName] = candidatePath;
      }

      if (allFound) {
        return {
          buildConfig: path.basename(candidateDirectory),
          nativeBuildRoot,
          resolvedArtifacts
        };
      }
    }
  }

  throw new Error(
    `Unable to locate native Surevideotool camera artifacts in any of: ${nativeBuildRoots.join(', ')}. ` +
      `Build SurevideotoolCam first so ${NATIVE_ARTIFACTS.join(', ')} exist in a build output directory.`
  );
}

function getExecutableCandidates(context) {
  const appInfo = context.packager?.appInfo;
  const names = [
    appInfo?.productFilename,
    appInfo?.productName,
    context.packager?.platformSpecificBuildOptions?.executableName,
    'Surevideotool'
  ].filter(Boolean);

  return [...new Set(names)].map((name) => path.join(context.appOutDir, `${name}.exe`));
}

async function stampWindowsExecutableIcon(context, appDirectory) {
  if (process.platform !== 'win32') {
    return;
  }

  const iconPath = path.join(appDirectory, 'build', 'icon.ico');
  const rceditPath = path.join(appDirectory, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  const executablePath = (await Promise.all(
    getExecutableCandidates(context).map(async (candidate) => ((await fileExists(candidate)) ? candidate : null))
  )).find(Boolean);

  if (!executablePath) {
    throw new Error(`Unable to locate packaged Surevideotool executable in ${context.appOutDir}.`);
  }

  if (!(await fileExists(iconPath))) {
    throw new Error(`Unable to locate Surevideotool icon for executable stamping: ${iconPath}`);
  }

  if (!(await fileExists(rceditPath))) {
    throw new Error(`Unable to locate rcedit.exe for executable icon stamping: ${rceditPath}`);
  }

  const result = spawnSync(rceditPath, [executablePath, '--set-icon', iconPath], {
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(
      `Unable to stamp Surevideotool executable icon. exit=${result.status} stdout=${result.stdout || ''} stderr=${result.stderr || ''}`
    );
  }

  console.log(`[afterPack] Stamped Surevideotool executable icon on ${executablePath}`);
}

module.exports = async function afterPack(context) {
  const appDirectory = context.packager?.info?.appDir ?? context.packager?.projectDir ?? process.cwd();
  const { buildConfig, resolvedArtifacts } = await resolveNativeArtifacts(appDirectory);
  const destinationDirectory = path.join(context.appOutDir, 'resources', 'surevideotool-cam');

  await fs.mkdir(destinationDirectory, { recursive: true });

  await Promise.all(
    Object.entries(resolvedArtifacts).map(([artifactName, sourcePath]) =>
      fs.copyFile(sourcePath, path.join(destinationDirectory, artifactName))
    )
  );

  console.log(
    `[afterPack] Bundled Surevideotool camera artifacts from ${buildConfig} into ${destinationDirectory}`
  );

  await stampWindowsExecutableIcon(context, appDirectory);
};
