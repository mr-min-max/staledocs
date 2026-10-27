import { AnthropicProvider } from "../../../src/providers/anthropic";

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
      stream: jest.fn(),
    },
  })),
}));

type MockAnthropicClient = {
  messages: { create: jest.Mock; stream: jest.Mock };
};

function providerWithClient(model?: string): {
  provider: AnthropicProvider;
  client: MockAnthropicClient;
} {
  const client: MockAnthropicClient = {
    messages: { create: jest.fn(), stream: jest.fn() },
  };
  const Anthropic = require("@anthropic-ai/sdk").default as jest.Mock;
  Anthropic.mockImplementationOnce(() => client);
  return {
    provider: new AnthropicProvider("fake-anthropic-key", model),
    client,
  };
}

describe("AnthropicProvider Messages transport", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses the exact current default model and Messages request shape", async () => {
    const { provider, client } = providerWithClient();
    client.messages.create.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "not returned as answer" },
        { type: "text", text: "answer" },
      ],
    });

    await expect(
      provider.generate("prompt-value", {
        systemPrompt: "system-value",
        maxTokens: 2048,
      }),
    ).resolves.toBe("answer");

    expect(client.messages.create).toHaveBeenCalledWith({
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      system: "system-value",
      messages: [{ role: "user", content: "prompt-value" }],
    });
  });

  it("defaults max_tokens and never sends sampling parameters", async () => {
    const { provider, client } = providerWithClient("caller-model");
    client.messages.create.mockResolvedValue({
      content: [{ type: "text", text: "answer" }],
    });

    await provider.generate("prompt", { temperature: 0.2 });

    expect(client.messages.create).toHaveBeenCalledWith({
      model: "caller-model",
      max_tokens: 16000,
      messages: [{ role: "user", content: "prompt" }],
    });
  });

  it("rejects a response cut off at max_tokens instead of returning partial text", async () => {
    const { provider, client } = providerWithClient();
    client.messages.create.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
    });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /Anthropic provider response stopped at max_tokens/,
    );
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal once without exposing the prompt", async () => {
    const { provider, client } = providerWithClient();
    client.messages.create.mockResolvedValue({
      stop_reason: "refusal",
      content: [],
    });

    const result = provider.generate("prompt-secret");
    await expect(result).rejects.toThrow(
      /Anthropic provider declined the request/,
    );
    await expect(result).rejects.not.toThrow(/prompt-secret/);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty or malformed response without exposing prompt or key", async () => {
    const { provider, client } = providerWithClient();
    client.messages.create
      .mockResolvedValueOnce({ content: [{ type: "text", text: 42 }] })
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "tool" }] });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /Anthropic provider returned no text/,
    );
    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /Anthropic provider returned no text/,
    );
    await expect(provider.generate("prompt-secret")).rejects.not.toThrow(
      /prompt-secret|fake-anthropic-key|42/,
    );
  });

  it("retries a 429 without exposing the SDK body", async () => {
    jest.useFakeTimers();
    try {
      const { provider, client } = providerWithClient();
      client.messages.create
        .mockRejectedValueOnce({ status: 429, message: "fake-anthropic-key" })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

      const resultPromise = provider.generate("prompt-secret");
      await jest.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe("ok");
      expect(client.messages.create).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("sanitizes terminal SDK failures", async () => {
    const { provider, client } = providerWithClient();
    client.messages.create.mockRejectedValue({
      status: 401,
      message: "invalid fake-anthropic-key prompt-secret",
    });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /Anthropic provider request failed \(HTTP 401\)/,
    );
    await expect(provider.generate("prompt-secret")).rejects.not.toThrow(
      /fake-anthropic-key|prompt-secret|invalid/,
    );
  });
});

describe("AnthropicProvider Messages streaming", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accumulates ordered text deltas and ignores non-text events", async () => {
    const { provider, client } = providerWithClient();
    client.messages.stream.mockReturnValue(
      (async function* () {
        yield { type: "message_start", message: {} };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        };
        yield { type: "message_stop" };
      })(),
    );
    const tokens: string[] = [];

    await expect(
      provider.generateStream!("prompt", {}, (token) => tokens.push(token)),
    ).resolves.toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(client.messages.stream).toHaveBeenCalledWith({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      messages: [{ role: "user", content: "prompt" }],
      stream: true,
    });
  });

  it("rejects a stream cut off at max_tokens without replaying it", async () => {
    const { provider, client } = providerWithClient();
    client.messages.stream.mockReturnValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        };
        yield { type: "message_delta", delta: { stop_reason: "max_tokens" } };
        yield { type: "message_stop" };
      })(),
    );
    const tokens: string[] = [];

    await expect(
      provider.generateStream!("prompt", {}, (token) => tokens.push(token)),
    ).rejects.toThrow(/Anthropic provider response stopped at max_tokens/);
    expect(tokens).toEqual(["partial"]);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
  });

  it("reports a streamed refusal once", async () => {
    const { provider, client } = providerWithClient();
    client.messages.stream.mockReturnValue(
      (async function* () {
        yield { type: "message_delta", delta: { stop_reason: "refusal" } };
        yield { type: "message_stop" };
      })(),
    );

    await expect(
      provider.generateStream!("prompt-secret", {}, jest.fn()),
    ).rejects.toThrow(/Anthropic provider declined the request/);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
  });

  it("rejects a stream that ends without a message_stop event", async () => {
    const { provider, client } = providerWithClient();
    client.messages.stream.mockReturnValue(
      (async function* () {
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        };
      })(),
    );

    await expect(
      provider.generateStream!("prompt-secret", {}, jest.fn()),
    ).rejects.toThrow(/Anthropic provider stream failed after output/);
  });

  it("does not replay a stream after a retryable failure follows emitted output", async () => {
    jest.useFakeTimers();
    try {
      const { provider, client } = providerWithClient();
      client.messages.stream.mockReturnValue(
        (async function* () {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          };
          throw { status: 503, message: "retryable body" };
        })(),
      );
      const tokens: string[] = [];

      const resultPromise = provider.generateStream!("prompt", {}, (token) =>
        tokens.push(token),
      );
      const settled = resultPromise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await jest.runAllTimersAsync();
      const result = await settled;
      const error = "error" in result ? result.error : undefined;

      expect((error as Error).message).toMatch(/stream failed after output/);
      expect(tokens).toEqual(["partial"]);
      expect(client.messages.stream).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
