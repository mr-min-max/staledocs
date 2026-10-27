import { defaultConfig } from "../../../src/config/schema";
import {
  PROVIDER_PROFILES,
  getProviderProfile,
} from "../../../src/providers/profiles";
import { createProvider } from "../../../src/providers/registry";

describe("built-in provider profiles", () => {
  it("exposes the locked provider metadata without credential values", () => {
    expect(PROVIDER_PROFILES.map((profile) => profile.name)).toEqual([
      "openai",
      "anthropic",
      "deepseek",
      "qwen",
      "ollama",
      "openai-compatible",
    ]);
    expect(getProviderProfile("openai")).toMatchObject({
      transport: "openai-responses",
      boundary: "remote",
      credentialEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-5.6-luna",
    });
    expect(getProviderProfile("anthropic")).toMatchObject({
      transport: "anthropic-messages",
      credentialEnv: "ANTHROPIC_API_KEY",
      defaultModel: "claude-sonnet-5-5",
    });
    expect(getProviderProfile("deepseek")).toMatchObject({
      transport: "openai-compatible-chat",
      credentialEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-v4-flash",
    });
    expect(getProviderProfile("qwen")).toMatchObject({
      transport: "openai-compatible-chat",
      credentialEnv: "DASHSCOPE_API_KEY",
      defaultModel: "qwen3.6-flash",
    });
    expect(getProviderProfile("ollama")).toMatchObject({
      transport: "ollama",
      boundary: "local",
    });
    expect(getProviderProfile("ollama")?.defaultModel).toBeUndefined();
    expect(getProviderProfile("openai-compatible")).toMatchObject({
      transport: "openai-compatible-chat",
      credentialEnv: "STALEDOCS_COMPAT_API_KEY",
      boundary: "remote",
    });
    expect(getProviderProfile("not-a-provider")).toBeUndefined();

    expect(Object.isFrozen(PROVIDER_PROFILES)).toBe(true);
    for (const profile of PROVIDER_PROFILES) {
      expect(Object.isFrozen(profile)).toBe(true);
    }
    expect(JSON.stringify(PROVIDER_PROFILES)).not.toContain("apiKey");
    expect(JSON.stringify(PROVIDER_PROFILES)).not.toContain("secret");
  });

  it("uses auto as the provider selection state by default", () => {
    expect(defaultConfig.provider).toBe("auto");
    expect(defaultConfig.allowLocalHttp).toBe(false);
    expect(defaultConfig.providerBaseUrl).toBeUndefined();
  });

  it("does not construct the auto selection state as a transport", () => {
    expect(() => createProvider({ provider: "auto" })).toThrow(
      expect.objectContaining({
        code: "PROVIDER_SELECTION_REQUIRED",
      }),
    );
  });
});
