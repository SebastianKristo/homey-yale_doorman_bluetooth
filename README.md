# Yale lokal Bluetooth for Homey

Styrer Yale Doorman L3 (og andre Yale/August-låser som støttes av Home Assistants `yalexs_ble`)
direkte over Bluetooth fra Homey Pro. Ingen sky, ingen bro.

## Krav
- Homey Pro (2019 eller 2023) med Bluetooth, innenfor rekkevidde av låsen.
- Låsens **offline-nøkkel** (32 hex-tegn) og **slot**.

## Hente offline-nøkkel og slot
Nøkkelen ligger ikke i låsen, men i Yale Home-kontoen din. Yale Home tillater bare innlogging via
Home Assistant (OAuth), så vi låner Home Assistant midlertidig for å hente den. Det tar ca. 10 minutter.

1. Start Home Assistant i Docker på Macen (Docker Desktop må være installert):
   ```bash
   docker run -d --name ha-temp -p 8123:8123 -v ~/ha-temp:/config ghcr.io/home-assistant/home-assistant:stable
   ```
2. Åpne http://localhost:8123, opprett en bruker og fullfør oppsettet.
3. Innstillinger → Enheter og tjenester → Legg til integrasjon → **Yale**. Logg inn med Yale Home-kontoen.
4. Hent nøkkelen:
   ```bash
   node tools/get-offline-key.js ~/ha-temp/.storage/core.config_entries
   ```
   Skriptet viser offline-nøkkel og slot for hver lås.
5. Rydd opp:
   ```bash
   docker rm -f ha-temp && rm -rf ~/ha-temp
   ```

Nøkkelen endres ikke så lenge brukeren beholder tilgangen til låsen, så dette trengs bare én gang.
Kontoen må være eier eller admin av låsen.

## Installere
```bash
npm install -g homey
cd no.kristo.yaleble
homey app install
```
Legg til enhet → «Yale-lås (Bluetooth)» → skriv inn nøkkel og slot → velg låsen.

## Lang avstand: ESPHome Bluetooth-proxy
Står Homey for langt fra låsen, kan appen gå via en ESPHome-enhet med `bluetooth_proxy` nær døren,
f.eks. Everything Presence One, slik Home Assistant gjør. Alt er fortsatt lokalt.

1. Proxyen må ha aktiv Bluetooth-proxy (`bluetooth_proxy: active: true`). Fungerer låsen via proxyen i
   Home Assistant, er dette allerede på plass.
2. I låsens innstillinger i Homey: fyll inn **Proxy IP-adresse** og eventuelt **Proxy krypteringsnøkkel**
   (`api: encryption: key:` fra ESPHome-konfigurasjonen, 44 tegn).
3. Ny lås kan også legges til direkte via proxyen: fyll inn proxy-feltene i parringen.

Deaktiver `yalexs_ble` i Home Assistant, ellers kjemper de om låsen.

## Slik fungerer det
- Lås/lås opp: kobler til, gjør AES-håndtrykk med offline-nøkkelen, sender kommandoen og leser
  faktisk status etterpå. Forbindelsen lukkes etter 20 s uten aktivitet.
- Statusendringer (f.eks. manuell låsing): Homey skanner passivt etter låsens Bluetooth-annonsering
  (standard hvert 30. sekund) og leser status bare når annonseringen endres. I tillegg gjøres en full
  avlesning hver 60. minutt. Begge intervallene kan endres i innstillingene.
- `locked` (lås-/åpne-knapp) og `lock_state` (ukjent/låser/låst/låser opp/ulåst).
- Batterinivå (`measure_battery`) og alarm for lavt batteri (`alarm_battery`, standard under 20 %). Leses ved
  hver full avlesning (standard hver time). Låsen rapporterer spenning, som regnes om til prosent med
  samme AA-tabell som Home Assistant.
- Flow-handling: «Oppdater låsstatus».
