import { defaultConfig, type AidocConfig } from "../../../src/config/schema";
import {
  ProviderConfigurationError,
  type ProviderPrompter,
  confirmProviderBoundary,
  resolveProviderSelection,
} from "../../../src/providers/selection";
import { registerProvider } from "../../../src/providers/registry";

function config(overrides: Partial<AidocConfig> = {}): AidocConfig {
  return { ...defaultConfig, ...overrides };
}

function prompter(overrides: Partial<ProviderPrompter> = {}): ProviderPrompter {
  return {
    chooseProvider: jest.fn().mockResolvedValue(null),
    chooseOllamaModel: jest.fn().mockResolvedValue(null),
    configureQwen: jest.fn().mockResolvedValue(null),
    confirmBoundary: jest.fn().mockResolvedValue(true),
    rememberSelection: jest.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("resolveProviderSelection", () => {
  it("gives command provider and model overrides highest precedence", async () => {
    const selection = await resolveProviderSelection({
      config: config({ provider: "auto", model: "project-model" }),
      overrides: { provider: "openai", model: "command-model" },
      env: {
        STALEDOCS_PROVIDER: "anthropic",
        STALEDOCS_MODEL: "environment-model",
        OPENAI_API_KEY: "command-secret",
      },
      interactive: false,
    });

    expect(selection).toMatchObject({
      provider: "openai",
      model: "command-model",
      source: "command",
      credentialEnv: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(selection)).not.toContain("command-secret");
  });

  it("treats an explicit auto value as selection mode rather than a transport", async () => {
    const selection = await resolveProviderSelection({
      config: config({ provider: "openai" }),
      overrides: { provider: "auto" },
      env: {
        OPENAI_API_KEY: "openai-secret",
      },
      interactive: true,
    });

    expect(selection).toMatchObject({
      provider: "openai",
      source: "detected",
    });
  });

  it("uses effective environment values before project configuration", async () => {
    const selection = await resolveProviderSelection({
      config: config({ provider: "ollama", model: "project-model" }),
      env: {
        STALEDOCS_PROVIDER: "openai",
        STALEDOCS_MODEL: "environment-model",
        OPENAI_API_KEY: "environment-secret",
      },
      interactive: false,
    });

    expect(selection).toMatchObject({
      provider: "openai",
      model: "environment-model",
      source: "environment",
    });
  });

  it("uses an explicit project provider before availability detection", async () => {
    const selection = await resolveProviderSelection({
      config: config({ provider: "deepseek" }),
      env: {
        DEEPSEEK_API_KEY: "deepseek-secret",
        OPENAI_API_KEY: "openai-secret",
      },
      interactive: false,
    });

    expect(selection).toMatchObject({
      provider: "deepseek",
      source: "project",
      credentialEnv: "DEEPSEEK_API_KEY",
    });
    expect(JSON.stringify(selection)).not.toContain("deepseek-secret");
    expect(JSON.stringify(selection)).not.toContain("openai-secret");
  });

  it("detects the sole ready remote key only for an interactive auto selection", async () => {
    const selection = await resolveProviderSelection({
      config: config(),
      env: { OPENAI_API_KEY: "openai-secret" },
      interactive: true,
    });

    expect(selection).toMatchObject({
      provider: "openai",
      source: "detected",
      model: "gpt-6-luna",
      credentialEnv: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(selection)).not.toContain("openai-secret");
  });

  it("requires explicit remote provider configuration in non-interactive mode", async () => {
    await expect(
      resolveProviderSelection({
        config: config(),
        env: { OPENAI_API_KEY: "openai-secret" },
        interactive: false,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_SELECTION_REQUIRED" });
  });

  it("does not rank multiple ready remote keys", async () => {
    const chooseProvider = jest.fn().mockResolvedValue("deepseek");
    const selection = await resolveProviderSelection({
      config: config(),
      env: {
        OPENAI_API_KEY: "openai-secret",
        DEEPSEEK_API_KEY: "deepseek-secret",
      },
      interactive: true,
      prompter: prompter({ chooseProvider }),
    });

    expect(chooseProvider).toHaveBeenCalled();
    expect(selection).toMatchObject({
      provider: "deepseek",
      source: "interactive",
    });
    expect(JSON.stringify(selection)).not.toContain("openai-secret");
    expect(JSON.stringify(selection)).not.toContain("deepseek-secret");
  });

  it("fails a selected unavailable provider without falling back", async () => {
    const chooseProvider = jest.fn();
    await expect(
      resolveProviderSelection({
        config: config({ provider: "openai" }),
        env: { DEEPSEEK_API_KEY: "deepseek-secret" },
        interactive: true,
        prompter: prompter({ chooseProvider }),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_SELECTION_REQUIRED" });
    expect(chooseProvider).not.toHaveBeenCalled();
  });

  it("rejects a forbidden Qwen plan before inspecting its credential", async () => {
    let credentialReads = 0;
    const env = {} as NodeJS.ProcessEnv;
    Object.defineProperty(env, "DASHSCOPE_API_KEY", {
      get: () => {
        credentialReads += 1;
        return "qwen-secret";
      },
      enumerable: true,
    });
    const configureQwen = jest.fn().mockResolvedValue({
      plan: "coding-plan",
      region: "singapore",
      workspaceId: "workspace-123",
    });

    await expect(
      resolveProviderSelection({
        config: config({ provider: "qwen" }),
        env,
        interactive: true,
        prompter: prompter({ configureQwen }),
      }),
    ).rejects.toMatchObject({
      code: "QWEN_PLAN_NOT_PERMITTED_FOR_CUSTOM_APP",
    });
    expect(configureQwen).toHaveBeenCalledTimes(1);
    expect(credentialReads).toBe(0);
  });

  it("returns null when Qwen onboarding is cancelled", async () => {
    await expect(
      resolveProviderSelection({
        config: config({ provider: "qwen" }),
        env: { DASHSCOPE_API_KEY: "qwen-secret" },
        interactive: true,
        prompter: prompter({
          configureQwen: jest.fn().mockResolvedValue(null),
        }),
      }),
    ).resolves.toBeNull();
  });

  it("uses the effective Qwen region and workspace environment values", async () => {
    const result = await resolveProviderSelection({
      config: config({ provider: "qwen" }),
      env: {
        DASHSCOPE_API_KEY: "qwen-secret",
        STALEDOCS_QWEN_REGION: "singapore",
        STALEDOCS_QWEN_WORKSPACE_ID: "workspace-123",
      },
      interactive: false,
    });

    expect(result?.endpoint?.url.toString()).toBe(
      "https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("detects Ollama and uses an explicitly configured model without a remote key", async () => {
    const selection = await resolveProviderSelection({
      config: config({ model: "llama3" }),
      env: {},
      interactive: false,
      listOllamaModels: jest.fn().mockResolvedValue(["llama3", "qwen2"]),
    });

    expect(selection).toMatchObject({
      provider: "ollama",
      model: "llama3",
      boundary: "local",
      source: "detected",
    });
  });

  it("requires an Ollama model when none is configured", async () => {
    await expect(
      resolveProviderSelection({
        config: config(),
        env: {},
        interactive: false,
        listOllamaModels: jest.fn().mockResolvedValue(["llama3"]),
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_SELECTION_REQUIRED",
      message:
        "Ollama needs an installed model. Set STALEDOCS_PROVIDER=ollama STALEDOCS_MODEL=<installed-model> before running non-interactively.",
    });
  });

  it("reports an exact missing credential for an explicit remote provider", async () => {
    await expect(
      resolveProviderSelection({
        config: config({ provider: "openai" }),
        env: {},
        interactive: false,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_SELECTION_REQUIRED",
      message:
        'Provider "openai" is configured but OPENAI_API_KEY is missing. Set OPENAI_API_KEY in the environment before running.',
    });
  });

  it("uses a same-recorded legacy key for availability without returning it", async () => {
    const legacyKey = "legacy-openai-secret";
    const result = await resolveProviderSelection({
      config: config({ provider: "openai", apiKey: legacyKey }),
      env: {},
      interactive: false,
    });

    expect(result).toMatchObject({
      provider: "openai",
      source: "project",
      credentialEnv: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(result)).not.toContain(legacyKey);
  });

  it("does not expose a differently recorded legacy key to custom availability", async () => {
    const providerName = "legacy-availability-provider";
    const legacyKey = "legacy-openai-secret";
    const available = jest.fn().mockReturnValue(true);
    registerProvider({
      name: providerName,
      available,
      create: () => ({
        name: providerName,
        generate: async () => "",
      }),
    });

    const result = await resolveProviderSelection({
      config: config({ provider: "openai", apiKey: legacyKey }),
      overrides: { provider: providerName },
      env: {},
      interactive: false,
    });
    const environmentResult = await resolveProviderSelection({
      config: config({ provider: "openai", apiKey: legacyKey }),
      env: { STALEDOCS_PROVIDER: providerName },
      interactive: false,
    });

    expect(result?.provider).toBe(providerName);
    expect(environmentResult?.provider).toBe(providerName);
    expect(available).toHaveBeenCalledTimes(2);
    for (const [availableConfig] of available.mock.calls) {
      expect(availableConfig.apiKey).toBeUndefined();
      expect(JSON.stringify(availableConfig)).not.toContain(legacyKey);
    }
    expect(JSON.stringify(result)).not.toContain(legacyKey);
    expect(JSON.stringify(environmentResult)).not.toContain(legacyKey);
  });

  it("tells non-interactive users to disambiguate multiple ready remote providers", async () => {
    await expect(
      resolveProviderSelection({
        config: config(),
        env: {
          OPENAI_API_KEY: "openai-secret",
          DEEPSEEK_API_KEY: "deepseek-secret",
        },
        interactive: false,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_SELECTION_REQUIRED",
      message:
        "Multiple remote providers are ready. Set STALEDOCS_PROVIDER explicitly before running non-interactively.",
    });
  });

  it("attaches truthful loopback endpoint metadata to Ollama selections", async () => {
    const listOllamaModels = jest.fn().mockResolvedValue(["llama3"]);
    const result = await resolveProviderSelection({
      config: config({
        provider: "ollama",
        model: "llama3",
        ollamaHost: "http://127.0.0.1:11434",
      }),
      env: {},
      interactive: false,
      listOllamaModels,
    });

    expect(result).toMatchObject({
      provider: "ollama",
      boundary: "local",
      endpoint: {
        origin: "http://127.0.0.1:11434",
        local: true,
      },
    });
    expect(listOllamaModels).not.toHaveBeenCalled();
  });

  it("rejects an Ollama host that is not an approved loopback HTTP endpoint", async () => {
    await expect(
      resolveProviderSelection({
        config: config({
          provider: "ollama",
          model: "llama3",
          ollamaHost: "http://10.0.0.4:11434",
        }),
        env: {},
        interactive: false,
        listOllamaModels: jest.fn().mockResolvedValue(["llama3"]),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ENDPOINT_NOT_PUBLIC" });
  });

  it("preserves interactive Qwen region metadata without the credential", async () => {
    const result = await resolveProviderSelection({
      config: config({ provider: "qwen" }),
      env: { DASHSCOPE_API_KEY: "qwen-secret" },
      interactive: true,
      prompter: prompter({
        configureQwen: jest.fn().mockResolvedValue({
          plan: "pay-as-you-go",
          region: "singapore",
          workspaceId: "workspace-123",
        }),
      }),
    });

    expect(result?.qwen).toEqual({
      region: "singapore",
      workspaceId: "workspace-123",
    });
    expect(JSON.stringify(result)).not.toContain("qwen-secret");
  });

  it("allows interactive Ollama model choice from discovered models", async () => {
    const chooseOllamaModel = jest.fn().mockResolvedValue("qwen2");
    const selection = await resolveProviderSelection({
      config: config({ provider: "ollama" }),
      env: {},
      interactive: true,
      listOllamaModels: jest.fn().mockResolvedValue(["llama3", "qwen2"]),
      prompter: prompter({ chooseOllamaModel }),
    });

    expect(chooseOllamaModel).toHaveBeenCalledWith(["llama3", "qwen2"]);
    expect(selection).toMatchObject({
      provider: "ollama",
      model: "qwen2",
      source: "project",
    });
  });

  it("returns null when interactive onboarding is cancelled", async () => {
    const selection = await resolveProviderSelection({
      config: config(),
      env: {},
      interactive: true,
      prompter: prompter({ chooseProvider: jest.fn().mockResolvedValue(null) }),
    });

    expect(selection).toBeNull();
  });
});

describe("confirmProviderBoundary", () => {
  const selection = {
    provider: "openai",
    model: "gpt-5.6-luna",
    source: "command" as const,
    boundary: "remote" as const,
    credentialEnv: "OPENAI_API_KEY",
  };

  it("lets yes skip only an already explicit provider confirmation", async () => {
    await expect(
      confirmProviderBoundary({
        selection,
        targetPaths: ["docs/z.md", "README.md"],
        contextBytes: 512,
        trustPolicy: "redact",
        interactive: true,
        yes: true,
      }),
    ).resolves.toBe(true);
  });

  it("does not silently confirm a remote boundary in non-interactive mode", async () => {
    await expect(
      confirmProviderBoundary({
        selection,
        targetPaths: ["README.md"],
        contextBytes: 1,
        trustPolicy: "redact",
        interactive: false,
        yes: false,
      }),
    ).resolves.toBe(false);
  });

  it("passes a non-secret boundary summary to the interactive prompter", async () => {
    const confirmBoundary = jest.fn().mockResolvedValue(true);
    const result = await confirmProviderBoundary({
      selection,
      targetPaths: ["docs/z.md", "README.md"],
      contextBytes: 512,
      trustPolicy: "strict",
      interactive: true,
      yes: false,
      prompter: prompter({ confirmBoundary }),
    });

    expect(result).toBe(true);
    expect(confirmBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        origin: "https://api.openai.com",
        boundary: "remote",
        targetPaths: ["README.md", "docs/z.md"],
        contextBytes: 512,
        trustPolicy: "strict",
      }),
    );
    expect(JSON.stringify(confirmBoundary.mock.calls[0][0])).not.toContain(
      "OPENAI_API_KEY",
    );
  });

  it("includes a truthful Ollama origin in the boundary summary", async () => {
    const confirmBoundary = jest.fn().mockResolvedValue(true);
    await confirmProviderBoundary({
      selection: {
        provider: "ollama",
        model: "llama3",
        source: "project",
        boundary: "local",
        endpoint: {
          url: new URL("http://127.0.0.1:11434"),
          origin: "http://127.0.0.1:11434",
          local: true,
          addresses: [{ address: "127.0.0.1", family: 4 }],
        },
      },
      targetPaths: ["README.md"],
      contextBytes: 128,
      trustPolicy: "redact",
      interactive: true,
      yes: false,
      prompter: prompter({ confirmBoundary }),
    });

    expect(confirmBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        origin: "http://127.0.0.1:11434",
      }),
    );
  });

  it("rejects an unresolved auto selection even when yes is supplied", async () => {
    await expect(
      confirmProviderBoundary({
        selection: {
          ...selection,
          provider: "auto",
        },
        targetPaths: [],
        contextBytes: 0,
        trustPolicy: "warn",
        interactive: false,
        yes: true,
      }),
    ).rejects.toBeInstanceOf(ProviderConfigurationError);
  });
});
