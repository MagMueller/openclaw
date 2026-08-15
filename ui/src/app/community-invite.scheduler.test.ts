/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The card is a separate lazy chunk; stubbing it keeps this suite on the showing
// protocol instead of the dialog's shadow-DOM dependencies.
vi.mock("../components/community-invite-dialog.ts", () => ({
  COMMUNITY_INVITE_SETTLED_EVENT: "community-invite-settled",
}));

import {
  COMMUNITY_INVITE_KEY,
  runCommunityInvite,
  type CommunityInviteRecord,
} from "./community-invite.runtime.ts";

const DWELL_MS = 5 * 60 * 1000;
const CARD_TAG = "openclaw-community-invite-dialog";

const stops: Array<() => void> = [];
let visibility: DocumentVisibilityState = "visible";
let focused = true;
let lockHolders: Set<string>;

function seedRecord(record: Partial<CommunityInviteRecord> = {}): void {
  localStorage.setItem(
    COMMUNITY_INVITE_KEY,
    JSON.stringify({
      // An upgraded operator on their second qualified load: this load makes the
      // record "ready", so only dwell and presence remain.
      firstQualifiedAtMs: Date.now() - 60 * 60 * 1000,
      qualifiedLoads: 1,
      established: true,
      ...record,
    } satisfies CommunityInviteRecord),
  );
}

function storedRecord(): CommunityInviteRecord | null {
  const raw = localStorage.getItem(COMMUNITY_INVITE_KEY);
  return raw ? (JSON.parse(raw) as CommunityInviteRecord) : null;
}

/** jsdom ships no Web Locks. This models the slice the protocol depends on: with
 * `ifAvailable`, a request while a holder is active is handed null rather than
 * queued, and the holder is released as soon as its callback settles. */
function installWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request(name: string, _options: unknown, callback: (lock: unknown) => unknown) {
        if (lockHolders.has(name)) {
          return Promise.resolve(callback(null));
        }
        lockHolders.add(name);
        return Promise.resolve(callback({ name })).finally(() => lockHolders.delete(name));
      },
    },
  });
}

function start(
  hasInteractionHistory = true,
  isEligibleNow: () => boolean = () => true,
): () => void {
  const dispose = runCommunityInvite(hasInteractionHistory, isEligibleNow);
  stops.push(dispose);
  return dispose;
}

function setPresence(next: { visible?: boolean; focused?: boolean }): void {
  if (next.visible !== undefined) {
    visibility = next.visible ? "visible" : "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (next.focused !== undefined) {
    focused = next.focused;
    window.dispatchEvent(new Event(next.focused ? "focus" : "blur"));
  }
}

function mountedCards(): number {
  return document.querySelectorAll(CARD_TAG).length;
}

/** Presentation crosses the card import and then the claim, so it settles a few
 * promise hops after the dwell timer fires. */
