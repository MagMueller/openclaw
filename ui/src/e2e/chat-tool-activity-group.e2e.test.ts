// Control UI E2E covers the transcript's canonical tool-activity presentation.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI tool activity group",
  browserLaunchOptions: { headless: false },
  startServerBeforeBrowser: true,
});

const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
const proofState = process.env.OPENCLAW_TOOL_ACTIVITY_PROOF_STATE?.trim() || "after";

async function capture(page: import("playwright").Page, name: string, theme: "light" | "dark") {
  if (!artifactDir) {
    return;
  }
  await page.emulateMedia({ colorScheme: theme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
    .toBe(theme);
  await fs.mkdir(artifactDir, { recursive: true });
  await page.locator(".chat-main").screenshot({
    path: path.join(artifactDir, `${proofState}-${name}-${theme}.png`),
  });
}

function toolCall(id: string, name: string, args: unknown, timestamp: number) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    timestamp,
  };
}

function toolResult(id: string, name: string, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    timestamp,
  };
}

suite.define(() => {
  it("keeps a rich streamed turn in one inspectable activity trace", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem("openclaw.confetti.firstReply", "1");
    });
    const sessionKey = "agent:main:dashboard:tool-activity-proof";
    const timestamp = Date.UTC(2026, 7, 15, 12, 0);
    const gateway = await installMockGateway(page, {
      sessionKey,
      historyMessages: [
        {
          role: "user",
          content: "Inspect the existing release workflow.",
          timestamp,
        },
        toolCall(
          "historical-read",
          "read",
          { path: "/workspace/src/release-plan.ts" },
          timestamp + 1_000,
        ),
        toolResult(
          "historical-read",
          "read",
          "export const releaseChannel = 'beta';",
          timestamp + 2_000,
        ),
        toolCall(
          "historical-command",
          "exec",
          { command: "git status --short" },
          timestamp + 3_000,
        ),
        toolResult(
          "historical-command",
          "exec",
          "M ui/src/pages/chat/chat-thread.ts",
          timestamp + 4_000,
        ),
        {
          role: "assistant",
          content: "The existing workflow targets the beta channel.",
          timestamp: timestamp + 5_000,
        },
      ],
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await page
      .getByText("The existing workflow targets the beta channel.", { exact: true })
      .waitFor();

    const prompt =
      "Update the release workflow, inspect the affected files, and run the focused checks.";
    await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const runId = (send.params as { idempotencyKey?: string }).idempotencyKey;
    if (!runId) {
      throw new Error("chat.send did not include an idempotency key");
    }

    await page.getByText(prompt, { exact: true }).waitFor();
    if (proofState !== "before") {
      const thinkingGroup = page.locator(".chat-activity-group").last();
      await expect.poll(() => thinkingGroup.locator(".chat-reading-indicator").count()).toBe(1);
      await expect.poll(() => thinkingGroup.locator(".claw-icon__jaw").count()).toBe(1);
    }
    await capture(page, "thinking", "light");
    await capture(page, "thinking", "dark");

    const emitTool = async (seq: number, data: Record<string, unknown>) => {
      await gateway.emitGatewayEvent("agent", {
        runId,
        seq,
        stream: "tool",
        ts: timestamp + 6_000 + seq,
        sessionKey,
        data,
      });
    };

    await emitTool(1, {
      phase: "start",
      toolCallId: "current-command",
      name: "exec",
      args: { command: "pnpm check:changed" },
    });
    await emitTool(2, {
      phase: "result",
      toolCallId: "current-command",
      name: "exec",
      result: { text: "Checks selected: ui", details: { exitCode: 0, durationMs: 842 } },
    });
    await emitTool(3, {
      phase: "start",
      toolCallId: "current-command-two",
      name: "exec",
      args: { command: "pnpm test ui/src/pages/chat" },
    });
    await emitTool(4, {
      phase: "result",
      toolCallId: "current-command-two",
      name: "exec",
      result: { text: "42 tests passed", details: { exitCode: 0, durationMs: 1_420 } },
    });
    await emitTool(5, {
      phase: "start",
      toolCallId: "current-read",
      name: "read",
      args: { path: "/workspace/ui/src/pages/chat/chat-thread.ts" },
    });
    await emitTool(6, {
      phase: "result",
      toolCallId: "current-read",
      name: "read",
      result: { text: "export function renderChatThread() {}" },
    });
    await emitTool(7, {
      phase: "start",
      toolCallId: "current-search",
      name: "web_search",
      args: { query: "accessible disclosure animation" },
    });
    await emitTool(8, {
      phase: "result",
      toolCallId: "current-search",
      name: "web_search",
      result: { text: "Three relevant references" },
    });
    await emitTool(9, {
      phase: "start",
      toolCallId: "current-edit",
      name: "apply_patch",
      args: {
        changes: [
          {
            path: "ui/src/pages/chat/chat-thread.ts",
            kind: { type: "update" },
            diff: "@@\n-export const oldFlow = true;\n+export const groupedFlow = true;",
          },
          {
            path: "ui/src/lib/chat/activity-summary.ts",
            kind: { type: "add" },
            diff: "+export const activitySummary = true;",
          },
        ],
      },
    });

    if (proofState === "before") {
      await expect
        .poll(() => page.locator(".chat-activity-group__summary").count())
        .toBeGreaterThan(0);
    } else {
      await expect
        .poll(() => page.locator(".chat-activity-group__label").last().textContent())
        .toBe("Editing files");
      await expect
        .poll(() => page.locator(".chat-activity-group").last().getAttribute("class"))
        .toContain("is-open");
    }
    await capture(page, "active", "light");
    await capture(page, "active", "dark");

    await emitTool(10, {
      phase: "result",
      toolCallId: "current-edit",
      name: "apply_patch",
      result: { text: "Applied patch" },
    });
    await gateway.emitChatFinal({
      runId,
      text: "The release workflow now uses one grouped activity trace, and the focused checks pass.",
    });
    const finalReply = page.locator(".chat-bubble p").filter({
      hasText:
        "The release workflow now uses one grouped activity trace, and the focused checks pass.",
    });
    await finalReply.waitFor();

    await capture(page, "summary-collapsed", "light");
    await capture(page, "summary-collapsed", "dark");

    if (proofState !== "before") {
      expect(await page.locator(".chat-work-group").count()).toBe(0);
      expect(await page.locator(".chat-activity-group").count()).toBe(2);
      const summaryLabel = await page.locator(".chat-activity-group__label").last().textContent();
      expect(summaryLabel).toBe(
        "Edited a file, created a file, read a file, ran commands, and searched the web",
      );
      expect(summaryLabel).not.toMatch(/\d/);
    }

    const latestSummary = page.locator(".chat-activity-group__summary").last();
    if ((await latestSummary.getAttribute("aria-expanded")) !== "true") {
      await latestSummary.click();
    }
    await expect.poll(() => latestSummary.getAttribute("aria-expanded")).toBe("true");
    await capture(page, "summary-expanded", "light");
    await capture(page, "summary-expanded", "dark");

    expect(await finalReply.count()).toBe(1);
    expect(
      await page
        .locator(".chat-activity-group")
        .last()
        .getByText(
          "The release workflow now uses one grouped activity trace, and the focused checks pass.",
          { exact: true },
        )
        .count(),
    ).toBe(0);
    await context.close();
  });
});
