import { createCodiChat } from "./codi.js";
import { createAppTutorials } from "./tutorials.js";
import { createWorld } from "./world.js";
import { createServiceClient } from "./services.js";
import {
  QUESTS,
  freshState,
  sanitizeState,
  STORAGE_KEY,
  getLevel,
  deposit,
  completeQuest,
  validPlan,
  guideReply,
  worldObjective,
  applyWorldAction,
} from "./game.js";
const $ = (id) => document.getElementById(id);
const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state;
let storageWorks = true;
try {
  state = sanitizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
} catch {
  state = freshState();
}
let world, toastTimer, audioContext;
let currentScreen = "explore";

let previousFocus;
let resetBackup = null;
let trackedQuest = null;
let worldMessageTimer;
const dialog = $("game-dialog");
const services = createServiceClient({ changed: renderServiceStatus });
const appTutorials = createAppTutorials({
  show: open,
  close,
  isActive: (screen) => currentScreen === screen && dialog.open,
  services,
  onBank: bankLedger,
  onClassroom: classroomBoard,
});
let serviceView = 0;
const codiChat = createCodiChat({
  request: services.askCodi,
  fallback: (text) => guideReply(text, state),
  configured: () => services.snapshot().gemini?.configured === true,
  getProgress: () =>
    Object.fromEntries(
      [
        "coins",
        "savings",
        "xp",
        "completed",
        "bankDeposited",
        "gardenStep",
        "plannerOrder",
        "planStep",
        "hasWateringCan",
        "collectibles",
      ].map((key) => [key, state[key]]),
    ),
  getTracked: () => trackedQuest,
  changed: () => renderChat(),
});
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWorks = true;
  } catch {
    storageWorks = false;
  }
  renderHUD();
  return storageWorks;
}
function tone(success = false) {
  if (!state.sound) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    const notes = success ? [523.25, 659.25, 783.99, 1046.5] : [523.25, 659.25];
    notes.forEach((freq, i) => {
      const osc = audioContext.createOscillator(),
        gain = audioContext.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = audioContext.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.04, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(start);
      osc.stop(start + 0.36);
    });
  } catch {
    /* Audio is optional. */
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
function open(content, screen) {
  serviceView++;
  currentScreen = screen || currentScreen;
  dialog.classList.toggle("tutorial-dialog", currentScreen.startsWith("tutorial-"));
  const wasOpen = dialog.open;
  if (!wasOpen) previousFocus = document.activeElement;
  $("dialog-content").innerHTML = content;
  if (!wasOpen) dialog.showModal();
  dialog.scrollTop = 0;
  $("close-dialog").focus({ preventScroll: true });
}
function close() {
  dialog.close();
  currentScreen = "explore";
}
$("close-dialog").addEventListener("click", close);
dialog.addEventListener("close", () => {
  currentScreen = "explore";
  previousFocus?.focus?.({ preventScroll: true });
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      close();
  }
});
function heading(eyebrow, title, intro = "") {
  return `<div class="dialog-eyebrow">${eyebrow}</div><h2 id="dialog-title">${title}</h2>${intro ? `<p class="dialog-intro">${intro}</p>` : ""}`;
}
function renderHUD() {
  const objective = worldObjective(state, trackedQuest);
  const q = QUESTS.find((q) => q.id === objective.quest);
  const level = getLevel(state.xp);
  $("coin-count").textContent = state.coins;
  $("level-number").textContent = level;
  $("level-name").textContent = [
    "Curious explorer",
    "Finding your stride",
    "Cove keeper",
  ][level - 1];
  $("xp-fill").style.width = `${Math.min((state.xp / 150) * 100, 100)}%`;
  document.querySelector(".level-chip").title = `${state.xp} of 150 XP earned`;
  $("quest-count").textContent = 3 - state.completed.length;
  document.querySelector(".profile-btn").firstChild.textContent =
    state.name[0].toUpperCase();
  $("sound-toggle").textContent = state.sound ? "♫" : "♪";
  $("sound-toggle").setAttribute(
    "aria-label",
    state.sound ? "Mute sound" : "Enable sound",
  );
  $("sound-toggle").title = state.sound ? "Mute sound" : "Enable sound";
  $("sound-toggle").setAttribute("aria-pressed", String(state.sound));
  document.body.classList.toggle("motion-reduced", state.reducedMotion);
  $("quest-category").textContent = q ? q.category : "CHAPTER COMPLETE";
  $("quest-title").textContent = objective.title;
  $("quest-description").textContent = objective.detail;
  $("quest-step").textContent = `${state.completed.length}/3 skills earned`;
  $("start-quest").innerHTML = "Choose an adventure <span>↗</span>";
  document.querySelector(".quest-reward").hidden =
    !q || state.completed.includes(q.id);
  document
    .querySelectorAll(".quest-pagination>span")
    .forEach((el, i) =>
      el.classList.toggle("active", i < state.completed.length),
    );
  document.querySelectorAll(".landmark").forEach((el) => {
    const id = QUESTS.find((q) => el.classList.contains(q.id))?.id;
    if (id && el.querySelector("small"))
      el.querySelector("small").textContent = state.completed.includes(id)
        ? "✓"
        : { bank: "SAVE", classroom: "PLAN", garden: "GROW" }[id];
  });
  $("codi-tip").textContent = objective.detail;
  if (!storageWorks)
    document.querySelector(".local-note").textContent =
      "Session only · browser storage unavailable";
  world?.updateProgress(state);
  world?.setObjective(objective.target);
}
function showWorldMessage(message, reward) {
  const panel = $("world-feedback");
  clearTimeout(worldMessageTimer);
  panel.innerHTML = reward
    ? `<strong>✦ ${escapeHTML(QUESTS.find((q) => q.id === reward).badge)} unlocked!</strong>${escapeHTML(message)}`
    : escapeHTML(message);
  panel.classList.toggle("reward", !!reward);
  panel.classList.add("show");
  worldMessageTimer = setTimeout(() => panel.classList.remove("show"), 6000);
}
function handleWorldAction(id) {
  const lesson = id === "bank" || id === "bank-ledger" ? "bank"
    : id === "classroom-board" || id.startsWith("plan-") ? "classroom" : null;
  if (lesson && appTutorials.shouldIntroduce(lesson)) return appTutorials.open(lesson);
  if (id === "bank-ledger") return bankLedger();
  if (id === "classroom-board") return classroomBoard();
  try {
    const previousSavings = state.savings;
    const result = applyWorldAction(state, id);
    if (result.reward) trackedQuest = null;
    if (result.changed) {
      const stored = save();
      if (stored && state.savings > previousSavings)
        services.recordDeposit(state.savings - previousSavings);
      tone(!!result.reward);
    }
    showWorldMessage(result.message, result.reward);
    return result;
  } catch (error) {
    showWorldMessage(error.message);
    return { changed: false };
  }
}
function bindPlaces() {
  document
    .querySelectorAll("[data-place]")
    .forEach((b) => (b.onclick = () => visit(b.dataset.place)));
}
function locationCards() {
  return QUESTS.map(
    (q) =>
      `<button class="location-card" data-place="${q.id}"><span class="location-icon">${q.icon}</span><span><strong>${q.location}</strong><small>${q.skill}</small></span><span>${state.completed.includes(q.id) ? "✓" : "↗"}</span></button>`,
  ).join("");
}
function map() {
  open(
    `${heading("SUNBEAM ISLAND", "Where to next?", "Follow your curiosity. Every place has something to teach you.")}<div class="location-cards">${locationCards()}</div><p class="note">Choose a destination to track it. Walk there, then press E near the object. Drag to look around; Space to jump.</p>`,
    "map",
  );
  bindPlaces();
}
function journal() {
  open(
    `${heading("YOUR ADVENTURE JOURNAL", "Small steps. Real superpowers.", `${state.completed.length} of 3 adventures complete · ${state.xp} XP earned`)}<div class="progress-line" aria-label="Adventure progress"><span style="width:${(state.completed.length / 3) * 100}%"></span></div><div class="location-cards">${QUESTS.map((q) => `<button class="location-card" data-place="${q.id}"><span class="location-icon">${q.icon}</span><span><strong>${q.name}</strong><small>${q.location} · ${state.completed.includes(q.id) ? "Badge earned — explore this place" : "50 XP + 20 coins"}</small></span><span>${state.completed.includes(q.id) ? "✓" : "↗"}</span></button>`).join("")}</div><button class="secondary-btn" id="journal-classroom">Notion classroom board</button><p class="note">Choose a quest to track it in the world. Walk up to objects and press E. Rewards are earned once.</p>`,
    "journal",
  );
  $("journal-classroom").onclick = classroomBoard;
  addTutorialEntry("classroom", "A classroom you can use beyond the island", "See how a Notion page, task table, and checklist turn a busy day into a plan.");
  bindPlaces();
}

