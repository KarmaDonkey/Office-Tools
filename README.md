# PDF-verktyg

En PDF-app som körs helt i webbläsaren. Filerna bearbetas lokalt på datorn och laddas aldrig upp någonstans. Appen kan installeras (PWA) och fungerar offline efter första besöket.

Byggd för Chrome och Edge på datorn. Gränssnittet är responsivt men är inte testat på iPhone/iPad.

## Funktioner

**Läsa och navigera**
- Visa PDF med zoom (Ctrl+hjul, Ctrl+plus/minus, anpassa till bredd eller hel sida)
- Miniatyrer i sidopanelen och en sidöversikt i rutnät
- Sök i texten, med träffar markerade på sidan

**Sidor**
- Ändra ordning genom att dra miniatyrer (flera sidor åt gången med Ctrl/Skift)
- Rotera, ta bort och plocka ut sidor
- Dela upp: varje sida, var N:e sida, efter intervall eller efter filstorlek
- Slå ihop PDF-filer och bilder, infoga filer eller tomma sidor

**Redigera**
- Markera text, skriva text, rita, signera (ritad signatur eller bild) och infoga bilder
- Fylla i formulär (textfält, kryssrutor, listor)
- Maskera känslig text på riktigt: innehållet under maskeringen tas bort ur filen
- Vattenstämpel, sidnummer och metadata
- Ta bort anteckningar med radergummit

**Filer**
- Öppna lösenordsskyddade filer, ta bort lösenordet eller sätt ett nytt (AES-256)
- Komprimera (utan förlust, medel eller stark bildkomprimering)
- Bilder till PDF och PDF till bilder (PNG/JPEG, 72–300 dpi)
- Spara direkt i originalfilen, senaste filer och "Öppna med" från Utforskaren (installerad app)
- Ångra/gör om för alla ändringar, mörkt läge

## Utveckling

Kräver Node 22.

```sh
npm install
npm run dev      # utvecklingsserver
npm test         # tester för PDF-motorn (körs i Node)
npm run build    # bygger till dist/
npm run preview  # kör det byggda resultatet lokalt
```

### Struktur

| Sökväg | Innehåll |
|---|---|
| `src/core/engine.js` | All PDF-bearbetning ovanpå MuPDF.js. Ren JavaScript som går att testa i Node. |
| `src/worker/pdf.worker.js` | Web Worker som kör motorn utanför huvudtråden. |
| `src/client.js` | Anrop till workern och en prioriterad kö för rendering. |
| `src/ui/` | Gränssnittet: visare, miniatyrer, sök, dialoger, filhantering. |
| `src/sw.js` | Service worker för offline-läge. Fillistan fylls i vid bygget (`vite.config.js`). |
| `tests/` | Tester för motorn. |

## Publicering

`.github/workflows/pages.yml` bygger och publicerar på GitHub Pages vid varje push till `main`. Första gången behöver GitHub Pages aktiveras: **Settings → Pages → Source: GitHub Actions**.

## Licens

GNU Affero General Public License 3.0 eller senare, se [LICENSE](LICENSE). PDF-motorn [MuPDF](https://mupdf.com) är © Artifex Software och licensierad under AGPL. Ikonerna kommer från [Lucide](https://lucide.dev) (ISC).
