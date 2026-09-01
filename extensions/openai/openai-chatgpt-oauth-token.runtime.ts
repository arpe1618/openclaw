import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
  throwIfOAuthLoginAborted,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  isRecord,
  normalizeBoundedOptionalString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_TOKEN_SSRF_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
  hostnameAllowlist: ["auth.openai.com"],
} satisfies SsrFPolicy;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS = 500;

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = {
  type: "failed";
  summary: string;
  diagnostic?: string;
  reason?: string;
  status?: number;
};
type TokenResult = TokenSuccess | TokenFailure;
type TokenResponseJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};
type TokenRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function normalizeErrorSummary(value: unknown): string | undefined {
  const normalized = normalizeBoundedOptionalString(
    value,
    OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS,
  )?.replace(/\s+/gu, " ");
  if (!normalized) {
    return undefined;
  }
  return normalizeBoundedOptionalString(
    redactSensitiveText(normalized),
    OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS,
  );
}

function buildOpenAITokenFailure(params: {
  operation: "exchange" | "refresh";
  response: Response;
  text: string;
}): TokenFailure {
  let root: Record<string, unknown> | undefined;
  try {
    root = asOptionalRecord(JSON.parse(params.text));
  } catch {
    // Non-JSON responses use the bounded generic summary below.
  }
  const nested = asOptionalRecord(root?.error);
  const normalizeFact = (value: unknown) => {
    const normalized = normalizeOptionalString(value);
    return normalizeDiagnosticValue(normalized, "") || undefined;
  };
  const code = normalizeFact(
    nested?.code ?? (typeof root?.error === "string" ? root.error : root?.code),
  );
  const type = normalizeFact(nested?.type ?? root?.type);
  const summary =
    normalizeErrorSummary(nested?.message ?? root?.error_description ?? root?.message) ??
    `OpenAI Codex token ${params.operation} failed (HTTP ${params.response.status}).`;
  const facts = [
    `HTTP ${params.response.status}`,
    code ? `code=${code}` : undefined,
    type ? `type=${type}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const diagnostic =
    summary.startsWith("OpenAI Codex token ") || facts.length === 1
      ? undefined
      : `OpenAI Codex token ${params.operation} failed (${facts.join("; ")}).`;
  return {
    type: "failed",
    status: params.response.status,
    ...(code ? { reason: code } : {}),
    summary,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function formatMissingTokenResponseFields(
  json: TokenResponseJson,
  existingRefreshToken?: string,
): string {
  const missing: string[] = [];
  if (!json.access_token) {
    missing.push("access_token");
  }
  if (!json.refresh_token && !existingRefreshToken) {
    missing.push("refresh_token");
  }
  if (resolveOAuthTokenLifetimeMs(json.expires_in) === undefined) {
    missing.push("expires_in");
  }
  return missing.join(", ");
}

function formatTokenRequestError(
  operation: "exchange" | "refresh",
  error: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): string {
  if (signal?.aborted) {
    return "Login cancelled";
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return `OpenAI Codex token ${operation} timed out after ${timeoutMs}ms`;
  }
  const detail = normalizeErrorSummary(error instanceof Error ? error.message : String(error));
  return (
    normalizeErrorSummary(`OpenAI Codex token ${operation} error${detail ? `: ${detail}` : ""}`) ??
    `OpenAI Codex token ${operation} error`
  );
}

async function postTokenForm(
  body: URLSearchParams,
  options: TokenRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  throwIfOAuthLoginAborted(options.signal);
  const { response, release } = await fetchWithSsrFGuard({
    url: TOKEN_URL,
    // Fake-IP proxies map public hosts into these ranges. The exact-host allowlist
    // keeps redirects and every other hostname fail-closed.
    policy: OAUTH_TOKEN_SSRF_POLICY,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    timeoutMs,
    signal: options.signal,
    auditContext: "openai-chatgpt-oauth-token",
  });
  try {
    const responseBody = await readResponseWithLimit(
      response,
      OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES,
      {
        onOverflow: ({ size, maxBytes }) =>
          new Error(
            `OpenAI Codex OAuth token response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
          ),
      },
    );
    return new Response(new Uint8Array(responseBody), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}

async function readOpenAITokenResponse(
  response: Response,
  operation: "exchange" | "refresh",
  existingRefreshToken?: string,
): Promise<TokenResult> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return buildOpenAITokenFailure({ operation, response, text });
  }
  let json: TokenResponseJson;
  try {
    json = (await response.json()) as TokenResponseJson;
  } catch {
    return {
      type: "failed",
      summary: `OpenAI Codex token ${operation} failed: response is not valid JSON`,
    };
  }
  if (!isRecord(json)) {
    return {
      type: "failed",
      summary: `OpenAI Codex token ${operation} failed: expected JSON object response`,
    };
  }
  const expires = resolveOAuthTokenExpiresAt(json.expires_in);
  const refreshToken = json.refresh_token || existingRefreshToken;
  if (!json.access_token || !refreshToken || expires === undefined) {
    return {
      type: "failed",
      summary: `OpenAI Codex token ${operation} response missing fields: ${formatMissingTokenResponseFields(json, existingRefreshToken)}`,
    };
  }
  return {
    type: "success",
    access: json.access_token,
    refresh: refreshToken,
    expires,
  };
}

export async function exchangeOpenAIAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await postTokenForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      { signal: options.signal, timeoutMs },
    );
  } catch (error) {
    return {
      type: "failed",
      summary: formatTokenRequestError("exchange", error, timeoutMs, options.signal),
    };
  }
  return await readOpenAITokenResponse(response, "exchange");
}

export async function refreshOpenAIAccessToken(
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  try {
    const response = await postTokenForm(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      { signal: options.signal, timeoutMs },
    );
    return await readOpenAITokenResponse(response, "refresh", refreshToken);
  } catch (error) {
    return {
      type: "failed",
      summary: formatTokenRequestError("refresh", error, timeoutMs, options.signal),
    };
  }
}
