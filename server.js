/* Beauty & Nutrition - produkcijski server za online zakazivanje
   Node.js + Express + SQLite. Pokretanje: npm install && npm start            */
"use strict";
process.env.TZ = process.env.TZ || "Europe/Belgrade";

const express = require("express");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const compression = require("compression");
const SECRET = process.env.SECRET || "promeni-ovaj-secret-u-produkciji";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "kaca9525@gmail.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const STAFF_EMAILS = (process.env.STAFF_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || "18", 10); // sat slanja podsetnika
const SMS_DAY_HOUR = parseInt(process.env.SMS_DAY_HOUR || "8", 10);     // od kog sata idu SMS podsetnici (i onaj „na dan tretmana")
const SMS_QUIET_HOUR = 21;                                               // posle 21h se SMS ne šalje
const MAX_PER_EMP = 3;                                                   // najviše usluga po klijentu kod jedne zaposlene
const DATA_DIR = process.env.DATA_DIR || __dirname;

/* ---------------- baza ---------------- */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const db = new Database(path.join(DATA_DIR, "salon.db"));
console.log("Baza: " + path.join(DATA_DIR, "salon.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  email TEXT PRIMARY KEY, ime TEXT, prezime TEXT, telefon TEXT,
  salt TEXT, hash TEXT, created TEXT, consent TEXT);
CREATE TABLE IF NOT EXISTS services(
  id TEXT PRIMARY KEY, cat TEXT, name TEXT, desc TEXT,
  price INTEGER, duration INTEGER, active INTEGER DEFAULT 1,
  note TEXT, emps TEXT);
CREATE TABLE IF NOT EXISTS employees(
  id TEXT PRIMARY KEY, name TEXT, cats TEXT, title TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS bookings(
  id TEXT PRIMARY KEY, userEmail TEXT, userName TEXT, userTel TEXT,
  services TEXT, employee TEXT, employeeName TEXT,
  date TEXT, start TEXT, end TEXT,
  totalPrice INTEGER, totalDuration INTEGER,
  status TEXT, reminderSent INTEGER DEFAULT 0, created TEXT);
CREATE INDEX IF NOT EXISTS idx_b_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_b_user ON bookings(userEmail);
`);

function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM services").get().c;
  if (n > 0) return;
  const seedDir = path.join(__dirname, "seed");
  const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
  const tx = db.transaction(() => {
    for (const f of fs.readdirSync(path.join(seedDir, "services"))) {
      const s = read(path.join(seedDir, "services", f));
      db.prepare(`INSERT OR REPLACE INTO services(id,cat,name,desc,price,duration,active,note,emps,oldPrice,cur)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        f.replace(/\.json$/, ""), s.cat, s.name, s.desc || "",
        s.price == null ? null : s.price, s.duration == null ? null : s.duration,
        s.active === false ? 0 : 1, s.note || null, s.emps ? JSON.stringify(s.emps) : null,
        s.oldPrice == null ? null : s.oldPrice, s.cur || null);
    }
    for (const f of fs.readdirSync(path.join(seedDir, "employees"))) {
      const e = read(path.join(seedDir, "employees", f));
      db.prepare("INSERT OR REPLACE INTO employees(id,name,cats,title) VALUES(?,?,?,?)")
        .run(f.replace(/\.json$/, ""), e.name, JSON.stringify(e.cats || []), e.title || "");
    }
    for (const key of ["hours", "salon"]) {
      db.prepare("INSERT OR REPLACE INTO settings(key,json) VALUES(?,?)")
        .run(key, JSON.stringify(read(path.join(seedDir, "settings", key + ".json"))));
    }
  });
  tx();
  console.log("Baza je inicijalizovana podacima iz seed/ direktorijuma.");
}
try { db.exec("ALTER TABLE users ADD COLUMN consent TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE employees ADD COLUMN active INTEGER DEFAULT 1"); } catch (e) {}
try { db.exec("ALTER TABLE employees ADD COLUMN kind TEXT"); } catch (e) {}               // "aparat" = kolona za tretmane na aparatu
try { db.exec("ALTER TABLE services ADD COLUMN aparat INTEGER DEFAULT 0"); } catch (e) {} // 1 = radi se na aparatu, ne zauzima zaposlene
try { db.exec("ALTER TABLE services ADD COLUMN oldPrice INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN resetHash TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN resetExp TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE services ADD COLUMN cur TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN totalPriceEur INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN source TEXT"); } catch (e) {}          // 'online' | 'manual'
try { db.exec("ALTER TABLE bookings ADD COLUMN note TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN changed TEXT"); } catch (e) {}         // vreme poslednje izmene termina
try { db.exec("ALTER TABLE bookings ADD COLUMN sms24 INTEGER DEFAULT 0"); } catch (e) {}  // 0 čeka, 1 poslat, 2 nije potreban, 3 greška
try { db.exec("ALTER TABLE bookings ADD COLUMN smsDay INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE services ADD COLUMN packages TEXT"); } catch (e) {}       // JSON [{qty, price, label}] - paketi tretmana uz uslugu
/* radno vreme zaposlenih: day = "w0".."w6" (stalni raspored po danu u nedelji) ili "YYYY-MM-DD" (izmena za datum) */
db.exec(`CREATE TABLE IF NOT EXISTS emp_hours(
  emp TEXT, day TEXT, open TEXT, close TEXT, off INTEGER DEFAULT 0, PRIMARY KEY(emp, day))`);
db.exec(`CREATE TABLE IF NOT EXISTS vouchers(
  id TEXT PRIMARY KEY, buyerEmail TEXT, buyerName TEXT, buyerTel TEXT,
  recipient TEXT, serviceId TEXT, serviceName TEXT,
  amount INTEGER, message TEXT, status TEXT, created TEXT)`);
seedIfEmpty();
/* jednokratno: tajlandska i kombinovana masaža više nisu u ponudi */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_bez_tajlandske'").get()) {
  db.prepare("DELETE FROM services WHERE cat IN ('telo','masaze') AND (lower(name) LIKE '%tajland%' OR lower(name) LIKE '%kombinovan%')").run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_bez_tajlandske','true')").run();
}
/* jednokratno: duge crte u nazivima i opisima usluga zamenjene običnom crticom */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_bez_dugih_crta'").get()) {
  db.prepare("UPDATE services SET name=replace(replace(name,' \u2014 ',' - '),'\u2014','-'), desc=replace(replace(desc,' \u2014 ',' - '),'\u2014','-')").run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_bez_dugih_crta','true')").run();
}
/* jednokratno: stari termini bez naloga klijenta su ručni unosi */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_izvor_termina'").get()) {
  db.prepare("UPDATE bookings SET source = CASE WHEN ifnull(userEmail,'')='' OR userEmail NOT IN (SELECT email FROM users) THEN 'manual' ELSE 'online' END WHERE source IS NULL").run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_izvor_termina','true')").run();
}
/* kolona „Aparat": tretmani na aparatu se zakazuju tu i ne zauzimaju zaposlene (isti aparat ne prima dva klijenta) */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_aparat'").get()) {
  db.prepare("INSERT OR IGNORE INTO employees(id,name,cats,title,active,kind) VALUES('aparat','Aparat','[]','tretmani na aparatu',1,'aparat')").run();
  db.prepare("UPDATE services SET aparat=1 WHERE id IN ('presoterapija','ems-body','termo-cebe')").run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_aparat','true')").run();
}
/* jednokratno: besplatnu konsultaciju radi samo Andrijana */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_konsultacija_andrijana'").get()) {
  if (db.prepare("SELECT 1 FROM employees WHERE id='andrijana'").get())
    db.prepare(`UPDATE services SET emps='["andrijana"]' WHERE cat<>'edu' AND (id='konsultacija' OR lower(name) LIKE '%konsultacij%')`).run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_konsultacija_andrijana','true')").run();
}
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_crte_zaposlene'").get()) {
  db.prepare("UPDATE employees SET title=replace(replace(title,' \u2014 ',' - '),'\u2014','-')").run();
  db.prepare("INSERT INTO settings(key,json) VALUES('mig_crte_zaposlene','true')").run();
}
/* jednokratno (novembar 2026): cenovnik uskla\u0111en sa SrediMe. Vrednosti se \u010ditaju iz seed/services/<id>.json.
   Menjaju se samo navedena polja postoje\u0107ih tretmana; tretmani koji su falili se dodaju (ako ve\u0107 ne postoji
   tretman sa istim id-jem ili nazivom); ni\u0161ta se ne bri\u0161e. Ve\u0107 zakazani termini zadr\u017eavaju svoju cenu i trajanje. */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_sredime_2026_11'").get()) {
  const seedSvc = id => JSON.parse(fs.readFileSync(path.join(__dirname, "seed", "services", id + ".json"), "utf8"));
  const foldName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/g, "dj").replace(/\s+/g, " ").trim();
  const SET = {
    "paket-celulit": ["duration"],
    "akcija-hydra-14u1": ["price", "cur", "oldPrice"],
    "akcija-hydra-oxy": ["price", "cur", "oldPrice"],
    "la-bomba": ["price", "duration"],
    "endosfera-lica": ["price", "duration"],
    "hydrafacial-7u1": ["price"],
    "egzozomi": ["price"],
    "instant-fresh": ["price", "duration"],
    "ems-body": ["price"],
    "endosfera-telo": ["price", "note"],
    "maderoterapija": ["note"],
    "presoterapija": ["note"],
    "antistres-60": ["price"],
  };
  const NEW = ["botoks-maska", "bubble-pen", "darsonvalizacija", "lipoliza-podbratka",
    "mikrodermoabrazija-mezoporacija", "sminkanje-trepavice", "rf-mio-lift", "rf-lifting-vrat", "vocne-kiseline",
    "kolagen-niti-lice", "kolagen-niti-lice-vrat", "uz-spatula-masaza", "mikrodermoabrazija-masaza",
    "ems-endosfera", "inari-masaza", "kavitacija-lipolaseri", "lipoliza-noge", "lipomodelovanje-donji-ems",
    "lipomodelovanje-lipoliza-donji", "madero-preso-5-5", "body-sculpt", "paket-mrsavljenje", "vakum-brazilsko-5-5",
    "akcija-ems-tesla", "akcija-lipo-donji-ems", "akcija-lipo-gornji-ems", "akcija-neinvazivna-lipoliza", "akcija-preso-vacuslim"];
  db.transaction(() => {
    for (const [id, fields] of Object.entries(SET)) {
      const s = seedSvc(id);
      for (const f of fields) db.prepare(`UPDATE services SET ${f}=? WHERE id=?`).run(s[f] == null || s[f] === "" ? null : s[f], id);
    }
    const names = new Set(db.prepare("SELECT name FROM services").all().map(r => foldName(r.name)));
    for (const id of NEW) {
      const s = seedSvc(id);
      if (!db.prepare("SELECT 1 FROM services WHERE id=?").get(id) && !names.has(foldName(s.name))) {
        db.prepare(`INSERT INTO services(id,cat,name,desc,price,duration,active,note,emps,oldPrice,cur,aparat)
          VALUES(?,?,?,?,?,?,1,?,?,?,?,0)`).run(id, s.cat, s.name, s.desc || "", s.price, s.duration,
          s.note || null, s.emps ? JSON.stringify(s.emps) : null, s.oldPrice == null ? null : s.oldPrice, s.cur || null);
        names.add(foldName(s.name));
      }
      if (s.aparat) db.prepare("UPDATE services SET aparat=1 WHERE id=?").run(id); // radi se na aparatu (kolona \u201eAparat")
    }
    db.prepare("INSERT INTO settings(key,json) VALUES('mig_sredime_2026_11','true')").run();
  })();
}

