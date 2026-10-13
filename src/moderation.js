import { randomUUID } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { audit } from "./database.js";
import { logEmbed } from "./presentation.js";
import { accessGroups } from "./config.js";
import { RULE_LABELS, actionsForRule, evaluateMessage, exemptionReason, slidingWindow } from "./services/automod.js";
import { recordMemberChange } from "./services/stats.js";

const ACTION_LABELS = { warn: "Hinweis", delete: "Nachricht gelöscht", timeout: "Timeout", alert: "Staff-Meldung" };

export function startModeration({ client, db, config }) {
  const recent = new Map(), joins = new Map(), floods = new Map(), violations = new Map(), alertCooldown = new Map();
  const staffRoles = accessGroups(config).anyStaff;

  const sendLog = async (guild, payload) => {
    if (!config.CHANNEL_AUTOMOD_LOG) return;
    const channel = await guild.channels.fetch(config.CHANNEL_AUTOMOD_LOG).catch(() => null);
    if (channel) await channel.send(payload).catch(error => console.warn("AutoMod-Log konnte nicht gesendet werden:", error.message));
  };
  const coolingDown = (key, seconds) => {
    const last = alertCooldown.get(key) ?? 0;
    if (Date.now() - last < seconds * 1000) return true;
    alertCooldown.set(key, Date.now());
    return false;
  };

  client.on("guildMemberAdd", async member => {
    try {
      if (config.DISCORD_GUILD_ID && member.guild.id !== config.DISCORD_GUILD_ID) return;
      recordMemberChange(db, member.guild.id, "join", member.guild.memberCount);
      const recentJoins = slidingWindow(joins, member.guild.id, config.RAID_WINDOW_SECONDS * 1000);
      if (recentJoins.length < config.RAID_JOIN_COUNT) return;
      const performed = [];
      if (config.RAID_ACTIONS.includes("timeout") && !staffRoles.some(id => member.roles.cache.has(id))) {
        const ok = await member.timeout(config.RAID_TIMEOUT_MINUTES * 60_000, "Gambinos Raid-Schutz: ungewöhnliche Beitrittsrate").then(() => true).catch(error => { console.warn("Raid-Timeout fehlgeschlagen:", error.message); return false; });
        performed.push(ok ? "timeout" : "timeout_failed");
      }
      if (config.RAID_ACTIONS.includes("alert")) performed.push("alert");
      logAutomod(db, member.guild.id, member.id, "join_raid", performed.join(",") || "logged", { joins: recentJoins.length, windowSeconds: config.RAID_WINDOW_SECONDS });
      audit(db, member.guild.id, client.user.id, "automod.action", member.id, { rule: "join_raid", action: performed.join(",") || "logged", entries: recentJoins.length });
      if (config.RAID_ACTIONS.includes("alert") && !coolingDown(`raid:${member.guild.id}`, config.RAID_ALERT_COOLDOWN_SECONDS)) {
        console.warn(`Möglicher Join-Raid: guild=${member.guild.id}, ${recentJoins.length} Beitritte / ${config.RAID_WINDOW_SECONDS}s`);
        await sendLog(member.guild, { embeds: [logEmbed("🚨 Möglicher Join-Raid", `${recentJoins.length} neue Beitritte innerhalb von ${config.RAID_WINDOW_SECONDS} Sekunden.${config.RAID_ACTIONS.includes("timeout") ? `\nNeue Mitglieder erhalten während des Raids ${config.RAID_TIMEOUT_MINUTES} Minuten Timeout.` : ""}\nBitte Staff-Prüfung starten.`, "warning")] });
      }
    } catch (error) { console.error("Join-Verarbeitung fehlgeschlagen:", error); }
  });

  client.on("guildMemberRemove", member => {
    try {
      if (config.DISCORD_GUILD_ID && member.guild.id !== config.DISCORD_GUILD_ID) return;
      recordMemberChange(db, member.guild.id, "leave", member.guild.memberCount);
    } catch (error) { console.error("Austritts-Statistik fehlgeschlagen:", error.message); }
  });

  client.on("messageCreate", async message => {
    try {
      if (!message.guild || message.author.bot) return;
      if (config.DISCORD_GUILD_ID && message.guild.id !== config.DISCORD_GUILD_ID) return;
      // Server-weite Nachrichtenflut: reine Staff-Meldung, keine automatische Strafe.
      if (config.FLOOD_MESSAGE_COUNT > 0) {
        const flood = slidingWindow(floods, message.guild.id, config.FLOOD_WINDOW_SECONDS * 1000);
        if (flood.length >= config.FLOOD_MESSAGE_COUNT && !coolingDown(`flood:${message.guild.id}`, config.RAID_ALERT_COOLDOWN_SECONDS)) {
          logAutomod(db, message.guild.id, message.author.id, "message_flood", "alert", { messages: flood.length, windowSeconds: config.FLOOD_WINDOW_SECONDS });
          await sendLog(message.guild, { embeds: [logEmbed("🌊 Ungewöhnliche Nachrichtenflut", `${flood.length} Nachrichten innerhalb von ${config.FLOOD_WINDOW_SECONDS} Sekunden im Server. Bitte prüfen, ob Slowmode nötig ist.`, "warning")] });
        }
      }
      if (!config.AUTOMOD_ENABLED) return;
      const memberRoleIds = [...(message.member?.roles?.cache?.keys() ?? [])];
      const exempt = exemptionReason({ memberRoleIds, canManageMessages: message.member?.permissions?.has(PermissionFlagsBits.ManageMessages), channelId: message.channelId, parentId: message.channel?.parentId }, config, staffRoles);
      if (exempt) return;
      const key = `${message.guild.id}:${message.author.id}`;
      const history = (recent.get(key) ?? []).filter(entry => entry.at > Date.now() - config.AUTOMOD_SPAM_WINDOW_SECONDS * 1000);
      const rule = evaluateMessage({ content: message.content, history }, config);
      history.push({ at: Date.now(), content: message.content });
      recent.set(key, history.slice(-25));
      if (!rule) return;
      await applyActions({ message, rule, actions: [...actionsForRule(rule, config)] });
    } catch (error) { console.error("AutoMod-Verarbeitung fehlgeschlagen:", error); }
  });

  async function applyActions({ message, rule, actions }) {
    const key = `${message.guild.id}:${message.author.id}`;
    if (config.AUTOMOD_ESCALATION_COUNT > 0) {
      const strikes = slidingWindow(violations, key, config.AUTOMOD_ESCALATION_WINDOW_MINUTES * 60_000);
      if (strikes.length >= config.AUTOMOD_ESCALATION_COUNT && !actions.includes("timeout")) actions.push("timeout");
    }
    const performed = [];
    if (actions.includes("delete")) {
      const ok = await message.delete().then(() => true).catch(error => { console.warn("AutoMod konnte Nachricht nicht löschen:", error.message); return false; });
      performed.push(ok ? "delete" : "delete_failed");
    }
    if (actions.includes("timeout") && message.member) {
      const ok = message.member.moderatable && await message.member.timeout(config.AUTOMOD_TIMEOUT_MINUTES * 60_000, `Gambinos AutoMod: ${RULE_LABELS[rule]}`).then(() => true).catch(error => { console.warn("AutoMod-Timeout fehlgeschlagen:", error.message); return false; });
      performed.push(ok ? "timeout" : "timeout_failed");
    }
    if (actions.includes("warn")) {
      await message.channel.send({ embeds: [logEmbed("⚠️ Bitte beachte die Serverregeln", `<@${message.author.id}>, deine Nachricht verstößt gegen eine Serverregel (${RULE_LABELS[rule]}).`, "warning")], allowedMentions: { users: [message.author.id] } })
        .then(m => { setTimeout(() => m.delete().catch(() => {}), 8000).unref(); performed.push("warn"); })
        .catch(() => performed.push("warn_failed"));
    }
    if (actions.includes("alert")) performed.push("alert");
    const summary = performed.join(",") || "logged";
    // Nachrichteninhalt wird bewusst nicht gespeichert.
    logAutomod(db, message.guild.id, message.author.id, rule, summary, { channelId: message.channelId });
    audit(db, message.guild.id, client.user.id, "automod.action", message.author.id, { rule, action: summary, channelId: message.channelId });
    if (actions.includes("alert")) {
      await sendLog(message.guild, { embeds: [logEmbed("🛡️ AutoMod-Maßnahme", `**Regel:** ${RULE_LABELS[rule]}\n**Maßnahmen:** ${performed.map(item => ACTION_LABELS[item] ?? item.replace("_failed", " fehlgeschlagen")).join(", ")}\n**Mitglied:** <@${message.author.id}>\n**Channel:** <#${message.channelId}>`, "warning")] });
    }
  }
}

