# Yale lokal Bluetooth for Homey

Styrer Yale Doorman L3 (og andre Yale/August-låser som støttes av Home Assistants `yalexs_ble`)
direkte over Bluetooth fra Homey Pro. Ingen sky, ingen bro.

## Krav
- Homey Pro (2019 eller 2023) med Bluetooth, innenfor rekkevidde av låsen.
- Låsens **offline-nøkkel** (32 hex-tegn) og **slot**.

## Hente offline-nøkkel og slot
Nøkkelen ligger ikke i låsen, men i Yale Home-kontoen din:
1. **Home Assistant:** Legg til Yale-integrasjonen (sky) én gang. Den henter nøklene automatisk og
   `yalexs_ble` viser dem. Du finner dem i `.storage/core.config_entries` under `yalexs_ble`
   (`key` og `slot`).
2. **Python:** biblioteket [`yalexs`](https://github.com/bdraco/yalexs) kan logge inn på Yale Home-kontoen
   og lese `offline_key` / `offline_slot` fra låsdetaljene.

Tips: Opprett en egen gjestebruker i Yale Home-appen for Homey, så får Homey sin egen slot.

## Installere
```bash
npm install -g homey
cd no.kristo.yaleble
homey app install
```
Legg til enhet → «Yale-lås (Bluetooth)» → skriv inn nøkkel og slot → velg låsen.

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