/* jednokratno (novembar 2026): „Derma evolution - vo\u0107ne kiseline" vi\u0161e nije u ponudi (ve\u0107 zakazani termini ostaju);
   Bio sonda nosi i popularniji naziv Myo lift, a tretman kose ispravljen naziv. */
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_derma_evo_myo'").get()) {
  const foldName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/g, "dj").replace(/\s+/g, " ").trim();
  const seedName = id => JSON.parse(fs.readFileSync(path.join(__dirname, "seed", "services", id + ".json"), "utf8")).name;
  db.transaction(() => {
    for (const r of db.prepare("SELECT id,name FROM services").all()) {
      const n = foldName(r.name);
      if (r.id === "derma-evolution" || /^derma evolution/.test(n)) db.prepare("DELETE FROM services WHERE id=?").run(r.id);
      else if (r.id === "bio-sonda" || n === "bio sonda") db.prepare("UPDATE services SET name=? WHERE id=?").run(seedName("bio-sonda"), r.id);
      else if (r.id === "darsonvalizacija" || n === "darsonvalizacija + dermapen kose i vlasista")
        db.prepare("UPDATE services SET name=? WHERE id=?").run(seedName("darsonvalizacija"), r.id);
    }
    db.prepare("INSERT INTO settings(key,json) VALUES('mig_derma_evo_myo','true')").run();
  })();
}
const getSetting = k => { const r = db.prepare("SELECT json FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.json) : null; };
const setSetting = (k, v) => db.prepare("INSERT OR REPLACE INTO settings(key,json) VALUES(?,?)").run(k, JSON.stringify(v));
/* jednokratno: napomene tipa „Paket od 10 tretmana: 25.000 RSD" postaju paketi koje admin menja dugmetom „Paketi";
   na kartici se prikazuju isto kao do sada */
if (!getSetting("mig_packages_v1")) {
  const re = /^(Paket\b[^:]*): ([\d.]+) RSD$/i;
  for (const r of db.prepare("SELECT id,note FROM services WHERE note IS NOT NULL AND packages IS NULL").all()) {
    const m = re.exec(String(r.note).trim()); if (!m) continue;
    const price = Number(m[2].replace(/\./g, "")); if (!(price >= 0)) continue;
    const q = /(\d+)\s*tretman/i.exec(m[1]);
    db.prepare("UPDATE services SET packages=?, note=NULL WHERE id=?").run(JSON.stringify([{ qty: q ? +q[1] : null, price, label: m[1] }]), r.id);
  }
  setSetting("mig_packages_v1", 1);
}
const rezEmail = () => (getSetting("salon") || {}).rezEmail || "andrijanaobradovic5@gmail.com";

/* ---------------- e-mail (Gmail SMTP) ---------------- */
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require("nodemailer");
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "465", 10),
    secure: (process.env.SMTP_PORT || "465") === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log("E-mail slanje je UKLJUČENO (" + process.env.SMTP_USER + ").");
} else {
  console.log("E-mail slanje je ISKLJUČENO - postavite SMTP_USER i SMTP_PASS (Gmail App Password).");
}
function sendMail(to, subject, text) {
  if (!mailer || !to) return Promise.resolve(false);
  return mailer.sendMail({
    from: `"Beauty & Nutrition" <${process.env.SMTP_USER}>`,
    to, subject, text,
    replyTo: rezEmail(),
  }).then(() => true).catch(e => { console.error("Mail greška:", e.message); return false; });
}

/* ---------------- SMS (Infobip ili Twilio) ---------------- */
const SMS_PROVIDER = (process.env.SMS_PROVIDER ||
  (process.env.INFOBIP_API_KEY ? "infobip" : process.env.TWILIO_ACCOUNT_SID ? "twilio" : "")).toLowerCase();
const SMS_FROM = process.env.SMS_FROM || "BNSalon";
const smsOn = (SMS_PROVIDER === "infobip" && !!process.env.INFOBIP_API_KEY) ||
  (SMS_PROVIDER === "twilio" && !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN) ||
  SMS_PROVIDER === "log";
console.log(smsOn ? "SMS slanje je UKLJUČENO (" + SMS_PROVIDER + ", pošiljalac " + SMS_FROM + ")."
  : "SMS slanje je ISKLJUČENO - postavite INFOBIP_API_KEY ili TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN.");
/* broj telefona u međunarodnom formatu (+381…) ili null; prima 064 123 4567, +381 64…, 00381…, 381… */
function normTel(s) {
  let t = String(s || "").trim().replace(/[\s\-\/().]/g, "");
  if (!t) return null;
  if (t.startsWith("00")) t = "+" + t.slice(2);
  else if (t.startsWith("0")) t = "+381" + t.slice(1);
  else if (t.startsWith("381")) t = "+" + t;
  else if (/^6\d{7,9}$/.test(t)) t = "+381" + t;
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
}
/* SMS bez kvačica (č→c, đ→dj): ostaje u GSM kodiranju, 160 znakova po poruci umesto 70 */
const smsAscii = s => String(s).replace(/đ/g, "dj").replace(/Đ/g, "Dj").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E\n]/g, "");
async function sendSms(to, text) {
  const tel = normTel(to);
  if (!smsOn || !tel) return false;
  const body = smsAscii(text);
  try {
    if (SMS_PROVIDER === "infobip") {
      const base = (process.env.INFOBIP_BASE_URL || "https://api.infobip.com").replace(/\/+$/, "");
      const r = await fetch(base + "/sms/3/messages", {
        method: "POST",
        headers: { Authorization: "App " + process.env.INFOBIP_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ messages: [{ sender: SMS_FROM, destinations: [{ to: tel.slice(1) }], content: { text: body } }] }),
      });
      if (!r.ok) throw new Error("Infobip " + r.status + " " + (await r.text()).slice(0, 300));
    } else if (SMS_PROVIDER === "twilio") {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const form = new URLSearchParams({ To: tel, Body: body });
      if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
      else form.set("From", SMS_FROM);
      const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json", {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(sid + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (!r.ok) throw new Error("Twilio " + r.status + " " + (await r.text()).slice(0, 300));
    } else {
      console.log("SMS (probni režim) -> " + tel + ": " + body);
    }
    return true;
  } catch (e) { console.error("SMS greška:", e.message); return false; }
}

/* ---------------- pomoćne ---------------- */
const DOWS = ["Nedelja","Ponedeljak","Utorak","Sreda","Četvrtak","Petak","Subota"];
const MONTHS = ["jan","feb","mar","apr","maj","jun","jul","avg","sep","okt","nov","dec"];
const pad = n => String(n).padStart(2, "0");
const toMin = t => { const [a, b] = String(t).split(":").map(Number); return a * 60 + b; };
const toHM = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const dstr = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parseD = s => { const [a, b, c] = s.split("-").map(Number); return new Date(a, b - 1, c); };
const fmtD = s => { const d = parseD(s); return DOWS[d.getDay()] + ", " + d.getDate() + ". " + MONTHS[d.getMonth()] + " " + d.getFullYear() + "."; };
const durTxt = m => m >= 60 ? (Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "min" : "")) : (m + " min");
const RSD = n => new Intl.NumberFormat("sr-RS").format(n) + " RSD";
const money = (r, e) => [e ? new Intl.NumberFormat("sr-RS").format(e) + " €" : null, r ? RSD(r) : null].filter(Boolean).join(" + ") || RSD(0);
/* avans 30% je obavezan za sve usluge, tretmane i edukacije - uplata na tekući račun (podaci idu i u aplikaciju, /api/public) */
const AVANS = { pct: 30, racun: "160-6000001958308-27", primalac: "Andrijana Obradović", svrha: "Avans" };
const avansAmt = (r, e) => ({ r: Math.round((+r || 0) * AVANS.pct / 100), e: Math.round((+e || 0) * AVANS.pct) / 100 });
/* blok za mejl potvrde; bez iznosa ako cena nije poznata */
function avansText(r, e) {
  const a = avansAmt(r, e), has = !!(a.r || a.e), amt = has ? money(a.r, a.e) : AVANS.pct + "% cene usluge";
  return `💳 Obavezan avans ${AVANS.pct}%: ${amt}

Avans je obavezan za sve usluge i tretmane. Podaci za uplatu:
Primalac: ${AVANS.primalac}
Tekući račun: ${AVANS.racun}
Svrha uplate: ${AVANS.svrha}
Iznos: ${amt}

Preostali iznos plaća se u salonu.`;
}
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const validTime = s => /^\d{2}:\d{2}$/.test(s);

