# Writes an API key into C:\dev\callsign\.env without you opening the file.
# Usage:  powershell -ExecutionPolicy Bypass -File C:\dev\callsign\scripts\set-key.ps1 [gemini|elevenlabs|github]
param([string]$Which = "gemini")

$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (-not (Test-Path $envPath)) { Copy-Item (Join-Path (Split-Path $PSScriptRoot -Parent) ".env.example") $envPath }

switch ($Which.ToLower()) {
  "gemini"     { $var = "GEMINI_API_KEY";    $mode = @{ name = "LLM_MODE"; value = "real" }; $hint = "Paste your Gemini API key (starts with AIza)" }
  "elevenlabs" { $var = "ELEVENLABS_API_KEY"; $mode = $null; $hint = "Paste your ElevenLabs API key" }
  "github"     { $var = "GITHUB_TOKEN";       $mode = $null; $hint = "Paste your GitHub token (starts with ghp_)" }
  default      { Write-Host "Unknown: $Which. Use gemini, elevenlabs or github."; exit 1 }
}

$key = Read-Host $hint
$key = $key.Trim().Trim('"').Trim("'")
if (-not $key) { Write-Host "Nothing entered. Nothing changed."; exit 1 }

$lines = Get-Content $envPath
$out = @()
$setVar = $false; $setMode = $false
foreach ($line in $lines) {
  if ($line -match "^\s*$var=") { $out += "$var=$key"; $setVar = $true; continue }
  if ($mode -and $line -match "^\s*$($mode.name)=") { $out += "$($mode.name)=$($mode.value)"; $setMode = $true; continue }
  $out += $line
}
if (-not $setVar) { $out += "$var=$key" }
if ($mode -and -not $setMode) { $out += "$($mode.name)=$($mode.value)" }
[System.IO.File]::WriteAllLines($envPath, $out)

Write-Host ""
Write-Host "Saved $var to $envPath ($($key.Length) characters)."
if ($mode) { Write-Host "Set $($mode.name)=$($mode.value)." }
Write-Host "Restart the app (npm run dev) to pick it up."
