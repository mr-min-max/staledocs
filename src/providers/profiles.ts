export type BuiltInProviderName =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "qwen"
  | "ollama"
  | "openai-compatible";

export type ProviderTransportKind =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-compatible-chat"
  | "ollama";

export interface ProviderProfile {
  readonly name: BuiltInProviderName;
  readonly displayName: string;
  readonly credentialEnv?: string;
  readonly defaultModel?: string;
  readonly transport: ProviderTransportKind;
  readonly boundary: "remote" | "local";
}

function profile(input: ProviderProfile): ProviderProfile {
  return Object.freeze(input);
}

export const PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze([
  profile({
    name: "openai",
    displayName: "OpenAI",
    credentialEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-luna",
    transport: "openai-responses",
    boundary: "remote",
  }),
  profile({
    name: "anthropic",
    displayName: "Anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5-5",
    transport: "anthropic-messages",
    boundary: "remote",
  }),
  profile({
    name: "deepseek",
    displayName: "DeepSeek",
    credentialEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    transport: "openai-compatible-chat",
    boundary: "remote",
  }),
  profile({
    name: "qwen",
    displayName: "Qwen / Alibaba Model Studio",
    credentialEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3.6-flash",
    transport: "openai-compatible-chat",
    boundary: "remote",
  }),
  profile({
    name: "ollama",
    displayName: "Ollama",
    transport: "ollama",
    boundary: "local",
  }),
  profile({
    name: "openai-compatible",
    displayName: "OpenAI-compatible endpoint",
    credentialEnv: "STALEDOCS_COMPAT_API_KEY",
    transport: "openai-compatible-chat",
    boundary: "remote",
  }),
]);

const profileByName = new Map<string, ProviderProfile>(
  PROVIDER_PROFILES.map((item) => [item.name, item]),
);

/** Returns the immutable built-in provider profile for a known provider name. */
export function getProviderProfile(name: string): ProviderProfile | undefined {
  return profileByName.get(name);
}
