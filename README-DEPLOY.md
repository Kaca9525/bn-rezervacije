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
| `SECRET`        | preporučeno | Dugačak nasumičan niz (potpisivanje prijave). Kad se jednom postavi, ne menjati - promena odjavljuje sve. Ako ga nema, aplikacija napravi ključ i čuva ga u bazi. |
| `ADMIN_EMAILS`  | ne       | Admin nalozi, zarezom odvojeni. Podrazumevano: `kaca9525@gmail.com` |
| `SMTP_USER`     | za mejl  | Gmail adresa sa koje se šalju potvrde/podsetnici, npr. `andrijanaobradovic5@gmail.com` |
| `SMTP_PASS`     | za mejl  | Gmail **App Password** (uputstvo ispod) |
| `REMINDER_HOUR` | ne       | Sat kada se šalju podsetnici za sutra (podrazumevano `18`) |
| `INFOBIP_API_KEY`, `INFOBIP_BASE_URL` | za SMS | Infobip nalog (API ključ i Base URL) - vidi „SMS podsetnici" |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | za SMS | Umesto Infobip-a može Twilio; opciono i `TWILIO_MESSAGING_SERVICE_SID` |
| `SMS_FROM`      | ne       | Ime pošiljaoca SMS-a (podrazumevano `BNSalon`, do 11 znakova) |
| `SMS_DAY_HOUR`  | ne       | Od kog sata ide SMS „na dan termina" (podrazumevano `8`) |
| `SMS_PROVIDER`  | ne       | `log` = probni režim (poruke samo u logu); inače se bira sam po ključu |
| `PORT`          | ne       | Port servera (hosting ga obično sam zada) |
| `DATA_DIR`      | DA (produkcija) | Folder trajnog diska za bazu `salon.db`, npr. `/data`. Bez njega se pri svakom deploy-u brišu nalozi i rezervacije |
| `SITE_URL`      | ne       | Sopstveni domen, npr. `https://beautyandnutrition.app`; stara onrender.com adresa tada preusmerava na njega (vidi „Sopstveni domen") |

**Bez SMTP podešavanja aplikacija normalno radi** — samo se mejlovi ne šalju automatski;
u Admin → Podsetnici i dalje imate gotove tekstove za ručno slanje.

### Gmail App Password (za automatske mejlove)
1. Na Google nalogu (andrijanaobradovic5@gmail.com) uključite **2-Step Verification**
2. Otvorite https://myaccount.google.com/apppasswords
3. Napravite App password (naziv npr. „Salon rezervacije") — dobijate šifru od 16 znakova
4. To je vrednost za `SMTP_PASS` (a `SMTP_USER` je sama Gmail adresa)

### Logo pored imena pošiljaoca (Gmail)
Krug sa slikom pored imena „Beauty & Nutrition" u Gmail-u je **profilna slika Google naloga** sa kog
aplikacija šalje mejlove (`SMTP_USER`). Ne podešava se u aplikaciji, nego na samom nalogu:
1. Prijavite se na taj nalog i otvorite https://myaccount.google.com/personal-info
2. Kliknite na fotografiju profila i otpremite logo (kvadratna slika, npr. 800×800 px)
3. Slika se kod primalaca pojavljuje na novim mejlovima, nekad tek posle nekoliko sati

Outlook, Yahoo i ostali servisi ovu sliku ne prikazuju (za to je potreban sopstveni domen i BIMI).

Šta se tada šalje automatski:
- **klijentu**: potvrda odmah po rezervaciji (sa podacima za uplatu avansa od 30%) + podsetnik dan pre termina (u `REMINDER_HOUR` sati)
- **salonu** (`andrijanaobradovic5@gmail.com`): obaveštenje o svakoj novoj rezervaciji i svakom otkazivanju
- **link za novu lozinku** kada klijent klikne „Zaboravljena lozinka?" (važi 1 sat)

### SMS podsetnici
Broj telefona je obavezan pri registraciji i u ručnom unosu, pa svaki klijent dobija:
- **24h pre termina**: „podsećamo Vas da sutra u 10:00 imate zakazan tretman: …"
- **na dan termina** (od `SMS_DAY_HOUR`, podrazumevano 8h): „podsećamo Vas da danas u 10:00 …"

Ako je termin zakazan manje od 24h unapred, šalje se samo podsetnik na dan termina; ako je zakazan
istog dana, SMS se ne šalje (klijent je upravo dobio potvrdu). Posle 21h se SMS ne šalje.
Status svakog SMS-a vidi se u Admin → Podsetnici.

Podešavanje (Infobip, dobar izbor za Srbiju):
1. Napravite nalog na **infobip.com** i dopunite kredit
2. U nalogu prepišite **API key** i **Base URL** (izgleda kao `xxxxxx.api.infobip.com`)
3. Na Renderu dodajte `INFOBIP_API_KEY` i `INFOBIP_BASE_URL=https://xxxxxx.api.infobip.com`
4. Po želji zatražite od Infobip-a ime pošiljaoca (npr. `BNSalon`) i postavite `SMS_FROM`

Twilio radi isto tako, sa `TWILIO_ACCOUNT_SID` i `TWILIO_AUTH_TOKEN`. Bez ovih ključeva aplikacija
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

> **Važno za podatke:** bez trajnog diska Render pri **svakom deploy-u** (i restartu) pravi novu,
> praznu bazu — brišu se nalozi, prijave i rezervacije. Za pravu produkciju obavezno uradite korake
> iz odeljka „Trajno čuvanje podataka" ispod.

## Trajno čuvanje podataka (nalozi, prijave, rezervacije)

Zašto se brišu: baza `salon.db` se, dok `DATA_DIR` nije podešen, čuva u folderu same aplikacije.
Render taj folder pri svakom deploy-u pravi iznova iz GitHub-a, pa baza nestane. Prijava (kolačić)
je vezana za nalog u bazi i za `SECRET`, pa i ona prestane da važi.

Rešenje (jednom, na Renderu):
1. **Pre svega:** Admin → **⤓ Rezervna kopija** — sačuvajte fajl (sadrži sve naloge i rezervacije).
2. Render → servis → **Settings → Instance Type**: izaberite **Starter** (Free plan ne podržava disk).
3. Render → servis → **Disks → Add Disk**: Name `podaci`, Mount Path `/data`, Size `1 GB` → Save.
4. Render → **Environment**:
   - dodajte `DATA_DIR` = `/data`
   - proverite da postoji `SECRET` (dugačak nasumičan niz). Ako postoji, **ne menjajte ga nikad** —
     promena `SECRET`-a odjavljuje sve korisnike. Ako ne postoji, aplikacija sama napravi ključ i čuva ga u bazi.
   - Save → Render ponovo postavlja aplikaciju, ovaj put sa bazom na disku `/data`.
5. Ako su podaci posle toga prazni: registrujte se ponovo sa admin adresom → Admin → **⤒ Vrati iz kopije**
   → izaberite fajl iz koraka 1. Nalozi i rezervacije se vraćaju (ništa postojeće se ne briše), a korisnici
   ostaju prijavljeni ako se `SECRET` nije menjao.
6. Provera: otvorite `https://VAŠA-ADRESA/zdravlje` — treba da piše `"trajniDisk":true`. Datum `bazaOd`
   mora ostati isti i posle sledećih deploy-a. U Admin panelu nestaje crveno upozorenje.

Šta je dalje zaštićeno:
- seed (`seed/`) se učitava **samo u potpuno praznu bazu**, a izmene cenovnika u kodu su jednokratne
  i nikad ne diraju naloge ni rezervacije
- aplikacija svakog dana pravi kopiju baze u `/data/kopije` (čuva poslednjih 14 dana)

Ista aplikacija radi i na Railway, Fly.io, Hetzner/DigitalOcean VPS-u ili cPanel hostingu sa Node.js.

## Sopstveni domen (beautyandnutrition.app, kupljen preko Hostinger-a)
1. **Render:** servis → Settings → Custom Domains → **+ Add Custom Domain** → `beautyandnutrition.app` → Save.
   Render sam dodaje i `www.beautyandnutrition.app` i preusmerava ga na glavnu adresu.
2. **Hostinger:** hPanel → Domeni → `beautyandnutrition.app` → **DNS / Nameservers** → DNS zapisi:
   - obrišite postojeće `A` i `AAAA` zapise za `@` i postojeći zapis za `www` (Hostinger ih postavlja sam)
   - dodajte `A` zapis: Name `@`, Points to `216.24.57.1`
   - dodajte `CNAME` zapis: Name `www`, Target `bn-rezervacije.onrender.com`
   - ako postoje `CAA` zapisi, moraju da sadrže `letsencrypt.org` i `pki.goog` (ili ih obrišite)
3. Na Renderu kliknite **Verify**. HTTPS sertifikat se izdaje automatski. Domeni `.app` rade samo preko
   HTTPS-a, pa adresa proradi tek kad je sertifikat izdat (obično nekoliko minuta, zbog DNS-a ponekad i par sati).
4. Kad `https://beautyandnutrition.app` otvori aplikaciju: Render → **Environment** → dodajte
   `SITE_URL=https://beautyandnutrition.app` → Save. Od tada stara adresa `bn-rezervacije.onrender.com`
   vodi na novu (i stari linkovi i QR kodovi), a link za novu lozinku u mejlu koristi novu adresu.

Prijava važi posebno za svaku adresu, pa se na novoj adresi treba jednom ponovo prijaviti.

---

## Prvi koraci posle postavljanja

1. Otvorite aplikaciju → **Registracija** sa adresom `kaca9525@gmail.com` → taj nalog je automatski **Admin**
2. Admin → **Radno vreme**: proverite/izmenite (postavljeno: pon–pet 09–21, sub 10–15, nedelja neradna),
   a u delu **Radno vreme zaposlenih** upišite kada koja zaposlena radi (nedeljni raspored + izuzeci po datumu)
   - Admin → **Klijenti**: adresar (ime, telefon, e-mail, napomena, broj dolazaka). Puni se sam iz online
     rezervacija i ručnog unosa; postojeće klijente uvezite iz Excela (nalepite kolone, `.xlsx` ili CSV) ili
     iz kontakata telefona (`.vcf`), uz pregled pre uvoza. U ručnom unosu termina klijent se predlaže dok kucate
     ime ili broj (broj se prepoznaje u bilo kom zapisu: 064…, +381 64…, 381…)
3. Admin → **Usluge**: cene, trajanja i aktivnost menjate u par klikova; oznaka **„na aparatu"** šalje
   tretman u kolonu **Aparat** (npr. presoterapija, EMS, termo ćebe), pa ne zauzima zaposlene, a isti
   aparat ne može da primi dva klijenta u isto vreme; dugme **„Paketi"** uz uslugu (i uz objavljenu akciju) dodaje
   pakete tretmana sa cenama, npr. „Paket od 10 tretmana: 25.000 RSD"; klijent na kartici bira „1 tretman" ili paket,
   a izbor i cena paketa idu u rezervaciju, potvrdu i mejl
4. Pošaljite mi javnu adresu — **regenerisaću QR karticu** sa njom za minut

## Sigurnosne napomene
- Lozinke se čuvaju isključivo kao scrypt hash + so; prijava je httpOnly kolačić potpisan `SECRET`-om
- Server ponovo proverava svaku rezervaciju (radno vreme, zauzetost, koja zaposlena izvodi koje tretmane)
- Obavezno postavite svoj, dugačak `SECRET` u produkciji
