// One-shot Discord community nudge, in full. Nothing here is in the startup graph:
// the shell reaches this module only once a load has already qualified, so an
// unsolicited nudge costs nothing before first paint and nothing at all to an
// operator who has already seen it.
//
// The terminal fact is *shown*, not *answered*. `shownAtMs` is written and read
// back before the card reaches the DOM, so every way a showing can end — answered,
// tab closed, shell reconnected, storage refused — leaves the same tombstone
// behind. Dismiss and join only enrich that record; they do not own suppression.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { hasActiveToast } from "../lib/toast.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v1";
/** Guards the one short critical section: re-read, stamp, verify, mount. */
const COMMUNITY_INVITE_LOCK = "openclaw:control-ui:community-invite";

/** An upgraded operator never sees the card on the first load of the new build;
 * from the second qualified load the dwell timer decides. */
const ESTABLISHED_MIN_LOADS = 2;
/** A fresh install has to look like a returning user first: onboarding and the
 * first days of evaluation stay free of community chrome. */
const NEW_INSTALL_MIN_LOADS = 3;
const NEW_INSTALL_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Dwell is *accumulated* foreground time inside one load, not continuous
 * presence. Operators tab away constantly while a run streams, so a continuous
 * rule would hide the card from exactly the people using OpenClaw most; the
 * accumulator still proves five real minutes in the app before anything appears. */
const DWELL_MS = 5 * 60 * 1000;

export type CommunityInviteOutcome = "joined" | "dismissed";

export type CommunityInviteRecord = {
  /** First Control UI load that reached a connected, non-onboarding shell. */
  firstQualifiedAtMs: number;
  /** Qualified loads so far. Stands in for "sessions of use" in the arming rules. */
  qualifiedLoads: number;
  /** Sessions already existed when this browser first qualified, so the operator
   * upgraded into this build rather than arriving from a fresh install. */
  established: boolean;
  /** Tombstone. Written before the card is mounted and never cleared: its
   * presence alone is what stops the invite coming back. */
  shownAtMs?: number;
  /** Build the card appeared in; null when the artifact ships without identity. */
  shownVersion?: string | null;
  /** How the operator answered, recorded after the fact. Metadata only, and
   * bounded in time by `shownAtMs` above. */
  outcome?: CommunityInviteOutcome;
};

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The one validator, used by every read. localStorage is shared, hand-editable
 * and outlives the build that wrote it, so a stored value is untrusted input
 * rather than a round-trip of our own write: `{}` would spread into `undefined + 1`
 * qualified loads, and a bare `{"settledAtMs":1,"outcome":"dismissed"}` would
 * otherwise pass a partial check and suppress the invite forever. Our own writes
 * always satisfy this schema, so a record that fails it is foreign damage and the
 * sequence restarts rather than silently sticking. */
