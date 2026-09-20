import type { PhoneState } from "@callsign/shared";
import { IconChevron, Qr } from "./ui.tsx";
import { shareUrl } from "./shareUrl.ts";

/**
 * The doctor's phone: a browser on the same Wi-Fi paired to the agent.
 * Paired → device name with a green dot. Not paired → a QR of the phone URL.
 * Used in the hero (compact) and in the presenter sheet (larger QR, Unpair).
 */
/** The device name the docked phone (and the popup window) pairs under; the phone app reads it from ?device=. */
export const DOCKED_DEVICE = "This computer";

/** Open the phone as a phone-sized window on this computer. Works on localhost with no certificate or Wi-Fi. */
export function openPhoneWindow() {
  const url = `${location.origin}/phone?device=${encodeURIComponent(DOCKED_DEVICE)}`;
  const w = window.open(url, "callsign-phone", "popup=yes,width=420,height=860,left=40,top=40");
  w?.focus();
}

export function PhoneCard({
  phone,
  inSheet,
  onUnpair,
  onDock,
  docked,
}: {
  phone: PhoneState;
  inSheet?: boolean;
  onUnpair?: () => void;
  /** Dock the phone inside the console's live call card (preferred: popups get blocked). */
  onDock?: () => void;
  /** The phone is already docked in the live call card and waiting for its one tap. */
  docked?: boolean;
}) {
  const url = shareUrl("/phone", phone.urls);

  if (docked && !phone.paired) {
    // The docked phone is pairing itself; the QR stays up so a judge's own phone can take over.
    return (
      <div className={`phone-card ${inSheet ? "in-sheet" : ""}`}>
        <Qr value={url} size={inSheet ? 132 : 84} />
        <div className="phone-card-text">
          {!inSheet && <div className="phone-card-label">Phone</div>}
          <div className="phone-card-title">
            <span className="dot idle" aria-hidden />
            Docked in the live call card
          </div>
          <a className="phone-card-url" href={url} target="_blank" rel="noreferrer">{url}</a>
          <div className="phone-card-hint">Scan to use your own phone instead; it takes over the moment it pairs.</div>
        </div>
      </div>
    );
  }

  if (phone.paired) {
    // This computer is the phone: keep the QR up, because a judge's own phone is the better demo and takes over on pairing.
    const self = phone.deviceName === DOCKED_DEVICE;
    return (
      <div className={`phone-card ${inSheet ? "in-sheet" : ""}`}>
        <Qr value={url} size={inSheet ? 132 : 84} />
        <div className="phone-card-text">
          {!inSheet && <div className="phone-card-label">Phone</div>}
          <div className="phone-card-title">
            <span className="dot" aria-hidden />
            {phone.deviceName ?? "Phone"}
          </div>
          <a className="phone-card-url" href={url} target="_blank" rel="noreferrer">{url}</a>
          <div className="phone-card-hint">{self ? "Rings here · scan to use your own phone instead" : "Paired · rings when a verified agent calls"}</div>
          {inSheet && onUnpair && (
            <button type="button" className="link" onClick={onUnpair}>
              Unpair <IconChevron />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`phone-card ${inSheet ? "in-sheet" : ""}`}>
      <Qr value={url} size={inSheet ? 132 : 84} />
      <div className="phone-card-text">
        {!inSheet && <div className="phone-card-label">Phone</div>}
        <div className="phone-card-title">Pair a phone</div>
        <a className="phone-card-url" href={url} target="_blank" rel="noreferrer">{url}</a>
        <div className="phone-card-hint">Scan with a phone on the same Wi-Fi, or use this computer. Microphone access requires HTTPS; typing works over Wi-Fi.</div>
        <button type="button" className={inSheet ? "btn primary" : "link"} onClick={onDock ?? openPhoneWindow}>
          Use this computer as the phone {!inSheet && <IconChevron />}
        </button>
        {onDock && inSheet && (
          <button type="button" className="link" onClick={openPhoneWindow}>
            Open in a window instead <IconChevron />
          </button>
        )}
      </div>
    </div>
  );
}
