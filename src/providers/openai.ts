import OpenAI from "openai";
import type { OpenAI as OpenAITypes } from "openai";
import { withRetry } from "../core/retry";
import { GenerateOptions, LLMProvider } from "./types";

const DEFAULT_MODEL = "gpt-6-luna";
const INCOMPLETE_MESSAGE = "OpenAI provider response was incomplete";

function safeStatus(error: unknown): number | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const status = Reflect.get(error, "status");
    return typeof status === "number" && Number.isInteger(status)
      ? status
      : undefined;
  } catch {
    return undefined;
  }
}

function safeCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function providerError(phase: "request" | "stream", error: unknown): Error {
  const status = safeStatus(error);
  if (status !== undefined && status >= 100 && status <= 599) {
    return new Error(`OpenAI provider ${phase} failed (HTTP ${status})`);
  }

  const code = safeCode(error);
  if (
    code === "etimedout" ||
    code === "econnreset" ||
    code === "econnrefused" ||
    code === "timeout" ||
    code === "aborted" ||
    code === "abort_err"
  ) {
    return new Error(`OpenAI provider ${phase} failed (network timeout)`);
  }
  return new Error(`OpenAI provider ${phase} failed`);
}

function requestParams(
  model: string,
  prompt: string,
  options: GenerateOptions,
  stream: false,
): OpenAITypes.Responses.ResponseCreateParamsNonStreaming;
function requestParams(
  model: string,
  prompt: string,
  options: GenerateOptions,
  stream: true,
): OpenAITypes.Responses.ResponseCreateParamsStreaming;
function requestParams(
  model: string,
  prompt: string,
  options: GenerateOptions,
  stream: boolean,
): OpenAITypes.Responses.ResponseCreateParams {
  const params: OpenAITypes.Responses.ResponseCreateParams = {
    model,
    input: prompt,
    ...(stream ? { stream: true } : {}),
    ...(options.systemPrompt === undefined
      ? {}
      : { instructions: options.systemPrompt }),
    ...(options.maxTokens === undefined
      ? {}
      : { max_output_tokens: options.maxTokens }),
    // No temperature: current OpenAI models are reasoning models, and leaving
    // sampling at its default is accepted by every model.
    ...(options.responseFormat === "json"
      ? { text: { format: { type: "json_object" } } }
      : {}),
  };
  return params;
}

function outputText(response: OpenAITypes.Responses.Response): string {
  if (response.status === "incomplete") throw new Error(INCOMPLETE_MESSAGE);
  if (
    typeof response.output_text !== "string" ||
    response.output_text.trim() === ""
  ) {
    throw new Error("OpenAI provider returned no text");
  }
  return response.output_text;
}

/** OpenAI Responses provider with retry and truthful streaming support. */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  /** Generates a non-streaming completion through the Responses API. */
  async generate(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<string> {
    const run = async (): Promise<string> => {
      try {
        const response = await this.client.responses.create(
          requestParams(this.model, prompt, options, false),
        );
        return outputText(response);
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message === "OpenAI provider returned no text" ||
            error.message === INCOMPLETE_MESSAGE)
        ) {
          throw error;
        }
        throw providerError("request", error);
      }
    };

    return withRetry(run, { maxRetries: 3 });
  }

  /** Streams only response.output_text.delta events in provider order. */
  async generateStream(
    prompt: string,
    options: GenerateOptions,
    onToken: (token: string) => void,
  ): Promise<string> {
    let emitted = false;
    const emit = (token: string): void => {
      emitted = true;
      onToken(token);
    };
    const run = async (): Promise<string> => {
      let sawTerminalEvent = false;
      try {
        const stream = await this.client.responses.create(
          requestParams(this.model, prompt, options, true),
        );
        let full = "";
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            if (typeof event.delta !== "string") {
              throw new Error("OpenAI provider stream returned invalid text");
            }
            if (event.delta.length > 0) {
              full += event.delta;
              emit(event.delta);
            }
            continue;
          }

          if (event.type === "response.completed") {
            sawTerminalEvent = true;
            continue;
          }

          if (
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            throw new Error("OpenAI provider stream failed");
          }

          if ((event.type as string) === "error") {
            throw new Error("OpenAI provider stream failed");
          }
        }

        if (!sawTerminalEvent) {
          throw new Error("OpenAI provider stream ended prematurely");
        }
        if (full.trim() === "") {
          throw new Error("OpenAI provider returned no text");
        }
        return full;
      } catch (error: unknown) {
        if (emitted) {
          return Promise.reject(
            new Error("OpenAI provider stream failed after output"),
          );
        }
        if (
          error instanceof Error &&
          (error.message === "OpenAI provider returned no text" ||
            error.message === "OpenAI provider stream returned invalid text" ||
            error.message === "OpenAI provider stream failed" ||
            error.message === "OpenAI provider stream ended prematurely")
        ) {
          throw error;
        }
        throw providerError("stream", error);
      }
    };

    return withRetry(run, { maxRetries: 3 });
  }
}