function logAutomod(db, guild, user, rule, action, details = {}) {
  db.prepare("INSERT INTO automod_actions(id,guild_id,user_id,rule,action,details,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), guild, user, rule, action, JSON.stringify(details), new Date().toISOString());
}

/** Synchronisiert AUTOMOD_BLOCKED_TERMS in eine native Discord-AutoMod-Keyword-Regel (benötigt „Server verwalten“). */
export async function syncNativeAutomod({ guild, db, config, actorId, getSetting, setSetting }) {
  const { AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType } = await import("discord.js");
  const me = guild.members.me ?? await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("Dem Bot fehlt die Berechtigung „Server verwalten“ für native AutoMod-Regeln.");
  const terms = config.AUTOMOD_BLOCKED_TERMS.map(term => term.slice(0, 60)).slice(0, 1000);
  if (!terms.length) throw new Error("AUTOMOD_BLOCKED_TERMS ist leer. Es gibt nichts zu synchronisieren.");
  const actions = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: "Diese Nachricht verstößt gegen die Gambinos-Serverregeln." } }];
  if (config.CHANNEL_AUTOMOD_LOG) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: config.CHANNEL_AUTOMOD_LOG } });
  const exemptRoles = [...new Set([...accessGroups(config).anyStaff, ...(config.AUTOMOD_EXEMPT_ROLES ?? [])])].slice(0, 20);
  const data = { name: "Gambinos – gesperrte Begriffe", eventType: AutoModerationRuleEventType.MessageSend, triggerType: AutoModerationRuleTriggerType.Keyword, triggerMetadata: { keywordFilter: terms }, actions, enabled: true, exemptRoles, exemptChannels: (config.AUTOMOD_EXEMPT_CHANNELS ?? []).slice(0, 50) };
  const existingId = getSetting(db, guild.id, "AUTOMOD_NATIVE_RULE_ID");
  const existing = existingId ? await guild.autoModerationRules.fetch(existingId).catch(() => null) : null;
  const rule = existing ? await existing.edit(data) : await guild.autoModerationRules.create(data);
  setSetting(db, guild.id, "AUTOMOD_NATIVE_RULE_ID", rule.id);
  audit(db, guild.id, actorId, "config.automod_synced", rule.id, { entries: terms.length, status: existing ? "updated" : "created" });
  return { rule, created: !existing, terms: terms.length };
}
