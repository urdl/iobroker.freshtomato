# Screenshots für das Handbuch

Hier liegen die Bilder, auf die [`docs/de/README.md`](../README.md) verweist.
Solange eine Datei fehlt, steht an der Stelle im Handbuch ein sichtbarer
Platzhalter (`📷 Screenshot einfügen`) — den Absatz nach dem Einfügen des Bildes
durch die Einbindung ersetzen:

```markdown
![Beschreibung](img/dateiname.png)
```

## Was gebraucht wird

| Datei | Inhalt | Fundort |
|---|---|---|
| `uebersicht-objektbaum.png` | Objektbaum einer laufenden Instanz, aufgeklappt bis zu einem `devices.<mac>` | Admin → Objekte |
| `router-http-id.png` | Feld *Web Admin ID* | Router → *Administration → Admin Access* |
| `einstellungen-gesamt.png` | Vollständige Instanzeinstellungen, alle Abschnitte sichtbar | Admin → Instanzen → freshtomato → Einstellungen |
| `einstellungen-influxdb.png` | Abschnitt *InfluxDB logging* mit ausgeklappter Instanzauswahl | dieselbe Seite, unten |
| `trafficenabled-schalter.png` | `devices.<mac>.trafficEnabled` mit sichtbarem Schalter | Admin → Objekte |
| `toggle-vs-editor.png` | Eine Objektzeile mit markiertem Schalter (richtig) **und** markiertem Stift (falsch) | Admin → Objekte |

## Bitte vorher unkenntlich machen

* **Die HTTP-ID** in `router-http-id.png` — sie ist ein Zugangsgeheimnis.
* Passwortfelder in `einstellungen-gesamt.png`, auch wenn sie als Punkte
  dargestellt sind.
* Nach Geschmack Hostnamen und MAC-Adressen fremder Geräte in den
  Objektbaum-Bildern.

## Format

PNG, Breite möglichst nicht über 1400 px — sonst wird die Datei groß, ohne
lesbarer zu werden. Nur den relevanten Ausschnitt zeigen, nicht den ganzen
Bildschirm.
