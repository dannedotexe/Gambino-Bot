import { randomUUID } from "node:crypto";
import { audit } from "../database.js";

const now = () => new Date().toISOString();
const amount = (n) => Number.isSafeInteger(n) && n > 0;

export function createFinance(db) {
  function balance(guildId, userId) {
    return db.prepare("SELECT balance_cents FROM accounts WHERE guild_id=? AND user_id=?").get(guildId, userId)?.balance_cents ?? 0;
  }
  const credit = db.transaction(({ guildId, userId, actorId, cents, reason, key }) => {
    if (!amount(cents) || !reason?.trim()) throw new Error("Betrag und Buchungsgrund sind erforderlich.");
    if (db.prepare("SELECT id FROM transactions WHERE idempotency_key=?").get(key)) return db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);
    const ts = now(), txId = randomUUID();
    db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,0,?) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId,userId,ts);
    db.prepare("UPDATE accounts SET balance_cents=balance_cents+?,updated_at=? WHERE guild_id=? AND user_id=?").run(cents,ts,guildId,userId);
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(txId,guildId,userId,actorId,"credit",cents,reason.trim(),key,ts);
    audit(db,guildId,actorId,"finance.credit",userId,{cents,reason:reason.trim(),transactionId:txId});
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });
  const sanction = db.transaction(({ guildId,userId,actorId,cents,reason,caseRef=null }) => {
    if (!amount(cents) || !reason?.trim()) throw new Error("Sanktionsbetrag und Grund sind erforderlich.");
    const ts=now(), id=randomUUID();
    db.prepare("INSERT INTO sanctions(id,guild_id,user_id,actor_id,amount_cents,remaining_cents,reason,status,case_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?,?)").run(id,guildId,userId,actorId,cents,cents,reason.trim(),caseRef,ts,ts);
    audit(db,guildId,actorId,"sanction.created",userId,{sanctionId:id,cents,reason:reason.trim(),caseRef});
    return id;
  });
  const payout = db.transaction(({ guildId,userId,actorId,key,reason="Familienauszahlung",allowZero=false,minimumCents }) => {
    const prior = db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);
    if (prior) return prior;
    const gross=balance(guildId,userId);
    if (gross<=0 && !allowZero) throw new Error("Kein Guthaben für eine Auszahlung vorhanden.");
    if(minimumCents!=null&&gross<minimumCents)throw new Error("Das Guthaben liegt unter dem konfigurierten Auszahlungs-Mindestbetrag.");
    const open = db.prepare("SELECT id,remaining_cents FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ('open','partial') AND remaining_cents>0 ORDER BY created_at,id").all(guildId,userId);
    let left=gross, deducted=0;
    const allocations=[];
    for (const row of open) {
      const part=Math.min(left,row.remaining_cents);
      if (!part) break;
      allocations.push({id:row.id,cents:part}); left-=part; deducted+=part;
    }
    const net=gross-deducted, ts=now(), txId=randomUUID();
    db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,0,?) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId,userId,ts);
    db.prepare("UPDATE accounts SET balance_cents=balance_cents-?,updated_at=? WHERE guild_id=? AND user_id=? AND balance_cents>=?").run(gross,ts,guildId,userId,gross);
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,gross_cents,deduction_cents,net_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(txId,guildId,userId,actorId,"payout",gross,gross,deducted,net,reason,key,ts);
    for (const item of allocations) {
      db.prepare("INSERT INTO payout_allocations(id,payout_id,sanction_id,amount_cents,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),txId,item.id,item.cents,ts);
      db.prepare("UPDATE sanctions SET remaining_cents=remaining_cents-?,status=CASE WHEN remaining_cents-?=0 THEN 'paid' ELSE 'partial' END,updated_at=? WHERE id=? AND remaining_cents>=?").run(item.cents,item.cents,ts,item.id,item.cents);
      audit(db,guildId,actorId,"sanction.applied",userId,{sanctionId:item.id,payoutId:txId,cents:item.cents});
    }
    audit(db,guildId,actorId,"finance.payout",userId,{transactionId:txId,grossCents:gross,deductionCents:deducted,netCents:net,reason});
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });
  const voidSanction = db.transaction(({ guildId,sanctionId,actorId,reason }) => {
    if (!reason?.trim()) throw new Error("Für die Aufhebung ist ein Grund erforderlich.");
    const row=db.prepare("SELECT * FROM sanctions WHERE id=? AND guild_id=?").get(sanctionId,guildId);
    if (!row || !["open","partial"].includes(row.status)) throw new Error("Offene Sanktion nicht gefunden.");
    const applied=db.prepare("SELECT COALESCE(SUM(amount_cents),0) amount FROM payout_allocations WHERE sanction_id=?").get(sanctionId).amount;
    if(applied>0)throw new Error("Von dieser Sanktion wurde bereits Geld abgezogen. Nutze /sanktion rueckerstatten, damit der bereits belastete Betrag gutgeschrieben und die Sanktion aufgehoben wird.");
    db.prepare("UPDATE sanctions SET status='void',remaining_cents=0,updated_at=? WHERE id=?").run(now(),sanctionId);
    audit(db,guildId,actorId,"sanction.void",row.user_id,{sanctionId,remainingCents:row.remaining_cents,reason:reason.trim()});
    return row;
  });
  const refundSanction = db.transaction(({guildId,sanctionId,actorId,reason,key})=>{
    if(!reason?.trim())throw new Error("Für eine Rückerstattung ist ein Grund erforderlich.");
    const prior=db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);if(prior)return prior;
    const row=db.prepare("SELECT * FROM sanctions WHERE id=? AND guild_id=?").get(sanctionId,guildId);if(!row)throw new Error("Sanktion nicht gefunden.");
    const collected=db.prepare("SELECT COALESCE(SUM(amount_cents),0) amount FROM payout_allocations WHERE sanction_id=?").get(sanctionId).amount;
    const refunded=db.prepare("SELECT COALESCE(SUM(amount_cents),0) amount FROM sanction_refunds WHERE sanction_id=?").get(sanctionId).amount;
    const cents=collected-refunded;if(cents<=0)throw new Error("Für diese Sanktion gibt es keinen noch nicht erstatteten Abzug.");
    const ts=now(),txId=randomUUID(),refundId=randomUUID();
    db.prepare("INSERT INTO accounts(guild_id,user_id,balance_cents,updated_at) VALUES(?,?,0,?) ON CONFLICT(guild_id,user_id) DO NOTHING").run(guildId,row.user_id,ts);
    db.prepare("UPDATE accounts SET balance_cents=balance_cents+?,updated_at=? WHERE guild_id=? AND user_id=?").run(cents,ts,guildId,row.user_id);
    db.prepare("INSERT INTO transactions(id,guild_id,user_id,actor_id,type,amount_cents,reason,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(txId,guildId,row.user_id,actorId,"sanction_refund",cents,reason.trim(),key,ts);
    db.prepare("INSERT INTO sanction_refunds(id,sanction_id,transaction_id,amount_cents,reason,created_at) VALUES(?,?,?,?,?,?)").run(refundId,sanctionId,txId,cents,reason.trim(),ts);
    if(row.status!=="void")db.prepare("UPDATE sanctions SET status='void',remaining_cents=0,updated_at=? WHERE id=?").run(ts,sanctionId);
    audit(db,guildId,actorId,"sanction.refunded",row.user_id,{sanctionId,transactionId:txId,cents,reason:reason.trim()});
    return db.prepare("SELECT * FROM transactions WHERE id=?").get(txId);
  });
  return { balance, credit, sanction, payout, voidSanction, refundSanction };
}

export const formatMoney = (cents) => `$${(cents / 100).toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const parseMoney = (value) => {
  const match = /^(\d{1,12})(?:[,.](\d{1,2}))?$/.exec(value ?? "");
  if (!match) throw new Error("Betrag bitte als positive Zahl eingeben (z. B. 2500000 oder 12,50).");
  const cents=Number(match[1])*100+Number((match[2]??"").padEnd(2,"0"));
  if (!amount(cents)) throw new Error("Betrag muss größer als 0 sein.");
  return cents;
};
