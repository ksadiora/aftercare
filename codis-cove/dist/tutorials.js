// Interactive app lessons. Practice actions never mutate the game or external services.
const KEY = "codis-cove-app-lessons-v1";
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const lessons = {
  bank: {
    name: "Meet your banking app", tag: "CAPITALTWO BANK → EVERYDAY MONEY",
    steps: [
      ["Find your savings", "An account is a place to keep money. Banking apps show your accounts together so you can choose the one you need.", "Tap the Savings account."],
      ["Give your coins a job", "Saving for a helmet turns ‘save more’ into a clear goal. A little at a time gets you closer without spending everything at once.", "Choose 20 coins, then review the move."],
      ["Check before you confirm", "In a banking app, check the amount and the destination before moving money. A review screen gives you a chance to catch a mistake.", "Check: 20 coins from Spending to Savings."],
      ["Read the story in Activity", "Activity records what happened, when, and how much moved. The island bank records your new savings in Nessie’s practice banking service.", "Open the +20 activity entry to read the receipt."],
    ],
    source: "https://www.capitalone.com/digital/tools/mobile/", sourceLabel: "See a real banking app",
  },
  classroom: {
    name: "Turn a busy day into a plan", tag: "NOTION CLASSROOM → EVERYDAY PLANNING",
    steps: [
      ["Give your plans a home", "Notion keeps notes, homework, and project plans in pages. Instead of remembering everything, you can put it somewhere easy to find.", "Open Classroom in the workspace sidebar."],
      ["A row can hold a whole plan", "A Notion database is a list you can organize. Each row can open as a page with instructions, notes, and small steps. Due dates help you spot what needs attention.", "Open the Pack for tomorrow row."],
      ["Make the next step obvious", "‘Get ready’ can feel like a big job. A checklist turns it into actions you can do one by one, just like the classroom stations on the island.", "Pack all three items in this practice checklist."],
      ["Keep the plan useful", "A shared board helps classmates and teammates see what is finished. Notion is one useful tool; the skill is making a clear plan and keeping it up to date.", "Mark Pack for tomorrow done in the practice table."],
    ],
    source: "https://www.notion.com/help/intro-to-databases", sourceLabel: "See Notion’s real interface",
  },
};

