import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { clampProbeTimeoutMs, probeGateway } from "../gateway/probe.js";
import { quoteCliArg } from "./quote-cli-arg.js";

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

// realpath rejects paths that do not exist yet (openclaw.json before the first write).
// Canonicalize the nearest existing ancestor and re-append the missing tail; without it a
// symlinked state dir compares unequal to the Gateway's real dir and the guard refuses the
// first credential write.
function canonicalizeStatePath(value: string): string {
  const resolved = path.resolve(value);
  for (let dir = resolved, tail = ""; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), tail);
    } catch {
      if (path.dirname(dir) === dir) {
        return resolved;
      }
      tail = path.join(path.basename(dir), tail);
    }
  }
}

export function compareCliGatewayStateDirs(params: {
  cliStateDir: string;
  cliConfigPath: string;
  gatewayStateDir?: string;
  gatewayConfigPath?: string;
  gatewayReachable: boolean;
  command?: string;
  allowMismatch?: boolean;
  warn?: (message: string) => void;
  gatewayStateDirSource?: "configured service target";
}) {
  const cliStateDir = canonicalizeStatePath(params.cliStateDir);
  const cliConfigPath = canonicalizeStatePath(params.cliConfigPath);
  if (!params.gatewayStateDir) {
    return { kind: "unavailable" as const, cliStateDir };
  }
  const gatewayStateDir = canonicalizeStatePath(params.gatewayStateDir);
  const gatewayConfigPath = params.gatewayConfigPath
    ? canonicalizeStatePath(params.gatewayConfigPath)
    : undefined;
  const stateDirMismatch = gatewayStateDir !== cliStateDir;
  const configPathMismatch = gatewayConfigPath !== undefined && gatewayConfigPath !== cliConfigPath;
  const comparisonKind = stateDirMismatch || configPathMismatch ? "mismatch" : "match";
  const result = {
    kind: params.gatewayStateDirSource ? "unavailable" : comparisonKind,
    cliStateDir,
    gatewayStateDir,
    ...(params.gatewayStateDirSource
      ? { gatewayStateDirSource: params.gatewayStateDirSource }
      : {}),
  };
  if (comparisonKind !== "mismatch") {
    return result;
  }

  const differences = [
    stateDirMismatch &&
      `state directories (CLI: ${params.cliStateDir}; Gateway: ${result.gatewayStateDir})`,
    configPathMismatch &&
      `config paths (CLI: ${params.cliConfigPath}; Gateway: ${gatewayConfigPath})`,
  ]
    .filter(Boolean)
    .join(" and ");
  const gatewayConfig = gatewayConfigPath ?? path.join(result.gatewayStateDir, "openclaw.json");
  if (params.gatewayReachable && params.command && !params.allowMismatch) {
    throw new Error(
      `No credentials were written. ${differences}. Fix: rerun with OPENCLAW_STATE_DIR=${quoteCliArg(result.gatewayStateDir)} OPENCLAW_CONFIG_PATH=${quoteCliArg(gatewayConfig)} ${params.command}, or pass --allow-state-dir-mismatch to write here anyway.`,
    );
  }
  params.warn?.(
    params.gatewayReachable
      ? `CLI and live Gateway use different ${differences}. The CLI may read or write a store or config file the Gateway does not use. Fix: run OPENCLAW_STATE_DIR=${quoteCliArg(result.gatewayStateDir)} OPENCLAW_CONFIG_PATH=${quoteCliArg(gatewayConfig)} openclaw doctor, then rerun openclaw gateway status --deep.`
      : `Gateway is unavailable. CLI and the configured service target use different ${differences}; this is not live proof.`,
  );
  return result;
}

async function serviceFallback(
  cliStateDir: string,
  cliConfigPath: string,
  params: {
    gatewayReachable: boolean;
    command?: string;
    allowMismatch?: boolean;
    warn?: (message: string) => void;
  },
) {
  const serviceEnv = { ...process.env };
  // Drop caller-owned paths: merged env would let a caller override masquerade as
  // the service's own path and defeat the guard.
  delete serviceEnv.OPENCLAW_STATE_DIR;
  delete serviceEnv.OPENCLAW_CONFIG_PATH;
  const state = await readGatewayServiceState(resolveGatewayService(), { env: serviceEnv }).catch(
    () => null,
  );
  if (!state?.installed) {
    if (params.gatewayReachable) {
      params.warn?.(
        "Gateway is listening, but no installed service state exists; state directory comparison was not possible.",
      );
    }
    return { kind: "unavailable" as const, cliStateDir };
  }

  return compareCliGatewayStateDirs({
    cliStateDir,
    cliConfigPath,
    gatewayStateDir: resolveStateDir(state.env),
    gatewayConfigPath: resolveConfigPath(state.env),
    gatewayReachable: params.gatewayReachable,
    command: params.command,
    allowMismatch: params.allowMismatch,
    warn: params.warn,
    gatewayStateDirSource: "configured service target",
  });
}

export async function checkCliGatewayStateDir(params: {
  config?: OpenClawConfig;
  timeoutMs?: number;
  allowMismatch?: boolean;
  command?: string;
  warn?: (message: string) => void;
}) {
  const cliStateDir = canonicalizeStatePath(resolveStateDir(process.env));
  const cliConfigPath = canonicalizeStatePath(resolveConfigPath(process.env));
  let details: ReturnType<typeof buildGatewayConnectionDetails>;
  try {
    details = buildGatewayConnectionDetails({ config: params.config });
  } catch {
    return { kind: "unavailable", cliStateDir };
  }
  // The resolved URL is the only reliable remote test: connection details already fold in
  // gateway.mode, and callers that pass no config still get the same verdict.
  const hostname = new URL(details.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname !== "localhost" && !["127.0.0.1", "::1"].includes(hostname)) {
    params.warn?.(
      `Gateway target ${details.url} is remote. Cross-host comparison is not possible; local writes do not reach the remote Gateway.`,
    );
    return { kind: "remote", cliStateDir, gatewayUrl: details.url };
  }

  let gatewayStateDir: string | undefined;
  let gatewayConfigPath: string | undefined;
  try {
    await callGateway({
      config: params.config,
      method: "status",
      params: { includeChannelSummary: false },
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
      timeoutMs: params.timeoutMs,
      onHelloOk: (hello: GatewayHello) => {
        gatewayStateDir = hello.snapshot.stateDir;
        gatewayConfigPath = hello.snapshot.configPath;
      },
    });
  } catch {
    let gatewayReachable = false;
    try {
      // Credential preflight can fail before opening a socket. Probe without stored auth so only
      // a Gateway protocol response can upgrade the fallback from offline to reachable.
      const probe = await probeGateway({
        url: details.url,
        config: params.config,
        timeoutMs: clampProbeTimeoutMs(params.timeoutMs ?? 10_000),
        includeDetails: false,
        suppressStoredDeviceAuth: true,
      });
      gatewayReachable = probe.gatewayReached === true;
    } catch {
      // A probe that cannot complete is not proof of a live Gateway; stay offline.
    }
    return await serviceFallback(cliStateDir, cliConfigPath, {
      gatewayReachable,
      command: params.command,
      allowMismatch: params.allowMismatch,
      warn: params.warn,
    });
  }
  return compareCliGatewayStateDirs({
    cliStateDir,
    cliConfigPath,
    gatewayStateDir,
    gatewayConfigPath,
    gatewayReachable: true,
    command: params.command,
    allowMismatch: params.allowMismatch,
    warn: params.warn,
  });
}
