# Volt API v1

Операторские endpoints используют HttpOnly `volt_session` cookie и same-origin
mutation policy. Machine endpoint принимает только общий Bearer token Kernel.
Все ответы API отправляются с `Cache-Control: no-store`.

## Operator

| Method | Path | Назначение |
| --- | --- | --- |
| `POST` | `/api/v1/session` | Unlock по `{ "access_key": "…" }` |
| `DELETE` | `/api/v1/session` | Lock |
| `GET/POST` | `/api/v1/entries` | Список masked entries / создание |
| `PUT/DELETE` | `/api/v1/entries/:id` | Новая ревизия / soft delete |
| `GET` | `/api/v1/trash` | Удалённые entries и срок автоматического purge |
| `POST` | `/api/v1/trash/:id/restore` | Восстановление entry без изменения ревизии |
| `DELETE` | `/api/v1/trash/:id` | Необратимое удаление entry и всех ревизий |
| `POST` | `/api/v1/entries/:id/fields/:field/reveal` | Явное раскрытие |
| `GET` | `/api/v1/entries/:id/revisions` | Метаданные истории |
| `POST` | `/api/v1/entries/:id/revisions/:revision/restore` | Restore как новая ревизия |
| `POST` | `/api/v1/generate` | CSPRNG generators |
| `GET` | `/api/v1/audit` | Redacted audit |
| `GET` | `/api/v1/dashboard` | CPU, RAM, filesystem и uptime процесса |
| `GET/PUT` | `/api/v1/settings/interface` | Акцент, режим sidebar и сохранённые порядки UI |
| `GET/PUT` | `/api/v1/settings/trash` | Срок хранения удалённых entries в днях (1–365) |
| `PUT` | `/api/v1/settings/access-key` | Смена по `{ current_access_key, new_access_key }` с закрытием сессий |
| `GET/PUT` | `/api/v1/settings/kernel-access` | URL, reachability и замена общего Kernel token; значение не возвращается |
| `GET` | `/api/v1/update/status` | Установленная версия и доступность локального Updater |
| `POST` | `/api/v1/update/check` | Проверка `repositories.volt.url` через Kernel Register |
| `POST` | `/api/v1/update/install` | Backup и запуск проверенной установки через локальный Updater |
| `GET` | `/api/v1/update/jobs/:id` | Состояние сохранённого updater job |
| `POST` | `/api/v1/update/jobs/:id/rollback` | Ручной rollback завершённого обновления |
| `POST` | `/api/v1/update/updater/check` | Проверка `repositories.updater.url` |
| `GET` | `/api/v1/logs/archive` | ZIP с redacted audit в JSONL |
| `GET` | `/api/v1/vault-file` | Согласованный переносимый `personal.volt` snapshot |
| `GET` | `/api/v1/vault-file/info` | Версия формата, vault ID и параметры KDF без секретов |
| `GET` | `/api/v1/backup` | Свежий ZIP |
| `POST` | `/api/v1/backup/inspect` | Проверка ZIP без мутации |
| `POST` | `/api/v1/backup/restore` | Подтверждённый replace restore |

## Machine resolve

```http
POST /api/v1/internal/kernel/resolve
Authorization: Bearer <VOLT_KERNEL_TOKEN>
Content-Type: application/json

{"references":["volt://<entry-id>/1"]}
```

```json
{
  "schema": "volt.resolve.v1",
  "resolution_revision": "sha256-base64url",
  "values": {
    "volt://<entry-id>/1": {
      "value": "resolved for Kernel",
      "revision": 3,
      "visibility": "plain"
    }
  }
}
```

Batch ограничен 20 уникальными ссылками и использует all-or-nothing resolution.
Последний сегмент — 1-based позиция значения в текущей ревизии записи (1–5).
Удаление или перестановка значений меняет смысл позиционной ссылки.
Volt не ведёт principals или grants: этот endpoint доступен только Kernel.
`resolution_revision` зависит от ссылок и номеров ревизий, но не от значений.
`visibility` имеет значение `plain` или `secret` и позволяет Kernel сохранить
корректную метку в ответе, не меняя общий путь разрешения.

## Updater restore

`POST /api/v1/internal/updater/restore` принимает только multipart ZIP в поле
`file` и отдельный `X-Updater-Token`. Endpoint не использует operator cookie и
предназначен исключительно для автоматического восстановления после неудачного
health check. Control token генерируется установщиком, хранится в root-owned
`.env` для host updater и монтируется в Volt отдельным read-only secret-файлом.
