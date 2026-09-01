import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import type { PreparedTalkSessionTarget } from "../talk-session-target.types.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveOwnedActiveTalkRunTarget(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  /** The shipped talk.client.steer RPC is session-wide; attached transports select their call. */
  scope: { kind: "session" } | { kind: "voice-session"; voiceSessionId: string };
  assertCurrent?: () => void;
}): NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> | null {
  const connId = normalizeOptionalString(params.clientConnId);
  if (!connId) {
    return null;
  }
  const { agentId, sessionKey, canonicalKey } = params.sessionTarget;
  for (const [runId, entry] of params.context.chatAbortControllers) {
    const generation = entry.lifecycleGeneration;
    if (!generation) {
      continue;
    }
    const signal = entry.controller.signal;
    // Backing identity can materialize after admission; compare the live owner's
    // session ID with this same registration's current value, not an early snapshot.
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      if (params.scope.kind === "voice-session") {
        // Run bindings can move or retire during awaited control setup. They keep
        // the call's original key, not its canonical transcript-storage key.
        const binding = resolveClientVoiceRunBinding(runId);
        if (
          binding?.voiceSessionId !== params.scope.voiceSessionId ||
          binding.agentId !== agentId ||
          binding.sessionKey !== sessionKey
        ) {
          return false;
        }
      }
      return (
        params.context.chatAbortControllers.get(runId) === entry &&
        entry.agentId === agentId &&
        (entry.sessionKey === sessionKey || entry.sessionKey === canonicalKey) &&
        entry.ownerConnId === connId &&
        entry.kind !== "agent" &&
        entry.registrationCleanupRequested !== true &&
        (resolvedSessionId === undefined || entry.sessionId === resolvedSessionId) &&
        entry.controller.signal === signal &&
        !signal.aborted &&
        entry.lifecycleGeneration === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      return { runId, signal, isCurrent };
    }
  }
  return null;
}
