import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";

describe("Browser Harness exec environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not inherit ambient Gateway credentials in minimal mode", () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-reach-browser-python");
    vi.stubEnv("BROWSER_USE_API_KEY", "must-not-reach-browser-python");
    vi.stubEnv("GH_TOKEN", "must-not-reach-browser-python");
    vi.stubEnv("GITHUB_TOKEN", "must-not-reach-browser-python");

    const { env } = resolvePreparedExecEnvironment({
      execParams: {
        command: "browser-harness",
        env: {
          BH_RUNTIME_DIR: "/tmp/oc-bh/run",
          BH_TELEMETRY: "0",
        },
      },
      host: "gateway",
      defaultPathPrepend: [],
      pluginEnv: { PLUGIN_SECRET: "must-not-reach-browser-python" },
      storeEnv: { STORED_SECRET: "must-not-reach-browser-python" },
      storeSecretEnv: { SECRET_SENTINEL: "must-not-reach-browser-python" },
      secretEgressEnv: { SECRET_EGRESS: "must-not-reach-browser-python" },
      managedLocalIdentity: false,
      localIdentityEnv: {
        GH_CONFIG_DIR: "/private/github-profile",
        GH_TOKEN: "must-not-reach-browser-python",
      },
      warnings: [],
      environmentMode: "minimal",
    });

    expect(env.BH_RUNTIME_DIR).toBe("/tmp/oc-bh/run");
    expect(env.BH_TELEMETRY).toBe("0");
    expect(env.PATH).toBeTruthy();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BROWSER_USE_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBeUndefined();
    expect(env.PLUGIN_SECRET).toBeUndefined();
    expect(env.STORED_SECRET).toBeUndefined();
    expect(env.SECRET_SENTINEL).toBeUndefined();
    expect(env.SECRET_EGRESS).toBeUndefined();
  });
});
