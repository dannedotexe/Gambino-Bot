import { EmbedBuilder } from "discord.js";
import { getSetting, setSetting } from "./database.js";
import { auditLogPayload, BRAND_COLOR, logEmbed } from "./presentation.js";
import { createGiveawayService } from "./services/giveaways.js";
import { createTicketService } from "./services/tickets.js";
import { collectStats } from "./services/stats.js";
import { createSeriesEvents, endSeriesEvents, refreshActivityBoard } from "./activity-board.js";
import { ensurePanels, postEventResult } from "./panels.js";
import { cleanupReminders, refreshEventPosts, sendEventReminder } from "./event-posts.js";
import { panelTexts } from "./services/texts.js";
import { syncAbsenceRoles } from "./absence-posts.js";
import { runDailyInactivity } from "./inactivity.js";
import { sendDueAnnouncements } from "./announcements.js";
import { closeDuePolls } from "./polls.js";
import { checkEventMinimums, processNoShows } from "./event-checks.js";
import { sendWeeklyReport } from "./weekly-report.js";
import { runDailySnapshot } from "./role-snapshots.js";
import { refreshPayoutList } from "./payout-list.js";
import { refreshTaskBoard } from "./task-logs.js";
import { remindInactiveLogbooks } from "./logbooks.js";
import { requestAttendance, requestDueAttendance } from "./attendance.js";
import { PANEL_SETTING_KEY, STATS_SETTING_KEY, buildPanelPayload, statsEmbed } from "./staff-panel.js";

/**
 * Wählt für ein Event die fällige Erinnerung: die kleinste konfigurierte Vorlaufzeit, die bereits erreicht ist.
 * Größere, verpasste Stufen (z. B. nach einem Neustart) werden übersprungen, damit nicht mehrfach erinnert wird.
 */
export function dueReminder(startsAt, reminderMinutes, sentSlots, now = new Date()) {
  const minutesLeft = (new Date(startsAt) - now) / 60_000;
  if (minutesLeft <= 0) return null;
  const reached = reminderMinutes.filter(slot => minutesLeft <= slot);
  if (!reached.length) return null;
  const slot = Math.min(...reached);
  if (sentSlots.some(sent => sent <= slot)) return null;
  return { slot, skipped: reached.filter(item => item !== slot && !sentSlots.includes(item)) };
}

/** Bereichs-Logs: Sanktionen, Finanzen und Events in ihre eigenen Channels, alles andere ins Audit-Log. */
export function auditChannelFor(action,config){
  // Einreichungen und Entscheidungen stehen schon als Prüf-Karte im Aufgaben-Channel (Buchung zusätzlich im Finanz-Log).
  if(/^task\.(submitted|approved|rejected|withdrawn)$/.test(action))return null;
  const area=action.startsWith("sanction.")||action.startsWith("moderation.")?config.CHANNEL_SANCTION_LOG:action.startsWith("absence.")||action.startsWith("activity.")?config.CHANNEL_ACTIVITY_LOG:action.startsWith("finance.")?config.CHANNEL_FINANCE_LOG:action.startsWith("event.")?config.CHANNEL_EVENT_LOG:null;
  return area||config.CHANNEL_AUDIT_LOG||null;
}

