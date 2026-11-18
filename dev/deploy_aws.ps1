<#
.SYNOPSIS
    Empaqueta y despliega una Lambda del hub en AWS (dev o prd). Mismo patrón que toma-unidades-en-taller/deploy.ps1.

.DESCRIPTION
    Todas las Lambdas del hub comparten el mismo paquete (handlers.py + core/, channels/, ai/, crm/, modules/...); cambia solo
    el handler (DISENO_BACKEND_AWS.md §3). Este script es la ÚNICA fuente de handler, tiempo máximo y memoria de cada una
    (tabla $Funciones), como dev/deploy.ps1 lo es en GCP.

    1. Instala requirements-lambda.txt para Linux arm64 / Python 3.12 (pip --platform, sin Docker) y copia el código.
    2. Arma el .zip. Si la función existe, actualiza su código; si no, la crea. Para crearla sin -RolArn copia rol,
       variables (SECRET_NAME, URL_API_DB...) y VPC de hub-entry-point-<ambiente>; lo que se pase por parámetro gana.
    3. Si todo salió bien, elimina el .zip.

    Requiere Python con pip y AWS CLI v2 con sesión iniciada. Para prd pide confirmación.

.PARAMETER Funcion
    Nombre corto de la función (ver $Funciones): entry-point, acciones-usuario, router, msj-entrantes.

.PARAMETER Ambiente
    dev o prd. La función se llama hub-<funcion>-<ambiente>.

.PARAMETER Secret
    Solo al crear: secreto con las variables del ambiente (JSON plano; se guarda en SECRET_NAME, core/entorno.py).

.PARAMETER SecretosPrefijo
    Solo al crear: prefijo de los secretos de números y bots (SECRETOS_PREFIJO; con SECRETOS_EN=aws). Default hub/<ambiente>.

.PARAMETER EnvFile
    Solo al crear: archivo KEY=valor con variables de la función (URL_API_DB, API_GATEWAY_URL...). Las llaves secretas van
    en -Secret, no aquí.

.PARAMETER SubnetIds / SecurityGroupIds
    Solo al crear: VPC para llegar a PostgREST por la red interna (separados por coma). Con salida a internet por NAT.