function scrypt(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString("hex");
}
function sign(email) {
  const body = Buffer.from(email).toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const good = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  return Buffer.from(body, "base64url").toString();
}

/* paketi tretmana uz uslugu: [{qty, price, label}] - qty ceo broj 1-200 ili null, price >= 0 (u valuti usluge),
   label do 80 znakova (prazan = „Paket od N tretmana"); bar jedno od qty/label; najviše 12 paketa. null = neispravno */
function cleanPackages(arr) {
  if (!Array.isArray(arr) || arr.length > 12) return null;
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") return null;
    const price = Math.round(Number(p.price)); if (!(price >= 0 && price <= 10000000)) return null;
    const label = String(p.label || "").trim().slice(0, 80);
    const qty = p.qty == null || p.qty === "" ? null : Number(p.qty);
    if (qty !== null && !(Number.isInteger(qty) && qty >= 1 && qty <= 200)) return null;
    if (qty === null && !label) return null;
    out.push({ qty, price, label });
  }
  return out;
}
const svcRow = r => r && ({ id: r.id, cat: r.cat, name: r.name, desc: r.desc, price: r.price, duration: r.duration, active: !!r.active, note: r.note || undefined, emps: r.emps ? JSON.parse(r.emps) : undefined, oldPrice: r.oldPrice == null ? undefined : r.oldPrice, cur: r.cur || undefined, aparat: r.aparat ? true : undefined, packages: r.packages ? JSON.parse(r.packages) : undefined });
const empRow = r => r && ({ id: r.id, name: r.name, cats: JSON.parse(r.cats || "[]"), title: r.title || "", active: r.active === 0 ? false : true, kind: r.kind || undefined });
const bkRow = r => r && ({ ...r, services: JSON.parse(r.services), reminderSent: !!r.reminderSent, source: r.source || "online", sms24: r.sms24 || 0, smsDay: r.smsDay || 0 });
/* stavka rezervacije sa paketom nosi pkg {qty,label}; u mejlovima i spiskovima piše „Naziv – Paket od 5 tretmana"
   (SMS ostaje samo naziv: kraći je, a crta nije u GSM skupu znakova) */
const pkgName = p => String(p.label || "").trim() || ("Paket od " + p.qty + " tretmana");
const svcLine = x => x.name + (x.pkg ? " – " + pkgName(x.pkg) : "");
/* tretman na aparatu radi samo kolona „Aparat"; aparat ne radi ostale tretmane */
const isDev = e => !!e && e.kind === "aparat";
const performs = (e, s) => s.aparat ? isDev(e) : !isDev(e) && (Array.isArray(s.emps) ? s.emps.includes(e.id) : (e.cats || []).includes(s.cat));
const isDevId = id => !!db.prepare("SELECT 1 FROM employees WHERE id=? AND kind='aparat'").get(String(id || ""));
/* red o zaposlenoj u mejlovima; za aparat piše „Tretman na aparatu" */
const empLine = (b, short) => isDevId(b.employee)
  ? "⚙️ Tretman na aparatu" + (/^aparat$/i.test(b.employeeName || "") ? "" : ": " + b.employeeName)
  : "👩 " + (short ? "" : "Kozmetičarka: ") + b.employeeName;

function dayHours(dateStr) {
  const H = getSetting("hours") || {};
  const h = H[String(parseD(dateStr).getDay())];
  if (!h || h.closed) return null;
  return { open: toMin(h.open), close: toMin(h.close) };
}
function busyFor(dateStr, employee, exceptId) {
  return db.prepare("SELECT start,end FROM bookings WHERE date=? AND employee=? AND status IN ('zakazano','ceka') AND id<>?")
    .all(dateStr, employee, exceptId || "").map(b => [toMin(b.start), toMin(b.end)]);
}
/* radno vreme zaposlene za datum: izmena za taj datum, pa stalni raspored, pa radno vreme salona;
   uvek u okviru radnog vremena salona. null = ne radi. */
const ehGet = db.prepare("SELECT * FROM emp_hours WHERE emp=? AND day=?");
function empHours(empId, dateStr) {
  const salon = dayHours(dateStr);
  if (!salon) return null;
  const r = ehGet.get(empId, dateStr) || ehGet.get(empId, "w" + parseD(dateStr).getDay());
  if (!r) return salon;
  if (r.off) return null;
  const open = Math.max(salon.open, toMin(r.open)), close = Math.min(salon.close, toMin(r.close));
  return open < close ? { open, close } : null;
}
const worksAt = (empId, dateStr, start, dur) => { const h = empHours(empId, dateStr); return !!h && start >= h.open && start + dur <= h.close; };
function freeAt(busy, start, dur) {
  const end = start + dur;
  return !busy.some(([s, e]) => !(end <= s || start >= e));
}

const insBookingStmt = db.prepare(`INSERT INTO bookings(id,userEmail,userName,userTel,services,employee,employeeName,date,start,end,totalPrice,totalPriceEur,totalDuration,status,reminderSent,created,source,note,sms24,smsDay)
  VALUES(@id,@userEmail,@userName,@userTel,@servicesJson,@employee,@employeeName,@date,@start,@end,@totalPrice,@totalPriceEur,@totalDuration,@status,@reminderSent,@created,@source,@note,0,0)`);
const insBooking = b => insBookingStmt.run({ ...b, servicesJson: JSON.stringify(b.services), note: b.note || null });

/* ---------------- app ---------------- */
const app = express();
app.set("trust proxy", 1);
/* sopstveni domen: kad je SITE_URL podešen (npr. https://beautyandnutrition.app), stara adresa
   *.onrender.com trajno preusmerava na njega, sa istom putanjom (stari linkovi i QR kodovi i dalje rade).
   /zdravlje ostaje na staroj adresi zbog provere rada (pinger). */
const SITE_URL = String(process.env.SITE_URL || "").trim().replace(/\/+$/, "");
const SITE_HOST = (() => { try { return SITE_URL ? new URL(SITE_URL).host.toLowerCase() : ""; } catch (e) { return ""; } })();
if (SITE_URL && !SITE_HOST) console.log("SITE_URL nije ispravna adresa (primer: https://beautyandnutrition.app) - preusmeravanje je isključeno.");
if (SITE_HOST) {
  console.log("Adresa sajta: " + SITE_URL + " (onrender.com adresa preusmerava na nju).");
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase().split(":")[0];
    if (host.endsWith(".onrender.com") && host !== SITE_HOST && req.path !== "/zdravlje")  // bez petlje ako je SITE_URL i sam onrender adresa
      return res.redirect(req.method === "GET" || req.method === "HEAD" ? 301 : 308, "https://" + SITE_HOST + req.originalUrl);
    next();
  });
}
app.use(express.json());
app.use(cookieParser());
app.use(compression());  // gzip: strana, cenovnik (/api/public) i ostali odgovori idu do 4x manji
/* keširanje: slike, ikone i fontovi 1 dan (posle toga pregledač proverava da li su promenjeni);
   HTML, JS i JSON se proveravaju pri svakom otvaranju, pa se nova verzija sajta vidi odmah posle postavljanja */
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  setHeaders: (res, file) => { if (/\.(html|js|json|webmanifest)$/i.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));

function me(req) {
  const email = verify(req.cookies.bn);
  if (!email) return null;
  const u = db.prepare("SELECT email,ime,prezime,telefon,consent FROM users WHERE email=?").get(email);
  if (!u) return null;
  return { email: u.email, ime: u.ime, prezime: u.prezime, telefon: u.telefon, admin: ADMIN_EMAILS.includes(email), staff: STAFF_EMAILS.includes(email), needConsent: !u.consent };
}
const auth = (req, res, next) => { const u = me(req); if (!u) return res.status(401).json({ error: "Prijavite se." }); req.user = u; next(); };
const staff = (req, res, next) => { if (!req.user.admin && !req.user.staff) return res.status(403).json({ error: "Samo osoblje salona." }); next(); };
const admin = (req, res, next) => { if (!req.user.admin) return res.status(403).json({ error: "Samo administrator." }); next(); };

/* ---- javni podaci ---- */
app.get("/api/public", (req, res) => {
  res.json({
    services: db.prepare("SELECT * FROM services").all().map(svcRow),
    employees: db.prepare("SELECT * FROM employees").all().map(empRow),
    hours: getSetting("hours"),
    salon: (({ rezEmail, phone, address }) => ({ rezEmail, phone, address }))(getSetting("salon") || {}),
    mailEnabled: !!mailer,
    smsEnabled: smsOn,
    avans: AVANS,
  });
});
/* radno vreme salona i svake zaposlene za dan (za prikaz slobodnih termina) */
app.get("/api/work", (req, res) => {
  const { date } = req.query;
  if (!validDate(date)) return res.status(400).json({ error: "Neispravan datum." });
  const h = dayHours(date), emps = {};
  for (const e of db.prepare("SELECT id FROM employees").all()) {
    const w = empHours(e.id, date);
    emps[e.id] = w ? { open: toHM(w.open), close: toHM(w.close) } : null;
  }
  res.json({ salon: h ? { open: toHM(h.open), close: toHM(h.close) } : null, emps });
});
/* zauzeti intervali za dan (bez ličnih podataka) */
app.get("/api/day", (req, res) => {
  const { date } = req.query;
  if (!validDate(date)) return res.status(400).json({ error: "Neispravan datum." });
  res.json(db.prepare("SELECT employee,start,end FROM bookings WHERE date=? AND status IN ('zakazano','ceka')").all(date));
});

