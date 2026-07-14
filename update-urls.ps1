$root = 'c:\Users\Phill\.copilot\repos\copilot-worktrees\tcbpestcontriol\phill-svg-turbo-eureka'
$base = 'https://www.tcbpestcontrolcanberra.com.au'
$changed = 0

function Add-TrailingSlashIfNeeded($value) {
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace($value)) {
        return $value
    }

    if ($value -notmatch '^https://www\.tcbpestcontrolcanberra\.com\.au/') {
        return $value
    }

    if ($value -match '/$' -or $value -match '\.(html|htm)([?#].*)?$') {
        return $value
    }

    return $value + '/'
}

Get-ChildItem -Path $root -Recurse -File -Filter '*.html' | ForEach-Object {
    $path = $_.FullName
    $content = [System.IO.File]::ReadAllText($path)
    $original = $content

    $content = [regex]::Replace($content, 'href="(?<url>' + [regex]::Escape($base) + '/[^"]*)" rel="canonical"', {
        param($m)
        $url = Add-TrailingSlashIfNeeded $m.Groups['url'].Value
        return 'href="' + $url + '" rel="canonical"'
    })

    $content = [regex]::Replace($content, 'content="(?<url>' + [regex]::Escape($base) + '/[^"]*)" property="og:url"', {
        param($m)
        $url = Add-TrailingSlashIfNeeded $m.Groups['url'].Value
        return 'content="' + $url + '" property="og:url"'
    })

    if ($content -ne $original) {
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        $script:changed++
    }
}

Write-Host "Updated $script:changed files"
