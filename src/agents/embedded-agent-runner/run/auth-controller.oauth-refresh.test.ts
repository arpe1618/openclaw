import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../auth-profiles.js";
import {
  OAuthRefreshFailureError,
  resolveOAuthRefreshFailurePresentation,
} from "../../auth-profiles/oauth-refresh-failure.js";
import { createEmbeddedRunAuthController } from "./auth-controller.js";

const mocks = vi.hoisted(() => ({
  getApiKeyForModelCore: vi.fn(),
}));

vi.mock("../../model-auth.js", async () => ({
  ...(await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js")),
  getApiKeyForModelCore: mocks.getApiKeyForModelCore,
}));

function createTestModel(): Model {
  // SAFETY: This fixture supplies the complete model fields consumed by the auth controller.
  return {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  } as Model;
}

describe("createEmbeddedRunAuthController OAuth refresh state", () => {
  it("preserves structured presentation without writes in read-only mode", async () => {
    const profileId = "custom-openai:oauth";
    const summary = "Please sign in again.";
    const diagnostic = "OpenAI Codex token refresh failed (HTTP 401).";
    const authStore: AuthProfileStore = { version: 1, profiles: {} };
    mocks.getApiKeyForModelCore.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "custom-openai",
        profileId,
        message: summary,
        reason: "revoked",
        summary,
        diagnostic,
        status: 401,
      }),
    );
    let runtimeModel = createTestModel();
    let effectiveModel = createTestModel();
    let profileIndex = 0;
    const controller = createEmbeddedRunAuthController({
      config: undefined,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authStore,
      authStorage: { setRuntimeApiKey: vi.fn() },
      profileCandidates: [profileId],
      initialThinkLevel: "medium",
      attemptedThinking: new Set(),
      fallbackConfigured: false,
      allowTransientCooldownProbe: false,
      authProfileStateMode: "read-only",
      getProvider: () => "custom-openai",
      getModelId: () => "test-model",
      getRuntimeModel: () => runtimeModel,
      setRuntimeModel: (next) => {
        runtimeModel = next;
      },
      getEffectiveModel: () => effectiveModel,
      setEffectiveModel: (next) => {
        effectiveModel = next;
      },
      getApiKeyInfo: () => null,
      setApiKeyInfo: () => undefined,
      getLastProfileId: () => undefined,
      setLastProfileId: () => undefined,
      getRuntimeAuthState: () => null,
      setRuntimeAuthState: () => undefined,
      getRuntimeAuthRefreshCancelled: () => false,
      setRuntimeAuthRefreshCancelled: () => undefined,
      getProfileIndex: () => profileIndex,
      setProfileIndex: (next) => {
        profileIndex = next;
      },
      setThinkLevel: () => undefined,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });

    const failure = await controller.initializeAuthProfile().catch((error: unknown) => error);

    expect(resolveOAuthRefreshFailurePresentation(failure)).toEqual({
      summary,
      diagnostic,
      reason: "revoked",
      status: 401,
    });
    expect(authStore.usageStats).toBeUndefined();
  });
});
