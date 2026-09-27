#requires -Version 7
param(
    [Parameter(Mandatory)][string]$Tag,
    [string]$InputDirectory = (Join-Path $PSScriptRoot 'plugins'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts/release')
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw "无效 Release tag：$Tag" }
$packages = @(Get-ChildItem -LiteralPath $InputDirectory -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath (Join-Path $_.FullName 'dist') -Directory -ErrorAction SilentlyContinue
} | Sort-Object Name)
if ($packages.Count -eq 0) { throw '没有可发布的插件目录。' }
if ((Test-Path -LiteralPath $OutputDirectory) -and @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -ne 0) {
    throw "Release 输出目录不为空：$OutputDirectory"
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$seen = @{}
$entries = foreach ($package in $packages) {
    $manifest = Get-Content -LiteralPath (Join-Path $package.FullName 'plugin.json') -Raw | ConvertFrom-Json
    $id = [string]$manifest.id
    if ($id -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or $id -cne $package.Name) { throw "插件 ID 与目录不一致：$($package.FullName)" }
    if ($seen.ContainsKey($id)) { throw "插件 ID 重复：$id" }
    $seen[$id] = $true
    if ($manifest.runtime -ne 'jint' -or -not $manifest.version -or [string]::IsNullOrWhiteSpace([string]$manifest.description)) {
        throw "插件清单缺少运行时、版本或描述：$id"
    }
    $asset = "$id.zip"
    $archive = Join-Path $OutputDirectory $asset
    Compress-Archive -LiteralPath $package.FullName -DestinationPath $archive
    $content = @(Get-ChildItem -LiteralPath $package.FullName -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($package.FullName, $_.FullName).Replace('\', '/')
        "$relative $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
    }) -join "`n"
    [pscustomobject]@{
        id = $id
        name = [string]$manifest.name
        description = ([string]$manifest.description).Trim()
        runtime = 'jint'
        version = [string]$manifest.version
        asset = $asset
        sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        contentSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($content))).ToLowerInvariant()
        sizeBytes = (Get-Item -LiteralPath $archive).Length
    }
}
@{ schemaVersion = 1; tag = $Tag; plugins = @($entries) } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'release-index.json') -Encoding utf8NoBOM
$notes = @("# $Tag 插件", '')
foreach ($entry in @($entries)) {
    $notes += "## $($entry.name) ($($entry.id))"
    $notes += $entry.description
    $notes += "版本：$($entry.version) · 运行时：$($entry.runtime) · 下载：$($entry.asset)"
    $notes += ''
}
$notes | Set-Content -LiteralPath (Join-Path $OutputDirectory 'release-notes.md') -Encoding utf8NoBOM
