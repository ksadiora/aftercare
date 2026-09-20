export const STORAGE_KEY = "codis-cove-save-v1";
export const QUESTS = [
  {
    id: "bank",
    name: "A little saved. A lot possible.",
    short: "A little saved.<br>A lot possible.",
    category: "MONEY SMARTS",
    description:
      "Big dreams start with small steps. Let’s save up for something good.",
    location: "CapitalTwo Bank",
    skill: "Saving & smart choices",
    icon: "◈",
    badge: "Smart saver",
    xp: 50,
    coins: 20,
  },
  {
    id: "classroom",
    name: "Make room for what matters.",
    short: "Make room for<br>what matters.",
    category: "EVERYDAY SUPERPOWERS",
    description:
      "A little planning leaves more time for the things you love. Find your rhythm.",
    location: "Notion Classroom",
    skill: "Planning & priorities",
    icon: "▤",
    badge: "Day designer",
    xp: 50,
    coins: 20,
  },
  {
    id: "garden",
    name: "Small acts. Big difference.",
    short: "Small acts.<br>Big difference.",
    category: "KINDNESS IN ACTION",
    description:
      "A good community grows together. Help bring our little garden to life.",
    location: "Kindness Garden",
    skill: "Care & community",
    icon: "♧",
    badge: "Community grower",
    xp: 50,
    coins: 20,
  },
];
export function freshState() {
  return {
    version: 1,
    name: "Jamie",
    coins: 120,
    savings: 0,
    xp: 0,
    completed: [],
    bankDeposited: false,
    gardenStep: 0,
    plannerOrder: ["play", "homework", "pack", "snack"],
    sound: false,
    reducedMotion: false,
    planStep: 0,
    hasWateringCan: false,
    collectibles: [],
  };
}
export function sanitizeState(value) {
  const s = freshState();
  if (!value || value.version !== 1) return s;
  if (typeof value.name === "string" && value.name.trim())
    s.name = value.name.trim().slice(0, 20);
  for (const key of ["coins", "savings", "xp"])
    if (
      Number.isSafeInteger(value[key]) &&
      value[key] >= 0 &&
      value[key] <= 100000
    )
      s[key] = value[key];
  s.completed = Array.isArray(value.completed)
    ? [
        ...new Set(
          value.completed.filter((id) => QUESTS.some((q) => q.id === id)),
        ),
      ]
    : [];
  s.bankDeposited = !!value.bankDeposited;
  s.gardenStep = Number.isInteger(value.gardenStep)
    ? Math.max(0, Math.min(3, value.gardenStep))
    : 0;
  if (
    Array.isArray(value.plannerOrder) &&
    value.plannerOrder.length === 4 &&
    new Set(value.plannerOrder).size === 4 &&
    value.plannerOrder.every((x) => s.plannerOrder.includes(x))
  )
    s.plannerOrder = [...value.plannerOrder];
  s.sound = !!value.sound;
  s.reducedMotion = !!value.reducedMotion;
  s.planStep = s.completed.includes("classroom")
    ? 4
    : Number.isInteger(value.planStep)
      ? Math.max(0, Math.min(3, value.planStep))
      : 0;
  s.hasWateringCan = !!value.hasWateringCan;
  s.collectibles = Array.isArray(value.collectibles)
    ? [
        ...new Set(
          value.collectibles.filter((id) =>
            ["star-0", "star-1", "star-2"].includes(id),
          ),
        ),
      ]
    : [];
  return s;
}
export function deposit(state, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > state.coins)
    throw new Error("Choose an amount you have in your pocket.");
  state.coins -= amount;
  state.savings += amount;
  if (state.savings >= 40) state.bankDeposited = true;
  return state;
}
export function completeQuest(state, id) {
  const q = QUESTS.find((q) => q.id === id);
  if (!q) throw new Error("Unknown adventure.");
  if (state.completed.includes(id)) return false;
  if (id === "bank" && !state.bankDeposited)
    throw new Error("Save 40 coins first.");
  if (id === "garden" && state.gardenStep !== 3)
    throw new Error("Finish caring for the garden first.");
  if (id === "classroom" && !validPlan(state.plannerOrder))
    throw new Error("Check your plan first.");
  state.completed.push(id);
  state.xp += q.xp;
  state.coins += q.coins;
  return true;
}
export function validPlan(order) {
  return (
    Array.isArray(order) &&
    order.length === 4 &&
    order.join(",") === "snack,homework,pack,play"
  );
}
export function getLevel(xp) {
  return Math.min(3, Math.floor(xp / 50) + 1);
}
export function guideReply(text, state) {
  const input = text.toLowerCase();
  if (
    /nessie|\bapi\b|\bai\b|real money|bank account|connect.*notion/.test(input)
  )
    return "Cove coins are pretend. Nessie can record savings in a sandbox, and the Notion classroom board can show assignments. Open Connected services in Settings to check setup and sync status. This reply uses built-in tips. Gemini can power my general assistant when configured.";
  if (/sav|money|bank|coin|budget/.test(input))
    return `You have ${state.coins} coins in your pocket and ${state.savings} saved. ${state.bankDeposited ? "You’ve made your first saving step! Keep some coins for today and add to your bike fund when you can." : `At CapitalTwo Bank, put ${Math.max(0, 40 - state.savings)} more coins aside to finish your first savings step.`} Small steps add up!`;
  if (/plan|homework|class|notion|time|day/.test(input))
    return "Start with a snack so you have energy, do your homework, pack your bag, then enjoy playtime. Visit the four stations in front of Notion Classroom in that order. Press E when you are close to each one.";
  if (/garden|plant|water|kind|help someone|community/.test(input))
    return "Visit Kindness Garden: choose a sunny spot, give the seed a gentle drink, and share the harvest. Plants and people both grow with a little care.";
  if (/control|move|walk|play|how/.test(input))
    return "Use WASD to move, Shift to sprint, and Space to jump. Drag to look around or press Q/R to turn the camera. Press E near an object to interact. On touch screens, use the arrows and jump button. M opens your map.";
  if (/next|quest|adventure|stuck|help/.test(input)) {
    const q = QUESTS.find((q) => !state.completed.includes(q.id));
    return q
      ? `Your next adventure is “${q.name}” at ${q.location}. Choose it in the journal to track its marker, then walk over and press E at the object.`
      : "You’ve earned every island badge! Revisit a place to practice, or look in your Backpack to see how far you’ve come.";
  }
  if (/hello|hi\b|hey|name/.test(input))
    return `Hi, ${state.name}! I’m Codi, your island guide. Ask me about saving, planning your day, growing the garden, or what to try next.`;
  return "I know a few things about this little island. Ask me about saving coins, planning your day, caring for the garden, or finding your next adventure.";
}

