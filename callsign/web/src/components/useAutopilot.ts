import { useCallback, useEffect, useRef, useState } from "react";
import { IMPOSTOR_VARIANTS, type ImpostorVariant, type Snapshot } from "@callsign/shared";

/**
 * The three-beat choreography, hands-free:
 *   reset → 1.5 s → attack (selected variant) → its verdict + 4 s → brand calls → the ring.
 * Esc cancels between beats. Progress is a short line the sheet and a
 * bottom toast both show.
 */

export type AutopilotStatus = "idle" | "running" | "done" | "cancelled" | "error";
export type AutopilotState = { status: AutopilotStatus; phase: string };

type Actions = {
  reset: () => Promise<unknown>;
  impostor: (variant?: ImpostorVariant) => Promise<{ requestId?: string } | unknown>;
  brandCall: () => Promise<{ requestId?: string } | unknown>;
};

class Cancelled extends Error {}

export function useAutopilot({ snapshot, actions, variant }: { snapshot?: Snapshot; actions: Actions; variant: ImpostorVariant }) {
  const [state, setState] = useState<AutopilotState>({ status: "idle", phase: "" });
  const snap = useRef(snapshot);
  snap.current = snapshot;
  const cancelRef = useRef<() => void>();
  const running = state.status === "running";

  // Finished states fade out on their own.
  useEffect(() => {
    if (state.status === "idle" || state.status === "running") return;
    const t = window.setTimeout(() => setState({ status: "idle", phase: "" }), 3500);
    return () => window.clearTimeout(t);
  }, [state]);

  const cancel = useCallback(() => cancelRef.current?.(), []);

  const start = useCallback(() => {
    if (cancelRef.current) return;
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };
    const check = () => {
      if (cancelled) throw new Cancelled();
    };
    const phase = (p: string) => setState({ status: "running", phase: p });
    const sleep = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        check();
        await new Promise((r) => setTimeout(r, Math.min(120, until - Date.now())));
      }
      check();
    };
    const waitFor = async (pred: (s: Snapshot) => boolean, timeoutMs: number, what: string) => {
      const t0 = Date.now();
      while (!(snap.current && pred(snap.current))) {
        check();
        if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out ${what}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      check();
    };
    const idOf = (r: unknown) => (r && typeof r === "object" && typeof (r as { requestId?: unknown }).requestId === "string" ? (r as { requestId: string }).requestId : undefined);

    void (async () => {
      try {
        phase("Resetting…");
        await actions.reset();
        await sleep(1500);

        const v = IMPOSTOR_VARIANTS.find((x) => x.id === variant);
        phase(`${v?.label ?? "Impostor"}…`);
        const attackId = idOf(await actions.impostor(variant));
        phase("Waiting for the verdict…");
        await waitFor((s) => Boolean(attackId && s.verifications.find((x) => x.requestId === attackId)?.verdict), 30_000, "waiting for the verdict");

        for (let n = 4; n >= 1; n--) {
          phase(`Verdict in · brand calls in ${n} s`);
          await sleep(1000);
        }

        phase("Brand calls…");
        const brandId = idOf(await actions.brandCall());
        phase("Waiting for the ring…");
        await waitFor(
          (s) =>
            Boolean(
              brandId &&
                (s.calls.some((c) => c.requestId === brandId && c.status !== "queued" && c.status !== "dialing") ||
                  s.verifications.find((x) => x.requestId === brandId)?.verdict === "quarantined" ||
                  s.verifications.find((x) => x.requestId === brandId)?.outcome === "inbox"),
            ),
          30_000,
          "waiting for the ring",
        );
        const done = snap.current;
        const call = done?.calls.find((c) => c.requestId === brandId);
        const held = done?.verifications.find((x) => x.requestId === brandId)?.outcome === "inbox";
        setState({ status: "done", phase: call ? "Done · the phone is ringing" : held ? "Done · verified, held by policy" : "Done" });
      } catch (e) {
        if (e instanceof Cancelled) setState({ status: "cancelled", phase: "Cancelled" });
        else setState({ status: "error", phase: e instanceof Error ? e.message : String(e) });
      } finally {
        cancelRef.current = undefined;
      }
    })();
  }, [actions, variant]);

  return { state, running, start, cancel };
}
