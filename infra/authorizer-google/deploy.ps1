<#
.SYNOPSIS
    Empaqueta y despliega la Lambda "authorizer-google" (Lambda authorizer del API Gateway REST v1) en dev o prd.

.DESCRIPTION
    Basado en toma-unidades-en-taller/deploy.ps1.

    1. Arma un .zip solo con index.mjs y package.json. No hay dependencias ni Layer: verifica el token con node:crypto.
       Runtime nodejs24.x, arquitectura arm64. Las pruebas (node --test) se corren aparte.
    2. Si la función existe, actualiza su código (y sus variables si se indica -GoogleClientIds). Si no existe, la
       crea (solo -RolArn es obligatorio).
    3. Con -ApiId, da permiso al API Gateway para invocarla como authorizer (si la consola no lo hizo ya).
    4. Si todo salió bien, elimina el .zip.

    Las variables GOOGLE_CLIENT_IDS y ALLOWED_EMAIL_DOMAINS se pueden configurar con este script o después en la
    consola (Lambda → Configuration → Environment variables). Mientras GOOGLE_CLIENT_IDS no exista, el authorizer
    rechaza todo (falla cerrado).

    La función va SIN VPC: necesita internet para descargar las llaves públicas de Google.
    El rol solo necesita escribir logs (política administrada AWSLambdaBasicExecutionRole).
    Requiere AWS CLI v2 con sesión iniciada. Para prd pide confirmación.
    Guía completa: Arquitectura/GUIA_API_GATEWAY.md (pasos 1 y 2).

.PARAMETER Ambiente
    dev o prd. Define el nombre de la función (prd -> authorizer-google, dev -> authorizer-google-dev).

.PARAMETER Perfil
    Perfil de AWS CLI. Si se omite, usa el predeterminado.

.PARAMETER SoloEmpaquetar
    Solo genera el .zip, sin llamar a AWS (el zip se conserva).


.PARAMETER RolArn
    Solo al crear: rol de ejecución de la Lambda.

.PARAMETER GoogleClientIds
    Opcional: Client IDs de OAuth aceptados como audiencia, separados por coma (variable GOOGLE_CLIENT_IDS).
    Si se indica, reemplaza las variables de la función (al crear o en una función existente).

.PARAMETER DominiosPermitidos
    Opcional, junto con -GoogleClientIds: dominios de email permitidos, separados por coma (variable
    ALLOWED_EMAIL_DOMAINS). Vacío = cualquier cuenta de Google con email verificado.

.PARAMETER ApiId
    Opcional: id del API Gateway (ej. z66x2zyooj) al que se le da permiso de invocar la función.

.EXAMPLE
    .\deploy.ps1 dev -SoloEmpaquetar
    .\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724 -RolArn arn:aws:iam::386458449724:role/authorizer-google-role
    .\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724 -RolArn <arn> -GoogleClientIds 1234-abc.apps.googleusercontent.com -ApiId z66x2zyooj
    .\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724                    # solo actualiza el código
    .\deploy.ps1 dev -GoogleClientIds "id-1,id-2" -DominiosPermitidos "cleber.com"   # cambia la configuración
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('dev', 'prd')]
    [string]$Ambiente,

    [string]$Perfil,
    [string]$Region = 'us-east-1',
    [switch]$SoloEmpaquetar,

    # Solo para crear la función por primera vez
    [string]$RolArn,

    # Variables de entorno (al crear, o para cambiarlas en una función existente)
    [string]$GoogleClientIds,
    [string]$DominiosPermitidos,

    [string]$ApiId,
    [int]$Timeout = 5,
    [int]$Memoria = 128
)

$ErrorActionPreference = 'Stop'
$Runtime = 'nodejs24.x'
$Arquitectura = 'arm64'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$nombreBase = 'authorizer-google'
$nombreLambda = if ($Ambiente -eq 'prd') { $nombreBase } else { "$nombreBase-dev" }
$carpeta = $PSScriptRoot
$zipPath = Join-Path $carpeta "$nombreBase-$Ambiente.zip"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-$nombreBase-$([guid]::NewGuid())"
$envJson = Join-Path ([System.IO.Path]::GetTempPath()) "env-$nombreBase-$([guid]::NewGuid()).json"

$awsArgs = @('--region', $Region)
if ($Perfil) { $awsArgs += @('--profile', $Perfil) }

# Archivo JSON de variables (evita el parseo de Variables=k=v en PowerShell)
function Escribe-Variables {
    $vars = @{ GOOGLE_CLIENT_IDS = $GoogleClientIds.Trim() }
    if ($DominiosPermitidos) { $vars.ALLOWED_EMAIL_DOMAINS = $DominiosPermitidos.Trim() }
    Set-Content $envJson -Encoding ascii -Value (@{ Variables = $vars } | ConvertTo-Json -Compress)
}

