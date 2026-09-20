# Codi’s Cove: project explanation and pitch draft

Prepared for the hackathon handoff, September 19, 2026. This describes the current local prototype. The personal connection reflects the team’s account of growing up without instruction in practical financial and organization tools, and learning through Prodigy.

## What we made

Codi’s Cove is a third-person 3D browser game where players practice everyday skills through short adventures. Players walk around a pastel island, interact with objects, and earn skill badges. CapitalTwo Bank introduces saving and choosing a need before a want. Notion Classroom turns an afternoon routine into an ordered plan. Kindness Garden asks players to care for a plant and share the harvest.

The game also teaches the interfaces behind those skills. A banking tutorial lets players explore accounts, review a pretend transfer, and read an activity receipt. A Notion-style tutorial introduces a workspace, a task table, a task page, and a checklist. These are interactive practice recreations. They are not screenshots of someone’s account.

Codi, the island’s companion, uses Gemini to answer general questions and give game-aware hints. The server can record new savings events in a Nessie sandbox account. The Notion adapter can read classroom assignments and update their Done checkboxes once a workspace is configured.

## Why we made it

Knowing the name of a skill is different from recognizing what to do on a screen. “Save money” becomes more concrete when someone chooses an account, checks an amount, and reviews a receipt. “Get organized” becomes more concrete when someone opens a task, breaks it into steps, and records what is finished.

Our design hypothesis is that a familiar game format can make that first practice session more inviting. The island gives each action a purpose. The tutorials connect that action to a recognizable interface. Codi gives players a place to ask questions without leaving the game. We have built and tested the prototype’s behavior, but we have not yet measured learning outcomes.