/* ---- nalozi ---- */
app.post("/api/register", async (req, res) => {
  let { ime, prezime, email, telefon, pw } = req.body || {};
  ime = String(ime || "").trim(); prezime = String(prezime || "").trim();
  email = String(email || "").trim().toLowerCase(); telefon = String(telefon || "").trim();
  if (!ime || !prezime || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(pw || "").length < 6)
    return res.status(400).json({ error: "Popunite ime, prezime i ispravan e-mail; lozinka najmanje 6 karaktera." });
  if (!telefon) return res.status(400).json({ error: "Unesite broj telefona - bez njega registracija nije moguća.", field: "tel" });
  if (!normTel(telefon)) return res.status(400).json({ error: "Broj telefona nije ispravan - upišite ga npr. kao 064 123 4567.", field: "tel" });
  if ((req.body || {}).consent !== true)
    return res.status(400).json({ error: "Potrebno je da potvrdite da ste upoznati sa Politikom Privatnosti." });
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email))
    return res.status(409).json({ error: "Nalog sa ovom e-mail adresom već postoji - prijavite se.", exists: true });
  const salt = crypto.randomBytes(12).toString("hex");
  db.prepare("INSERT INTO users(email,ime,prezime,telefon,salt,hash,created,consent) VALUES(?,?,?,?,?,?,?,?)")
    .run(email, ime, prezime, telefon, salt, scrypt(String(pw), salt), new Date().toISOString(), new Date().toISOString());
  res.cookie("bn", sign(email), { httpOnly: true, sameSite: "lax", maxAge: 180 * 864e5 });
  res.json({ me: { email, ime, prezime, telefon, admin: ADMIN_EMAILS.includes(email), staff: STAFF_EMAILS.includes(email) } });
});
app.post("/api/login", (req, res) => {
  const ident = String((req.body || {}).ident || "").trim();
  const pw = String((req.body || {}).pw || "");
  if (!ident || !pw) return res.status(400).json({ error: "Unesite e-mail ili ime i prezime, i lozinku." });
  let u = null;
  if (ident.includes("@")) u = db.prepare("SELECT * FROM users WHERE email=?").get(ident.toLowerCase());
  else u = db.prepare("SELECT * FROM users WHERE lower(ime||' '||prezime)=?").get(ident.toLowerCase());
  if (!u) return res.status(404).json({ error: "Nalog nije pronađen. Proverite unos ili se registrujte." });
  if (scrypt(pw, u.salt) !== u.hash) return res.status(401).json({ error: "Pogrešna lozinka." });
  res.cookie("bn", sign(u.email), { httpOnly: true, sameSite: "lax", maxAge: 180 * 864e5 });
  res.json({ me: { email: u.email, ime: u.ime, prezime: u.prezime, telefon: u.telefon, admin: ADMIN_EMAILS.includes(u.email), staff: STAFF_EMAILS.includes(u.email), needConsent: !u.consent } });
});
app.post("/api/logout", (req, res) => { res.clearCookie("bn"); res.json({ ok: true }); });

app.post("/api/forgot", (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Unesite ispravnu e-mail adresu." });
  if (!mailer && !smsOn) return res.status(503).json({ error: "Slanje mejlova još nije podešeno - javite se salonu na " + rezEmail() + " radi nove lozinke." });
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  /* novi link najranije 2 minuta posle prethodnog (zaštita od zatrpavanja mejlovima i SMS-ovima) */
  const recent = u && u.resetExp && new Date(u.resetExp).getTime() - 58 * 60 * 1000 > Date.now();
  if (u && !recent) {
    const token = crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE users SET resetHash=?, resetExp=? WHERE email=?").run(hash, exp, email);
    const proto = req.protocol || "https";   // iza Render proksija: https (trust proxy)
    const link = (SITE_HOST ? "https://" + SITE_HOST : proto + "://" + req.get("host")) + "/?reset=" + token;
    if (smsOn && normTel(u.telefon)) sendSms(u.telefon, "Beauty & Nutrition: link za novu lozinku (vazi 1 sat): " + link);
    if (mailer) sendMail(email, "Resetovanje lozinke - Beauty & Nutrition",
`Poštovana/i ${u.ime},

primili smo zahtev za novu lozinku za vaš nalog. Kliknite na link (važi 1 sat):

${link}

Ako niste vi tražili promenu, slobodno ignorišite ovu poruku - lozinka ostaje nepromenjena.

Beauty & Nutrition`);
  }
  res.json({ ok: true, mail: !!mailer, sms: smsOn });
});
app.post("/api/reset", (req, res) => {
  const token = String((req.body || {}).token || "");
  const pw = String((req.body || {}).pw || "");
  if (pw.length < 6) return res.status(400).json({ error: "Lozinka mora imati najmanje 6 karaktera." });
  if (!/^[0-9a-f]{48}$/.test(token)) return res.status(400).json({ error: "Link za resetovanje nije ispravan." });
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const u = db.prepare("SELECT * FROM users WHERE resetHash=?").get(hash);
  if (!u || !u.resetExp || u.resetExp < new Date().toISOString())
    return res.status(400).json({ error: "Link za resetovanje je istekao - zatražite novi." });
  const salt = crypto.randomBytes(12).toString("hex");
  db.prepare("UPDATE users SET salt=?, hash=?, resetHash=NULL, resetExp=NULL WHERE email=?")
    .run(salt, scrypt(pw, salt), u.email);
  res.cookie("bn", sign(u.email), { httpOnly: true, sameSite: "lax", maxAge: 180 * 864e5 });
  res.json({ me: { email: u.email, ime: u.ime, prezime: u.prezime, telefon: u.telefon, admin: ADMIN_EMAILS.includes(u.email), staff: STAFF_EMAILS.includes(u.email) } });
});
app.get("/api/me", (req, res) => res.json({ me: me(req) }));
/* dopuna broja telefona (stari nalozi bez broja) */
app.post("/api/profile", auth, (req, res) => {
  const telefon = String((req.body || {}).telefon || "").trim();
  if (!normTel(telefon)) return res.status(400).json({ error: "Broj telefona nije ispravan - upišite ga npr. kao 064 123 4567." });
  db.prepare("UPDATE users SET telefon=? WHERE email=?").run(telefon, req.user.email);
  db.prepare("UPDATE bookings SET userTel=? WHERE userEmail=? AND ifnull(userTel,'')='' AND date>=?").run(telefon, req.user.email, dstr(new Date()));
  res.json({ me: me(req) });
});
app.post("/api/consent", auth, (req, res) => {
  db.prepare("UPDATE users SET consent=? WHERE email=?").run(new Date().toISOString(), req.user.email);
  res.json({ ok: true });
});

/* ---- rezervacije ---- */
app.get("/api/my", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM bookings WHERE userEmail=? ORDER BY date,start").all(req.user.email).map(bkRow));
});

