import {sha256} from './policy.mjs';
import {secureRequest} from './security.mjs';

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value ?? null;
}

export async function deliverOnce({candidate, request, signal, timeoutMs, transport = secureRequest}) {
  const wire = JSON.stringify(request.body);
  const started = Date.now();
  const sentAt = new Date(started).toISOString();
  try {
    const response = await transport(candidate.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'a2a-version': candidate.protocolVersion,
        'user-agent': 'WHP-EPT-Carrier/1.0 (+https://whp-standing-live-production.up.railway.app/)',
        'content-length': String(Buffer.byteLength(wire)),
      },
      body: wire,
      maxBytes: 262144,
      maxRedirects: 0,
      timeoutMs,
      signal,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch {
      // The response hash and content type remain evidence; response content is never retained.
    }
    return {
      attempted: true,
      responded: true,
      sent_at: sentAt,
      duration_ms: Date.now() - started,
      request_sha256: sha256(wire),
      request_bytes: Buffer.byteLength(wire),
      http_status: response.status,
      response_content_type: headerValue(response.headers, 'content-type'),
      response_sha256: sha256(response.body),
      response_bytes: response.body.length,
      response_url: response.url,
      remote_address: response.remoteAddress,
      a2a_response: Boolean(parsed && (parsed.result || parsed.error || parsed.task || parsed.message)),
      task_state: parsed?.result?.status?.state
        ?? parsed?.result?.task?.status?.state
        ?? parsed?.task?.status?.state
        ?? null,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      attempted: true,
      responded: false,
      sent_at: sentAt,
      duration_ms: Date.now() - started,
      request_sha256: sha256(wire),
      request_bytes: Buffer.byteLength(wire),
      network_error: String(error?.message ?? error).slice(0, 500),
    };
  }
}