export function worldObjective(state, tracked) {
  const id = QUESTS.some((q) => q.id === tracked)
    ? tracked
    : QUESTS.find((q) => !state.completed.includes(q.id))?.id;
  if (id && state.completed.includes(id))
    return {
      quest: id,
      target: { bank: "bank", classroom: "plan-snack", garden: "garden" }[id],
      title: "A skill that stays with you.",
      detail: `${QUESTS.find((q) => q.id === id).badge} badge earned. Explore this place, or choose another adventure from the journal.`,
    };
  if (id === "bank")
    return state.bankDeposited
      ? {
          quest: id,
          target: "helmet",
          title: "Needs before wants",
          detail:
            "Walk to the helmet stand beside the bank. Press E to choose safety before stickers.",
        }
      : {
          quest: id,
          target: "bank",
          title: "A little saved. A lot possible.",
          detail: `Visit the bank terminal. Press E to save 20 coins at a time. ${Math.min(state.savings, 40)} / 40 saved.`,
        };
  if (id === "classroom") {
    const steps = ["snack", "homework", "pack", "play"];
    return {
      quest: id,
      target: `plan-${steps[Math.min(state.planStep, 3)]}`,
      title: "Build a better afternoon",
      detail: [
        "Visit the snack station in front of the classroom. Fuel up first!",
        "Walk to the homework station. Finish what is due tomorrow.",
        "Pack your finished homework at the backpack station.",
        "Everything is ready! Visit the play station to finish your plan.",
      ][Math.min(state.planStep, 3)],
    };
  }
  if (id === "garden") {
    const target =
      state.gardenStep === 3
        ? "share"
        : state.gardenStep === 1 && !state.hasWateringCan
          ? "watering-can"
          : "garden";
    return {
      quest: id,
      target,
      title: "Help the garden grow",
      detail: [
        "Walk to the garden bed. Press E to plant your first seed.",
        state.hasWateringCan
          ? "Return to the garden bed and press E to water the seedlings."
          : "Pick up the watering can beside the garden. Press E when you are close.",
        "The vegetables are ready! Return to the bed and press E to harvest.",
        "Bring your basket to Bea beside the garden. Press E to share.",
      ][state.gardenStep],
    };
  }
  return {
    quest: null,
    target: "codi",
    title: "The cove is lucky to have you.",
    detail:
      "All three skills earned! Explore, jump along the coin trail, or say hello to Codi.",
  };
}

