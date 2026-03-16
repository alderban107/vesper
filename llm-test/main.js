import { CreateMLCEngine } from "@mlc-ai/web-llm";

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const statsEl = document.getElementById("stats");

let engine = null;

// --- Simulated local message store (stands in for FTS5 SQLite) ---
const MESSAGE_DB = [
  { id: 1, channel: "general", author: "alice", text: "hey everyone, standup in 10 minutes", ts: "2026-03-14T09:00:00Z" },
  { id: 2, channel: "general", author: "bob", text: "sounds good, i'll be there", ts: "2026-03-14T09:01:00Z" },
  { id: 3, channel: "engineering", author: "carol", text: "the postgres migration is done, all tests pass", ts: "2026-03-14T09:15:00Z" },
  { id: 4, channel: "engineering", author: "dave", text: "nice! what about the redis caching layer? are we going with redis or memcached?", ts: "2026-03-14T09:16:00Z" },
  { id: 5, channel: "engineering", author: "carol", text: "redis for sure, memcached doesn't support pub/sub which we need for invalidation", ts: "2026-03-14T09:17:00Z" },
  { id: 6, channel: "engineering", author: "alice", text: "agreed. carol can you have the redis PR up by end of day friday?", ts: "2026-03-14T09:18:00Z" },
  { id: 7, channel: "engineering", author: "carol", text: "yep, already halfway done. will also add the cache warming on startup", ts: "2026-03-14T09:19:00Z" },
  { id: 8, channel: "general", author: "dave", text: "who's handling the demo for the client on monday?", ts: "2026-03-14T10:00:00Z" },
  { id: 9, channel: "general", author: "bob", text: "i think alice volunteered last week", ts: "2026-03-14T10:01:00Z" },
  { id: 10, channel: "general", author: "alice", text: "yeah i'll do it. need the latest staging deploy though", ts: "2026-03-14T10:02:00Z" },
  { id: 11, channel: "design", author: "eve", text: "new mockups for the settings page are in figma, link: https://figma.com/file/abc123", ts: "2026-03-14T11:00:00Z" },
  { id: 12, channel: "design", author: "eve", text: "main changes: simplified the nav, moved notifications to its own tab", ts: "2026-03-14T11:01:00Z" },
  { id: 13, channel: "design", author: "bob", text: "looks clean, love the notification tab idea", ts: "2026-03-14T11:05:00Z" },
  { id: 14, channel: "engineering", author: "dave", text: "found a bug in the auth flow - refresh tokens aren't being rotated on mobile", ts: "2026-03-14T13:00:00Z" },
  { id: 15, channel: "engineering", author: "alice", text: "that's critical, can you file a ticket and tag it P0?", ts: "2026-03-14T13:01:00Z" },
  { id: 16, channel: "engineering", author: "dave", text: "done, ENG-452. i'll start on the fix now", ts: "2026-03-14T13:02:00Z" },
  { id: 17, channel: "general", author: "carol", text: "lunch anyone? thinking about that new ramen place", ts: "2026-03-14T12:00:00Z" },
  { id: 18, channel: "general", author: "eve", text: "yes! i've been wanting to try it", ts: "2026-03-14T12:01:00Z" },
  { id: 19, channel: "engineering", author: "bob", text: "reminder: we need to bump the node version to 22 before next release", ts: "2026-03-14T14:00:00Z" },
  { id: 20, channel: "engineering", author: "alice", text: "added to the release checklist. also need to update the CI pipeline", ts: "2026-03-14T14:01:00Z" },
];

// --- Tool implementations ---
function toolSearch(args) {
  const q = (args.query || "").toLowerCase();
  const results = MESSAGE_DB.filter((m) => m.text.toLowerCase().includes(q));
  if (results.length === 0) return JSON.stringify({ results: [], message: "No messages found." });
  return JSON.stringify({
    results: results.map((m) => ({
      channel: m.channel,
      author: m.author,
      time: m.ts.slice(11, 16),
      text: m.text,
    })),
  });
}

