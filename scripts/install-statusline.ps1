param(
    [string] $CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' })
)
$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathFullyQualified($CopilotHome)) {
    throw 'CopilotHome must be an absolute path.'
}
$destination = Join-Path $CopilotHome 'statusline\context-tokens'
if (Test-Path -LiteralPath $destination) {
    throw 'Status-line destination already exists; inspect it before updating. No settings changed.'
}
$oldHome = $env:COPILOT_HOME
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Text.Json;

public static class TokenStatusLineSettings
{
    public static string Patch(string text, string command)
    {
        var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
        using var document = JsonDocument.Parse(text, options);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Settings must be a JSON object.");
        int groups = 0;
        foreach (var property in document.RootElement.EnumerateObject())
            if (property.Name == "statusLine") groups++;
        if (groups > 1) throw new InvalidOperationException("Duplicate statusLine properties.");
        var bytes = Encoding.UTF8.GetBytes(text);
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions {
            CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true
        });
        reader.Read();
        long rootStart = reader.BytesConsumed;
        string encoded = JsonSerializer.Serialize(command);
        while (reader.Read())
        {
            if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 1
                || !reader.ValueTextEquals("statusLine")) continue;
            reader.Read();
            if (reader.TokenType == JsonTokenType.Null)
                return Replace(bytes, reader.TokenStartIndex, reader.BytesConsumed, "{\"command\":" + encoded + "}");
            if (reader.TokenType != JsonTokenType.StartObject)
                throw new InvalidOperationException("statusLine must be a JSON object.");
            long groupStart = reader.BytesConsumed;
            var group = document.RootElement.GetProperty("statusLine");
            int commands = 0;
            bool hasProperties = false;
            foreach (var property in group.EnumerateObject())
            {
                hasProperties = true;
                if (property.Name == "command") commands++;
            }
            if (commands > 1) throw new InvalidOperationException("Duplicate statusLine command properties.");
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject && reader.CurrentDepth == 1) break;
                if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 2
                    || !reader.ValueTextEquals("command")) continue;
                reader.Read();
                if (reader.TokenType != JsonTokenType.String && reader.TokenType != JsonTokenType.Null)
                    throw new InvalidOperationException("statusLine command must be a string.");
                return Replace(bytes, reader.TokenStartIndex, reader.BytesConsumed, encoded);
            }
            return Replace(bytes, groupStart, groupStart, "\"command\":" + encoded + (hasProperties ? "," : ""));
        }
        bool rootHasProperties = document.RootElement.EnumerateObject().MoveNext();
        return Replace(bytes, rootStart, rootStart, "\n  \"statusLine\": {\"command\":" + encoded + "}" + (rootHasProperties ? "," : ""));
    }

    private static string Replace(byte[] bytes, long start, long end, string replacement)
    {
        return Encoding.UTF8.GetString(bytes, 0, checked((int)start)) + replacement
            + Encoding.UTF8.GetString(bytes, checked((int)end), bytes.Length - checked((int)end));
    }
}
'@
try {
    $env:COPILOT_HOME = $CopilotHome
    $settingsPath = Join-Path $CopilotHome 'settings.json'
    $settingsExisted = Test-Path -LiteralPath $settingsPath
    $original = if ($settingsExisted) { [System.IO.File]::ReadAllText($settingsPath) } else { '{}' }
    $settings = $original | ConvertFrom-Json
    $previous = $settings.statusLine
    if ($null -ne $previous -and $null -ne $previous.command -and $previous.command -isnot [string]) {
        throw 'Existing status-line command is invalid. No settings changed.'
    }
    if ($null -ne $previous -and $null -eq $previous.command) { $previous = $null }
    $root = Split-Path $PSScriptRoot -Parent
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $command = '"{0}" "{1}"' -f $node, (Join-Path $destination 'statusline.mjs')
    $patched = [TokenStatusLineSettings]::Patch($original, $command)
    $null = New-Item -ItemType Directory -Path $destination
    [System.IO.File]::Copy((Join-Path $root 'statusline\statusline.mjs'), (Join-Path $destination 'statusline.mjs'), $false)
    $config = @{ previousStatusLine = $previous; showTokens = $true } | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $destination 'config.json'), $config)
    if ((Test-Path -LiteralPath $settingsPath) -ne $settingsExisted -or
        ($settingsExisted -and [System.IO.File]::ReadAllText($settingsPath) -cne $original)) {
        throw 'Settings changed during installation; no settings written. Staged files retained.'
    }
    [System.IO.File]::WriteAllText($settingsPath, $patched)
    $actual = [System.IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json
    if ($actual.statusLine.command -cne $command) {
        throw 'Status-line command verification failed; files retained. Inspect settings before retrying.'
    }
    Write-Output "Installed token status-line compositor: $destination"
    Write-Output 'Previous renderer saved in config.json; other status-line settings are unchanged.'
} finally {
    $env:COPILOT_HOME = $oldHome
}
