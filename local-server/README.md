# TexLocal local server

Le serveur local :

- stocke les projets LaTeX sur le disque local
- importe des archives `.zip`
- compile les fichiers `.tex`
- expose l'API REST consommee par l'interface React

## Configuration locale

Le serveur lit automatiquement `local-server/.env` si le fichier existe.

Exemple :

```env
PORT=3001
TEXLOCAL_ROOT=../TexLocalProjects
```

Les chemins relatifs de `TEXLOCAL_ROOT` sont resolus depuis `local-server/`.

## Compilation LaTeX

Le serveur choisit automatiquement un compilateur utilisable :

- `latexmk` si disponible
- sous Windows, `latexmk` seulement si `perl` est aussi disponible
- sinon `pdflatex`

Cela evite l'erreur MiKTeX classique :

```text
MiKTeX could not find the script engine 'perl'
```

## Demarrage

```bash
cd local-server
npm install
npm start
```

Au demarrage, le serveur affiche :

- l'URL de l'API
- le dossier de stockage actif
- le compilateur detecte

## Documentation complete

Voir le README a la racine du projet pour :

- l'installation complete frontend + backend
- la configuration du dossier de sauvegarde
- l'installation de LaTeX
- les conseils de depannage Windows / MiKTeX
