<div align="center">

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Prédiction du prochain message</h1>

<p align="center">
  <b>Un plugin pour la zone de saisie de DeepSeek Harness</b><br>
  Quand l’assistant a terminé, votre prochain message le plus probable vous attend déjà dans la zone de saisie.<br>
  <kbd>Tab</kbd> l’insère, <kbd>Échap</kbd> l’ignore, et <b>rien n’est jamais envoyé à votre place</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0-4d6bfe" alt="version 0.4.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/langues-9-8250df" alt="langues 9">
  <img src="https://img.shields.io/badge/d%C3%A9pendances%20tierces-0-2ea44f" alt="dépendances tierces 0">
  <img src="https://img.shields.io/badge/tests-242%20r%C3%A9ussis-2ea44f" alt="tests 242 réussis">
  <img src="https://img.shields.io/badge/licence-MIT-blue" alt="licence MIT">
</p>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="Démonstration : après la réponse de l’assistant, une suggestion grise apparaît dans la zone de saisie ; une autre est demandée ; Tab l’insère">
</p>

<p align="center">
  <sub>Une suggestion apparaît → demandez-en une autre si elle ne convient pas → <kbd>Tab</kbd> l’insère, et vous pouvez encore la modifier avant d’envoyer</sub>
</p>

---

## Pourquoi l’utiliser

Quand on travaille avec un assistant, beaucoup de réponses sont courtes et faciles à deviner : « continue », « lance les tests », « montre-moi les modifications ». Ce plugin rédige cette relance à l’avance et la dépose dans la zone de saisie.

<table>
<tr>
<td width="33%" valign="top">

### ⌨️ Moins de frappe

Les relances courantes en une touche. Une fois inséré, le texte se comporte comme tout ce que vous avez tapé : il se modifie et s’annule.

</td>
<td width="33%" valign="top">

### 🤫 Sans interruption

Dès que vous commencez à taper, la suggestion s’efface. Elle n’apparaît ni pendant une composition IME ni lorsqu’un menu est ouvert. Si le modèle n’est pas sûr de lui, il ne propose rien.

</td>
<td width="33%" valign="top">

### 🛡️ Jamais d’excès de zèle

Il se contente de placer du texte dans la zone de saisie. Le plugin ne contient aucun code d’« envoi de message » ; envoyer reste toujours votre décision.

</td>
</tr>
<tr>
<td valign="top">

### 💰 Un coût maîtrisé

Un modèle économique par défaut, avec des limites quotidiennes de requêtes et de jetons. Les phrases courtes que vous répétez sont proposées directement, sans appeler le modèle.

</td>
<td valign="top">

### 🔒 La confidentialité d’abord

Avant l’envoi, les clés, jetons, adresses e-mail et numéros de téléphone probables sont masqués. Le navigateur ne transmet jamais votre brouillon. Les statistiques locales enregistrent des chiffres, pas du texte.

</td>
<td valign="top">

### 📊 Une consommation transparente

Les requêtes, le taux d’acceptation, le temps de réponse et la consommation de jetons des 7 derniers jours figurent sur la page des paramètres : vous voyez tout de suite si cela vaut le coup.

</td>
</tr>
</table>

## Fonctionnalités

### La suggestion est directement dans la zone de saisie

Une fois la réponse de l’assistant terminée, si la zone de saisie est vide, une suggestion grise apparaît exactement là où vous alliez taper. Pas de fenêtre surgissante, pas de place perdue.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="Une suggestion grise dans la zone de saisie, avec « Tab : accepter » et « Une autre » à droite">
</p>

| Touche | Effet |
|---|---|
| <kbd>Tab</kbd> ou <kbd>→</kbd> | Insère la suggestion dans la zone de saisie, où vous pouvez continuer à la modifier ; <kbd>Ctrl</kbd>+<kbd>Z</kbd> n’annule que cette insertion |
| <kbd>Échap</kbd> | Masque la suggestion |
| <kbd>Alt</kbd>+<kbd>\\</kbd> (modifiable) | Prédit immédiatement ; si une suggestion est affichée, passe à une autre. Un seul appel rapporte plusieurs propositions : le changement est instantané |
| Taper, tout simplement | La suggestion disparaît aussitôt ; elle revient quand vous videz la zone de saisie |

### Trois modes, un clic

Pas envie d’étudier chaque option ? Choisissez un mode. Vous pourrez l’annuler ou l’affiner ensuite.

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="La carte des modes : Équilibré, Économe, Qualité">
</p>

| Mode | Quand prédit-il | Modèle | Contexte | Limite quotidienne | Pour qui |
|---|---|---|---|---|---|
| **Équilibré** (Recommandé) | Automatiquement après chaque réponse | Un modèle précis et économique | 12 messages | 200 requêtes | L’usage quotidien |
| **Économe** | Uniquement quand vous cliquez sur « Prédire » ou utilisez le raccourci | Un modèle précis et économique | 6 messages | 60 requêtes | Un contrôle strict des coûts |
| **Qualité** | Automatiquement après chaque réponse | Le modèle de la session | 20 messages | 200 requêtes | Des suggestions plus justes |

