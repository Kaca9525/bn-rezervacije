/* Beauty & Nutrition — produkcijski server za online zakazivanje
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
const SECRET = process.env.SECRET || "promeni-ovaj-secret-u-produkciji";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "kaca9525@gmail.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const STAFF_EMAILS = (process.env.STAFF_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || "18", 10); // sat slanja podsetnika
const DATA_DIR = process.env.DATA_DIR || __dirname;

/* ---------------- baza ---------------- */
const db = new Database(path.join(DATA_DIR, "salon.db"));
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
try { db.exec("ALTER TABLE services ADD COLUMN oldPrice INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN resetHash TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN resetExp TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE services ADD COLUMN cur TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN totalPriceEur INTEGER DEFAULT 0"); } catch (e) {}
db.exec(`CREATE TABLE IF NOT EXISTS vouchers(
  id TEXT PRIMARY KEY, buyerEmail TEXT, buyerName TEXT, buyerTel TEXT,
  recipient TEXT, serviceId TEXT, serviceName TEXT,
  amount INTEGER, message TEXT, status TEXT, created TEXT)`);
seedIfEmpty();

const getSetting = k => { const r = db.prepare("SELECT json FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.json) : null; };
const setSetting = (k, v) => db.prepare("INSERT OR REPLACE INTO settings(key,json) VALUES(?,?)").run(k, JSON.stringify(v));
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
  console.log("E-mail slanje je ISKLJUČENO — postavite SMTP_USER i SMTP_PASS (Gmail App Password).");
}
function sendMail(to, subject, text) {
  if (!mailer || !to) return Promise.resolve(false);
  return mailer.sendMail({
    from: `"Beauty & Nutrition" <${process.env.SMTP_USER}>`,
    to, subject, text,
    replyTo: rezEmail(),
  }).then(() => true).catch(e => { console.error("Mail greška:", e.message); return false; });
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

const svcRow = r => r && ({ id: r.id, cat: r.cat, name: r.name, desc: r.desc, price: r.price, duration: r.duration, active: !!r.active, note: r.note || undefined, emps: r.emps ? JSON.parse(r.emps) : undefined, oldPrice: r.oldPrice == null ? undefined : r.oldPrice, cur: r.cur || undefined });
const empRow = r => r && ({ id: r.id, name: r.name, cats: JSON.parse(r.cats || "[]"), title: r.title || "", active: r.active === 0 ? false : true });
const bkRow = r => r && ({ ...r, services: JSON.parse(r.services), reminderSent: !!r.reminderSent });
const performs = (e, s) => Array.isArray(s.emps) ? s.emps.includes(e.id) : (e.cats || []).includes(s.cat);

function dayHours(dateStr) {
  const H = getSetting("hours") || {};
  const h = H[String(parseD(dateStr).getDay())];
  if (!h || h.closed) return null;
  return { open: toMin(h.open), close: toMin(h.close) };
}
function busyFor(dateStr, employee) {
  return db.prepare("SELECT start,end FROM bookings WHERE date=? AND employee=? AND status='zakazano'")
    .all(dateStr, employee).map(b => [toMin(b.start), toMin(b.end)]);
}
function freeAt(busy, start, dur) {
  const end = start + dur;
  return !busy.some(([s, e]) => !(end <= s || start >= e));
}

/* ---------------- app ---------------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

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
  });
});
/* zauzeti intervali za dan (bez ličnih podataka) */
app.get("/api/day", (req, res) => {
  const { date } = req.query;
  if (!validDate(date)) return res.status(400).json({ error: "Neispravan datum." });
  res.json(db.prepare("SELECT employee,start,end FROM bookings WHERE date=? AND status='zakazano'").all(date));
});

/* ---- nalozi ---- */
app.post("/api/register", async (req, res) => {
  let { ime, prezime, email, telefon, pw } = req.body || {};
  ime = String(ime || "").trim(); prezime = String(prezime || "").trim();
  email = String(email || "").trim().toLowerCase(); telefon = String(telefon || "").trim();
  if (!ime || !prezime || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(pw || "").length < 6)
    return res.status(400).json({ error: "Popunite ime, prezime i ispravan e-mail; lozinka najmanje 6 karaktera." });
  if ((req.body || {}).consent !== true)
    return res.status(400).json({ error: "Potrebno je da potvrdite da ste upoznati sa Politikom Privatnosti." });
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email))
    return res.status(409).json({ error: "Nalog sa ovom e-mail adresom već postoji — prijavite se." });
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
  if (!mailer) return res.status(503).json({ error: "Slanje mejlova još nije podešeno — javite se salonu na " + rezEmail() + " radi nove lozinke." });
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (u) {
    const token = crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE users SET resetHash=?, resetExp=? WHERE email=?").run(hash, exp, email);
    const proto = req.get("x-forwarded-proto") || "https";
    const link = proto + "://" + req.get("host") + "/?reset=" + token;
    sendMail(email, "Resetovanje lozinke — Beauty & Nutrition",
`Poštovana/i ${u.ime},

primili smo zahtev za novu lozinku za vaš nalog. Kliknite na link (važi 1 sat):

${link}

Ako niste vi tražili promenu, slobodno ignorišite ovu poruku — lozinka ostaje nepromenjena.

Beauty & Nutrition`);
  }
  res.json({ ok: true });
});
app.post("/api/reset", (req, res) => {
  const token = String((req.body || {}).token || "");
  const pw = String((req.body || {}).pw || "");
  if (pw.length < 6) return res.status(400).json({ error: "Lozinka mora imati najmanje 6 karaktera." });
  if (!/^[0-9a-f]{48}$/.test(token)) return res.status(400).json({ error: "Link za resetovanje nije ispravan." });
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const u = db.prepare("SELECT * FROM users WHERE resetHash=?").get(hash);
  if (!u || !u.resetExp || u.resetExp < new Date().toISOString())
    return res.status(400).json({ error: "Link za resetovanje je istekao — zatražite novi." });
  const salt = crypto.randomBytes(12).toString("hex");
  db.prepare("UPDATE users SET salt=?, hash=?, resetHash=NULL, resetExp=NULL WHERE email=?")
    .run(salt, scrypt(pw, salt), u.email);
  res.cookie("bn", sign(u.email), { httpOnly: true, sameSite: "lax", maxAge: 180 * 864e5 });
  res.json({ me: { email: u.email, ime: u.ime, prezime: u.prezime, telefon: u.telefon, admin: ADMIN_EMAILS.includes(u.email), staff: STAFF_EMAILS.includes(u.email) } });
});
app.get("/api/me", (req, res) => res.json({ me: me(req) }));
app.post("/api/consent", auth, (req, res) => {
  db.prepare("UPDATE users SET consent=? WHERE email=?").run(new Date().toISOString(), req.user.email);
  res.json({ ok: true });
});

