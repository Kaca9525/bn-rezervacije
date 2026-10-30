# Beauty & Nutrition — Rezervacije (produkcijska web aplikacija)

Javna web aplikacija za online zakazivanje: cenovnik tretmana lica i tela (masaže u sklopu
tretmana tela), edukacije na upit, nalozi klijenata, slobodni termini po zaposlenima,
admin panel i automatski e-mail podsetnici dan pre termina.

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
| `PORT`          | ne       | Port servera (hosting ga obično sam zada) |
| `DATA_DIR`      | ne       | Folder za bazu `salon.db` i slike usluga (`DATA_DIR/img`, dodaju se u Admin → Usluge → „Slika"); korisno uz persistent disk |

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

---

## Najbrže postavljanje na internet (Render.com)

1. Napravite besplatan nalog na **github.com** → „New repository" (npr. `bn-rezervacije`, Public)
   → „uploading an existing file" → prevucite **sav sadržaj ovog foldera** (bez `node_modules`) → Commit
2. Napravite nalog na **render.com** → **New → Web Service** → povežite GitHub repo
3. Podešavanja: Build Command `npm install` · Start Command `npm start` · Instance: po želji
4. U **Environment** dodajte promenljive iz tabele iznad (bar `SECRET`; za mejlove i `SMTP_USER`/`SMTP_PASS`)
5. Deploy → dobijate javnu adresu tipa `https://bn-rezervacije.onrender.com`

> **Važno za podatke:** na Render **Free** planu disk nije trajan — rezervacije i slike usluga se mogu izgubiti
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
2. Admin → **Radno vreme**: proverite/izmenite (postavljeno: pon–pet 09–21, sub 10–15, nedelja neradna)
3. Admin → **Usluge**: cene, trajanja i aktivnost menjate u par klikova
4. Pošaljite mi javnu adresu — **regenerisaću QR karticu** sa njom za minut

## Sigurnosne napomene
- Lozinke se čuvaju isključivo kao scrypt hash + so; prijava je httpOnly kolačić potpisan `SECRET`-om
- Server ponovo proverava svaku rezervaciju (radno vreme, zauzetost, koja zaposlena izvodi koje tretmane)
- Obavezno postavite svoj, dugačak `SECRET` u produkciji
