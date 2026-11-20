# Mentor (plugin Obsidian personnel)

Tuteur personnel construit sur les notes du vault : leçon guidée, quiz corrigés et révision espacée (FSRS).
Le moteur est Claude Code, lancé en local avec l'abonnement déjà connecté (aucune clé API).

## Modes

- **Leçon guidée** : plan de leçon préparé à partir des notes, puis une notion à la fois (question préalable, explication, exemple si besoin, question de vérification).
- **Quiz** : sans chrono, réponses rédigées corrigées par Sonnet, points avec bonus de série, « Explique-moi » après chaque correction.
- **Défi chrono** : QCM de 20 secondes façon Kahoot, plus de points pour une réponse rapide.
- **Révision** : fiches planifiées par FSRS ; les questions ratées deviennent des fiches.

Le modèle par défaut est Sonnet (Opus en option). Les animations respectent le réglage système « réduire les animations ».

## Construire et installer

```
npm install
node build.mjs
```

Copier `dist/main.js`, `dist/manifest.json` et `dist/styles.css` dans `.obsidian/plugins/mentor/` du vault, puis activer « Mentor » dans les plugins communautaires.

## Principes pédagogiques appliqués

- Pratique de récupération (se tester) et espacement des révisions : les deux techniques les plus efficaces (Dunlosky et al. 2013 ; méta-analyse Donoghue & Hattie 2021).
- Pré-test avant la leçon, questions surtout rédigées plutôt que QCM, correction immédiate.
- Tuteur qui guide pas à pas et ne donne pas la réponse d'emblée (Kestin & Miller 2025, Harvard ; Bastani et al. 2025).
- Révisions mélangées entre sujets (interleaving), planification FSRS-6 (ts-fsrs).
- Confiance déclarée à chaque question pour repérer les fausses certitudes.

## Fichiers

- `src/claude.ts` : lancement de Claude Code (`claude -p`, sans outils, sortie JSON ou flux).
- `src/sources.ts` : collecte des notes (note + liens, dossier, ou recherche par mots).
- `src/prompts.ts` : consignes pédagogiques, schémas JSON des quiz, corrections et fiches.
- `src/store.ts` : sujets, fiches, FSRS, maîtrise.
- `src/view.ts` : interface (accueil, leçon, quiz, révision).
- `src/main.ts` : réglages, commandes, menu contextuel.