export function startScheduler({db,client,config,series=null}) {
  let running=false,lastTicketCheck=0,lastPanel=0,lastStats=0,lastAbsence=0;
  const giveaways=createGiveawayService(db),tickets=createTicketService(db);
  const tick=async()=>{
    if(running)return;running=true;
    try{
      const now=new Date();
      const due=db.prepare("SELECT id FROM giveaways WHERE status='active' AND ends_at<=?").all(now.toISOString());
      for(const giveaway of due){
        try{if(giveaways.draw(giveaway.id))await announceGiveaway(db,client,db.prepare("SELECT * FROM giveaways WHERE id=?").get(giveaway.id));}
        catch(error){console.error(`Giveaway ${giveaway.id} konnte nicht beendet werden:`,error.message);}
      }
      const announce=db.prepare("SELECT g.* FROM giveaways g LEFT JOIN giveaway_announcements a ON a.giveaway_id=g.id WHERE g.status='ended' AND a.giveaway_id IS NULL ORDER BY g.ended_at LIMIT 20").all();
      for(const giveaway of announce)await announceGiveaway(db,client,giveaway).catch(error=>console.warn(`Giveaway-Ergebnis ${giveaway.id} noch nicht zugestellt:`,error.message));
      if(series){
        await createSeriesEvents({db,client,config,series,reference:now}).catch(error=>console.error("Aktivitäten konnten nicht angelegt werden:",error.message));
        // Einmalig: Posts bereits beendeter Staatlicher Kontrollen (vor diesem Update) aufräumen.
        if(config.EVENT_SERIES_DELETE_ENDED&&config.DISCORD_GUILD_ID&&!getSetting(db,config.DISCORD_GUILD_ID,"CONTROL_POSTS_CLEANED")){
          setSetting(db,config.DISCORD_GUILD_ID,"CONTROL_POSTS_CLEANED",now.toISOString());
          for(const row of db.prepare("SELECT * FROM events WHERE guild_id=? AND location='Staatliche Kontrolle' AND series_id IS NULL AND status IN ('ended','cancelled') AND message_id IS NOT NULL").all(config.DISCORD_GUILD_ID))
            await refreshEventPosts({db,client,config,event:row,state:row.status}).catch(()=>{});
        }
        await endSeriesEvents({db,client,config,reference:now,onEnded:event=>requestAttendance({db,client,config,event})}).catch(error=>console.error("Aktivitäten konnten nicht beendet werden:",error.message));
      }
      await checkEventMinimums({db,client,config,reference:now}).catch(error=>console.warn("Mindestteilnehmer-Prüfung fehlgeschlagen:",error.message));
      await sendReminders(db,client,config,now);
      await cleanupReminders({db,client,reference:now}).catch(error=>console.warn("Erinnerungen konnten nicht aufgeräumt werden:",error.message));
      await closeDuePolls({db,client,reference:now}).catch(error=>console.warn("Abstimmungen konnten nicht beendet werden:",error.message));
      await sendDueAnnouncements({db,client,reference:now}).catch(error=>console.warn("Ankündigungen konnten nicht gesendet werden:",error.message));
      if(Date.now()-lastTicketCheck>60_000){
        lastTicketCheck=Date.now();
        const open=db.prepare("SELECT id,channel_id FROM tickets WHERE status='open' AND channel_id IS NOT NULL ORDER BY created_at LIMIT 100").all();
        for(const ticket of open){
          // Nur ein eindeutiges "Unknown Channel" (10003) gilt als gelöscht; Netzwerkfehler schließen kein Ticket.
          const missing=await client.channels.fetch(ticket.channel_id).then(()=>false).catch(error=>error?.code===10003);
          if(missing)tickets.markChannelMissing({ticketId:ticket.id,actorId:client.user.id});
        }
      }
      const panelEvery=(config.DASHBOARD_PANEL_REFRESH_MINUTES>0?config.DASHBOARD_PANEL_REFRESH_MINUTES:10)*60_000;
      if(!lastPanel||Date.now()-lastPanel>panelEvery){
        lastPanel=Date.now();
        // Panels in den eingestellten Channels sicherstellen; ältere, manuell gepostete Panels weiter aktualisieren.
        await ensurePanels({db,client,config,series}).catch(error=>console.warn("Panels konnten nicht geprüft werden:",error.message));
        if(config.DASHBOARD_PANEL_REFRESH_MINUTES>0){if(!config.CHANNEL_STAFF_DASHBOARD)await refreshStaffPanel(db,client,config);if(series&&!config.CHANNEL_ACTIVITY_BOARD)await refreshActivityBoard({db,client,config,series});}
      }
      if(config.STATS_CHANNEL_UPDATE_MINUTES>0&&config.CHANNEL_STATS&&Date.now()-lastStats>config.STATS_CHANNEL_UPDATE_MINUTES*60_000){lastStats=Date.now();await refreshStatsChannel(db,client,config);}
      if(Date.now()-lastAbsence>60_000){
        lastAbsence=Date.now();
        await syncAbsenceRoles({db,client,config,reference:now}).catch(error=>console.warn("Abmelde-Rollen konnten nicht abgeglichen werden:",error.message));
        await requestDueAttendance({db,client,config,reference:now}).catch(error=>console.warn("Anwesenheits-Abfrage fehlgeschlagen:",error.message));
        await processNoShows({db,client,config,reference:now}).catch(error=>console.warn("No-Show-Prüfung fehlgeschlagen:",error.message));
        await sendWeeklyReport({db,client,config,reference:now}).catch(error=>console.warn("Wochenbericht fehlgeschlagen:",error.message));
        await runDailyInactivity({db,client,config,reference:now}).catch(error=>console.warn("Inaktivitätsprüfung fehlgeschlagen:",error.message));
        await refreshPayoutList({db,client,config}).catch(error=>console.warn("Auszahlungsliste konnte nicht aktualisiert werden:",error.message));
        await refreshTaskBoard({db,client,config}).catch(error=>console.warn("Aufgaben-Board konnte nicht aktualisiert werden:",error.message));
        await runDailySnapshot({db,client,config,reference:now}).catch(error=>console.warn("Rollen-Sicherung fehlgeschlagen:",error.message));
        // Logbuch-Erinnerungen einmal täglich am Abend (ab 18 Uhr Server-Zeit), wenn die meisten online sind.
        if(Number(new Intl.DateTimeFormat("en-GB",{hour:"numeric",hourCycle:"h23",timeZone:config.TIMEZONE}).format(now))>=18)await remindInactiveLogbooks({db,client,config,reference:now}).catch(error=>console.warn("Logbuch-Erinnerungen fehlgeschlagen:",error.message));
      }
      client.gambinoSchedulerTick=Date.now();
      await deliverAuditLogs(db,client,config,now);
    }catch(error){console.error("Scheduler tick failed:",error);}finally{running=false;}
  };
  const timer=setInterval(tick,15_000);timer.unref();void tick();return()=>clearInterval(timer);
}

