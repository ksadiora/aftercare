import express from 'express';
import { z } from 'zod';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Session } from '../shared/types.js';
import { responses } from '../shared/protocol.js';
import { AppError, Store } from './store.js';
import { capabilities, signedVoiceUrl, type VoiceConfig } from './voice.js';
import { geminiCapability, type GeminiConfig } from './gemini.js';
import { createResponder } from './respond.js';
import { answerCaseQuestion, generateBriefing, ruleSummary, type Briefing } from './briefing.js';
import { HANDOFF_RING_MS, joinToken, mediaCapability, type MediaConfig } from './handoff.js';
import { ansCapability, verifyCareTeam, type AnsConfig } from './ans.js';
import { EscalationGate } from './callsign/gate.js';
import { localRegistryRouter } from './callsign/local-registry.js';

export function createApp(store: Store, options: { voice?: VoiceConfig; gemini?: GeminiConfig; media?: MediaConfig; ans?: AnsConfig; careTeamEndpoint?: string; ringMs?: number; trustedHosts?: string[]; allowedOrigins?: string[]; outreach?: boolean; simulationDelay?: number; fetcher?: typeof fetch; serveStatic?: boolean } = {}) {
  const app = express();
  const peers = new Set<Response>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSeen = new Map<string, number>();
  const browserPlayback = new Set<string>();
  const voice = options.voice || {};
  const gemini = options.gemini || {};
  const responder = createResponder(store, gemini, options.fetcher);
  const media = options.media || {};
  const ans = options.ans || {};
  // Where a handoff request carrying patient context would be delivered.
  const careTeamEndpoint = options.careTeamEndpoint || process.env.CARE_TEAM_ENDPOINT || '';
  const ringMs = options.ringMs ?? HANDOFF_RING_MS;
  const abilities = () => {
    const g = geminiCapability(gemini); const m = mediaCapability(media);
    const a = ansCapability(ans); const c = gate.capability();
    return { ...capabilities(voice), chat: g.enabled, chatReason: g.reason, model: g.model, handoff: m.enabled, handoffReason: m.reason, ringSeconds: Math.round(ringMs / 1000), ans: a.enabled, ansReason: a.reason, careTeam: a.careTeam, escalationGate: c.enabled, escalationGateReason: c.reason, providerAgentName: c.providerAgentName, providerName: c.providerName, careTeamAgentName: c.careTeamAgentName, registryMode: c.registryMode };
  };
  // A patient asking for a person rings the care team only when a live route exists.
  const maybeHandoff = (session: Session) => {
    if (!mediaCapability(media).enabled || session.next.reason !== 'callback') return;
    // If another handoff is already live, the callback task recorded by finish() stands.
    try { store.requestHandoff(session.patientId, session.id, 'The patient asked to speak with a person.'); } catch { /* callback task remains */ }
  };
  const publish = () => { for (const peer of peers) peer.write(`id: ${Date.now()}\nevent: update\ndata: {}\n\n`); };
  // The escalation gate (Callsign, in-process): decides whether an escalation may reach the provider, with evidence.
  const gate = new EscalationGate(store, publish);
  // Localhost stays the default. Deployment must name its hosts; DNS alone is not enough.
  const trustedHosts = (options.trustedHosts || []).map(h => h.trim().toLowerCase()).filter(Boolean);
  const isLocal = (host: string) => ['localhost', '127.0.0.1'].includes(host);
  const allowedHost = (host: string) => isLocal(host) || trustedHosts.includes(host.toLowerCase());
  // Empty by default, which keeps the strict same-origin rule below. A partner app
  // that must call this API from a browser is named here explicitly; anything not
  // named is still refused. Server-to-server callers send no Origin and are unaffected.
  const allowedOrigins = (options.allowedOrigins || []).map(o => o.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean);
  const partnerOrigin = (origin: string | undefined) => Boolean(origin && allowedOrigins.includes(origin.replace(/\/$/, '').toLowerCase()));
  // Fixed-window limiter for the routes that spend provider quota.
  const hits = new Map<string, { count: number; until: number }>();
  const limit = (req: express.Request, max: number, windowMs = 60000) => {
    const key = `${req.path.split('/').slice(0, 4).join('/')}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.until < now) { hits.set(key, { count: 1, until: now + windowMs }); return; }
    if (++entry.count > max) throw new AppError(429, 'Too many requests in a short time. Wait a moment and try again.');
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      const host = (req.get('host') || '').split(':')[0];
      if (!allowedHost(host)) return res.status(403).json({ error: trustedHosts.length ? 'This host is not configured for this deployment.' : 'This demo is available on localhost only.' });
      const origin = req.get('origin');
      const partner = partnerOrigin(origin);
      if (partner) {
        // A named partner integration. No credentials are shared across origins, so a
        // caller must present its own Authorization header rather than ride a session.
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Origin', String(origin));
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') return res.status(204).end();
      } else if (origin) {
        try {
          const url = new URL(origin);
          const wanted = isLocal(url.hostname) ? 'http:' : 'https:';
          if (!allowedHost(url.hostname) || url.protocol !== wanted || url.host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        }
        catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
      }
      if (!partner && req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
      if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON request required.' });
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  // The local ANS-shaped registry the gate verifies against (CA, certificates, zone, transparency log). Public, read-only.
  app.use('/ans', localRegistryRouter);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/capabilities', (_req, res) => res.json(abilities()));
  app.get('/api/dashboard', (_req, res) => res.json(store.dashboard()));
  app.get('/api/patients/:id', (req, res) => res.json(store.detail(String(req.params.id))));
  app.get('/api/history', (req, res) => res.json(store.history(typeof req.query.runId === 'string' ? req.query.runId : undefined)));
  app.get('/api/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write('event: update\ndata: {}\n\n'); peers.add(res);
    const ping = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    res.on('close', () => { peers.delete(res); clearInterval(ping); });
  });
  const startSchema = z.object({ patientId: z.string().min(1), mode: z.enum(['simulation', 'voice', 'chat']), language: z.enum(['en', 'es']), scenario: z.enum(['wound', 'emergency', 'transport', 'recovery', 'interrupted', 'human']).optional(), browserPlayback: z.boolean().default(false) });
  const end = (id: string, reason: 'interrupted' | 'completed' | 'failed', message?: string) => {
    clearTimeout(timers.get(id)); timers.delete(id); lastSeen.delete(id); browserPlayback.delete(id); responder.cancel(id);
    const session = store.finish(id, reason, message); publish(); return session;
  };
  const simulate = (session: Session, index = 0) => {
    const scenario = session.scenario!;
    const script = responses[session.language][scenario];
    timers.set(session.id, setTimeout(() => {
      try {
        const current = store.session(session.id);
        if (current.status !== 'active') return;
        if (index >= script.length) { end(session.id, scenario === 'interrupted' ? 'interrupted' : 'completed'); return; }
        const result = store.ingest(session.id, `simulation-${index}`, 'user', script[index]); publish();
        if (result.session.next.done) timers.set(session.id, setTimeout(() => end(session.id, 'completed'), options.simulationDelay ?? 1600));
        else simulate(session, index + 1);
      } catch { end(session.id, 'failed', 'Simulation could not continue. Intake requires review.'); }
    }, options.simulationDelay ?? 1600));
  };
  app.post('/api/sessions', (req, res) => {
    const body = startSchema.parse(req.body);
    if (body.mode === 'voice' && !abilities().voice) throw new AppError(503, abilities().voiceReason);
    if (body.mode === 'chat' && !abilities().chat) throw new AppError(503, abilities().chatReason);
    // Simulation never reaches a provider, so it is never adaptive.
    const session = store.start(body.patientId, body.mode, body.language, body.mode === 'simulation' ? body.scenario || 'wound' : null, body.mode !== 'simulation' && responder.enabled(), mediaCapability(media).enabled);
    lastSeen.set(session.id, Date.now()); publish();
    if (session.mode === 'simulation') {
      if (body.browserPlayback) browserPlayback.add(session.id);
      else simulate(session);
    }
    res.status(201).json(session);
  });
  app.get('/api/sessions/:id', async (req, res) => { const id = String(req.params.id); await responder.settle(id); res.json(store.session(id)); });
  // The voice agent's get_next_step tool reads this. Mirrors the patient-token route
  // so one call adapter serves both the nurse studio and an invited patient.
  app.get('/api/sessions/:id/next', async (req, res) => {
    const id = String(req.params.id); await responder.settle(id);
    res.json({ next: store.session(id).next });
  });
  app.post('/api/sessions/:id/voice-url', async (req, res) => {
    limit(req, 10);
    const id = String(req.params.id); const s = store.session(id);
    if (s.mode !== 'voice' || s.status !== 'connecting') throw new AppError(409, 'A new in-app call session is required.');
    try { const signedUrl = await signedVoiceUrl(voice, options.fetcher); res.json({ signedUrl }); }
    catch (error) { end(id, 'failed', 'In-app call could not connect. No simulation was started.'); throw error; }
  });
  app.post('/api/sessions/:id/connected', (req, res) => { const { providerId } = z.object({ providerId: z.string().max(200) }).parse(req.body); res.json(store.connect(String(req.params.id), providerId)); publish(); });
  app.post('/api/sessions/:id/heartbeat', (req, res) => { const s = store.session(String(req.params.id)); if (s.status === 'active' || s.status === 'connecting') lastSeen.set(s.id, Date.now()); res.json({ status: s.status }); });
  app.post('/api/sessions/:id/events', (req, res) => {
    const body = z.object({ eventId: z.string().min(1).max(200), role: z.enum(['agent', 'user']), text: z.string().trim().min(1).max(6000) }).parse(req.body);
    const id = String(req.params.id);
    const result = store.ingest(id, body.eventId, body.role, body.text);
    if (result.clarify) responder.clarify(result.session, result.clarify.question, result.clarify.answer, result.clarify.kind);
    maybeHandoff(result.session);
    publish(); res.json(result);
  });
  app.post('/api/sessions/:id/message', async (req, res) => {
    limit(req, 60);
    const body = z.object({ eventId: z.string().min(1).max(200), text: z.string().trim().min(1).max(6000) }).parse(req.body);
    const id = String(req.params.id);
    if (store.session(id).mode !== 'chat') throw new AppError(409, 'This conversation is not a text chat.');
    const result = store.ingest(id, body.eventId, 'user', body.text);
    if (result.duplicate) return res.json({ session: result.session, duplicate: true });
    lastSeen.set(id, Date.now());
    if (result.clarify) { responder.clarify(result.session, result.clarify.question, result.clarify.answer, result.clarify.kind); await responder.settle(id); }
    const session = store.session(id);
    const live = session.status === 'active';
    if (live) store.insertTurn(session, `${body.eventId}-reply`, 'agent', session.next.instruction);
    const finished = live && session.next.done ? end(id, 'completed') : session;
    maybeHandoff(session);
    publish(); res.json({ session: finished, duplicate: false });
  });
  app.post('/api/sessions/:id/end', (req, res) => { const { reason } = z.object({ reason: z.enum(['interrupted', 'completed', 'failed']) }).parse(req.body); res.json(end(String(req.params.id), reason)); });
  // Shared with the provider's "Prepare briefing": escalating warms this, so the
  // provider's first look costs no further model quota.
  const briefings = new Map<string, Briefing>();
  const briefingFor = async (id: string) => {
    const detail = store.detail(id);
    const session = detail.sessions[0];
    if (!session) throw new AppError(409, 'This patient has no check-in to brief yet.');
    const key = `${session.id}:${session.version}`;
    const cached = briefings.get(key);
    if (cached) return { briefing: cached, cached: true };
    const briefing = await generateBriefing(detail, gemini, options.fetcher);
    briefings.set(key, briefing);
    return { briefing, cached: false };
  };
  /**
   * A provider should never open a case with nothing but "please advise". Whatever
   * the nurse wrote, an automated summary is attached too — as its own audit entry
   * under its own attribution, so the two are never mistaken for each other.
   *
   * It never fails the escalation. If the model cannot answer, the intake rules
   * write the summary instead and say so, rather than a generated sentence
   * quietly becoming a scripted one.
   */
  const attachEscalationSummary = async (id: string) => {
    try {
      const { briefing } = await briefingFor(id);
      store.escalationSummary(id, briefing.reason, `Aftercare · ${briefing.model}`);
    } catch (error) {
      const why = error instanceof AppError ? error.message : 'the summary model was unavailable';
      store.escalationSummary(id, ruleSummary(store.detail(id)), `Aftercare · intake rules (${why})`);
    }
  };
  app.post('/api/patients/:id/actions', async (req, res) => {
    const { action, note, nurse } = z.object({ action: z.enum(['acknowledge', 'resolve', 'escalate', 'callback']), note: z.string().trim().max(2000).default(''), nurse: z.string().trim().min(1).max(60).default('Demo nurse') }).parse(req.body);
    const id = String(req.params.id);
    const patient = store.action(id, action, note);
    // A callback with a live audio route rings the patient's own page rather than
    // leaving a task nobody acts on. Without a route it stays a recorded task.
    if (action === 'callback' && mediaCapability(media).enabled) {
      try { store.requestHandoff(id, null, 'The care team is calling you back.'); }
      catch { /* another handoff is live; the callback task stands */ }
    }
    // The escalation is on record first; then the gate decides whether it may reach the provider. The nurse sees the verdict with the response.
    if (action === 'escalate') { await attachEscalationSummary(id); await gate.deliver({ patientId: id, nurse, note }); }
    res.json(store.patient(id)); publish();
  });
  // The nurse sees the newest attempt, demos included; the provider sees the newest genuine one (?genuine=1), which is what decides delivery.
  const escalationView = (id: string, genuineOnly = false) => ({ ...gate.capability(), escalation: store.latestEscalation(id, genuineOnly), policy: gate.policy() });
  app.get('/api/patients/:id/escalation', (req, res) => { store.patient(String(req.params.id)); res.json(escalationView(String(req.params.id), req.query.genuine === '1')); });
  // Re-run delivery for a held or rejected escalation. Only a nurse asks for this; it never changes the case.
  app.post('/api/patients/:id/escalation/retry', async (req, res) => {
    const { nurse } = z.object({ nurse: z.string().trim().min(1).max(60).default('Demo nurse') }).parse(req.body ?? {});
    const id = String(req.params.id); const last = store.latestEscalation(id);
    if (!last) throw new AppError(409, 'Escalate the case first; there is nothing to retry.');
    await gate.deliver({ patientId: id, nurse, note: last.note });
    res.json(escalationView(id)); publish();
  });
  // Demo: what an attacker's copy of the last escalation looks like to the gate. Recorded as a rejected attempt, never delivered.
  app.post('/api/patients/:id/escalation/demo', async (req, res) => {
    const { variant, nurse } = z.object({ variant: z.enum(['spoof', 'tamper', 'replay']), nurse: z.string().trim().min(1).max(60).default('Demo nurse') }).parse(req.body);
    const id = String(req.params.id);
    if (!store.latestEscalation(id)) throw new AppError(409, 'Escalate the case first so there is a genuine escalation to imitate.');
    await gate.demo(id, nurse, variant);
    res.json(escalationView(id)); publish();
  });
  app.get('/api/provider/policy', (_req, res) => res.json(gate.policy()));
  app.post('/api/provider/policy', (req, res) => {
    const patch = z.object({ acceptCalls: z.boolean().optional(), specialtyOnly: z.boolean().optional(), note: z.string().trim().max(80).optional() }).parse(req.body);
    res.json(gate.setPolicy(patch)); publish();
  });
  // Everything a third party needs to re-check a delivery decision: the record, with the evidence of every step.
  app.get('/api/proof/:requestId', (req, res) => {
    const record = store.escalationByRequest(String(req.params.requestId));
    if (!record) throw new AppError(404, 'No escalation with that request id.');
    res.json({ ...record, generatedAt: new Date().toISOString() });
  });
  const scoped = (req: express.Request) => {
    const outreach = store.outreachByToken(String(req.params.token));
    if (!outreach) throw new AppError(404, 'This check-in link is not valid. Ask the care team for a new one.');
    return outreach;
  };
  app.get('/api/outreach/:token', (req, res) => {
    const outreach = store.markOutreachOpened(String(req.params.token)) ?? scoped(req);
    const patient = store.patient(outreach.patientId);
    const active = store.activeSession();
    const session = active?.patientId === outreach.patientId ? active : null;
    // Deliberately narrow: a name, a language, and their own conversation. No worklist.
    res.json({
      outreach,
      patient: {
        id: patient.id, name: patient.name, initials: patient.initials, avatar: patient.avatar,
        language: patient.language, age: patient.age, procedure: patient.procedure,
        dischargeDate: patient.dischargeDate, appointment: patient.appointment,
        surgeon: patient.surgeon, caregiver: patient.caregiver, medications: patient.medications,
      },
      can: { voice: abilities().voice, chat: abilities().chat, voiceReason: abilities().voiceReason, chatReason: abilities().chatReason },
      handoff: (() => { const h = store.latestHandoff(); return h && h.patientId === outreach.patientId ? h : null; })(),
      session,
      turns: session ? store.detail(patient.id).turns.filter(t => t.sessionId === session.id) : [],
    });
    publish();
  });
  app.post('/api/outreach/:token/start', (req, res) => {
    const outreach = scoped(req);
    const body = z.object({ mode: z.enum(['chat', 'voice']).default('chat'), language: z.enum(['en', 'es']).optional() }).parse(req.body);
    if (body.mode === 'chat' && !abilities().chat) throw new AppError(503, abilities().chatReason);
    if (body.mode === 'voice' && !abilities().voice) throw new AppError(503, abilities().voiceReason);
    const language = body.language ?? store.patient(outreach.patientId).language;
    const session = store.start(outreach.patientId, body.mode, language, null, responder.enabled(), mediaCapability(media).enabled);
    store.clearCheckInRing(outreach.patientId);
    lastSeen.set(session.id, Date.now()); publish();
    res.status(201).json(session);
  });
  const patientHandoff = (req: express.Request) => {
    const outreach = scoped(req);
    const handoff = store.latestHandoff();
    if (!handoff || handoff.patientId !== outreach.patientId) throw new AppError(404, 'There is no call waiting for you.');
    return handoff;
  };
  app.post('/api/outreach/:token/handoff/token', (req, res) => {
    requireMedia();
    const handoff = patientHandoff(req);
    if (!['accepted', 'connecting', 'active'].includes(handoff.state)) throw new AppError(409, `No one is on the call yet (${handoff.state}).`);
    res.json(joinToken(media, handoff.room, `patient-${handoff.patientId}`, store.patient(handoff.patientId).name));
  });
  app.post('/api/outreach/:token/handoff/joined', (req, res) => {
    res.json(store.joinHandoff(patientHandoff(req).id, 'patient')); publish();
  });
  app.post('/api/outreach/:token/handoff/end', (req, res) => {
    // A patient hanging up is a disconnect, not a decision to close the case.
    const handoff = patientHandoff(req);
    res.json(handoff); publish();
  });
  app.get('/api/outreach/:token/next', async (req, res) => {
    const { session } = patientSession(req);
    await responder.settle(session.id);
    res.json({ next: store.session(session.id).next });
  });
  app.post('/api/outreach/:token/voice-url', async (req, res) => {
    limit(req, 10);
    const { session } = patientSession(req);
    if (session.mode !== 'voice' || session.status !== 'connecting') throw new AppError(409, 'A new call is required.');
    try { res.json({ signedUrl: await signedVoiceUrl(voice, options.fetcher) }); }
    catch (error) { end(session.id, 'failed', 'The call could not connect.'); throw error; }
  });
  app.post('/api/outreach/:token/connected', (req, res) => {
    const { session } = patientSession(req);
    const { providerId } = z.object({ providerId: z.string().max(200) }).parse(req.body);
    res.json(store.connect(session.id, providerId)); publish();
  });
  app.post('/api/outreach/:token/events', (req, res) => {
    const body = z.object({ eventId: z.string().min(1).max(200), role: z.enum(['agent', 'user']), text: z.string().trim().min(1).max(6000) }).parse(req.body);
    const { session } = patientSession(req);
    const result = store.ingest(session.id, body.eventId, body.role, body.text);
    if (result.clarify) responder.clarify(result.session, result.clarify.question, result.clarify.answer, result.clarify.kind);
    maybeHandoff(result.session);
    publish(); res.json(result);
  });
  const patientSession = (req: express.Request) => {
    const outreach = scoped(req);
    const active = store.activeSession();
    if (!active || active.patientId !== outreach.patientId) throw new AppError(409, 'This check-in is no longer active.');
    return { outreach, session: active };
  };
  app.post('/api/outreach/:token/message', async (req, res) => {
    limit(req, 60);
    const body = z.object({ eventId: z.string().min(1).max(200), text: z.string().trim().min(1).max(6000) }).parse(req.body);
    const { outreach, session: current } = patientSession(req);
    const result = store.ingest(current.id, body.eventId, 'user', body.text);
    if (result.duplicate) return res.json({ session: result.session, duplicate: true });
    lastSeen.set(current.id, Date.now());
    if (result.clarify) { responder.clarify(result.session, result.clarify.question, result.clarify.answer, result.clarify.kind); await responder.settle(current.id); }
    const session = store.session(current.id);
    const live = session.status === 'active';
    if (live) store.insertTurn(session, `${body.eventId}-reply`, 'agent', session.next.instruction);
    const finished = live && session.next.done ? end(current.id, 'completed') : session;
    if (finished.status !== 'active' && finished.status !== 'connecting') store.completeOutreach(outreach.patientId);
    maybeHandoff(session);
    publish(); res.json({ session: finished, duplicate: false });
  });
  app.post('/api/outreach/:token/heartbeat', (req, res) => {
    const { session } = patientSession(req);
    lastSeen.set(session.id, Date.now()); res.json({ status: session.status });
  });
  app.post('/api/outreach/:token/end', (req, res) => {
    const { outreach, session } = patientSession(req);
    const finished = end(session.id, 'interrupted');
    store.completeOutreach(outreach.patientId);
    res.json(finished);
  });

  app.post('/api/patients/:id/ring', (req, res) => {
    const id = String(req.params.id);
    const patient = store.patient(id);
    if (!patient.featured) throw new AppError(400, 'Only the three featured patients have a full synthetic record to check in on.');
    if (!abilities().voice && !abilities().chat) throw new AppError(503, abilities().chatReason);
    if (store.activeSession()) throw new AppError(409, 'A conversation is already running. End it before ringing another patient.');
    res.status(201).json(store.ringCheckIn(id)); publish();
  });
  app.post('/api/patients/:id/outreach', (req, res) => {
    const id = String(req.params.id);
    const patient = store.patient(id);
    if (!patient.featured) throw new AppError(400, 'Only the three featured patients have a full synthetic record to check in on.');
    res.status(201).json(store.createOutreach(id)); publish();
  });
  app.get('/api/provider/queue', (_req, res) => res.json(store.providerQueue()));
  app.post('/api/patients/:id/provider-note', (req, res) => {
    const { note, provider } = z.object({
      note: z.string().trim().min(1).max(2000),
      provider: z.string().trim().min(1).max(60).default('Demo provider'),
    }).parse(req.body);
    res.json(store.providerNote(String(req.params.id), note, provider));
    publish();
  });
  // The nurse's side of the case conversation. Symmetrical with the provider's, and
  // like it, it decides nothing: only the nurse's resolve action closes a case.
  app.post('/api/patients/:id/nurse-note', (req, res) => {
    const { note, nurse } = z.object({
      note: z.string().trim().min(1).max(2000),
      nurse: z.string().trim().min(1).max(60).default('Demo nurse'),
    }).parse(req.body);
    res.json(store.nurseNote(String(req.params.id), note, nurse));
    publish();
  });
  const nurseName = z.string().trim().min(1).max(60).default('Demo nurse');
  const requireMedia = () => { if (!mediaCapability(media).enabled) throw new AppError(503, mediaCapability(media).reason); };
  app.post('/api/patients/:id/handoff', async (req, res) => {
    requireMedia();
    const { reason } = z.object({ reason: z.string().trim().min(1).max(300).default('A nurse requested a live conversation.') }).parse(req.body);
    const active = store.activeSession();
    const handoff = store.requestHandoff(String(req.params.id), active?.patientId === req.params.id ? active.id : null, reason);
    if (ansCapability(ans).enabled) {
      const verification = await verifyCareTeam(ans, careTeamEndpoint, options.fetcher);
      store.verifyHandoff(handoff.id, verification);
      if (!verification.verified) {
        const closed = store.closeHandoff(handoff.id, 'failed', `Care-team service was not verified: ${verification.detail} No patient context was sent.`);
        publish();
        return res.status(502).json({ error: closed.outcome });
      }
    }
    publish();
    res.status(201).json(store.handoff(handoff.id));
  });
  app.get('/api/handoffs/:id', (req, res) => res.json(store.handoff(String(req.params.id))));
  app.post('/api/handoffs/:id/accept', (req, res) => {
    const { nurse } = z.object({ nurse: nurseName }).parse(req.body);
    res.json(store.acceptHandoff(String(req.params.id), nurse)); publish();
  });
  app.post('/api/handoffs/:id/decline', (req, res) => {
    const { nurse, note } = z.object({ nurse: nurseName, note: z.string().trim().max(300).default('') }).parse(req.body);
    const h = store.handoff(String(req.params.id));
    if (h.state !== 'requested') throw new AppError(409, `This handoff is no longer waiting (${h.state}).`);
    res.json(store.closeHandoff(h.id, 'declined', note || `${nurse} declined the handoff. An urgent callback task remains open.`, nurse)); publish();
  });
  app.post('/api/handoffs/:id/token', (req, res) => {
    requireMedia();
    const { role, nurse } = z.object({ role: z.enum(['patient', 'nurse']), nurse: nurseName }).parse(req.body);
    const h = store.handoff(String(req.params.id));
    if (!['accepted', 'connecting', 'active'].includes(h.state)) throw new AppError(409, `No nurse has accepted this handoff yet (${h.state}).`);
    if (role === 'nurse' && h.nurse !== nurse) throw new AppError(403, `This handoff was accepted by ${h.nurse}.`);
    const identity = role === 'nurse' ? `nurse-${h.nurse}` : `patient-${h.patientId}`;
    res.json(joinToken(media, h.room, identity, role === 'nurse' ? String(h.nurse) : store.patient(h.patientId).name));
  });
  app.post('/api/handoffs/:id/joined', (req, res) => {
    const { role } = z.object({ role: z.enum(['patient', 'nurse']) }).parse(req.body);
    res.json(store.joinHandoff(String(req.params.id), role)); publish();
  });
  app.post('/api/handoffs/:id/end', (req, res) => {
    const { outcome, state } = z.object({ outcome: z.string().trim().max(300).default(''), state: z.enum(['ended', 'failed']).default('ended') }).parse(req.body);
    const h = store.handoff(String(req.params.id));
    const fallback = state === 'failed' ? 'The live audio connection failed. An urgent callback task remains open.' : 'The nurse ended the live conversation.';
    res.json(store.closeHandoff(h.id, state, outcome || fallback, h.nurse || 'Aftercare')); publish();
  });
  app.post('/api/patients/:id/briefing', async (req, res) => {
    limit(req, 20);
    const id = String(req.params.id);
    const { briefing, cached } = await briefingFor(id);
    if (cached) return res.json(briefing);
    store.audit(id, briefing.sessionId, 'briefing', `Clinician briefing prepared (${briefing.model}). Draft for nurse review.`, store.session(briefing.sessionId).mode, 'Demo nurse');
    publish(); res.json(briefing);
  });
  app.post('/api/patients/:id/briefing/ask', async (req, res) => {
    limit(req, 20);
    const { question } = z.object({ question: z.string().trim().min(3).max(400) }).parse(req.body);
    res.json(await answerCaseQuestion(store.detail(String(req.params.id)), question, gemini, options.fetcher));
  });
  app.post('/api/demo/reset', (req, res) => {
    const { sampleData } = z.object({ sampleData: z.boolean().default(true) }).parse(req.body ?? {});
    res.json(store.reset(sampleData)); publish();
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  if (options.serveStatic) { app.use(express.static(join(process.cwd(), 'dist'))); app.get('/{*path}', (_req, res) => res.sendFile(join(process.cwd(), 'dist/index.html'))); }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request.' });
    const incident = randomUUID().slice(0, 8); console.error(`Internal error ${incident}`, error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: `Something went wrong (${incident}). Please try again.` });
  });
  const watchdog = setInterval(() => {
    if (store.expireCheckInRings(ringMs).length) publish();
    if (options.outreach !== false) {
      const due = store.dueForOutreach();
      if (due.length) { for (const patient of due) store.createOutreach(patient.id); publish(); }
    }
    if (store.expireHandoffs(ringMs).length) publish();
    const s = store.activeSession(); if (!s) return;
    const elapsed = Date.now() - Date.parse(s.startedAt);
    if (elapsed >= 300000) end(s.id, 'interrupted', 'Five-minute limit reached. Any incomplete intake requires review.');
    else if ((s.mode !== 'simulation' || browserPlayback.has(s.id)) && Date.now() - (lastSeen.get(s.id) || 0) > 35000) end(s.id, 'interrupted', 'Browser disconnected. Intake requires review.');
  }, 1000);
  watchdog.unref();
  return { app, close: () => { clearInterval(watchdog); for (const t of timers.values()) clearTimeout(t); for (const peer of peers) peer.end(); } };
}
