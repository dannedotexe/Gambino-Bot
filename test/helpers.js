import { initializeSchema } from "../src/database.js";

let Native=await import("better-sqlite3").then(m=>m.default).catch(()=>null);
if(Native){try{new Native(":memory:").close();}catch{Native=null;}}
let DatabaseFactory;
if(Native)DatabaseFactory=()=>new Native(":memory:");
else {
  const {DatabaseSync}=await import("node:sqlite");
  DatabaseFactory=()=>{
    const raw=new DatabaseSync(":memory:");
    return {
      exec:(sql)=>raw.exec(sql),pragma:()=>{},prepare:(sql)=>raw.prepare(sql),
      transaction(fn){return (...args)=>{raw.exec("BEGIN IMMEDIATE");try{const out=fn(...args);raw.exec("COMMIT");return out;}catch(error){raw.exec("ROLLBACK");throw error;}};},
    };
  };
}

export function testDb(){const db=DatabaseFactory();initializeSchema(db);return db;}