// The browser controller also checks proximity. This reducer keeps rewards and steps consistent.
export function applyWorldAction(state, action) {
  const result = (message, changed = false, reward = null) => ({
    message,
    changed,
    reward,
  });
  if (/^star-[0-2]$/.test(action)) {
    if (state.collectibles.includes(action))
      return result("You already found this trail coin.");
    state.collectibles.push(action);
    state.coins += 5;
    return result(
      `Trail coin found! +5 coins · ${state.collectibles.length}/3 collected`,
      true,
    );
  }
  if (action === "bank") {
    if (state.completed.includes("bank"))
      return result(
        `Smart saver badge earned! You have ${state.savings} coins saved and ${state.coins} in your pocket.`,
      );
    if (state.bankDeposited)
      return result(
        `You have ${state.savings} saved. Choose the helmet at the stand beside the bank to put a need before a want.`,
      );
    const amount = Math.min(20, state.coins, Math.max(0, 40 - state.savings));
    if (amount <= 0)
      return result(
        "Find the gold coins on the stepping-stone trail to add to your pocket.",
      );
    deposit(state, amount);
    return result(
      `${amount} coins moved to savings! ${state.bankDeposited ? "Now choose a helmet before stickers at the nearby stands." : `${state.savings}/40 saved. Press E once more to reach your goal.`}`,
      true,
    );
  }
  if (action === "helmet") {
    if (!state.bankDeposited)
      return result(
        "First, save 40 coins at the bank terminal. Then choose a useful item here.",
      );
    const reward = completeQuest(state, "bank");
    return result(
      reward
        ? "Smart saver! A helmet is a need; stickers can wait. +50 XP · +20 coins"
        : "A safe helmet still comes first. Smart saver badge already earned.",
      reward,
      reward ? "bank" : null,
    );
  }
  if (action === "stickers")
    return result(
      "Stickers are a fun want. A safe helmet is a need. Try the helmet stand first!",
    );
  if (action.startsWith("plan-")) {
    const steps = ["snack", "homework", "pack", "play"],
      selected = action.slice(5);
    if (!steps.includes(selected)) throw new Error("Unknown planning station.");
    if (state.completed.includes("classroom"))
      return result(
        "Your afternoon is planned: snack, homework, pack, then play. Day designer badge earned!",
      );
    if (selected !== steps[state.planStep])
      return result(
        `A helpful order leaves room for fun. Next, visit the ${steps[state.planStep]} station.`,
      );
    state.planStep++;
    if (state.planStep === 4) {
      state.plannerOrder = [...steps];
      const reward = completeQuest(state, "classroom");
      return result(
        "Day designer! You made room for responsibilities AND fun. +50 XP · +20 coins",
        true,
        reward ? "classroom" : null,
      );
    }
    return result(
      [
        "You fueled up! Next: finish your homework.",
        "Homework finished! Next: pack it in your bag.",
        "Bag packed! Now head over to the play station.",
      ][state.planStep - 1],
      true,
    );
  }
  if (action === "watering-can") {
    if (state.hasWateringCan)
      return result("You have the watering can. Take it to the garden bed.");
    state.hasWateringCan = true;
    return result("Watering can equipped! Take it to the garden bed.", true);
  }
  if (action === "garden") {
    if (state.completed.includes("garden"))
      return result(
        "Look what you grew! Your neighbors are enjoying the harvest.",
      );
    if (state.gardenStep === 0) {
      state.gardenStep = 1;
      return result(
        "Seeds planted! Pick up the watering can beside the garden.",
        true,
      );
    }
    if (state.gardenStep === 1) {
      if (!state.hasWateringCan)
        return result(
          "Your seedlings need a gentle drink. Pick up the watering can first.",
        );
      state.gardenStep = 2;
      return result(
        "A gentle drink — just right! Your vegetables have grown. Press E to harvest.",
        true,
      );
    }
    if (state.gardenStep === 2) {
      state.gardenStep = 3;
      return result(
        "Harvest collected! Bring your basket to Bea nearby and share.",
        true,
      );
    }
    return result(
      "Your basket is ready. Walk over to Bea and share the harvest.",
    );
  }
  if (action === "share") {
    if (state.gardenStep !== 3)
      return result(
        "Hi, I’m Bea! Plant, water, and harvest a little something in our garden. Then we can share it.",
      );
    const reward = completeQuest(state, "garden");
    return result(
      reward
        ? "Community grower! You shared the harvest with Bea. +50 XP · +20 coins"
        : "Thanks again for sharing. You helped our little community grow!",
      reward,
      reward ? "garden" : null,
    );
  }
  throw new Error("Unknown island interaction.");
}
