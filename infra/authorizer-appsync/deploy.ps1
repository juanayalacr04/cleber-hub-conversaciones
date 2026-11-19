<#
.SYNOPSIS
    Empaqueta y despliega la Lambda "authorizer-appsync" (Lambda authorizer genérico de AppSync Events) en dev o prd.

.DESCRIPTION
    Basado en infra/authorizer-google/deploy.ps1.

    1. Arma un .zip con index.mjs, google.mjs y package.json. Sin dependencias ni Layer. Runtime nodejs24.x, arm64.
       Las pruebas (node --test) se corren aparte.
    2. Si la función existe, actualiza su código. Si no existe, la crea (solo -RolArn es obligatorio).
    3. Con -ApiId, da permiso a esa API de AppSync para invocarla (la consola lo hace sola al elegirla como authorizer).
    4. Si todo salió bien, elimina el .zip.

    Las variables (GOOGLE_CLIENT_IDS, ALLOWED_EMAIL_DOMAINS, NAMESPACES, URL_API_DB, CLEBER_API_KEY, TTL_SEGUNDOS) se
    configuran en la consola (Lambda → Configuration → Environment variables); ver el encabezado de index.mjs.
    Mientras falten GOOGLE_CLIENT_IDS o NAMESPACES, el authorizer rechaza (falla cerrado).

    La función va SIN VPC: necesita internet para las llaves públicas de Google y alcanzar PostgREST (URL_API_DB).
    El rol solo necesita escribir logs (política administrada AWSLambdaBasicExecutionRole).
    Requiere AWS CLI v2 con sesión iniciada. Para prd pide confirmación.

.EXAMPLE
    .\deploy.ps1 dev -SoloEmpaquetar
    .\deploy.ps1 dev -RolArn arn:aws:iam::807746362931:role/authorizer-appsync-role
    .\deploy.ps1 dev -ApiId abcdefghij1234567890
    .\deploy.ps1 dev                                        # solo actualiza el código
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('dev', 'prd')]
    [string]$Ambiente,

    [string]$Perfil,
    [string]$Region = 'us-east-1',
    [switch]$SoloEmpaquetar,
    [string]$RolArn,
    [string]$ApiId,
    [int]$Timeout = 5,
    [int]$Memoria = 128
)

$ErrorActionPreference = 'Stop'
$Runtime = 'nodejs24.x'
$Arquitectura = 'arm64'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$nombreBase = 'authorizer-appsync'
$nombreLambda = if ($Ambiente -eq 'prd') { $nombreBase } else { "$nombreBase-dev" }
$carpeta = $PSScriptRoot
$zipPath = Join-Path $carpeta "$nombreBase-$Ambiente.zip"

$awsArgs = @('--region', $Region)
if ($Perfil) { $awsArgs += @('--profile', $Perfil) }

try {
    # 1. Empaquetado
    Write-Host "Empaquetando ($Ambiente)..."
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($archivo in 'index.mjs', 'google.mjs', 'package.json') {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, (Join-Path $carpeta $archivo), $archivo, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
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

    $ErrorActionPreference = 'Continue'
    aws lambda get-function --function-name $nombreLambda @awsArgs *> $null
    $existe = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'

    if ($existe) {
        Write-Host "Actualizando '$nombreLambda'..."
        aws lambda update-function-code --function-name $nombreLambda --zip-file "fileb://$zipPath" `
            --architectures $Arquitectura @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "update-function-code terminó con código $LASTEXITCODE." }
    }
    else {
        if (-not $RolArn) { throw "'$nombreLambda' no existe. Para crearla indique -RolArn." }
        Write-Host "Creando '$nombreLambda'..."
        aws lambda create-function --function-name $nombreLambda --runtime $Runtime --architectures $Arquitectura `
            --handler 'index.handler' --role $RolArn --timeout "$Timeout" --memory-size "$Memoria" `
            --zip-file "fileb://$zipPath" `
            --description 'Lambda authorizer de AppSync Events: id_token de Google + <Prefijo>.autorizaCanal del namespace' `
            @awsArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "create-function terminó con código $LASTEXITCODE." }
        Write-Warning 'Configure las variables de entorno en la consola; mientras tanto el authorizer rechaza todo.'
    }

    # 3. Permiso para que AppSync la invoque
    if ($ApiId) {
        aws lambda wait function-updated --function-name $nombreLambda @awsArgs
        $ErrorActionPreference = 'Continue'
        $salida = aws lambda add-permission --function-name $nombreLambda --statement-id "appsync-$ApiId" `
            --action lambda:InvokeFunction --principal appsync.amazonaws.com `
            --source-arn "arn:aws:appsync:${Region}:${cuenta}:apis/${ApiId}" @awsArgs 2>&1
        $codigo = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($codigo -eq 0) { Write-Host "Permiso otorgado a la API de AppSync '$ApiId'." }
        elseif ("$salida" -match 'ResourceConflictException') { Write-Host "El permiso para '$ApiId' ya existía." }
        else { throw "add-permission terminó con código ${codigo}: $salida" }
    }

    Remove-Item $zipPath -Force
    Write-Host "DESPLIEGUE FINALIZADO: $nombreLambda ($Ambiente)"
}
catch {
    Write-Error "Error al desplegar: $_"
    if (Test-Path $zipPath) { Write-Warning "El zip se conserva en '$zipPath'." }
    exit 1
}
