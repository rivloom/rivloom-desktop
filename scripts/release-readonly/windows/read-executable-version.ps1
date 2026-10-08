param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Executable -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected regular executable file' }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
[pscustomobject]@{
  fileVersion = $version.FileVersion
  productVersion = $version.ProductVersion
  productName = $version.ProductName
  fileDescription = $version.FileDescription
} | ConvertTo-Json -Compress
