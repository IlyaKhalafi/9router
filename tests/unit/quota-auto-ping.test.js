import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage/shared.js", () => ({
  U: () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/responses" }),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

describe("quota auto-ping", () => {
  let runQuotaAutoPingTick;
  let configureQuotaAutoPing;
  let deps;
  let state;
  let getCodexUsage;
  let getClaudeUsage;
  let getExecutor;
  let codexResponseText;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ getExecutor } = await import("open-sse/executors/index.js"));
    ({ runQuotaAutoPingTick, configureQuotaAutoPing } = await import("../../src/shared/services/quotaAutoPing.js"));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
      })),
    };
    codexResponseText = vi.fn().mockResolvedValue("");
    getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
    });
    state = { running: false, resetCache: {}, failureCache: {}, pingedResetCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("does not ping Codex when setting is absent", async () => {
    deps.getSettings.mockResolvedValue({});

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("starts the scheduler only when an account opts in", () => {
    vi.useFakeTimers();

    configureQuotaAutoPing({ codexAutoPing: { connections: {} } });
    expect(vi.getTimerCount()).toBe(0);

    configureQuotaAutoPing({ codexAutoPing: { connections: { "codex-1": true } } });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops the scheduler when the last account opts out", () => {
    vi.useFakeTimers();
    configureQuotaAutoPing({ claudeAutoPing: { connections: { "claude-1": true } } });

    configureQuotaAutoPing({ claudeAutoPing: { connections: { "claude-1": false } } });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ping Codex on the first resetAt observation", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, resetAt: "2026-01-01T13:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T13:00:00.000Z");
  });

  it("sends Codex ping when session resetAt slides", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping Codex when resetAt is stable", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not repeat Codex ping inside the minimum ping interval", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingAt: "2026-01-01T11:55:00.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex just because reported usage is zero", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not ping Codex when weekly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        weekly: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-03T12:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when monthly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        monthly: { used: 100, total: 100, remaining: 0, resetAt: "2026-02-01T00:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when session quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("sends one tiny gpt-5.5 Codex request through the executor", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", providerSpecificData: { workspaceId: "ws-1" } }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(deps.getExecutor).toHaveBeenCalledWith("codex");
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.5",
      stream: true,
      credentials: expect.objectContaining({
        accessToken: "token",
        connectionId: "codex-1",
        providerSpecificData: { workspaceId: "ws-1" },
      }),
      body: {
        model: "gpt-5.5",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        }],
        instructions: "Reply with OK.",
        reasoning: { effort: "none", summary: "auto" },
        store: false,
        stream: true,
      },
    }));
    expect(codexResponseText).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping same Codex reset twice when seconds drift", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingedResetAt: "2026-01-01T11:59:44.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T11:59:44.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T11:59:47.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("skips non-OAuth Codex connections", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "apikey", accessToken: "token" }] : []
    ));

    await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).not.toHaveBeenCalled();
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("keeps Claude session quota key behavior", async () => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
    ));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T11:59:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.proxyAwareFetch.mock.calls[0][1].body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  function enableClaudeAutoPing() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const connection = { id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" };
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [connection] : []
    ));
    deps.updateProviderConnection.mockImplementation(async (_id, patch) => Object.assign(connection, patch));
    return connection;
  }

  it("catches a Claude reset that rolls forward between scheduler ticks", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:30.000Z"));
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
      lastPingedResetKey: "2026-01-01T12:00:00.000Z",
    }));

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer a missed Claude reset from the first future observation", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not catch up a Claude reset before the previously observed window expires", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("retries a failed Claude rollover ping after the failure cooldown", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.proxyAwareFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T12:15:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("keeps an exhausted Claude rollover pending until quota is available", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("catches consecutive Claude rollovers without marking the next reset as pinged", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T22:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    vi.setSystemTime(new Date("2026-01-01T17:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenLastCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:00:00.000Z",
      lastPingedResetKey: "2026-01-01T17:00:00.000Z",
    }));
  });

  it("does not repeat a Claude ping when an already pinged reset rolls forward", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not catch up a Claude reset when the cached timestamp is invalid", async () => {
    enableClaudeAutoPing();
    state.resetCache["claude:claude-1"] = "invalid";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("stops retrying a failed Claude rollover after the catch-up window expires", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.proxyAwareFetch.mockResolvedValue({ ok: false });

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T12:31:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(getClaudeUsage).toHaveBeenCalledTimes(3);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not catch up a stale Claude reset after an idle gap", async () => {
    enableClaudeAutoPing();
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: null } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 99, resetAt: "2026-01-01T19:00:00.000Z" } },
    });

    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T14:00:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T19:00:00.000Z");
  });

  it("does not treat a small Claude reset timestamp change as a rollover", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:01:30.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a successful Claude catch-up when persisting its marker fails", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.updateProviderConnection.mockRejectedValueOnce(new Error("write failed"));

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:30.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("preserves Codex drift detection after a failed ping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" } },
    });
    deps.getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: false } }),
    });

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:01:00.000Z");
  });

  it("does not repeat a direct Claude ping after its marker fails to persist and reset rolls forward", async () => {
    enableClaudeAutoPing();
    // A scheduler created before a hot reload has no successful-ping cache yet.
    delete state.pingedResetCache;
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.updateProviderConnection.mockRejectedValueOnce(new Error("write failed"));

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("uses the existing lead tolerance when catching up a Claude reset", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:57.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
    }));
  });
});
