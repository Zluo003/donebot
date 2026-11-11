import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { createDoneBotHelpers } from "./helpers.ts";

describe("DoneBot decision routing", () => {
  it("uses the original Jev System One request through the fixed gateway", async () => {
    const state = { message: "Which bot should answer?" };
    const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({
      answers: { answer: { type: "choice", choice: "bot-a", probabilities: { "bot-a": 0.9, "bot-b": 0.1 } } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const gateway = { authenticated: () => true, request } as unknown as DoneBotGateway;
    const config = () => ({ decider: { provider: "openrouter", enabled: true, jobs: { roomRouting: true } } }) as AppConfig;
    const { decider } = createDoneBotHelpers(gateway, config);

    const result = await decider.choose("roomRouting", state, {
      instructions: "Pick the best responder.",
      options: { "bot-a": "Handles design", "bot-b": "Handles operations" },
    });
    expect(result).toStrictEqual({ ok: true, provider: "jev", answers: {
      type: "choice", choice: "bot-a", pTop: 0.9, margin: 0.8, probabilities: { "bot-a": 0.9, "bot-b": 0.1 },
    }, latencyMs: expect.any(Number) });

    expect(request).toHaveBeenCalledOnce();
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "jev-latest",
      state,
      questions: { answer: { type: "choice", instructions: "Pick the best responder.", criteria: { "bot-a": "Handles design", "bot-b": "Handles operations" } } },
    });
  });

  it("does not fall back to an external decision provider when signed out", async () => {
    const request = vi.fn();
    const gateway = { authenticated: () => false, request } as unknown as DoneBotGateway;
    const config = () => ({ decider: { enabled: true } }) as AppConfig;
    const { decider } = createDoneBotHelpers(gateway, config);

    await expect(decider.choose("roomRouting", {}, {
      instructions: "Pick one.", options: { "bot-a": "A", "bot-b": "B" },
    })).resolves.toMatchObject({ ok: false, reason: "disabled" });
    expect(request).not.toHaveBeenCalled();
  });
});