export function parseCommunityInviteRecord(value: unknown): CommunityInviteRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { established, shownVersion, outcome } = value;
  const firstQualifiedAtMs = readNonNegativeNumber(value.firstQualifiedAtMs);
  const qualifiedLoads = readNonNegativeNumber(value.qualifiedLoads);
  if (
    firstQualifiedAtMs === null ||
    qualifiedLoads === null ||
    !Number.isInteger(qualifiedLoads) ||
    typeof established !== "boolean"
  ) {
    return null;
  }
  // Absent is fine; present but not a real timestamp is foreign damage.
  const shownAtMs =
    value.shownAtMs === undefined ? undefined : readNonNegativeNumber(value.shownAtMs);
  if (shownAtMs === null) {
    return null;
  }
  if (shownVersion !== undefined && shownVersion !== null && typeof shownVersion !== "string") {
    return null;
  }
  if (outcome !== undefined && outcome !== "joined" && outcome !== "dismissed") {
    return null;
  }
  return {
    firstQualifiedAtMs,
    qualifiedLoads,
    established,
    ...(shownAtMs === undefined ? {} : { shownAtMs }),
    ...(shownVersion === undefined ? {} : { shownVersion }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export function readCommunityInviteRecord(): CommunityInviteRecord | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY);
    return raw ? parseCommunityInviteRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Reports whether the record actually reached storage, because the tombstone is
 * only worth as much as the write that carries it. */
export function writeCommunityInviteRecord(record: CommunityInviteRecord): boolean {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return false;
    }
    storage.setItem(COMMUNITY_INVITE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function communityInviteReadiness(
  record: CommunityInviteRecord,
  nowMs: number,
): "ready" | "waiting" {
  if (record.established) {
    return record.qualifiedLoads >= ESTABLISHED_MIN_LOADS ? "ready" : "waiting";
  }
  const oldEnough = nowMs - record.firstQualifiedAtMs >= NEW_INSTALL_MIN_AGE_MS;
  return record.qualifiedLoads >= NEW_INSTALL_MIN_LOADS && oldEnough ? "ready" : "waiting";
}

/** Records this load against the stored history and reports the resulting record. */
export function recordQualifiedLoad(
  previous: CommunityInviteRecord | null,
  hasInteractionHistory: boolean,
  nowMs: number,
): CommunityInviteRecord {
  if (!previous) {
    // The very first sighting classifies the operator. A session already carrying
    // a real recorded interaction means this browser met an install that was
    // already in active use, i.e. an upgrade — not merely one that happened to
    // have a session object on record.
    return { firstQualifiedAtMs: nowMs, qualifiedLoads: 1, established: hasInteractionHistory };
  }
  return { ...previous, qualifiedLoads: previous.qualifiedLoads + 1 };
}

/** Foreground presence: the only state in which dwell time accrues. */
export function operatorIsPresent(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** The card must never appear over something the operator is typing into.
 * `document.activeElement` stops at a shadow host, and the surface most likely to
 * be holding a keystroke is exactly that shape — the terminal panel keeps a
 * textarea in its shadow root — so a document-level check would see only
 * `openclaw-terminal-panel` and read as "nobody is typing". */
export function editableElementFocused(): boolean {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active.getAttribute("role") === "textbox")
  );
}

/** Decides which tab, across the whole browser profile, may show the card. The
 * re-read, the stamp and the read-back all happen inside one short exclusive lock
 * and the lock is released the moment they finish, so two tabs cannot both pass
 * and no lock is held while the card is on screen. Anything that leaves the
 * tombstone in doubt — no lock manager, no storage, a refused write, a write that
 * does not read back — answers no: the invite may be missed, never shown twice. */
export async function claimCommunityInviteShowing(): Promise<boolean> {
  if (!("locks" in navigator) || !getSafeLocalStorage()) {
    return false;
  }
  try {
    return await navigator.locks.request(COMMUNITY_INVITE_LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        return false;
      }
      const record = readCommunityInviteRecord();
      if (!record || record.shownAtMs !== undefined) {
        return false;
      }
      const shownAtMs = Date.now();
      const stamped = {
        ...record,
        shownAtMs,
        shownVersion: CONTROL_UI_BUILD_INFO.version,
      };
      if (!writeCommunityInviteRecord(stamped)) {
        return false;
      }
      return readCommunityInviteRecord()?.shownAtMs === shownAtMs;
    });
  } catch {
    return false;
  }
}

/** True while any modal dialog is open. The card must never mount over one — a
 * modal traps focus and blocks whatever the operator is doing, so presenting
 * under it would burn the one-shot tombstone on a card nobody could see or
 * reach. Reads the same registry `modal-dialog.ts` keeps for toast handoff,
 * which every open `openclaw-modal-dialog` is already a member of. */
export function attentionModalOpen(): boolean {
  return (document.openClawModalToastLayers?.size ?? 0) > 0;
}

/** Starts the invite for a load the shell has already qualified. `isEligibleNow`
 * is checked live at presentation time, not only here: it covers state that can
 * change after this load qualified (gateway connectivity, onboarding, an active
 * run or subagent elsewhere), which this one-shot start-up call cannot see in
 * advance. Returns the disposer the shell owns. */