app.post("/api/bookings", auth, (req, res) => {
  const { services: items, employee: wantEmp, date, start } = req.body || {};
  if (!Array.isArray(items) || !items.length || !validDate(date) || !validTime(start))
    return res.status(400).json({ error: "Nepotpuni podaci rezervacije." });
  if (!normTel(req.user.telefon))
    return res.status(400).json({ error: "Dodajte broj telefona u nalog - na njega stižu SMS podsetnici za termin.", code: "phone" });
  /* stavka je id usluge ili {id, pkg:{qty,label,price}} kad je klijent na kartici izabrao paket; paket mora i dalje da
     postoji uz uslugu sa istom cenom (ako ga je salon u međuvremenu izmenio, klijent bira ponovo). Stavka sa paketom
     nosi cenu paketa, pa ukupna cena i avans važe za paket; trajanje je jedan dolazak. */
  const services = [];
  for (const it of items) {
    const obj = !!it && typeof it === "object";
    const s = svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(String(obj ? it.id : it)));
    if (!s || !s.active || s.cat === "edu" || !s.duration || s.price == null)
      return res.status(400).json({ error: "Izabrana usluga nije dostupna za online zakazivanje." });
    const w = obj && it.pkg && typeof it.pkg === "object" ? it.pkg : null;
    if (!w) { services.push(s); continue; }
    const num = v => (v == null || v === "" ? null : +v);
    const p = (s.packages || []).find(p => +p.price === num(w.price) && num(p.qty) === num(w.qty) && String(p.label || "").trim() === String(w.label || "").trim());
    if (!p) return res.status(409).json({ error: "Paketi za „" + s.name + "\" su u međuvremenu izmenjeni - osvežite stranicu i izaberite ponovo." });
    services.push({ ...s, price: p.price, pkg: { qty: p.qty == null ? null : p.qty, label: String(p.label || "").trim() } });
  }
  const dur = services.reduce((a, s) => a + s.duration, 0);
  const priceR = services.reduce((a, s) => a + (s.cur === "EUR" ? 0 : s.price), 0);
  const priceE = services.reduce((a, s) => a + (s.cur === "EUR" ? s.price : 0), 0);
  const h = dayHours(date);
  const t = toMin(start);
  if (!h || t < h.open || t + dur > h.close)
    return res.status(409).json({ error: "Termin je van radnog vremena salona." });
  const today = dstr(new Date());
  if (date < today) return res.status(400).json({ error: "Datum je u prošlosti." });
  if (date === today) {
    const now = new Date(); if (t < now.getHours() * 60 + now.getMinutes() + 60)
      return res.status(409).json({ error: "Termini se zakazuju najmanje sat vremena unapred." });
  }
  const emps = db.prepare("SELECT * FROM employees").all().map(empRow)
    .filter(e => e.active !== false && services.every(s => performs(e, s)));
  if (!emps.length) return res.status(400).json({ error: "Nijedna zaposlena ne izvodi sve izabrane tretmane u jednoj poseti." });
  let chosen = null;
  if (wantEmp && wantEmp !== "__any") {
    chosen = emps.find(e => e.id === wantEmp);
    if (!chosen) return res.status(400).json({ error: "Izabrana zaposlena ne izvodi sve izabrane tretmane." });
    if (!worksAt(chosen.id, date, t, dur)) return res.status(409).json({ error: chosen.name + " ne radi u tom terminu - izaberite drugo vreme." });
    if (!freeAt(busyFor(date, chosen.id), t, dur)) chosen = null;
  } else {
    chosen = emps.find(e => worksAt(e.id, date, t, dur) && freeAt(busyFor(date, e.id), t, dur)) || null;
  }
  if (!chosen) return res.status(409).json({ error: "Ovaj termin je upravo zauzet - izaberite drugi." });

  const b = {
    id: crypto.randomUUID(),
    userEmail: req.user.email, userName: req.user.ime + " " + req.user.prezime, userTel: req.user.telefon || "",
    services: services.map(s => ({ id: s.id, name: s.name, price: s.price, duration: s.duration, cat: s.cat, cur: s.cur || null, ...(s.pkg ? { pkg: s.pkg } : {}) })),
    employee: chosen.id, employeeName: chosen.name,
    date, start: toHM(t), end: toHM(t + dur),
    totalPrice: priceR, totalPriceEur: priceE, totalDuration: dur, status: "ceka", reminderSent: 0,
    created: new Date().toISOString(), source: "online", note: null,
  };
  insBooking(b);

  /* online rezervacija je zahtev: termin je rezervisan (blokira slot) dok ga salon ne potvrdi ili odbije u adminu;
     podaci za uplatu avansa i podsetnici idu tek posle potvrde */
  const list = b.services.map(s => "• " + svcLine(s)).join("\n");
  const av = (a => money(a.r, a.e))(avansAmt(b.totalPrice, b.totalPriceEur || 0));
  sendMail(b.userEmail, "Zahtev za termin je primljen - Beauty & Nutrition",
`Poštovana/i ${b.userName},

vaš zahtev za termin je primljen i čeka potvrdu salona:

📅 ${fmtD(b.date)} u ${b.start}
${list}
${empLine(b)}
⏱ Trajanje: ${durTxt(b.totalDuration)} · Cena: ${money(b.totalPrice, b.totalPriceEur || 0)}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

Termin je rezervisan za vas dok ga salon ne potvrdi ili odbije - obaveštenje stiže na ovaj e-mail, obično u toku dana. Uz potvrdu stižu i podaci za uplatu obaveznog avansa ${AVANS.pct}%: ${av}. Do potvrde se podsetnici ne šalju.

Za pitanja nam pišite na ${rezEmail()} ili pozovite +381 64 93 55 003.

Srdačno,
Beauty & Nutrition`);
  sendMail(rezEmail(), `Novi zahtev za termin: ${b.date} u ${b.start} - ${b.userName}`,
`Novi zahtev za termin u aplikaciji - potvrdite ili odbijte u Admin → Rezervacije${SITE_URL ? " (" + SITE_URL + ")" : ""}:

Klijent: ${b.userName} (${b.userEmail}${b.userTel ? ", " + b.userTel : ""})
Termin: ${fmtD(b.date)} u ${b.start}–${b.end}
${empLine(b).replace(/^\S+ /, "")}
Usluge:
${list}
Ukupno: ${money(b.totalPrice, b.totalPriceEur || 0)} · ${durTxt(b.totalDuration)}
Avans (${AVANS.pct}%): ${av}

Dok se zahtev ne potvrdi ili odbije, termin je zauzet u kalendaru. Klijent dobija e-mail sa odlukom (uz potvrdu i podatke za uplatu avansa).`);

  res.json({ booking: { ...b, reminderSent: false } });
});

app.post("/api/bookings/:id/cancel", auth, (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) return res.status(404).json({ error: "Rezervacija nije pronađena." });
  const isStaffUser = req.user.admin || req.user.staff;
  if (b.userEmail !== req.user.email && !isStaffUser) return res.status(403).json({ error: "Nije dozvoljeno." });
  if (b.status !== "zakazano" && b.status !== "ceka") return res.json({ ok: true });  /* već otkazano ili odbijeno */
  db.prepare("UPDATE bookings SET status='otkazano' WHERE id=?").run(b.id);
  const bySalon = isStaffUser && b.userEmail !== req.user.email;
  if (b.status === "ceka") {
    /* zahtev koji još nije potvrđen: klijent ga povlači (ili ga salon otkazuje umesto da ga odbije) */
    sendMail(rezEmail(), `Povučen zahtev za termin: ${b.date} u ${b.start} - ${b.userName}`,
      `Zahtev za termin je ${bySalon ? "otkazao salon" : "povukao klijent"}:\n\n${b.userName} · ${fmtD(b.date)} u ${b.start} · ${b.services.map(svcLine).join(", ")}`);
  } else {
    sendMail(rezEmail(), `Otkazana rezervacija: ${b.date} u ${b.start} - ${b.userName}`,
      `Rezervacija je otkazana (${bySalon ? "od strane salona" : "od strane klijenta"}):\n\n` +
      `${b.userName} · ${fmtD(b.date)} u ${b.start} · ${b.services.map(svcLine).join(", ")}`);
  }
  if (bySalon)
    sendMail(b.userEmail, "Otkazan termin - Beauty & Nutrition",
      `Poštovana/i ${b.userName},\n\nnažalost, termin ${fmtD(b.date)} u ${b.start} je otkazan. Molimo vas da zakažete novi termin u aplikaciji ili nas pozovete na +381 64 93 55 003.\n\nBeauty & Nutrition`);
  res.json({ ok: true });
});