function toolChannelHistory(args) {
  const ch = (args.channel || "").toLowerCase().replace("#", "");
  let results = MESSAGE_DB.filter((m) => m.channel === ch);
  if (args.limit) results = results.slice(-args.limit);
  if (results.length === 0) return JSON.stringify({ results: [], message: `No messages in #${ch}.` });
  return JSON.stringify({
    channel: ch,
    results: results.map((m) => ({
      author: m.author,
      time: m.ts.slice(11, 16),
      text: m.text,
    })),
  });
}

function toolListChannels() {
  const channels = [...new Set(MESSAGE_DB.map((m) => m.channel))];
  return JSON.stringify({ channels });
}

const TOOL_HANDLERS = {
  search: toolSearch,
  channel_history: toolChannelHistory,
  list_channels: toolListChannels,
};

// --- OpenAI-style tool definitions ---
const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Search all messages across all channels for a keyword or phrase.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query to find in messages" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "channel_history",
      description: "Get recent messages from a specific channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name, e.g. 'engineering' or 'general'" },
          limit: { type: "number", description: "Max number of recent messages to return" },
        },
        required: ["channel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_channels",
      description: "List all available channels.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a private AI assistant inside Vesper, an encrypted messaging app.
You help users find information in their local message history.
All data stays on-device — nothing leaves the user's machine.
Use the provided tools to search and browse messages before answering.
Be concise and direct in your answers. Cite who said what when relevant.`;

function log(msg) {
  statusEl.textContent += msg + "\n";
  statusEl.scrollTop = statusEl.scrollHeight;
}

function addMessage(role, text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls || role}`;
  div.innerHTML = `<div class="label">${role}</div>`;
  const textSpan = document.createElement("span");
  textSpan.textContent = text;
  div.appendChild(textSpan);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { div, textSpan };
}

async function generate(userPrompt) {
  promptEl.disabled = true;
  sendBtn.disabled = true;

  addMessage("you", userPrompt, "user");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const t0 = performance.now();
  let totalTokens = 0;
  const MAX_ROUNDS = 4;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Non-streaming call so we can get tool_calls from the response
    const response = await engine.chat.completions.create({
      messages,
      tools: TOOLS_SCHEMA,
      temperature: 0.3,
      max_tokens: 400,
    });

    const choice = response.choices[0];
    totalTokens += response.usage?.completion_tokens || 0;

    // Check for tool calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      // Add assistant message with tool calls to history
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {}

        // Show the tool call in UI
        addMessage(`tool: ${fnName}`, JSON.stringify(fnArgs), "tool");

        // Execute
        const handler = TOOL_HANDLERS[fnName];
        const result = handler ? handler(fnArgs) : JSON.stringify({ error: "Unknown tool" });

        // Show result
        addMessage("result", result, "tool-result");

        // Add tool result to conversation
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      // Loop back for the model to produce a final answer
      continue;
    }

    // No tool calls — this is the final text answer
    const text = choice.message.content || "(no response)";
    addMessage("assistant", text, "assistant");
    break;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const tps = (totalTokens / (elapsed || 1)).toFixed(1);
  statsEl.textContent = `${totalTokens} tokens in ${elapsed}s (~${tps} tok/s)`;

  promptEl.disabled = false;
  sendBtn.disabled = false;
  promptEl.focus();
}

// --- Init ---
async function init() {
  if (!navigator.gpu) {
    log("WebGPU not available. Use Chrome 113+ or Edge 113+.");
    return;
  }

  log("WebGPU detected. Loading Hermes-3-Llama-3.1-8B...");
  log("First run downloads ~4.5GB. Cached after that.\n");

  // Hermes-3 is the smallest model with tool calling support in WebLLM
  const modelId = "Hermes-3-Llama-3.1-8B-q4f16_1-MLC";

  try {
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (progress) => {
        statusEl.textContent = `Loading ${modelId}:\n${progress.text}`;
      },
    });
    log(`\nReady: ${modelId}`);
  } catch (err) {
    log(`Failed to load: ${err.message}`);
    return;
  }

  promptEl.disabled = false;
  sendBtn.disabled = false;
  promptEl.focus();
}

sendBtn.addEventListener("click", () => {
  const text = promptEl.value.trim();
  if (text) {
    promptEl.value = "";
    generate(text);
  }
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

document.querySelectorAll(".preset").forEach((el) => {
  el.addEventListener("click", () => {
    promptEl.value = el.dataset.prompt;
    sendBtn.click();
  });
});

init();
