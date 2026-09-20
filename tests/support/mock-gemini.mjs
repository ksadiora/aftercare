// Test-only stand-in for the Gemini generateContent endpoint. Started by Playwright
// so the browser tests exercise the adaptive and briefing UI without spending quota
// or depending on network access. It is never imported by the application.
import { createServer } from 'node:http';

const envelope = value => JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
  modelVersion: 'gemini-2.5-flash-e2e',
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
});

createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const spanish = body.includes('Language: Spanish') || body.includes('Also translate this line');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (body.includes('Write the reason this case needs review')) {
      return res.end(envelope({
        reason: 'The patient described a red, warm incision and a fever the night before.',
        statements: [{ text: 'The patient reported the incision is red and warm.', turns: [3] }],
        englishTranslation: spanish ? 'It is red and warm, and I had a fever last night.' : '',
      }));
    }
    if (body.includes('The nurse asks:')) {
      return res.end(envelope({ answer: 'They said the skin is red and warm.', turns: [3], grounded: true }));
    }
    return res.end(envelope({
      clarification: spanish
        ? '¿Puede mirar la herida ahora y decirme si la piel está roja o caliente?'
        : 'When you look at the incision right now, is the skin red or warm to the touch?',
      rationale: 'The answer did not describe the skin.',
    }));
  });
}).listen(4399, '127.0.0.1', () => console.log('mock gemini listening on 4399'));
