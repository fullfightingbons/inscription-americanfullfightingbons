import test from "node:test";
import assert from "node:assert/strict";

import { insertCotisationJournal } from "../src/routes/api/public/payment/helloasso/status.js";

// Faux D1 modélisant journal_comptable en mémoire, juste assez fidèlement
// pour exécuter les deux requêtes que fait insertCotisationJournal :
//  - DELETE FROM journal_comptable WHERE piece = ? OR piece LIKE ?
//    [AND exercice_id IS ?]   (variante scopée à un exercice)
//  - INSERT INTO journal_comptable ("col", ...) VALUES (?, ...)
// Le LIKE SQL est traduit en regex (% = n'importe quelle suite, _ = un
// caractère) pour que la suppression se comporte comme dans SQLite : c'est
// précisément ce comportement qui effaçait les écritures de la saison
// précédente avec l'ancienne clé "ADH-<adhérent>" (cf. incident du
// 27/09/2026 documenté dans insertCotisationJournal).
function fakeJournalDb() {
  const rows = [];

  const likeToRegex = (pattern) =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".") +
        "$",
    );

  return {
    rows,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              if (/^DELETE FROM journal_comptable/i.test(sql.trim())) {
                const [exact, like, exerciceId] = params;
                const re = likeToRegex(like);
                // Variante scopée : "... AND exercice_id IS ?" (IS traite null
                // comme une valeur comparable, contrairement à "=").
                const scoped = /exercice_id IS \?/i.test(sql);
                for (let i = rows.length - 1; i >= 0; i--) {
                  const samePiece = rows[i].piece === exact || re.test(rows[i].piece);
                  const sameExercice = !scoped || (rows[i].exercice_id ?? null) === (exerciceId ?? null);
                  if (samePiece && sameExercice) rows.splice(i, 1);
                }
                return {};
              }
              const insert = sql.match(/^INSERT INTO journal_comptable \(([^)]*)\)/i);
              if (insert) {
                const columns = insert[1].split(",").map((c) => c.trim().replace(/"/g, ""));
                const row = {};
                columns.forEach((c, i) => (row[c] = params[i]));
                rows.push(row);
                return {};
              }
              throw new Error(`Requête non prévue par le faux D1 : ${sql}`);
            },
          };
        },
      };
    },
  };
}

const ADHERENT_ID = "9f3c2a71-1111-4222-8333-444455556666";
const EXERCICE_2025 = { id: "aaaaaaaa-1111-4222-8333-444455556666" };
const EXERCICE_2026 = { id: "bbbbbbbb-1111-4222-8333-444455556666" };
const TOTALS = { cotisation: 250 };

test("un renouvellement en saison N+1 conserve les écritures de cotisation de la saison N", async () => {
  const db = fakeJournalDb();

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2025, "2025-09-01T10:00:00Z");
  assert.equal(db.rows.length, 2, "2 lignes (411 + 7561) attendues après la 1re saison");

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");

  assert.equal(db.rows.length, 4, "les 2 lignes de 2025 doivent survivre, 2 nouvelles s'ajoutent pour 2026");
  const parExercice = (id) => db.rows.filter((r) => r.exercice_id === id);
  assert.equal(parExercice(EXERCICE_2025.id).length, 2);
  assert.equal(parExercice(EXERCICE_2026.id).length, 2);
});

test("revérifier le paiement de la MÊME inscription reste idempotent (pas de double écriture)", async () => {
  const db = fakeJournalDb();

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");

  assert.equal(db.rows.length, 2, "la même saison doit être remplacée, pas dupliquée");
});

test("les écritures d'un autre adhérent ne sont jamais touchées", async () => {
  const db = fakeJournalDb();
  const AUTRE_ADHERENT = "1a2b3c4d-9999-4888-8777-666655554444";

  await insertCotisationJournal(db, AUTRE_ADHERENT, "MARTIN", "Alice", TOTALS, EXERCICE_2026, "2026-09-01T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");

  assert.equal(db.rows.filter((r) => r.source_id === AUTRE_ADHERENT).length, 2);
  assert.equal(db.rows.filter((r) => r.source_id === ADHERENT_ID).length, 2);
});

test("deux exercices dont les identifiants partagent un préfixe ne s'écrasent pas", async () => {
  // Garde-fou contre toute future "optimisation" qui tronquerait ou
  // normaliserait l'identifiant d'exercice ("exercice-2025" et
  // "exercice-2026" ne doivent jamais être confondus).
  const db = fakeJournalDb();

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, { id: "exercice-2025" }, "2025-09-01T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, { id: "exercice-2026" }, "2026-09-07T10:00:00Z");

  assert.equal(db.rows.length, 4);
});

test("sans exercice résolu : écritures créées sans exercice, et celles des exercices datés ne sont pas touchées", async () => {
  const db = fakeJournalDb();

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2025, "2025-09-01T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, null, "2026-09-07T10:00:00Z");
  // Rejouer le cas "sans exercice" reste idempotent (remplace, ne duplique pas).
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, null, "2026-09-07T10:00:00Z");

  assert.equal(db.rows.filter((r) => r.exercice_id === EXERCICE_2025.id).length, 2, "exercice daté préservé");
  assert.equal(db.rows.filter((r) => r.exercice_id === null).length, 2, "un seul jeu d'écritures sans exercice");
});

test("contrat avec gestion : format de pièce ADH-<8 hex>-(CLI|COT), sans segment d'exercice", async () => {
  // gestion/public/assets/app.js → normalizePieceGroupKey décompose la pièce
  // avec /^((?:ADH|ACH|PAY|SUB|VTE)-[^-]+)-([A-Z]{2,4}\d*)$/ pour regrouper
  // CLI + COT et contrôler l'équilibre de chaque groupe. Ajouter un segment
  // (ex. l'exercice) sépare les deux lignes en deux groupes déséquilibrés.
  // Le test miroir côté gestion (gl-accounting.test.ts) vérifie le parseur.
  const db = fakeJournalDb();

  const piece = await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");

  assert.match(piece, /^ADH-[0-9a-f]{8}$/);
  assert.deepEqual(
    db.rows.map((r) => r.piece).sort(),
    [`${piece}-CLI`, `${piece}-COT`],
  );
  for (const r of db.rows) assert.match(r.piece, /^ADH-[0-9a-f]{8}-(CLI|COT)$/);
});

test("cotisation à 0 € : aucune écriture (comportement inchangé)", async () => {
  const db = fakeJournalDb();

  const piece = await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", { cotisation: 0 }, EXERCICE_2026, "2026-09-07T10:00:00Z");

  assert.equal(piece, null);
  assert.equal(db.rows.length, 0);
});

test("les deux lignes restent équilibrées (débit 411 = crédit 7561) pour chaque saison", async () => {
  const db = fakeJournalDb();

  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2025, "2025-09-01T10:00:00Z");
  await insertCotisationJournal(db, ADHERENT_ID, "GRALLIEN", "Laurent", TOTALS, EXERCICE_2026, "2026-09-07T10:00:00Z");

  for (const ex of [EXERCICE_2025, EXERCICE_2026]) {
    const lignes = db.rows.filter((r) => r.exercice_id === ex.id);
    const debit = lignes.reduce((s, r) => s + r.debit, 0);
    const credit = lignes.reduce((s, r) => s + r.credit, 0);
    assert.equal(debit, credit);
    assert.equal(debit, 250);
  }
});