/* ---- admin ---- */
app.get("/api/admin/bookings", auth, staff, (req, res) => {
  const from = validDate(req.query.from || "") ? req.query.from : dstr(new Date());
  res.json(db.prepare("SELECT * FROM bookings WHERE date>=? ORDER BY date,start").all(from).map(bkRow));
});
app.post("/api/admin/hours", auth, admin, (req, res) => {
  const H = req.body || {};
  for (const k of ["0","1","2","3","4","5","6"]) {
    const h = H[k];
    if (!h || (h.closed !== true && !(validTime(h.open) && validTime(h.close) && toMin(h.open) < toMin(h.close))))
      return res.status(400).json({ error: "Neispravno radno vreme za: " + DOWS[+k] });
  }
  setSetting("hours", H);
  res.json({ hours: getSetting("hours") });
});
app.post("/api/admin/service/:id", auth, admin, (req, res) => {
  const s = db.prepare("SELECT * FROM services WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Usluga nije pronađena." });
  /* menja se samo ono što je poslato: lista u adminu šalje cenu, trajanje, aktivnost i „na aparatu";
     prozor „Paketi" šalje pakete i napomenu */
  const { price, duration, active, aparat, packages, note } = req.body || {};
  const pk = packages === undefined ? undefined : cleanPackages(packages);
  if (pk === null) return res.status(400).json({ error: "Proverite pakete: svaki ima cenu i broj tretmana ili naziv (najviše 12 paketa)." });
  if (s.cat !== "edu" && (price !== undefined || duration !== undefined)) {
    if (!(Number(price) >= 0) || !(Number(duration) > 0)) return res.status(400).json({ error: "Proverite cenu i trajanje." });
    db.prepare("UPDATE services SET price=?,duration=? WHERE id=?").run(Math.round(Number(price)), Math.round(Number(duration)), s.id);
  }
  if (active !== undefined) db.prepare("UPDATE services SET active=? WHERE id=?").run(active ? 1 : 0, s.id);
  if (s.cat !== "edu" && typeof aparat === "boolean") db.prepare("UPDATE services SET aparat=? WHERE id=?").run(aparat ? 1 : 0, s.id);
  if (pk) db.prepare("UPDATE services SET packages=? WHERE id=?").run(pk.length ? JSON.stringify(pk) : null, s.id);
  if (typeof note === "string") db.prepare("UPDATE services SET note=? WHERE id=?").run(note.trim().slice(0, 120) || null, s.id);
  res.json({ service: svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(s.id)) });
});
app.post("/api/admin/employee/:id", auth, admin, (req, res) => {
  const e = db.prepare("SELECT * FROM employees WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Zaposlena nije pronađena." });
  db.prepare("UPDATE employees SET active=? WHERE id=?").run(req.body && req.body.active ? 1 : 0, e.id);
  res.json({ employee: empRow(db.prepare("SELECT * FROM employees WHERE id=?").get(e.id)) });
});
const SVC_CATS = ["lice", "telo", "masaze", "akcije", "edu"];
app.post("/api/admin/service-new", auth, admin, (req, res) => {
  const { name, desc, price, oldPrice, duration, emps } = req.body || {};
  const aparat = !!(req.body || {}).aparat;
  const cat = SVC_CATS.includes((req.body || {}).cat) ? req.body.cat : "akcije";
  const nm = String(name || "").trim();
  if (!nm) return res.status(400).json({ error: "Unesite naziv usluge." });
  const ids = (Array.isArray(emps) ? emps : []).map(String)
    .filter(id => db.prepare("SELECT 1 FROM employees WHERE id=?").get(id));
  const id = cat + "-" + Date.now();
  if (cat === "edu") {
    db.prepare(`INSERT INTO services(id,cat,name,desc,price,duration,active,note,emps,oldPrice)
      VALUES(?,?,?,?,NULL,NULL,1,?,NULL,NULL)`)
      .run(id, cat, nm, String(desc || "").trim(), "Cena i termini: na upit");
    return res.json({ service: svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(id)) });
  }
  const pr = Math.round(Number(price)); const d = Math.round(Number(duration));
  if (!(pr >= 0) || !(d > 0)) return res.status(400).json({ error: "Unesite naziv, cenu i trajanje." });
  if (cat === "akcije" && !ids.length && !aparat) return res.status(400).json({ error: "Označite bar jednu zaposlenu." });
  let op = Math.round(Number(oldPrice) || 0); if (!(op > pr)) op = null;
  db.prepare(`INSERT INTO services(id,cat,name,desc,price,duration,active,note,emps,oldPrice,aparat)
    VALUES(?,?,?,?,?,?,1,NULL,?,?,?)`)
    .run(id, cat, nm, String(desc || "").trim(), pr, d, ids.length ? JSON.stringify(ids) : null, op, aparat ? 1 : 0);
  res.json({ service: svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(id)) });
});
app.post("/api/admin/service-del/:id", auth, admin, (req, res) => {
  const s = db.prepare("SELECT * FROM services WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Usluga nije pronađena." });
  db.prepare("DELETE FROM services WHERE id=?").run(s.id);
  res.json({ ok: true });
});
app.post("/api/vouchers", auth, (req, res) => {
  const { recipient, serviceId, amount, message } = req.body || {};
  const rec = String(recipient || "").trim();
  let amt = Math.round(Number(amount));
  if (!rec) return res.status(400).json({ error: "Unesite ime osobe kojoj poklanjate vau\u010der." });
  let sName = null, sId = null;
  if (serviceId) {
    const s = svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(String(serviceId)));
    if (!s || s.active === false || s.cat === "edu" || s.cur === "EUR") return res.status(400).json({ error: "Izabrana usluga nije dostupna." });
    sName = s.name; sId = s.id;
    if (!(amt > 0)) amt = s.price;
  }
  if (!(amt >= 1000)) return res.status(400).json({ error: "Najmanji iznos vau\u010dera je 1.000 RSD." });
  if (amt > 500000) return res.status(400).json({ error: "Proverite iznos vau\u010dera." });
  const v = { id: crypto.randomUUID(), buyerEmail: req.user.email, buyerName: req.user.ime + " " + req.user.prezime,
    buyerTel: req.user.telefon || "", recipient: rec, serviceId: sId, serviceName: sName,
    amount: amt, message: String(message || "").trim(), status: "novo", created: new Date().toISOString() };
  db.prepare(`INSERT INTO vouchers(id,buyerEmail,buyerName,buyerTel,recipient,serviceId,serviceName,amount,message,status,created)
    VALUES(@id,@buyerEmail,@buyerName,@buyerTel,@recipient,@serviceId,@serviceName,@amount,@message,@status,@created)`).run(v);
  sendMail(rezEmail(), "Porud\u017ebina poklon vau\u010dera - " + rec + " (" + RSD(amt) + ")",
`Nova porud\u017ebina poklon vau\u010dera:

Za: ${rec}
Iznos: ${RSD(amt)}${sName ? "\nUsluga: " + sName : "\n(iznos po \u017eelji - primalac bira tretmane)"}
${v.message ? "Posveta: " + v.message + "\n" : ""}Kupac: ${v.buyerName} (${v.buyerEmail}${v.buyerTel ? ", " + v.buyerTel : ""})

Kontaktirajte kupca radi uplate i preuzimanja.`);
  sendMail(v.buyerEmail, "Porud\u017ebina vau\u010dera je primljena - Beauty & Nutrition",
`Po\u0161tovana/i ${v.buyerName},

primili smo va\u0161u porud\u017ebinu poklon vau\u010dera:

Za: ${rec}
Iznos: ${RSD(amt)}${sName ? "\nUsluga: " + sName : ""}

Javi\u0107emo vam se u najkra\u0107em roku radi uplate i preuzimanja vau\u010dera.
Kontakt: ${rezEmail()} \u00b7 +381 64 93 55 003

Beauty & Nutrition`);
  res.json({ voucher: v });
});
app.get("/api/admin/vouchers", auth, staff, (req, res) => {
  res.json(db.prepare("SELECT * FROM vouchers ORDER BY created DESC").all());
});
app.post("/api/admin/vouchers/:id", auth, staff, (req, res) => {
  const v = db.prepare("SELECT * FROM vouchers WHERE id=?").get(req.params.id);
  if (!v) return res.status(404).json({ error: "Vau\u010der nije prona\u0111en." });
  const st = (req.body || {}).status === "obra\u0111en" ? "obra\u0111en" : "novo";
  db.prepare("UPDATE vouchers SET status=? WHERE id=?").run(st, v.id);
  res.json({ ok: true, status: st });
});
app.get("/api/admin/backup", auth, admin, (req, res) => {
  const data = {
    exportedAt: new Date().toISOString(),
    settings: { hours: getSetting("hours"), salon: getSetting("salon") },
    employees: db.prepare("SELECT * FROM employees").all().map(empRow),
    services: db.prepare("SELECT * FROM services").all().map(svcRow),
    users: db.prepare("SELECT * FROM users").all(),
    bookings: db.prepare("SELECT * FROM bookings").all().map(bkRow),
    empHours: db.prepare("SELECT * FROM emp_hours").all(),
  };
  res.setHeader("Content-Disposition", 'attachment; filename="bn-kopija-' + dstr(new Date()) + '.json"');
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, 1));
});
app.post("/api/admin/remind/:id", auth, staff, async (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) return res.status(404).json({ error: "Rezervacija nije pronađena." });
  let sent = false;
  if (req.body && req.body.send) sent = await sendMail(b.userEmail, "Podsetnik za sutrašnji termin - Beauty & Nutrition", reminderText(b));
  db.prepare("UPDATE bookings SET reminderSent=1 WHERE id=?").run(b.id);
  res.json({ ok: true, sent });
});

