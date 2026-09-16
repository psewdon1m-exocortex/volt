# Volt

> Documentation authority: the workspace-wide [Part 00](https://github.com/psewdon1m-exocortex/general/blob/main/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md)
> and its applicable Parts are normative. This repository documents
> Volt-specific details only; a conflict is corrected here and a material
> implementation difference follows the Part 00 divergence protocol.

## Required pre-push gate

After native checks and before every push, complete the checks required by
[Part 06 — Unified acceptance checklist](https://github.com/psewdon1m-exocortex/general/blob/main/PART_06_UNIFIED_ACCEPTANCE_CHECKLIST.md) and run the versioned policy in
`.github/pre-push-gate.json` through `scripts/pre-push-gate.py`. CI repeats the
gate on `main`. Security is always reviewed; backup/restore, updater, embedded
Documentation and affected technical docs are reviewed when relevant. Apply
SEO/GEO checks to intentionally public/indexable surfaces and concealment,
crawler and probe-resistance checks to private or authenticated surfaces.
Every area requires `PASS` evidence or a reasoned `N/A`.

## Required pre-release known-problem gate

Before a service-qualified release is finalized, evaluate every active ID in
[Part 12](https://github.com/psewdon1m-exocortex/general/blob/main/PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md) against the exact candidate. Retain
`known-problems-report.json` bound to the service revision, qualified tag,
immutable central-documentation revision and catalog digest. Missing, stale,
failed, unknown or unsupported `N/A` evidence blocks publication. This is a
normative release requirement; until the repository workflow generates and
enforces that report, the release pipeline remains an implementation gap.

Volt — локальное зашифрованное хранилище Exocortex и единственный источник значений
для ссылок `volt://<entry-id>/<value-position>` в Kernel Register.

Production-релиз включает Compose-конфигурацию и pinned-версию локального
Updater. Проверенный bootstrap размещает их в `/opt/volt`, создаёт
root-owned secret-файлы, control token и socket groups и регистрирует `head=volt`.
Если Kernel установлен на том же VPS, его installer заранее создаёт одноразовый
root-only handoff; Volt импортирует и удаляет только свой файл, не читая Kernel
`.env`. Для уже установленного Kernel сначала выполните `sudo kernel-install
credentials`. Вручную задаются только Access Key и удалённые Kernel credentials,
когда локального Kernel нет.

После установки можно создать в Saturn pipeline **Volt ZIP + personal.volt
mirror**. Введите setup code через Settings → Backup
→ **Initialize Neptune**: Updater установит отсутствующий Neptune или подключит уже работающий экземпляр. `sudo volt-install backup` остаётся резервным
CLI-сценарием. Расписания задаются только в Saturn → Synchronization.

## Что реализовано

- записи с названием, несколькими необязательными проектами и 1–20 именованными значениями;
- открытые и секретные поля; списки и карточки никогда не получают секретное
  значение до явного reveal/copy/edit;
- неизменяемые ревизии и восстановление старой версии как новой ревизии;
- корзина с восстановлением, принудительным purge и настраиваемым сроком
  автоматического необратимого удаления (30 дней по умолчанию);
- генераторы паролей с точной энтропией, 16-символьных ID, HMAC, RSA и
  самоподписанного ECDSA X.509 сертификата;
- отдельный machine endpoint для Kernel с общим Kernel-to-Volt token;
- единый переносимый файл `personal.volt`, открываемый офлайн по Access Key;
- полный зашифрованный ZIP backup с manifest/checksums и транзакционный replace
  restore;
- унифицированный локальный UI: обязательная тёмная тема, контрастный акцент,
  reorder навигации, dashboard и секций настроек с сохранением порядка, а также
  отключаемое ранжирование Vault по взаимодействиям с ручным baseline;
- смена Access Key с проверкой текущего ключа, bounded audit без значений
  секретов и выгрузка redacted-журналов.

## Модель хранения

`personal.volt` — SQLite-контейнер с собственным `application_id` и версией
формата. Каждая запись получает случайный 256-битный data-encryption key.
Payload всех её ревизий шифруется AES-256-GCM, а ключ записи оборачивается
случайным vault master key. Название, проекты, имена полей и значения находятся
только внутри зашифрованного payload.

Vault master key также находится внутри `personal.volt`, но только в
зашифрованном виде. Основная обёртка создаётся из Access Key через Argon2id
(64 MiB, 3 прохода) и AES-256-GCM. Поэтому для офлайн-копии достаточно самого
`personal.volt` и Access Key. Сервер может иметь вторую обёртку от отдельного
32-байтного device key для совместимости старых файлов. В строгом режиме она
не разрешает запуск без Access Key и не требуется офлайн-клиенту. Для Kernel-to-Volt token в настройках хранится только SHA-256
verifier; исходное значение не входит ни в `personal.volt`, ни в backup и не
может быть прочитано обратно.

Компрометация `personal.volt` без Access Key или device key не раскрывает
секреты. Компрометация файла вместе с одним из этих ключей, работающего процесса
или разблокированной браузерной сессии не входит в защиту at-rest.

## Локальный запуск

Требуется Node.js 24.7 или новее.

```powershell
npm install
$env:VOLT_ACCESS_KEY = '<выбранное оператором значение>'
npm run build
npm start
```

Такой запуск создаст `data/personal.volt`; его можно скопировать на другой
компьютер и открыть тем же Access Key. Для автоматического запуска передайте
Access Key в защищённом файле через `VOLT_ACCESS_KEY_FILE`; это явная передача
ключа. Production installer делает только этот bind-mounted файл доступным на
запись группе процесса, чтобы смена Access Key из Settings синхронно обновляла
следующий автоматический запуск. Без ключа или при устаревшем/недоступном файле
сервер поднимет экран разблокировки, а readiness останется недоступным до ввода
действующего Access Key. Один `VOLT_DEVICE_KEY_FILE` разблокировку не выполняет.

`VOLT_ACCESS_KEY` должен быть явно передан, но в остальном является непрозрачным
точным значением. Для него нет минимальной/максимальной длины, обязательных или
запрещённых классов символов, URL-safe/ASCII-ограничения, strength/entropy или
denylist известных/example/placeholder значений. Запуск, web unlock, смена
ключа, backup/restore и offline unlock не должны применять trim, нормализацию,
изменение регистра или усечение. Единственное исключение — ограниченная
совместимость startup-файлов формата 1: если точное значение не подошло, Volt
может повторить попытку по правилам чтения `0.1.5`, который добавлял перевод
строки и затем выполнял `trim`. Ввод через UI этой совместимостью не пользуется.

Интерфейс: `http://127.0.0.1:18184`. В production используйте только общий
серверный Nginx для HTTPS-маршрутизации, `VOLT_SECURE_COOKIES=true` и внешний
root-owned bind mount для Access Key, доступный на запись только группе Volt.
Kernel и Volt могут работать на разных серверах: в
Settings → Security интерфейса Kernel укажите HTTPS URL Volt и общий токен, а
затем задайте то же значение в Settings интерфейса Volt. Volt сохраняет только
verifier, поэтому после сохранения токен нельзя посмотреть — только заменить.
Прямой listener по-прежнему публикуется только на loopback; доступ между
серверами проходит через серверный Nginx. Volt не поставляет и не запускает
собственный Nginx. Coturn не применяется: текущему HTTP/API-трафику он не нужен;
только отдельный будущий WebRTC NAT-traversal кейс может потребовать
самостоятельного архитектурного решения о TURN.

Публичный HTTPS virtual host показывает locked/login UI с любого клиентского
IP. `OPERATOR_CIDR`, VPN prerequisite и source-IP allow-list запрещены. Данные
и управляющие API доступны только после проверки Access Key и через
защищённую cookie-сессию. Включите из release bundle
`/opt/volt/nginx.security.conf`; он скрывает внутренние callback/Neptune routes
и probe paths, но намеренно не содержит source-IP `allow`/`deny` ACL.

Volt следует общему UI/UX-контракту Exocortex: true-black поверхности,
Consolas для интерфейсного текста, Space Grotesk только для названия сервиса и
страниц, квадратная геометрия без теней и градиентов, 250 px sidebar и 123 px
page header. Порядок основных экранов, dashboard-карточек и обязательных
секций Settings хранится внутри `personal.volt`. Новая продуктовая иконка из
`.src` используется в login, sidebar и favicon.

Старые `VOLT_KERNEL_TOKEN` и `VOLT_KERNEL_TOKEN_FILE` принимаются при запуске
только как источник однократной миграции, если токен ещё не задан в настройках.

При первом запуске новой версии существующие `data/volt.sqlite` и legacy master
key автоматически копируются в `data/personal.volt`. Секреты не
перешифровываются, исходный `volt.sqlite` сохраняется как rollback-копия.
Миграция требует действующий legacy Access Key и `VOLT_MASTER_KEY_FILE` либо
`VOLT_LEGACY_MASTER_KEY_FILE`.

Первый запуск broker-версии удаляет устаревшие таблицы service principals и
grants. Старые `VOLT_SERVICE_TOKEN` после обновления больше не действуют;
сделайте обычную резервную копию перед согласованным обновлением Volt, Kernel и
потребляющих сервисов.

Внутренняя схема `personal.volt` обновляется одной SQLite-транзакцией и каждое
применённое изменение фиксируется в `vault_migrations`. Версия схемы хранится в
`PRAGMA user_version` отдельно от версии криптографического контейнера. Уже
существующий контейнер format 1 намеренно не переписывается в format 2: текущая
версия его читает и обновляет внутреннюю схему, а предыдущий релиз всё ещё может
открыть тот же envelope при автоматическом rollback. Новые хранилища создаются в
format 2.

## Production-установка и обновления

Запустите bootstrap конкретного immutable-релиза, заменив `X.Y.Z`:

```bash
curl -fsSL https://github.com/psewdon1m-exocortex/volt/releases/download/volt-vX.Y.Z/bootstrap.sh | sudo sh
sudoedit /opt/volt/.env
sudo chmod 600 /opt/volt/.env
sudo volt-install
sudo volt-install status
curl -fsS http://127.0.0.1:18184/api/v1/health
```

Закрытый ключ подписи Volt хранится только в GitHub Secrets и доступен только
защищённому release job. CI извлекает публичную часть и встраивает только её в
versioned `bootstrap.sh`. На чистом сервере bootstrap создаёт
`/etc/exocortex/release-trust/volt.pem`, проверяет подпись manifest до доверия
его URL и digest и готовит только Volt и его mode-`0600` `.env`; существующий
несовпадающий ключ автоматически не заменяется. `scp`, ручная сверка
release-key fingerprint и отдельная подготовка публичного ключа не применяются.
Затем проверяется SHA-256 архива до распаковки. В release bundle уже находятся
зафиксированные binary/unit/installer Updater; установщик не скачивает
исполняемый файл во время привилегированного шага и не требует вручную создавать
`UPDATER_CONTROL_TOKEN`, GID или token-файлы. Повторный `sudo volt-install`
сохраняет существующие секреты и данные.

Settings → Updates получает `repositories.volt.url` и
`repositories.updater.url` через Kernel Register. При установке релиза Volt
создаётся зашифрованный logical backup, после чего Updater проверяет manifest,
подпись, checksum и immutable image digest, пересоздаёт только контейнер Volt и выполняет
health check. При ошибке он возвращает предыдущий image и импортирует backup.

## Подключение через Kernel

1. Создайте запись и нужное поле в Volt.
2. Один раз задайте одинаковый Kernel-to-Volt token в Settings обоих приложений
   и URL Volt в Settings Kernel.
3. Для каждого ключа Kernel Register сохраните ссылку на поле, например
   `services.laboratory.ai.gemini_api_key = volt://<entry>/1`.
4. Передайте сервису только общий `KERNEL_SERVICE_TOKEN`. Сервис вызывает
   `POST /api/v1/register/resolve` с именем Register key.
5. Kernel обращается к `POST /api/v1/internal/kernel/resolve` в Volt со своим
   отдельным token и возвращает результат сервису.

Оба batch endpoint ограничены 20 уникальными элементами и работают
all-or-nothing. Отдельных grants нет: Volt доверяет только Kernel, а любой
сервис с `KERNEL_SERVICE_TOKEN` может разрешить любое зарегистрированное
значение — и открытое, и секретное.

## Backup и восстановление

Settings позволяет скачать согласованный snapshot `personal.volt`. Это
самодостаточная офлайн-копия: для открытия нужен только Access Key.

Отдельно создаётся `application/zip` server backup. В архив входят ciphertext,
история, настройки и redacted audit. Plaintext-секреты, cookies и bearer tokens
не входят. Restore
сначала проверяет allow-list файлов, размеры, manifest и каждый SHA-256, затем
заменяет состояние одной SQLite-транзакцией внутри того же vault.

Этот же builder доступен Neptune через loopback-only endpoint
`POST /api/v1/internal/neptune/backup`, защищённый отдельным bearer token.
Поэтому ручной ZIP и ZIP, отправленный автоматически в Saturn, полностью
взаимозаменяемы. Settings показывает локальный статус Neptune и позволяет
инициализировать или восстановить обязательную пару pipeline: recovery ZIP и
single-file mirror `personal.volt`. Расписания, явные remote runs и fleet update
задаются только в Saturn → Synchronization. Для регистрации archive worker
используются `project_id=volt`, exporter
`http://127.0.0.1:18184/api/v1/internal/neptune/backup` и Register key
`services.volt.backup.saturn_slug`; mirror worker отдельно использует
`mirrorRoot=volt`, `mode=single-file` и `targetFilename=personal.volt`.

## Проверка

```bash
npm run check
```

Vaultwarden рассматривался как источник продуктовых принципов (локальное
хранилище, явное раскрытие, отдельные credentials), но код и схема данных Volt
реализованы независимо: модель Exocortex требует key/value полей, immutable
revisions и единственного доверенного machine broker в Kernel.

The current six-service deployment, trust, recovery and acceptance contract is documented in [Deployment readiness](DEPLOYMENT_READINESS.md).
