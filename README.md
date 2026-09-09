# Volt

Volt — локальное зашифрованное хранилище Exocortex и единственный источник значений
для ссылок `volt://<entry-id>/<value-position>` в Kernel Register.

## Что реализовано

- записи с названием, необязательным проектом и 1–5 именованными значениями;
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
  reorder навигации, dashboard и секций настроек с сохранением порядка;
- смена Access Key с проверкой текущего ключа, bounded audit без значений
  секретов и выгрузка redacted-журналов.

## Модель хранения

`personal.volt` — SQLite-контейнер с собственным `application_id` и версией
формата. Каждая запись получает случайный 256-битный data-encryption key.
Payload всех её ревизий шифруется AES-256-GCM, а ключ записи оборачивается
случайным vault master key. Название, project, имена полей и значения находятся
только внутри зашифрованного payload.

Vault master key также находится внутри `personal.volt`, но только в
зашифрованном виде. Основная обёртка создаётся из Access Key через Argon2id
(64 MiB, 3 прохода) и AES-256-GCM. Поэтому для офлайн-копии достаточно самого
`personal.volt` и Access Key. Сервер может иметь вторую обёртку от отдельного
32-байтного device key: она нужна только для unattended-start и не требуется
офлайн-клиенту. Для Kernel-to-Volt token в настройках хранится только SHA-256
verifier; исходное значение не входит ни в `personal.volt`, ни в backup и не
может быть прочитано обратно.

Компрометация `personal.volt` без Access Key или device key не раскрывает
секреты. Компрометация файла вместе с одним из этих ключей, работающего процесса
или разблокированной браузерной сессии не входит в защиту at-rest.

## Локальный запуск

Требуется Node.js 24.7 или новее.

```powershell
npm install
$env:VOLT_ACCESS_KEY = '<не менее 12 символов>'
npm run build
npm start
```

Такой запуск создаст `data/personal.volt`; его можно скопировать на другой
компьютер и открыть тем же Access Key. Для unattended server startup добавьте:

```powershell
npm run generate-device-key -- C:\secure\volt-device.key
$env:VOLT_DEVICE_KEY_FILE = 'C:\secure\volt-device.key'
```

Интерфейс: `http://127.0.0.1:18184`. Для production используйте HTTPS reverse
proxy, `VOLT_SECURE_COOKIES=true`, внешние read-only secret mounts для device и
bootstrap Access Key. Kernel и Volt могут работать на разных серверах: в
Settings → Security интерфейса Kernel укажите HTTPS URL Volt и общий токен, а
затем задайте то же значение в Settings интерфейса Volt. Volt сохраняет только
verifier, поэтому после сохранения токен нельзя посмотреть — только заменить.
Прямой listener по-прежнему публикуется только на loopback; доступ между
серверами проходит через HTTPS reverse proxy.

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
взаимозаменяемы. В Settings можно включить расписание, задать интервал в часах,
запустить отправку в Saturn и проверить/установить версию Neptune. Для
регистрации проекта у Linux-агента используются `project_id=volt`, exporter
`http://127.0.0.1:18184/api/v1/internal/neptune/backup` и Register key
`services.volt.backup.saturn_slug`.

## Проверка

```bash
npm run check
```

Vaultwarden рассматривался как источник продуктовых принципов (локальное
хранилище, явное раскрытие, отдельные credentials), но код и схема данных Volt
реализованы независимо: модель Exocortex требует key/value полей, immutable
revisions и единственного доверенного machine broker в Kernel.
