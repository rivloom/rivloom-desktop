# Isolated contract tests for the exact embedded scripts. All NetSecurity and
# networking cmdlets are mocked; this script never modifies Windows Firewall.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$script:rules = @()
$script:category = 'Public'
$script:enabled = 'True'
$script:localAllowed = 'True'
$script:inboundAllowed = 'True'
$script:listenerExists = $true
$config = [pscustomobject]@{program='C:\Users\Test\Rivloom\runtime\node.exe'; key='isolated-contract'; action='repair'; allowPublic=$false; port=55915; processId=5776}
function Import-Module { param($Name, $ErrorAction) }
function Test-Path { param($LiteralPath, $PathType) return $true }
function Get-NetConnectionProfile { [pscustomobject]@{NetworkCategory=$script:category} }
function Get-NetFirewallProfile { param($PolicyStore) @('Private','Public','Domain') | ForEach-Object { [pscustomobject]@{Name=$_;Enabled=$script:enabled;AllowLocalFirewallRules=$script:localAllowed;AllowInboundRules=$script:inboundAllowed;DefaultInboundAction='Block'} } }
function Get-NetFirewallRule { param($PolicyStore,$Enabled,$Direction) $script:rules | Where-Object { !$Enabled -or $_.Enabled -eq $Enabled } }
function Mock-Filter($kind,$inputRule) {
    $items=if($null -eq $inputRule){$script:rules}else{@($inputRule)}
    foreach($item in $items){
        $value=@{InstanceID=$item.Name}
        switch($kind){
            'app' {$value.Program=$item.Program;$value.Package=$item.Package}
            'port' {$value.Protocol=$item.Protocol;$value.LocalPort=$item.LocalPort;$value.RemotePort='Any'}
            'address' {$value.RemoteAddress=$item.RemoteAddress;$value.LocalAddress='Any'}
            'service' {$value.Service='Any'}
            'interface' {$value.InterfaceAlias='Any'}
            'interfaceType' {$value.InterfaceType='Any'}
            'security' {$value.Authentication='NotRequired';$value.LocalUser='Any';$value.RemoteUser='Any';$value.RemoteMachine='Any'}
        }
        [pscustomobject]$value
    }
}
function Get-NetFirewallApplicationFilter { param($PolicyStore) process { Mock-Filter app $_ } }
function Get-NetFirewallPortFilter { param($PolicyStore) process { Mock-Filter port $_ } }
function Get-NetFirewallAddressFilter { param($PolicyStore) process { Mock-Filter address $_ } }
function Get-NetFirewallServiceFilter { param($PolicyStore) process { Mock-Filter service $_ } }
function Get-NetFirewallInterfaceFilter { param($PolicyStore) process { Mock-Filter interface $_ } }
function Get-NetFirewallInterfaceTypeFilter { param($PolicyStore) process { Mock-Filter interfaceType $_ } }
function Get-NetFirewallSecurityFilter { param($PolicyStore) process { Mock-Filter security $_ } }
function Get-NetTCPConnection { param($State,$ErrorAction) if ($script:listenerExists) { [pscustomobject]@{LocalPort=55915;OwningProcess=5776;LocalAddress='0.0.0.0'} } }
function Profile-Mask($Profile) { $mask=0; foreach($p in $Profile){$mask=$mask -bor $(switch($p){'Private'{2}'Public'{4}'Domain'{1}})}; return $mask }
function New-NetFirewallRule {
    param($PolicyStore,$Name,$DisplayName,$Group,$Description,$Enabled,$Direction,$Action,$Program,$Protocol,$LocalPort,$RemoteAddress,$Profile,$EdgeTraversalPolicy)
    $script:rules += [pscustomobject]@{Name=$Name;InstanceID=$Name;Group=$Group;Description=$Description;Enabled=$Enabled;Direction=$Direction;Action=$Action;Program=$Program;Protocol=$Protocol;LocalPort=$LocalPort;RemoteAddress=$RemoteAddress;Profile=(Profile-Mask $Profile);PolicyStoreSourceType='Local'}
}
function Set-NetFirewallRule {
    param($Enabled,$Direction,$Action,$Program,$Protocol,$LocalPort,$RemotePort,$LocalAddress,$RemoteAddress,$Profile,$EdgeTraversalPolicy,$InterfaceType,$InterfaceAlias,$Service)
    process { $_.Enabled=$Enabled; $_.Action=$Action; $_.Program=$Program; $_.Protocol=$Protocol; $_.LocalPort=$LocalPort; $_.RemoteAddress=$RemoteAddress; $_.Profile=(Profile-Mask $Profile) }
}
function Remove-NetFirewallRule { process { $name=$_.Name; $script:rules=@($script:rules | Where-Object Name -ne $name) } }
function Assert($condition,$label) { if (!$condition) { throw "FAIL: $label" }; Write-Output "PASS: $label" }
$inspectText = [IO.File]::ReadAllText((Join-Path $root 'src-tauri/src/lan_firewall_inspect.ps1'))
$ruleText = [IO.File]::ReadAllText((Join-Path $root 'src-tauri/src/lan_firewall_rules.ps1')).Replace('exit (Invoke-RivloomManagedRules)','')
function Inspect { & ([scriptblock]::Create($inspectText)) | ConvertFrom-Json }
. ([scriptblock]::Create($ruleText))
$value=Inspect
Assert ($value.listener -eq 'ready' -and $value.profiles[0].tcp -eq 'missing') 'Public listener with no matching rule remains missing'
# Current Windows can put the app-container scope on the rule itself while
# its application filter reports Program=Any and a blank Package property.
New-NetFirewallRule -Name packaged-system-app -Program Any -Enabled True -Direction Inbound -Action Allow -Protocol Any -LocalPort Any -RemoteAddress Any -Profile Public
$script:rules[0] | Add-Member -NotePropertyName PackageFamilyName -NotePropertyValue 'Microsoft.Win32WebViewHost_cw5n1h2txyewy'
$value=Inspect
Assert ($value.profiles[0].tcp -eq 'missing' -and $value.profiles[0].udp -eq 'missing' -and $value.profiles[0].mdns -eq 'missing') 'System package-family allow does not cover unpackaged runtime'
$script:rules[0].Action='Block'
Assert ((Inspect).profiles[0].tcp -eq 'missing') 'Unrelated package-family block does not block unpackaged runtime'
$script:rules[0].Action='Allow'; $script:rules[0].PackageFamilyName=''
$script:rules[0] | Add-Member -NotePropertyName Package -NotePropertyValue 'S-1-15-2-1234'
Assert ((Inspect).profiles[0].tcp -eq 'missing') 'Package SID scope also excludes an unrelated application'
$script:rules[0].Package='Any'
Assert ((Inspect).profiles[0].tcp -eq 'allowed') 'Unscoped all-program rule still covers runtime'
$script:rules[0] | Add-Member -NotePropertyName PolicyAppId -NotePropertyValue 'organization-app-tag'
Assert ((Inspect).profiles[0].tcp -eq 'restricted') 'Unverified application tag is not advertised as broad coverage'
$script:rules=@()
New-NetFirewallRule -Name manual-shell -Program 'C:\Users\Test\Rivloom\Rivloom.exe' -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort Any -RemoteAddress Any -Profile Public
Assert ((Inspect).profiles[0].tcp -eq 'missing') 'Outer shell allow does not cover runtime node'
Assert ((Invoke-RivloomManagedRules) -eq 0) 'Repair creates owned rules'
Assert ($script:rules.Count -eq 3) 'Manual rule preserved and two managed rules added'
Assert ((Inspect).profiles[0].tcp -eq 'missing') 'Public is not silently authorized'
$script:category='Private'; $value=Inspect
Assert ($value.profiles[0].tcp -eq 'allowed' -and $value.profiles[0].udp -eq 'allowed' -and $value.profiles[0].mdns -eq 'allowed') 'Private TCP and both discovery ports covered'
Assert ((Invoke-RivloomManagedRules) -eq 0 -and $script:rules.Count -eq 3) 'Repeated repair has no duplicates'
$config.allowPublic=$true; Assert ((Invoke-RivloomManagedRules) -eq 0) 'Explicit Public grant works'
$script:category='Public'; Assert ((Inspect).profiles[0].tcp -eq 'allowed') 'Public scope verified after consent'
$config.allowPublic=$false; Assert ((Invoke-RivloomManagedRules) -eq 0 -and (Inspect).managedPublic) 'Prior explicit Public consent retained'
$script:rules[1].RemoteAddress='192.168.5.33'; Assert ((Inspect).profiles[0].tcp -eq 'restricted') 'One-peer rule is not advertised as all-LAN coverage'
$script:rules[1].RemoteAddress='LocalSubnet'; $script:localAllowed='False'
Assert ((Inspect).profiles[0].tcp -eq 'policy_blocked') 'Policy denying local rules cannot report local allow success'
$script:localAllowed='True'; $script:inboundAllowed='False'
Assert ((Inspect).profiles[0].tcp -eq 'policy_blocked') 'Block-all inbound policy wins'
$script:inboundAllowed='True'; $script:rules[1].Action='Block'
Assert ((Inspect).profiles[0].tcp -eq 'block_rule') 'Explicit block takes precedence'
$script:rules[1].Action='Allow'; $script:enabled='False'
Assert ((Inspect).profiles[0].tcp -eq 'disabled') 'Disabled firewall is recorded, never changed'
$script:enabled='True'; $script:listenerExists=$false
Assert ((Inspect).listener -eq 'missing') 'No owned listener is reported separately'
$script:rules[1].Group='foreign'; Assert ((Invoke-RivloomManagedRules) -eq 12) 'Name collision refuses overwrite'
$script:rules[1].Group=$group; $config.action='remove'
Assert ((Invoke-RivloomManagedRules) -eq 0 -and $script:rules.Count -eq 1 -and $script:rules[0].Name -eq 'manual-shell') 'Uninstall removes only exact owned rules'
Assert ((Invoke-RivloomManagedRules) -eq 0 -and $script:rules.Count -eq 1) 'Cleanup is idempotent'