export function runCommunityInvite(
  hasInteractionHistory: boolean,
  isEligibleNow: () => boolean,
): () => void {
  const previous = readCommunityInviteRecord();
  if (previous?.shownAtMs !== undefined) {
    return () => undefined;
  }
  const now = Date.now();
  const record = recordQualifiedLoad(previous, hasInteractionHistory, now);
  writeCommunityInviteRecord(record);
  if (communityInviteReadiness(record, now) !== "ready") {
    return () => undefined;
  }

  let disposed = false;
  let presented = false;
  let dwellAccumulatedMs = 0;
  let dwellStartedAtMs: number | null = null;
  let dwellSatisfied = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let listening = false;
  let card: HTMLElement | null = null;

  const clearDwellTimer = () => {
    if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
  };

  /** Folds the open presence span into the accumulator. */
  const bankDwell = () => {
    if (dwellStartedAtMs !== null) {
      dwellAccumulatedMs += Date.now() - dwellStartedAtMs;
      dwellStartedAtMs = null;
    }
  };

  /** Every condition that must hold at the instant the card is claimed and
   * mounted, not only when the dwell timer first fires: the chunk import and the
   * claim below both cross an await, and a modal, a toast, a disconnect, or a
   * newly active run can all arrive in that gap. Re-checking here — not just in
   * `tryPresent` — is what keeps the tombstone from burning under a state that
   * changed mid-flight. */
  const isQuietAndEligible = () =>
    dwellSatisfied &&
    operatorIsPresent() &&
    !editableElementFocused() &&
    !attentionModalOpen() &&
    !hasActiveToast() &&
    isEligibleNow();

  const present = async () => {
    // Load the card first and claim second: a failed chunk fetch must not burn the
    // one showing this browser gets, and once the claim lands the card reaches the
    // DOM in the same task.
    const { COMMUNITY_INVITE_SETTLED_EVENT } =
      await import("../components/community-invite-dialog.ts");
    if (disposed || !isQuietAndEligible() || !(await claimCommunityInviteShowing())) {
      return;
    }
    const mounted = document.createElement("openclaw-community-invite-dialog");
    mounted.addEventListener(COMMUNITY_INVITE_SETTLED_EVENT, (event) => {
      // Metadata only. The tombstone already decided this browser is done, so a
      // failed write here costs the outcome, never the suppression.
      const answered = readCommunityInviteRecord();
      if (answered) {
        const { outcome } = (event as CustomEvent<{ outcome: CommunityInviteOutcome }>).detail;
        writeCommunityInviteRecord({ ...answered, outcome });
      }
      mounted.remove();
      card = null;
    });
    card = mounted;
    document.body.append(mounted);
  };

  const tryPresent = () => {
    if (disposed || presented || !isQuietAndEligible()) {
      // No retry timer: the next visibility/focus event brings us back here. A
      // run/subagent finishing or a modal closing with no accompanying
      // visibility/focus event will not itself re-trigger a check — an accepted
      // gap, since ordinary tab use produces those events often enough to close
      // it, and the invite has no urgency that would justify polling for it.
      return;
    }
    presented = true;
    void present().then(
      () => stopWatching(),
      () => {
        // Only the chunk fetch can land here, and it burned no tombstone, so a
        // later event in this load may still show the card.
        presented = false;
      },
    );
  };

  /** One-shot timer for the dwell remainder, alive only while the operator is here. */
  const armDwell = () => {
    if (dwellSatisfied || dwellStartedAtMs !== null || !operatorIsPresent()) {
      return;
    }
    dwellStartedAtMs = Date.now();
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      bankDwell();
      dwellSatisfied = true;
      tryPresent();
    }, DWELL_MS - dwellAccumulatedMs);
  };

  /** Single handler for visibilitychange, window focus/blur and focusin/focusout:
   * presence drives the dwell accumulator, and every event is a chance to present
   * once dwell is satisfied. Nothing polls. */
  const onEnvironmentChange = () => {
    if (disposed || presented) {
      return;
    }
    if (operatorIsPresent()) {
      armDwell();
    } else if (dwellStartedAtMs !== null) {
      clearDwellTimer();
      bankDwell();
    }
    tryPresent();
  };

  const startListening = () => {
    listening = true;
    document.addEventListener("visibilitychange", onEnvironmentChange);
    document.addEventListener("focusin", onEnvironmentChange);
    document.addEventListener("focusout", onEnvironmentChange);
    window.addEventListener("focus", onEnvironmentChange);
    window.addEventListener("blur", onEnvironmentChange);
  };

  function stopWatching() {
    clearDwellTimer();
    if (!listening) {
      return;
    }
    listening = false;
    document.removeEventListener("visibilitychange", onEnvironmentChange);
    document.removeEventListener("focusin", onEnvironmentChange);
    document.removeEventListener("focusout", onEnvironmentChange);
    window.removeEventListener("focus", onEnvironmentChange);
    window.removeEventListener("blur", onEnvironmentChange);
  }

  startListening();
  armDwell();

  return () => {
    disposed = true;
    stopWatching();
    card?.remove();
    card = null;
  };
}