/* ---- ručni unos: klijent + jedan ili više blokova (zaposlena, datum, vreme, do 3 usluge) ---- */
const MANUAL_CATS = ["lice", "telo", "masaze", "akcije"];
function manualServices(items) {
  if (!Array.isArray(items) || !items.length) return { error: "Dodajte bar jednu uslugu." };
  if (items.length > MAX_PER_EMP) return { error: "Najviše " + MAX_PER_EMP + " usluge po klijentu kod jedne zaposlene." };
  const out = [];
  for (const it of items) {
    const d = Math.round(Number(it && it.duration));
    const pr = Math.max(0, Math.round(Number(it && it.price) || 0));
    if (!(d > 0) || d > 600) return { error: "Proverite trajanje usluga." };
    const s = it.serviceId ? svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(String(it.serviceId))) : null;
    if (s && s.cat !== "edu") { out.push({ id: s.id, name: s.name, price: pr, duration: d, cat: s.cat, cur: s.cur || null }); continue; }
    const name = String((it && it.label) || "").trim().slice(0, 120);
    if (!name) return { error: "Izaberite uslugu ili upišite naziv paketa." };
    out.push({ id: "manual", name, price: pr, duration: d, cat: MANUAL_CATS.includes(it.cat) ? it.cat : "telo", cur: null });
  }
  return { services: out };
}
/* koliko usluga klijent (isti telefon ili e-mail) već ima kod zaposlene tog dana */
function clientSvcCount(date, empId, tel, mail, exceptId) {
  const t = normTel(tel), m = String(mail || "").toLowerCase();
  if (!t && !m) return 0;
  return db.prepare("SELECT * FROM bookings WHERE date=? AND employee=? AND status IN ('zakazano','ceka') AND id<>?").all(date, empId, exceptId || "")
    .map(bkRow).filter(b => (t && normTel(b.userTel) === t) || (m && String(b.userEmail || "").toLowerCase() === m))
    .reduce((a, b) => a + b.services.length, 0);
}
/* drugi termin istog klijenta (telefon ili e-mail) koji se vremenski preklapa - klijent ne može biti na dva mesta */
function clientClash(date, t, dur, tel, mail, exceptId) {
  const tn = normTel(tel), m = String(mail || "").toLowerCase();
  if (!tn && !m) return null;
  return db.prepare("SELECT * FROM bookings WHERE date=? AND status IN ('zakazano','ceka') AND id<>?").all(date, exceptId || "")
    .find(b => ((tn && normTel(b.userTel) === tn) || (m && String(b.userEmail || "").toLowerCase() === m))
      && !(t + dur <= toMin(b.start) || t >= toMin(b.end))) || null;
}
function checkBlock(bl, client, exceptId) {
  bl = bl || {};
  const date = String(bl.date || ""), start = String(bl.start || "");
  if (!validDate(date) || !validTime(start)) return { error: "Proverite datum i vreme." };
  const emp = empRow(db.prepare("SELECT * FROM employees WHERE id=?").get(String(bl.employee || "")));
  if (!emp) return { error: "Izaberite zaposlenu." };
  if (emp.active === false) return { error: emp.name + " je trenutno na odmoru." };
  const ms = manualServices(bl.services);
  if (ms.error) return ms;
  const dur = ms.services.reduce((a, x) => a + x.duration, 0);
  const t = toMin(start);
  if (t < 7 * 60 || t + dur > 22 * 60) return { error: "Termin mora biti između 07:00 i 22:00." };
  if (!freeAt(busyFor(date, emp.id, exceptId), t, dur))
    return { status: 409, error: "Termin se preklapa sa postojećom rezervacijom kod: " + emp.name + "." };
  const cc = clientClash(date, t, dur, client.tel, client.mail, exceptId);
  if (cc) return { status: 409, error: "Klijent u to vreme već ima termin kod: " + cc.employeeName + " (" + cc.start + "-" + cc.end + ")." };
  const had = clientSvcCount(date, emp.id, client.tel, client.mail, exceptId);
  if (had + ms.services.length > MAX_PER_EMP)
    return { error: "Najviše " + MAX_PER_EMP + " usluge po klijentu kod iste zaposlene" + (had ? " - klijent tog dana već ima " + had + " kod: " + emp.name : "") + "." };
  return { emp, date, t, dur, services: ms.services, note: String(bl.note || "").trim().slice(0, 200) };
}
function checkClient(body) {
  const name = String(body.name || "").trim(), tel = String(body.tel || "").trim(), mail = String(body.email || "").trim().toLowerCase();
  if (!name) return { error: "Unesite ime i prezime klijenta." };
  if (!normTel(tel)) return { error: "Unesite ispravan broj telefona klijenta (npr. 064 123 4567) - na njega stiže SMS podsetnik." };
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: "E-mail adresa klijenta nije ispravna." };
  return { name, tel, mail };
}
/* avans u potvrdi ručno unetog termina: od ukupne cene svih termina; izostaje kad je cena 0 (npr. termin iz već plaćenog paketa) */
const manualAvans = list => {
  const r = list.reduce((a, b) => a + (b.totalPrice || 0), 0), e = list.reduce((a, b) => a + (b.totalPriceEur || 0), 0);
  return r || e ? "\n" + avansText(r, e) + "\n" : "";
};
const visitLines = list => list.map(b => `📅 ${fmtD(b.date)} u ${b.start}\n💆 ${b.services.map(svcLine).join(" + ")}\n${empLine(b, true)}`).join("\n\n");
app.post("/api/admin/manual", auth, staff, (req, res) => {
  const body = req.body || {};
  const c = checkClient(body);
  if (c.error) return res.status(400).json({ error: c.error });
  /* stari oblik zahteva (jedna usluga) i dalje radi */
  const blocks = Array.isArray(body.blocks) ? body.blocks : [{ employee: body.employee, date: body.date, start: body.start, note: body.note,
    services: [{ serviceId: body.serviceId, label: body.label, duration: body.duration, price: body.price }] }];
  if (!blocks.length || blocks.length > 8) return res.status(400).json({ error: "Dodajte bar jednu zaposlenu sa uslugom." });
  const plan = [];
  for (let i = 0; i < blocks.length; i++) {
    const v = checkBlock(blocks[i], c, null);
    const pre = blocks.length > 1 ? "Zaposlena " + (i + 1) + ": " : "";
    if (v.error) return res.status(v.status || 400).json({ error: pre + v.error });
    if (plan.some(p => p.emp.id === v.emp.id))
      return res.status(400).json({ error: v.emp.name + " je izabrana dva puta - spojite usluge u jedan blok (najviše " + MAX_PER_EMP + ")." });
    const clash = plan.find(p => p.date === v.date && !(v.t + v.dur <= p.t || v.t >= p.t + p.dur));
    if (clash) return res.status(409).json({ error: "Termini kod: " + clash.emp.name + " i " + v.emp.name + " se preklapaju - klijent ne može biti na dva tretmana u isto vreme." });
    plan.push(v);
  }
  const now = new Date().toISOString();
  const list = plan.map(v => ({
    id: crypto.randomUUID(), userEmail: c.mail, userName: c.name, userTel: c.tel,
    services: v.services, employee: v.emp.id, employeeName: v.emp.name, date: v.date, start: toHM(v.t), end: toHM(v.t + v.dur),
    totalPrice: v.services.reduce((a, x) => a + (x.cur === "EUR" ? 0 : x.price), 0),
    totalPriceEur: v.services.reduce((a, x) => a + (x.cur === "EUR" ? x.price : 0), 0),
    totalDuration: v.dur, status: "zakazano", reminderSent: c.mail ? 0 : 1, created: now, source: "manual", note: v.note || null,
  }));
  db.transaction(() => list.forEach(insBooking))();
  if (c.mail) sendMail(c.mail, "Potvrda termina - Beauty & Nutrition",
`Poštovana/i ${c.name},

${list.length > 1 ? "vaši termini" : "vaš termin"} u salonu Beauty & Nutrition ${list.length > 1 ? "su zakazani" : "je zakazan"}:

${visitLines(list)}
📍 Živojina Žujovića 25, Beograd (Zvezdara)
${manualAvans(list)}
Podsetnik vam stiže dan pre termina. Za izmene: ${rezEmail()} ili +381 64 93 55 003.

Beauty & Nutrition`);
  res.json({ bookings: list.map(b => ({ ...b, reminderSent: !c.mail, sms24: 0, smsDay: 0 })) });
});
/* izmena ručno unetog termina (greška pri unosu, pomeranje) */
app.post("/api/admin/booking/:id", auth, staff, (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) return res.status(404).json({ error: "Termin nije pronađen." });
  if (b.source !== "manual") return res.status(400).json({ error: "Online rezervacija se ne menja ovde - otkažite je ili upišite novi termin." });
  if (b.status !== "zakazano") return res.status(400).json({ error: "Otkazan termin ne može da se menja." });
  const body = req.body || {};
  const c = checkClient(body);
  if (c.error) return res.status(400).json({ error: c.error });
  const v = checkBlock({ employee: body.employee, date: body.date, start: body.start, note: body.note, services: body.services }, c, b.id);
  if (v.error) return res.status(v.status || 400).json({ error: v.error });
  const start = toHM(v.t);
  const moved = v.date !== b.date || start !== b.start || v.emp.id !== b.employee;
  const changed = moved || v.services.map(x => x.name).join("|") !== b.services.map(x => x.name).join("|");
  const telChanged = normTel(c.tel) !== normTel(b.userTel);
  const sms = k => moved ? 0 : (telChanged && b[k] !== 1 ? 0 : b[k]);
  const reminderSent = !c.mail ? 1 : (moved || !b.userEmail) ? 0 : (b.reminderSent ? 1 : 0);
  db.prepare(`UPDATE bookings SET userName=?, userTel=?, userEmail=?, services=?, employee=?, employeeName=?, date=?, start=?, end=?,
    totalPrice=?, totalPriceEur=?, totalDuration=?, note=?, reminderSent=?, sms24=?, smsDay=?, changed=? WHERE id=?`).run(
    c.name, c.tel, c.mail, JSON.stringify(v.services), v.emp.id, v.emp.name, v.date, start, toHM(v.t + v.dur),
    v.services.reduce((a, x) => a + (x.cur === "EUR" ? 0 : x.price), 0), v.services.reduce((a, x) => a + (x.cur === "EUR" ? x.price : 0), 0),
    v.dur, v.note || null, reminderSent, sms("sms24"), sms("smsDay"), moved ? new Date().toISOString() : (b.changed || null), b.id);
  const nb = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(b.id));
  if (changed && c.mail) sendMail(c.mail, "Izmenjen termin - Beauty & Nutrition",
`Poštovana/i ${c.name},

vaš termin u salonu Beauty & Nutrition je izmenjen. Novi podaci:

${visitLines([nb])}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

Za pitanja: ${rezEmail()} ili +381 64 93 55 003.

Beauty & Nutrition`);
  res.json({ booking: nb });
});
/* brisanje ručno unetog termina (bez obaveštenja klijentu - za greške pri unosu) */
app.post("/api/admin/booking-del/:id", auth, staff, (req, res) => {
  const b = db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if (!b) return res.status(404).json({ error: "Termin nije pronađen." });
  if ((b.source || "online") !== "manual") return res.status(400).json({ error: "Online rezervacija se otkazuje, ne briše." });
  db.prepare("DELETE FROM bookings WHERE id=?").run(b.id);
  res.json({ ok: true });
});

/* ---- potvrda zahteva: online rezervacija čeka ("ceka") dok je salon ne potvrdi ili odbije ---- */
const pendingBk = (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) { res.status(404).json({ error: "Zahtev nije pronađen." }); return null; }
  if (b.status !== "ceka") { res.status(400).json({ error: "Ovaj zahtev više nije na čekanju (osvežite listu)." }); return null; }
  return b;
};
app.post("/api/admin/booking/:id/accept", auth, staff, (req, res) => {
  const b = pendingBk(req, res); if (!b) return;
  db.prepare("UPDATE bookings SET status='zakazano' WHERE id=?").run(b.id);
  const list = b.services.map(s => "• " + svcLine(s)).join("\n");
  sendMail(b.userEmail, "Termin je potvrđen - Beauty & Nutrition",
`Poštovana/i ${b.userName},

vaš termin je potvrđen:

📅 ${fmtD(b.date)} u ${b.start}
${list}
${empLine(b)}
⏱ Trajanje: ${durTxt(b.totalDuration)} · Cena: ${money(b.totalPrice, b.totalPriceEur || 0)}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

${avansText(b.totalPrice, b.totalPriceEur || 0)}

Podsetnik vam stiže dan pre termina (e-mailom i SMS-om). Za izmene nam pišite na ${rezEmail()} ili pozovite +381 64 93 55 003.

Srdačno,
Beauty & Nutrition`);
  res.json({ booking: bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(b.id)) });
});
app.post("/api/admin/booking/:id/reject", auth, staff, (req, res) => {
  const b = pendingBk(req, res); if (!b) return;
  const reason = String((req.body || {}).reason || "").trim().slice(0, 300);
  db.prepare("UPDATE bookings SET status='odbijeno', note=? WHERE id=?").run(reason ? "Odbijeno: " + reason : b.note || null, b.id);
  sendMail(b.userEmail, "Termin nije moguć - Beauty & Nutrition",
`Poštovana/i ${b.userName},

nažalost, zahtev za termin ${fmtD(b.date)} u ${b.start} (${b.services.map(svcLine).join(", ")}) ne možemo da potvrdimo.${reason ? "\nRazlog: " + reason : ""}

Molimo vas da izaberete drugi termin u aplikaciji ili nas pozovete na +381 64 93 55 003 - rado ćemo pronaći termin koji vam odgovara.

Srdačno,
Beauty & Nutrition`);
  res.json({ booking: bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(b.id)) });
});

