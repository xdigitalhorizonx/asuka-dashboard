# Proposal PDF fixtures

Test inputs for `scripts/test-proposal.ts` (the parser in `src/lib/proposal/parse.ts` and the
invoice draft in `src/lib/proposal/draft.ts`). Every client, domain and project here is
**fictional**. The real sample proposal is confidential and never goes in this folder. The test
reads it from outside the repo when `PROPOSAL_SAMPLE_PDF` points at a local copy.

Each fixture folder holds:

| File | What it is |
| --- | --- |
| `proposal.json` | Input to Digital Horizon's generator. It is also the ground truth for every text field. |
| `helvetica.pdf` | Rendered without the Geist font, which is what production does when `node_modules/geist` is missing. |
| `geist.pdf` | Rendered with Geist. |
| `expected.json` | **Hand-checked** amounts, flags, totals, warnings and the invoice draft. Never generate it from the parser's output. |

| Fixture | What it exercises |
| --- | --- |
| `base-offer` | The system prompt's base offer: an empty price, FREE prices, a "Setup" type, a price note, and add-ons with free-text pricing |
| `long-names` | Service names that wrap to 2 lines, long descriptions hyphenated across lines, special characters (é — & ’ “ ”), `$12,500.50`, yearly pricing (`$240 / yr`) and priced add-ons (`$350`, `$95 / mo`, `FREE`). In Geist, react-pdf also adds a blank continuation page. |
| `overflow-14` | 14 services, so the table flows onto page 2 with no repeated header and the totals land there. Also covers a wrapping TYPE cell, a price note with no price, `$49/mo`, `$120 per month`, `$99 annually` and `$0` |
| `free-monthly` | TOTAL MONTHLY is `FREE`, with no additional services |
| `wrong-totals` | Stated totals that don't add up, plus an unreadable price (`10% of ad spend`). Warnings are expected. |
| `long-client` | A long client name that wraps the header strip, hyphenates in the hero title and hyphenates inside the CLIENT cell |
| `totals-split-helvetica` | In Helvetica, the totals strip splits across pages: labels at the foot of page 1, figures at the top of page 2. In Geist, the last row and the strip move to page 2. |
| `totals-split-geist` | The same split, but in Geist |
| `totals-page-two` | In Geist, the whole totals strip moves to page 2 while every row stays on page 1 |
| `encrypted-user-password.pdf` | `base-offer/helvetica.pdf` locked with a user password (AES-256). The parse must return `ok: false`. |
| `encrypted-owner-only.pdf` | The same file with only an owner password, so it opens without one. It must parse like `base-offer`. |

The three `totals-*` fixtures depend on exact layout: their summaries were lengthened a few words
at a time until react-pdf broke the page where the fixture's name says. If you re-render them with
a different react-pdf version, check that the break still happens (see step 5).

## Regenerating

The generator is `lib/proposal/pdf.tsx` (with `lib/proposal/types.ts`) in the **digital-horizon**
repo. Render it **outside this repo** so no new dependencies land in `package.json`. The versions
below match digital-horizon's lockfile at the time these fixtures were made.

1. Set up a scratch folder:

   ```sh
   mkdir -p /tmp/dh-fixtures/helvetica-cwd && cd /tmp/dh-fixtures
   cp <digital-horizon>/lib/proposal/pdf.tsx <digital-horizon>/lib/proposal/types.ts .
   ```

2. Add `package.json` and install with `npm install --legacy-peer-deps`. `geist` pulls in `next`
   as a peer, which the legacy flag skips:

   ```json
   {
     "private": true,
     "type": "module",
     "dependencies": {
       "@react-pdf/renderer": "4.5.1", "react": "18.3.1", "zod": "3.25.76", "geist": "1.7.0", "tsx": "4.20.6"
     },
     "overrides": {
       "@react-pdf/layout": "4.6.1", "@react-pdf/textkit": "6.3.0", "@react-pdf/pdfkit": "5.1.1",
       "@react-pdf/font": "4.0.8", "@react-pdf/render": "4.5.1", "@react-pdf/fns": "3.1.3",
       "@react-pdf/image": "3.1.0", "@react-pdf/primitives": "4.3.0", "@react-pdf/reconciler": "2.0.0",
       "@react-pdf/stylesheet": "6.2.1", "@react-pdf/svg": "1.1.0", "@react-pdf/types": "2.11.1",
       "fontkit": "2.0.4", "linebreak": "1.1.0", "unicode-properties": "1.4.1", "yoga-layout": "3.2.1",
       "hyphen": "1.14.1"
     }
   }
   ```

