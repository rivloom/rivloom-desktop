# Embedded in the executable. $config is a base64 JSON literal supplied by Rust,
# never a script path or frontend-provided command. No files are executed/written.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module "$PSHOME\Modules\NetSecurity\NetSecurity.psd1" -ErrorAction Stop
$program = [string]$config.program
$group = 'Rivloom LAN ' + $config.key
$description = 'Rivloom managed LAN access v1; ' + $config.key
$names = @(('Rivloom-LAN-' + $config.key + '-TCP'), ('Rivloom-LAN-' + $config.key + '-UDP'))
function Invoke-RivloomManagedRules {
try {
    $existing = @(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object { $names -contains $_.Name })
    foreach ($rule in $existing) {
        $app = $rule | Get-NetFirewallApplicationFilter
        if ($rule.Group -ne $group -or $rule.Description -ne $description -or $app.Program -ine $program) { return 12 }
    }
    if ($config.action -eq 'remove') {
        foreach ($rule in $existing) { $rule | Remove-NetFirewallRule }
        return 0
    }
    if ($config.action -ne 'repair' -or !(Test-Path -LiteralPath $program -PathType Leaf)) { return 13 }
    $profiles = @('Private', 'Domain')
    # Preserve a prior explicit Public grant; never enable it just because the
    # connected network is Public. A network change does not widen consent.
    if ($config.allowPublic -or @($existing | Where-Object { ([int]$_.Profile -band 4) -ne 0 -or [int]$_.Profile -eq 0 }).Count -gt 0) { $profiles += 'Public' }
    for ($index = 0; $index -lt 2; $index++) {
        $protocol = @('TCP', 'UDP')[$index]
        $ports = if ($index -eq 0) { @('Any') } else { @('43531', '5353') }
        $old = @($existing | Where-Object Name -eq $names[$index])
        if ($old.Count -eq 0) {
            New-NetFirewallRule -PolicyStore PersistentStore -Name $names[$index] -DisplayName "Rivloom LAN $protocol" -Group $group -Description $description -Enabled True -Direction Inbound -Action Allow -Program $program -Protocol $protocol -LocalPort $ports -RemoteAddress LocalSubnet -Profile $profiles -EdgeTraversalPolicy Block | Out-Null
        } else {
            # Only the exact owned rule is reconciled. Explicit administrator
            # block rules and Windows-created/manual rules remain untouched.
            $old | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Program $program -Protocol $protocol -LocalPort $ports -RemotePort Any -LocalAddress Any -RemoteAddress LocalSubnet -Profile $profiles -EdgeTraversalPolicy Block -InterfaceType Any -InterfaceAlias Any -Service Any | Out-Null
        }
    }
    return 0
} catch { return 14 }
}
exit (Invoke-RivloomManagedRules)