async function flushPresentation(): Promise<void> {
  for (let hop = 0; hop < 4; hop += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Runs a full armed load to the point of presentation. */
async function runToPresentation(): Promise<void> {
  start();
  await vi.advanceTimersByTimeAsync(DWELL_MS);
  await flushPresentation();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  visibility = "visible";
  focused = true;
  lockHolders = new Set();
  document.openClawModalToastLayers = new Set();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.useFakeTimers();
  installWebLocks();
});

afterEach(() => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  // Own-property stubs outlive vi.restoreAllMocks, and a leaked activeElement or
  // lock manager would silently decide the next test.
  Reflect.deleteProperty(document, "activeElement");
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(document, "openClawModalToastLayers");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("community invite dwell", () => {
  it("presents once the dwell elapses with the operator present", async () => {
    seedRecord();
    start();
    expect(mountedCards()).toBe(0);

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("does not accrue dwell while the tab is hidden, and keeps no timer alive", async () => {
    seedRecord();
    start();
    setPresence({ visible: false });

    await vi.advanceTimersByTimeAsync(DWELL_MS * 3);
    await flushPresentation();
    expect(mountedCards()).toBe(0);
    // The invariant behind the event-driven design: an idle, hidden tab runs no
    // periodic work at all.
    expect(vi.getTimerCount()).toBe(0);

    setPresence({ visible: true });
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("accumulates dwell across absences instead of demanding continuous presence", async () => {
    seedRecord();
    start();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    setPresence({ visible: false });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mountedCards()).toBe(0);

    setPresence({ visible: true });
    // Only the remaining two minutes are owed, not a fresh five.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("waits for focus to leave an editable field before presenting", async () => {
    seedRecord();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    composer.blur();
    document.dispatchEvent(new Event("focusout"));
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("waits for a field inside a shadow root too, where activeElement is the host", async () => {
    seedRecord();
    const panel = document.createElement("div");
    const shadow = panel.attachShadow({ mode: "open" });
    const field = document.createElement("textarea");
    shadow.append(field);
    document.body.append(panel);
    // A browser retargets activeElement to the shadow host, which is what hides the
    // real field from a document-level check. jsdom does not model the retarget, so
    // the state is declared rather than performed.
    Object.defineProperty(shadow, "activeElement", { configurable: true, get: () => field });
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => panel });
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    // The terminal panel keeps its textarea this way, so a document-level check
    // would drop the card over live typing.
    expect(mountedCards()).toBe(0);

    Reflect.deleteProperty(document, "activeElement");
    document.dispatchEvent(new Event("focusout"));
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("stays away for a load the record already counted as shown", async () => {
    seedRecord({ shownAtMs: Date.now() - 1000 });
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS * 2);
    await flushPresentation();
    expect(mountedCards()).toBe(0);
  });
});

describe("community invite showing protocol", () => {
  it("records the tombstone before the card reaches the DOM", async () => {
    seedRecord();
    await runToPresentation();

    expect(mountedCards()).toBe(1);
    // Written and verified inside the claim, so it is already durable by the time
    // anything is on screen — no outcome required.
    expect(storedRecord()?.shownAtMs).toBeGreaterThan(0);
    expect(storedRecord()?.outcome).toBeUndefined();
  });

  it("never shows again after a load that only displayed the card", async () => {
    seedRecord();
    await runToPresentation();
    expect(mountedCards()).toBe(1);

    // The tab dies without the operator answering: no dismiss, no join, no settle.
    document.body.innerHTML = "";
    await runToPresentation();
    expect(mountedCards()).toBe(0);
  });

  it("never shows again after the shell disconnects with the card up", async () => {
    seedRecord();
    const dispose = start();
    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(1);

    dispose();
    // A card outliving its owner would keep a detached shell's closures alive.
    expect(mountedCards()).toBe(0);

    await runToPresentation();
    expect(mountedCards()).toBe(0);
  });

  it("records the outcome as metadata, without it owning suppression", async () => {
    seedRecord();
    await runToPresentation();
    const shownAtMs = storedRecord()?.shownAtMs;

    document.querySelector(CARD_TAG)?.dispatchEvent(
      new CustomEvent("community-invite-settled", {
        bubbles: true,
        detail: { outcome: "joined" },
      }),
    );

    expect(storedRecord()?.outcome).toBe("joined");
    // The tombstone is untouched by answering: it was already the terminal fact.
    expect(storedRecord()?.shownAtMs).toBe(shownAtMs);
    expect(mountedCards()).toBe(0);
  });

  it("shows nothing when storage refuses the write", async () => {
    seedRecord();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await runToPresentation();
    // Fail-closed: a card with no durable tombstone would come back on every load.
    expect(mountedCards()).toBe(0);
  });

  it("shows nothing when the write does not read back", async () => {
    seedRecord();
    // A storage that silently drops writes is the shape that survives a naive
    // "did setItem throw?" check.
    vi.spyOn(localStorage, "setItem").mockImplementation(() => undefined);
    await runToPresentation();
    expect(mountedCards()).toBe(0);
  });

  it("shows nothing when the record vanishes mid-flight", async () => {
    seedRecord();
    start();
    await vi.advanceTimersByTimeAsync(DWELL_MS - 1);
    localStorage.clear();
    await vi.advanceTimersByTimeAsync(1);
    await flushPresentation();
    // Nothing to stamp means nothing to suppress with, so the card stays away.
    expect(mountedCards()).toBe(0);
  });

  it("shows nothing in a browser with no lock manager", async () => {
    seedRecord();
    Reflect.deleteProperty(navigator, "locks");
    await runToPresentation();
    // Without mutual exclusion two tabs could both mount, so this degrades to not
    // showing rather than to showing twice.
    expect(mountedCards()).toBe(0);
    expect(storedRecord()?.shownAtMs).toBeUndefined();
  });

  it("mounts one card when two tabs reach presentation together", async () => {
    seedRecord();
    start();
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    // Both loads are presentation-ready against one record; the claim is what stops
    // the operator seeing the invite twice.
    expect(mountedCards()).toBe(1);
  });

  it("releases the lock as soon as the claim is decided", async () => {
    seedRecord();
    await runToPresentation();
    expect(mountedCards()).toBe(1);

    // No lock is held while the card is on screen, so a later tab is free to take
    // it — and is turned away by the tombstone rather than by a stuck lock.
    expect(lockHolders.size).toBe(0);
    await runToPresentation();
    expect(mountedCards()).toBe(1);
  });
});

describe("community invite live eligibility", () => {
  // The shell's cohort qualification is a one-shot latch decided at first sight
  // (see app-host.ts), but the shell can still disconnect from the Gateway or
  // fall back into onboarding afterward. `isEligibleNow` is how it reports that
  // live, and both scenarios must keep the card from ever mounting even though
  // the load already qualified and dwell already elapsed.
  const shellTransitions: ReadonlyArray<{ name: string }> = [
    { name: "the Gateway disconnects before dwell completes" },
    { name: "the shell returns to onboarding before dwell completes" },
  ];

  for (const { name } of shellTransitions) {
    it(`never presents once ${name}`, async () => {
      seedRecord();
      let eligible = true;
      start(true, () => eligible);

      await vi.advanceTimersByTimeAsync(DWELL_MS / 2);
      eligible = false;
      await vi.advanceTimersByTimeAsync(DWELL_MS / 2);
      await flushPresentation();
      expect(mountedCards()).toBe(0);

      // Focus churn alone cannot recover it either: the gate stays live and
      // stays closed until the shell itself reports eligibility again.
      document.dispatchEvent(new Event("focusout"));
      await flushPresentation();
      expect(mountedCards()).toBe(0);
    });
  }

  it("defers presentation while a modal is open, then presents once it closes", async () => {
    seedRecord();
    document.openClawModalToastLayers = new Set([document.createElement("div")]);
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(0);

    document.openClawModalToastLayers.clear();
    document.dispatchEvent(new Event("focusout"));
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("defers presentation while a toast is active, then presents once it clears", async () => {
    seedRecord();
    const toast = document.createElement("div");
    toast.className = "app-toast";
    document.body.append(toast);
    start();

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();
    expect(mountedCards()).toBe(0);

    toast.remove();
    document.dispatchEvent(new Event("focusout"));
    await flushPresentation();
    expect(mountedCards()).toBe(1);
  });

  it("never burns the tombstone for a state that turns unquiet during the chunk import", async () => {
    seedRecord();
    // The chunk import and the claim both cross an await after tryPresent's
    // synchronous check already passed. Answering true only the first time
    // stands in for a modal, a toast, a disconnect, or a new run arriving in
    // that exact gap: whichever one it is, `present()` must re-check and refuse
    // rather than mount a card and burn the one-shot tombstone on it.
    let calls = 0;
    start(true, () => {
      calls += 1;
      return calls === 1;
    });

    await vi.advanceTimersByTimeAsync(DWELL_MS);
    await flushPresentation();

    expect(calls).toBeGreaterThan(1);
    expect(mountedCards()).toBe(0);
    expect(storedRecord()?.shownAtMs).toBeUndefined();
  });
});
