# Beauty & Nutrition — Rezervacije (produkcijska web aplikacija)

Javna web aplikacija za online zakazivanje: cenovnik tretmana lica i tela (masaže u sklopu
tretmana tela), edukacije na upit, nalozi klijenata, slobodni termini po zaposlenima,
admin panel, automatski e-mail podsetnici dan pre termina i SMS podsetnici (24h pre i na dan termina).

Radi za **neograničen broj realnih korisnika** — nije potreban nikakav Claude ili Google nalog,
samo link (ili QR kod) do vaše adrese.

---

## Šta je u paketu

```
server.js          – ceo backend (Node.js + Express + SQLite)
public/index.html  – kompletna aplikacija koju korisnici vide
seed/              – početni cenovnik, zaposlene, radno vreme (učita se automatski pri prvom startu)
package.json       – zavisnosti
.env.example       – primer podešavanja
```

Baza (`salon.db`) se pravi sama pri prvom pokretanju.

---

## Pokretanje (bilo koji server/računar sa Node.js 18+)

```bash
npm install
npm start          # aplikacija radi na http://localhost:3000
```

## Podešavanja (environment promenljive)

| Promenljiva     | Obavezno | Opis |
|-----------------|----------|------|
| `SECRET`        | DA       | Dugačak nasumičan niz (potpisivanje prijave). Npr. 40+ znakova. |
| `ADMIN_EMAILS`  | ne       | Admin nalozi, zarezom odvojeni. Podrazumevano: `kaca9525@gmail.com` |
| `SMTP_USER`     | za mejl  | Gmail adresa sa koje se šalju potvrde/podsetnici, npr. `andrijanaobradovic5@gmail.com` |
| `SMTP_PASS`     | za mejl  | Gmail **App Password** (uputstvo ispod) |
| `REMINDER_HOUR` | ne       | Sat kada se šalju podsetnici za sutra (podrazumevano `18`) |
| `SMSGATE_USER`, `SMSGATE_PASS` | za SMS | SMS sa Android telefona salona (aplikacija SMSGate) - vidi „SMS podsetnici" |
| `INFOBIP_API_KEY`, `INFOBIP_BASE_URL` | za SMS | Infobip nalog (API ključ i Base URL) - vidi „SMS podsetnici" |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | za SMS | Umesto Infobip-a može Twilio; opciono i `TWILIO_MESSAGING_SERVICE_SID` |
| `SMS_FROM`      | ne       | Ime pošiljaoca SMS-a (podrazumevano `BNSalon`, do 11 znakova) |
| `SMS_DAY_HOUR`  | ne       | Od kog sata ide SMS „na dan termina" (podrazumevano `8`) |
| `SMS_PROVIDER`  | ne       | `log` = probni režim (poruke samo u logu); inače se bira sam po ključu |
| `PORT`          | ne       | Port servera (hosting ga obično sam zada) |
| `DATA_DIR`      | ne       | Folder za bazu `salon.db` (korisno uz persistent disk) |

**Bez SMTP podešavanja aplikacija normalno radi** — samo se mejlovi ne šalju automatski;
u Admin → Podsetnici i dalje imate gotove tekstove za ručno slanje.

