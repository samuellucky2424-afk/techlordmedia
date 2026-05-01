// @ts-nocheck

/**
 * Fetches the latest release version directly from the GitHub Releases API.
 * No hardcoded version — updating this file is never required when releasing.
 */

const GITHUB_OWNER = 'samuellucky2424-afk';
const GITHUB_REPO = 'Surevideotool-project';
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

async function fetchLatestVersion() {
  const response = await fetch(GITHUB_API_LATEST, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'surevideotool-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  // GitHub returns 404 when the repo has no published releases yet. Treat that
  // as "no update available" rather than a hard error so the desktop updater
  // doesn't surface a scary 500 dialog on every launch.
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API responded with HTTP ${response.status}`);
  }

  const data = await response.json();

  // tag_name is typically "v1.2.5" — strip the leading "v"
  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  const version = tag.replace(/^v/, '').trim();

  if (!version) {
    throw new Error('GitHub API returned an empty tag_name');
  }

  // Build a set of uploaded asset names from the API response — much more
  // reliable than a HEAD request which can follow redirects to HTML pages.
  const uploadedAssets = new Set(
    Array.isArray(data.assets)
      ? data.assets.map((a) => a.name)
      : [],
  );

  return { version, releaseNotes: data.body || null, uploadedAssets };
}

function normalizePackageType(value) {
  return value === 'portable' ? 'portable' : 'installer';
}

function buildAssetName(version, packageType) {
  const safeVersion = version.trim();
  return packageType === 'portable'
    ? `Surevideotool-${safeVersion}.exe`
    : `Surevideotool-Setup-${safeVersion}.exe`;
}

function buildReleasePageUrl(version) {
  return `${GITHUB_REPOSITORY_URL}/releases/tag/v${version.trim()}`;
}

function buildDownloadUrl(version, packageType) {
  const assetName = buildAssetName(version, packageType);
  return `${GITHUB_REPOSITORY_URL}/releases/download/v${version.trim()}/${encodeURIComponent(assetName)}`;
}

function createVersionManifest(options) {
  const version = options.version.trim();
  const packageType = options.packageType || 'installer';
  const assetName = buildAssetName(version, packageType);

  return {
    latestVersion: version,
    downloadUrl: buildDownloadUrl(version, packageType),
    packageType,
    checksum: options.checksum || null,
    releaseNotes: options.releaseNotes || null,
    releasePageUrl: buildReleasePageUrl(version),
    sourceLabel: 'GitHub Releases',
    assetName,
    generatedAt: new Date().toISOString()
  };
}

function getBuildType(req) {
  const candidate = req?.query?.build ?? req?.query?.packageType ?? req?.query?.mode;
  return normalizePackageType(candidate);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const packageType = getBuildType(req);
    const latest = await fetchLatestVersion();

    // No GitHub release published yet — echo the client's currentVersion back
    // as latestVersion so the desktop updater treats the build as up-to-date
    // instead of erroring on a missing version field.
    if (latest === null) {
      const clientVersion = (req?.query?.currentVersion ?? req?.query?.version ?? '0.0.0').toString().trim() || '0.0.0';
      return res.status(200).json({
        latestVersion: clientVersion,
        downloadUrl: `${GITHUB_REPOSITORY_URL}/releases`,
        packageType,
        checksum: null,
        releaseNotes: null,
        releasePageUrl: `${GITHUB_REPOSITORY_URL}/releases`,
        sourceLabel: 'GitHub Releases',
        assetName: buildAssetName(clientVersion, packageType),
        generatedAt: new Date().toISOString(),
        _debug: { reason: 'no-releases-published' },
      });
    }

    const { version, releaseNotes, uploadedAssets } = latest;
    const manifest = createVersionManifest({
      version,
      packageType,
      releaseNotes,
      checksum: null,
    });

    // Use the GitHub API asset list to check existence — more reliable than
    // a HEAD request which can follow redirects to HTML pages and return 200.
    const assetName = buildAssetName(version, packageType);
    if (!uploadedAssets.has(assetName)) {
      manifest.downloadUrl = manifest.releasePageUrl;
      manifest.assetName = null;
    }

    manifest._debug = { assetName, uploadedAssets: [...uploadedAssets] };

    return res.status(200).json(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