Notion matters here because it makes a plan visible and revisitable. A task can hold instructions, a date can indicate when it matters, and a completion field can communicate progress. The transferable skill is keeping useful information outside your memory and making shared work understandable. Notion is the concrete tool we chose to teach that habit. Its databases organize items as pages with properties, which matches this lesson well. [Notion’s database guide](https://www.notion.com/help/intro-to-databases)

## Personal connection: our story

Draft wording based on the experience the team shared:

> We were all kids once, and we weren’t taught how to use real-world tools for financial planning and general organization. We also grew up playing Prodigy, and it actually helped us learn. That experience stayed with us: a game could be something we wanted to play and something that taught us at the same time. We made Codi’s Cove because we wanted to bring that feeling to the everyday skills we missed. We want players to practice saving toward a goal, organizing a task, and understanding the tools behind those actions, with Codi there when they have a question.

This is the team’s own account, not a claim that Prodigy’s results generalize to every learner. Prodigy inspired the learning-through-play approach. Codi’s Cove is an independent project.

## 30-second explanation

> Codi’s Cove is a 3D browser game for practicing everyday skills. Players save for a goal, plan an afternoon, and help a neighbor in a pastel island world. Guided tutorials then show how those ideas appear in banking apps and Notion. Codi uses Gemini to answer questions, and new savings events can sync to Nessie’s banking sandbox. We want people to understand both the action and the reason behind it, with room to practice before using unfamiliar tools.

## Three-minute presentation script

**Opening: what and why, about 35 seconds**

> Growing up, we weren’t taught how to use practical tools for financial planning and organization. But we did play Prodigy, and that game helped us learn. We wanted to bring that feeling to the everyday skills we missed. Codi’s Cove is our answer: a browser adventure where players practice those skills and see how they connect to tools they may use outside the game.

**The player experience, about 40 seconds**

> You explore the island in third person. At CapitalTwo Bank, you save toward a goal and choose a safety helmet before stickers. At Notion Classroom, you build an afternoon routine. At Kindness Garden, you grow something and share it with a neighbor. Each activity gives players a small, understandable goal and feedback as they work toward it.

**The bridge to real interfaces, about 45 seconds**

> The app guides connect those activities to screens people recognize. In the banking guide, you find savings, choose a pretend amount, review the destination, and read the receipt. In the Notion guide, you open a classroom page, open a task, complete its checklist, and mark it done. The point of Notion is that your plan has a home: you can return to the instructions and show others what is finished. Tutorial actions stay inside the practice lesson.

**Codi and the stack, about 35 seconds**

> Codi is a Gemini-powered general assistant who also understands the current game objective. The island uses Three.js with JavaScript, HTML, and CSS. A small Node server keeps credentials out of the browser and connects the external services. Gemini has returned live answers, and Nessie has confirmed a sandbox deposit. The Notion connector is implemented and still needs a workspace connection in this checkout.

**Close and next step, about 25 seconds**

> Our next step is to integrate this experience into the larger hackathon project. We can keep the game as its own page first, then connect shared identity and progress when that architecture is ready. We want the result to help someone recognize what to do next and explain why the action matters. Testing that learning goal is the next step after this prototype.

## Suggested live demo: 90 seconds

| Time | Show | Say |
| --- | --- | --- |
| 0–15 sec | Walk and jump near the bank | “The player explores and interacts directly with the world.” |
| 15–40 sec | Press T, open the banking guide, advance through review and receipt | “These are pretend tutorial coins. The guide teaches what to check before confirming.” |
| 40–65 sec | Close the banking guide, reopen App guides, then open the Notion task page and checklist | “The same planning skill now appears in a workspace and task list.” |
| 65–85 sec | Close the Notion guide, press C, and ask “Why should I review a transfer before confirming it? Give me two short sentences.” | “Codi can explain the reason behind an action.” |
| 85–90 sec | Return to the island | “The game, interface practice, and assistant are part of the same experience.” |

Rehearse the timing. If Gemini is slow, continue explaining and return to the answer. If a provider is unavailable, use the clearly labeled local guide and describe the connection status honestly. The normal world bank action queues a real **sandbox** deposit; the app tutorial does not. Avoid repeatedly using the terminal just to replay the pitch.

## What works now, and what comes next

| Area | Current state |
| --- | --- |
| 3D exploration and quests | Implemented, with keyboard/touch controls and local saves |
| Banking and Notion interface practice | Implemented; independent of live service credentials |
| Gemini | Live responses verified in this local checkout |
| Nessie | Dedicated synthetic account connected; one 20-coin deposit confirmed |
| Notion | Read/update adapter implemented and tested with fixtures; live workspace unconfigured |
| Integration into the other project | Guide prepared; merge or embedding not performed yet |
| Hosting, accounts, multiplayer | Future work |
| Learning outcomes | A design goal to evaluate, not a measured result |

The original concept explores teaching younger learners. The current local hackathon demonstration is for adults aged 18 and over. Any broader release requires a separate audience and provider review.

## Presenter questions

**Is this a Roblox game?** It is an independent browser game with Roblox-inspired movement and interactions. It does not run on Roblox and has no multiplayer yet.

**Does this move real money?** No. Nessie contains synthetic banking data. Game coins and the provider’s sandbox balance are separate. The UI reports what the provider actually returns.

**What is live about Notion?** The adapter supports actual workspace reads and checkbox updates when configured. This checkout currently demonstrates the practice tutorial; a live Notion workspace still needs connecting. The tutorial does not edit a real task.

**Can Codi complete the game or operate an account?** Codi returns advice. It cannot award coins, complete quests, execute banking actions, or change Notion assignments.

**Why an assistant instead of only fixed instructions?** Fixed lessons teach a consistent sequence. Codi gives players a place to ask their own follow-up questions and request a different explanation.

**How does this fit the other project?** Start with the separate game page described in [INTEGRATION.md](./INTEGRATION.md). A deeper merge needs a chosen API path, mount/unmount lifecycle, and an explicit plan for identity and progress.

## Technical reference

See [TECH_STACK.md](./TECH_STACK.md) for the architecture and [SERVICE_SETUP.md](./SERVICE_SETUP.md) for service configuration. The deck includes speaker notes with matching explanations and source references. Game screenshots depict this project’s own interface. Codi’s portrait is original generated artwork included with the project.
