<#
Despliega una función del hub con sus flags de capacidad EXPLÍCITOS (tarea 1.25).

    .\dev\deploy.ps1 -Function actions-execute -Project ambiente-desarrollo-ti
    .\dev\deploy.ps1 -All -Project ambiente-desarrollo-ti -DryRun        muestra los comandos sin ejecutarlos

Por qué existe: un `gcloud functions deploy` que omite un flag lo vuelve al default de GCP (concurrencia 1, pocas instancias, 60 s de
timeout). Aquí cada función lleva TODOS sus valores en una tabla, y después de desplegar se lee de vuelta lo que quedó en la revisión.

- `-Project` es obligatorio y no tiene default: el proyecto activo de gcloud en esta máquina NO es el del hub, nunca se confía en él.
- Variables de entorno: si existe `dev\env\<nombre>.yaml` (o `-EnvVarsFile`) se aplican TODAS desde ese archivo (reemplaza las que la función
  tenga); si no existe, no se tocan. Plantillas y qué va en cada una: `dev\env\README.md`. No despliega con valores `<...>` sin llenar.
- Los valores de la tabla son una propuesta (300/40 es el de la tarea 1.25 para las funciones del camino del mensaje): ajústalos aquí,
  en un solo lugar. `--concurrency` mayor a 1 exige `--cpu` 1 o más y `--memory` de 512Mi o más; sin eso el despliegue falla.
- `jobs-run` va con `--max-instances=1` Y `--concurrency=1`: con concurrencia 40 una sola instancia atendería dos ticks a la vez.
#>
[CmdletBinding()]
param(
    [string]$Function,
    [switch]$All,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Project,
    [string]$Region = 'us-central1',
    [string]$EnvVarsFile,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Nombre corto -> entry point de main.py y capacidad. El nombre desplegado es `hub-<nombre>`.
$Functions = [ordered]@{
    'router'               = @{ Entry = 'router';               Timeout = 540; Max = 300; Concurrency = 40; Cpu = '1'; Memory = '1Gi';   NoCpuThrottling = $true }
    'queue-incoming'       = @{ Entry = 'queue_incoming';       Timeout = 540; Max = 300; Concurrency = 40; Cpu = '1'; Memory = '1Gi' }
    'bot'                  = @{ Entry = 'bot';                  Timeout = 300; Max = 300; Concurrency = 40; Cpu = '1'; Memory = '1Gi' }
    'actions-execute'      = @{ Entry = 'actions_execute';      Timeout = 120; Max = 300; Concurrency = 40; Cpu = '1'; Memory = '512Mi' }
    'user-actions-execute' = @{ Entry = 'user_actions_execute'; Timeout = 900; Max = 50;  Concurrency = 20; Cpu = '1'; Memory = '512Mi' }
    'situacion-detectada'  = @{ Entry = 'situacion_detectada';  Timeout = 60;  Max = 50;  Concurrency = 40; Cpu = '1'; Memory = '512Mi' }
    'close-by-phone'       = @{ Entry = 'close_by_phone';       Timeout = 60;  Max = 50;  Concurrency = 40; Cpu = '1'; Memory = '512Mi' }
    'inactivity-followup'  = @{ Entry = 'inactivity_followup';  Timeout = 540; Max = 10;  Concurrency = 1;  Cpu = '1'; Memory = '512Mi' }
    'jobs-run'             = @{ Entry = 'jobs_run';             Timeout = 540; Max = 1;   Concurrency = 1;  Cpu = '1'; Memory = '512Mi' }
}

if ($All -eq [bool]$Function) { throw 'Indica -Function <nombre> o -All (una de las dos).' }
$targets = if ($All) { @($Functions.Keys) } else { @($Function) }
foreach ($t in $targets) {
    if (-not $Functions.Contains($t)) { throw "Función desconocida '$t'. Opciones: $($Functions.Keys -join ', ')" }
}

function Invoke-Gcloud([string[]]$GcloudArgs) {
    Write-Host ("gcloud " + ($GcloudArgs -join ' ')) -ForegroundColor DarkGray
    if ($DryRun) { return }
    & gcloud @GcloudArgs
    if ($LASTEXITCODE -ne 0) { throw "gcloud falló (código $LASTEXITCODE)" }
}

foreach ($name in $targets) {
    $f = $Functions[$name]
    $deployed = "hub-$name"
    Write-Host "`n== $deployed ==" -ForegroundColor Cyan

    $deployArgs = @(
        'functions', 'deploy', $deployed, '--gen2', '--runtime=python311', "--region=$Region", '--source=.',
        "--entry-point=$($f.Entry)", '--trigger-http', '--allow-unauthenticated', "--project=$Project",
        "--timeout=$($f.Timeout)", "--max-instances=$($f.Max)", "--concurrency=$($f.Concurrency)",
        "--cpu=$($f.Cpu)", "--memory=$($f.Memory)"
    )
    # Variables de entorno: `-EnvVarsFile` manda; si no, `dev\env\<nombre>.yaml` (fuera de git; plantilla: `<nombre>.example.yaml`).
    # Ese archivo REEMPLAZA todas las variables de la función, así que debe traer el conjunto completo. Sin archivo no se tocan.
    $envFile = if ($EnvVarsFile) { $EnvVarsFile } else { Join-Path $PSScriptRoot "env\$name.yaml" }
    if (Test-Path $envFile) {
        if (Get-Content $envFile | Where-Object { $_ -notmatch '^\s*#' } | Select-String -Pattern '<[^>]+>' -Quiet) { throw "$envFile todavía tiene valores <...> sin llenar." }
        $deployArgs += "--env-vars-file=$envFile"
    } elseif ($EnvVarsFile) { throw "No existe $EnvVarsFile" }
    else { Write-Host "(sin dev\env\$name.yaml: se conservan las variables de entorno que la función ya tenga)" -ForegroundColor Yellow }
    Invoke-Gcloud $deployArgs

    if ($f.NoCpuThrottling) {
        # El hilo sigue trabajando después de responder 200; un redeploy puede restablecer esto, por eso va siempre tras el deploy
        Invoke-Gcloud @('run', 'services', 'update', $deployed, "--region=$Region", "--project=$Project", '--no-cpu-throttling')
    }

    # Lo que realmente quedó en la revisión, para comprobar que nada volvió a un default
    Invoke-Gcloud @('functions', 'describe', $deployed, '--gen2', "--region=$Region", "--project=$Project",
        '--format=table(serviceConfig.timeoutSeconds:label=TIMEOUT,serviceConfig.maxInstanceCount:label=MAX_INST,serviceConfig.maxInstanceRequestConcurrency:label=CONCURRENCY,serviceConfig.availableCpu:label=CPU,serviceConfig.availableMemory:label=MEMORY)')
}
