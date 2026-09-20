import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EscalationRecord, AuditEvent, CaseMessage, Dashboard, EndReason, Handoff, HandoffState, Language, Mode, Observation, Outreach, Patient, PatientDetail, QuestionId, ScenarioId, Session, Turn } from '../shared/types.js';
import { severityOrder } from '../shared/types.js';
import { messages, questionIds, questions } from '../shared/protocol.js';
import { classify } from './triage.js';
import { seedPatients } from './seed.js';
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
/** Recorded when a nurse escalates without writing anything, so the trail still shows the action. */
export const NO_NURSE_NOTE = 'Case escalated to the provider. The nurse did not add a note.';
const now = () => new Date().toISOString();
const parse = <T>(row: Record<string, unknown> | undefined): T | undefined => row ? JSON.parse(String(row.data)) as T : undefined;
const active = (s: Session) => s.status === 'active' || s.status === 'connecting';
export const modeLabel = (mode: Mode) => mode === 'voice' ? 'In-app call' : mode === 'chat' ? 'Text chat' : 'Simulation';
export class Store {
  db: DatabaseSync;
  runId = '';
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, number INTEGER NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patients (runId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(runId,id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, runId TEXT NOT NULL, patientId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, eventId TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(sessionId,eventId));
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, patientId TEXT, sessionId TEXT, kind TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL, mode TEXT);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, runId TEXT NOT NULL, patientId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach (token TEXT PRIMARY KEY, runId TEXT NOT NULL, patientId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS escalations (id TEXT PRIMARY KEY, runId TEXT NOT NULL, patientId TEXT NOT NULL, requestId TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outreach_run ON outreach(runId);
      CREATE INDEX IF NOT EXISTS handoffs_run ON handoffs(runId);
      CREATE INDEX IF NOT EXISTS audit_run ON audit(runId,id);
      CREATE INDEX IF NOT EXISTS sessions_patient ON sessions(runId,patientId);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(sessionId);`);
    const last = this.db.prepare('SELECT id FROM runs ORDER BY number DESC LIMIT 1').get();
    if (!last) this.reset(); else this.runId = String(last.id);
    for (const row of this.db.prepare('SELECT data FROM sessions').all()) {
      const session = parse<Session>(row)!;
      if (active(session)) this.finish(session.id, 'interrupted', 'Server restarted; intake incomplete.');
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(patientId: string | null, sessionId: string | null, kind: string, text: string, mode: Mode | 'seed' | null = null, actor = 'Aftercare', runId = this.runId) {
    this.db.prepare('INSERT INTO audit(runId,patientId,sessionId,kind,actor,text,createdAt,mode) VALUES(?,?,?,?,?,?,?,?)').run(runId, patientId, sessionId, kind, actor, text, now(), mode);
  }
  reset(sampleData = true) {
    if (this.runId && this.activeSession()) throw new AppError(409, 'End the active conversation before starting a new demo.');
    const oldRun = this.runId;
    try {
      return this.transaction(() => {
        const number = Number(this.db.prepare('SELECT COALESCE(MAX(number),0) AS n FROM runs').get()!.n) + 1;
        this.runId = randomUUID();
        this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(this.runId, number, now());
        for (const patient of seedPatients(sampleData)) {
          patient.quoteSource = patient.mode;
          this.db.prepare('INSERT INTO patients VALUES(?,?,?)').run(this.runId, patient.id, JSON.stringify(patient));
          if (patient.featured) this.audit(patient.id, null, 'seed', patient.mode === 'seed' ? 'Illustrative outreach record loaded. This is synthetic seed data.' : 'Synthetic discharge record loaded. Day 3 check-in due.', 'seed');
        }
        this.audit(null, null, 'reset', `Demo ${number} started${sampleData ? '' : ' with no sample assessments, so everything on the worklist comes from this run'}. Earlier demo records remain in history.`);
        return { runId: this.runId, number };
      });
    } catch (error) { this.runId = oldRun; throw error; }
  }
  /** Cases a nurse has escalated, newest first, with the nurse's reason attached. */
  providerQueue() {
    return this.db.prepare('SELECT data FROM patients WHERE runId=?').all(this.runId).map(r => parse<Patient>(r)!)
      .filter(p => p.disposition === 'escalated')
      // Only escalations the gate delivered reach the provider. Held and rejected ones stay with the nurse, with the reason.
      .filter(p => this.latestEscalation(p.id, true)?.status === 'delivered')
      .map(p => {
        const escalation = (this.db.prepare("SELECT * FROM audit WHERE runId=? AND patientId=? AND kind='escalate' ORDER BY id DESC LIMIT 1").get(this.runId, p.id) as unknown as AuditEvent | undefined);
        const reply = (this.db.prepare("SELECT * FROM audit WHERE runId=? AND patientId=? AND kind='provider_note' ORDER BY id DESC LIMIT 1").get(this.runId, p.id) as unknown as AuditEvent | undefined);
        // Only summaries attached at or after this escalation; an older one describes a case that has since moved on.
        const summary = (this.db.prepare("SELECT * FROM audit WHERE runId=? AND patientId=? AND kind='escalation_summary' AND id>=? ORDER BY id DESC LIMIT 1").get(this.runId, p.id, escalation?.id ?? 0) as unknown as AuditEvent | undefined);
        return {
          patient: p, escalatedAt: escalation?.createdAt ?? null,
          // The nurse's own words, and empty when they chose not to write any.
          reason: escalation && escalation.text !== NO_NURSE_NOTE ? escalation.text : '',
          summary: summary?.text ?? null, summarySource: summary?.actor ?? null,
          lastReply: reply?.text ?? null, repliedAt: reply?.createdAt ?? null,
          thread: this.caseThread(p.id),
          escalation: this.latestEscalation(p.id, true),
        };
      })
      .sort((a, b) => String(b.escalatedAt).localeCompare(String(a.escalatedAt)));
  }

  /**
   * The conversation a nurse and a provider are holding about one case, oldest
   * first. Assembled from the audit trail rather than stored beside it, so there
   * can be no discussion the permanent record does not show. The nurse's escalation
   * note is the opening message; the automated summary is not a message and is not
   * in here.
   */
  caseThread(id: string, runId = this.runId): CaseMessage[] {
    const rows = this.db.prepare("SELECT * FROM audit WHERE runId=? AND patientId=? AND kind IN ('escalate','nurse_note','provider_note') ORDER BY id").all(runId, id) as unknown as AuditEvent[];
    return rows
      .filter(row => row.text !== NO_NURSE_NOTE)
      .map(row => ({ id: row.id, role: row.kind === 'provider_note' ? 'provider' as const : 'nurse' as const, author: row.actor, text: row.text, at: row.createdAt }));
  }

  /** A provider's written response, back to the same audit trail the nurse reads. */
  providerNote(id: string, note: string, provider: string) {
    const p = this.patient(id);
    this.audit(id, null, 'provider_note', note, null, provider);
    return p;
  }

  /** The escalation gate's record for a case: one row per delivery attempt, newest wins. */
  saveEscalation(record: EscalationRecord) {
    if (!record.runId) record.runId = this.runId;
    this.db.prepare('INSERT INTO escalations(id,runId,patientId,requestId,status,createdAt,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data')
      .run(record.id, record.runId, record.patientId, record.requestId, record.status, record.createdAt, JSON.stringify(record));
  }
  /** Newest attempt for the case. With genuineOnly, demo attempts (an attacker's copy, always rejected) are skipped: they never decide delivery. */
  latestEscalation(patientId: string, genuineOnly = false, runId = this.runId): EscalationRecord | null {
    const rows = this.db.prepare('SELECT data FROM escalations WHERE runId=? AND patientId=? ORDER BY createdAt DESC, rowid DESC LIMIT 20').all(runId, patientId).map(r => parse<EscalationRecord>(r)!);
    return rows.find(r => !genuineOnly || r.variant === 'genuine') ?? null;
  }
  escalationByRequest(requestId: string): EscalationRecord | null {
    return parse<EscalationRecord>(this.db.prepare('SELECT data FROM escalations WHERE requestId=? ORDER BY rowid DESC LIMIT 1').get(requestId)) ?? null;
  }

  /** The nurse's side of that conversation. Like a provider note, it decides nothing. */
  nurseNote(id: string, note: string, nurse: string) {
    const p = this.patient(id);
    this.audit(id, null, 'nurse_note', note, null, nurse);
    return p;
  }

  patient(id: string, runId = this.runId) {
    const p = parse<Patient>(this.db.prepare('SELECT data FROM patients WHERE runId=? AND id=?').get(runId, id));
    if (!p) throw new AppError(404, 'Patient not found.'); return p;
  }
  savePatient(p: Patient, runId = this.runId) { this.db.prepare('UPDATE patients SET data=? WHERE runId=? AND id=?').run(JSON.stringify(p), runId, p.id); }
  session(id: string) {
    const s = parse<Session>(this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id));
    if (!s) throw new AppError(404, 'Conversation not found.');
    s.version ??= 0; s.adaptive ??= false; s.clarified ??= []; s.probed ??= []; s.handoff ??= false;
    return s;
  }
  saveSession(s: Session) { this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(s), s.id); }
  activeSession() { return this.db.prepare('SELECT data FROM sessions WHERE runId=?').all(this.runId).map(r => parse<Session>(r)!).find(active) ?? null; }
  dashboard(): Dashboard {
    const patients = this.db.prepare('SELECT data FROM patients WHERE runId=?').all(this.runId).map(r => parse<Patient>(r)!);
    patients.sort((a, b) => Number(a.disposition === 'resolved') - Number(b.disposition === 'resolved') || severityOrder[a.severity] - severityOrder[b.severity] || a.name.localeCompare(b.name));
    // Cases where the newest message came from a provider, so the worklist can show
    // whose turn it is rather than leaving the nurse to open every case and check.
    const awaitingNurse = patients
      .map(patient => this.caseThread(patient.id).at(-1))
      .filter(last => last?.role === 'provider')
      .map(last => String(this.db.prepare('SELECT patientId FROM audit WHERE id=?').get(last!.id)!.patientId));
    return { patients, awaitingNurse, activeSession: this.activeSession(), handoff: this.latestHandoff(), outreach: this.outreachQueue(), runId: this.runId, runNumber: Number(this.db.prepare('SELECT number FROM runs WHERE id=?').get(this.runId)!.number), recent: this.db.prepare('SELECT * FROM audit WHERE runId=? ORDER BY id DESC LIMIT 5').all(this.runId) as unknown as AuditEvent[] };
  }
  detail(id: string): PatientDetail {
    const patient = this.patient(id);
    const sessions = this.db.prepare('SELECT data FROM sessions WHERE runId=? AND patientId=? ORDER BY rowid DESC').all(this.runId, id).map(r => parse<Session>(r)!);
    const turns = sessions.flatMap(s => this.db.prepare('SELECT data FROM turns WHERE sessionId=? ORDER BY rowid').all(s.id).map(r => parse<Turn>(r)!));
    const observations = sessions.flatMap(s => this.db.prepare('SELECT data FROM observations WHERE sessionId=? ORDER BY rowid').all(s.id).map(r => parse<Observation>(r)!));
    const audit = this.db.prepare('SELECT * FROM audit WHERE runId=? AND patientId=? ORDER BY id DESC').all(this.runId, id) as unknown as AuditEvent[];
    return { patient, sessions, turns, observations, audit, thread: this.caseThread(id), escalation: this.latestEscalation(id) };
  }
  history(runId?: string) {
    const runs = this.db.prepare('SELECT r.*, (SELECT COUNT(*) FROM sessions s WHERE s.runId=r.id) AS conversations FROM runs r ORDER BY number DESC').all();
    const events = this.db.prepare('SELECT * FROM audit WHERE runId=? ORDER BY id DESC').all(runId || this.runId);
    return { runs, events };
  }
  start(patientId: string, mode: Mode, language: Language, scenario: ScenarioId | null, adaptive = false, handoff = false) {
    return this.transaction(() => {
      if (this.activeSession()) throw new AppError(409, 'A conversation is already active. End it before starting another.');
      const p = this.patient(patientId);
      if (!p.featured) throw new AppError(400, 'Use one of the three featured patients for conversations.');
      const s: Session = { id: randomUUID(), runId: this.runId, patientId, mode, language, status: mode === 'voice' ? 'connecting' : 'active', startedAt: now(), endedAt: null, questionIndex: 0, answers: [], next: { instruction: questions[language].consent, done: false }, scenario, severity: 'unassessed', providerId: null, version: 0, adaptive, clarified: [], probed: [], handoff };
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(s.id, s.runId, patientId, JSON.stringify(s));
      p.quoteSource ??= p.mode;
      p.contactStatus = mode === 'voice' ? 'Connecting' : 'Check-in in progress'; p.mode = mode;
      this.savePatient(p); this.audit(patientId, s.id, 'session_started', `${modeLabel(mode)} check-in started in ${language === 'es' ? 'Spanish' : 'English'}.`, mode);
      if (mode !== 'voice') this.insertTurn(s, 'opening', 'agent', s.next.instruction);
      return s;
    });
  }
  insertTurn(s: Session, eventId: string, role: 'user' | 'agent', text: string) {
    const turn: Turn = { id: randomUUID(), sessionId: s.id, role, text, createdAt: now(), language: s.language, questionId: questionIds[s.questionIndex] ?? null };
    this.db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run(turn.id, s.id, eventId, JSON.stringify(turn)); return turn;
  }
  ingest(id: string, eventId: string, role: 'agent' | 'user', text: string) {
    return this.transaction(() => {
      const s = this.session(id);
      let clarify: { question: QuestionId; kind: 'rephrase' | 'probe'; answer: string } | null = null;
      if (this.db.prepare('SELECT id FROM turns WHERE sessionId=? AND eventId=?').get(id, eventId)) return { session: s, duplicate: true, clarify };
      if (!active(s)) throw new AppError(409, 'This conversation has ended.');
      if (Date.now() - Date.parse(s.startedAt) >= 300000) throw new AppError(409, 'The five-minute session limit has been reached.');
      if (role === 'user' && s.next.done) throw new AppError(409, 'The intake has ended; no further answers are accepted.');
      this.insertTurn(s, eventId, role, text);
      s.status = 'active';
      const p = this.patient(s.patientId, s.runId); p.contactStatus = 'Check-in in progress';
      if (role === 'user') {
        const question = questionIds[s.questionIndex];
        const finding = classify(text, question);
        if (finding.clear && !finding.stop && !s.answers.includes(question)) s.answers.push(question);
        if (finding.severity !== 'unassessed') {
          const o: Observation = { id: randomUUID(), sessionId: id, severity: finding.severity, category: finding.category, quote: text, action: finding.action, createdAt: now() };
          this.db.prepare('INSERT INTO observations VALUES(?,?,?)').run(o.id, id, JSON.stringify(o));
          if (severityOrder[finding.severity] < severityOrder[s.severity]) s.severity = finding.severity;
          if (severityOrder[finding.severity] < severityOrder[p.severity] || !p.quote || p.disposition === 'resolved') {
            p.severity = finding.severity; p.quote = text; p.action = finding.action; p.quoteSource = s.mode;
          }
          // New evidence reopens a resolved case; it never erases prior nurse actions.
          if (p.disposition === 'resolved') p.disposition = 'open';
          this.audit(p.id, id, 'flag', `${finding.category}: “${text}”`, s.mode);
        }
        if (finding.stop) s.next = { instruction: messages[s.language][finding.stop === 'callback' && s.handoff ? 'handoff' : finding.stop], done: true, reason: finding.stop };
        else if (s.adaptive && question !== 'consent' && !s.clarified.includes(question) && (!finding.clear || finding.severity !== 'unassessed')) {
          // Hold the questionnaire in place for one adaptive turn, at most once per
          // question. Two cases: an answer the rules could not read gets rephrased,
          // and an answer that raised a flag gets one follow-up for observable detail.
          // Either way the severity decided above stands, and the model can neither
          // advance the questionnaire, downgrade a concern, nor end the intake.
          s.clarified.push(question);
          if (finding.clear) s.probed.push(question);
          clarify = { question, kind: finding.clear ? 'probe' : 'rephrase', answer: text };
          s.next = { instruction: questions[s.language][question], done: false };
        }
        else {
          s.questionIndex += 1;
          if (s.questionIndex >= questionIds.length) {
            const allAnswered = s.answers.length === questionIds.length;
            s.next = { instruction: s.severity === 'unassessed' && allAnswered ? messages[s.language].completed : messages[s.language].review, done: true, reason: allAnswered ? 'completed' : 'interrupted' };
          } else s.next = { instruction: `${finding.clear || s.probed.includes(question) ? '' : messages[s.language].clarify + ' '}${questions[s.language][questionIds[s.questionIndex]]}`, done: false };
        }
        if (s.mode === 'simulation') this.insertTurn(s, `${eventId}-reply`, 'agent', s.next.instruction);
      }
      s.version += 1;
      this.saveSession(s); this.savePatient(p, s.runId);
      return { session: s, duplicate: false, clarify };
    });
  }
  applyClarification(id: string, expectedVersion: number, instruction: string, source: string) {
    const s = this.session(id);
    if (s.version !== expectedVersion || !active(s) || s.next.done) return null;
    s.next = { ...s.next, instruction }; s.version += 1; this.saveSession(s);
    this.audit(s.patientId, s.id, 'adaptive_question', `Adaptive follow-up asked (${source}): \u201c${instruction}\u201d`, s.mode);
    return s;
  }
  /** Abandon a held probe and move on. A follow-up we could not ask is not a reason
   *  to ask the patient the same question twice. */
  releaseProbe(id: string, expectedVersion: number) {
    return this.transaction(() => {
      const s = this.session(id);
      if (s.version !== expectedVersion || !active(s) || s.next.done) return null;
      const question = questionIds[s.questionIndex];
      if (!question || !s.probed.includes(question)) return null;
      s.questionIndex += 1;
      if (s.questionIndex >= questionIds.length) {
        const allAnswered = s.answers.length === questionIds.length;
        s.next = { instruction: s.severity === 'unassessed' && allAnswered ? messages[s.language].completed : messages[s.language].review, done: true, reason: allAnswered ? 'completed' : 'interrupted' };
      } else {
        s.next = { instruction: questions[s.language][questionIds[s.questionIndex]], done: false };
      }
      s.version += 1; this.saveSession(s);
      return s;
    });
  }
  connect(id: string, providerId: string) {
    const s = this.session(id); if (!active(s)) throw new AppError(409, 'Conversation has ended.');
    s.status = 'active'; s.providerId = providerId; this.saveSession(s); return s;
  }
  finish(id: string, requested: EndReason, description?: string) {
    return this.transaction(() => {
      const s = this.session(id); if (!active(s)) return s;
      const reason = s.next.done ? s.next.reason! : (requested === 'completed' ? 'interrupted' : requested);
      s.status = reason; s.endedAt = now(); s.version += 1;
      const p = this.patient(s.patientId, s.runId);
      if (reason === 'completed') {
        p.contactStatus = 'Outreach documented'; p.lastContact = now();
        if (s.severity === 'unassessed' && s.answers.length === questionIds.length) {
          s.severity = 'green';
          if (p.severity === 'unassessed' || p.severity === 'green') {
            p.severity = 'green';
            const lastUser = this.db.prepare("SELECT data FROM turns WHERE sessionId=? AND json_extract(data,'$.role')='user' ORDER BY rowid DESC LIMIT 1").get(s.id);
            p.quote = parse<Turn>(lastUser)?.text || ''; p.quoteSource = s.mode;
            p.action = 'No concern detected · nurse review available';
          }
        }
      } else {
        p.contactStatus = reason === 'emergency' ? 'Emergency flagged' : reason === 'callback' ? 'Callback requested' : reason === 'failed' ? 'Connection failed' : reason === 'declined' ? 'Intake declined' : 'Intake incomplete';
        if (p.severity === 'green' || p.severity === 'unassessed') { p.severity = 'yellow'; p.action = 'Manual follow-up · intake incomplete'; p.quote = ''; }
        if (p.disposition === 'resolved') p.disposition = 'open';
      }
      this.saveSession(s); this.savePatient(p, s.runId);
      this.audit(p.id, s.id, 'session_ended', description || `Check-in ${reason}. ${reason === 'completed' ? 'Outreach documented; case remains under nurse control.' : 'Nurse follow-up remains open.'}`, s.mode, 'Aftercare', s.runId);
      return s;
    });
  }
  // ---- Scheduled outreach -------------------------------------------------
  // The service reaches out; it does not wait to be opened. A patient who is due
  // gets an invitation with a scoped token, and that token is the only thing the
  // patient side can authenticate with.
  private DAY = 86400000;
  outreachQueue(runId = this.runId) { return this.db.prepare('SELECT data FROM outreach WHERE runId=? ORDER BY rowid').all(runId).map(r => parse<Outreach>(r)!); }
  outreachByToken(token: string) { return parse<Outreach>(this.db.prepare('SELECT data FROM outreach WHERE token=?').get(token)) ?? null; }
  private saveOutreach(o: Outreach) { this.db.prepare('UPDATE outreach SET data=? WHERE token=?').run(JSON.stringify(o), o.token); }

  /** Day 3 after discharge, no contact yet, no invitation already out. */
  dueForOutreach(dayThreshold = 3) {
    const existing = new Set(this.outreachQueue().map(o => o.patientId));
    return this.db.prepare('SELECT data FROM patients WHERE runId=?').all(this.runId).map(r => parse<Patient>(r)!)
      .filter(p => p.featured && !p.lastContact && !existing.has(p.id)
        && Date.now() - Date.parse(p.dischargeDate) >= dayThreshold * this.DAY);
  }

  /** Called by the scheduler. Creating the invitation IS the outreach. */
  createOutreach(patientId: string) {
    return this.transaction(() => {
      const existing = this.outreachQueue().find(o => o.patientId === patientId);
      if (existing) return existing;
      const p = this.patient(patientId);
      const o: Outreach = {
        id: randomUUID(), runId: this.runId, patientId, token: randomUUID().replace(/-/g, ''),
        state: 'sent', dueAt: now(), createdAt: now(), openedAt: null, completedAt: null, ringingSince: null,
      };
      this.db.prepare('INSERT INTO outreach VALUES(?,?,?,?)').run(o.token, o.runId, patientId, JSON.stringify(o));
      p.contactStatus = 'Invitation sent'; this.savePatient(p);
      this.audit(patientId, null, 'outreach_sent', `Day ${Math.floor((Date.now() - Date.parse(p.dischargeDate)) / this.DAY)} check-in invitation generated for ${p.name}. No delivery channel is configured, so the link is shown in the outreach queue instead of being sent.`, null, 'Aftercare');
      return o;
    });
  }

  /** Ring the patient to take their check-in with the agent now. Not a human call:
   *  answering starts the same automated check-in they would have started themselves. */
  ringCheckIn(patientId: string) {
    const outreach = this.outreachQueue().find(o => o.patientId === patientId) ?? this.createOutreach(patientId);
    const fresh = this.outreachByToken(outreach.token)!;
    fresh.ringingSince = now(); this.saveOutreach(fresh);
    const p = this.patient(patientId); p.contactStatus = 'Check-in call ringing'; this.savePatient(p);
    this.audit(patientId, null, 'checkin_ring', `Care team rang ${p.name} to take their day 3 check-in with the follow-up agent.`, null, 'Demo nurse');
    return fresh;
  }
  clearCheckInRing(patientId: string) {
    const outreach = this.outreachQueue().find(o => o.patientId === patientId && o.ringingSince);
    if (!outreach) return null;
    outreach.ringingSince = null; this.saveOutreach(outreach);
    return outreach;
  }
  /** Called by the watchdog: the patient never picked up. */
  expireCheckInRings(ringMs: number) {
    return this.outreachQueue()
      .filter(o => o.ringingSince && Date.now() - Date.parse(o.ringingSince) >= ringMs)
      .map(o => {
        o.ringingSince = null; this.saveOutreach(o);
        const p = this.patient(o.patientId);
        p.contactStatus = 'No answer to check-in call'; this.savePatient(p);
        this.audit(o.patientId, null, 'checkin_no_answer', `${p.name} did not answer the check-in call. The invitation link still works.`, null);
        return o;
      });
  }
  markOutreachOpened(token: string) {
    const o = this.outreachByToken(token);
    if (!o || o.state !== 'sent') return o;
    o.state = 'opened'; o.openedAt = now(); this.saveOutreach(o);
    this.audit(o.patientId, null, 'outreach_opened', `${this.patient(o.patientId).name} opened the check-in invitation.`, null, 'Aftercare');
    return o;
  }

  completeOutreach(patientId: string) {
    const o = this.outreachQueue().find(x => x.patientId === patientId && x.state !== 'completed');
    if (!o) return null;
    o.state = 'completed'; o.completedAt = now(); this.saveOutreach(o);
    return o;
  }

  // ---- Nurse handoff -------------------------------------------------------
  // A handoff is a separate object from the intake session on purpose: a nurse
  // joining a call is not a second intake, so it never touches the active-session lock.
  private liveHandoff = (h: Handoff) => ['requested', 'accepted', 'connecting', 'active'].includes(h.state);
  private saveHandoff(h: Handoff) { this.db.prepare('UPDATE handoffs SET data=? WHERE id=?').run(JSON.stringify(h), h.id); }
  handoff(id: string) {
    const h = parse<Handoff>(this.db.prepare('SELECT data FROM handoffs WHERE id=?').get(id));
    if (!h) throw new AppError(404, 'Handoff request not found.'); return h;
  }
  handoffs(runId = this.runId) { return this.db.prepare('SELECT data FROM handoffs WHERE runId=? ORDER BY rowid DESC').all(runId).map(r => parse<Handoff>(r)!); }
  activeHandoff() { return this.handoffs().find(this.liveHandoff) ?? null; }
  latestHandoff() { return this.handoffs()[0] ?? null; }

  /** Requesting twice returns the same request, so a double click cannot ring twice. */
  requestHandoff(patientId: string, sessionId: string | null, reason: string) {
    return this.transaction(() => {
      const existing = this.handoffs().find(h => h.patientId === patientId && this.liveHandoff(h));
      if (existing) return existing;
      const other = this.activeHandoff();
      if (other) throw new AppError(409, 'Another handoff is already in progress in this demo.');
      const p = this.patient(patientId);
      const h: Handoff = {
        id: randomUUID(), runId: this.runId, patientId, sessionId, room: `aftercare-${randomUUID().slice(0, 8)}`,
        state: 'requested', reason, nurse: null, outcome: null,
        requestedAt: now(), acceptedAt: null, endedAt: null, joined: [], verification: null,
      };
      this.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?)').run(h.id, h.runId, patientId, JSON.stringify(h));
      p.contactStatus = 'Waiting for a nurse'; this.savePatient(p);
      this.audit(patientId, sessionId, 'handoff_requested', `Live nurse handoff requested: ${reason}`, null);
      return h;
    });
  }

  /** Atomic claim. The first nurse to commit owns the call; a second gets 409. */
  acceptHandoff(id: string, nurse: string) {
    return this.transaction(() => {
      const h = this.handoff(id);
      if (h.state === 'accepted' || h.state === 'connecting' || h.state === 'active') {
        if (h.nurse === nurse) return h;
        throw new AppError(409, `${h.nurse} already accepted this handoff.`);
      }
      if (h.state !== 'requested') throw new AppError(409, `This handoff is no longer waiting (${h.state}).`);
      h.state = 'accepted'; h.nurse = nurse; h.acceptedAt = now();
      this.saveHandoff(h);
      const p = this.patient(h.patientId); p.contactStatus = 'Nurse joining'; this.savePatient(p);
      this.audit(h.patientId, h.sessionId, 'handoff_accepted', `${nurse} accepted the live handoff.`, null, nurse);
      return h;
    });
  }

  /** Only both participants being present makes a handoff 'active'. */
  joinHandoff(id: string, who: 'patient' | 'nurse') {
    return this.transaction(() => {
      const h = this.handoff(id);
      if (!this.liveHandoff(h)) throw new AppError(409, `This handoff has ended (${h.state}).`);
      if (h.state === 'requested') throw new AppError(409, 'No nurse has accepted this handoff yet.');
      if (!h.joined.includes(who)) h.joined.push(who);
      h.state = h.joined.includes('patient') && h.joined.includes('nurse') ? 'active' : 'connecting';
      this.saveHandoff(h);
      if (h.state === 'active') {
        const p = this.patient(h.patientId); p.contactStatus = 'Talking with nurse'; this.savePatient(p);
        this.audit(h.patientId, h.sessionId, 'handoff_connected', `${h.nurse} and the patient are connected on live audio.`, null, h.nurse || 'Aftercare');
      }
      return h;
    });
  }

  /** Every unhappy ending keeps an open, urgent callback task on the case. */
  closeHandoff(id: string, state: HandoffState, outcome: string, actor = 'Aftercare') {
    return this.transaction(() => {
      const h = this.handoff(id);
      if (!this.liveHandoff(h)) return h;
      h.state = state; h.outcome = outcome; h.endedAt = now();
      this.saveHandoff(h);
      const p = this.patient(h.patientId);
      if (state === 'ended') p.contactStatus = 'Nurse conversation documented';
      else {
        p.contactStatus = state === 'declined' ? 'Callback requested' : state === 'timed_out' ? 'No nurse answered' : 'Handoff failed';
        p.action = 'Nurse callback requested';
        if (p.disposition === 'resolved') p.disposition = 'open';
      }
      this.savePatient(p);
      this.audit(h.patientId, h.sessionId, `handoff_${state}`, outcome, null, actor);
      return h;
    });
  }

  verifyHandoff(id: string, verification: NonNullable<Handoff['verification']>) {
    const h = this.handoff(id); h.verification = verification; this.saveHandoff(h);
    this.audit(h.patientId, h.sessionId, 'handoff_verification', `${verification.verified ? 'Verified' : 'Rejected'} care-team service ${verification.service}: ${verification.detail}`, null);
    return h;
  }

  /** Called by the watchdog: nobody answered within the ring window. */
  expireHandoffs(ringMs: number) {
    return this.handoffs()
      .filter(h => h.state === 'requested' && Date.now() - Date.parse(h.requestedAt) >= ringMs)
      .map(h => this.closeHandoff(h.id, 'timed_out', 'No nurse answered the handoff request. An urgent callback task remains open.'));
  }

  action(id: string, action: 'acknowledge' | 'resolve' | 'escalate' | 'callback', note: string) {
    return this.transaction(() => {
      const p = this.patient(id);
      // Closing a case still needs the nurse's own words; escalating does not,
      // because an escalation always carries an automated summary as well.
      if (action === 'resolve' && !note.trim()) throw new AppError(400, 'Add a note before resolving.');
      if (action === 'acknowledge') p.disposition = 'acknowledged';
      if (action === 'resolve') p.disposition = 'resolved';
      if (action === 'escalate') p.disposition = 'escalated';
      if (action === 'callback') { if (p.disposition === 'resolved') p.disposition = 'open'; p.action = 'Nurse callback requested'; }
      this.savePatient(p);
      const fallback = action === 'acknowledge' ? 'Case acknowledged for review.'
        : action === 'escalate' ? NO_NURSE_NOTE
        : 'Nurse callback requested. No telephone call was placed.';
      this.audit(id, null, action, note.trim() || fallback, null, 'Demo nurse');
      return p;
    });
  }

  /**
   * The automated half of an escalation, kept as its own entry so the provider and
   * the audit trail can always tell the nurse's words from a generated summary.
   * `source` goes in the actor column, which is where attribution already lives.
   */
  escalationSummary(id: string, summary: string, source: string) {
    const text = summary.trim();
    if (!text) return;
    const session = this.db.prepare('SELECT data FROM sessions WHERE runId=? AND patientId=? ORDER BY rowid DESC LIMIT 1').get(this.runId, id);
    this.audit(id, parse<Session>(session)?.id ?? null, 'escalation_summary', text, null, source);
  }
  close() { this.db.close(); }
}
