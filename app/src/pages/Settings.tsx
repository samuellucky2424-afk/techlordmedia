import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import { StreamGuideModal } from '@/components/StreamGuideModal';
import {
  checkForUpdates as checkDesktopForUpdates,
  downloadUpdate as downloadDesktopUpdate,
  getDesktopUpdateState,
  installUpdate as installDesktopUpdate,
  isDesktopUpdaterAvailable,
  subscribeToDesktopUpdateState,
  formatUpdateInstallMode,
  formatUpdatePackageType,
  type DesktopUpdateState
} from '@/lib/desktop-updater';

function Settings() {
  const { user, logout } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [isSaving, setIsSaving] = useState(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(() => ({
    status: 'idle',
    currentVersion: 'Unknown',
    latestVersion: null,
    packageType: null,
    installMode: 'download-only',
    manifestUrl: null,
    releasePageUrl: null,
    sourceLabel: null,
    sourceHost: null,
    downloadUrl: null,
    checksum: null,
    releaseNotes: null,
    assetName: null,
    downloadedFileName: null,
    downloadedPath: null,
    downloadDirectory: null,
    downloadProgress: {
      percent: 0,
      transferredBytes: 0,
      totalBytes: null,
      bytesPerSecond: null,
      etaSeconds: null
    },
    progress: 0,
    updateAvailable: false,
    readyToInstall: false,
    canAutoInstall: false,
    checksumVerified: null,
    checkInProgress: false,
    downloadInProgress: false,
    installInProgress: false,
    error: null,
    lastCheckedAt: null,
    lastDownloadedAt: null,
    lastInstalledAt: null
  }));
  const [isGuideModalOpen, setIsGuideModalOpen] = useState(false);
  const isDesktopUpdatesAvailable = isDesktopUpdaterAvailable();

  useEffect(() => {
    let alive = true;

    const hydrateState = async () => {
      const state = await getDesktopUpdateState();
      if (alive) {
        setDesktopUpdateState(state);
      }
    };

    void hydrateState();

    const unsubscribe = subscribeToDesktopUpdateState((state) => {
      setDesktopUpdateState(state);
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const formatBytes = (value: number | null | undefined) => {
    if (!value || value <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** exponent;
    return `${amount.toFixed(amount >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  };

  const updateProgressLabel = () => {
    const progress = desktopUpdateState.downloadProgress;
    if (desktopUpdateState.downloadInProgress) {
      const total = progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : '';
      return `${formatBytes(progress.transferredBytes)}${total}`;
    }

    if (desktopUpdateState.readyToInstall && desktopUpdateState.downloadedFileName) {
      return `${desktopUpdateState.downloadedFileName} is ready to install`;
    }

    if (desktopUpdateState.latestVersion && desktopUpdateState.latestVersion === desktopUpdateState.currentVersion) {
      return 'You are up to date';
    }

    return 'No download in progress';
  };

  const handleCheckForUpdates = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    toast('Checking for updates...');
    const result = await checkDesktopForUpdates();

    if (result.success) {
      if (result.updateAvailable) {
        toast.info(`Version ${result.latestVersion || 'unknown'} found. Downloading now...`);
      } else {
        toast.success('You are using the latest version.');
      }
    } else {
      toast.error(result.error || 'Failed to check for updates');
    }
  };

  const handleDownloadUpdate = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    toast('Downloading update...');
    const result = await downloadDesktopUpdate();

    if (result.success) {
      if (result.readyToInstall) {
        toast.success(`Update ${result.latestVersion || ''} is ready to install.`);
      } else if (result.updateAvailable) {
        toast.info('Download is in progress.');
      } else {
        toast.info('No newer build is available right now.');
      }
    } else {
      toast.error(result.error || 'Failed to download update');
    }
  };

  const handleInstallUpdate = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    const result = await installDesktopUpdate();

    if (result.success) {
      if (result.downloadOnly) {
        toast.info('The downloaded file was opened in its folder. Run it manually to finish updating.');
      } else {
        toast.success('Installer launched. Please approve the Windows prompt.');
      }
    } else {
      toast.error(result.error || 'Failed to start the installer');
    }
  };



  const handleSaveProfile = async () => {
    setIsSaving(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    toast.success('Profile updated successfully');
    setIsSaving(false);
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#71717a]">Account</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="text-xs text-[#a1a1aa]">Manage your account, notifications and desktop updates.</p>
      </div>

      <div className="space-y-3">
        <Card className="gap-0 overflow-hidden rounded-md border-[#1f1f23] bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-white">Profile</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Update your account details.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-xs font-medium text-[#a1a1aa]">Full name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 rounded-md border-[#27272a] bg-[#18181b] text-xs text-white focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium text-[#a1a1aa]">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-8 rounded-md border-[#27272a] bg-[#18181b] text-xs text-white focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
            </div>
            <Button
              onClick={handleSaveProfile}
              disabled={isSaving}
              className="h-8 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500"
            >
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </CardContent>
        </Card>

        <Card className="gap-0 overflow-hidden rounded-md border-[#1f1f23] bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-white">Notifications</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Configure your notification preferences.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">Email notifications</Label>
                <p className="text-[11px] text-[#71717a]">Receive email updates about your account.</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">Low balance alerts</Label>
                <p className="text-[11px] text-[#71717a]">Get notified when your balance is low.</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">Marketing emails</Label>
                <p className="text-[11px] text-[#71717a]">Receive updates about new features and offers.</p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 overflow-hidden rounded-md border-[#1f1f23] bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-white">Streaming &amp; capture</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Route Surevideotool into SplitCam, OBS, Zoom, WhatsApp and more.</CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">SplitCam / OBS guide</Label>
                <p className="text-[11px] text-[#71717a]">Step-by-step instructions for capturing the feed in video apps.</p>
              </div>
              <Button
                onClick={() => setIsGuideModalOpen(true)}
                className="h-8 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500"
              >
                View guide
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 overflow-hidden rounded-md border-[#1f1f23] bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-sm font-semibold tracking-tight text-white">Software updates</CardTitle>
                <CardDescription className="text-xs text-[#71717a]">
                  Check for new desktop builds, validate the download, and install when ready.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={desktopUpdateState.updateAvailable ? 'default' : 'secondary'} className="rounded px-1.5 py-0 text-[10px] font-medium">
                  {desktopUpdateState.updateAvailable ? 'Update available' : 'Up to date'}
                </Badge>
                <Badge variant="outline" className="rounded px-1.5 py-0 text-[10px] font-medium">{formatUpdatePackageType(desktopUpdateState.packageType)}</Badge>
                <Badge variant="outline" className="rounded px-1.5 py-0 text-[10px] font-medium">{formatUpdateInstallMode(desktopUpdateState.installMode)}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-[#27272a] bg-[#27272a]">
              <div className="bg-[#18181b] px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71717a]">Current version</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-white">{desktopUpdateState.currentVersion}</p>
                <p className="mt-0.5 text-[11px] text-[#a1a1aa]">Installed on this device.</p>
              </div>
              <div className="bg-[#18181b] px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#71717a]">Latest version</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-white">
                  {desktopUpdateState.latestVersion || 'Not checked yet'}
                </p>
                <p className="mt-0.5 text-[11px] text-[#a1a1aa]">
                  {desktopUpdateState.updateAvailable
                    ? 'A newer build is ready to download.'
                    : 'Refreshes after the next manifest check.'}
                </p>
              </div>
            </div>

            <div className="rounded-md border border-[#27272a] bg-[#18181b] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-white">Update status</p>
                  <p className="text-[11px] text-[#71717a]">{updateProgressLabel()}</p>
                </div>
                <Badge
                  variant={desktopUpdateState.error ? 'destructive' : desktopUpdateState.readyToInstall ? 'default' : 'secondary'}
                  className="rounded px-1.5 py-0 text-[10px] font-medium"
                >
                  {desktopUpdateState.status.replace(/-/g, ' ')}
                </Badge>
              </div>

              <div className="mt-3">
                <Progress
                  value={desktopUpdateState.downloadInProgress || desktopUpdateState.readyToInstall ? desktopUpdateState.downloadProgress.percent : desktopUpdateState.updateAvailable ? 10 : 0}
                  className="h-1.5 bg-[#27272a]"
                />
              </div>

              <div className="mt-3 grid gap-2 text-[11px] text-[#a1a1aa] sm:grid-cols-2">
                <div>
                  <p className="text-[#71717a]">Downloaded file</p>
                  <p className="mt-0.5 font-medium text-white">
                    {desktopUpdateState.downloadedFileName || 'Waiting for download'}
                  </p>
                  <p className="mt-0.5 text-[#a1a1aa]">
                    {desktopUpdateState.downloadInProgress
                      ? formatBytes(desktopUpdateState.downloadProgress.transferredBytes)
                      : desktopUpdateState.readyToInstall
                        ? 'Validated and ready to install'
                        : 'Filled in once the file arrives.'}
                  </p>
                </div>
                <div>
                  <p className="text-[#71717a]">Checksum</p>
                  <p className="mt-0.5 text-white">
                    {desktopUpdateState.checksum
                      ? desktopUpdateState.checksumVerified === true
                        ? 'Verified'
                        : 'Pending verification'
                      : 'Not provided'}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-md border border-[#27272a] bg-[#18181b] p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-white">Release notes</p>
                  <p className="text-[11px] text-[#71717a]">What changed in the latest build.</p>
                </div>
              </div>
              <div className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded border border-[#27272a] bg-black/30 p-2.5 text-[11px] leading-5 text-[#d4d4d8]">
                {desktopUpdateState.releaseNotes || 'No release notes were provided with this manifest.'}
              </div>
            </div>

            {desktopUpdateState.error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                <p className="font-semibold">Updater error</p>
                <p className="mt-1 break-words text-[11px] leading-5 text-red-100/90">{desktopUpdateState.error}</p>
              </div>
            )}

            {!isDesktopUpdatesAvailable && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-100">
                Desktop updates are only available in the packaged Electron app. The web app updates through normal deploys.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleCheckForUpdates}
                disabled={!isDesktopUpdatesAvailable || desktopUpdateState.checkInProgress || desktopUpdateState.downloadInProgress || desktopUpdateState.installInProgress}
                className="h-8 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-500"
              >
                {desktopUpdateState.checkInProgress
                  ? 'Checking…'
                  : desktopUpdateState.downloadInProgress
                    ? 'Downloading…'
                    : 'Check for updates'}
              </Button>
              <Button
                onClick={handleDownloadUpdate}
                disabled={!isDesktopUpdatesAvailable || desktopUpdateState.downloadInProgress || desktopUpdateState.installInProgress || desktopUpdateState.readyToInstall}
                className="h-8 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500"
              >
                Download update
              </Button>
              <Button
                onClick={handleInstallUpdate}
                disabled={!isDesktopUpdatesAvailable || !desktopUpdateState.readyToInstall || desktopUpdateState.installInProgress}
                className="h-8 rounded-md bg-white px-3 text-xs font-bold text-black hover:bg-[#e4e4e7]"
              >
                {desktopUpdateState.installInProgress
                  ? 'Launching…'
                  : desktopUpdateState.canAutoInstall
                    ? 'Restart to install'
                    : 'Show download'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <StreamGuideModal
          isOpen={isGuideModalOpen}
          onClose={() => setIsGuideModalOpen(false)}
        />

        <Card className="gap-0 overflow-hidden rounded-md border-[#1f1f23] bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-white">Contact &amp; support</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Reach out for help or feedback.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">Email support</Label>
                <p className="text-[11px] text-[#71717a]">samuellucky2424@gmail.com</p>
              </div>
              <Button
                onClick={() => { window.open('mailto:samuellucky2424@gmail.com', '_blank'); }}
                variant="outline"
                className="h-8 rounded-md border-[#27272a] bg-transparent px-3 text-xs text-[#a1a1aa] hover:bg-[#27272a] hover:text-white"
              >
                Send email
              </Button>
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">WhatsApp</Label>
                <p className="text-[11px] text-[#71717a]">+234 703 819 5038</p>
              </div>
              <Button
                onClick={() => { window.open('https://wa.me/2347038195038', '_blank'); }}
                variant="outline"
                className="h-8 rounded-md border-[#27272a] bg-transparent px-3 text-xs text-[#a1a1aa] hover:bg-[#27272a] hover:text-white"
              >
                Open WhatsApp
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 overflow-hidden rounded-md border-red-500/20 bg-[#0f0f10] shadow-none">
          <CardHeader className="border-b border-[#1f1f23] px-4 py-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-white">Danger zone</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Irreversible actions.</CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-white">Sign out</Label>
                <p className="text-[11px] text-[#71717a]">Sign out of your account on this device.</p>
              </div>
              <Button
                onClick={logout}
                variant="outline"
                className="h-8 rounded-md border-red-500/30 bg-transparent px-3 text-xs text-red-200 hover:bg-red-500/10 hover:text-red-100"
              >
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default Settings;
