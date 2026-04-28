Param([switch]$DryRun,[switch]$Force)
& "$PSScriptRoot\maintenance\cleanup.ps1" @PSBoundParameters
