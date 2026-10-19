# Builds dist/trikaal-<version>.zip containing ONLY the files the extension needs.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File scripts/package.ps1
#
# Compress-Archive in Windows PowerShell 5.1 writes backslash paths into the zip, which the
# Chrome Web Store and other tools can mishandle, so entries are written with forward slashes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $out | Out-Null
$zipPath = Join-Path $out ("trikaal-{0}.zip" -f $manifest.version)
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Everything that ships. Tests, docs, scripts and editor files are deliberately absent.
$include = @('manifest.json', 'background', 'content', 'popup', 'shared', 'icons')

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($item in $include) {
    $path = Join-Path $root $item
    $files = if ((Get-Item $path).PSIsContainer) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal')
    }
  }
} finally {
  $zip.Dispose()
}
$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "Created $zipPath ($size KB)"
