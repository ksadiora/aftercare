import { lazy, Suspense } from "react";
import { DeskApp } from "./desk/DeskApp.tsx";

const PhoneApp = lazy(() => import("./phone/PhoneApp.tsx").then((m) => ({ default: m.PhoneApp })));
const ProofPage = lazy(() => import("./components/ProofPage.tsx").then((m) => ({ default: m.ProofPage })));
const TryPage = lazy(() => import("./components/TryPage.tsx").then((m) => ({ default: m.TryPage })));

export function App() {
  const path = location.pathname.replace(/\/+$/, "");
  const proof = path.match(/^\/proof\/([^/]+)$/);
  let requestId = proof?.[1] ?? "";
  try { requestId = decodeURIComponent(requestId); } catch { /* Keep malformed identifiers inert. */ }
  return (
    <Suspense fallback={<div className="connecting">Opening Callsign…</div>}>
      {path === "/phone" ? <PhoneApp /> : path === "/try" ? <TryPage /> : proof ? <ProofPage requestId={requestId} /> : <DeskApp />}
    </Suspense>
  );
}