try {
    # 1. Empaquetado

    Write-Host "Empaquetando ($Ambiente)..."
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-Item (Join-Path $carpeta 'index.mjs'), (Join-Path $carpeta 'package.json') $staging

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # Entrada por entrada, con '/' como separador
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
            $ruta = $_.FullName.Substring($staging.Length + 1) -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $_.FullName, $ruta, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally { $zip.Dispose() }
    Write-Host ("Zip generado: {0} ({1:N1} KB)" -f $zipPath, ((Get-Item $zipPath).Length / 1KB))

    if ($SoloEmpaquetar) { return }

    # 2. Despliegue
    $cuenta = aws sts get-caller-identity --query Account --output text @awsArgs
    if ($LASTEXITCODE -ne 0) { throw 'Sin sesión de AWS.' }
    if ($Ambiente -eq 'prd') {
        $resp = Read-Host "Se desplegará '$nombreLambda' en PRODUCCIÓN (cuenta $cuenta). Escriba 'prd' para continuar"
        if ($resp -ne 'prd') { throw 'Cancelado.' }
    }

    # get-function falla si la función no existe; se tolera ese error
    $ErrorActionPreference = 'Continue'
    aws lambda get-function --function-name $nombreLambda @awsArgs *> $null
    $existe = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'

    if ($existe) {
        Write-Host "Actualizando '$nombreLambda'..."
        aws lambda update-function-code --function-name $nombreLambda --zip-file "fileb://$zipPath" `
            --architectures $Arquitectura @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "update-function-code terminó con código $LASTEXITCODE." }

        # El runtime y las variables no los cambia update-function-code; se alinean aquí si hace falta
        $runtimeActual = aws lambda get-function-configuration --function-name $nombreLambda `
            --query Runtime --output text @awsArgs
        $configArgs = @()
        if ($runtimeActual -ne $Runtime) {
            Write-Host "Cambiando runtime $runtimeActual -> $Runtime..."
            $configArgs += @('--runtime', $Runtime)
        }
        if ($GoogleClientIds) {
            Write-Host "Actualizando variables de entorno..."
            Escribe-Variables
            $configArgs += @('--environment', "file://$envJson")
        }
        elseif ($DominiosPermitidos) {
            throw '-DominiosPermitidos va junto con -GoogleClientIds (reemplaza las dos variables).'
        }
        if ($configArgs.Count -gt 0) {
            aws lambda wait function-updated --function-name $nombreLambda @awsArgs
            aws lambda update-function-configuration --function-name $nombreLambda @configArgs @awsArgs | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "update-function-configuration terminó con código $LASTEXITCODE." }
        }
    }
    else {
        if (-not $RolArn) {
            throw "'$nombreLambda' no existe. Para crearla indique -RolArn."
        }
        if ($DominiosPermitidos -and -not $GoogleClientIds) {
            throw '-DominiosPermitidos va junto con -GoogleClientIds.'
        }
        $creaArgs = @(
            '--function-name', $nombreLambda, '--runtime', $Runtime, '--architectures', $Arquitectura,
            '--handler', 'index.handler', '--role', $RolArn,
            '--timeout', "$Timeout", '--memory-size', "$Memoria", '--zip-file', "fileb://$zipPath",
            '--description', 'Lambda authorizer (TOKEN) del API Gateway: valida el id_token de Google e inyecta el email'
        )
        if ($GoogleClientIds) {
            Escribe-Variables
            $creaArgs += @('--environment', "file://$envJson")
        }
        else {
            Write-Warning 'Sin -GoogleClientIds: configure GOOGLE_CLIENT_IDS en la consola; mientras tanto el authorizer rechaza todo.'
        }

        Write-Host "Creando '$nombreLambda'..."
        aws lambda create-function @creaArgs @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "create-function terminó con código $LASTEXITCODE." }
    }

    # 3. Permiso para que el API Gateway la invoque como authorizer
    if ($ApiId) {
        aws lambda wait function-updated --function-name $nombreLambda @awsArgs
        $statementId = "apigateway-$ApiId-authorizers"
        $ErrorActionPreference = 'Continue'
        $salida = aws lambda add-permission --function-name $nombreLambda --statement-id $statementId `
            --action lambda:InvokeFunction --principal apigateway.amazonaws.com `
            --source-arn "arn:aws:execute-api:${Region}:${cuenta}:${ApiId}/authorizers/*" @awsArgs 2>&1
        $codigo = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($codigo -eq 0) { Write-Host "Permiso otorgado a API Gateway '$ApiId'." }
        elseif ("$salida" -match 'ResourceConflictException') { Write-Host "El permiso para '$ApiId' ya existía." }
        else { throw "add-permission terminó con código ${codigo}: $salida" }
    }

    # 4. El zip solo se elimina si todo salió bien
    Remove-Item $zipPath -Force
    Write-Host "DESPLIEGUE FINALIZADO: $nombreLambda ($Ambiente)"
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