async function sendReminders(db,client,config,now){
  if(!config.EVENT_REMINDER_MINUTES.length)return;
  const horizon=new Date(now.getTime()+Math.max(...config.EVENT_REMINDER_MINUTES)*60_000).toISOString();
  const events=db.prepare("SELECT * FROM events WHERE status='scheduled' AND starts_at>? AND starts_at<=?").all(now.toISOString(),horizon);
  for(const event of events){
    const sent=db.prepare("SELECT minutes_before FROM event_reminders WHERE event_id=?").all(event.id).map(r=>r.minutes_before);
    const reminder=dueReminder(event.starts_at,config.EVENT_REMINDER_MINUTES,sent,now);
    if(!reminder)continue;
    // Erst reservieren, dann senden: verhindert doppelte Erinnerungen bei parallelen Ticks oder Neustarts.
    const claimed=db.transaction(()=>{
      const inserted=db.prepare("INSERT OR IGNORE INTO event_reminders(event_id,minutes_before,sent_at) VALUES(?,?,?)").run(event.id,reminder.slot,now.toISOString()).changes;
      if(inserted)for(const skipped of reminder.skipped)db.prepare("INSERT OR IGNORE INTO event_reminders(event_id,minutes_before,sent_at) VALUES(?,?,?)").run(event.id,skipped,now.toISOString());
      return inserted;
    })();
    if(!claimed)continue;
    await sendEventReminder({db,client,config,event});
  }
}