function addTutorialEntry(topic, title, detail) {
  const entry = document.createElement("div");
  entry.className = "tutorial-entry";
  entry.innerHTML = `<div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(detail)}</p></div><button class="secondary-btn">${appTutorials.completed(topic) ? "Replay app tutorial" : "Try app tutorial"} ↗</button>`;
  entry.querySelector("button").onclick = () => appTutorials.open(topic);
  $("dialog-content").appendChild(entry);
}

function appGuides() {
  open(`${heading("FROM THE ISLAND TO EVERYDAY LIFE", "Get to know the apps.", "Try the screens, learn what the buttons mean, and connect the skill to your island adventure.")}<div class="tutorial-library"><button id="guide-bank"><span>◈</span><strong>Meet your banking app</strong><small>Accounts, savings, review screens, and activity. Then see your live Nessie practice account.</small></button><button id="guide-notion"><span>▤</span><strong>Make a plan in Notion</strong><small>Open a workspace, turn a task into a checklist, and keep a shared board useful.</small></button></div><p class="note">Practice screens are interactive recreations. You can explore them without moving your game coins or updating a shared task.</p>`, "app-guides");
  $("guide-bank").onclick = () => appTutorials.open("bank");
  $("guide-notion").onclick = () => appTutorials.open("classroom");
}
function backpack() {
  open(
    `${heading("YOUR BACKPACK", "Good things you’ve picked up.", "A few coins, new skills, and a little more confidence.")}<div class="balance-row"><div class="balance-card"><span>In your pocket</span><strong>${state.coins}</strong><em>Cove coins</em></div><div class="balance-card"><span>Saved for later</span><strong>${state.savings}</strong><em>Cove coins</em></div></div><h3>Your gear &amp; finds</h3><div class="planner-labels"><span>${state.hasWateringCan ? "Watering can collected ✓" : "Watering can · find it in the garden"}</span><span>Trail coins ${state.collectibles.length}/3</span>${state.gardenStep === 3 && !state.completed.includes("garden") ? "<span>Harvest basket · ready to share</span>" : ""}</div><h3>Your skill badges</h3><div class="badge-grid">${QUESTS.map((q) => `<div class="badge-tile ${state.completed.includes(q.id) ? "" : "locked"}"><span>${q.icon}</span><strong>${q.badge}</strong><small>${state.completed.includes(q.id) ? "Earned!" : `Try ${q.location}`}</small></div>`).join("")}</div><div class="dialog-actions"><button class="secondary-btn" id="backpack-bank">Nessie savings ledger</button><button class="primary-btn" id="backpack-journal">Find an adventure <span>↗</span></button></div><p class="note">Cove coins are pretend money for practicing. Your backpack is saved only in this browser.</p>`,
    "backpack",
  );
  $("backpack-journal").onclick = journal;
  $("backpack-bank").onclick = bankLedger;
  addTutorialEntry("bank", "What does a banking app look like?", "Try a practice transfer, check its receipt, and find your real Nessie sandbox activity.");
}
function profile() {
  open(
    `${heading("EXPLORER PROFILE", `Hello, ${escapeHTML(state.name)}.`, `Level ${getLevel(state.xp)} · ${state.xp} XP · ${state.completed.length} skill badges`)}<form id="profile-form"><label class="range-label" for="explorer-name">What should Codi call you?</label><input id="explorer-name" type="text" maxlength="20" value="${escapeHTML(state.name)}" required autocomplete="off"><div class="dialog-actions"><button class="primary-btn" type="submit">Save explorer name <span>✓</span></button></div></form><p class="note">Your name stays on this device. No account needed.</p>`,
    "profile",
  );
  $("profile-form").onsubmit = (e) => {
    e.preventDefault();
    const name = $("explorer-name").value.trim();
    if (!name) return;
    state.name = name.slice(0, 20);
    save();
    close();
    toast(`Looking good, ${state.name}. Let’s explore!`);
  };
}
function settings() {
  open(
    `${heading("MAKE YOURSELF AT HOME", "Your kind of cove.")}<div class="settings-row"><label for="sound-setting"><strong>Gentle sound effects</strong><small>A little chime for small wins.</small></label><input type="checkbox" id="sound-setting" ${state.sound ? "checked" : ""}></div><div class="settings-row"><label for="motion-setting"><strong>Reduce motion</strong><small>Keep the world still while you explore.</small></label><input type="checkbox" id="motion-setting" ${state.reducedMotion ? "checked" : ""}></div><h3>Getting around</h3><p class="dialog-intro">Move with <strong>WASD</strong> or the <strong>arrow keys</strong>. Hold <strong>Shift</strong> to sprint and press <strong>Space</strong> to jump. <strong>Drag</strong> the world to look around and scroll to zoom; Q/R also turn the camera. Press <strong>E</strong> near an object to interact. M opens the map, 1 the journal, 2 your backpack, and C chats with Codi. Escape closes a window.</p><div class="dialog-actions"><button class="secondary-btn" id="unstuck">Return to the dock</button><button class="secondary-btn" id="about">About this cove</button></div><h3>Beyond the island</h3><button class="secondary-btn" id="connected-services">Connected services</button><p class="note">Codi with Gemini, Nessie savings, and your Notion classroom.</p><h3>A fresh little start</h3><button class="danger-btn" id="reset-ask">Start a new adventure</button>${resetBackup ? '<button class="text-button" id="settings-undo">Undo last fresh start</button>' : ""}<p class="note">${storageWorks ? "Progress is saved automatically in this browser." : "Browser storage is unavailable. Progress will last for this session only."} Your operating system’s reduced-motion preference is also respected.</p>`,
    "settings",
  );
  $("sound-setting").onchange = (e) => {
    state.sound = e.target.checked;
    save();
    tone();
  };
  $("motion-setting").onchange = (e) => {
    state.reducedMotion = e.target.checked;
    save();
  };
  $("unstuck").onclick = () => {
    world?.resetPosition();
    close();
    toast("Back at the dock. A fresh direction awaits.");
  };
  $("about").onclick = about;
  $("connected-services").onclick = connections;
  $("reset-ask").onclick = resetPrompt;
  if ($("settings-undo"))
    $("settings-undo").onclick = () => {
      state = resetBackup;
      resetBackup = null;
      save();
      close();
      toast("Your previous adventure is restored.");
    };
}
function resetPrompt() {
  open(
    `${heading("FRESH START", "Begin a new adventure?", "This resets your coins, badges, and lesson progress on this device. You can undo the reset until you close or reload this page.")}<div class="dialog-actions"><button class="secondary-btn" id="cancel-reset">Keep my adventure</button><button class="primary-btn" id="reset-confirm">Start fresh <span>↗</span></button></div>`,
    "reset",
  );
  $("cancel-reset").onclick = settings;
  $("reset-confirm").onclick = () => {
    const backup = structuredClone(state);
    resetBackup = backup;
    state = freshState();
    trackedQuest = null;
    codiChat.reset();
    save();
    world?.resetPosition();
    open(
      `${heading("A BRAND NEW CHAPTER", "The cove is yours again.", "Your adventures are ready whenever you are.")}<div class="dialog-actions"><button class="secondary-btn" id="undo-reset">Undo fresh start</button><button class="primary-btn" id="fresh-play">Explore the island <span>↗</span></button></div>`,
      "reset-done",
    );
    $("undo-reset").onclick = () => {
      state = backup;
      resetBackup = null;
      save();
      close();
      toast("Your previous adventure is restored.");
    };
    $("fresh-play").onclick = close;
  };
}
function renderServiceStatus() {
  if (currentScreen === "codi") renderChat();
  const s = services.snapshot();
  if ($("nessie-sync-status"))
    $("nessie-sync-status").textContent = s.syncing
      ? "Recording your savings…"
      : s.message ||
        `${s.pending} savings record${s.pending === 1 ? "" : "s"} waiting to sync · ${s.confirmed} confirmed`;
  if ($("sync-savings"))
    $("sync-savings").disabled =
      s.syncing || !s.nessie.configured || !s.pending;
}
function connections() {
  const s = services.snapshot();
  open(
    `${heading("CONNECTED SERVICES", "Your connected cove.", "Connect Codi’s AI assistant, sandbox savings, and classroom assignments.")}<div class="service-cards"><article class="service-card"><span class="service-tag">GEMINI · CODI</span><h3>A curious companion.</h3><p>Ask general questions, brainstorm, or get help with your next adventure.</p><strong>${s.gemini?.configured ? "Configured · chat to check" : "Setup needed"}</strong><button class="secondary-btn" id="open-codi">Chat with Codi</button></article><article class="service-card"><span class="service-tag">NESSIE · SANDBOX</span><h3>Your savings, recorded.</h3><p>New deposits can be sent to your configured practice account. This uses pretend money.</p><strong>${s.nessie.configured ? "Configured · open ledger to check" : "Setup needed"}</strong><button class="secondary-btn" id="open-ledger">Open savings ledger</button></article><article class="service-card"><span class="service-tag">NOTION · CLASSROOM</span><h3>A little direction from class.</h3><p>Read assignments from your class board and mark finished work done in Notion.</p><strong>${s.notion.configured ? "Configured · open board to check" : "Setup needed"}</strong><button class="secondary-btn" id="open-board">Open classroom board</button></article></div><div class="service-help"><h3>For the hackathon team</h3><p>Copy <code>.env.example</code> to <code>.env</code> in the project folder. Add <code>GEMINI_API_KEY</code> for Codi. Nessie and Notion use their own keys and IDs. Restart <code>npm start</code>, then refresh here.</p><p>The included <code>SERVICE_SETUP.md</code> explains each step. Credentials belong in the server file.</p>${!s.available ? '<p class="feedback error">The service server is unavailable. Restart this project with npm start.</p>' : ""}</div><button class="primary-btn" id="refresh-connections">Refresh connections</button>`,
    "connections",
  );
  $("open-codi").onclick = codi;
  $("open-ledger").onclick = bankLedger;
  $("open-board").onclick = classroomBoard;
  $("refresh-connections").onclick = async () => {
    const view = serviceView;
    $("refresh-connections").disabled = true;
    await services.refresh();
    if (currentScreen === "connections" && serviceView === view) connections();
  };
}
async function bankLedger() {
  const s = services.snapshot();
  open(
    `${heading("CAPITALTWO BANK × NESSIE", "Small savings. A real record.", "Your sandbox ledger is separate from the Cove coins in your backpack.")}<div class="service-card"><span class="service-tag">SAVINGS SYNC</span><p id="nessie-sync-status" role="status"></p><button class="primary-btn" id="sync-savings">Sync pending savings</button></div><div id="bank-records" aria-live="polite">${s.nessie.configured ? "<p>Checking your Nessie account…</p>" : '<p class="service-empty">Your island savings work now. Add a Nessie API key and sandbox account ID to the server to connect this ledger.</p>'}</div><div class="dialog-actions"><button class="secondary-btn" id="refresh-ledger">Refresh ledger</button><button class="text-button" id="ledger-connections">Connection setup</button></div><p class="note">New savings are queued on this device and sent automatically while Nessie is configured. Existing savings from before this integration are not imported. Resetting the island does not remove external records.</p>`,
    "bank-ledger",
  );
  const view = serviceView;
  addTutorialEntry("bank", "Make sense of the banking screen", "Walk through accounts, moving money, and reading your activity.");
  renderServiceStatus();
  $("ledger-connections").onclick = connections;
  $("refresh-ledger").onclick = bankLedger;
  $("sync-savings").onclick = async () => {
    await services.sync();
    if (currentScreen === "bank-ledger" && serviceView === view) bankLedger();
  };
  if (!s.nessie.configured) return;
  try {
    const data = await services.bank();
    if (currentScreen !== "bank-ledger" || serviceView !== view) return;
    $("bank-records").innerHTML =
      `<div class="balance-row"><div class="balance-card"><span>${escapeHTML(data.nickname)}</span><strong>${escapeHTML(data.balance)}</strong><em>Nessie sandbox balance</em></div><div class="balance-card"><span>This adventure</span><strong>${state.savings}</strong><em>Saved Cove coins</em></div></div><p class="service-tag">CONNECTED · LATEST ACCOUNT RESPONSE</p><h3>Recent Cove deposits</h3>${data.deposits.length ? `<ul class="service-ledger">${data.deposits.map((d) => `<li><strong>+${escapeHTML(d.amount)} coins</strong><span>${escapeHTML(d.date || "Date unavailable")} · ${escapeHTML(d.status)}</span></li>`).join("")}</ul>` : '<p class="service-empty">No Cove deposits in this account yet. Save coins at the bank terminal to add one.</p>'}<p class="note">Nessie may process deposits asynchronously. The balance and transaction status come directly from the sandbox.</p>`;
  } catch (error) {
    if (currentScreen === "bank-ledger" && serviceView === view)
      $("bank-records").innerHTML =
        `<p class="feedback error">${escapeHTML(error.message)}</p>`;
  }
}
async function classroomBoard() {
  const s = services.snapshot();
  open(
    `${heading("NOTION CLASSROOM", "Today’s little adventures.", "Assignments from your connected classroom. Island-linked work unlocks after you earn its skill badge.")}<div id="classroom-assignments" aria-live="polite">${s.notion.configured ? "<p>Opening the classroom board…</p>" : '<p class="service-empty">Your classroom board is ready to connect. Add the Notion token and data source ID to the server, then share that classroom with your integration.</p>'}</div><div class="dialog-actions"><button class="secondary-btn" id="refresh-classroom">Refresh assignments</button><button class="text-button" id="classroom-connections">Connection setup</button></div><p class="note">“Mark done in Notion” checks the Done box in the connected classroom. Your explorer name is not sent. This demo board is intended for one explorer.</p>`,
    "classroom-board",
  );
  const view = serviceView;
  addTutorialEntry("classroom", "Why learn a tool like Notion?", "Keep homework in one place, break jobs into steps, and show your team what is finished.");
  $("classroom-connections").onclick = connections;
  $("refresh-classroom").onclick = classroomBoard;
  if (!s.notion.configured) return;
  try {
    const data = await services.assignments();
    if (currentScreen !== "classroom-board" || serviceView !== view) return;
    $("classroom-assignments").innerHTML = data.assignments.length
      ? `<p class="service-tag">CONNECTED · ${data.assignments.length} ASSIGNMENTS</p><div class="assignment-list">${data.assignments
          .map((task) => {
            const unlocked =
              !task.quest || state.completed.includes(task.quest);
            return `<article class="service-card"><span class="service-tag">${task.done ? "DONE IN NOTION ✓" : task.quest ? escapeHTML(QUESTS.find((q) => q.id === task.quest).location) : "CLASSROOM ASSIGNMENT"}</span><h3>${escapeHTML(task.title)}</h3>${task.notes ? `<p class="assignment-notes">${escapeHTML(task.notes)}</p>` : ""}<div class="dialog-actions">${task.quest && !task.done ? `<button class="secondary-btn" data-assignment-quest="${task.quest}">Track island adventure</button>` : ""}${!task.done ? `<button class="primary-btn" data-complete-assignment="${escapeHTML(task.id)}" ${!unlocked || !task.canComplete ? "disabled" : ""}>Mark done in Notion</button>` : ""}</div>${!task.canComplete ? '<p class="note">The teacher needs to add a Done checkbox to enable completion.</p>' : !unlocked && !task.done ? '<p class="note">Earn this adventure’s badge before marking it done.</p>' : ""}<p class="assignment-feedback" role="status"></p></article>`;
          })
          .join("")}</div>`
      : '<p class="service-empty">Your Notion connection is working. Add assignment rows to the classroom database, then refresh this board.</p>';
    document
      .querySelectorAll("[data-assignment-quest]")
      .forEach(
        (button) =>
          (button.onclick = () => visit(button.dataset.assignmentQuest)),
      );
    document.querySelectorAll("[data-complete-assignment]").forEach(
      (button) =>
        (button.onclick = async () => {
          const feedback = button
            .closest("article")
            .querySelector(".assignment-feedback");
          button.disabled = true;
          feedback.textContent = "Updating Notion…";
          try {
            await services.complete(button.dataset.completeAssignment);
            if (currentScreen === "classroom-board" && serviceView === view)
              classroomBoard();
          } catch (error) {
            if (button.isConnected) {
              feedback.textContent = error.message;
              button.disabled = false;
            }
          }
        }),
    );
  } catch (error) {
    if (currentScreen === "classroom-board" && serviceView === view)
      $("classroom-assignments").innerHTML =
        `<p class="feedback error">${escapeHTML(error.message)}</p>`;
  }
}

