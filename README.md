# Configurar PARIA amb un Google Sheets i un Google Drive nous

Aquesta guia parteix de zero: crea un full buit, una carpeta d’imatges, desplega l’API d’Apps Script i connecta-hi l’app. Cal un compte Google amb permís per crear i administrar aquests recursos.

## 1. Crear el full de dades

1. Ves a [Google Sheets](https://sheets.google.com) i crea un full de càlcul nou. Posa-li un nom identificable, per exemple **Inventari PARIA**.
2. A la primera pestanya, escriu aquests encapçalaments a la fila 1:

   | A | B | C | D | E | F |
   |---|---|---|---|---|---|
   | ID | Item | Talla | Quantitat | Codi de barres | Img |

3. Deixa les files següents buides. Apps Script crearà les files i assignarà els identificadors i codis de barres quan s’afegeixin productes.
4. Copia l’identificador del full des de la URL. És el text entre `/d/` i `/edit`:

   ```text
   https://docs.google.com/spreadsheets/d/ID_DEL_FULL/edit
   ```

   No cal publicar el full al web però si que cal fer-lo públic  (tothom que tingui l'enllaç = lector): l’script hi accedirà amb el compte que el desplega.

## 2. Crear la carpeta d’imatges

1. A [Google Drive](https://drive.google.com), crea una carpeta nova, per exemple **Imatges PARIA**.
2. Copia l’identificador de la carpeta des de la seva URL:

   ```text
   https://drive.google.com/drive/folders/ID_DE_LA_CARPETA
   ```

3. La carpeta ha de ser accessible pel mateix compte Google que autoritzarà i desplegarà Apps Script. Les imatges que l’app hi puja es comparteixen amb permís de lectura per enllaç perquè l’app les pugui mostrar; no hi desis imatges privades.

## 3. Crear i configurar Apps Script

1. Torna al full i obre **Extensions → Apps Script**. Així el projecte queda vinculat al full nou.
2. A l’editor, obre `Code.gs`, esborra el contingut inicial i enganxa-hi tot el codi de [`server/Code.gs`](./server/Code.gs) d’aquest projecte.
3. A **Configuració del projecte**, activa **Mostra el fitxer de manifest `appsscript.json` a l’editor**. Obre `appsscript.json` i substitueix-ne el contingut pel de [`appsscript.json`](./appsscript.json) d’aquest projecte. El manifest declara els permisos necessaris per llegir i escriure Sheets i Drive.
4. A **Configuració del projecte → Propietats de l’script**, afegeix aquestes propietats:

   | Nom | Valor |
   |---|---|
   | `GOOGLE_SPREADSHEET_ID` | L’identificador del full del pas 1 |
   | `GOOGLE_DRIVE_FOLDER_ID` | L’identificador de la carpeta del pas 2 |
   | `GOOGLE_SHEET_NAME` | Opcional: nom exacte de la pestanya; si no es posa, s’utilitza la primera |

   No enganxis les URL completes: les dues primeres propietats contenen només els identificadors.
5. Desa el projecte. A la llista de funcions, selecciona `authorizeDriveAccess` i prem **Executa**. Revisa i accepta les sol·licituds de permisos de Google amb el compte que desplegarà l’app. Si Google mostra una pantalla d’avís per a una aplicació no verificada, continua només si reconeixes i controles aquest projecte.

## 4. Desplegar l’aplicació web d’Apps Script

1. A Apps Script, prem **Implementa → Nova implementació**.
2. Selecciona el tipus **Aplicació web**.
3. Configura **Executar com a** perquè sigui el teu compte (el mateix que ha autoritzat l’script i té accés al full i a la carpeta).
4. A **Qui hi té accés**, limita l’accés als usuaris necessaris. L’opció **Qualsevol persona** és la que permetrà la app la possibilitat d'accedir-hi.
5. Prem **Implementa**, completa els permisos si cal i copia l’URL de l’aplicació web. Ha de tenir aquest format i acabar en `/exec`:

   ```text
   https://script.google.com/macros/s/ID_DE_LA_IMPLEMENTACIO/exec
   ```

6. Si edites el codi Apps Script més endavant, ves a **Implementa → Gestiona les implementacions**, edita la implementació, selecciona **Nova versió** i torna a implementar-la.

## 5. Connectar l’app

1. Obre PARIA al navegador o dispositiu. L’app provarà de connectar-se a la implementació d’Apps Script configurada per defecte.
2. Si has de fer servir un desplegament diferent, prem l’engranatge al costat de la campana de notificacions, enganxa l’URL `/exec` i desa’l. L’app es recarregarà i connectarà amb el full i la carpeta que estiguin configurats en aquell desplegament.
3. L’URL alternativa es desa en l’emmagatzematge local del navegador/dispositiu; cada navegador o dispositiu s’ha de configurar per separat.

L’URL és específic del dispositiu i de l’origen web. No el comparteixis en codi públic. Si neteges les dades del navegador, caldrà tornar-lo a introduir.

## Notes sobre el full i les imatges

- Cada fila del full representa una variant/talla. Les columnes necessàries són `ID`, `Item`, `Talla` i `Quantitat`; `Codi de barres` i `Img` també s’inclouen a les capçaleres recomanades.
- Es poden afegir els productes des de PARIA; l’script assigna els codis de barres i desa els canvis directament al full.
- Les imatges acceptades són PNG, JPG i WEBP, de fins a 8 MB. L’app les carrega i desa a la carpeta de Drive configurada.
- Si la connexió falla temporalment, els canvis compatibles queden pendents al dispositiu i se sincronitzen quan torna la connexió. Una cua pendent no es comparteix entre dispositius.
- Si apareix un error de permisos, comprova els dos identificadors de les propietats de l’script i que el compte **Executar com a** tingui accés al full i a la carpeta. També pots tornar a executar `authorizeDriveAccess` i acceptar els permisos.
- En algunes ocasions per tema d'interconectivitat pot tardar una mica a efectuar els canvis.