async function deliverAuditLogs(db,client,config,now){
  const pending=db.prepare("SELECT a.* FROM audit_logs a LEFT JOIN audit_log_deliveries d ON d.audit_id=a.id WHERE d.audit_id IS NULL ORDER BY a.created_at LIMIT 50").all();
  if(!pending.length)return;
  const channels=new Map();
  const channelFor=async action=>{
    const id=auditChannelFor(action,config);
    if(!id)return null;
    if(!channels.has(id))channels.set(id,await client.channels.fetch(id).catch(()=>null));
    return channels.get(id);
  };
  for(const item of pending){
    const logChannel=await channelFor(item.action);
    const skip=!logChannel?"no_channel":config.AUDIT_CHANNEL_IGNORE_ACTIONS.includes(item.action)?"skipped":null;
    // Zustellung wird vor dem Senden reserviert: ein Fehler im Log-Channel führt nie zu doppelter Ausführung.
    const claimed=db.prepare("INSERT OR IGNORE INTO audit_log_deliveries(audit_id,attempted_at,result) VALUES(?,?,?)").run(item.id,now.toISOString(),skip??"attempted");
    if(!claimed.changes||skip)continue;
    const result=await logChannel.send(auditLogPayload(item)).then(()=>"sent").catch(error=>{console.warn("Audit channel delivery failed; DB audit retained:",error.message);return "failed";});
    db.prepare("UPDATE audit_log_deliveries SET result=? WHERE audit_id=?").run(result,item.id);
  }
}

export async function refreshStaffPanel(db,client,config){
  const guildId=config.DISCORD_GUILD_ID;
  if(!guildId)return;
  const stored=getSetting(db,guildId,PANEL_SETTING_KEY);
  if(!stored)return;
  const [channelId,messageId]=stored.split(":");
  const channel=await client.channels.fetch(channelId).catch(()=>null);
  const message=channel?await channel.messages.fetch(messageId).catch(()=>null):null;
  if(message)await message.edit(buildPanelPayload(db,guildId,panelTexts(db,guildId,"staffDashboard"))).catch(error=>console.warn("Dashboard-Panel konnte nicht aktualisiert werden:",error.message));
}

async function refreshStatsChannel(db,client,config){
  const guildId=config.DISCORD_GUILD_ID;
  if(!guildId)return;
  const channel=await client.channels.fetch(config.CHANNEL_STATS).catch(()=>null);
  if(!channel?.isTextBased?.())return;
  const guild=client.guilds.cache.get(guildId);
  // Öffentlicher Statistik-Channel: niemals Finanzdaten.
  const payload={embeds:[statsEmbed(collectStats(db,guildId,{days:30,includeFinance:false}),{title:"📊 Gambinos Statistik (automatisch)",memberCount:guild?.memberCount??null})]};
  const stored=getSetting(db,guildId,STATS_SETTING_KEY);
  const [storedChannel,storedMessage]=stored?.split(":")??[];
  const message=storedChannel===channel.id?await channel.messages.fetch(storedMessage).catch(()=>null):null;
  if(message){await message.edit(payload).catch(error=>console.warn("Statistik-Nachricht konnte nicht aktualisiert werden:",error.message));return;}
  const sent=await channel.send(payload).catch(error=>{console.warn("Statistik-Channel nicht beschreibbar:",error.message);return null;});
  if(sent)setSetting(db,guildId,STATS_SETTING_KEY,`${channel.id}:${sent.id}`);
}

async function announceGiveaway(db,client,row){
  const winners=JSON.parse(row.winners??"[]"),channel=await client.channels.fetch(row.channel_id).catch(()=>null);
  if(!channel){console.warn(`Giveaway ${row.id} ended but its channel is unavailable; result remains stored for retry.`);return;}
  const result={embeds:[new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({name:"GAMBINOS  •  GIVEAWAY"}).setTitle(`🎉 Giveaway beendet: ${row.prize}`.slice(0,256)).setDescription(winners.length?`**Gewonnen haben:**\n${winners.map(id=>`🏆 <@${id}>`).join("\n")}`:"Es gab keine Teilnahmen; es wurde kein Gewinner gezogen.").setFooter({text:"GAMBINOS  •  Ergebnis dauerhaft gespeichert"}).setTimestamp()],components:[],allowedMentions:{users:winners}};
  const message=row.message_id?await channel.messages.fetch(row.message_id).catch(()=>null):null;
  if(message){await message.edit(result);if(winners.length)await channel.send({content:`Glückwunsch ${winners.map(id=>`<@${id}>`).join(", ")}! Ihr habt **${row.prize}** gewonnen.`,allowedMentions:{users:winners}}).catch(()=>{});}
  else await channel.send(result);
  db.prepare("INSERT OR IGNORE INTO giveaway_announcements(giveaway_id,sent_at) VALUES(?,?)").run(row.id,new Date().toISOString());
}
