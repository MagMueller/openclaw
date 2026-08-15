/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMUNITY_INVITE_SETTLED_EVENT } from "./community-invite-dialog.ts";

/** The invite link is the product contract this card exists to deliver, so the
 * test states it independently instead of reading back the value under test. */
const COMMUNITY_INVITE_URL = "https://discord.gg/clawd";

// The tag map carries the element type, so no exported class is needed here.
let card: HTMLElementTagNameMap["openclaw-community-invite-dialog"];
let outcomes: string[];

beforeEach(async () => {
  outcomes = [];
  card = document.createElement("openclaw-community-invite-dialog");
  card.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
    outcomes.push((event as CustomEvent<{ outcome: string }>).detail.outcome);
  });
  document.body.append(card);
  await card.updateComplete;
});

afterEach(() => {
  card.remove();
});

/** Every element the card exposes is an HTMLElement, so one concrete return type
 * covers the button, the anchor and the region without a call-site generic. */
function shadowQuery(selector: string): HTMLElement {
  const found = card.shadowRoot?.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

describe("community invite card", () => {
  it("is a non-modal complementary region, not a dialog", () => {
    const region = shadowQuery("aside.invite");
    expect(region.getAttribute("role")).toBe("complementary");
    // A focus trap or an aria-modal here would make it interrupt the operator.
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(card.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(card.shadowRoot?.querySelector("[autofocus]")).toBeNull();
  });

  it("dismisses from the close button, whose label communicates permanence", () => {
    const close = shadowQuery(".invite__close");
    // A bare "Dismiss" reads as reversible; the card only ever shows once, so the
    // label has to say so.
    expect(close.getAttribute("aria-label")).toBe("Dismiss and don't show again");
    close.click();
    expect(outcomes).toEqual(["dismissed"]);
  });

  it("dismisses on Escape while focus is inside the card", () => {
    shadowQuery(".invite").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(outcomes).toEqual(["dismissed"]);
  });

  it("settles as joined when the invite is opened in a new tab", () => {
    const cta = shadowQuery(".invite__cta");
    expect(cta.getAttribute("href")).toBe(COMMUNITY_INVITE_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toContain("noopener");
    cta.click();
    expect(outcomes).toEqual(["joined"]);
  });

  it("reports one outcome even when both exits fire", () => {
    shadowQuery(".invite__close").click();
    shadowQuery(".invite__cta").click();
    expect(outcomes).toEqual(["dismissed"]);
  });
});
