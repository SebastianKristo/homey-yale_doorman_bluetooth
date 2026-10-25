Styr Yale Doorman L3 og andre Yale/August-låser direkte over Bluetooth fra Homey, uten sky og uten bro.

Appen bruker låsens lokale Bluetooth-protokoll (samme som Home Assistants yalexs_ble-integrasjon). Lås og lås opp, se låsstatus og batterinivå, og få varsel ved lavt batteri.

For å legge til låsen trenger du låsens offline-nøkkel og slot. Har du Home Assistant, viser parringen i Homey nøyaktig hvilke kommandoer som henter dem. Uten Home Assistant: se https://github.com/SebastianKristo/homey-yale_doorman_bluetooth

Står Homey langt fra døren, kan appen gå via en ESPHome Bluetooth-proxy (f.eks. Everything Presence One). Valget «Alltid tilkoblet» gir raskest lås/lås opp, og Flow-kortet «Lokal styring feilet» lar Yale Home-appen (Wi-Fi-bro) ta over som reserve.

Control Yale Doorman L3 and other Yale/August locks directly over Bluetooth from Homey, without cloud or bridge. Lock, unlock, lock state, battery level and low battery alarm. Requires the lock's offline key and slot; see the GitHub page for how to obtain them.
