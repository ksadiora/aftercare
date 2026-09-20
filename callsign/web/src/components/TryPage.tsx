import { useEffect } from "react";
import { useCallsign } from "../useCallsign.ts";
import { Header } from "./Header.tsx";
import { IconChevron } from "./ui.tsx";
import { Workbench } from "./Workbench.tsx";
import { Scenarios } from "./Scenarios.tsx";

/**
 * /try — the judge's page. Two ways to test the five checks:
 *   1. the scenario deck: one click per catalogued attack (several per check),
 *      or "Run all" to walk a check, or the whole deck, one at a time;
 *   2. the workbench: compose any request by hand, read the prediction, send.
 * The console's nav sits on top so the judge can hop back and watch the
 * trust card and the phone react.
 */
export function TryPage() {
  const { connected, snapshot } = useCallsign();

  useEffect(() => {
    document.body.classList.add("scroll");
    const prev = document.title;
    document.title = "Try to fool it · Callsign";
    return () => {
      document.body.classList.remove("scroll");
      document.title = prev;
    };
  }, []);

  const counts = snapshot
    ? {
        verified: snapshot.verifications.filter((v) => v.verdict === "verified").length,
        quarantined: snapshot.verifications.filter((v) => v.verdict === "quarantined").length,
        calls: snapshot.calls.length,
      }
    : undefined;

  return (
    <div className="try-page">
      <Header phone={snapshot?.phone ?? { paired: false, urls: [], voice: "browser" }} connected={connected} counts={counts} links={[{ href: "/", label: "Console" }]} />
      <div className="try-inner">
        <header className="try-head">
          <h1>Try to fool it</h1>
          <p className="proof-lede">
            Five checks stand between a sender and Dr. Patel's phone. Fire a catalogued attack at each one below, or scroll down and build your own
            request. Everything goes down the same path as any agent on the network; the console shows what her agent saw.
          </p>
          <nav className="try-jump" aria-label="On this page">
            <a className="link" href="#scenarios">
              Scenario deck <IconChevron />
            </a>
            <a className="link" href="#workbench">
              Build your own <IconChevron />
            </a>
          </nav>
        </header>
        <div id="scenarios">
          <Scenarios snapshot={snapshot} />
        </div>
        <header className="try-head" id="workbench">
          <h2 className="try-h2">Build your own</h2>
          <p className="proof-lede">
            Be the sender. Pick a name, pick how it is signed, write anything. Read the prediction first, then see whether Dr. Patel's agent agrees.
          </p>
        </header>
        <Workbench snapshot={snapshot} />
        <p className="try-foot">
          Only a message signed by the registered brand's key, unaltered, inside the replay window, gets through. The phone rings only for that
          one. Everything else lands in quarantine, with the evidence attached.
        </p>
      </div>
    </div>
  );
}
