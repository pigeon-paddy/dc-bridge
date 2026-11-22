
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

console.log("Bridge version:", new Date().toISOString());
console.log("Starting Discord bridge...");

const {
  DISCORD_TOKEN,
  DISCORDSRV_BOT_ID,
  N8N_BOT_ID,
  N8N_WEBHOOK: WEBHOOK,
  CHANNEL_ID,
  DISCORDSRV_BOTS: BOT_CONFIG
} = process.env;

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

// Configuration validation
if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN missing");
if (!WEBHOOK) throw new Error("N8N_WEBHOOK missing");

// Multiple DiscordSRV bots
const DISCORDSRV_BOTS = new Map(
  (BOT_CONFIG || "")
    .split(",")
    .filter(Boolean)
    .map(entry => {
      const [id, name, container] = entry.trim().split(":");

      return [
        id,
        {
          name: name || "Unknown",
          container: container || null
        }
      ];
    })
);

// Backwards compatibility
if (DISCORDSRV_BOT_ID && !DISCORDSRV_BOTS.has(DISCORDSRV_BOT_ID)) {
  DISCORDSRV_BOTS.set(DISCORDSRV_BOT_ID, {
    name: "Minecraft",
    container: null
  });
}

console.log("Webhook:", WEBHOOK);
console.log("Channel ID:", CHANNEL_ID || "ALL");
console.log("Discord token:", DISCORD_TOKEN ? "SET" : "MISSING");
console.log("Minecraft bots:", [...DISCORDSRV_BOTS.entries()]);

// Parse normal DiscordSRV chat messages

function parseMinecraftMessage(content) {
  const match = content.match(/^\s*(.{1,32}?)\s*(?:»|:)\s*([\s\S]*)$/);

  if (!match) {
    return {
      username: null,
      content
    };
  }

  return {
    username: match[1].trim(),
    content: match[2].trim()
  };
}


// Detect Minecraft join events in normal messages AND embeds
function parseMinecraftJoin(msg) {
  const texts = [msg.content || ""];

  for (const embed of msg.embeds) {
    const data = embed.toJSON();

    texts.push(
      data.title,
      data.description,
      data.author?.name,
      data.footer?.text,
      ...(data.fields || []).flatMap(field => [
        field.name,
        field.value
      ])
    );
  }

  for (const text of texts.filter(Boolean)) {
    const match = text.match(
      /(?:^|\n)\s*(?:→\s*)?(.{1,32}?)\s+joined the server\b/i
    );

    if (match) {
      return {
        event: "join",
        username: match[1].trim()
      };
    }
  }

  return null;
}

// Test n8n connection
async function testWebhook() {
  console.log("Testing n8n webhook connection...");

  try {
    const response = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: "bridgeStartup",
        source: "dc-bridge",
        message: {
          content: "Discord bridge successfully connected to n8n!"
        },
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(10000)
    });

    const body = await response.text();

    console.log("Webhook test status:", response.status);
    console.log("Webhook response:", body || "(empty)");

    if (!response.ok) {
      console.error("❌ Webhook test failed!");
      return false;
    }

    console.log("✅ Webhook connection successful!");
    return true;

  } catch (err) {
    console.error("❌ Webhook test failed:", err.message);
    return false;
  }
}

// Forward messages to n8n
async function forward(payload) {
  try {
    console.log("➡️ Forwarding:", payload.event);

    const response = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    console.log("Webhook response:", response.status);

    if (!response.ok) {
      console.error("❌ Webhook returned HTTP", response.status);
    }

  } catch (err) {
    console.error("❌ Webhook unreachable:", err.message);
  }
}

// Discord ready
client.once("clientReady", () => {
  console.log(`✅ Connected as ${client.user.tag}`);
});

// Receive Discord messages
client.on("messageCreate", async (msg) => {
  if (CHANNEL_ID && msg.channelId !== CHANNEL_ID) return;

  if (msg.author.id === N8N_BOT_ID) return;

  const isMinecraft = DISCORDSRV_BOTS.has(msg.author.id);

  if (msg.author.bot && !isMinecraft) return;

  let origin;
  let author;
  let server = null;
  let content = msg.content;
  let event = "messageCreate";

  if (isMinecraft) {
    origin = "mc_server";

    const botConfig = DISCORDSRV_BOTS.get(msg.author.id);

    server = {
      name: botConfig.name,
      container: botConfig.container,
      bot_id: msg.author.id,
      bot_username: msg.author.username
    };

    // Detect join events (normal messages AND embeds)
    const joinEvent = parseMinecraftJoin(msg);

    if (joinEvent) {
      event = "join";

      author = {
        id: null,
        username: joinEvent.username
      };

      content = "/event join";

    } else {
      // Ignore unrecognized embed-only messages
      if (!msg.content.trim()) {
        console.warn("⚠️ Unrecognized Minecraft embed-only message!");

        console.log(
          "Embed data:",
          JSON.stringify(msg.embeds.map(embed => embed.toJSON()), null, 2)
        );

        return;
      }

      // Parse normal Minecraft chat messages
      const parsed = parseMinecraftMessage(msg.content);

      if (!parsed.username) {
        console.warn("⚠️ Could not parse Minecraft message:", msg.content);
        return;
      }

      author = {
        id: null,
        username: parsed.username
      };

      content = parsed.content;
    }

  } else {
    origin = "discord";

    author = {
      id: msg.author.id,
      username: msg.author.username
    };
  }

  const payload = {
    event,
    origin,
    server,
    message: {
      id: msg.id,
      content,
      channel_id: msg.channelId,
      guild_id: msg.guildId
    },
    author
  };

  console.log(
    `📩 [${origin}] ${server?.name || "Discord"} | ${author.username}: ${content}`
  );

  await forward(payload);
});

// Graceful shutdown
async function shutdown() {
  console.log("🛑 Shutting down Discord bridge...");
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

// Startup
console.log("Testing webhook before Discord login...");

await testWebhook();

console.log("Logging in to Discord...");
await client.login(DISCORD_TOKEN);