Un mode ne modifie que le déclenchement, la stratégie de modèle, la taille du contexte et les limites. Il ne touche ni à l’interrupteur principal, ni au raccourci, ni à la langue, ni aux options de confidentialité, et il conserve le modèle que vous avez saisi.

### Neuf langues d’interface

La page des paramètres, les boutons de la zone de saisie et leurs infobulles sont disponibles en 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Русский, Português. Par défaut, le plugin suit la langue réglée dans DeepSeek Harness ; vous pouvez aussi en choisir une dans **Paramètres → Prédiction → Langue**, et elle s’applique aussitôt. Les suggestions, elles, suivent toujours la langue de votre conversation.

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="Le haut de la page des paramètres en anglais, japonais, espagnol et russe">
</p>

### À un clic dans la barre latérale

Cliquez sur « Ajouter à la barre latérale » et une entrée apparaît dans la barre latérale gauche de DSH ; consulter l’état ou changer de mode ne demande alors plus de passer par les Paramètres. La version affichée près du titre vous indique toujours laquelle est installée.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="L’entrée « Prédiction » dans la barre latérale gauche">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="La version à côté du titre de la page et le bouton « Retirer de la barre latérale »">
</td>
</tr>
</table>

### Votre consommation en un coup d’œil

<details>
<summary><b>Afficher toute la page des paramètres</b> (bases, modes, origine des suggestions, modèle, 7 derniers jours)</summary>
<br>
<p align="center">
  <img src="docs/images/settings.png" width="640" alt="La page des paramètres complète">
</p>
</details>

> La plupart des captures montrent l’interface en chinois. Elles proviennent d’une conversation de démonstration et sont générées par un script de ce dépôt avec un modèle simulé local ; c’est pourquoi le modèle s’appelle Mock et les chiffres sont faibles. En usage réel, les suggestions viennent du modèle que vous avez configuré dans DSH.

## Installation

Nécessite DeepSeek Harness `0.2.2-rc.1` (`>=0.2.2-rc.1 <0.3.0`). Le plugin n’a aucune dépendance tierce et ne demande aucune compilation. Une seule commande suffit :

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

Le nom qui suit `--profile` est le profil que vous utilisez au quotidien : `desktop` pour l’application de bureau, `web` pour la version web. Ensuite, **quittez complètement DSH puis relancez-le**.

<details>
<summary>La commande <code>dsh</code> est introuvable, ou vous voulez installer depuis un dossier local</summary>

