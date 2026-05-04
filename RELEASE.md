# Release Process

## Creating a New Release

This project uses GitHub Actions to automatically build and release the Electron app as Windows EXE files.

### Version Source

The release version comes from `app/package.json`. The Git tag and the app version must match.

### How to Create a Release

1. **Update the version in `app/package.json`**:
   ```bash
   cd app
   # Edit package.json and update the "version" field
   ```

2. **Commit your changes**:
   ```bash
   git add .
   git commit -m "Release version 1.0.1"
   ```

3. **Create and push a matching version tag**:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

4. **GitHub Actions will automatically**:
   - Build the Electron app
   - Create or update the GitHub release for the version tag
   - Upload two EXE files:
     - `Surevideotool Setup 1.0.1.exe` (NSIS installer)
     - `Surevideotool 1.0.1.exe` (Portable version)

### Manual Trigger

You can also manually trigger the release workflow from the GitHub Actions tab:
1. Go to `Actions` -> `Release`
2. Click `Run workflow`
3. Select the branch and click `Run workflow`

If the workflow is re-run for the same tag, it updates the existing GitHub release instead of failing.

### Build Outputs

The workflow creates two types of Windows executables:
- **NSIS Installer**: Full installer with uninstall capability
- **Portable**: Standalone executable that doesn't require installation

### Version Naming Convention

- Use semantic versioning: `MAJOR.MINOR.PATCH`
- Tag format: `v1.0.0`
- Example tags: `v1.0.0`, `v1.0.1`, `v1.1.0`, `v2.0.0`
- Example: if `app/package.json` is `1.0.1`, the tag must be `v1.0.1`