function about() {
  open(
    `${heading("MADE FOR LITTLE EXPLORERS", "Welcome to Codi’s Cove.", "A local life-skills adventure inspired by the VTHacks 14 game outline.")}<p>Practice saving, planning, and helping your community in a world where it’s safe to try again.</p><p><strong>This is a practice world.</strong> All coins are pretend. Nessie can record your practice deposits in a sandbox account, and the classroom board can load and update assignments in Notion once configured. Codi can use Gemini for general questions and game help when configured, with a clearly labeled built-in guide available. Check Connected services in Settings for setup and sync status.</p><p class="note">Built with JavaScript, Three.js, HTML, CSS, browser storage, and Web Audio. Your explorer profile name stays local. In Gemini mode, submitted messages, recent conversation, and game progress are sent to Google through the local server. Configured services exchange sandbox savings events and classroom assignment records through the local server. Full setup and architecture notes are included with the project.</p><button class="primary-btn" id="about-close">Back to the island <span>↗</span></button>`,
    "about",
  );
  $("about-close").onclick = close;
}
function codi() {
  open(
    `<div class="guide-header"><img src="./assets/codi-portrait.png" alt="Codi, a smiling mint-colored robot"><div>${heading("YOUR CURIOUS COMPANION", "What’s on your mind?")}</div></div><div class="codi-toolbar"><span class="service-tag" id="codi-mode" role="status"></span><button class="text-button" id="new-chat">New conversation</button></div><div class="chat-log" id="chat-log" aria-live="polite" aria-label="Conversation with Codi"></div><div id="codi-error" class="feedback error" role="status" hidden></div><div class="codi-recovery" id="codi-recovery" hidden><button class="secondary-btn" id="retry-codi">Retry Gemini</button><button class="text-button" id="local-codi">Use island guide</button></div><form class="chat-form" id="chat-form"><label class="visually-hidden" for="chat-input">Ask Codi anything</label><textarea id="chat-input" rows="2" maxlength="2000" placeholder="Ask a question, share an idea, or get a little help…"></textarea><button id="send-codi" aria-label="Send question to Codi" type="submit">↑</button><button id="stop-codi" type="button" hidden>Stop</button></form><div class="chat-suggestions"><button data-prompt="What should I try next on the island?">What’s next?</button><button data-prompt="Explain how rainbows form with a simple example.">Explain something</button><button data-prompt="Help me brainstorm a fun game idea.">Brainstorm with me</button></div><p class="note" id="codi-privacy"></p><button class="text-button" id="codi-setup">Connection setup</button>`,
    "codi",
  );
  renderChat();
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    sendChat($("chat-input").value);
  };
  $("chat-input").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat(e.target.value);
    }
  };
  document
    .querySelectorAll("[data-prompt]")
    .forEach((b) => (b.onclick = () => sendChat(b.dataset.prompt)));
  $("new-chat").onclick = () => {
    codiChat.reset();
    $("chat-input").value = "";
    $("chat-input").focus();
  };
  $("stop-codi").onclick = () => codiChat.stop();
  $("retry-codi").onclick = () => codiChat.retry();
  $("local-codi").onclick = () => codiChat.useGuide();
  $("codi-setup").onclick = connections;
}
function renderChat() {
  const log = $("chat-log");
  if (!log || currentScreen !== "codi") return;
  const chat = codiChat.snapshot();
  const configured = services.snapshot().gemini?.configured === true;
  $("codi-mode").textContent = chat.pending
    ? "Codi is thinking…"
    : !configured
      ? "Built-in guide · Gemini needs setup"
      : chat.lastProvider === "error"
        ? "Gemini unavailable"
        : chat.lastProvider === "gemini"
          ? "Gemini connected"
          : chat.lastProvider === "local"
            ? "Last reply: built-in guide"
            : "Gemini ready";
  log.setAttribute("aria-busy", String(chat.pending));
  log.innerHTML = chat.messages.length
    ? chat.messages
        .map(
          (m) =>
            `<div class="chat-bubble ${m.role === "user" ? "user" : ""}">${m.source ? `<span class="chat-source">Codi · ${escapeHTML(m.source)}</span>` : ""}<div>${escapeHTML(m.text)}</div>${m.truncated ? '<small class="chat-source">Reply shortened. Ask Codi to continue.</small>' : ""}</div>`,
        )
        .join("")
    : `<div class="chat-bubble">Hi, ${escapeHTML(state.name)}! I’m Codi. We can explore an idea, learn something new, or figure out your next step together.</div>`;
  if (chat.pending)
    log.innerHTML +=
      '<div class="chat-bubble codi-thinking">Thinking it through…</div>';
  log.scrollTop = log.scrollHeight;
  $("codi-error").hidden = !chat.error;
  $("codi-error").textContent = chat.error;
  $("codi-recovery").hidden = !chat.canRetry;
  $("send-codi").hidden = chat.pending;
  $("stop-codi").hidden = !chat.pending;
  const wasPending = $("chat-input").disabled;
  $("chat-input").disabled = chat.pending;
  if (wasPending && !chat.pending && document.activeElement === document.body)
    $("chat-input").focus();
  document
    .querySelectorAll("[data-prompt]")
    .forEach((b) => (b.disabled = chat.pending));
  $("codi-privacy").textContent = configured
    ? "Gemini mode sends your messages, recent chat, and game progress to Google. This game keeps history only for this page session. AI answers can be mistaken."
    : "Built-in mode stays in this browser and helps with island topics. Add a Gemini key in Connection setup for general questions.";
}
function sendChat(text) {
  if (codiChat.snapshot().pending || !text.trim()) return;
  $("chat-input").value = "";
  void codiChat.send(text);
}
function visit(id) {
  if (id === "codi") {
    codi();
    return;
  }
  if (!QUESTS.some((q) => q.id === id)) return;
  if (!world) {
    if (id === "bank") bank();
    else if (id === "classroom") classroom();
    else garden();
    return;
  }
  trackedQuest = id;
  close();
  renderHUD();
  showWorldMessage(
    `Tracking ${QUESTS.find((q) => q.id === id).location}. Follow the gold marker, then press E near the object.`,
  );
}
function bank() {
  const done = state.completed.includes("bank");
  const amount = Math.min(40, state.coins);
  open(
    `${heading("MONEY SMARTS · CAPITALTWO BANK", "Make a little room for later.", done ? "Welcome back, smart saver. Keep building your bike fund, or practice your choices again." : "Your first goal: put 40 coins aside for a bike, while keeping some for today.")}<div class="balance-row"><div class="balance-card"><span>In your pocket</span><strong id="bank-pocket">${state.coins}</strong><em>coins</em></div><div class="balance-card"><span>Your bike fund</span><strong id="bank-savings">${state.savings}</strong><em>of 80 coins</em></div></div><div class="progress-line" aria-label="Bike fund progress"><span style="width:${Math.min(100, (state.savings / 80) * 100)}%"></span></div><label class="range-label" for="save-amount">Choose how much to save <span><output id="amount-output">${amount}</output> coins</span></label><input type="range" id="save-amount" min="0" max="${state.coins}" step="1" value="${amount}" ${state.coins === 0 ? "disabled" : ""}><div class="amount-presets">${[10, 20, 40].map((v) => `<button data-amount="${v}" ${v > state.coins ? "disabled" : ""} class="${v === amount ? "selected" : ""}">${v} coins</button>`).join("")}</div><div class="dialog-actions"><button class="primary-btn" id="save-coins" ${amount === 0 ? "disabled" : ""}>Move to savings <span>↗</span></button><button class="secondary-btn" id="bank-next" ${state.bankDeposited ? "" : "disabled"}>${done ? "Practice choices" : "Try a smart choice"}</button></div><div id="bank-feedback" role="status" aria-live="polite">${state.bankDeposited ? `<p class="feedback">${state.savings >= 80 ? "Bike fund filled! You made room for a bigger goal." : "You’ve taken your first saving step. Ready to practice a smart choice?"}</p>` : ""}</div>${state.savings > 0 ? '<button class="text-button" id="withdraw">Move 10 coins back to my pocket</button>' : ""}<p class="note">Practice money only. Moving coins between your pocket and savings keeps the total the same.</p>`,
    "bank",
  );
  addTutorialEntry("bank", "Learn the banking app", "Practice the screens behind saving and checking your account.");
  function updateAmount(v) {
    $("save-amount").value = v;
    $("amount-output").textContent = v;
    $("save-coins").disabled = Number(v) === 0;
    document
      .querySelectorAll("[data-amount]")
      .forEach((b) =>
        b.classList.toggle("selected", Number(b.dataset.amount) === Number(v)),
      );
  }
  $("save-amount").oninput = (e) => updateAmount(e.target.value);
  document
    .querySelectorAll("[data-amount]")
    .forEach((b) => (b.onclick = () => updateAmount(b.dataset.amount)));
  $("save-coins").onclick = () => {
    const value = Number($("save-amount").value);
    try {
      deposit(state, value);
      if (save()) services.recordDeposit(value);
      bank();
      tone();
      $("bank-feedback").innerHTML =
        `<p class="feedback">${value} coins saved! ${state.bankDeposited ? "You’re ready to try a smart choice." : `Save ${40 - state.savings} more to finish your first step.`}</p>`;
    } catch (e) {
      $("bank-feedback").innerHTML =
        `<p class="feedback error">${escapeHTML(e.message)}</p>`;
    }
  };
  $("bank-next").onclick = bankQuiz;
  const withdraw = $("withdraw");
  if (withdraw)
    withdraw.onclick = () => {
      const value = Math.min(10, state.savings);
      state.savings -= value;
      state.coins += value;
      save();
      bank();
      toast(`${value} coins moved back to your pocket.`);
    };
}
function bankQuiz() {
  open(
    `${heading("SMART CHOICE · NEEDS & WANTS", "A little choice, a big difference.", "Your bike helmet is broken. You also spotted some very cool stickers. What would you spend your coins on first?")}<div class="quiz-options"><button class="quiz-option" data-answer="stickers"><span>✧</span> The stickers — they would look amazing!</button><button class="quiz-option" data-answer="helmet"><span>◈</span> A safe helmet — then save up for stickers.</button><button class="quiz-option" data-answer="nothing"><span>○</span> Nothing — I should never spend my savings.</button></div><div id="quiz-feedback" role="status" aria-live="polite"></div><div class="dialog-actions"><button class="primary-btn" id="bank-finish" hidden>Collect my badge <span>✦</span></button></div>`,
    "bank-quiz",
  );
  document.querySelectorAll("[data-answer]").forEach(
    (b) =>
      (b.onclick = () => {
        const correct = b.dataset.answer === "helmet";
        document
          .querySelectorAll("[data-answer]")
          .forEach((x) => x.classList.remove("correct", "incorrect"));
        b.classList.add(correct ? "correct" : "incorrect");
        $("quiz-feedback").innerHTML =
          `<p class="feedback ${correct ? "" : "error"}">${correct ? "Exactly! A safe helmet is a need. Stickers are a want — something fun you can save for next." : b.dataset.answer === "stickers" ? "Stickers are fun, but protecting your head comes first. Which choice takes care of that need?" : "Saving gives you choices. It’s okay to spend on something you need, like staying safe. Try again!"}</p>`;
        $("bank-finish").hidden = !correct;
        if (correct) tone();
      }),
  );
  $("bank-finish").onclick = () => finish("bank");
}
const TASKS = {
  snack: {
    icon: "◉",
    title: "Have a snack",
    detail: "First, fuel up after school.",
  },
  homework: {
    icon: "▤",
    title: "Finish your homework",
    detail: "Due tomorrow — do it while you have energy.",
  },
  pack: {
    icon: "♧",
    title: "Pack your finished homework",
    detail: "Get your bag ready for tomorrow.",
  },
  play: {
    icon: "✧",
    title: "Head outside to play",
    detail: "Relax with everything taken care of.",
  },
};
function classroom() {
  open(
    `${heading("EVERYDAY SUPERPOWERS · NOTION CLASSROOM", "Make space for a good afternoon.", "You’re hungry after school. Homework is due tomorrow, and your bag needs to be packed before playtime. Put your afternoon in a helpful order.")}<div class="planner-labels"><span>AFTER SCHOOL</span><span>4 LITTLE STEPS</span><span>YOUR OWN PLAN</span></div><div class="task-list" id="task-list"></div><div id="planner-feedback" role="status" aria-live="polite"></div><div class="dialog-actions"><button class="primary-btn" id="check-plan">Try my plan <span>↗</span></button></div><p class="note">Use the up and down buttons to change the order. Little plans make room for big fun.</p>`,
    "classroom",
  );
  addTutorialEntry("classroom", "Try a Notion-style workspace", "Turn a task into a page, a checklist, and a useful plan.");
  renderTasks();
  $("check-plan").onclick = () => {
    if (validPlan(state.plannerOrder)) {
      $("planner-feedback").innerHTML =
        '<p class="feedback">That works! Fuel up, finish what’s due, pack it away, and enjoy your free time. You made space for all four.</p>';
      $("check-plan").innerHTML = "Collect my badge <span>✦</span>";
      $("check-plan").onclick = () => finish("classroom");
      tone();
    } else {
      $("planner-feedback").innerHTML =
        '<p class="feedback error">Try starting with a snack. Then finish your homework before packing it, and save playtime for the end.</p>';
    }
  };
}
function renderTasks() {
  const list = $("task-list");
  list.innerHTML = state.plannerOrder
    .map(
      (id, i) =>
        `<div class="task-row"><span class="task-number">${i + 1}</span><span><strong>${TASKS[id].title}</strong><small class="task-detail">${TASKS[id].detail}</small></span><button data-task="${id}" data-direction="-1" aria-label="Move ${TASKS[id].title.toLowerCase()} up" ${i === 0 ? "disabled" : ""}>↑</button><button data-task="${id}" data-direction="1" aria-label="Move ${TASKS[id].title.toLowerCase()} down" ${i === 3 ? "disabled" : ""}>↓</button></div>`,
    )
    .join("");
  list.querySelectorAll("[data-task]").forEach(
    (b) =>
      (b.onclick = () => {
        const i = state.plannerOrder.indexOf(b.dataset.task),
          j = i + Number(b.dataset.direction);
        if (j < 0 || j > 3) return;
        [state.plannerOrder[i], state.plannerOrder[j]] = [
          state.plannerOrder[j],
          state.plannerOrder[i],
        ];
        save();
        classroom();
        const selector = `[data-task="${b.dataset.task}"][data-direction="${b.dataset.direction}"]`;
        const moved = document.querySelector(selector);
        if (moved && !moved.disabled) moved.focus();
        else
          document
            .querySelector(`[data-task="${b.dataset.task}"]:not(:disabled)`)
            ?.focus();
      }),
  );
}
const GARDEN_STEPS = [
  {
    title: "Give a little seed a good start.",
    intro:
      "Your neighbors are growing vegetables to share. Where should we plant our first seed?",
    answers: [
      "A sunny garden bed with good soil",
      "Inside a dark cupboard",
      "On the stone path",
    ],
    correct: 0,
    tip: "Good soil and sunlight give the seed what it needs to grow.",
    hint: "Think about where a seed can get sunlight and room for its roots.",
    icon: "✦",
  },
  {
    title: "A little care goes a long way.",
    intro:
      "Our seed is tucked into its new home. The soil feels dry. What would help?",
    answers: [
      "Leave it dry for the whole week",
      "Give it a gentle drink of water",
      "Fill the bed until the plant floats",
    ],
    correct: 1,
    tip: "Just right! A gentle drink moistens the soil without flooding the roots.",
    hint: "Roots need moisture, but too much water can hurt them. Look for the gentle choice.",
    icon: "♧",
  },
  {
    title: "Good things are better together.",
    intro:
      "The garden has grown! There are more vegetables than you need. What could you do?",
    answers: [
      "Leave all the extras to go bad",
      "Keep them all, just in case",
      "Share some with a neighbor",
    ],
    correct: 2,
    tip: "Sharing turns your little garden into something that helps the whole community.",
    hint: "You have enough for yourself. How could your extra vegetables help someone else?",
    icon: "♡",
  },
];
function garden(step = state.gardenStep, practice = false) {
  if (step >= 3) {
    open(
      `${heading("KINDNESS IN ACTION · KINDNESS GARDEN", "Look what a little care can do.", "You planted, watered, and shared. The garden — and your community — is a little brighter.")}<div class="garden-stages"><div class="garden-stage complete"><span>✦</span><small>PLANT</small></div><div class="garden-stage complete"><span>♧</span><small>CARE</small></div><div class="garden-stage complete"><span>♡</span><small>SHARE</small></div></div><button class="primary-btn" id="garden-finish">${state.completed.includes("garden") ? "See my grower badge" : "Collect my badge"} <span>✦</span></button><button class="text-button" id="garden-replay">Practice growing again</button>`,
      "garden",
    );
    $("garden-finish").onclick = () => finish("garden");
    $("garden-replay").onclick = () => garden(0, true);
    return;
  }
  const s = GARDEN_STEPS[step];
  open(
    `${heading("KINDNESS IN ACTION · KINDNESS GARDEN", s.title, s.intro)}<div class="garden-stages">${["PLANT", "CARE", "SHARE"].map((label, i) => `<div class="garden-stage ${i < step ? "complete" : i === step ? "current" : ""}"><span>${["✦", "♧", "♡"][i]}</span><small>${label}</small></div>`).join("")}</div><div class="quiz-options">${s.answers.map((a, i) => `<button class="quiz-option" data-garden-answer="${i}"><span>${["A", "B", "C"][i]}</span>${a}</button>`).join("")}</div><div id="garden-feedback" role="status" aria-live="polite"></div><div class="dialog-actions"><button class="primary-btn" id="garden-next" hidden>${step === 2 ? "See what grew" : "Keep growing"} <span>↗</span></button></div>`,
    "garden",
  );
  document.querySelectorAll("[data-garden-answer]").forEach(
    (b) =>
      (b.onclick = () => {
        const correct = Number(b.dataset.gardenAnswer) === s.correct;
        document
          .querySelectorAll("[data-garden-answer]")
          .forEach((x) => x.classList.remove("correct", "incorrect"));
        b.classList.add(correct ? "correct" : "incorrect");
        $("garden-feedback").innerHTML =
          `<p class="feedback ${correct ? "" : "error"}">${correct ? s.tip : s.hint}</p>`;
        $("garden-next").hidden = !correct;
        if (correct) tone();
      }),
  );
  $("garden-next").onclick = () => {
    if (!practice) {
      state.gardenStep = step + 1;
      save();
    }
    garden(step + 1, practice);
  };
}
function finish(id) {
  let earned;
  try {
    earned = completeQuest(state, id);
  } catch (e) {
    toast(e.message);
    return;
  }
  save();
  const q = QUESTS.find((q) => q.id === id);
  const allDone = state.completed.length === 3;
  open(
    `<div class="success-view"><div class="achievement-icon">${q.icon}</div>${heading(earned ? "A LITTLE WIN WORTH CELEBRATING" : "A SKILL THAT STAYS WITH YOU", `You’re a ${q.badge.toLowerCase()}!`, allDone ? "All three adventures, all three superpowers. Keep your curiosity — it’s the best thing in your backpack." : id === "bank" ? "You made space for a bigger goal and learned how to put needs first." : id === "classroom" ? "You turned a busy afternoon into a plan with room to play." : "You helped something grow and made your community a little brighter.")}<div class="reward-pills"><span>${earned ? "+50 XP" : "Badge earned ✓"}</span><span>${earned ? "+20 coins" : q.badge}</span></div><button class="primary-btn" id="next-adventure">${allDone ? "See all my badges" : "On to the next adventure"} <span>↗</span></button><button class="text-button" id="success-island">Wander a little first</button></div>`,
    "success",
  );
  $("next-adventure").onclick = () =>
    allDone
      ? backpack()
      : visit(QUESTS.find((q) => !state.completed.includes(q.id)).id);
  $("success-island").onclick = close;
  if (earned) {
    tone(true);
    celebrate();
    $("codi-tip").textContent = allDone
      ? "Look at you! Three new skills. One very proud Codi."
      : `A ${q.badge.toLowerCase()}! I knew you had it in you.`;
  }
}
function celebrate() {
  if (
    state.reducedMotion ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 32; i++) {
    const bit = document.createElement("i");
    bit.style.cssText = `left:${10 + Math.random() * 80}%;background:${["#d6b660", "#a0bc7d", "#dba393", "#a9bfd3"][i % 4]};animation-delay:${Math.random() * 0.3}s;--drift:${(Math.random() - 0.5) * 160}px;`;
    layer.appendChild(bit);
  }
  dialog.appendChild(layer);
  setTimeout(() => layer.remove(), 2200);
}
const actions = {
  explore: close,
  journal,
  backpack,
  settings,
  profile,
  map,
  codi,
  guides: appGuides,
};
document
  .querySelectorAll("[data-action]")
  .forEach((b) => (b.onclick = () => actions[b.dataset.action]?.()));
