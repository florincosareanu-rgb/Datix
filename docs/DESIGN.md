# Aspectul DAX (sistemul vizual)

Stil: **AI-native + minimalism**, cu suprafețe de „sticlă” pentru elementele plutitoare. Totul pornește din tokenurile din `web/src/styles.css`. În componente nu se scriu culori hex: se folosesc doar tokenurile de mai jos, ca tema luminoasă și cea întunecată să rămână sincronizate.

## Fonturi

Fonturile sunt găzduite local în `web/public/fonts`, fără Google Fonts, deci nu se fac cereri către terți. Ambele au licența SIL OFL, inclusă alături.

| Rol | Font | Unde |
|---|---|---|
| Titluri | **Outfit** (variabil) | utilitarul `font-display`: titluri de pagină, de card, salutul din chat |
| Text | **Inter** (variabil) | tot restul; `tabular` pentru cifre aliniate |

Textul de bază are 16px. Sub 12px nu se coboară.

## Culori

| Token | Luminos | Întunecat | Folosire |
|---|---|---|---|
| `page` / `surface` / `surface-2` / `surface-3` | `#f5f6fa` / `#fff` / `#f0f1f7` / `#e5e7f0` | `#0a0b12` / `#12141e` / `#1a1d2a` / `#242838` | fundal, carduri, câmpuri, butoane secundare |
| `ink` / `ink-2` / `ink-3` | `#0e1120` / `#4b5168` / `#656b83` | `#f3f4fa` / `#b9bed1` / `#8c92a9` | text principal / secundar / discret |
| `accent` | `#7c3aed` | `#7c3aed` | **doar fundaluri** (buton principal, comutatoare); textul alb pe el are 5,7:1 |
| `accent-fg` | `#6d28d9` | `#a78bfa` | **text și pictograme** în culoarea de accent |
| `accent-soft` | `#f1ebfe` | `#221a3d` | elementul activ din navigare, bulele utilizatorului |
| `bg-brand` / `text-brand` | gradient violet → indigo → cyan | la fel | orbul DAX, avatarul, butonul de trimitere, numele din salut |

Toate perechile text/fundal au contrast **≥ 4,5:1** în ambele teme. Cel mai mic este `ink-3` pe `accent-soft`, în tema luminoasă: 4,53:1.

**Culorile de stare sunt rezervate:** `good`, `warning`, `serious` și `critical`, fiecare cu variantele `-ink` și `-soft`. Apar mereu împreună cu o pictogramă și un text, nu doar prin culoare. Nu se folosesc ca accent decorativ.

Graficele folosesc `chart-1`: `#7c3aed` în tema luminoasă și `#9f7aea` în cea întunecată. Ambele valori au fost validate pentru lizibilitate pe fundalul temei respective.

## Suprafețe și forme

- Cardurile au `rounded-3xl`, chenarul `border-line/80` și `card-shadow`.
- Elementele plutitoare folosesc utilitarul `glass` (fundal translucid + blur) și `float-shadow`: bara de sus, bara de navigare de jos, caseta de mesaj.
- Butoanele, filele și comutatoarele segmentate au formă de pastilă (`rounded-full`).
- Câmpurile de formular sunt „umplute” (`bg-surface-2`, `rounded-2xl`, înălțime 48px), cu inel de focus violet.
- Fundalul paginilor are o lumină „aurora” discretă (`.aurora`).

## Atingere și accesibilitate

- Țintele de atingere au cel puțin **44×44px**. Pe ecranele tactile, butoanele mici cresc automat prin varianta `pointer-coarse:`. Comutatoarele păstrează aspectul iOS de 51×31, dar zona de atingere e extinsă cu 8px pe fiecare latură.
- Focusul de la tastatură e mereu vizibil (`:focus-visible`). Paginile au `scroll-padding` astfel încât elementul focalizat să nu ajungă sub bara de jos.
- Animațiile sunt scurte, de 150–300 ms: intrarea paginilor și apăsarea butoanelor (scalare 0,97). Toate se opresc când telefonul are activată „Reducere mișcare”.
- Pe telefon în landscape (înălțime ≤ 500px, varianta `short:`), bara de jos devine compactă: pictogramă și text pe același rând.
- Zonele sigure iOS (notch, bara de jos) sunt respectate prin `safe-top`, `safe-bottom` și `safe-x`. Aceste clase **nu se pun împreună cu `pt-*`/`pb-*` pe același element**, pentru că le-ar anula. Acolo unde trebuie ambele, se scrie direct, de exemplu `pb-[max(env(safe-area-inset-bottom),12px)]`.
- Caseta de mesaj din chat are aceeași poziție și înălțime ca bara de navigare de jos din celelalte ecrane: 12px de la margine (sau deasupra barei iPhone-ului) și 66px înălțime. Textul ei ajutător se schimbă la câteva secunde doar cât caseta e goală și nefocalizată, iar cu „Reducere mișcare” rămâne fix.

## Componente

Componentele de bază sunt în `web/src/components/ui.tsx`: `Button`, `IconButton`, `Card`, `CardHeader`, `IconTile`, `Field`, `Input`, `Select`, `Toggle`, `Segmented`, `Tabs`, `Modal` (foaie de jos pe telefon), `Badge`, `Notice`, `EmptyState`.

Identitatea vizuală a agentului se află în `web/src/components/brand.tsx`:

- `DaxOrb`: orbul în gradient, care „respiră” cât timp DAX lucrează;
- `DaxMark`: orbul împreună cu numele.

Pentru stări se folosesc componentele din `web/src/components/status.tsx`:

- `StatusBadge`: eticheta completă, pe ecrane late;
- `StatusIcon`: o pictogramă rotundă, pe telefon.
