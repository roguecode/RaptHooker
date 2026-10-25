<#
.SYNOPSIS
  Builds RaptHooker on this PC and installs it on a Raspberry Pi over SSH.

.EXAMPLE
  .\deploy\deploy.ps1 -PiHost raspberrypi.local -Setup       # first time: also runs setup.sh (renames the Pi to rapthooker)
  .\deploy\deploy.ps1                                         # updates (to rapthooker.local)
  .\deploy\deploy.ps1 -PiHost mypi.local -Setup -SetupArgs '--keep-hostname'
#>
param(
  [string]$PiHost = 'rapthooker.local',
  [string]$User = 'pi',
  [switch]$Setup,
  [string]$SetupArgs = '',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

# Native tools write progress to stderr; judge them by their exit code only. SSH/SCP exit with 255 when they couldn't
# connect at all (e.g. a .local name that didn't resolve this time), so those are retried.
function Invoke-Native([string]$What, [scriptblock]$Command, [int]$Attempts = 1) {
  for ($try = 1; ; $try++) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $Command 2>&1 | ForEach-Object { "$_" }
      $code = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previous
    }
    if ($code -eq 0) { return }
    if ($code -ne 255 -or $try -ge $Attempts) { throw "$What failed (exit code $code)" }
    Write-Host "$What couldn't connect; trying again..."
    Start-Sleep -Seconds 5
  }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not $SkipBuild) { Invoke-Native 'Build' { npm run build } }

  $stage = Join-Path $root 'release\rapthooker'
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force "$stage\server", "$stage\web", "$stage\deploy" | Out-Null
  Copy-Item src\server\dist\*.cjs "$stage\server\"
  Copy-Item -Recurse src\web\dist "$stage\web\dist"
  Copy-Item -Recurse deploy\pi "$stage\deploy\pi"
  # The app's "Switch to release" runs this (through update.sh), as on a hub set up with the installer.
  Copy-Item deploy\install.sh "$stage\deploy\install.sh"
  # Scripts and unit files need LF line endings on the Pi.
  Get-ChildItem "$stage\deploy" -File -Recurse | ForEach-Object {
    $text = [IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($_.FullName, $text, [Text.UTF8Encoding]::new($false))
  }

  $archive = Join-Path $root 'release\rapthooker.tgz'
  Invoke-Native 'Packaging' { tar -czf $archive -C $stage . }

  $target = "$User@$PiHost"
  Write-Host "Copying to $target..."
  Invoke-Native 'scp' { scp $archive "${target}:/tmp/rapthooker.tgz" } -Attempts 5

  # Unpack next to the running version and swap folders, so the service is down for as short a time as possible.
  # A development build isn't a release: the installer's marker goes and .dev-build goes in, so the app says it's a
  # development build and doesn't offer updates (only a switch back to the latest release, if you ask for it).
  $remote = 'set -e; sudo mkdir -p /opt/rapthooker; sudo rm -rf /opt/rapthooker.new; sudo mkdir /opt/rapthooker.new; ' +
    'sudo tar -xzf /tmp/rapthooker.tgz -C /opt/rapthooker.new --no-same-owner --no-same-permissions; rm /tmp/rapthooker.tgz; ' +
    'sudo chown -R root:root /opt/rapthooker.new; sudo chmod -R u=rwX,go=rX /opt/rapthooker.new; ' +
    'for d in server web deploy; do sudo rm -rf /opt/rapthooker/$d.old; if [ -e /opt/rapthooker/$d ]; then sudo mv /opt/rapthooker/$d /opt/rapthooker/$d.old; fi; sudo mv /opt/rapthooker.new/$d /opt/rapthooker/$d; done; ' +
    'sudo rm -rf /opt/rapthooker.new /opt/rapthooker/server.old /opt/rapthooker/web.old /opt/rapthooker/deploy.old; ' +
    'sudo rm -f /opt/rapthooker/.installer /opt/rapthooker/VERSION; ' +
    'echo deployed from source by deploy.ps1, not a release | sudo tee /opt/rapthooker/.dev-build >/dev/null; '
  if ($Setup) { $remote += "sudo bash /opt/rapthooker/deploy/pi/setup.sh $SetupArgs; " }
  $remote += 'if [ -f /etc/systemd/system/rapthooker.service ]; then sudo systemctl restart rapthooker; sleep 4; systemctl --no-pager --lines=12 status rapthooker; else echo "Run with -Setup first"; fi'
  Invoke-Native 'Install on the Pi' { ssh $target $remote } -Attempts 5
}
finally {
  Pop-Location
}