3. Save this as `render.tsx`:

   ```tsx
   // Usage: tsx render.tsx <proposal.json> <out.pdf>
   // pdf.tsx uses Geist when <cwd>/node_modules/geist exists, otherwise Helvetica.
   import fs from "node:fs";
   import { renderToBuffer } from "@react-pdf/renderer";
   import { ProposalDocument } from "./pdf";
   import { ProposalSchema } from "./types";

   async function main() {
     const [specPath, outPath] = process.argv.slice(2);
     const proposal = ProposalSchema.parse(JSON.parse(fs.readFileSync(specPath, "utf8")));
     fs.writeFileSync(outPath, await renderToBuffer(<ProposalDocument proposal={proposal} />));
   }
   main().catch((e) => { console.error(e); process.exit(1); });
   ```

   Add a `tsconfig.json` with `{ "compilerOptions": { "jsx": "react-jsx", "module": "esnext", "moduleResolution": "bundler", "esModuleInterop": true } }`.

4. Render every fixture in both fonts. Run from the scratch folder for Geist, and from
   `helvetica-cwd`, which has no `node_modules/geist`, for Helvetica:

   ```sh
   F=<this repo>/scripts/fixtures/proposals
   for d in "$F"/*/; do
     ./node_modules/.bin/tsx render.tsx "$d/proposal.json" "$d/geist.pdf"
     (cd helvetica-cwd && ../node_modules/.bin/tsx ../render.tsx "$d/proposal.json" "$d/helvetica.pdf")
   done
   ```

5. Check the page flow of the `totals-*` fixtures. Print where TOTAL MONTHLY and its figure land
   (page@y). A split shows the label on one page and the figure on the next:

   ```sh
   cd <this repo> && node --input-type=module -e '
   import fs from "node:fs"; import { getDocumentProxy } from "unpdf";
   for (const f of process.argv.slice(1)) {
     const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(f))); const at = [];
     for (let p = 1; p <= pdf.numPages; p++)
       for (const it of (await (await pdf.getPage(p)).getTextContent()).items) {
         const big = Math.hypot(it.transform?.[0] ?? 0, it.transform?.[1] ?? 0) === 20 && /^(\$|FREE)/.test(it.str);
         if (/^TOTAL ?MO/.test(it.str ?? "") || big) at.push(`${it.str.replace(/\s/g, "")} p${p}@${Math.round(it.transform[5])}`);
       }
     console.log(f.split("/").slice(-2).join("/"), "|", at.slice(0, 2).join(" | "));
   }' scripts/fixtures/proposals/totals-*/*.pdf
   ```

   The layouts these fixtures were made for:

   ```text
   totals-page-two/geist.pdf            | TOTALMONTHLY p2@748 | $1,249.99 p2@720
   totals-page-two/helvetica.pdf        | TOTALMONTHLY p1@71 | $1,249.99 p1@45
   totals-split-geist/geist.pdf         | TOTALMONTHLY p1@64 | $1,249.99 p2@736
   totals-split-geist/helvetica.pdf     | TOTALMONTHLY p1@112 | $1,249.99 p1@86
   totals-split-helvetica/geist.pdf     | TOTALMONTHLY p2@716 | $1,249.99 p2@688
   totals-split-helvetica/helvetica.pdf | TOTALMONTHLY p1@56 | $1,249.99 p2@738
   ```

6. Rebuild the encrypted copies with PyMuPDF (`pip install pymupdf`):

   ```python
   import pymupdf
   for name, user in (("encrypted-user-password.pdf", "example-user-pw"), ("encrypted-owner-only.pdf", "")):
       doc = pymupdf.open("base-offer/helvetica.pdf")
       doc.save(name, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="example-owner-pw", user_pw=user,
                permissions=int(pymupdf.PDF_PERM_PRINT | pymupdf.PDF_PERM_COPY))
   ```

7. Run `npx tsx scripts/test-proposal.ts`. If a fixture's text changed on purpose, update its
   `expected.json` by hand after checking the numbers yourself.