$("start-quest").onclick = journal;
$("collapse-quest").onclick = () => {
  const collapsed = document
    .querySelector(".quest-panel")
    .classList.toggle("collapsed");
  $("collapse-quest").textContent = collapsed ? "+" : "−";
  $("collapse-quest").setAttribute("aria-expanded", String(!collapsed));
  $("collapse-quest").setAttribute(
    "aria-label",
    collapsed ? "Expand quest tracker" : "Collapse quest tracker",
  );
};
$("interact-btn").onclick = () => world?.visitNearest();
$("sound-toggle").onclick = () => {
  state.sound = !state.sound;
  save();
  tone();
  toast(
    state.sound
      ? "A little sound, a little more joy."
      : "Sound off. Enjoy the quiet.",
  );
};
$("codi-avatar").innerHTML =
  '<img src="./assets/codi-portrait.png" alt="Codi">';
window.addEventListener("keydown", (e) => {
  if (
    dialog.open ||
    ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  )
    return;
  const action = { m: map, 1: journal, 2: backpack, c: codi, t: appGuides }[
    e.key.toLowerCase()
  ];
  if (action) {
    e.preventDefault();
    action();
  }
});
try {
  world = createWorld({
    container: $("world"),
    onVisit: visit,
    onAction: handleWorldAction,
    onMessage: showWorldMessage,
    onNear: (p) => {
      $("interact-btn").hidden = !p;
      if (p) {
        $("interact-btn").querySelector("span").textContent = p.label;
        $("interact-place").textContent = p.name;
      }
    },
    getPaused: () => dialog.open,
    getReducedMotion: () =>
      state.reducedMotion ||
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  world.updateProgress(state);
} catch (error) {
  console.error(error);
  $("world-loading").innerHTML =
    '<div class="fallback-world"><h2>The island is taking a little rest.</h2><p>This browser couldn’t open the 3D world. Your adventures are still ready to play.</p><button id="fallback-play" class="primary-btn">Open adventures <span>↗</span></button></div>';
  $("fallback-play").onclick = journal;
}
save();
void services.refresh();
// Page-scoped agent affordances share the visible UI, with validated inputs.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const definitions = [
    {
      name: "read_cove_progress",
      title: "Read island progress",
      description:
        "Read the local explorer level, coins, savings, and completed adventures without changing them.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        if (input && Object.keys(input).length)
          throw new Error("No inputs expected.");
        return {
          name: state.name,
          level: getLevel(state.xp),
          coins: state.coins,
          savings: state.savings,
          xp: state.xp,
          completed: [...state.completed],
          objective: worldObjective(state, trackedQuest),
          position: world?.getPosition(),
          planStep: state.planStep,
          gardenStep: state.gardenStep,
          trailCoins: state.collectibles.length,
        };
      },
    },
    {
      name: "track_cove_adventure",
      title: "Track an adventure",
      description:
        "Track an adventure in the third-person world. The player must walk to its objects and interact nearby. Does not teleport, complete lessons, or award rewards.",
      inputSchema: {
        type: "object",
        properties: {
          place: { type: "string", enum: ["bank", "classroom", "garden"] },
        },
        required: ["place"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        if (
          !input ||
          Object.keys(input).some((k) => k !== "place") ||
          !QUESTS.some((q) => q.id === input.place)
        )
          throw new Error("Choose bank, classroom, or garden.");
        visit(input.place);
        return { tracked: input.place };
      },
    },
  ];
  for (const tool of definitions) {
    try {
      Promise.resolve(
        document.modelContext.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Unsupported implementations are optional. */
    }
  }
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