/* ---- radno vreme zaposlenih ---- */
const ehOut = r => r.off ? { off: true } : { open: r.open, close: r.close };
const validSpan = h => !!h && (h.off === true || (validTime(h.open) && validTime(h.close) && toMin(h.open) < toMin(h.close)));
app.get("/api/admin/emp-hours", auth, staff, (req, res) => {
  const today = dstr(new Date()), week = {}, dates = {};
  for (const r of db.prepare("SELECT * FROM emp_hours ORDER BY day").all()) {
    if (r.day[0] === "w") (week[r.emp] = week[r.emp] || {})[r.day.slice(1)] = ehOut(r);
    else if (r.day >= today) (dates[r.emp] = dates[r.emp] || []).push({ date: r.day, ...ehOut(r) });
  }
  const n = new Date(), days = [];
  for (let i = 0; i < 7; i++) days.push(dstr(new Date(n.getFullYear(), n.getMonth(), n.getDate() + i)));
  const eff = {};
  for (const e of db.prepare("SELECT id FROM employees").all())
    eff[e.id] = days.map(d => { const w = empHours(e.id, d); return w ? toHM(w.open) + "-" + toHM(w.close) : null; });
  res.json({ week, dates, days, eff });
});
app.post("/api/admin/emp-hours/:emp/week", auth, admin, (req, res) => {
  const e = db.prepare("SELECT * FROM employees WHERE id=?").get(req.params.emp);
  if (!e) return res.status(404).json({ error: "Zaposlena nije pronađena." });
  const W = req.body || {};
  if (!W.reset) for (const k of ["0","1","2","3","4","5","6"])
    if (!validSpan(W[k])) return res.status(400).json({ error: "Proverite vreme za: " + DOWS[+k] + " (početak pre kraja)." });
  db.transaction(() => {
    db.prepare("DELETE FROM emp_hours WHERE emp=? AND day LIKE 'w%'").run(e.id);
    if (!W.reset) for (const k of ["0","1","2","3","4","5","6"]) {
      const h = W[k];
      db.prepare("INSERT INTO emp_hours(emp,day,open,close,off) VALUES(?,?,?,?,?)").run(e.id, "w" + k, h.off ? null : h.open, h.off ? null : h.close, h.off ? 1 : 0);
    }
  })();
  res.json({ ok: true });
});
app.post("/api/admin/emp-hours/:emp/date", auth, admin, (req, res) => {
  const e = db.prepare("SELECT * FROM employees WHERE id=?").get(req.params.emp);
  if (!e) return res.status(404).json({ error: "Zaposlena nije pronađena." });
  const { date, open, close, off } = req.body || {};
  if (!validDate(String(date || "")) || date < dstr(new Date())) return res.status(400).json({ error: "Izaberite današnji ili neki budući datum." });
  const h = off === true ? { off: true } : { open, close };
  if (!validSpan(h)) return res.status(400).json({ error: "Proverite vreme (početak pre kraja)." });
  db.prepare("INSERT OR REPLACE INTO emp_hours(emp,day,open,close,off) VALUES(?,?,?,?,?)").run(e.id, date, h.off ? null : h.open, h.off ? null : h.close, h.off ? 1 : 0);
  res.json({ ok: true });
});
app.post("/api/admin/emp-hours/:emp/date-del", auth, admin, (req, res) => {
  const date = String((req.body || {}).date || "");
  if (!validDate(date)) return res.status(400).json({ error: "Neispravan datum." });
  db.prepare("DELETE FROM emp_hours WHERE emp=? AND day=?").run(req.params.emp, date);
  res.json({ ok: true });
});

/* ---- automatski podsetnici dan pre ---- */
function reminderText(b) {
  return `Poštovana/i ${b.userName},

podsećamo Vas na zakazani termin u salonu Beauty & Nutrition:

📅 ${fmtD(b.date)} u ${b.start}
💆 ${b.services.map(svcLine).join(", ")}
${empLine(b)}
⏱ Trajanje: ${durTxt(b.totalDuration)} · Cena: ${money(b.totalPrice, b.totalPriceEur || 0)}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

Ako ste sprečeni, javite nam na ${rezEmail()} ili +381 64 93 55 003.

Srdačno,
Beauty & Nutrition`;
}
async function runReminders() {
  const now = new Date();
  if (now.getHours() < REMINDER_HOUR) return;
  const today = dstr(now);
  if ((getSetting("lastReminderRun") || {}).date === today) return;
  setSetting("lastReminderRun", { date: today, at: now.toISOString() });
  const tmr = dstr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const list = db.prepare("SELECT * FROM bookings WHERE date=? AND status='zakazano' AND reminderSent=0").all(tmr).map(bkRow);
  if (!list.length) return;
  console.log(`Podsetnici za ${tmr}: ${list.length} rezervacija.`);
  for (const b of list) {
    const ok = await sendMail(b.userEmail, "Podsetnik za sutrašnji termin - Beauty & Nutrition", reminderText(b));
    if (ok || !mailer) db.prepare("UPDATE bookings SET reminderSent=1 WHERE id=?").run(b.id);
  }
}

/* ---- SMS podsetnici: 24h pre termina i na dan termina (od SMS_DAY_HOUR, ne posle 21h) ---- */
const SMS_DOW = ["ned", "pon", "uto", "sre", "cet", "pet", "sub"];
const salonTel = () => (getSetting("salon") || {}).phone || "+381 64 93 55 003";
const smsSvc = b => { const t = b.services.map(x => x.name).join(", "); return t.length > 45 ? t.slice(0, 43).trimEnd() + "..." : t; };
function smsText(b, kind) {
  const d = parseD(b.date);
  return kind === "sms24"
    ? `Beauty & Nutrition: podsecamo Vas da sutra (${SMS_DOW[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.) u ${b.start} imate zakazan tretman: ${smsSvc(b)}. Ako ste spreceni, javite se na ${salonTel()}.`
    : `Beauty & Nutrition: podsecamo Vas da danas u ${b.start} imate zakazan tretman: ${smsSvc(b)}. Zivojina Zujovica 25, Zvezdara. Info: ${salonTel()}`;
}
const startOf = b => { const d = parseD(b.date), m = toMin(b.start); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60); };
/* šta raditi sa podsetnikom: "send", "skip" (nije potreban) ili "wait" */
function smsPlan(b, kind, now) {
  if (!normTel(b.userTel)) return "skip";
  const H = 36e5, st = startOf(b), made = new Date(b.changed || b.created), left = st - now;
  const today = dstr(now), tmr = dstr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (kind === "sms24") {
    if (st - made < 24 * H) return "skip";        // zakazano (ili pomereno) manje od 24h pre termina
    if (b.date === today) return "skip";            // propušten dan pre - pokriva ga podsetnik na dan termina
    if (b.date !== tmr) return "wait";
    /* tačno 24h pre; kasni termini (posle 21h) dobijaju podsetnik od 20h, pre tihih sati */
    return left <= 24 * H || now.getHours() >= SMS_QUIET_HOUR - 1 ? "send" : "wait";
  }
  if (b.date !== today) return "wait";
  if (dstr(made) === b.date) return "skip";         // zakazano istog dana - klijent tek što je zakazao
  return left >= 30 * 60 * 1000 ? "send" : "skip";
}
const smsTries = new Map();
let smsBusy = false;
async function runSmsReminders() {
  if (!smsOn || smsBusy) return;
  const now = new Date();
  if (now.getHours() < SMS_DAY_HOUR || now.getHours() >= SMS_QUIET_HOUR) return;
  smsBusy = true;
  try {
    const today = dstr(now), tmr = dstr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const list = db.prepare("SELECT * FROM bookings WHERE status='zakazano' AND date IN (?,?) AND (sms24=0 OR smsDay=0)").all(today, tmr).map(bkRow);
    for (const b of list) for (const kind of ["sms24", "smsDay"]) {
      if (b[kind] !== 0) continue;
      const plan = smsPlan(b, kind, now);
      if (plan === "wait") continue;
      if (plan === "skip") { db.prepare(`UPDATE bookings SET ${kind}=2 WHERE id=?`).run(b.id); continue; }
      const ok = await sendSms(b.userTel, smsText(b, kind));
      const key = b.id + kind, n = (smsTries.get(key) || 0) + 1;
      if (ok) { db.prepare(`UPDATE bookings SET ${kind}=1 WHERE id=?`).run(b.id); smsTries.delete(key); }
      else { smsTries.set(key, n); if (n >= 3) db.prepare(`UPDATE bookings SET ${kind}=3 WHERE id=?`).run(b.id); }
    }
  } finally { smsBusy = false; }
}
const tick = () => { runReminders().catch(e => console.error(e)); runSmsReminders().catch(e => console.error(e)); };
setInterval(tick, 5 * 60 * 1000);
setTimeout(tick, 3000);

app.get("/zdravlje", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Beauty & Nutrition rezervacije - http://localhost:" + PORT));