/* ---- rezervacije ---- */
app.get("/api/my", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM bookings WHERE userEmail=? ORDER BY date,start").all(req.user.email).map(bkRow));
});

app.post("/api/bookings", auth, (req, res) => {
  const { services: ids, employee: wantEmp, date, start } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !validDate(date) || !validTime(start))
    return res.status(400).json({ error: "Nepotpuni podaci rezervacije." });
  const services = ids.map(id => svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(String(id))));
  if (services.some(s => !s || !s.active || s.cat === "edu" || !s.duration || s.price == null))
    return res.status(400).json({ error: "Izabrana usluga nije dostupna za online zakazivanje." });
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
    if (!freeAt(busyFor(date, chosen.id), t, dur)) chosen = null;
  } else {
    chosen = emps.find(e => freeAt(busyFor(date, e.id), t, dur)) || null;
  }
  if (!chosen) return res.status(409).json({ error: "Ovaj termin je upravo zauzet — izaberite drugi." });

  const b = {
    id: crypto.randomUUID(),
    userEmail: req.user.email, userName: req.user.ime + " " + req.user.prezime, userTel: req.user.telefon || "",
    services: services.map(s => ({ id: s.id, name: s.name, price: s.price, duration: s.duration, cat: s.cat, cur: s.cur || null })),
    employee: chosen.id, employeeName: chosen.name,
    date, start: toHM(t), end: toHM(t + dur),
    totalPrice: priceR, totalPriceEur: priceE, totalDuration: dur, status: "zakazano", reminderSent: 0,
    created: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO bookings(id,userEmail,userName,userTel,services,employee,employeeName,date,start,end,totalPrice,totalPriceEur,totalDuration,status,reminderSent,created)
    VALUES(@id,@userEmail,@userName,@userTel,@servicesJson,@employee,@employeeName,@date,@start,@end,@totalPrice,@totalPriceEur,@totalDuration,@status,@reminderSent,@created)`)
    .run({ ...b, servicesJson: JSON.stringify(b.services) });

  const list = b.services.map(s => "• " + s.name).join("\n");
  sendMail(b.userEmail, "Potvrda rezervacije — Beauty & Nutrition",
`Poštovana/i ${b.userName},

vaša rezervacija je primljena:

📅 ${fmtD(b.date)} u ${b.start}
${list}
👩 Kozmetičarka: ${b.employeeName}
⏱ Trajanje: ${durTxt(b.totalDuration)} · Cena: ${money(b.totalPrice, b.totalPriceEur || 0)}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

Podsetnik vam stiže dan pre termina. Za izmene nam pišite na ${rezEmail()} ili pozovite +381 64 93 55 003.

Srdačno,
Beauty & Nutrition`);
  sendMail(rezEmail(), `Nova rezervacija: ${b.date} u ${b.start} — ${b.userName}`,
`Nova rezervacija u aplikaciji:

Klijent: ${b.userName} (${b.userEmail}${b.userTel ? ", " + b.userTel : ""})
Termin: ${fmtD(b.date)} u ${b.start}–${b.end}
Kozmetičarka: ${b.employeeName}
Usluge:
${list}
Ukupno: ${money(b.totalPrice, b.totalPriceEur || 0)} · ${durTxt(b.totalDuration)}`);

  res.json({ booking: { ...b, reminderSent: false } });
});

app.post("/api/bookings/:id/cancel", auth, (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) return res.status(404).json({ error: "Rezervacija nije pronađena." });
  const isStaffUser = req.user.admin || req.user.staff;
  if (b.userEmail !== req.user.email && !isStaffUser) return res.status(403).json({ error: "Nije dozvoljeno." });
  db.prepare("UPDATE bookings SET status='otkazano' WHERE id=?").run(b.id);
  if (b.status === "zakazano") {
    sendMail(rezEmail(), `Otkazana rezervacija: ${b.date} u ${b.start} — ${b.userName}`,
      `Rezervacija je otkazana (${isStaffUser && b.userEmail !== req.user.email ? "od strane salona" : "od strane klijenta"}):\n\n` +
      `${b.userName} · ${fmtD(b.date)} u ${b.start} · ${b.services.map(s => s.name).join(", ")}`);
    if (isStaffUser && b.userEmail !== req.user.email)
      sendMail(b.userEmail, "Otkazan termin — Beauty & Nutrition",
        `Poštovana/i ${b.userName},\n\nnažalost, termin ${fmtD(b.date)} u ${b.start} je otkazan. Molimo vas da zakažete novi termin u aplikaciji ili nas pozovete na +381 64 93 55 003.\n\nBeauty & Nutrition`);
  }
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
  const { price, duration, active } = req.body || {};
  if (s.cat !== "edu") {
    if (!(Number(price) >= 0) || !(Number(duration) > 0)) return res.status(400).json({ error: "Proverite cenu i trajanje." });
    db.prepare("UPDATE services SET price=?,duration=?,active=? WHERE id=?")
      .run(Math.round(Number(price)), Math.round(Number(duration)), active ? 1 : 0, s.id);
  } else {
    db.prepare("UPDATE services SET active=? WHERE id=?").run(active ? 1 : 0, s.id);
  }
  res.json({ service: svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(s.id)) });
});
app.post("/api/admin/employee/:id", auth, admin, (req, res) => {
  const e = db.prepare("SELECT * FROM employees WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "Zaposlena nije pronađena." });
  db.prepare("UPDATE employees SET active=? WHERE id=?").run(req.body && req.body.active ? 1 : 0, e.id);
  res.json({ employee: empRow(db.prepare("SELECT * FROM employees WHERE id=?").get(e.id)) });
});
app.post("/api/admin/service-new", auth, admin, (req, res) => {
  const { name, desc, price, oldPrice, duration, emps } = req.body || {};
  const nm = String(name || "").trim();
  const pr = Math.round(Number(price)); const d = Math.round(Number(duration));
  if (!nm || !(pr >= 0) || !(d > 0)) return res.status(400).json({ error: "Unesite naziv, cenu i trajanje." });
  const ids = (Array.isArray(emps) ? emps : []).map(String)
    .filter(id => db.prepare("SELECT 1 FROM employees WHERE id=?").get(id));
  if (!ids.length) return res.status(400).json({ error: "Označite bar jednu zaposlenu." });
  let op = Math.round(Number(oldPrice) || 0); if (!(op > pr)) op = null;
  const id = "akcija-" + Date.now();
  db.prepare(`INSERT INTO services(id,cat,name,desc,price,duration,active,note,emps,oldPrice)
    VALUES(?,?,?,?,?,?,1,NULL,?,?)`)
    .run(id, "akcije", nm, String(desc || "").trim(), pr, d, JSON.stringify(ids), op);
  res.json({ service: svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(id)) });
});
app.post("/api/admin/service-del/:id", auth, admin, (req, res) => {
  const s = db.prepare("SELECT * FROM services WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Akcija nije pronađena." });
  if (s.cat !== "akcije") return res.status(400).json({ error: "Brisati se mogu samo akcije; usluge iz cenovnika se isključuju u kartici Usluge." });
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
  sendMail(rezEmail(), "Porud\u017ebina poklon vau\u010dera \u2014 " + rec + " (" + RSD(amt) + ")",
`Nova porud\u017ebina poklon vau\u010dera:

Za: ${rec}
Iznos: ${RSD(amt)}${sName ? "\nUsluga: " + sName : "\n(iznos po \u017eelji \u2014 primalac bira tretmane)"}
${v.message ? "Posveta: " + v.message + "\n" : ""}Kupac: ${v.buyerName} (${v.buyerEmail}${v.buyerTel ? ", " + v.buyerTel : ""})

Kontaktirajte kupca radi uplate i preuzimanja.`);
  sendMail(v.buyerEmail, "Porud\u017ebina vau\u010dera je primljena \u2014 Beauty & Nutrition",
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
  };
  res.setHeader("Content-Disposition", 'attachment; filename="bn-kopija-' + dstr(new Date()) + '.json"');
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, 1));
});
app.post("/api/admin/remind/:id", auth, staff, async (req, res) => {
  const b = bkRow(db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id));
  if (!b) return res.status(404).json({ error: "Rezervacija nije pronađena." });
  let sent = false;
  if (req.body && req.body.send) sent = await sendMail(b.userEmail, "Podsetnik za sutrašnji termin — Beauty & Nutrition", reminderText(b));
  db.prepare("UPDATE bookings SET reminderSent=1 WHERE id=?").run(b.id);
  res.json({ ok: true, sent });
});

app.post("/api/admin/manual", auth, staff, (req, res) => {
  const { name, tel, email, employee, serviceId, label, duration, price, date, start, note } = req.body || {};
  const nm = String(name || "").trim();
  if (!nm || !validDate(String(date || "")) || !validTime(String(start || "")) || !(Number(duration) > 0))
    return res.status(400).json({ error: "Proverite ime, datum, vreme i trajanje." });
  const emp = empRow(db.prepare("SELECT * FROM employees WHERE id=?").get(String(employee || "")));
  if (!emp) return res.status(400).json({ error: "Izaberite zaposlenu." });
  if (emp.active === false) return res.status(400).json({ error: emp.name + " je trenutno na odmoru." });
  const d = Math.round(Number(duration));
  const pr = Math.max(0, Math.round(Number(price) || 0));
  const t = toMin(start);
  if (t < 7 * 60 || t + d > 22 * 60) return res.status(400).json({ error: "Termin mora biti između 07:00 i 22:00." });
  if (!freeAt(busyFor(date, emp.id), t, d))
    return res.status(409).json({ error: "Termin se preklapa sa postojećom rezervacijom kod: " + emp.name + "." });
  let svcName = String(label || "").trim(), cat = "telo", sid = "manual";
  if (serviceId) {
    const s = svcRow(db.prepare("SELECT * FROM services WHERE id=?").get(String(serviceId)));
    if (s) { svcName = s.name; cat = s.cat; sid = s.id; }
  }
  if (!svcName) svcName = "Tretman (ručni unos)";
  if (String(note || "").trim()) svcName += " — " + String(note).trim();
  const mail = String(email || "").trim().toLowerCase();
  const b = {
    id: crypto.randomUUID(), userEmail: mail, userName: nm, userTel: String(tel || "").trim(),
    services: [{ id: sid, name: svcName, price: pr, duration: d, cat }],
    employee: emp.id, employeeName: emp.name, date, start: toHM(t), end: toHM(t + d),
    totalPrice: pr, totalPriceEur: 0, totalDuration: d, status: "zakazano", reminderSent: mail ? 0 : 1,
    created: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO bookings(id,userEmail,userName,userTel,services,employee,employeeName,date,start,end,totalPrice,totalPriceEur,totalDuration,status,reminderSent,created)
    VALUES(@id,@userEmail,@userName,@userTel,@servicesJson,@employee,@employeeName,@date,@start,@end,@totalPrice,@totalPriceEur,@totalDuration,@status,@reminderSent,@created)`)
    .run({ ...b, servicesJson: JSON.stringify(b.services) });
  if (mail) sendMail(mail, "Potvrda termina — Beauty & Nutrition",
`Poštovana/i ${nm},

vaš termin u salonu Beauty & Nutrition je zakazan:

📅 ${fmtD(date)} u ${b.start}
💆 ${svcName}
👩 ${emp.name}
📍 Živojina Žujovića 25, Beograd (Zvezdara)

Podsetnik vam stiže dan pre termina. Za izmene: ${rezEmail()} ili +381 64 93 55 003.

Beauty & Nutrition`);
  res.json({ booking: { ...b, reminderSent: !mail } });
});

/* ---- automatski podsetnici dan pre ---- */
function reminderText(b) {
  return `Poštovana/i ${b.userName},

podsećamo Vas na zakazani termin u salonu Beauty & Nutrition:

📅 ${fmtD(b.date)} u ${b.start}
💆 ${b.services.map(s => s.name).join(", ")}
👩 Kozmetičarka: ${b.employeeName}
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
    const ok = await sendMail(b.userEmail, "Podsetnik za sutrašnji termin — Beauty & Nutrition", reminderText(b));
    if (ok || !mailer) db.prepare("UPDATE bookings SET reminderSent=1 WHERE id=?").run(b.id);
  }
}
setInterval(() => runReminders().catch(e => console.error(e)), 10 * 60 * 1000);
runReminders().catch(e => console.error(e));

app.get("/zdravlje", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Beauty & Nutrition rezervacije — http://localhost:" + PORT));
