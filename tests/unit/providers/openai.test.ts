import { OpenAIProvider } from "../../../src/providers/openai";

jest.mock("openai", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
      responses: {
        create: jest.fn(),
      },
    })),
  };
});

type MockedOpenAIClient = {
  chat: { completions: { create: jest.Mock } };
  responses: { create: jest.Mock };
};

function clientOf(provider: OpenAIProvider): MockedOpenAIClient {
  return (provider as unknown as { client: MockedOpenAIClient }).client;
}

function responseTextDelta(delta: string): Record<string, unknown> {
  return {
    type: "response.output_text.delta",
    content_index: 0,
    delta,
    item_id: "item-test",
    logprobs: [],
    output_index: 0,
    sequence_number: 1,
  };
}

describe("OpenAIProvider Responses transport", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses the current Responses request shape and exact default model", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create.mockResolvedValue({ output_text: '{"ok":true}' });

    await expect(
      provider.generate("prompt-value", {
        systemPrompt: "system-value",
        maxTokens: 2048,
        responseFormat: "json",
      }),
    ).resolves.toBe('{"ok":true}');

    expect(client.responses.create).toHaveBeenCalledWith({
      model: "gpt-6-luna",
      instructions: "system-value",
      input: "prompt-value",
      max_output_tokens: 2048,
      text: { format: { type: "json_object" } },
    });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("never sends sampling parameters", async () => {
    const provider = new OpenAIProvider("fake-openai-key", "caller-model");
    const client = clientOf(provider);
    client.responses.create.mockResolvedValue({ output_text: "ok" });

    await provider.generate("prompt", { temperature: 0.15 });

    expect(client.responses.create).toHaveBeenCalledWith({
      model: "caller-model",
      input: "prompt",
    });
  });

  it("rejects an incomplete response instead of returning partial text", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create.mockResolvedValue({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "partial",
    });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /OpenAI provider response was incomplete/,
    );
    expect(client.responses.create).toHaveBeenCalledTimes(1);
  });

  it("extracts output_text and rejects malformed or empty output safely", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create
      .mockResolvedValueOnce({ output_text: 42 })
      .mockResolvedValueOnce({ output_text: "" });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /OpenAI provider returned no text/,
    );
    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /OpenAI provider returned no text/,
    );
    await expect(provider.generate("prompt-secret")).rejects.not.toThrow(
      /prompt-secret|fake-openai-key|42/,
    );
  });

  it("retries a 429 and then returns the successful response", async () => {
    jest.useFakeTimers();
    try {
      const provider = new OpenAIProvider("fake-openai-key");
      const client = clientOf(provider);
      client.responses.create
        .mockRejectedValueOnce({
          status: 429,
          message: "body has fake-openai-key",
        })
        .mockResolvedValueOnce({ output_text: "ok" });

      const resultPromise = provider.generate("prompt");
      await jest.runAllTimersAsync();

      await expect(resultPromise).resolves.toBe("ok");
      expect(client.responses.create).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not retry a non-retryable SDK failure or expose its body", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create.mockRejectedValue({
      status: 401,
      message: "invalid key fake-openai-key and prompt-secret",
      body: { prompt: "prompt-secret" },
    });

    await expect(provider.generate("prompt-secret")).rejects.toThrow(
      /OpenAI provider request failed \(HTTP 401\)/,
    );
    await expect(provider.generate("prompt-secret")).rejects.not.toThrow(
      /fake-openai-key|prompt-secret|invalid key/,
    );
    expect(client.responses.create).toHaveBeenCalledTimes(2);
  });
});

describe("OpenAIProvider Responses streaming", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accumulates only ordered output_text deltas", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create.mockResolvedValue(
      (async function* () {
        yield { type: "response.created", response: {} };
        yield responseTextDelta("Hel");
        yield { type: "response.reasoning_text.delta", delta: "ignore" };
        yield responseTextDelta("lo");
        yield { type: "response.completed", response: {} };
      })(),
    );
    const tokens: string[] = [];

    await expect(
      provider.generateStream!("prompt", {}, (token) => tokens.push(token)),
    ).resolves.toBe("Hello");
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(client.responses.create).toHaveBeenCalledWith({
      model: "gpt-6-luna",
      input: "prompt",
      stream: true,
    });
  });

  it("rejects a terminal Responses failure through the sanitized path", async () => {
    const provider = new OpenAIProvider("fake-openai-key");
    const client = clientOf(provider);
    client.responses.create.mockResolvedValue(
      (async function* () {
        yield responseTextDelta("partial");
        yield {
          type: "response.failed",
          response: {
            error: { message: "prompt-secret fake-openai-key" },
          },
        };
      })(),
    );

    const result = provider.generateStream!("prompt-secret", {}, jest.fn());
    await expect(result).rejects.toThrow(/OpenAI provider stream failed/);
    await expect(result).rejects.not.toThrow(/prompt-secret|fake-openai-key/);
  });

  it("does not replay a stream after a retryable failure follows emitted output", async () => {
    jest.useFakeTimers();
    try {
      const provider = new OpenAIProvider("fake-openai-key");
      const client = clientOf(provider);
      client.responses.create.mockResolvedValueOnce(
        (async function* () {
          yield responseTextDelta("partial");
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
      expect(client.responses.create).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
