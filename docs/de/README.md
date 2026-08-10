# ioBroker.freshtomato — Handbuch

Ausführliche Dokumentation des Adapters: alle Einstellungen mit ihrer Wirkung,
der Objektbaum, und die Eigenheiten, die man kennen sollte, bevor man sie
schmerzhaft entdeckt.

Die Kurzfassung steht in der [README](../../README.md) (englisch).

> 📷 **Screenshot einfügen:** `docs/de/img/uebersicht-objektbaum.png` —
> Objektbaum einer laufenden Instanz im Admin, aufgeklappt bis `devices.<mac>`.

---

## Inhalt

1. [Was der Adapter tut](#was-der-adapter-tut)
2. [Voraussetzungen](#voraussetzungen)
3. [Einstellungen im Detail](#einstellungen-im-detail)
4. [Der Objektbaum](#der-objektbaum)
5. [Anwesenheitserkennung](#anwesenheitserkennung)
6. [Verkehr pro Gerät](#verkehr-pro-gerät)
7. [Steuerung](#steuerung)
8. [InfluxDB-Protokollierung](#influxdb-protokollierung)
9. [Mehrere Router betreiben](#mehrere-router-betreiben)
10. [Eigenheiten und Fallstricke](#eigenheiten-und-fallstricke)
11. [Fehlersuche](#fehlersuche)
12. [Bekannte Grenzen](#bekannte-grenzen)

---

## Was der Adapter tut

Er liest einen FreshTomato-Router über dessen **lokale Weboberfläche** aus und
kann ihn in engen Grenzen steuern. Kein SSH, kein Telnet, keine Cloud — nur
HTTP(S) im eigenen Netz.

**Beobachtung:** Systemwerte (CPU-Temperatur, Last, Speicher, NVRAM), WAN- und
LAN-Konfiguration, WLAN je Band, Switch-Ports, Byte-Zähler je Schnittstelle,
verbundene Geräte samt Signalstärke und Anwesenheit.

**Steuerung:** WLAN-Radio je Band ein- und ausschalten, DHCP-Lease des WAN
erneuern, Router neu starten (abgesichert, siehe [Steuerung](#steuerung)).

**Was er nicht tut:** Er verändert keine Router-Konfiguration außer den drei
genannten Kommandos, schreibt nicht selbst in Datenbanken und ermittelt keine
Zieladressen einzelner Geräte (siehe [Bekannte Grenzen](#bekannte-grenzen)).

---

## Voraussetzungen

* Ein Router mit **FreshTomato**, dessen Weboberfläche vom ioBroker-Host aus
  erreichbar ist. Entwickelt und geprüft gegen 2026.3 auf einem Netgear R7000
  und einem Netgear WNR3500L/U/v2.
* Benutzername und Passwort der Weboberfläche.
* Die **HTTP-ID** des Routers — ein CSRF-Token, ohne das jede Anfrage
  scheitert.

### Die HTTP-ID finden

Router-Oberfläche → *Administration* → *Admin Access* → **Web Admin ID**.
Der Wert sieht aus wie `TID1a2b3c4d5e6f7890`.

> 📷 **Screenshot einfügen:** `docs/de/img/router-http-id.png` —
> Seite *Administration → Admin Access* mit markiertem Feld *Web Admin ID*.
> **Vorher den Wert unkenntlich machen** — er ist ein Zugangsgeheimnis.

Warum das wichtig ist: Eine falsche HTTP-ID erzeugt **keine** Fehlermeldung.
Der Router kappt stattdessen die Verbindung ohne Antwort, was wie ein
Netzwerkproblem aussieht. Der Adapter erkennt genau diesen Fall und schreibt
*„Router closed the connection without answering"* zusammen mit dem Hinweis auf
die HTTP-ID ins Log — sonst sucht man an der falschen Stelle.

---

## Einstellungen im Detail

> 📷 **Screenshot einfügen:** `docs/de/img/einstellungen-gesamt.png` —
> vollständige Instanzeinstellungen, alle Abschnitte sichtbar.

### Abschnitt *Router connection*

| Einstellung | Standard | Wirkung |
|---|---|---|
| **Host name or IP address** | – | Adresse der Weboberfläche, z. B. `192.168.1.1`. Pflichtfeld. |
| **Port** | `80` | Port der Weboberfläche. Das Umschalten von HTTPS wechselt nur zwischen den beiden Standardwerten 80 und 443; ein selbst gesetzter Port (etwa 8080) bleibt unangetastet. |
| **Use HTTPS** | aus | Nur einschalten, wenn die Weboberfläche tatsächlich auf TLS konfiguriert ist. |
| **Accept a self-signed certificate** | aus | Erscheint nur bei aktivem HTTPS. Siehe unten. |
| **User name** | `root` | Benutzer der Weboberfläche. Pflichtfeld. |
| **Password** | – | Wird verschlüsselt gespeichert. Pflichtfeld. |
| **HTTP ID** | – | Der CSRF-Token von oben. Wird verschlüsselt gespeichert. Pflichtfeld. |

Fehlt eines der Pflichtfelder, beendet sich die Instanz mit einer klaren
Meldung, statt den Router sinnlos anzufragen.

#### HTTPS und das Zertifikat des Routers

FreshTomato erzeugt sein Zertifikat **immer selbst**; ein eigenes hochzuladen
ist nicht vorgesehen. Node lehnt ein solches Zertifikat ab, deshalb schlägt
HTTPS ohne die zweite Option jede Abfrage mit *„Router certificate not
trusted"* fehl.

**Accept a self-signed certificate** ist ein bewusster Kompromiss:

* Der Verkehr **ist** verschlüsselt — niemand liest das Passwort mehr mit.
* Der Adapter prüft aber **nicht mehr**, ob das Zertifikat wirklich zum Router
  gehört. Alles, was unter dieser Adresse antwortet, wird akzeptiert. Damit ist
  ein Angreifer in der Mitte möglich: Er könnte ein eigenes Zertifikat
  vorzeigen, die Zugangsdaten entgegennehmen und den Verkehr weiterreichen,
  ohne dass etwas auffällt.

Im eigenen, kontrollierten Netz ist das meist vertretbar und immer noch besser
als reines HTTP, bei dem das Passwort im Klartext-Umfeld base64-kodiert über
die Leitung geht. Der Adapter schreibt eine Warnung ins Log, solange die Option
aktiv ist — das ist Absicht, nicht Lärm.

Der Hostname ist dabei **nicht** das Problem: Das erzeugte Zertifikat führt den
Router sowohl unter seiner IP als auch unter seinem Namen. Es fehlt allein die
Signatur einer vertrauenswürdigen Stelle.

### Abschnitt *Polling*

| Einstellung | Standard | Wirkung |
|---|---|---|
| **Poll interval** | `30` s | Wie oft der Router abgefragt wird. Erlaubt 10–600 s. |
| **Request timeout** | `15` s | Wie lange eine einzelne Anfrage dauern darf. Erlaubt 5–120 s. Siehe unten. |
| **Offline timeout** | `120` s | Karenzzeit, bis ein Gerät ohne Lebenszeichen als offline gilt. Erlaubt 0–3600 s. Ausführlich unter [Anwesenheitserkennung](#anwesenheitserkennung). |
| **Create one channel per connected device** | ein | Legt je verbundenem Gerät einen eigenen Kanal an. |

**Zum Poll-Intervall:** Jeder Durchlauf schreibt mehrere hundert Datenpunkte.
Läuft ein Durchlauf länger als das Intervall, wird der nächste übersprungen
statt parallel gestartet — der Adapter überholt sich nicht selbst.

**Zum Anfrage-Timeout:** Hängt am Router und an der Leitung, nicht am Adapter.
Gemessen an einem WNR3500L in einem langsamen Netz: Die Verkehrsseite brauchte
7–19 Sekunden, während alle anderen Abfragen unter 300 ms blieben — bei
vormals fest verdrahteten 15 Sekunden scheiterte damit etwa jeder sechste
Durchlauf. Bei einem alten Router oder einer schwachen Verbindung also erhöhen.

Der Adapter geht dem Problem inzwischen aus dem Weg: Hat ein Router einmal
gezeigt, dass er **keinen** Verkehr zählt, wird diese Abfrage übersprungen und
nur etwa alle zwanzig Durchläufe zur Kontrolle wiederholt — falls der Router
umkonfiguriert wurde. Am Messobjekt fiel ein Poll dadurch von 8,7 s auf 0,1 s.
Wer Verkehr je Gerät eingeschaltet hat, bekommt die Abfrage weiterhin jedes Mal.

Diese Abfrage steht dabei für sich: Läuft nur sie in den Timeout, scheitert
nicht der ganze Durchlauf — alle anderen Werte werden trotzdem geschrieben. Ein
gescheiterter Versuch gilt außerdem nicht als „Router zählt nichts"; das lernt
der Adapter nur aus einer tatsächlich beantworteten, leeren Liste. Sonst hätte
ein einzelner Aussetzer genügt, um die Erkennung dauerhaft falsch einzustellen.

**Zu den Geräte-Kanälen:** Auf einem großen Netz entstehen sonst schnell
mehrere hundert Objekte. Abschalten reduziert das drastisch, die vollständige
Geräteliste bleibt als JSON unter `devices.json` erhalten. **Aber:** Ohne
Kanäle gibt es auch keine `trafficEnabled`-Schalter und keine Anwesenheit je
Gerät.

### Abschnitt *Control*

| Einstellung | Standard | Wirkung |
|---|---|---|
| **Allow rebooting the router** | aus | Erst wenn gesetzt, ist `system.reboot` überhaupt beschreibbar. |

Siehe [Steuerung](#steuerung) — dort steht, warum das doppelt abgesichert ist.

### Abschnitt *InfluxDB logging*

| Einstellung | Standard | Wirkung |
|---|---|---|
| **InfluxDB instance** | disabled | Welche InfluxDB-Adapter-Instanz die Werte aufzeichnet. |
| **Datapoint prefix** | – | Wird als Alias je Datenpunkt gesetzt: `<präfix>.system.load1`. Leer = echter Datenpunktname. |
| **Log system KPIs** | aus | CPU-Temperatur, CPU-Auslastung, Lastmittelwerte, Speicher. |
| **Log network KPIs** | aus | `rxBytes`/`txBytes` je Schnittstelle, WAN erreichbar. |
| **Log WLAN KPIs** | aus | Clientzahl, Radio-Temperatur, Rauschpegel je Band. |
| **Log device counts** | aus | `devices.count`, `devices.wirelessCount`, `devices.onlineCount`, `devices.offlineCount`. |

> 📷 **Screenshot einfügen:** `docs/de/img/einstellungen-influxdb.png` —
> der InfluxDB-Abschnitt mit ausgeklappter Instanzauswahl.

Ausführlich unter [InfluxDB-Protokollierung](#influxdb-protokollierung).

---

## Der Objektbaum

| Zweig | Inhalt |
|---|---|
| `info` | `connection`, `firmware`, `model`, `routerName`, `uptime`, `uptimeText`, `lastUpdate`, `influxManaged` |
| `system` | CPU-Temperatur, CPU-Auslastung, Lastmittelwerte, Speicher, Swap, NVRAM-Belegung, Prozesse, CPU- und Bootloader-Angaben, **`reboot`** |
| `network.wan`, `network.wan2` … | IP, Netzmaske, Gateway, DNS, Domain, Hostname, Protokoll, MAC, MTU, `connected`, `uptime` (Verbindungsdauer), `leaseRemaining` (Rest-Laufzeit der WAN-DHCP-Lease), **`renewLease`**. Nur tatsächlich genutzte WANs werden angelegt. |
| `network.lan` | IP, Netzmaske, MAC, Gateway, Bridge-Schnittstelle, DHCP-Bereich |
| `wlan.2G`, `wlan.5G` | SSID, Kanal, Mittenfrequenz, Kanalbreite, Maximalrate, Rauschpegel, Radio-Temperatur, Sicherheitsmodus, Verschlüsselung, versteckt, Clientzahl, **`radioEnabled`** |
| `interfaces.<name>` | `rxBytes`, `txBytes` je Schnittstelle |
| `ports.<name>` | Verbindungsstatus, Geschwindigkeit, Duplex je Switch-Port |
| `usb.<disk+partition>` | Hersteller, Produkt, Disk, Partitionsnummer, Datenträgername, Mountpoint, Dateisystem, Größe gesamt/frei/belegt, Prozent belegt, `attached`. Ein Eintrag je gemounteter Partition; beim Abziehen bleiben die Größenangaben stehen, nur `attached` wird `false`. |
| `devices` | `count`, `wirelessCount`, `onlineCount`, `offlineCount`, `json` |
| `devices.<mac>` | siehe unten |

**Fett** = beschreibbar.

### Ein Gerätekanal

| Datenpunkt | Bedeutung |
|---|---|
| `mac`, `ip`, `hostname`, `interface` | Identität und aktuelle Zuordnung |
| `online` | Anwesend? Siehe [Anwesenheitserkennung](#anwesenheitserkennung) |
| `presenceSource` | **Warum** es als anwesend gilt: `wireless`, `traffic`, `arp`, `grace`, `offline` |
| `lastSeen` | Zeitpunkt des letzten Lebenszeichens |
| `wireless`, `band`, `rssi`, `txRate`, `rxRate`, `connectedTime` | nur bei WLAN-Clients gefüllt |
| `leaseExpires` | Restlaufzeit der DHCP-Lease als Text |
| **`trafficEnabled`** | Schalter: Verkehr für dieses Gerät protokollieren |
| `bytesIn`, `bytesOut`, `rateIn`, `rateOut` | entstehen erst, wenn `trafficEnabled` gesetzt ist |

**Der Schlüssel ist die MAC-Adresse**, nicht der Name. Ein Gerät behält damit
seinen Kanal, auch wenn sich seine IP oder sein Hostname ändert. Der Name steht
als Bezeichnung am Kanal, sichtbar in der Namensspalte des Objektbaums.

Warum nicht der Name als ID? Weil Namen weder eindeutig noch stabil sind. Im
Testnetz melden zwei verschiedene Geräte denselben Hostnamen — als ID würde
eines das andere überschreiben. Und beim Umbenennen entstünde ein neuer Kanal,
während der alte samt Historie verwaist.

**Geräte werden nie gelöscht.** Verschwindet eines, bleibt sein Kanal erhalten
und `online` geht auf `false`. So bleibt die Historie erhalten. Wer einen Kanal
wirklich loswerden will, löscht ihn von Hand — er kommt zurück, sobald der
Router das Gerät wieder meldet.

---

## Anwesenheitserkennung

Das ist die Eigenheit mit den meisten Überraschungen, deshalb ausführlich.

### Das Problem

Naheliegend wäre: „Steht das Gerät in der ARP-Tabelle des Routers? Dann ist es
da." Das ist **falsch**. Die ARP-Tabelle behält Einträge lange, nachdem ein
Gerät verschwunden ist — eine gelöschte DHCP-Reservierung kann dort bis zum
nächsten Neustart stehen bleiben —, und sie trägt keinen Zeitstempel. Ein
Gerät, das seit Wochen nicht im Netz war, sah damit dauerhaft „online" aus.

### Die Regel

Ein Gerät gilt nur bei einem **Lebenszeichen** als anwesend:

1. Es ist als **WLAN-Client assoziiert** → `presenceSource: wireless`
2. Seine **Verkehrszähler sind gewachsen** seit der letzten Abfrage →
   `presenceSource: traffic`

Kein Lebenszeichen, aber noch innerhalb der Karenzzeit → `grace`.
Danach → `offline`.

### Das Offline-Timeout

Die Karenzzeit zwischen dem letzten Lebenszeichen und `online = false`. Sie
überbrückt die Lücken zwischen zwei Abfragen und, bei Kabelgeräten, die Pausen
zwischen Verkehrsschüben.

* **Höher** (z. B. 600 s): Geräte bleiben durch längere Ruhephasen online.
  Sinnvoll bei Geräten, die selten funken.
* **Niedriger** (z. B. 60 s): Abwesenheit wird schneller erkannt, dafür
  „flackern" ruhige Geräte eher.
* **`0`**: Ein Gerät geht offline, sobald eine Abfrage keine Aktivität zeigt.

### Router ohne Verkehrszählung — der `arp`-Fall

Nicht jeder Router zählt Verkehr je Adresse. Ein Gerät im **Access-Point-Modus**
brückt den Verkehr, statt ihn zu routen — er durchläuft nie den Pfad, an dem
die Zählung hängt. Solche Router liefern eine **leere** Zählerliste.

Dort könnte ein Kabelgerät nie ein Lebenszeichen erzeugen, und die strenge
Regel würde **jedes** davon dauerhaft als offline melden. Das ist real
passiert: Auf einem WNR3500L im AP-Modus standen 5 von 6 anwesenden Geräten
auf offline.

Liefert ein Router **überhaupt keine** Zähler, stützt sich die Anwesenheit
deshalb auf die Router-Tabellen — sichtbar als `presenceSource: arp`. Der
Adapter schreibt beim Start einmalig eine Info-Meldung, welcher Modus gilt.

Das ist ein schwächeres Indiz — ein veralteter Eintrag kann ein Gerät länger
online halten —, aber deutlich besser, als ein offensichtlich anwesendes Gerät
als weg zu melden. Der Fallback wirkt **pro Router automatisch**; ein Router
**mit** Zählung behält die strengen Regeln.

Nachgemessen: Das Einschalten des IP-Traffic-Monitors am AP hilft **nicht**.
Mit `cstats_enable=1` und `cstats_all=1` blieb die Liste über eine
Viertelstunde leer. Es ist keine Fehlkonfiguration, sondern die Bauart.

### Drei Konsequenzen

Sie gelten auf Routern **mit** Zählung; wo der `arp`-Fallback greift, keine
davon:

* Ein eingeschaltetes, aber völlig stilles Gerät fällt nach der Karenzzeit
  offline. Für diesen Fall ist der ioBroker-**`ping`-Adapter** das richtige
  Werkzeug, nicht dieser.
* Ein veralteter ARP-Eintrag sinkt von selbst auf offline, statt ewig online zu
  stehen — genau das war das Ziel.
* Ein reines Kabelgerät kann nach einem Adapter-Neustart **eine Runde lang**
  offline erscheinen: Sein Nachweis kommt aus wachsenden Zählern, und die erste
  Abfrage legt nur den Ausgangswert fest.

---

## Verkehr pro Gerät

Der Router kann Byte-Zähler je Adresse liefern. Der Adapter macht daraus vier
Datenpunkte pro ausgewähltem Gerät:

| Datenpunkt | Bedeutung |
|---|---|
| `bytesIn`, `bytesOut` | Kumulative Zähler, wie der Router sie meldet |
| `rateIn`, `rateOut` | Bytes pro Sekunde seit der letzten Abfrage |

### Ein- und ausschalten

Je Gerät gibt es den Schalter **`devices.<mac>.trafficEnabled`** im Objektbaum.
Er wirkt **sofort**, ohne Adapter-Neustart, und übersteht Neustarts.

> 📷 **Screenshot einfügen:** `docs/de/img/trafficenabled-schalter.png` —
> Objektbaum mit `devices.<mac>.trafficEnabled` und sichtbarem Schalter.

**Wichtig — so schaltet man ihn richtig:** Den **Schalter/Toggle** benutzen,
nicht das Werte-Bearbeiten-Feld (Stift). Grund steht unter
[Das ack-Flag](#das-ack-flag-warum-ein-schalter-manchmal-nichts-tut) — das ist
die häufigste Stolperfalle.

Solange kein Gerät ausgewählt ist, entstehen keine Verkehrs-Datenpunkte. Die
Auswahl steckt bewusst **nicht** in den Instanzeinstellungen: Der Adapter kennt
die Geräte längst, und eine Tabelle mit handgetippten MAC-Adressen wäre
doppelte Arbeit.

Wird ein Gerät wieder abgeschaltet, verwirft der Adapter dessen Ausgangswert.
Sonst gäbe ein späteres Wiedereinschalten einen gewaltigen Ausschlag über die
gesamte Lücke.

### Was die Zahlen bedeuten — und was nicht

Die Bedeutung der Spalten wurde **gemessen**, nicht angenommen: Zwei Proben im
Abstand von 45 s, gegengeprüft an den Byte-Zählern der LAN-Bridge. Sechs
weitere Spalten bleiben unbenutzt; einige wurden beim Messen *kleiner*, sind
also keine Zähler.

Springt ein Zähler zurück (Router neu gestartet), wird für dieses Intervall
**keine** Rate gemeldet — statt einer negativen oder absurd großen Zahl.

Zugeordnet wird über die aktuelle IP. Ein Gerät ohne IP wird übersprungen,
statt zu raten: Eine per DHCP weitergegebene Adresse würde sonst fremden
Verkehr zuschreiben.

**Das zeigt, wie viel ein Gerät sendet — nicht wohin.** Siehe
[Bekannte Grenzen](#bekannte-grenzen).

---

## Steuerung

Drei Datenpunkte sind beschreibbar:

| Datenpunkt | Wirkung | Absicherung |
|---|---|---|
| `wlan.<band>.radioEnabled` | Schaltet dieses Funkmodul ein/aus | – |
| `network.<wan>.renewLease` | Erneuert die DHCP-Lease dieses WAN | – |
| `system.reboot` | Startet den Router neu | Option nötig, siehe unten |

### Wie bestätigt wird

Der Adapter setzt den gemeldeten Wert **nicht optimistisch**. Er liest den
Router wenige Sekunden nach dem Kommando erneut — was der Router tatsächlich
getan hat, ist verlässlicher als das, worum er gebeten wurde.

Die Wartezeit ist Absicht: Der Router bestätigt, bevor ein Funkmodul
hochgefahren ist. Eine sofortige Abfrage meldete den alten Wert und sähe aus,
als wäre das Kommando ignoriert worden.

### ⚠ Radio abschalten trennt WLAN-Clients

**Ein abgeschaltetes Funkmodul kann von einem WLAN-Gerät aus nicht wieder
eingeschaltet werden.** Vor dem Ausschalten sicherstellen, dass ein
kabelgebundener Weg zum Router oder zu ioBroker besteht.

### ⚠ Neustart

`system.reboot` nimmt den ganzen Haushalt für eine Minute oder länger vom Netz,
wenn der Router die einzige Internetanbindung ist. Deshalb doppelt abgesichert:

1. Das Objekt ist **nicht beschreibbar**, solange *Allow rebooting the router*
   nicht gesetzt ist.
2. Der Handler prüft die Option beim Schreiben **erneut** — für den Fall, dass
   das Objekt anders beschreibbar wurde (importierte Konfiguration, manuelle
   Änderung, ältere Version).

Nur der Wert **`true`** löst aus; ein beliebiger „wahrer" Wert tut nichts.

Dass der Router während des Neustarts nicht mehr antwortet, ist erwartet und
wird nicht als Fehler gewertet.

---

## InfluxDB-Protokollierung

Für Langzeit-Graphen, etwa in Grafana.

### Der Ansatz

Der Adapter **schreibt nicht selbst** nach InfluxDB und kennt **keine**
InfluxDB-Zugangsdaten. Er setzt an den ausgewählten Datenpunkten die
**Protokollier-Option** — dieselbe, die man sonst im Objektbaum je Datenpunkt
von Hand anhakt. Geschrieben wird vom InfluxDB-Adapter mit dessen eigener
Verbindung.

Das ist der ioBroker-übliche Weg und hält die gesamte InfluxDB-Frage aus diesem
Adapter heraus.

### Gruppen statt Einzelauswahl

| Gruppe | Datenpunkte |
|---|---|
| System | CPU-Temperatur, CPU-Auslastung, Lastmittelwerte, freier/verfügbarer/gesamter Speicher |
| Netz | `rxBytes`/`txBytes` je Schnittstelle, WAN `connected` |
| WLAN | Clientzahl, Radio-Temperatur, Rauschpegel je Band |
| Geräte-Zähler | `devices.count`, `devices.wirelessCount`, `devices.onlineCount`, `devices.offlineCount` |

**Verkehr pro Gerät ist bewusst nicht dabei** — er ist dynamisch und ergäbe
eine Zeitreihe je Gerät. Wer ihn braucht, aktiviert ihn einzeln am jeweiligen
`bytesIn`/`bytesOut`.

### Das Präfix

Wird als **Alias** je Datenpunkt gesetzt. Präfix `freshtomato` speichert
`system.load1` als `freshtomato.system.load1`. Leer lassen speichert unter dem
echten Datenpunktnamen.

### Was der Adapter nicht anfasst

Er schaltet **nur ab, was er selbst eingeschaltet hat** — geführt in
`info.influxManaged`. Ein Datenpunkt, den du von Hand aktiviert hast, bleibt
unangetastet.

Lässt sich ein Datenpunkt nicht abschalten, weil die InfluxDB-Instanz gerade
nicht antwortet, bleibt er auf der Merkliste und wird beim nächsten Start
erneut versucht — statt stillschweigend weiterzuprotokollieren.

### Abschalten und Instanzwechsel

Setzt du die Auswahl auf **„disabled"** oder wechselst auf eine andere Instanz,
schaltet der Adapter die Protokollierung dort ab, wo er sie eingeschaltet hat.
Er merkt sich dazu **welche Instanz** seine Datenpunkte hält, nicht nur welche
— das Zurücknehmen geschieht beim nächsten Start.

Was dabei nicht durchgeht, weil die Instanz gerade nicht antwortet, bleibt der
alten Instanz zugeordnet und wird beim übernächsten Start erneut versucht.

### Grenze

Die Auswahl wird **einmal beim Start** aufgelöst. Ein Datenpunkt, der später
erst entsteht (ein WAN, das nach dem Start verbindet), wird erst nach einem
Adapter-Neustart erfasst.

---

## Mehrere Router betreiben

Je Router **eine eigene Instanz**. Jede hat ihren eigenen Objektbaum:

```
freshtomato.0.devices.<mac>     ← Router A
freshtomato.1.devices.<mac>     ← Router B
```

Gleiche MAC, aber **zwei unabhängige Objekte**. Nichts wird zusammengeführt.

### Warum dasselbe Gerät oft in beiden auftaucht

Stehen beide Router im selben Subnetz und ist einer davon der eigentliche
Router, läuft der Verkehr **aller** Geräte über ihn — auch der von Geräten, die
am Access Point hängen. Damit landen sie in beiden ARP-Tabellen.

Im Testaufbau: 8 von 9 Kanälen der AP-Instanz existieren auch in der
Router-Instanz.

### Wann welche Instanz „online" meldet

| | Router (zählt Verkehr) | Access Point (zählt nicht) |
|---|---|---|
| Signal | WLAN-Assoziation **oder** wachsende Zähler | WLAN-Assoziation **oder** ARP-Tabelle |
| `presenceSource` | `wireless` / `traffic` / `grace` | `wireless` / `arp` |

### Ein Gerät wechselt vom Router zum Access Point

* Die **AP-Instanz** meldet `wireless` — es hängt jetzt an diesem Funkmodul.
* Die **Router-Instanz** verliert die Assoziation, aber der Verkehr läuft
  weiter über den Router → sie wechselt von `wireless` auf `traffic` und bleibt
  **online**.

Es steht dann in **beiden** auf online. Das ist richtig so: Die beiden
Instanzen beantworten verschiedene Fragen — „hängt es an diesem Funkmodul" und
„läuft sein Verkehr über diesen Router".

### ⚠ Nicht addieren

`devices.count` gilt je Instanz. Die Summe über mehrere Instanzen zählt Geräte
doppelt; eine instanzübergreifende Entdopplung gibt es nicht.

Woran man sieht, wo ein Gerät wirklich funkt: am Feld `wireless` und an
`presenceSource` der jeweiligen Instanz.

---

## Eigenheiten und Fallstricke

### Das ack-Flag: warum ein Schalter manchmal nichts tut

ioBroker unterscheidet zwei Arten von Schreibvorgängen:

* **Kommando** (`ack: false`) — „mach das". Entsteht, wenn man den **Schalter**
  klickt.
* **Ist-Wert** (`ack: true`) — „so ist es". Entsteht, wenn man den Wert über
  das **Bearbeiten-Feld (Stift)** setzt, und ist das, was der Adapter selbst
  schreibt.

**Der Adapter reagiert ausschließlich auf Kommandos.** Ein per Stift gesetzter
Wert wird bewusst ignoriert — sonst würde der Adapter auf seine eigenen
Schreibvorgänge reagieren und sich selbst in Schleifen versetzen.

Praktisch heißt das: Wenn `trafficEnabled`, `radioEnabled` oder `reboot`
„nichts tun", wurde fast immer der Wert bearbeitet statt der Schalter benutzt.
Der Datenpunkt ist nicht kaputt.

> 📷 **Screenshot einfügen:** `docs/de/img/toggle-vs-editor.png` —
> Objektbrowser-Zeile mit markiertem Schalter (richtig) und markiertem
> Stift-Symbol (falsch).

### Der Router antwortet nicht in JSON

FreshTomato liefert **JavaScript-Quelltext** — Zuweisungen wie
`arplist = [...]`, mit unquoteten Schlüsseln, einfachen Anführungszeichen,
hexadezimalen Zahlen und Lücken in Arrays.

Der Adapter parst das mit einem eigenen Tokenizer und **führt es bewusst nicht
aus** (kein `eval`). Sonst würde er ausführen, was der Router schickt. Ein
kompromittierter oder fehlerhafter Router kann dadurch höchstens einen
Parse-Fehler auslösen.

Scheitert eine einzelne Variable, bricht nicht die ganze Abfrage ab: Die
betroffene wird gemeldet, der Rest verarbeitet.

### Geheimnisse im Log

Zwei Werte dürfen nie im Log landen: das Passwort und die HTTP-ID.

Heikel ist die HTTP-ID, weil der Router sie **selbst zurückliefert** — sie
steht im nvram-Abzug von `status-data.jsx` — und bei GET-Anfragen in der
Adresse steht. Beides ist schon einmal in einer Fehlermeldung gelandet.

Deshalb läuft **jede** Log-Ausgabe, die einen Fremdstring führt, durch eine
Maskierung. Diese arbeitet zusätzlich mustererkennend: Nur den konfigurierten
Wert zu maskieren reicht nicht — ist er falsch, schickt der Router die *echte*
ID, die der Adapter nie gesehen hat.

### Verbindung wird gekappt statt Fehler gemeldet

Siehe [Voraussetzungen](#voraussetzungen). Bei falscher HTTP-ID gibt es keinen
HTTP-Fehlercode, sondern einen Verbindungsabbruch. Der Adapter erkennt das und
nennt die HTTP-ID als wahrscheinliche Ursache.

### WAN-Verbindungsdauer und Lease-Restlaufzeit sind Text, keine Zahl

`network.<wan>.uptime` und `network.<wan>.leaseRemaining` kommen nicht aus dem
nvram-Abzug, sondern aus einem eigenen `stats`-Objekt in `status-data.jsx`,
mit dem der Router seine eigene Statusseite füllt — bereits fertig formatiert
(`"11 days, 20h 01m 23s"`, `"00h 23m 26s"`). Der Adapter reicht das unverändert
durch, statt es in Sekunden umzurechnen: das Format ist Router-intern und eine
eigene Umrechnung könnte dessen Rundung falsch nachbilden. Ein WAN, das gerade
nicht verbunden ist, zeigt hier `"--"`, wie auf der Router-Oberfläche auch.

Die tatsächliche Lease-**Zeit** des ISP (wie lange sie insgesamt gilt) steht
nirgends — nur die Restlaufzeit bis zur nächsten Erneuerung.

### USB-Geräte: pro Partition, nicht pro Stick

`usb.<disk+partition>` bildet nicht den USB-Stick als Ganzes ab, sondern jede
**gemountete Partition** einzeln (Kennung z.B. `sda1`) — das ist die Einheit,
deren freien Platz man tatsächlich überwachen will. Ein Stick mit zwei
Partitionen erzeugt zwei Objekte, mehrere Sticks entsprechend mehr.

Eine Disk ohne erkanntes/gemountetes Dateisystem erzeugt **kein** Objekt — der
Router liefert dafür keine Größe und keinen Mountpoint, es gäbe nichts
anzuzeigen. Angesteckt, aber nicht gemountet bleibt damit unsichtbar.

Beim Abziehen verschwindet das Objekt nicht: Größe, Mountpoint und Dateisystem
bleiben auf dem letzten bekannten Stand stehen, nur `attached` wechselt auf
`false`. Wer das auswerten will, muss auf `attached` prüfen, nicht auf das
Vorhandensein des Objekts.

### Der Adapter blockiert nicht wegen InfluxDB

Nachrichten an die InfluxDB-Instanz laufen mit Zeitlimit, und der Abgleich
findet statt, **nachdem** die Abfrage schon läuft. Eine gestoppte
InfluxDB-Instanz kann die Überwachung damit nicht aufhalten.

---

## Fehlersuche

| Beobachtung | Wahrscheinliche Ursache |
|---|---|
| *„Router closed the connection without answering"* | **HTTP-ID falsch.** Kein Netzwerkproblem. |
| *„Router rejected the credentials (HTTP 401)"* | Benutzername oder Passwort falsch. |
| *„Router certificate not trusted"* | HTTPS aktiv, aber *Accept a self-signed certificate* nicht gesetzt. |
| *„No answer from … within … ms"* | Adresse/Port falsch, Router nicht erreichbar, oder er startet gerade einen Dienst neu. **Steht dort ein Name statt einer IP, kann auch die Namensauflösung hängen** — siehe unten. |
| Ein Schalter tut nichts | Wert per Stift gesetzt statt Schalter geklickt → [ack-Flag](#das-ack-flag-warum-ein-schalter-manchmal-nichts-tut). |
| Alle Kabelgeräte offline | Router zählt keinen Verkehr → sollte automatisch auf `arp` fallen. Prüfen, ob `presenceSource` `arp` zeigt und die Info-Meldung im Log steht. |
| Geräte flackern zwischen online/offline | Offline-Timeout zu knapp für ruhige Geräte. Erhöhen. |
| Keine `bytesIn`/`bytesOut` an einem Gerät | `trafficEnabled` nicht gesetzt, Gerät hat keine IP, oder der Router zählt gar nicht. |
| Radio-Temperatur bleibt leer | Diese Hardware liefert keinen Sensor. Meldet der Router einen Wert, kann ihn der Adapter aber nicht lesen, erscheint eine Warnung. |
| Keine Verbindung nach Adapter-Start | Pflichtfelder unvollständig — das Log nennt die fehlenden. |

### Hostname statt IP: der Timeout, der keiner ist

Ein Zeitablauf bedeutet nicht zwingend, dass der Router schweigt. **Auch eine
hängende Namensauflösung läuft in dieselbe Frist.** Real beobachtet: Nach der
Umstellung von `192.168.1.101` auf den Hostnamen meldete die Instanz minutenlang
*„No answer … within 15000 ms"*, während der Router die ganze Zeit erreichbar
war — unter seiner IP wie unter seinem Namen, nur eben nicht vom ioBroker-Host
aus auflösbar.

Zwei häufige Ursachen:

* **Kurzer Name** ohne passende Search-Domain (`router-ap` statt
  `router-ap.example.local`).
* **`.local`-Endung** auf einem Host ohne mDNS. `.local` ist für Multicast-DNS
  reserviert; fehlt Avahi bzw. `nss-mdns`, kann die Anfrage blockieren, statt
  sauber zu scheitern.

Der Adapter weist bei einem Namen inzwischen ausdrücklich darauf hin. Im Zweifel
**die IP eintragen** — sie hängt an keiner Auflösung. Bei einem Router mit
fester Adresse im eigenen Netz ist das ohnehin die robustere Wahl.

**Mehr Details:** Log-Stufe der Instanz auf `debug` stellen. Die Maskierung
bleibt dabei aktiv.

---

## Bekannte Grenzen

**Zieladressen einzelner Geräte lassen sich nicht ermitteln.** Der Router
bietet dafür keine brauchbare Datenquelle: Sein Web-Monitor liest
HTTP-Host-Header und unverschlüsseltes DNS mit — beides existiert bei heutigen
Geräten kaum noch, entsprechend bleibt er auch bei aktivierter Aufzeichnung
leer. Wer wissen will, *wohin* ein Gerät funkt, braucht einen mitschreibenden
DNS-Resolver (Pi-hole, AdGuard Home); beide haben eigene ioBroker-Adapter.

**Der Adapter ersetzt keinen Ping-Adapter.** Er sieht nur, was der Router
sieht. Ein eingeschaltetes, aber völlig stilles Gerät kann er nicht von einem
abwesenden unterscheiden.

**Verkehr wird pro Adresse gezählt, nicht pro Gerät.** Wechselt eine IP per
DHCP den Besitzer, wechselt auch die Zuordnung. Deshalb werden Geräte ohne
aktuelle IP übersprungen, statt geraten.

**Nicht jeder Router kann alles.** Sensoren (CPU-/Radio-Temperatur) und
Verkehrszählung hängen an Hardware und Betriebsmodus. Fehlende Werte bleiben
leer, statt erfunden zu werden.