.EXAMPLE
    .\dev\deploy_aws.ps1 acciones-usuario dev        # la crea con la configuración de hub-entry-point-dev, o la actualiza
    .\dev\deploy_aws.ps1 entry-point dev -SoloEmpaquetar
    .\dev\deploy_aws.ps1 router dev -Var COLA_ENTRANTES_URL=https://sqs.us-east-1.amazonaws.com/<cuenta>/hub-entrantes-dev.fifo,PUBLIC_BASE_URL=https://<api>.execute-api.us-east-1.amazonaws.com/dev
    .\dev\deploy_aws.ps1 entry-point dev -RolArn arn:aws:iam::123:role/hub-lambda -Secret hub/dev/entorno `
        -EnvFile .env.aws.dev -SubnetIds subnet-a,subnet-b -SecurityGroupIds sg-1

    Variables, VPC y secretos solo se fijan al CREAR. En una función existente el script actualiza el código y alinea
    handler, runtime, tiempo y memoria con la tabla; lo demás se cambia con aws lambda update-function-configuration.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('entry-point', 'acciones-usuario', 'router', 'msj-entrantes')]
    [string]$Funcion,

    [Parameter(Mandatory, Position = 1)]
    [ValidateSet('dev', 'prd')]
    [string]$Ambiente,

    [string]$Perfil,
    [string]$Region = 'us-east-1',
    [switch]$SoloEmpaquetar,

    # Solo para crear la función por primera vez
    [string]$RolArn,
    [string]$Secret,
    [string]$SecretosPrefijo,
    [string]$EnvFile,
    [string]$SubnetIds,
    [string]$SecurityGroupIds,
    # Solo al crear: variables propias de la función, además de las copiadas (p. ej. -Var COLA_ENTRANTES_URL=https://...)
    [string[]]$Var
)

$ErrorActionPreference = 'Stop'
$Runtime = 'python3.12'
$Arquitectura = 'arm64'

# Única fuente de handler, tiempo máximo (s) y memoria (MB) de cada Lambda
$Funciones = @{
    'entry-point'      = @{ Handler = 'handlers.entry_point'; Timeout = 60; Memoria = 512 }
    # Detrás del API Gateway: su límite es 29 s
    'acciones-usuario' = @{ Handler = 'handlers.acciones_usuario'; Timeout = 29; Memoria = 512 }
    # Webhooks de los proveedores: valida la firma y publica en SQS. Detrás del API Gateway
    'router'           = @{ Handler = 'handlers.router'; Timeout = 15; Memoria = 512 }
    # Consumidor de la cola hub-entrantes (la Lambda es hub-msj-entrantes-<ambiente>): llama al bot (Abacus, hasta 120 s por llamada). La visibilidad de la cola debe ser >= 6x
    'msj-entrantes'    = @{ Handler = 'handlers.entrantes'; Timeout = 300; Memoria = 512 }
}

# Lo que va en el paquete (el resto del repo: apps/, DB/, tests/, dev/, Arquitectura/... no)
$Codigo = @('handlers.py', 'ai', 'channels', 'contracts', 'core', 'crm', 'integrations', 'jobs', 'modules')

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$conf = $Funciones[$Funcion]
$raiz = Split-Path $PSScriptRoot -Parent
$nombreLambda = "hub-$Funcion-$Ambiente"
$zipPath = Join-Path $raiz "$nombreLambda.zip"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-$nombreLambda-$([guid]::NewGuid())"
$envJson = Join-Path ([System.IO.Path]::GetTempPath()) "env-$nombreLambda-$([guid]::NewGuid()).json"

$awsArgs = @('--region', $Region)
if ($Perfil) { $awsArgs += @('--profile', $Perfil) }

try {
    # 1. Dependencias para Linux arm64 y código
    Write-Host "Empaquetando $nombreLambda..."
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    python -m pip install --quiet --disable-pip-version-check -r (Join-Path $raiz 'requirements-lambda.txt') `
        --target $staging --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { throw "pip install terminó con código $LASTEXITCODE." }

    foreach ($elemento in $Codigo) {
        $origen = Join-Path $raiz $elemento
        if (Test-Path $origen) { Copy-Item $origen -Destination $staging -Recurse -Force }
    }
    Get-ChildItem -Path $staging -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
            $ruta = $_.FullName.Substring($staging.Length + 1) -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $_.FullName, $ruta, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally { $zip.Dispose() }
    $tamano = (Get-Item $zipPath).Length / 1MB
    Write-Host ("Zip generado: {0} ({1:N1} MB)" -f $zipPath, $tamano)
    if ($tamano -gt 50) {
        Write-Warning 'El zip pasa de 50 MB: no se puede subir directo; habría que subirlo a S3 o pasar a imagen de contenedor.'
    }

    if ($SoloEmpaquetar) { return }

    # 2. Despliegue
    if ($Ambiente -eq 'prd') {
        $cuenta = aws sts get-caller-identity --query Account --output text @awsArgs
        if ($LASTEXITCODE -ne 0) { throw 'Sin sesión de AWS.' }
        $resp = Read-Host "Se desplegará '$nombreLambda' en PRODUCCIÓN (cuenta $cuenta). Escriba 'prd' para continuar"
        if ($resp -ne 'prd') { throw 'Cancelado.' }
    }

    $ErrorActionPreference = 'Continue'
    aws lambda get-function --function-name $nombreLambda @awsArgs *> $null
    $existe = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'

    if ($existe) {
        Write-Host "Actualizando '$nombreLambda'..."
        aws lambda update-function-code --function-name $nombreLambda --zip-file "fileb://$zipPath" `
            --architectures $Arquitectura @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "update-function-code terminó con código $LASTEXITCODE." }
        aws lambda wait function-updated --function-name $nombreLambda @awsArgs
        # La tabla manda: handler, runtime, tiempo y memoria
        aws lambda update-function-configuration --function-name $nombreLambda --runtime $Runtime `
            --handler $conf.Handler --timeout $conf.Timeout --memory-size $conf.Memoria @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "update-function-configuration terminó con código $LASTEXITCODE." }
    }
    else {
        $vars = @{}
        if (-not $RolArn) {
            # Sin -RolArn: copia rol, variables y VPC de hub-entry-point-<ambiente> (todas las Lambdas del hub los comparten)
            $modelo = "hub-entry-point-$Ambiente"
            if ($nombreLambda -eq $modelo) { throw "'$nombreLambda' no existe. Para crearla indique -RolArn." }
            Write-Host "'$nombreLambda' no existe: se crea con el rol, las variables y la VPC de '$modelo'."
            $ErrorActionPreference = 'Continue'
            $json = aws lambda get-function-configuration --function-name $modelo @awsArgs
            $ok = ($LASTEXITCODE -eq 0)
            $ErrorActionPreference = 'Stop'
            if (-not $ok) { throw "No se pudo leer '$modelo' para copiar su configuración. Indique -RolArn, -Secret y -EnvFile." }
            $cfg = ($json | Out-String) | ConvertFrom-Json
            $RolArn = $cfg.Role
            if ($cfg.Environment -and $cfg.Environment.Variables) {
                $cfg.Environment.Variables.PSObject.Properties | ForEach-Object { $vars[$_.Name] = $_.Value }
            }
            if (-not $SubnetIds -and $cfg.VpcConfig -and $cfg.VpcConfig.SubnetIds) {
                $SubnetIds = $cfg.VpcConfig.SubnetIds -join ','
                $SecurityGroupIds = $cfg.VpcConfig.SecurityGroupIds -join ','
            }
        }
        $creaArgs = @(
            '--function-name', $nombreLambda, '--runtime', $Runtime, '--architectures', $Arquitectura,
            '--handler', $conf.Handler, '--role', $RolArn,
            '--timeout', "$($conf.Timeout)", '--memory-size', "$($conf.Memoria)", '--zip-file', "fileb://$zipPath"
        )
        if ($SubnetIds -and $SecurityGroupIds) {
            $creaArgs += @('--vpc-config', "SubnetIds=$SubnetIds,SecurityGroupIds=$SecurityGroupIds")
        }

        # Lo que se indique en la línea de comandos gana sobre lo copiado
        $vars.SECRETOS_EN = 'aws'
        if ($SecretosPrefijo) { $vars.SECRETOS_PREFIJO = $SecretosPrefijo }
        elseif (-not $vars.SECRETOS_PREFIJO) { $vars.SECRETOS_PREFIJO = "hub/$Ambiente" }
        if ($Secret) { $vars.SECRET_NAME = $Secret }
        if ($EnvFile) {
            Get-Content $EnvFile | ForEach-Object {
                $linea = $_.Trim()
                if ($linea -and -not $linea.StartsWith('#') -and $linea.Contains('=')) {
                    $i = $linea.IndexOf('=')
                    $llave = $linea.Substring(0, $i).Trim()
                    $valor = $linea.Substring($i + 1).Trim().Trim('"')
                    if ($valor) { $vars[$llave] = $valor }
                }
            }
        }
        foreach ($par in @($Var)) {
            if ($par -and $par.Contains('=')) {
                $i = $par.IndexOf('=')
                $vars[$par.Substring(0, $i).Trim()] = $par.Substring($i + 1).Trim()
            }
        }
        Set-Content $envJson -Encoding ascii -Value (@{ Variables = $vars } | ConvertTo-Json -Compress)
        $creaArgs += @('--environment', "file://$envJson")

        Write-Host "Creando '$nombreLambda'..."
        aws lambda create-function @creaArgs @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "create-function terminó con código $LASTEXITCODE." }
    }

    Remove-Item $zipPath -Force
    Write-Host "DESPLIEGUE FINALIZADO: $nombreLambda"
}
catch {
    Write-Error "Error al desplegar: $_"
    if (Test-Path $zipPath) { Write-Warning "El zip se conserva en '$zipPath'." }
    exit 1
}
finally {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    if (Test-Path $envJson) { Remove-Item $envJson -Force }
}