### Gmail App Password (za automatske mejlove)
1. Na Google nalogu (andrijanaobradovic5@gmail.com) uključite **2-Step Verification**
2. Otvorite https://myaccount.google.com/apppasswords
3. Napravite App password (naziv npr. „Salon rezervacije") — dobijate šifru od 16 znakova
4. To je vrednost za `SMTP_PASS` (a `SMTP_USER` je sama Gmail adresa)

Šta se tada šalje automatski:
- **klijentu**: potvrda odmah po rezervaciji + podsetnik dan pre termina (u `REMINDER_HOUR` sati)
- **salonu** (`andrijanaobradovic5@gmail.com`): obaveštenje o svakoj novoj rezervaciji i svakom otkazivanju
- **link za novu lozinku** kada klijent klikne „Zaboravljena lozinka?" (važi 1 sat)

### SMS podsetnici
Broj telefona je obavezan pri registraciji i u ručnom unosu, pa svaki klijent dobija:
- **24h pre termina**: „podsećamo Vas da sutra u 10:00 imate zakazan tretman: …"
- **na dan termina** (od `SMS_DAY_HOUR`, podrazumevano 8h): „podsećamo Vas da danas u 10:00 …"

Ako je termin zakazan manje od 24h unapred, šalje se samo podsetnik na dan termina; ako je zakazan
istog dana, SMS se ne šalje (klijent je upravo dobio potvrdu). Posle 21h se SMS ne šalje.
Status svakog SMS-a vidi se u Admin → Podsetnici.

**Varijanta 1: Android telefon salona (bez troška po poruci).** Besplatna aplikacija
[SMSGate](https://sms-gate.app/) šalje SMS-ove sa SIM kartice u telefonu, pa se plaća samo tarifa
(najbolje sa neograničenim SMS-ovima). Poruka stiže sa broja te kartice, a ne sa imena „BNSalon".
1. Na Android telefon sa SIM karticom instalirajte **SMS Gateway for Android (SMSGate)** sa sms-gate.app
2. U aplikaciji uključite **Cloud server** i potvrdite registraciju; prepišite **Username** i **Password**
   koje aplikacija prikaže
3. Na Renderu dodajte `SMSGATE_USER` i `SMSGATE_PASS` sa tim vrednostima
4. Na telefonu isključite štednju baterije za aplikaciju i držite ga na punjaču i internetu (Wi-Fi)

Ako je telefon isključen, poruke čekaju i šalju se kad se uključi, ali samo dok ne prođe vreme termina
(zastarele se ne šalju). Operateri ne vole automatsko slanje sa običnih kartica, pa je ovo dobro za
manji broj poruka; za veći obim pređite na SMS servis (varijanta 2).

**Varijanta 2: SMS servis** (Infobip, dobar izbor za Srbiju):
1. Napravite nalog na **infobip.com** i dopunite kredit
2. U nalogu prepišite **API key** i **Base URL** (izgleda kao `xxxxxx.api.infobip.com`)
3. Na Renderu dodajte `INFOBIP_API_KEY` i `INFOBIP_BASE_URL=https://xxxxxx.api.infobip.com`
4. Po želji zatražite od Infobip-a ime pošiljaoca (npr. `BNSalon`) i postavite `SMS_FROM`

Twilio radi isto tako, sa `TWILIO_ACCOUNT_SID` i `TWILIO_AUTH_TOKEN`. Bez ovih podešavanja aplikacija
radi normalno, samo se SMS ne šalje. Poruke idu bez kvačica (č→c), da bi stale u jedan SMS.

---

## Najbrže postavljanje na internet (Render.com)

1. Napravite besplatan nalog na **github.com** → „New repository" (npr. `bn-rezervacije`, Public)
   → „uploading an existing file" → prevucite **sav sadržaj ovog foldera** (bez `node_modules`) → Commit
2. Napravite nalog na **render.com** → **New → Web Service** → povežite GitHub repo
3. Podešavanja: Build Command `npm install` · Start Command `npm start` · Instance: po želji
4. U **Environment** dodajte promenljive iz tabele iznad (bar `SECRET`; za mejlove i `SMTP_USER`/`SMTP_PASS`)
5. Deploy → dobijate javnu adresu tipa `https://bn-rezervacije.onrender.com`

> **Važno za podsetnike:** Render **Free** plan „uspava" aplikaciju posle 15 minuta bez posetilaca,
> a dok spava ne šalje ni mejl ni SMS podsetnike (pošalje ih kad se probudi, ako još nije kasno).
> Za pouzdane podsetnike izaberite plaćenu instancu (Starter) ili podesite besplatni „pinger"
> (npr. UptimeRobot) da otvara `https://VAŠA-ADRESA/zdravlje` na svakih 10 minuta.

> **Važno za podatke:** na Render **Free** planu disk nije trajan — rezervacije se mogu izgubiti
> pri restartu servisa. Za pravu produkciju izaberite **Starter** plan + **Disk** (mount npr. `/data`
> i postavite `DATA_DIR=/data`), ili bilo koji VPS/hosting sa Node podrškom. Free plan je savršen
> za testiranje sa pravim korisnicima pre konačne odluke.

Ista aplikacija radi i na Railway, Fly.io, Hetzner/DigitalOcean VPS-u ili cPanel hostingu sa Node.js.

## Sopstveni domen
Na Renderu: Settings → Custom Domains → dodajte npr. `rezervacije.bg-beauty-and-nutrition.com`
i upišite prikazani CNAME kod svog registra domena. HTTPS je automatski.

---

## Prvi koraci posle postavljanja

1. Otvorite aplikaciju → **Registracija** sa adresom `kaca9525@gmail.com` → taj nalog je automatski **Admin**
2. Admin → **Radno vreme**: proverite/izmenite (postavljeno: pon–pet 09–21, sub 10–15, nedelja neradna),
   a u delu **Radno vreme zaposlenih** upišite kada koja zaposlena radi (nedeljni raspored + izuzeci po datumu)
3. Admin → **Usluge**: cene, trajanja i aktivnost menjate u par klikova; oznaka **„na aparatu"** šalje
   tretman u kolonu **Aparat** (npr. presoterapija, EMS, termo ćebe), pa ne zauzima zaposlene, a isti
   aparat ne može da primi dva klijenta u isto vreme
4. Pošaljite mi javnu adresu — **regenerisaću QR karticu** sa njom za minut

## Sigurnosne napomene
- Lozinke se čuvaju isključivo kao scrypt hash + so; prijava je httpOnly kolačić potpisan `SECRET`-om
- Server ponovo proverava svaku rezervaciju (radno vreme, zauzetost, koja zaposlena izvodi koje tretmane)
- Obavezno postavite svoj, dugačak `SECRET` u produkciji