La ligne de commande `dsh` se trouve dans le dossier d’installation de DeepSeek Harness et peut être appelée par son chemin complet. Pour modifier le code vous-même, clonez le dépôt puis installez depuis le dossier local :

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<dossier d’installation de DSH>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<dossier du plugin>'
```

`<dossier d’installation de DSH>` est l’emplacement où DeepSeek Harness est installé ; `<dossier du plugin>` est le dossier que vous venez de cloner.

</details>

Puis trois étapes pour commencer :

1. Ouvrez **Paramètres → Prédiction** et activez « Activer la prédiction ». C’est désactivé par défaut : tant que vous ne l’activez pas, aucune suggestion n’est affichée et aucun modèle n’est appelé.
2. Choisissez-en un sous « Mode ». Par défaut, c’est « Équilibré ».
3. Pour y accéder plus vite, cliquez sur « Ajouter à la barre latérale » en haut à droite.

<details>
<summary>Mise à jour et désinstallation</summary>

**Mise à jour** : si vous avez installé depuis GitHub, désinstallez puis relancez la commande d’installation ; si vous avez installé depuis un dossier local, exécutez-y `git pull`. Redémarrez ensuite DSH. Actualiser la page ne suffit pas : la page serait à jour alors que la partie en arrière-plan resterait ancienne, et la page des paramètres signalerait un écart de version.

**Désinstallation** :

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

N’activez qu’un seul plugin de prédiction pour la zone de saisie par profil. Si un autre est détecté, ce plugin se met en pause de lui-même et en donne la raison sur la page des paramètres.

</details>

## Ce qu’il envoie

Chaque prédiction est une seule requête au modèle, sans nouvelle tentative automatique. Elle contient des extraits des **messages de l’utilisateur et des réponses textuelles finales de l’assistant** les plus récents de la session en cours : par défaut, 12 messages et environ 2 000 jetons au maximum.

- Ni arguments ni résultats d’outils, ni raisonnement, ni prompt système.
- Avant l’envoi, les clés privées, clés d’API, jetons, mots de passe, adresses e-mail, numéros de mobile et d’identité probables, ainsi que le nom d’utilisateur dans les chemins du dossier personnel, sont remplacés par des substituts (fondé sur des règles ; il ne peut pas garantir de tout repérer).
- La page du navigateur n’envoie que des identifiants de session et de tour, jamais le brouillon, les pièces jointes ni le texte de la conversation ; le contenu destiné au modèle est lu par la partie en arrière-plan dans les enregistrements de session de DSH.
- « Privilégier les messages courts fréquents » compare seulement les messages courts que vous avez envoyés sur cet ordinateur ; aucun modèle n’est appelé.

La description complète, et la manière de supprimer les données locales, se trouvent dans [Confidentialité et périmètre des données](docs/PRIVACY.md).

## Questions fréquentes

<details>
<summary><b>Va-t-il envoyer un message à ma place ?</b></summary>

Non. Accepter une suggestion place seulement du texte dans la zone de saisie, par l’interface d’insertion de celle-ci ; le plugin ne contient aucun appel qui valide ou envoie.

</details>

<details>
<summary><b>Combien cela coûte-t-il ?</b></summary>

Chaque prédiction est un appel très court au modèle (96 jetons de sortie au maximum par défaut). Les limites quotidiennes par défaut sont de 200 requêtes et 500 000 jetons ; une fois atteintes, plus aucun appel n’est fait ce jour-là. Pour dépenser moins, choisissez le mode « Économe », qui ne prédit que sur demande. La consommation réelle figure sous « 7 derniers jours » sur la page des paramètres.

</details>

<details>
<summary><b>Pourquoi n’y a-t-il parfois aucune suggestion ?</b></summary>

C’est voulu : quand le modèle n’est pas sûr de lui, il ne propose rien, et une sortie qui enfreint les règles (trop longue, sur plusieurs lignes, écrite sur le ton de l’assistant) est écartée. La ligne d’état de la page des paramètres indique pourquoi il n’y en a pas à cet instant. Quand vous en voulez une, appuyez sur <kbd>Alt</kbd>+<kbd>\\</kbd>.

</details>

<details>
<summary><b>Les suggestions sont-elles justes ?</b></summary>

Il est à l’aise avec les relances courtes et claires : confirmer, demander une vérification, demander un détail. Il ne peut pas deviner ce que vous seul savez, et dans ce cas il doit se taire.

</details>

## Documentation

La documentation détaillée est rédigée en chinois.

| Document | Contenu |
|---|---|
| [Guide d’utilisation](docs/USER-GUIDE.md) | Touches, chaque élément de la page des paramètres, modes, entrée de la barre latérale, questions fréquentes |
| [Référence de configuration](docs/CONFIGURATION.md) | Valeurs par défaut et plages de toutes les options, valeurs des trois modes |
| [Confidentialité et périmètre des données](docs/PRIVACY.md) | Ce qui est envoyé, fichiers locaux, suppression des données |
| [Architecture](docs/ARCHITECTURE.md) | Les moitiés Host et navigateur, le parcours d’une requête, le protocole |
| [Développement et vérification](docs/DEVELOPMENT.md) | Construction, tests, vérification de bout en bout, régénération des captures |
| [Compatibilité](docs/COMPATIBILITY.md) | Le contrat confirmé avec DSH 0.2.2-rc.1 et les solutions de repli |
| [Journal des modifications](CHANGELOG.md) | Changements de chaque version |
| [Index de la documentation](docs/README.md) | Tous les documents, y compris les notes antérieures de vérification et d’optimisation |

## Contribuer

```powershell
npm run build   # génère lib/client.js à partir de src/shared + src/client
npm test        # 242 tests unitaires et d’intégration
npm run check   # construction + tests + vérification de la syntaxe
```

Pas de `npm install`, pas d’outil d’assemblage ; Node.js 22 ou une version ultérieure est requis. Pour ajouter ou corriger une traduction, modifiez `src/client/locales/<langue>.js` ; les tests vérifient que toutes les langues ont les mêmes clés.

## Limites connues

- Vérifié uniquement avec DSH `0.2.2-rc.1`.
- Enregistrer un réglage amène l’hôte à redémarrer la partie en arrière-plan du plugin ; une prédiction en cours est annulée.
- Plusieurs fenêtres partagent les résultats de prédiction ; masquer une suggestion dans une fenêtre n’est pas répercuté en temps réel dans les autres.
- La palette de commandes et la boîte de dialogue de commentaires sont reconnues d’après le focus et des caractéristiques modales ; une erreur de détection ne coûte qu’une suggestion, jamais une frappe détournée.

## Licence

Publié sous [licence MIT](LICENSE). Le choix des points d’extension et l’interaction « suggestion grise + Tab pour accepter + Échap pour masquer » s’inspirent de `dsh-composer-prediction`, lui aussi sous licence MIT ; aucun code n’en a été copié. Voir [NOTICE](NOTICE).
