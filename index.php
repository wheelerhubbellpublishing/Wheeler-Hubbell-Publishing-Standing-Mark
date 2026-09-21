<?php
declare(strict_types=1);

const WHP_UPSTREAM = 'https://whp-standing-mark-repository.wheelerhubbell.chatgpt.site/__whp_transport';

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$requestUri = $_SERVER['REQUEST_URI'] ?? '/';
if ($requestUri === '' || $requestUri[0] !== '/' || preg_match('/[\r\n]/', $requestUri)) {
    http_response_code(400);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":{"code":"INVALID_REQUEST_TARGET"}}';
    exit;
}

$target = WHP_UPSTREAM . $requestUri;
$hopByHop = array_fill_keys([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
], true);

$requestHeaders = [];
foreach ((function_exists('getallheaders') ? getallheaders() : []) as $name => $value) {
    if (!isset($hopByHop[strtolower((string) $name)])) {
        $requestHeaders[] = $name . ': ' . $value;
    }
}
$requestHeaders[] = 'Accept-Encoding: identity';

$responseHeaders = [];
$curl = curl_init($target);
curl_setopt_array($curl, [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $requestHeaders,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 75,
    CURLOPT_USERAGENT => 'WHP-Standing-Hostinger-Transport/1.0',
    CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$responseHeaders): int {
        $trimmed = trim($line);
        if (str_starts_with($trimmed, 'HTTP/')) {
            $responseHeaders = [];
        } elseif ($trimmed !== '') {
            $responseHeaders[] = $trimmed;
        }
        return strlen($line);
    },
]);

if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
    curl_setopt($curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
}
if ($method === 'HEAD') {
    curl_setopt($curl, CURLOPT_NOBODY, true);
} elseif (!in_array($method, ['GET', 'OPTIONS'], true)) {
    $body = file_get_contents('php://input');
    curl_setopt($curl, CURLOPT_POSTFIELDS, $body === false ? '' : $body);
}

$responseBody = curl_exec($curl);
if ($responseBody === false) {
    error_log('WHP transport upstream failure: ' . curl_error($curl));
    curl_close($curl);
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo '{"error":{"code":"UPSTREAM_UNAVAILABLE","retryable":true}}';
    exit;
}

$status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
http_response_code($status > 0 ? $status : 502);

foreach ($responseHeaders as $line) {
    $separator = strpos($line, ':');
    if ($separator === false) {
        continue;
    }
    $name = strtolower(trim(substr($line, 0, $separator)));
    if (!isset($hopByHop[$name])) {
        header($line, false);
    }
}
header('X-WHP-Transport: hostinger', true);

if ($method !== 'HEAD') {
    echo $responseBody;
}
