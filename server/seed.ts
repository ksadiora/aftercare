import type { Patient } from '../shared/types.js';
export function seedPatients(sampleData = true): Patient[] {
  const dischargeDate = new Date(Date.now() - 3 * 86400000).toISOString();
  const appointment = new Date(Date.now() + 4 * 86400000).toISOString();
  const base = { procedure: 'Total knee replacement', dischargeDate, appointment, surgeon: 'Dr. Morgan Lee', medications: ['Discharge medication list · synthetic record', 'Nurse to review any medication questions'], caregiver: 'Family support available', disposition: 'open' as const };
  const featured: Patient[] = [
    { ...base, id: 'alvarez', name: 'Miguel Alvarez', initials: 'MA', age: 71, language: 'es', featured: true, avatar: 'sage', severity: 'unassessed', quote: '', action: 'Day 3 check-in is ready to begin', contactStatus: 'Ready for check-in', lastContact: null, mode: null, caregiver: 'Elena Alvarez · daughter' },
    { ...base, id: 'johnson', name: 'Evelyn Johnson', initials: 'EJ', age: 68, language: 'en', featured: true, avatar: 'sand', severity: 'yellow', quote: 'I don’t have a ride to my appointment.', action: 'Nurse review today · arrange appointment transportation', contactStatus: 'Outreach documented', lastContact: new Date(Date.now() - 32 * 60000).toISOString(), mode: 'seed', caregiver: 'Lives independently' },
    { ...base, id: 'chen', name: 'Robert Chen', initials: 'RC', age: 74, language: 'en', featured: true, avatar: 'blue', severity: 'green', quote: 'I picked up my prescriptions, and my son is taking me to my appointment.', action: 'Responses documented · nurse review available', contactStatus: 'Outreach documented', lastContact: new Date(Date.now() - 58 * 60000).toISOString(), mode: 'seed', caregiver: 'Daniel Chen · son' },
  ];
  const names = ['Patricia Williams', 'James Thompson', 'Maria Garcia', 'William Davis', 'Linda Wilson', 'Richard Martinez', 'Barbara Anderson', 'Joseph Taylor', 'Susan Thomas', 'Charles Moore', 'Jessica Martin', 'Thomas Jackson', 'Sarah White', 'Christopher Harris', 'Karen Clark', 'Daniel Lewis', 'Nancy Robinson', 'Matthew Walker', 'Betty Hall', 'Anthony Allen', 'Margaret Young', 'Mark Hernandez', 'Sandra King', 'Donald Wright', 'Ashley Lopez', 'Steven Hill', 'Dorothy Scott', 'Paul Green', 'Kimberly Adams', 'Andrew Baker', 'Donna Gonzalez', 'Joshua Nelson', 'Carol Carter', 'Kenneth Mitchell', 'Ruth Perez', 'George Roberts', 'Shirley Turner'];
  const unassessed = (p: Patient): Patient => ({
    ...p, severity: 'unassessed', disposition: 'open', quote: '', quoteSource: null,
    action: 'Day 3 check-in is ready to begin', contactStatus: 'Ready for check-in',
    lastContact: null, mode: null,
  });
  const cohort = names.map((name, i): Patient => ({
    ...base, id: `cohort-${i + 1}`, name, initials: name.split(' ').map(n => n[0]).join(''), age: 62 + (i % 19), language: i % 7 === 2 ? 'es' : 'en', featured: false, avatar: ['sage', 'sand', 'blue', 'lavender'][i % 4],
    severity: i < 2 ? 'red' : 'green',
    quote: i === 0 ? 'The skin around the incision feels hot.' : i === 1 ? 'I was not sure, so I took both the old and new medicine.' : 'I have my prescriptions and a ride to my appointment.',
    action: i < 2 ? 'Nurse callback · review reported concern (15 min demo target)' : 'Responses documented · nurse review available',
    contactStatus: 'Outreach documented', lastContact: new Date(Date.now() - (70 + i * 3) * 60000).toISOString(), mode: 'seed',
  }));
  const all = [...featured, ...cohort];
  return sampleData ? all : all.map(unassessed);
}
