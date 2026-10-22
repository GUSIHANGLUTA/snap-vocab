<#
.SYNOPSIS
  在桌面创建「截图背单词」快捷方式（双击启动本机服务并自动打开浏览器）。

.DESCRIPTION
  快捷方式指向 cmd.exe，参数是 启动截图背单词.cmd，所以效果和双击那个 .cmd 一样：
  起服务 → 浏览器自动打开 http://127.0.0.1:8910；关掉控制台窗口即停止。

  默认只预览将要创建的内容，加 -Apply 才真正写文件（和仓库里其他脚本的约定一致）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Apply
  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Remove -Apply
#>

[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Remove,
  [string]$Name = '截图背单词'
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $appRoot '启动截图背单词.cmd'
$icon = Join-Path $appRoot 'assets\app.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop "$Name.lnk"

Write-Host '========================================================' -ForegroundColor Cyan
Write-Host " 桌面快捷方式：$Name" -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "快捷方式 : $linkPath"
Write-Host "启动脚本 : $launcher"
Write-Host "图标     : $(if (Test-Path $icon) { $icon } else { '(没有 assets\app.ico，用默认图标)' })"
Write-Host "工作目录 : $appRoot"
Write-Host ''

if (-not (Test-Path $launcher)) {
  throw "找不到启动脚本：$launcher"
}

if ($Remove) {
  if (-not $Apply) {
    Write-Host '预览模式：加 -Apply 才会真的删除下面这个快捷方式。' -ForegroundColor Yellow
    Write-Host "  $linkPath"
    exit 0
  }
  if (Test-Path $linkPath) {
    Remove-Item $linkPath -Force
    Write-Host "已删除：$linkPath" -ForegroundColor Green
  } else {
    Write-Host "不存在，无需删除：$linkPath" -ForegroundColor Yellow
  }
  exit 0
}

if (-not $Apply) {
  Write-Host '当前是「预览模式」，没有对系统做任何修改。' -ForegroundColor Green
  Write-Host '确认后加 -Apply 真正创建：'
  Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -Apply'
  Write-Host ''
  Write-Host '效果：桌面上出现「截图背单词」，双击 → 起服务 → 浏览器自动打开 http://127.0.0.1:8910。'
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = $env:ComSpec
$link.Arguments = "/c `"$launcher`""
$link.WorkingDirectory = $appRoot
$link.Description = '截图背单词：粘贴英文截图 → 点选单词 → 自动整理词性中文 → 导出不背单词'
if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
$link.WindowStyle = 1
$link.Save()

if (-not (Test-Path $linkPath)) {
  throw "快捷方式创建失败：$linkPath"
}

$check = $shell.CreateShortcut($linkPath)
Write-Host "已创建：$linkPath" -ForegroundColor Green
Write-Host "  目标：$($check.TargetPath) $($check.Arguments)"
Write-Host "  图标：$($check.IconLocation)"
Write-Host ''
Write-Host '双击桌面图标即可启动；关掉弹出的控制台窗口即停止服务。'