export function createAppTutorials({ show, close, isActive, services, onBank, onClassroom }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* session-only fallback */ }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  let topic, step, amount, checked, receipt, done, live, loading, serial = 0;
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* lessons still work */ } };
  function complete() {
    done = true;
    saved[topic] = { seen: true, done: true };
    persist();
  }
  function open(kind) {
    if (!lessons[kind]) return;
    topic = kind; step = 0; amount = 20; checked = new Set(); receipt = false; done = false; live = null; loading = false; serial++;
    saved[kind] = { seen: true, done: saved[kind]?.done === true };
    persist(); render();
  }
  function advance() { step = Math.min(3, step + 1); render(); }
  const badge = (text) => `<span class="app-demo-label">${text}</span>`;
  function bankApp() {
    return `<section class="bank-app" aria-label="Practice banking app">
      <header class="bank-app-top"><span class="bank-app-logo">C2</span><strong>CapitalTwo</strong><span>Banking practice</span></header>
      <div class="bank-app-body"><div class="app-breadcrumb">Home / ${step === 0 ? "Accounts" : step === 3 ? "Activity" : "Move money"}</div>
      ${step === 0 ? `<h3>Your money, at a glance.</h3><p class="app-muted">Example balances · pretend coins</p><div class="practice-accounts"><div><span>Spending</span><strong>120 <small>coins</small></strong><span>For everyday choices</span></div><button class="tutorial-target" data-tutorial="account"><span>Savings <b>↗</b></span><strong>0 <small>coins</small></strong><span>Open this account</span></button></div><div class="bank-goal"><span>◈</span><div><strong>A helmet for safer rides</strong><p>Your goal: 40 coins in savings</p><div class="app-progress"><i></i></div></div></div>` : ""}
      ${step === 1 ? `<h3>Move money to a goal.</h3><div class="transfer-route"><span>From <strong>Spending</strong><small>120 practice coins</small></span><b>→</b><span>To <strong>Savings</strong><small>Helmet goal</small></span></div><fieldset class="practice-amount"><legend>Choose an amount</legend>${[10,20,40].map(n=>`<label class="${amount===n?'selected':''}"><input type="radio" name="practice-amount" value="${n}" ${amount===n?'checked':''}>${n} coins</label>`).join('')}</fieldset><p class="app-muted">Try 20 coins for this walkthrough.</p><button class="bank-app-primary" data-tutorial="review">Review practice transfer <span>→</span></button><p class="app-inline-feedback" id="tutorial-feedback" role="status"></p>` : ""}
      ${step === 2 ? `<h3>Does everything look right?</h3><div class="practice-review"><span>Amount<strong>20 coins</strong></span><span>From<strong>Spending</strong></span><span>To<strong>Savings · helmet goal</strong></span><span>Spending after this example<strong>100 coins</strong></span><span>Savings after this example<strong>20 coins</strong></span></div><button class="bank-app-primary" data-tutorial="confirm">Confirm practice transfer ✓</button><p class="app-muted">This example does not move your game coins or send a deposit.</p>` : ""}
      ${step === 3 ? `<div class="bank-receipt-head"><span>✓</span><div><h3>Practice transfer complete</h3><p>20 coins set aside for your helmet.</p></div></div><h4>Activity</h4><button class="practice-transaction tutorial-target" data-tutorial="receipt"><span class="transaction-icon">↙</span><span><strong>Transfer to Savings</strong><small>Today · practice example</small></span><strong>+20 <small>coins</small></strong><span>›</span></button>${receipt ? `<div class="practice-receipt" role="status"><strong>Receipt checked ✓</strong><p>Amount: 20 coins · Destination: Savings<br>Date: Today · Status: Practice complete</p><p>You checked the amount, destination, date, and status—the same details to look for in a banking app.</p></div>` : ""}<div class="bank-bridge"><strong>On your island</strong><p>Save at the bank terminal → open your Nessie ledger → check the deposit.</p>${livePanel()}</div>` : ""}
      </div><footer>${badge("PRACTICE EXAMPLE · NO REAL MONEY")}<span>A familiar banking layout, made for this lesson.</span></footer></section>`;
  }
  function notionApp() {
    const checklistDone = checked.size === 3;
    return `<section class="notion-app" aria-label="Notion-style practice workspace"><aside class="notion-sidebar"><strong><span class="notion-mark">N</span> My workspace</strong><span class="notion-sidebar-muted">⌕ Search</span><span class="notion-sidebar-muted">⌂ Home</span><small>PRIVATE</small><button class="${step===0?'tutorial-target':''} ${step>0?'active':''}" data-tutorial="classroom">▤ Classroom</button><span class="notion-sidebar-muted">☷ Club ideas</span><span class="notion-sidebar-muted">☆ Reading list</span></aside><div class="notion-content"><header><span>Classroom ${step===2?' / Pack for tomorrow':''}</span><span>•••</span></header><div class="notion-page">
      ${step===0 ? `<div class="notion-page-icon">⌂</div><h3>Your workspace</h3><p>Pages give your ideas a place to live.</p><div class="notion-empty-page"><span>▤</span><strong>A page for class</strong><p>Open Classroom on the left to find your plan.</p></div>` : ""}
      ${step===1 || step===3 ? `<div class="notion-page-icon">▤</div><h3>Classroom</h3><p class="notion-description">A little plan. More room for the rest of your day.</p><div class="notion-callout">☀ <span>What matters today?<br><strong>Finish what is due, then make time to play.</strong></span></div><div class="notion-view-tabs"><span>▦ My afternoon</span><span>Filter · Sort</span></div><div class="notion-table-wrap"><table class="notion-table"><caption class="visually-hidden">Practice classroom task database</caption><thead><tr><th>Task</th><th>Due</th><th>Done</th></tr></thead><tbody><tr><td>Take a snack break</td><td>Today</td><td><span aria-label="Completed">☑</span></td></tr><tr><td>Homework practice</td><td><span class="notion-date">Tomorrow</span></td><td>☐</td></tr><tr class="${step===1?'notion-highlight':''}"><td><button class="notion-row-link ${step===1?'tutorial-target':''}" data-tutorial="task">▤ Pack for tomorrow <span>↗</span></button></td><td>Tonight</td><td>${step===3 ? `<input type="checkbox" aria-label="Mark Pack for tomorrow done in practice" data-tutorial-done ${done?'checked':''}>` : '☐'}</td></tr><tr><td>Play outside</td><td>Today</td><td>☐</td></tr></tbody></table></div>${step===3?`<div class="notion-callout"><span>✓</span><span>${done?'The board is up to date. You can see what is finished without keeping it all in your head.':'The checklist is finished. Check Done so the table tells the same story.'}</span></div><div class="notion-real-bridge"><strong>From practice to your class</strong><p>In the connected classroom board, “Mark done in Notion” updates the actual shared task. That helps a class or project team see its progress.</p>${livePanel()}</div>`:`<p class="app-muted">A date tells you when. A checkbox tells you whether it is finished. Open a task for the details.</p>`}` : ""}
      ${step===2 ? `<div class="notion-page-icon">▤</div><h3>Pack for tomorrow</h3><div class="notion-properties"><span>◷ Due</span><strong>Tonight</strong><span>☑ Done</span><span>Not yet</span></div><p>Put these three things in your bag so your morning is easier.</p><div class="notion-checklist">${['Notebook','Homework','Water bottle'].map((item,i)=>`<label><input type="checkbox" data-checklist="${i}" ${checked.has(i)?'checked':''}><span class="${checked.has(i)?'checked':''}">${item}</span></label>`).join('')}</div><div class="notion-checklist-feedback" role="status">${checklistDone?'Everything has a place. Now update your task in the table.':`${checked.size} of 3 packed. One clear action at a time.`}</div><button class="notion-continue" data-tutorial="back-to-table" ${checklistDone?'':'disabled'}>Back to my plan ↑</button>` : ""}
      </div><footer>${badge("NOTION-STYLE PRACTICE")}<span>Changes stay in this lesson.</span></footer></div></section>`;
  }
  function livePanel() { return `<div id="tutorial-live-content">${liveContent()}</div>`; }
  function liveContent() {
    const connected = services.snapshot()[topic==='bank'?'nessie':'notion'].configured;
    if (!connected) return `<p class="tutorial-connection-note">${topic==='bank'?'Connect Nessie to see your island deposits here.':'Practice is ready now. Connecting Notion adds a shared classroom board.'}</p>`;
    if (loading || !live) return '<p class="tutorial-connection-note" role="status">Checking your connected app…</p>';
    if (live.error) return `<p class="tutorial-connection-note" role="status">${escape(live.error)}</p>`;
    if (topic==='bank') return `<div class="tutorial-live-card"><span>LIVE NESSIE SANDBOX · PRETEND MONEY</span><strong>${escape(live.nickname)}</strong><p>Account balance: ${escape(live.balance)} coins</p><p>${live.deposits.length?`Latest island deposit: +${escape(live.deposits[0].amount)} coins · ${escape(live.deposits[0].status)}`:'No island deposits recorded yet.'}</p><small>The provider’s balance can update after its activity records.</small></div>`;
    return `<div class="tutorial-live-card"><span>CONNECTED NOTION CLASSROOM</span><strong>${live.assignments.length} shared task${live.assignments.length===1?'':'s'}</strong><p>${live.assignments.length?escape(live.assignments[0].title):'Your classroom is connected and ready for tasks.'}</p></div>`;
  }
  async function loadLive() {
    if (step!==3 || loading || live || !services.snapshot()[topic==='bank'?'nessie':'notion'].configured) return;
    loading=true;
    const requestSerial=serial, requestTopic=topic;
    try { const result=await (topic==='bank'?services.bank():services.assignments()); if(serial===requestSerial && topic===requestTopic) live=result; }
    catch(error) { if(serial===requestSerial && topic===requestTopic) live={error:error.message}; }
    finally { if(serial===requestSerial && topic===requestTopic) { loading=false; const host=document.getElementById('tutorial-live-content'); if(step===3 && isActive(`tutorial-${topic}`) && host) host.innerHTML=liveContent(); } }
  }
  function render(fetchLive=true) {
    const lesson=lessons[topic], [title,why,action]=lesson.steps[step];
    show(`<div class="app-tutorial"><header class="tutorial-heading"><div class="dialog-eyebrow">${lesson.tag}</div><h2 id="dialog-title">${lesson.name}</h2><div class="tutorial-step-track" aria-label="Step ${step+1} of 4">${lesson.steps.map((_,i)=>`<span class="${i===step?'current':i<step?'finished':''}">${i<step?'✓':i+1}</span>${i<3?'<i></i>':''}`).join('')}</div></header><div class="tutorial-layout"><aside class="tutorial-coach"><img src="./assets/codi-portrait.png" alt="Codi"><span class="service-tag">STEP ${step+1} OF 4</span><h3>${title}</h3><p>${why}</p><div class="tutorial-mission"><span>TRY IT</span><strong>${done?'Lesson complete ✓':action}</strong></div>${done?'<p class="tutorial-done" role="status">You’ve practiced a skill you can use beyond the island.</p>':''}</aside><div class="tutorial-screen">${topic==='bank'?bankApp():notionApp()}</div></div><footer class="tutorial-footer"><div><button class="text-button" data-tutorial="back" ${step===0?'disabled':''}>← Back</button><button class="text-button" data-tutorial="exit">Back to island</button></div>${done?`<button class="primary-btn" data-tutorial="connect">${topic==='bank'?'Open my Nessie account':'Open my classroom board'} ↗</button>`:'<span class="tutorial-action-hint">Try the highlighted action in the app.</span>'}</footer><p class="tutorial-reference">Interactive recreation, not a screenshot. <a href="${lesson.source}" target="_blank" rel="noopener noreferrer">${lesson.sourceLabel} ↗</a></p></div>`, `tutorial-${topic}`);
    bind();
    const stepHeading=document.querySelector('.tutorial-coach h3');
    if(stepHeading) { stepHeading.tabIndex=-1; stepHeading.focus({preventScroll:true}); }
    if(fetchLive) void loadLive();
  }
  function bind() {
    document.querySelectorAll('[data-tutorial]').forEach(button=>button.onclick=()=>{
      const action=button.dataset.tutorial;
      if(action==='exit') return close();
      if(action==='back') { step=Math.max(0,step-1); done=false; receipt=false; return render(); }
      if(action==='account' && step===0) return advance();
      if(action==='review') { if(amount!==20) { document.getElementById('tutorial-feedback').textContent='Choose 20 coins for this example, then review it.'; return; } return advance(); }
      if(action==='confirm' && step===2) return advance();
      if(action==='receipt' && step===3) { receipt=true; complete(); return render(); }
      if(action==='classroom') { step=1; done=false; return render(); }
      if(action==='task' && (step===1 || step===3)) { step=2; done=false; return render(); }
      if(action==='back-to-table' && checked.size===3) return advance();
      if(action==='connect') return topic==='bank'?onBank():onClassroom();
    });
    document.querySelectorAll('[name="practice-amount"]').forEach(input=>input.onchange=()=>{ amount=Number(input.value); document.querySelectorAll('.practice-amount label').forEach(label=>label.classList.toggle('selected',label.contains(input))); });
    document.querySelectorAll('[data-checklist]').forEach(input=>input.onchange=()=>{
      const i=Number(input.dataset.checklist); input.checked?checked.add(i):checked.delete(i);
      input.nextElementSibling.classList.toggle('checked',input.checked);
      document.querySelector('.notion-checklist-feedback').textContent=checked.size===3?'Everything has a place. Now update your task in the table.':`${checked.size} of 3 packed. One clear action at a time.`;
      document.querySelector('[data-tutorial="back-to-table"]').disabled=checked.size!==3;
    });
    const checkbox=document.querySelector('[data-tutorial-done]');
    if(checkbox) checkbox.onchange=()=>{ if(checkbox.checked) complete(); else done=false; render(); };
  }
  return { open, shouldIntroduce: (kind)=>saved[kind]?.seen!==true, completed: (kind)=>saved[kind]?.done===true };
}
