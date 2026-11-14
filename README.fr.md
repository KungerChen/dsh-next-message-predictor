<div align="center">

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Prédiction du prochain message</h1>

<p align="center">
  <b>Un plugin pour la zone de saisie de DeepSeek Harness</b><br>
  Après une réponse éligible, une suggestion peut s’afficher dans le champ de saisie.<br>
  Placez le curseur dans le champ et appuyez sur <kbd>Tab</kbd> pour insérer la suggestion dans le brouillon. Vous choisissez quand l’envoyer.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.0-4d6bfe" alt="version 0.6.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2--rc.1%20%3C0.3.0-1f2937" alt="DeepSeek Harness &gt;=0.2.2-rc.1 &lt;0.3.0">
  <img src="https://img.shields.io/badge/langues-9-8250df" alt="langues 9">
  <img src="https://img.shields.io/badge/d%C3%A9pendances%20tierces-0-2ea44f" alt="dépendances tierces 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/licence-MIT-blue" alt="licence MIT">
</p>

<div align="center">

[Démarrage rapide](#quick-start) · [Prévisualiser et accepter](#suggestions) · [Mettre une conversation en pause](#session-pause) · [Modes de prédiction](#modes) · [Confidentialité et requêtes au modèle](#privacy) · [Documentation](#documentation)

</div>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="Aperçu dans le champ DSH, défilement des suggestions et insertion dans le brouillon après la mise au point">
</p>

<a name="quick-start"></a>

## Démarrage rapide

Installez le module sur DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`. Le paquet GitHub est prêt à l’emploi, sans compilation.

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

Indiquez votre profil DSH (`desktop` par défaut pour l’application, `web` pour la version web). Ensuite, **quittez complètement DSH et rouvrez-le**.

1. Ouvrez **Paramètres → Prédiction**. La prédiction est désactivée à la première installation.
2. Choisissez un mode dans « Mode ». Dans « Modèle de prédiction », vérifiez le fournisseur et le modèle configurés dans DSH, ou choisissez « Suivre le modèle de la session ». Enregistrez les modifications apportées aux champs du modèle.
3. Activez « Activer la prédiction » et laissez le champ vide après la réponse. Pour un essai manuel, cliquez sur « Prédire » ou placez le curseur dans le champ vide et appuyez sur <kbd>Alt</kbd>+<kbd>\</kbd>.

Les modes équilibré et économie utilisent par défaut `deepseek-official / deepseek-flash`. Pour choisir un autre modèle précis, saisissez ses identifiants de fournisseur et de modèle dans DSH. Si le modèle configuré est introuvable, DSH peut utiliser son modèle par défaut disponible pour cette prédiction.

<details>
<summary>La commande <code>dsh</code> est introuvable, ou vous voulez installer depuis un dossier local</summary>

La ligne de commande `dsh` se trouve dans le dossier d’installation de DeepSeek Harness et peut être appelée par son chemin complet. Pour modifier le code vous-même, clonez le dépôt puis installez depuis le dossier local :

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<dossier d’installation de DSH>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<dossier du plugin>'
```

</details>

<details>
<summary>Mise à jour et désinstallation</summary>

**Mise à jour** : si vous avez installé depuis GitHub, désinstallez puis relancez la commande d’installation ; si vous avez installé depuis un dossier local, exécutez-y `git pull`. Redémarrez ensuite DSH. Actualiser la page ne suffit pas : la page serait à jour alors que la partie en arrière-plan resterait ancienne, et la page des paramètres signalerait un écart de version.

**Désinstallation** :

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

N’activez qu’un seul plugin de prédiction pour la zone de saisie par profil. Si un autre est détecté, ce plugin se met en pause de lui-même et en donne la raison sur la page des paramètres.

</details>

<a name="suggestions"></a>

## Prévisualiser et accepter

Une suggestion disponible apparaît en gris dans le champ vide de la fenêtre active. Par défaut, le champ peut l’afficher même sans le focus. Activez « Afficher les prédictions uniquement lorsque la zone de saisie a le focus » pour limiter l’affichage au champ actif. Cette option règle l’affichage des suggestions déjà obtenues.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="Suggestion grise dans le champ inactif, avec l’indication de cliquer dans le champ avant d’appuyer sur Tab">
</p>

| Action dans le champ de saisie | Effet |
|---|---|
| <kbd>Tab</kbd>, <kbd>→</kbd> au début ou clic sur « Tab : accepter » | Placez d’abord le curseur dans le champ. Le texte s’ajoute au brouillon et reste modifiable avant l’envoi. |
| <kbd>Échap</kbd> | Masque la suggestion quand le champ a le focus. Vous pouvez ensuite en demander une autre manuellement. |
| <kbd>Alt</kbd>+<kbd>\</kbd> (configurable), « Prédire » ou « Une autre » | Quand le champ est vide, demande une prédiction ou passe à une autre suggestion. Le raccourci exige aussi le focus dans le champ. |
| Taper, tout simplement | La saisie masque l’aperçu. En effaçant le brouillon, la suggestion peut réapparaître si elle est encore valable. |

Après l’insertion, <kbd>Ctrl</kbd>+<kbd>Z</kbd> annule et <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> rétablit. La version 0.6.0 répare l’annulation de la première insertion après un envoi dans l’éditeur testé de DSH Desktop `0.2.2-rc.3`. Les autres versions utilisent l’historique natif de DSH. [Rapport de validation](docs/VALIDATION-DISPLAY-SESSION.md)

<a name="session-pause"></a>

## Mettre une conversation en pause

Le bouton Pause de la barre du champ arrête les prédictions automatiques et manuelles pour cette conversation et masque la suggestion. Cliquez sur ▶ pour reprendre, puis demandez une prédiction ou attendez la prochaine réponse.

<p align="center">
  <img src="docs/images/pause.png" width="720" alt="Conversation en pause et bouton triangulaire de reprise des prédictions">
</p>

Les fenêtres connectées au même hôte DSH partagent l’état de pause. Il persiste après un rechargement de page ou une sauvegarde des réglages, jusqu’à la reprise ou au redémarrage de DSH. Accepter ou masquer une suggestion fait aussi disparaître les suggestions de ce tour dans les autres vues de la conversation.

<a name="modes"></a>

## Modes de prédiction

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="La carte des modes : Équilibré, Économe, Qualité">
</p>

| Mode | Quand prédit-il | Modèle | Messages de contexte max. | Limite de requêtes par jour |
|---|---|---|---|---|
| **Équilibré** (Recommandé) | Automatique après une réponse éligible | Modèle précis | 12 | 200 |
| **Économe** | Sur demande | Modèle précis | 6 | 60 |
| **Qualité** | Automatique après une réponse éligible | Le modèle de la session | 20 | 200 |

Un mode définit le déclenchement, la stratégie de modèle, le contexte et les limites. Il conserve l’interrupteur général, le raccourci, la langue, les réglages de confidentialité et les identifiants de modèle saisis.

### Suggestions du modèle et phrases personnelles

Après les suggestions du modèle peuvent suivre des messages courts répétés dans cette conversation et vos phrases épinglées. Ajoutez ou réordonnez les phrases dans **Paramètres → Prédiction → Origine des suggestions → Phrases épinglées**, puis enregistrez. « Une autre » parcourt les choix disponibles sans nouvel appel au modèle. Une fois les choix épuisés, en demander un autre peut déclencher une requête au modèle dans la limite des quotas.

Si une demande manuelle ne donne aucun résultat exploitable, le module peut proposer vos phrases s’il y en a. Ce choix de secours ne déclenche aucun appel supplémentaire au modèle.

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="Une phrase épinglée comme suggestion grise ; le bouton « Une autre » porte une épingle et la position dans la liste">
</p>

## Paramètres et utilisation

L’interface est disponible en neuf langues et suit par défaut celle de DSH. Vous pouvez en choisir une autre via « Langue ».

Cliquez sur « Ajouter un accès à la barre latérale » pour ouvrir Prédiction depuis la barre latérale gauche de DSH. Si vous désépinglez l’accès, vous pouvez l’ouvrir ou le réépingler depuis « Plus ». La version installée s’affiche à côté du titre.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="L’entrée « Prédiction » dans la barre latérale gauche">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="Le bouton d’accès à la barre latérale à côté du titre et de la version">
</td>
</tr>
</table>

« 7 derniers jours » affiche les requêtes, les suggestions affichées et acceptées, le temps de réponse et l’utilisation des jetons.

<details>
<summary><b>Afficher toute la page des paramètres</b> (bases, modes, origine des suggestions, modèle, 7 derniers jours)</summary>

<p align="center">
  <img src="docs/images/settings.png" width="640" alt="La page des paramètres complète">
</p>

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="Le haut de la page des paramètres en anglais, japonais, espagnol et russe">
</p>

</details>

> Les captures proviennent d’une interface web isolée, avec une conversation de synthèse et un modèle simulé en local. Les réglages sont fournis à titre d’exemple. Les chiffres d’utilisation et de latence sont illustratifs.

<a name="privacy"></a>

## Confidentialité et requêtes au modèle

Pour prédire, le module envoie des extraits des **messages de l’utilisateur et des réponses finales de l’assistant** de la branche actuelle à un fournisseur configuré dans DSH. Le budget d’entrée par défaut est de 12 messages et d’environ 2000 jetons, consignes comprises.

- Un court résumé des compteurs d’activité du tour précédent est inclus par défaut. Les arguments et sorties des outils, le raisonnement et les instructions système sont exclus.
- Le masquage par règles est activé par défaut. Il remplace les secrets probables et certains identifiants personnels. Des informations sensibles peuvent lui échapper.
- Les requêtes de prédiction et d’état du navigateur contiennent des identifiants et des métadonnées. Le serveur lit les messages envoyés dans DSH. Les brouillons, pièces jointes et références sont exclus. Les statistiques locales conservent compteurs, durées et identifiants, sans le texte des conversations ni des suggestions.
- Les candidats locaux et la liste des phrases épinglées ne sont pas ajoutés à l’invite du modèle. Une phrase déjà envoyée comme message peut figurer dans les extraits récents.

La description complète, et la manière de supprimer les données locales, se trouvent dans [Confidentialité et périmètre des données](docs/PRIVACY.md).

## Questions fréquentes

<details>
<summary><b>Pourquoi n’y a-t-il pas de suggestion ?</b></summary>

Vérifiez l’état dans les paramètres. Une conversation en pause, une fenêtre inactive, un brouillon, un menu ouvert ou une composition IME peuvent bloquer l’affichage. Le modèle peut aussi ne rien proposer d’utilisable. Lorsque les conditions sont réunies, essayez une prédiction manuelle depuis le champ vide et actif.

</details>

<details>
<summary><b>Quand une requête est-elle facturée ?</b></summary>

Le coût dépend du fournisseur sollicité et des jetons consommés. Parcourir les choix disponibles et générer une suggestion de secours en local n’ajoute aucune requête au modèle. Le mode économie permet de demander une prédiction au besoin.

</details>

<a name="documentation"></a>

## Documentation

La documentation détaillée est rédigée en chinois.

| Document | Contenu |
|---|---|
| [Guide d’utilisation](docs/USER-GUIDE.md) | Touches, chaque élément de la page des paramètres, modes, entrée de la barre latérale, questions fréquentes |
| [Référence de configuration](docs/CONFIGURATION.md) | Valeurs par défaut et plages de toutes les options, valeurs des trois modes |
| [Confidentialité et périmètre des données](docs/PRIVACY.md) | Ce qui est envoyé, fichiers locaux, suppression des données |
| [Compatibilité](docs/COMPATIBILITY.md) | Versions de DSH, périmètre des tests et interfaces de l’hôte |
| [Journal des modifications](CHANGELOG.md) | Changements de chaque version |
| [Index de la documentation](docs/README.md) | Tous les documents, y compris les notes antérieures de vérification et d’optimisation |

## Contribuer

```powershell
npm run build
npm test
npm run check
```

Le développement exige Node.js 22 ou ultérieur. Aucune dépendance d’exécution à installer. `npm run check` vérifie le paquet client, les README générés, les tests et la syntaxe JavaScript. [Développement et vérification](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md)

## Licence

Publié sous [licence MIT](LICENSE). Le choix des points d’extension et l’interaction « suggestion grise + Tab pour accepter + Échap pour masquer » s’inspirent de `dsh-composer-prediction`, lui aussi sous licence MIT ; aucun code n’en a été copié. Voir [NOTICE](NOTICE).
