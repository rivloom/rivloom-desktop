$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module "$PSHOME\Modules\NetSecurity\NetSecurity.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\NetConnection\NetConnection.psd1" -ErrorAction Stop
Import-Module "$PSHOME\Modules\NetTCPIP\NetTCPIP.psd1" -ErrorAction Stop
$program = [string]$config.program
$group = 'Rivloom LAN ' + $config.key
$names = @(('Rivloom-LAN-' + $config.key + '-TCP'), ('Rivloom-LAN-' + $config.key + '-UDP'))
$connections = @(Get-NetConnectionProfile)
$active = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
$rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound)
# CIM filter InstanceID is the rule InstanceID. Read each class once instead of
# making hundreds of per-rule RPCs on machines with many installed programs.
function Index-ByID($items) { $result=@{}; foreach($item in $items) { $result[[string]$item.InstanceID]=$item }; return $result }
$apps = Index-ByID (Get-NetFirewallApplicationFilter -PolicyStore ActiveStore)
$rules = @($rules | Where-Object {
    $app = $apps[[string]$_.InstanceID]
    # On current Windows the application filter can say Program=Any and have
    # no Package SID, while PackageFamilyName on the rule scopes it to a system
    # app container. Rivloom's bundled node.exe is an unpackaged executable.
    ($app.Program -ieq $program -or $app.Program -eq 'Any') -and
        (!$app.Package -or $app.Package -eq 'Any') -and
        (!$_.PackageFamilyName -or $_.PackageFamilyName -eq 'Any')
})
# Query the associated filters, not the complete protected filter classes:
# standard users can read associated rule data without admin elevation.
$ports = Index-ByID ($rules | Get-NetFirewallPortFilter)
$addresses = Index-ByID ($rules | Get-NetFirewallAddressFilter)
$services = Index-ByID ($rules | Get-NetFirewallServiceFilter)
$interfaces = Index-ByID ($rules | Get-NetFirewallInterfaceFilter)
$interfaceTypes = Index-ByID ($rules | Get-NetFirewallInterfaceTypeFilter)
$securityFilters = Index-ByID ($rules | Get-NetFirewallSecurityFilter)
$candidates = @()
foreach ($rule in $rules) {
    $id = [string]$rule.InstanceID
    $app = $apps[$id]
    if ($app.Program -ine $program -and $app.Program -ne 'Any') { continue }
    $port = $ports[$id]
    if (@('TCP', 'UDP', 'Any', '6', '17', '256') -notcontains [string]$port.Protocol) { continue }
    $address = $addresses[$id]
    $service = $services[$id]
    $iface = $interfaces[$id]
    $ifaceType = $interfaceTypes[$id]
    $security = $securityFilters[$id]
    $candidates += [pscustomobject]@{ rule=$rule; port=$port; address=$address; app=$app; service=$service; iface=$iface; ifaceType=$ifaceType; security=$security }
}
function Port-Matches($ports, [int]$wanted) {
    foreach ($entry in @($ports)) {
        if ($entry -eq 'Any') { return $true }
        if ($wanted -gt 0 -and $entry -eq [string]$wanted) { return $true }
        if ($wanted -gt 0 -and $entry -match '^(\d+)-(\d+)$' -and $wanted -ge [int]$Matches[1] -and $wanted -le [int]$Matches[2]) { return $true }
    }
    return $false
}
function Coverage($policy, [int]$mask, [string]$protocol, [int]$wanted) {
    if ([string]$policy.Enabled -eq 'False') { return 'disabled' }
    if ([string]$policy.AllowInboundRules -eq 'False') { return 'policy_blocked' }
    $allowed = $false; $restricted = $false; $blocked = $false
    foreach ($item in $candidates) {
        $r = $item.rule; $p = $item.port
        if ([int]$r.Profile -ne 0 -and ([int]$r.Profile -band $mask) -eq 0) { continue }
        $expected = if ($protocol -eq 'TCP') { @('TCP','6','Any','256') } else { @('UDP','17','Any','256') }
        if ($expected -notcontains [string]$p.Protocol -or !(Port-Matches $p.LocalPort $wanted)) { continue }
        if ($r.PolicyStoreSourceType -eq 'Local' -and [string]$policy.AllowLocalFirewallRules -eq 'False') { continue }
        if ($r.Action -eq 'Block') { $blocked = $true; continue }
        if ($r.Action -ne 'Allow') { continue }
        # Green requires unqualified local-subnet coverage. Any condition we
        # cannot prove satisfied remains restricted, never a false all-clear.
        $broad = (@($item.address.RemoteAddress) -contains 'Any' -or @($item.address.RemoteAddress) -contains 'LocalSubnet') -and
            (!$item.app.Package -or $item.app.Package -eq 'Any') -and
            (!$r.PolicyAppId) -and
            @($item.address.LocalAddress) -contains 'Any' -and @($p.RemotePort) -contains 'Any' -and
            $item.service.Service -eq 'Any' -and @($item.iface.InterfaceAlias) -contains 'Any' -and
            $item.ifaceType.InterfaceType -eq 'Any' -and $item.security.Authentication -eq 'NotRequired' -and
            $item.security.LocalUser -eq 'Any' -and $item.security.RemoteUser -eq 'Any' -and $item.security.RemoteMachine -eq 'Any'
        if ($broad) { $allowed = $true } else { $restricted = $true }
    }
    if ($blocked) { return 'block_rule' }
    if ($allowed -or [string]$policy.DefaultInboundAction -eq 'Allow') { return 'allowed' }
    if ([string]$policy.AllowLocalFirewallRules -eq 'False') { return 'policy_blocked' }
    if ($restricted) { return 'restricted' }
    return 'missing'
}
$profiles = @()
foreach ($category in @($connections | Select-Object -ExpandProperty NetworkCategory -Unique)) {
    $name = if ([string]$category -eq 'DomainAuthenticated') { 'Domain' } else { [string]$category }
    $mask = switch ($name) { 'Domain' {1} 'Private' {2} 'Public' {4} default {0} }
    $policy = @($active | Where-Object Name -eq $name)
    if ($mask -eq 0 -or $policy.Count -ne 1) { continue }
    $profiles += [pscustomobject]@{ name=$name; tcp=(Coverage $policy[0] $mask 'TCP' ([int]$config.port)); udp=(Coverage $policy[0] $mask 'UDP' 43531); mdns=(Coverage $policy[0] $mask 'UDP' 5353) }
}
$owned = @(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object { $names -contains $_.Name -and $_.Group -eq $group -and $_.Description -eq ('Rivloom managed LAN access v1; ' + $config.key) } | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -ieq $program })
$listener = 'unknown'
if ([int]$config.port -gt 0 -and [int]$config.processId -gt 0) {
    $listening = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq [int]$config.port -and $_.OwningProcess -eq [int]$config.processId })
    $listener = if (@($listening | Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' }).Count -gt 0) { 'ready' } elseif ($listening.Count -gt 0) { 'limited' } else { 'missing' }
}
[pscustomobject]@{ checkedAt=[DateTime]::UtcNow.ToString('o'); program=$program; runtimeExists=(Test-Path -LiteralPath $program -PathType Leaf); listener=$listener; profiles=@($profiles); managedRuleCount=$owned.Count; managedPublic=(@($owned | Where-Object { ([int]$_.Profile -band 4) -ne 0 -or [int]$_.Profile -eq 0 }).Count -gt 0) } | ConvertTo-Json -Depth 5 -Compress
